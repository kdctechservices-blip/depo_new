import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';

export const DATA_DIR = process.env.GESTDEPOT_DATA_DIR
  ? path.resolve(process.env.GESTDEPOT_DATA_DIR)
  : path.resolve(process.cwd(), 'data');
export const DB_PATH = path.join(DATA_DIR, 'gestdepot.sqlite');
export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUPS_DIR, { recursive: true });

let dbInstance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!dbInstance) {
    dbInstance = new DatabaseSync(DB_PATH);
    dbInstance.exec('PRAGMA journal_mode = WAL;');
    dbInstance.exec('PRAGMA synchronous = FULL;');
    dbInstance.exec('PRAGMA foreign_keys = ON;');
    dbInstance.exec('PRAGMA busy_timeout = 5000;');
  }
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    try {
      dbInstance.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // ignore checkpoint errors during shutdown
    }
    dbInstance.close();
    dbInstance = null;
  }
}

export function hashSecret(secret: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(secret, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifySecret(secret: string, storedHash: string | null): boolean {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, keyHex] = storedHash.split(':');
  const keyBuf = Buffer.from(keyHex, 'hex');
  const derivedBuf = crypto.scryptSync(secret, salt, 64);
  if (keyBuf.length !== derivedBuf.length) return false;
  return crypto.timingSafeEqual(keyBuf, derivedBuf);
}

export function runInTransaction<T>(fn: (db: DatabaseSync) => T): T {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn(db);
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // ignore rollback errors if already rolled back
    }
    throw err;
  }
}

export function nextDocumentNumber(db: DatabaseSync, prefix: string): string {
  const year = new Date().getFullYear();
  const row = db
    .prepare('SELECT last_number FROM document_sequences WHERE prefix = ? AND year = ?')
    .get(prefix, year) as { last_number: number } | undefined;

  let nextNum = 1;
  if (row) {
    nextNum = row.last_number + 1;
    db.prepare('UPDATE document_sequences SET last_number = ? WHERE prefix = ? AND year = ?').run(
      nextNum,
      prefix,
      year,
    );
  } else {
    db.prepare('INSERT INTO document_sequences (prefix, year, last_number) VALUES (?, ?, ?)').run(
      prefix,
      year,
      nextNum,
    );
  }
  return `${prefix}-${year}-${String(nextNum).padStart(6, '0')}`;
}

export function writeAuditLog(
  db: DatabaseSync,
  params: {
    userId: number | null;
    userName: string;
    action: string;
    entityType: string;
    entityId?: string | number | null;
    details: string;
  },
): void {
  db.prepare(
    `INSERT INTO audit_logs (user_id, user_name, action, entity_type, entity_id, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.userId,
    params.userName,
    params.action,
    params.entityType,
    params.entityId != null ? String(params.entityId) : null,
    params.details,
    new Date().toISOString(),
  );
}

export type BackupKind =
  | 'MANUELLE'
  | 'AUTO_DEMARRAGE'
  | 'AUTO_FERMETURE'
  | 'AUTO_PERIODIQUE'
  | 'AUTO_FENETRE'
  | 'SECURITE_PRE_RESTAURATION';

export function getAutoBackupMirrorDir(): string | null {
  const raw = process.env.GESTDEPOT_AUTO_BACKUP_DIR?.trim();
  if (!raw) return null;
  return path.resolve(raw);
}

export async function createSqliteBackup(
  backupType: BackupKind,
  customNote?: string,
): Promise<{
  id: number;
  filename: string;
  file_path: string;
  mirror_path: string | null;
  size_bytes: number;
  integrity_ok: number;
  created_at: string;
}> {
  const db = getDb();
  try {
    db.exec('PRAGMA wal_checkpoint(PASSIVE);');
  } catch {
    // non-fatal if busy
  }

  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const filename = `gestdepot_${backupType.toLowerCase()}_${stamp}.sqlite`;
  const destPath = path.join(BACKUPS_DIR, filename);

  await backup(db, destPath);

  const checkDb = new DatabaseSync(destPath, { readOnly: true });
  let integrityOk = 0;
  let integrityMsg = 'OK';
  try {
    const res = checkDb.prepare('PRAGMA integrity_check;').get() as { integrity_check: string };
    integrityOk = res?.integrity_check === 'ok' ? 1 : 0;
    integrityMsg = res?.integrity_check ?? 'Erreur inconnue';
  } finally {
    checkDb.close();
  }

  let mirrorPath: string | null = null;
  const mirrorDir = getAutoBackupMirrorDir();
  if (integrityOk === 1 && mirrorDir && path.resolve(mirrorDir) !== path.resolve(BACKUPS_DIR)) {
    try {
      fs.mkdirSync(mirrorDir, { recursive: true });
      const finalMirror = path.join(mirrorDir, filename);
      const tmpMirror = path.join(mirrorDir, `.tmp_${filename}`);
      fs.copyFileSync(destPath, tmpMirror);
      fs.renameSync(tmpMirror, finalMirror);
      mirrorPath = finalMirror;

      // Retain last 30 automated/mirror snapshots to prevent unbounded disk growth
      const autoFiles = fs
        .readdirSync(mirrorDir)
        .filter((f) => f.startsWith('gestdepot_') && f.endsWith('.sqlite'))
        .sort();
      if (autoFiles.length > 30) {
        for (const oldFile of autoFiles.slice(0, autoFiles.length - 30)) {
          try {
            fs.unlinkSync(path.join(mirrorDir, oldFile));
          } catch {
            // ignore unlink errors
          }
        }
      }
    } catch (mirrorErr) {
      console.error('Auto-backup mirror warning:', mirrorErr);
    }
  }

  const stat = fs.statSync(destPath);
  const createdAt = now.toISOString();

  const noteParts = [integrityMsg];
  if (customNote) noteParts.push(customNote);
  if (mirrorPath) noteParts.push(`Miroir local : ${mirrorPath}`);

  const insert = db
    .prepare(
      `INSERT INTO backup_history (filename, file_path, size_bytes, integrity_ok, backup_type, status, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      filename,
      destPath,
      stat.size,
      integrityOk,
      backupType,
      integrityOk ? 'REUSSIE' : 'ERREUR',
      noteParts.join(' — '),
      createdAt,
    );

  return {
    id: Number(insert.lastInsertRowid),
    filename,
    file_path: destPath,
    mirror_path: mirrorPath,
    size_bytes: stat.size,
    integrity_ok: integrityOk,
    created_at: createdAt,
  };
}

export function initSchema(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS company_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      registration_no TEXT NOT NULL DEFAULT '',
      footer_note TEXT NOT NULL DEFAULT '',
      currency TEXT NOT NULL DEFAULT 'FCFA',
      tax_enabled INTEGER NOT NULL DEFAULT 0,
      tax_rate REAL NOT NULL DEFAULT 0,
      reserve_stock_on_order INTEGER NOT NULL DEFAULT 1,
      auto_backup_on_start INTEGER NOT NULL DEFAULT 1,
      retention_daily INTEGER NOT NULL DEFAULT 7,
      first_setup_completed INTEGER NOT NULL DEFAULT 0,
      single_user_pin_migrated INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('ADMIN', 'GERANT', 'CAISSIER', 'MAGASINIER', 'LIVREUR')),
      password_hash TEXT NOT NULL,
      pin_hash TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      last_login_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      user_name TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS brands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS price_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS payment_methods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      is_cash INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS returnable_packaging (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 1,
      deposit_value_xof INTEGER NOT NULL CHECK (deposit_value_xof >= 0),
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      contact_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      payment_terms TEXT NOT NULL DEFAULT 'Comptant / 15 jours',
      lead_time_days INTEGER NOT NULL DEFAULT 2,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category_id INTEGER NOT NULL REFERENCES categories(id),
      brand_id INTEGER NOT NULL REFERENCES brands(id),
      unit_id INTEGER NOT NULL REFERENCES units(id),
      barcode TEXT,
      purchase_cost_xof INTEGER NOT NULL DEFAULT 0 CHECK (purchase_cost_xof >= 0),
      min_threshold INTEGER NOT NULL DEFAULT 24 CHECK (min_threshold >= 0),
      safety_stock INTEGER NOT NULL DEFAULT 48 CHECK (safety_stock >= 0),
      avg_daily_sales REAL NOT NULL DEFAULT 12,
      track_batches INTEGER NOT NULL DEFAULT 0,
      packaging_deposit_id INTEGER REFERENCES returnable_packaging(id),
      deposit_units_per_crate INTEGER NOT NULL DEFAULT 1,
      default_supplier_id INTEGER REFERENCES suppliers(id),
      is_favorite INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_packagings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      conversion_factor INTEGER NOT NULL CHECK (conversion_factor >= 1),
      is_default_sale INTEGER NOT NULL DEFAULT 0,
      is_default_purchase INTEGER NOT NULL DEFAULT 0,
      apply_deposit INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS product_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      packaging_id INTEGER NOT NULL REFERENCES product_packagings(id) ON DELETE CASCADE,
      price_list_id INTEGER NOT NULL REFERENCES price_lists(id),
      price_xof INTEGER NOT NULL CHECK (price_xof >= 0),
      UNIQUE(product_id, packaging_id, price_list_id)
    );

    CREATE TABLE IF NOT EXISTS product_cost_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      previous_cost_xof INTEGER NOT NULL,
      new_cost_xof INTEGER NOT NULL,
      reason TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      packaging_name TEXT NOT NULL,
      conversion_factor INTEGER NOT NULL DEFAULT 1,
      price_list_code TEXT NOT NULL,
      previous_price_xof INTEGER,
      new_price_xof INTEGER NOT NULL,
      reason TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_balances (
      product_id INTEGER PRIMARY KEY REFERENCES products(id),
      physical_qty INTEGER NOT NULL DEFAULT 0,
      reserved_qty INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      movement_type TEXT NOT NULL CHECK (movement_type IN (
        'ACHAT_RECEPTION', 'VENTE_SORTIE', 'RETOUR_CLIENT', 'RETOUR_FOURNISSEUR',
        'CASSE', 'PERTE', 'PEREMPTION', 'INVENTAIRE_CORRECTION', 'INITIAL', 'AJUSTEMENT_ENTREE'
      )),
      qty_signed INTEGER NOT NULL,
      unit_cost_xof INTEGER NOT NULL DEFAULT 0,
      reference_doc TEXT,
      comment TEXT NOT NULL DEFAULT '',
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      batch_number TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      qty_remaining INTEGER NOT NULL CHECK (qty_remaining >= 0),
      received_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      customer_type TEXT NOT NULL DEFAULT 'Détail',
      price_list_id INTEGER NOT NULL REFERENCES price_lists(id),
      credit_limit_xof INTEGER NOT NULL DEFAULT 0 CHECK (credit_limit_xof >= 0),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deposit_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      party_type TEXT NOT NULL CHECK (party_type IN ('CLIENT', 'FOURNISSEUR', 'INTERNE')),
      party_id INTEGER NOT NULL DEFAULT 0,
      packaging_id INTEGER NOT NULL REFERENCES returnable_packaging(id),
      movement_kind TEXT NOT NULL CHECK (movement_kind IN (
        'REMISE_CLIENT', 'RETOUR_CLIENT', 'RECU_FOURNISSEUR', 'RENDU_FOURNISSEUR', 'CASSE_PERTE', 'AJUSTEMENT'
      )),
      qty_signed INTEGER NOT NULL,
      amount_xof INTEGER NOT NULL DEFAULT 0,
      payment_method TEXT,
      reference_doc TEXT,
      comment TEXT NOT NULL DEFAULT '',
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_number TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      price_list_id INTEGER NOT NULL REFERENCES price_lists(id),
      status TEXT NOT NULL CHECK (status IN ('VALIDEE', 'ANNULEE', 'REMBOURSEE_PARTIELLE')),
      subtotal_xof INTEGER NOT NULL CHECK (subtotal_xof >= 0),
      discount_xof INTEGER NOT NULL DEFAULT 0 CHECK (discount_xof >= 0),
      tax_xof INTEGER NOT NULL DEFAULT 0 CHECK (tax_xof >= 0),
      deposit_xof INTEGER NOT NULL DEFAULT 0 CHECK (deposit_xof >= 0),
      total_xof INTEGER NOT NULL CHECK (total_xof >= 0),
      paid_xof INTEGER NOT NULL DEFAULT 0 CHECK (paid_xof >= 0),
      credit_due_xof INTEGER NOT NULL DEFAULT 0 CHECK (credit_due_xof >= 0),
      due_date TEXT,
      payment_summary TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sale_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      packaging_id INTEGER REFERENCES product_packagings(id),
      product_name TEXT NOT NULL,
      packaging_name TEXT NOT NULL,
      conversion_factor INTEGER NOT NULL,
      qty INTEGER NOT NULL CHECK (qty > 0),
      base_qty INTEGER NOT NULL CHECK (base_qty > 0),
      returned_base_qty INTEGER NOT NULL DEFAULT 0 CHECK (returned_base_qty >= 0),
      unit_price_xof INTEGER NOT NULL CHECK (unit_price_xof >= 0),
      discount_xof INTEGER NOT NULL DEFAULT 0 CHECK (discount_xof >= 0),
      unit_cost_xof INTEGER NOT NULL CHECK (unit_cost_xof >= 0),
      line_total_xof INTEGER NOT NULL CHECK (line_total_xof >= 0),
      deposit_xof INTEGER NOT NULL DEFAULT 0 CHECK (deposit_xof >= 0)
    );

    CREATE TABLE IF NOT EXISTS sale_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_number TEXT NOT NULL UNIQUE,
      sale_id INTEGER NOT NULL REFERENCES sales(id),
      total_refund_xof INTEGER NOT NULL CHECK (total_refund_xof >= 0),
      refund_method TEXT NOT NULL,
      restocked INTEGER NOT NULL DEFAULT 1,
      reason TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sale_return_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_id INTEGER NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
      sale_line_id INTEGER NOT NULL REFERENCES sale_lines(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      base_qty INTEGER NOT NULL CHECK (base_qty > 0),
      refund_xof INTEGER NOT NULL CHECK (refund_xof >= 0)
    );

    CREATE TABLE IF NOT EXISTS customer_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_number TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      amount_xof INTEGER NOT NULL CHECK (amount_xof > 0),
      payment_method TEXT NOT NULL,
      reference_note TEXT NOT NULL DEFAULT '',
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payment_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id INTEGER NOT NULL REFERENCES customer_payments(id) ON DELETE CASCADE,
      sale_id INTEGER NOT NULL REFERENCES sales(id),
      allocated_xof INTEGER NOT NULL CHECK (allocated_xof > 0)
    );

    CREATE TABLE IF NOT EXISTS customer_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      status TEXT NOT NULL CHECK (status IN (
        'BROUILLON', 'CONFIRMEE', 'EN_PREPARATION', 'PRETE', 'PARTIELLEMENT_LIVREE', 'LIVREE', 'ANNULEE'
      )),
      desired_date TEXT,
      delivery_address TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      subtotal_xof INTEGER NOT NULL DEFAULT 0,
      deposit_total_xof INTEGER NOT NULL DEFAULT 0,
      total_xof INTEGER NOT NULL DEFAULT 0,
      converted_sale_id INTEGER REFERENCES sales(id),
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customer_order_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      packaging_id INTEGER REFERENCES product_packagings(id),
      product_name TEXT NOT NULL,
      packaging_name TEXT NOT NULL,
      conversion_factor INTEGER NOT NULL,
      qty INTEGER NOT NULL CHECK (qty > 0),
      base_qty INTEGER NOT NULL CHECK (base_qty > 0),
      delivered_base_qty INTEGER NOT NULL DEFAULT 0,
      unit_price_xof INTEGER NOT NULL,
      line_total_xof INTEGER NOT NULL,
      deposit_xof INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_number TEXT NOT NULL UNIQUE,
      order_id INTEGER REFERENCES customer_orders(id),
      sale_id INTEGER REFERENCES sales(id),
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      driver_name TEXT NOT NULL DEFAULT '',
      vehicle TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      scheduled_date TEXT NOT NULL,
      fee_xof INTEGER NOT NULL DEFAULT 0 CHECK (fee_xof >= 0),
      status TEXT NOT NULL CHECK (status IN ('PLANIFIEE', 'EN_COURS', 'LIVREE_PARTIELLE', 'LIVREE', 'ECHEC')),
      proof_note TEXT NOT NULL DEFAULT '',
      collected_xof INTEGER NOT NULL DEFAULT 0,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_number TEXT NOT NULL UNIQUE,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      status TEXT NOT NULL CHECK (status IN ('BROUILLON', 'CONFIRMEE', 'PARTIELLE', 'RECUE', 'ANNULEE')),
      expected_date TEXT,
      shipping_fee_xof INTEGER NOT NULL DEFAULT 0 CHECK (shipping_fee_xof >= 0),
      total_xof INTEGER NOT NULL DEFAULT 0 CHECK (total_xof >= 0),
      paid_xof INTEGER NOT NULL DEFAULT 0 CHECK (paid_xof >= 0),
      notes TEXT NOT NULL DEFAULT '',
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_order_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      packaging_id INTEGER REFERENCES product_packagings(id),
      product_name TEXT NOT NULL,
      packaging_name TEXT NOT NULL,
      conversion_factor INTEGER NOT NULL,
      qty_ordered INTEGER NOT NULL CHECK (qty_ordered > 0),
      qty_received INTEGER NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
      unit_cost_xof INTEGER NOT NULL CHECK (unit_cost_xof >= 0),
      line_total_xof INTEGER NOT NULL CHECK (line_total_xof >= 0)
    );

    CREATE TABLE IF NOT EXISTS goods_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_number TEXT NOT NULL UNIQUE,
      po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      total_value_xof INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS goods_receipt_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id INTEGER NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
      po_line_id INTEGER NOT NULL REFERENCES purchase_order_lines(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      qty_received INTEGER NOT NULL CHECK (qty_received >= 0),
      qty_rejected INTEGER NOT NULL DEFAULT 0 CHECK (qty_rejected >= 0),
      base_qty_received INTEGER NOT NULL CHECK (base_qty_received >= 0),
      unit_cost_xof INTEGER NOT NULL CHECK (unit_cost_xof >= 0),
      batch_number TEXT,
      expiry_date TEXT
    );

    CREATE TABLE IF NOT EXISTS supplier_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_number TEXT NOT NULL UNIQUE,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      po_id INTEGER REFERENCES purchase_orders(id),
      amount_xof INTEGER NOT NULL CHECK (amount_xof > 0),
      payment_method TEXT NOT NULL,
      reference_note TEXT NOT NULL DEFAULT '',
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cash_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      user_name TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      opening_float_xof INTEGER NOT NULL DEFAULT 0 CHECK (opening_float_xof >= 0),
      theoretical_cash_xof INTEGER NOT NULL DEFAULT 0,
      counted_cash_xof INTEGER,
      variance_xof INTEGER,
      comment TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('OUVERTE', 'CLOTUREE'))
    );

    CREATE TABLE IF NOT EXISTS cash_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER REFERENCES cash_sessions(id),
      movement_type TEXT NOT NULL CHECK (movement_type IN (
        'VENTE_ENCAISSEMENT', 'REGLEMENT_CREANCE', 'REMBOURSEMENT_CLIENT',
        'PAIEMENT_FOURNISSEUR', 'DEPENSE', 'RETRAIT', 'APPORT', 'CONSIGNE_ENCAISSEMENT', 'CONSIGNE_REMBOURSEMENT', 'CORRECTION'
      )),
      payment_method TEXT NOT NULL,
      amount_signed_xof INTEGER NOT NULL,
      reference_doc TEXT,
      comment TEXT NOT NULL DEFAULT '',
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expense_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_number TEXT NOT NULL UNIQUE,
      category_id INTEGER NOT NULL REFERENCES expense_categories(id),
      beneficiary TEXT NOT NULL,
      amount_xof INTEGER NOT NULL CHECK (amount_xof > 0),
      payment_method TEXT NOT NULL,
      reference_note TEXT NOT NULL DEFAULT '',
      comment TEXT NOT NULL DEFAULT '',
      expense_date TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inventory_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_number TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL DEFAULT 'Global',
      status TEXT NOT NULL CHECK (status IN ('BROUILLON', 'VALIDE')),
      notes TEXT NOT NULL DEFAULT '',
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      validated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS inventory_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_id INTEGER NOT NULL REFERENCES inventory_sessions(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      theoretical_qty INTEGER NOT NULL,
      counted_qty INTEGER NOT NULL,
      variance_qty INTEGER NOT NULL,
      unit_cost_xof INTEGER NOT NULL,
      variance_value_xof INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS document_sequences (
      prefix TEXT NOT NULL,
      year INTEGER NOT NULL,
      last_number INTEGER NOT NULL,
      PRIMARY KEY (prefix, year)
    );

    CREATE TABLE IF NOT EXISTS backup_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      integrity_ok INTEGER NOT NULL,
      backup_type TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(created_at);
    CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
    CREATE INDEX IF NOT EXISTS idx_stock_movements_prod ON stock_movements(product_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_cash_movements_date ON cash_movements(created_at);
    CREATE INDEX IF NOT EXISTS idx_deposit_movements_party ON deposit_movements(party_type, party_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_date ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_price_history_prod ON product_price_history(product_id, created_at);
  `);

  try {
    db.exec('ALTER TABLE company_settings ADD COLUMN single_user_pin_migrated INTEGER NOT NULL DEFAULT 0;');
  } catch {
    // column already exists
  }

  const csRow = db
    .prepare('SELECT id, single_user_pin_migrated FROM company_settings WHERE id = 1')
    .get() as { id: number; single_user_pin_migrated: number } | undefined;
  if (csRow && csRow.single_user_pin_migrated === 0) {
    db.prepare("UPDATE users SET pin_hash = ?, failed_attempts = 0, active = 1 WHERE username = 'admin'").run(
      hashSecret('5555'),
    );
    db.prepare('UPDATE company_settings SET single_user_pin_migrated = 1 WHERE id = 1').run();
  }

  // One-time baseline backfill of selling price & purchase cost history for existing catalog items
  const phCount = (db.prepare('SELECT COUNT(*) as cnt FROM product_price_history').get() as { cnt: number }).cnt;
  const prodCount = (db.prepare('SELECT COUNT(*) as cnt FROM products').get() as { cnt: number }).cnt;
  if (phCount === 0 && prodCount > 0) {
    const existingPrices = db
      .prepare(
        `SELECT p.id AS product_id, p.created_at, pk.name AS packaging_name, pk.conversion_factor,
                pl.code AS price_list_code, pp.price_xof
         FROM product_prices pp
         JOIN products p ON p.id = pp.product_id
         JOIN product_packagings pk ON pk.id = pp.packaging_id
         JOIN price_lists pl ON pl.id = pp.price_list_id`,
      )
      .all() as Array<{
      product_id: number;
      created_at: string;
      packaging_name: string;
      conversion_factor: number;
      price_list_code: string;
      price_xof: number;
    }>;

    const insPh = db.prepare(
      `INSERT INTO product_price_history
       (product_id, packaging_name, conversion_factor, price_list_code, previous_price_xof, new_price_xof, reason, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, 'Tarif initial catalogue', ?)`,
    );
    for (const r of existingPrices) {
      insPh.run(r.product_id, r.packaging_name, r.conversion_factor, r.price_list_code, r.price_xof, r.created_at);
    }

    const prodsWithoutCostHist = db
      .prepare(
        `SELECT p.id, p.purchase_cost_xof, p.created_at
         FROM products p
         WHERE NOT EXISTS (SELECT 1 FROM product_cost_history ch WHERE ch.product_id = p.id)`,
      )
      .all() as Array<{ id: number; purchase_cost_xof: number; created_at: string }>;
    const insCh = db.prepare(
      `INSERT INTO product_cost_history (product_id, previous_cost_xof, new_cost_xof, reason, created_at)
       VALUES (?, ?, ?, 'Coût initial catalogue', ?)`,
    );
    for (const pr of prodsWithoutCostHist) {
      insCh.run(pr.id, pr.purchase_cost_xof, pr.purchase_cost_xof, pr.created_at);
    }
  }
}
