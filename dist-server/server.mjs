// server.ts
import express from "express";
import path3 from "node:path";

// server/db.ts
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
var DATA_DIR = process.env.GESTDEPOT_DATA_DIR ? path.resolve(process.env.GESTDEPOT_DATA_DIR) : path.resolve(process.cwd(), "data");
var DB_PATH = path.join(DATA_DIR, "gestdepot.sqlite");
var BACKUPS_DIR = path.join(DATA_DIR, "backups");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUPS_DIR, { recursive: true });
var dbInstance = null;
function getDb() {
  if (!dbInstance) {
    dbInstance = new DatabaseSync(DB_PATH);
    dbInstance.exec("PRAGMA journal_mode = WAL;");
    dbInstance.exec("PRAGMA synchronous = FULL;");
    dbInstance.exec("PRAGMA foreign_keys = ON;");
    dbInstance.exec("PRAGMA busy_timeout = 5000;");
  }
  return dbInstance;
}
function closeDb() {
  if (dbInstance) {
    try {
      dbInstance.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
    }
    dbInstance.close();
    dbInstance = null;
  }
}
function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(secret, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}
function verifySecret(secret, storedHash) {
  if (!storedHash || !storedHash.includes(":")) return false;
  const [salt, keyHex] = storedHash.split(":");
  const keyBuf = Buffer.from(keyHex, "hex");
  const derivedBuf = crypto.scryptSync(secret, salt, 64);
  if (keyBuf.length !== derivedBuf.length) return false;
  return crypto.timingSafeEqual(keyBuf, derivedBuf);
}
function runInTransaction(fn) {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = fn(db);
    db.exec("COMMIT;");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK;");
    } catch {
    }
    throw err;
  }
}
function nextDocumentNumber(db, prefix) {
  const year = (/* @__PURE__ */ new Date()).getFullYear();
  const row = db.prepare("SELECT last_number FROM document_sequences WHERE prefix = ? AND year = ?").get(prefix, year);
  let nextNum = 1;
  if (row) {
    nextNum = row.last_number + 1;
    db.prepare("UPDATE document_sequences SET last_number = ? WHERE prefix = ? AND year = ?").run(
      nextNum,
      prefix,
      year
    );
  } else {
    db.prepare("INSERT INTO document_sequences (prefix, year, last_number) VALUES (?, ?, ?)").run(
      prefix,
      year,
      nextNum
    );
  }
  return `${prefix}-${year}-${String(nextNum).padStart(6, "0")}`;
}
function writeAuditLog(db, params) {
  db.prepare(
    `INSERT INTO audit_logs (user_id, user_name, action, entity_type, entity_id, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.userId,
    params.userName,
    params.action,
    params.entityType,
    params.entityId != null ? String(params.entityId) : null,
    params.details,
    (/* @__PURE__ */ new Date()).toISOString()
  );
}
function getAutoBackupMirrorDir() {
  const raw = process.env.GESTDEPOT_AUTO_BACKUP_DIR?.trim();
  if (!raw) return null;
  return path.resolve(raw);
}
async function createSqliteBackup(backupType, customNote) {
  const db = getDb();
  try {
    db.exec("PRAGMA wal_checkpoint(PASSIVE);");
  } catch {
  }
  const now = /* @__PURE__ */ new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const filename = `gestdepot_${backupType.toLowerCase()}_${stamp}.sqlite`;
  const destPath = path.join(BACKUPS_DIR, filename);
  await backup(db, destPath);
  const checkDb = new DatabaseSync(destPath, { readOnly: true });
  let integrityOk = 0;
  let integrityMsg = "OK";
  try {
    const res = checkDb.prepare("PRAGMA integrity_check;").get();
    integrityOk = res?.integrity_check === "ok" ? 1 : 0;
    integrityMsg = res?.integrity_check ?? "Erreur inconnue";
  } finally {
    checkDb.close();
  }
  let mirrorPath = null;
  const mirrorDir = getAutoBackupMirrorDir();
  if (integrityOk === 1 && mirrorDir && path.resolve(mirrorDir) !== path.resolve(BACKUPS_DIR)) {
    try {
      fs.mkdirSync(mirrorDir, { recursive: true });
      const finalMirror = path.join(mirrorDir, filename);
      const tmpMirror = path.join(mirrorDir, `.tmp_${filename}`);
      fs.copyFileSync(destPath, tmpMirror);
      fs.renameSync(tmpMirror, finalMirror);
      mirrorPath = finalMirror;
      const autoFiles = fs.readdirSync(mirrorDir).filter((f) => f.startsWith("gestdepot_") && f.endsWith(".sqlite")).sort();
      if (autoFiles.length > 30) {
        for (const oldFile of autoFiles.slice(0, autoFiles.length - 30)) {
          try {
            fs.unlinkSync(path.join(mirrorDir, oldFile));
          } catch {
          }
        }
      }
    } catch (mirrorErr) {
      console.error("Auto-backup mirror warning:", mirrorErr);
    }
  }
  const stat = fs.statSync(destPath);
  const createdAt = now.toISOString();
  const noteParts = [integrityMsg];
  if (customNote) noteParts.push(customNote);
  if (mirrorPath) noteParts.push(`Miroir local : ${mirrorPath}`);
  const insert = db.prepare(
    `INSERT INTO backup_history (filename, file_path, size_bytes, integrity_ok, backup_type, status, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    filename,
    destPath,
    stat.size,
    integrityOk,
    backupType,
    integrityOk ? "REUSSIE" : "ERREUR",
    noteParts.join(" \u2014 "),
    createdAt
  );
  return {
    id: Number(insert.lastInsertRowid),
    filename,
    file_path: destPath,
    mirror_path: mirrorPath,
    size_bytes: stat.size,
    integrity_ok: integrityOk,
    created_at: createdAt
  };
}
function initSchema() {
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
      customer_type TEXT NOT NULL DEFAULT 'D\xE9tail',
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
    db.exec("ALTER TABLE company_settings ADD COLUMN single_user_pin_migrated INTEGER NOT NULL DEFAULT 0;");
  } catch {
  }
  const csRow = db.prepare("SELECT id, single_user_pin_migrated FROM company_settings WHERE id = 1").get();
  if (csRow && csRow.single_user_pin_migrated === 0) {
    db.prepare("UPDATE users SET pin_hash = ?, failed_attempts = 0, active = 1 WHERE username = 'admin'").run(
      hashSecret("5555")
    );
    db.prepare("UPDATE company_settings SET single_user_pin_migrated = 1 WHERE id = 1").run();
  }
  const phCount = db.prepare("SELECT COUNT(*) as cnt FROM product_price_history").get().cnt;
  const prodCount = db.prepare("SELECT COUNT(*) as cnt FROM products").get().cnt;
  if (phCount === 0 && prodCount > 0) {
    const existingPrices = db.prepare(
      `SELECT p.id AS product_id, p.created_at, pk.name AS packaging_name, pk.conversion_factor,
                pl.code AS price_list_code, pp.price_xof
         FROM product_prices pp
         JOIN products p ON p.id = pp.product_id
         JOIN product_packagings pk ON pk.id = pp.packaging_id
         JOIN price_lists pl ON pl.id = pp.price_list_id`
    ).all();
    const insPh = db.prepare(
      `INSERT INTO product_price_history
       (product_id, packaging_name, conversion_factor, price_list_code, previous_price_xof, new_price_xof, reason, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, 'Tarif initial catalogue', ?)`
    );
    for (const r of existingPrices) {
      insPh.run(r.product_id, r.packaging_name, r.conversion_factor, r.price_list_code, r.price_xof, r.created_at);
    }
    const prodsWithoutCostHist = db.prepare(
      `SELECT p.id, p.purchase_cost_xof, p.created_at
         FROM products p
         WHERE NOT EXISTS (SELECT 1 FROM product_cost_history ch WHERE ch.product_id = p.id)`
    ).all();
    const insCh = db.prepare(
      `INSERT INTO product_cost_history (product_id, previous_cost_xof, new_cost_xof, reason, created_at)
       VALUES (?, ?, ?, 'Co\xFBt initial catalogue', ?)`
    );
    for (const pr of prodsWithoutCostHist) {
      insCh.run(pr.id, pr.purchase_cost_xof, pr.purchase_cost_xof, pr.created_at);
    }
  }
}

// server/seed.ts
function seedIfEmpty() {
  const db = getDb();
  const countRow = db.prepare("SELECT COUNT(*) as cnt FROM users").get();
  if (countRow.cnt > 0) return;
  runInTransaction((tx) => {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    tx.prepare(
      `INSERT INTO company_settings (
        id, name, phone, address, city, registration_no, footer_note, currency,
        tax_enabled, tax_rate, reserve_stock_on_order, auto_backup_on_start, retention_daily,
        first_setup_completed, single_user_pin_migrated
      ) VALUES (1, ?, '', '', '', '', '', 'FCFA', 0, 0, 1, 1, 7, 0, 1)`
    ).run("Mon D\xE9p\xF4t");
    tx.prepare(
      `INSERT INTO users (username, full_name, role, password_hash, pin_hash, active, created_at)
       VALUES ('admin', 'Administrateur', 'ADMIN', ?, ?, 1, ?)`
    ).run(hashSecret("5555"), hashSecret("5555"), now);
    const defaultCategories = [
      "Bi\xE8res & Panach\xE9s",
      "Boissons Gazeuses",
      "Eaux Min\xE9rales",
      "Jus & \xC9nergisants",
      "Vins & Spiritueux"
    ];
    for (const c of defaultCategories) {
      tx.prepare("INSERT INTO categories (name) VALUES (?)").run(c);
    }
    const defaultUnits = [
      { code: "BTL", label: "Bouteille" },
      { code: "CAN", label: "Canette" },
      { code: "PCS", label: "Pi\xE8ce" },
      { code: "LIT", label: "Litre" }
    ];
    for (const u of defaultUnits) {
      tx.prepare("INSERT INTO units (code, label) VALUES (?, ?)").run(u.code, u.label);
    }
    tx.prepare("INSERT INTO price_lists (code, label, is_default) VALUES ('DETAIL', 'Tarif D\xE9tail', 1)").run();
    tx.prepare("INSERT INTO price_lists (code, label, is_default) VALUES ('GROS', 'Tarif Gros', 0)").run();
    tx.prepare("INSERT INTO price_lists (code, label, is_default) VALUES ('REVENDEUR', 'Tarif Revendeur', 0)").run();
    const defaultPayMethods = [
      { code: "ESPECES", label: "Esp\xE8ces", isCash: 1 },
      { code: "MOBILE_MONEY", label: "Mobile Money", isCash: 0 },
      { code: "CARTE", label: "Carte bancaire", isCash: 0 },
      { code: "VIREMENT", label: "Virement bancaire", isCash: 0 },
      { code: "CHEQUE", label: "Ch\xE8que", isCash: 0 }
    ];
    for (const pm of defaultPayMethods) {
      tx.prepare("INSERT INTO payment_methods (code, label, is_cash) VALUES (?, ?, ?)").run(
        pm.code,
        pm.label,
        pm.isCash
      );
    }
    const defaultExpenseCategories = [
      "Carburant & Livraison",
      "Manutention & Personnel",
      "\xC9lectricit\xE9 & Eau",
      "Loyer & Entretien",
      "Fournitures & Divers"
    ];
    for (const ec of defaultExpenseCategories) {
      tx.prepare("INSERT INTO expense_categories (name) VALUES (?)").run(ec);
    }
    const plDetail = tx.prepare("SELECT id FROM price_lists WHERE code = 'DETAIL'").get().id;
    tx.prepare(
      `INSERT INTO customers (code, name, phone, address, customer_type, price_list_id, credit_limit_xof, active, created_at)
       VALUES ('CLI-000', 'Client Comptoir', '', '', 'Comptoir', ?, 0, 1, ?)`
    ).run(plDetail, now);
    writeAuditLog(tx, {
      userId: 1,
      userName: "Administrateur",
      action: "INITIALISATION_SYSTEME",
      entityType: "SYSTEME",
      details: "Base locale GestDepot initialis\xE9e vierge (pr\xEAte pour vos donn\xE9es r\xE9elles)."
    });
  });
}

// server/rbac.ts
var ROLE_PERMISSIONS = {
  ADMIN: [
    "dashboard",
    "pos",
    "orders",
    "catalog",
    "catalog_edit",
    "stock",
    "stock_adjust",
    "deposits",
    "customers",
    "deliveries",
    "suppliers",
    "purchases",
    "cash_expenses",
    "inventories",
    "margins",
    "reports",
    "settings_users",
    "backups",
    "sensitive_override"
  ],
  GERANT: [
    "dashboard",
    "pos",
    "orders",
    "catalog",
    "catalog_edit",
    "stock",
    "stock_adjust",
    "deposits",
    "customers",
    "deliveries",
    "suppliers",
    "purchases",
    "cash_expenses",
    "inventories",
    "margins",
    "reports",
    "sensitive_override"
  ],
  CAISSIER: ["dashboard", "pos", "orders", "customers", "deposits", "cash_expenses"],
  MAGASINIER: ["dashboard", "catalog", "stock", "stock_adjust", "deposits", "purchases", "inventories", "deliveries"],
  LIVREUR: ["deliveries"]
};
function hasPermission(role, permission) {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
function getPermissionsForRole(role) {
  return ROLE_PERMISSIONS[role] ?? [];
}

// server/middleware.ts
function attachAuth(req, _res, next) {
  const token = req.headers["x-session-token"] || req.query.token;
  if (!token) {
    return next();
  }
  const db = getDb();
  const row = db.prepare(
    `SELECT u.id, u.username, u.full_name, u.role, u.active, s.expires_at
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
  ).get(token);
  if (row && row.active === 1 && new Date(row.expires_at).getTime() > Date.now()) {
    req.user = {
      id: row.id,
      username: row.username,
      full_name: row.full_name,
      role: row.role
    };
    req.sessionToken = token;
  }
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: "Authentification requise. Veuillez vous connecter." });
    return;
  }
  next();
}
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: "Session expir\xE9e ou non authentifi\xE9e." });
      return;
    }
    if (!hasPermission(req.user.role, permission)) {
      res.status(403).json({
        error: `Acc\xE8s refus\xE9 : le r\xF4le ${req.user.role} ne dispose pas de la permission "${permission}".`
      });
      return;
    }
    next();
  };
}
function verifySupervisorCredentials(username, secret) {
  const db = getDb();
  const cleanUser = username.trim();
  const row = cleanUser && cleanUser !== "admin" ? db.prepare(
    `SELECT id, username, full_name, role, password_hash, pin_hash, active
             FROM users WHERE username = ?`
  ).get(cleanUser) : db.prepare(
    `SELECT id, username, full_name, role, password_hash, pin_hash, active
             FROM users WHERE active = 1 AND role = 'ADMIN' ORDER BY id ASC LIMIT 1`
  ).get();
  if (!row || row.active !== 1) return null;
  if (row.role !== "ADMIN" && row.role !== "GERANT") return null;
  const valid = verifySecret(secret.trim(), row.pin_hash) || verifySecret(secret.trim(), row.password_hash);
  if (!valid) return null;
  return {
    id: row.id,
    username: row.username,
    full_name: row.full_name,
    role: row.role
  };
}
function toIntXof(val, fieldName = "montant") {
  const num = Number(val);
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new Error(`Le champ "${fieldName}" doit \xEAtre un nombre entier exact en FCFA.`);
  }
  return num;
}
function toPositiveInt(val, fieldName = "quantit\xE9") {
  const num = Number(val);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
    throw new Error(`Le champ "${fieldName}" doit \xEAtre un entier strictement positif.`);
  }
  return num;
}

// server/routes-core.ts
import { Router } from "express";
import crypto2 from "node:crypto";
var coreRouter = Router();
var pinCooldownUntil = 0;
coreRouter.get("/auth/pin-status", (_req, res) => {
  const db = getDb();
  const adminUser = db.prepare("SELECT pin_hash FROM users WHERE active = 1 AND role = 'ADMIN' ORDER BY id ASC LIMIT 1").get();
  const company = db.prepare("SELECT name FROM company_settings WHERE id = 1").get();
  res.json({
    isDefaultPin: adminUser?.pin_hash ? verifySecret("5555", adminUser.pin_hash) : false,
    depotName: company?.name || "GestDepot"
  });
});
coreRouter.post("/auth/login", (req, res) => {
  const { pin, username, secret } = req.body;
  const providedPin = (pin ?? secret ?? "").trim();
  if (!providedPin) {
    res.status(400).json({ error: "Veuillez saisir votre Code PIN." });
    return;
  }
  if (Date.now() < pinCooldownUntil) {
    const secs = Math.max(1, Math.ceil((pinCooldownUntil - Date.now()) / 1e3));
    res.status(429).json({ error: `Trop de tentatives. R\xE9essayez dans ${secs} seconde(s).` });
    return;
  }
  const db = getDb();
  const user = username?.trim() ? db.prepare(
    `SELECT id, username, full_name, role, password_hash, pin_hash, active, failed_attempts
             FROM users WHERE username = ?`
  ).get(username.trim()) : db.prepare(
    `SELECT id, username, full_name, role, password_hash, pin_hash, active, failed_attempts
             FROM users WHERE active = 1 AND role = 'ADMIN' ORDER BY id ASC LIMIT 1`
  ).get();
  if (!user || user.active !== 1) {
    res.status(401).json({ error: "Code PIN invalide." });
    return;
  }
  const ok = pin !== void 0 ? verifySecret(providedPin, user.pin_hash) : verifySecret(providedPin, user.pin_hash) || verifySecret(providedPin, user.password_hash);
  if (!ok) {
    const nextAttempts = user.failed_attempts + 1;
    if (nextAttempts >= 5) {
      pinCooldownUntil = Date.now() + 15e3;
      db.prepare("UPDATE users SET failed_attempts = 0 WHERE id = ?").run(user.id);
    } else {
      db.prepare("UPDATE users SET failed_attempts = ? WHERE id = ?").run(nextAttempts, user.id);
    }
    writeAuditLog(db, {
      userId: user.id,
      userName: user.full_name,
      action: "CONNEXION_ECHEC",
      entityType: "SECURITE",
      entityId: user.id,
      details: "Tentative de d\xE9verrouillage avec Code PIN incorrect"
    });
    res.status(401).json({
      error: nextAttempts >= 5 ? "Code PIN incorrect. Temporisation de s\xE9curit\xE9 de 15 secondes." : "Code PIN incorrect."
    });
    return;
  }
  pinCooldownUntil = 0;
  const token = crypto2.randomBytes(24).toString("hex");
  const now = /* @__PURE__ */ new Date();
  const expires = new Date(now.getTime() + 24 * 3600 * 1e3);
  runInTransaction((tx) => {
    tx.prepare("UPDATE users SET failed_attempts = 0, last_login_at = ? WHERE id = ?").run(
      now.toISOString(),
      user.id
    );
    tx.prepare("INSERT INTO user_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
      token,
      user.id,
      now.toISOString(),
      expires.toISOString()
    );
    writeAuditLog(tx, {
      userId: user.id,
      userName: user.full_name,
      action: "CONNEXION_REUSSIE",
      entityType: "SECURITE",
      entityId: user.id,
      details: "D\xE9verrouillage de session par Code PIN"
    });
  });
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      permissions: getPermissionsForRole(user.role)
    }
  });
});
coreRouter.put("/auth/pin", requireAuth, (req, res) => {
  try {
    const { current_pin, new_pin } = req.body;
    const current = (current_pin ?? "").trim();
    const next = (new_pin ?? "").trim();
    if (!current) {
      res.status(400).json({ error: "Veuillez saisir le code PIN actuel." });
      return;
    }
    if (!/^\d{4,8}$/.test(next)) {
      res.status(400).json({ error: "Le nouveau code PIN doit contenir uniquement entre 4 et 8 chiffres." });
      return;
    }
    const db = getDb();
    const row = db.prepare("SELECT id, full_name, pin_hash FROM users WHERE id = ?").get(req.user.id);
    if (!row || !verifySecret(current, row.pin_hash)) {
      res.status(403).json({ error: "Le code PIN actuel est incorrect." });
      return;
    }
    db.prepare("UPDATE users SET pin_hash = ?, failed_attempts = 0 WHERE id = ?").run(hashSecret(next), row.id);
    writeAuditLog(db, {
      userId: row.id,
      userName: row.full_name,
      action: "MODIFICATION_CODE_PIN",
      entityType: "SECURITE",
      entityId: row.id,
      details: "Code PIN d\u2019acc\xE8s modifi\xE9 depuis Param\xE8tres avanc\xE9s"
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
coreRouter.post("/auth/logout", requireAuth, (req, res) => {
  const db = getDb();
  if (req.sessionToken) {
    db.prepare("DELETE FROM user_sessions WHERE token = ?").run(req.sessionToken);
  }
  if (req.user) {
    writeAuditLog(db, {
      userId: req.user.id,
      userName: req.user.full_name,
      action: "DECONNEXION",
      entityType: "SECURITE",
      entityId: req.user.id,
      details: "Verrouillage manuel de la session"
    });
  }
  res.json({ ok: true });
});
coreRouter.get("/auth/me", requireAuth, (req, res) => {
  const u = req.user;
  const db = getDb();
  const row = db.prepare("SELECT pin_hash FROM users WHERE id = ?").get(u.id);
  res.json({
    user: {
      ...u,
      permissions: getPermissionsForRole(u.role),
      isDefaultPin: row?.pin_hash ? verifySecret("5555", row.pin_hash) : false
    }
  });
});
coreRouter.post("/auth/verify-supervisor", requireAuth, (req, res) => {
  const { username, secret } = req.body;
  if (!secret) {
    res.status(400).json({ error: "Code PIN requis." });
    return;
  }
  const sup = verifySupervisorCredentials(username || "admin", secret);
  if (!sup) {
    res.status(403).json({ error: "Code PIN incorrect ou droits insuffisants." });
    return;
  }
  res.json({ verified: true, supervisor: sup });
});
coreRouter.get("/dashboard", requireAuth, (req, res) => {
  const db = getDb();
  const period = req.query.period || "7d";
  const now = /* @__PURE__ */ new Date();
  let start = /* @__PURE__ */ new Date();
  let end = /* @__PURE__ */ new Date();
  if (period === "today") {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (period === "yesterday") {
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() - 1);
    end.setHours(23, 59, 59, 999);
  } else if (period === "month") {
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (period === "custom" && req.query.from && req.query.to) {
    start = /* @__PURE__ */ new Date(`${req.query.from}T00:00:00.000Z`);
    end = /* @__PURE__ */ new Date(`${req.query.to}T23:59:59.999Z`);
  } else {
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  }
  const fromIso = start.toISOString();
  const toIso = end.toISOString();
  const salesAgg = db.prepare(
    `SELECT
         COALESCE(SUM(subtotal_xof - discount_xof), 0) AS gross_sales_xof,
         COUNT(*) AS sales_count
       FROM sales
       WHERE status != 'ANNULEE' AND created_at >= ? AND created_at <= ?`
  ).get(fromIso, toIso);
  const returnsAgg = db.prepare(
    `SELECT COALESCE(SUM(total_refund_xof), 0) AS returns_xof
       FROM sale_returns
       WHERE created_at >= ? AND created_at <= ?`
  ).get(fromIso, toIso);
  const netRevenueXof = salesAgg.gross_sales_xof - returnsAgg.returns_xof;
  const collectionsByMethod = db.prepare(
    `SELECT payment_method, COALESCE(SUM(amount_signed_xof), 0) AS total_xof
       FROM cash_movements
       WHERE movement_type IN ('VENTE_ENCAISSEMENT', 'REGLEMENT_CREANCE')
         AND created_at >= ? AND created_at <= ?
       GROUP BY payment_method
       ORDER BY total_xof DESC`
  ).all(fromIso, toIso);
  const totalCollectionsXof = collectionsByMethod.reduce((acc, r) => acc + r.total_xof, 0);
  const receivablesAgg = db.prepare(
    `SELECT COALESCE(SUM(credit_due_xof), 0) AS open_receivables_xof,
              COUNT(CASE WHEN credit_due_xof > 0 THEN 1 END) AS open_credit_sales
       FROM sales WHERE status != 'ANNULEE' AND credit_due_xof > 0`
  ).get();
  const todayDate = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const overdueCredits = db.prepare(
    `SELECT s.id, s.sale_number, c.name AS customer_name, s.credit_due_xof, s.due_date
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       WHERE s.status != 'ANNULEE' AND s.credit_due_xof > 0 AND s.due_date IS NOT NULL AND s.due_date < ?
       ORDER BY s.due_date ASC`
  ).all(todayDate);
  const payablesAgg = db.prepare(
    `SELECT COALESCE(SUM(MAX(0, total_xof - paid_xof)), 0) AS open_payables_xof
       FROM purchase_orders WHERE status IN ('CONFIRMEE', 'PARTIELLE', 'RECUE')`
  ).get();
  const expensesAgg = db.prepare(
    `SELECT COALESCE(SUM(amount_xof), 0) AS expenses_xof
       FROM expenses
       WHERE created_at >= ? AND created_at <= ?`
  ).get(fromIso, toIso);
  const marginAgg = db.prepare(
    `SELECT
         COALESCE(SUM(sl.line_total_xof), 0) AS line_rev_xof,
         COALESCE(SUM(sl.base_qty * sl.unit_cost_xof), 0) AS cogs_xof
       FROM sale_lines sl
       JOIN sales s ON s.id = sl.sale_id
       WHERE s.status != 'ANNULEE' AND s.created_at >= ? AND s.created_at <= ?`
  ).get(fromIso, toIso);
  const grossMarginXof = netRevenueXof - marginAgg.cogs_xof;
  const estimatedResultXof = grossMarginXof - expensesAgg.expenses_xof;
  const stockAgg = db.prepare(
    `SELECT
         COALESCE(SUM(MAX(0, sb.physical_qty) * p.purchase_cost_xof), 0) AS stock_value_xof,
         COUNT(CASE WHEN (sb.physical_qty - sb.reserved_qty) <= 0 THEN 1 END) AS out_of_stock_count,
         COUNT(CASE WHEN (sb.physical_qty - sb.reserved_qty) > 0 AND (sb.physical_qty - sb.reserved_qty) <= p.min_threshold THEN 1 END) AS low_stock_count
       FROM products p
       JOIN stock_balances sb ON sb.product_id = p.id
       WHERE p.active = 1`
  ).get();
  const lowStockItems = db.prepare(
    `SELECT p.id, p.sku, p.name, c.name AS category_name,
              (sb.physical_qty - sb.reserved_qty) AS available_qty,
              sb.physical_qty, sb.reserved_qty,
              p.min_threshold, p.safety_stock,
              u.code AS unit_code, u.label AS unit_label,
              s.name AS default_supplier_name
       FROM products p
       JOIN stock_balances sb ON sb.product_id = p.id
       JOIN categories c ON c.id = p.category_id
       JOIN units u ON u.id = p.unit_id
       LEFT JOIN suppliers s ON s.id = p.default_supplier_id
       WHERE p.active = 1 AND (sb.physical_qty - sb.reserved_qty) <= p.min_threshold
       ORDER BY
         CASE WHEN (sb.physical_qty - sb.reserved_qty) <= 0 THEN 0 ELSE 1 END ASC,
         (CAST((sb.physical_qty - sb.reserved_qty) AS REAL) / MAX(1, p.min_threshold)) ASC,
         p.name ASC`
  ).all();
  const pendingOrdersCount = db.prepare(
    `SELECT COUNT(*) as cnt FROM customer_orders WHERE status IN ('CONFIRMEE', 'EN_PREPARATION', 'PRETE')`
  ).get().cnt;
  const pendingDeliveriesCount = db.prepare(`SELECT COUNT(*) as cnt FROM deliveries WHERE status IN ('PLANIFIEE', 'EN_COURS', 'LIVREE_PARTIELLE')`).get().cnt;
  const pad2 = (n) => String(n).padStart(2, "0");
  const toDayKey = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const endUtc = new Date(Date.UTC(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999));
  const startUtc = new Date(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0, 0));
  const spanDays = Math.max(1, Math.round((endUtc.getTime() - startUtc.getTime()) / 864e5) + 1);
  const dailyStartUtc = spanDays < 7 ? new Date(Date.UTC(endUtc.getUTCFullYear(), endUtc.getUTCMonth(), endUtc.getUTCDate() - 6, 0, 0, 0, 0)) : spanDays > 62 ? new Date(Date.UTC(endUtc.getUTCFullYear(), endUtc.getUTCMonth(), endUtc.getUTCDate() - 61, 0, 0, 0, 0)) : startUtc;
  const dailySalesRows = db.prepare(
    `SELECT substr(created_at, 1, 10) AS day,
              COALESCE(SUM(subtotal_xof - discount_xof), 0) AS revenue_xof,
              COUNT(*) AS count
       FROM sales
       WHERE status != 'ANNULEE' AND created_at >= ? AND created_at <= ?
       GROUP BY substr(created_at, 1, 10)`
  ).all(dailyStartUtc.toISOString(), endUtc.toISOString());
  const dailyReturnsRows = db.prepare(
    `SELECT substr(created_at, 1, 10) AS day,
              COALESCE(SUM(total_refund_xof), 0) AS returns_xof
       FROM sale_returns
       WHERE created_at >= ? AND created_at <= ?
       GROUP BY substr(created_at, 1, 10)`
  ).all(dailyStartUtc.toISOString(), endUtc.toISOString());
  const dailySalesMap = new Map(dailySalesRows.map((r) => [r.day, r]));
  const dailyReturnsMap = new Map(dailyReturnsRows.map((r) => [r.day, r.returns_xof]));
  const salesByDay = [];
  for (let cursor = new Date(dailyStartUtc.getTime()); cursor.getTime() <= endUtc.getTime(); cursor = new Date(cursor.getTime() + 864e5)) {
    const key = toDayKey(cursor);
    const s = dailySalesMap.get(key);
    const ret = dailyReturnsMap.get(key) ?? 0;
    const rev = s?.revenue_xof ?? 0;
    salesByDay.push({
      day: key,
      label: new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", timeZone: "UTC" }).format(cursor),
      revenue_xof: Math.max(0, rev - ret),
      returns_xof: ret,
      net_revenue_xof: rev - ret,
      count: s?.count ?? 0
    });
  }
  const endDow = (endUtc.getUTCDay() + 6) % 7;
  const currentWeekMonday = new Date(
    Date.UTC(endUtc.getUTCFullYear(), endUtc.getUTCMonth(), endUtc.getUTCDate() - endDow, 0, 0, 0, 0)
  );
  const firstWeekMonday = new Date(currentWeekMonday.getTime() - 7 * 7 * 864e5);
  const weeklySalesRaw = db.prepare(
    `SELECT substr(created_at, 1, 10) AS day,
              COALESCE(SUM(subtotal_xof - discount_xof), 0) AS revenue_xof,
              COUNT(*) AS count
       FROM sales
       WHERE status != 'ANNULEE' AND created_at >= ? AND created_at <= ?
       GROUP BY substr(created_at, 1, 10)`
  ).all(firstWeekMonday.toISOString(), endUtc.toISOString());
  const weeklyReturnsRaw = db.prepare(
    `SELECT substr(created_at, 1, 10) AS day,
              COALESCE(SUM(total_refund_xof), 0) AS returns_xof
       FROM sale_returns
       WHERE created_at >= ? AND created_at <= ?
       GROUP BY substr(created_at, 1, 10)`
  ).all(firstWeekMonday.toISOString(), endUtc.toISOString());
  const weekSalesMap = new Map(weeklySalesRaw.map((r) => [r.day, r]));
  const weekReturnsMap = new Map(weeklyReturnsRaw.map((r) => [r.day, r.returns_xof]));
  const getIsoWeek = (d) => {
    const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    return Math.ceil(((tmp.getTime() - yearStart.getTime()) / 864e5 + 1) / 7);
  };
  const salesByWeek = [];
  for (let w = 0; w < 8; w++) {
    const wStart = new Date(firstWeekMonday.getTime() + w * 7 * 864e5);
    const wEnd = new Date(wStart.getTime() + 6 * 864e5);
    let rev = 0;
    let ret = 0;
    let cnt = 0;
    for (let d = 0; d < 7; d++) {
      const dayKey = toDayKey(new Date(wStart.getTime() + d * 864e5));
      const row = weekSalesMap.get(dayKey);
      if (row) {
        rev += row.revenue_xof;
        cnt += row.count;
      }
      ret += weekReturnsMap.get(dayKey) ?? 0;
    }
    const isoW = getIsoWeek(wStart);
    const shortStart = new Intl.DateTimeFormat("fr-FR", {
      day: "2-digit",
      month: "2-digit",
      timeZone: "UTC"
    }).format(wStart);
    salesByWeek.push({
      week_key: `${wStart.getUTCFullYear()}-S${String(isoW).padStart(2, "0")}`,
      label: `S${isoW} (${shortStart})`,
      week_start: toDayKey(wStart),
      week_end: toDayKey(wEnd),
      revenue_xof: Math.max(0, rev - ret),
      returns_xof: ret,
      net_revenue_xof: rev - ret,
      count: cnt
    });
  }
  const salesByCategory = db.prepare(
    `SELECT c.name AS category,
              COALESCE(SUM(sl.line_total_xof), 0) AS revenue_xof,
              COALESCE(SUM(sl.line_total_xof - (sl.base_qty * sl.unit_cost_xof)), 0) AS margin_xof
       FROM sale_lines sl
       JOIN sales s ON s.id = sl.sale_id
       JOIN products p ON p.id = sl.product_id
       JOIN categories c ON c.id = p.category_id
       WHERE s.status != 'ANNULEE' AND s.created_at >= ? AND s.created_at <= ?
       GROUP BY c.id
       ORDER BY revenue_xof DESC`
  ).all(fromIso, toIso);
  const topProducts = db.prepare(
    `SELECT sl.product_id, sl.product_name,
              SUM(sl.base_qty) AS total_base_qty,
              COALESCE(SUM(sl.line_total_xof), 0) AS revenue_xof,
              COALESCE(SUM(sl.line_total_xof - (sl.base_qty * sl.unit_cost_xof)), 0) AS margin_xof
       FROM sale_lines sl
       JOIN sales s ON s.id = sl.sale_id
       WHERE s.status != 'ANNULEE' AND s.created_at >= ? AND s.created_at <= ?
       GROUP BY sl.product_id
       ORDER BY revenue_xof DESC
       LIMIT 6`
  ).all(fromIso, toIso);
  const lastBackup = db.prepare("SELECT id, filename, integrity_ok, status, created_at FROM backup_history ORDER BY id DESC LIMIT 1").get();
  res.json({
    period,
    fromIso,
    toIso,
    kpis: {
      netRevenueXof,
      salesCount: salesAgg.sales_count,
      returnsXof: returnsAgg.returns_xof,
      totalCollectionsXof,
      openReceivablesXof: receivablesAgg.open_receivables_xof,
      openCreditSales: receivablesAgg.open_credit_sales,
      openPayablesXof: payablesAgg.open_payables_xof,
      expensesXof: expensesAgg.expenses_xof,
      grossMarginXof,
      estimatedResultXof,
      stockValueXof: stockAgg.stock_value_xof,
      outOfStockCount: stockAgg.out_of_stock_count,
      lowStockCount: stockAgg.low_stock_count,
      pendingOrdersCount,
      pendingDeliveriesCount
    },
    collectionsByMethod,
    salesByDay,
    salesByWeek,
    salesByCategory,
    topProducts,
    lowStockItems,
    overdueCredits,
    lastBackup: lastBackup ?? null
  });
});
coreRouter.get("/catalog/meta", requireAuth, (_req, res) => {
  const db = getDb();
  res.json({
    categories: db.prepare("SELECT * FROM categories WHERE active = 1 ORDER BY name").all(),
    brands: db.prepare("SELECT * FROM brands WHERE active = 1 ORDER BY name").all(),
    units: db.prepare("SELECT * FROM units ORDER BY label").all(),
    priceLists: db.prepare("SELECT * FROM price_lists ORDER BY id").all(),
    paymentMethods: db.prepare("SELECT * FROM payment_methods WHERE active = 1 ORDER BY id").all(),
    returnablePackagings: db.prepare("SELECT * FROM returnable_packaging WHERE active = 1 ORDER BY code").all(),
    suppliers: db.prepare("SELECT id, code, name FROM suppliers WHERE active = 1 ORDER BY name").all(),
    expenseCategories: db.prepare("SELECT * FROM expense_categories WHERE active = 1 ORDER BY name").all()
  });
});
coreRouter.get("/products", requireAuth, (req, res) => {
  const db = getDb();
  const includeArchived = req.query.archived === "1";
  const products = db.prepare(
    `SELECT p.*,
              c.name AS category_name,
              b.name AS brand_name,
              u.code AS unit_code,
              u.label AS unit_label,
              rp.code AS deposit_code,
              rp.label AS deposit_label,
              rp.deposit_value_xof,
              s.name AS default_supplier_name,
              COALESCE(sb.physical_qty, 0) AS physical_qty,
              COALESCE(sb.reserved_qty, 0) AS reserved_qty,
              (COALESCE(sb.physical_qty, 0) - COALESCE(sb.reserved_qty, 0)) AS available_qty
       FROM products p
       JOIN categories c ON c.id = p.category_id
       JOIN brands b ON b.id = p.brand_id
       JOIN units u ON u.id = p.unit_id
       LEFT JOIN returnable_packaging rp ON rp.id = p.packaging_deposit_id
       LEFT JOIN suppliers s ON s.id = p.default_supplier_id
       LEFT JOIN stock_balances sb ON sb.product_id = p.id
       ${includeArchived ? "" : "WHERE p.active = 1"}
       ORDER BY p.is_favorite DESC, p.name ASC`
  ).all();
  const packStmt = db.prepare("SELECT * FROM product_packagings WHERE product_id = ? ORDER BY conversion_factor DESC");
  const priceStmt = db.prepare(
    `SELECT pp.*, pl.code AS price_list_code, pl.label AS price_list_label
     FROM product_prices pp
     JOIN price_lists pl ON pl.id = pp.price_list_id
     WHERE pp.product_id = ?`
  );
  const enriched = products.map((p) => ({
    ...p,
    packagings: packStmt.all(p.id),
    prices: priceStmt.all(p.id)
  }));
  res.json(enriched);
});
coreRouter.post("/products", requirePermission("catalog_edit"), (req, res) => {
  try {
    const body = req.body;
    if (!body.sku?.trim() || !body.name?.trim()) {
      res.status(400).json({ error: "R\xE9f\xE9rence SKU et d\xE9signation obligatoires." });
      return;
    }
    if (!body.packagings || body.packagings.length === 0) {
      res.status(400).json({ error: "D\xE9finissez au moins un conditionnement (ex. Bouteille ou Casier)." });
      return;
    }
    const cost = toIntXof(body.purchase_cost_xof, "prix d\u2019achat");
    const minT = toIntXof(body.min_threshold ?? 0, "seuil minimum");
    const safety = toIntXof(body.safety_stock ?? 0, "stock de s\xE9curit\xE9");
    const initStock = toIntXof(body.initial_stock ?? 0, "stock initial");
    if (cost < 0 || minT < 0 || safety < 0 || initStock < 0) {
      res.status(400).json({ error: "Les montants et seuils ne peuvent pas \xEAtre n\xE9gatifs." });
      return;
    }
    const productId = runInTransaction((tx) => {
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const ins = tx.prepare(
        `INSERT INTO products (
            sku, name, description, category_id, brand_id, unit_id, barcode,
            purchase_cost_xof, min_threshold, safety_stock, track_batches,
            packaging_deposit_id, default_supplier_id, is_favorite, active, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
      ).run(
        body.sku.trim().toUpperCase(),
        body.name.trim(),
        body.description?.trim() ?? "",
        body.category_id,
        body.brand_id,
        body.unit_id,
        body.barcode?.trim() || null,
        cost,
        minT,
        safety,
        body.track_batches ? 1 : 0,
        body.packaging_deposit_id || null,
        body.default_supplier_id || null,
        body.is_favorite ? 1 : 0,
        now
      );
      const pid = Number(ins.lastInsertRowid);
      tx.prepare(
        `INSERT INTO product_cost_history (product_id, previous_cost_xof, new_cost_xof, reason, user_id, created_at)
         VALUES (?, ?, ?, 'Cr\xE9ation fiche produit', ?, ?)`
      ).run(pid, cost, cost, req.user.id, now);
      const plRows = tx.prepare("SELECT id, code FROM price_lists").all();
      const plCodeById = new Map(plRows.map((pl) => [pl.id, pl.code]));
      for (const pack of body.packagings) {
        const factor = toPositiveInt(pack.conversion_factor, "facteur de conversion");
        const pIns = tx.prepare(
          `INSERT INTO product_packagings (product_id, name, conversion_factor, is_default_sale, is_default_purchase, apply_deposit)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).run(pid, pack.name.trim(), factor, pack.is_default_sale ? 1 : 0, factor > 1 ? 1 : 0, pack.apply_deposit ? 1 : 0);
        const packId = Number(pIns.lastInsertRowid);
        for (const [listIdStr, priceVal] of Object.entries(pack.prices || {})) {
          const listId = Number(listIdStr);
          const priceXof = toIntXof(priceVal, "prix de vente");
          tx.prepare(
            "INSERT INTO product_prices (product_id, packaging_id, price_list_id, price_xof) VALUES (?, ?, ?, ?)"
          ).run(pid, packId, listId, priceXof);
          tx.prepare(
            `INSERT INTO product_price_history
             (product_id, packaging_name, conversion_factor, price_list_code, previous_price_xof, new_price_xof, reason, user_id, created_at)
             VALUES (?, ?, ?, ?, NULL, ?, 'Cr\xE9ation fiche produit', ?, ?)`
          ).run(pid, pack.name.trim(), factor, plCodeById.get(listId) || `TARIF_${listId}`, priceXof, req.user.id, now);
        }
      }
      tx.prepare("INSERT INTO stock_balances (product_id, physical_qty, reserved_qty) VALUES (?, ?, 0)").run(
        pid,
        initStock
      );
      if (initStock > 0) {
        tx.prepare(
          `INSERT INTO stock_movements (product_id, movement_type, qty_signed, unit_cost_xof, reference_doc, comment, user_id, created_at)
           VALUES (?, 'INITIAL', ?, ?, 'CATALOGUE-INIT', 'Stock initial \xE0 la cr\xE9ation du produit', ?, ?)`
        ).run(pid, initStock, cost, req.user.id, now);
      }
      writeAuditLog(tx, {
        userId: req.user.id,
        userName: req.user.full_name,
        action: "CREATION_PRODUIT",
        entityType: "PRODUIT",
        entityId: pid,
        details: `Cr\xE9ation ${body.sku.trim().toUpperCase()} \u2014 ${body.name.trim()} (co\xFBt ${cost} FCFA)`
      });
      return pid;
    });
    res.status(201).json({ id: productId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
coreRouter.put("/products/:id", requirePermission("catalog_edit"), (req, res) => {
  try {
    const productId = Number(req.params.id);
    const body = req.body;
    const cost = toIntXof(body.purchase_cost_xof, "prix d\u2019achat");
    const minT = toIntXof(body.min_threshold ?? 0, "seuil minimum");
    const safety = toIntXof(body.safety_stock ?? 0, "stock de s\xE9curit\xE9");
    runInTransaction((tx) => {
      const existing = tx.prepare("SELECT id, purchase_cost_xof, name FROM products WHERE id = ?").get(productId);
      if (!existing) throw new Error("Produit introuvable.");
      if (existing.purchase_cost_xof !== cost) {
        tx.prepare(
          `INSERT INTO product_cost_history (product_id, previous_cost_xof, new_cost_xof, reason, user_id, created_at)
           VALUES (?, ?, ?, 'Modification fiche produit', ?, ?)`
        ).run(productId, existing.purchase_cost_xof, cost, req.user.id, (/* @__PURE__ */ new Date()).toISOString());
      }
      tx.prepare(
        `UPDATE products
         SET name = ?, description = ?, category_id = ?, brand_id = ?, unit_id = ?, barcode = ?,
             purchase_cost_xof = ?, min_threshold = ?, safety_stock = ?, track_batches = ?,
             packaging_deposit_id = ?, default_supplier_id = ?, is_favorite = ?
         WHERE id = ?`
      ).run(
        body.name.trim(),
        body.description?.trim() ?? "",
        body.category_id,
        body.brand_id,
        body.unit_id,
        body.barcode?.trim() || null,
        cost,
        minT,
        safety,
        body.track_batches ? 1 : 0,
        body.packaging_deposit_id || null,
        body.default_supplier_id || null,
        body.is_favorite ? 1 : 0,
        productId
      );
      if (body.packagings && body.packagings.length > 0) {
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const prevPriceRows = tx.prepare(
          `SELECT pk.conversion_factor, pl.code AS price_list_code, pp.price_xof
             FROM product_prices pp
             JOIN product_packagings pk ON pk.id = pp.packaging_id
             JOIN price_lists pl ON pl.id = pp.price_list_id
             WHERE pp.product_id = ?`
        ).all(productId);
        const prevPriceMap = /* @__PURE__ */ new Map();
        for (const r of prevPriceRows) {
          prevPriceMap.set(`${r.conversion_factor}:${r.price_list_code}`, r.price_xof);
        }
        const plRows = tx.prepare("SELECT id, code FROM price_lists").all();
        const plCodeById = new Map(plRows.map((pl) => [pl.id, pl.code]));
        tx.prepare("DELETE FROM product_prices WHERE product_id = ?").run(productId);
        tx.prepare("DELETE FROM product_packagings WHERE product_id = ?").run(productId);
        for (const pack of body.packagings) {
          const factor = toPositiveInt(pack.conversion_factor, "facteur de conversion");
          const pIns = tx.prepare(
            `INSERT INTO product_packagings (product_id, name, conversion_factor, is_default_sale, is_default_purchase, apply_deposit)
               VALUES (?, ?, ?, ?, ?, ?)`
          ).run(
            productId,
            pack.name.trim(),
            factor,
            pack.is_default_sale ? 1 : 0,
            factor > 1 ? 1 : 0,
            pack.apply_deposit ? 1 : 0
          );
          const packId = Number(pIns.lastInsertRowid);
          for (const [listIdStr, priceVal] of Object.entries(pack.prices || {})) {
            const listId = Number(listIdStr);
            const listCode = plCodeById.get(listId) || `TARIF_${listId}`;
            const nextPrice = toIntXof(priceVal, "tarif");
            tx.prepare(
              "INSERT INTO product_prices (product_id, packaging_id, price_list_id, price_xof) VALUES (?, ?, ?, ?)"
            ).run(productId, packId, listId, nextPrice);
            const prevPrice = prevPriceMap.get(`${factor}:${listCode}`);
            if (prevPrice === void 0 || prevPrice !== nextPrice) {
              tx.prepare(
                `INSERT INTO product_price_history
                 (product_id, packaging_name, conversion_factor, price_list_code, previous_price_xof, new_price_xof, reason, user_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'Modification fiche produit', ?, ?)`
              ).run(
                productId,
                pack.name.trim(),
                factor,
                listCode,
                prevPrice ?? null,
                nextPrice,
                req.user.id,
                now
              );
            }
          }
        }
      }
      writeAuditLog(tx, {
        userId: req.user.id,
        userName: req.user.full_name,
        action: "MODIFICATION_PRODUIT",
        entityType: "PRODUIT",
        entityId: productId,
        details: `Mise \xE0 jour ${body.name.trim()} (co\xFBt courant ${cost} FCFA)`
      });
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
coreRouter.get("/products/:id/price-history", requireAuth, (req, res) => {
  const db = getDb();
  const productId = Number(req.params.id);
  const product = db.prepare(
    `SELECT p.id, p.sku, p.name, p.purchase_cost_xof, p.min_threshold, p.safety_stock, p.created_at,
              c.name AS category_name, b.name AS brand_name, u.code AS unit_code, u.label AS unit_label
       FROM products p
       JOIN categories c ON c.id = p.category_id
       JOIN brands b ON b.id = p.brand_id
       JOIN units u ON u.id = p.unit_id
       WHERE p.id = ?`
  ).get(productId);
  if (!product) {
    res.status(404).json({ error: "Produit introuvable." });
    return;
  }
  const currentPackagings = db.prepare("SELECT * FROM product_packagings WHERE product_id = ? ORDER BY conversion_factor ASC").all(productId);
  const currentPrices = db.prepare(
    `SELECT pp.price_xof, pp.packaging_id, pl.code AS price_list_code, pl.label AS price_list_label,
              pk.name AS packaging_name, pk.conversion_factor
       FROM product_prices pp
       JOIN price_lists pl ON pl.id = pp.price_list_id
       JOIN product_packagings pk ON pk.id = pp.packaging_id
       WHERE pp.product_id = ?
       ORDER BY pk.conversion_factor ASC, pl.id ASC`
  ).all(productId);
  const costHistory = db.prepare(
    `SELECT id, previous_cost_xof, new_cost_xof, reason, created_at
       FROM product_cost_history
       WHERE product_id = ?
       ORDER BY created_at ASC, id ASC`
  ).all(productId);
  const priceHistory = db.prepare(
    `SELECT id, packaging_name, conversion_factor, price_list_code, previous_price_xof, new_price_xof, reason, created_at
       FROM product_price_history
       WHERE product_id = ?
       ORDER BY created_at ASC, id ASC`
  ).all(productId);
  const purchaseEvents = db.prepare(
    `SELECT pol.id, po.po_number AS doc_number, s.name AS party_name,
              pol.packaging_name, pol.conversion_factor, pol.qty_ordered AS qty,
              pol.unit_cost_xof, po.created_at
       FROM purchase_order_lines pol
       JOIN purchase_orders po ON po.id = pol.po_id
       JOIN suppliers s ON s.id = po.supplier_id
       WHERE pol.product_id = ? AND po.status != 'ANNULEE'
       ORDER BY po.created_at ASC, pol.id ASC`
  ).all(productId);
  const saleEvents = db.prepare(
    `SELECT sl.id, sa.sale_number AS doc_number, cu.name AS party_name,
              sl.packaging_name, sl.conversion_factor, sl.qty,
              sl.unit_price_xof, pl.code AS price_list_code, sa.created_at
       FROM sale_lines sl
       JOIN sales sa ON sa.id = sl.sale_id
       JOIN customers cu ON cu.id = sa.customer_id
       JOIN price_lists pl ON pl.id = sa.price_list_id
       WHERE sl.product_id = ? AND sa.status != 'ANNULEE'
       ORDER BY sa.created_at ASC, sl.id ASC
       LIMIT 120`
  ).all(productId);
  const events = [];
  for (const ch of costHistory) {
    events.push({
      id: `ch-${ch.id}`,
      created_at: ch.created_at,
      kind: "ACHAT_CUMP",
      kind_label: "Co\xFBt achat / CUMP (Unit\xE9)",
      packaging_name: product.unit_label,
      conversion_factor: 1,
      previous_xof: ch.previous_cost_xof,
      new_xof: ch.new_cost_xof,
      unit_normalized_xof: ch.new_cost_xof,
      details: ch.reason
    });
  }
  for (const ph of priceHistory) {
    const unitNorm = Math.round(ph.new_price_xof / Math.max(1, ph.conversion_factor));
    const kind = ph.price_list_code === "GROS" ? "VENTE_TARIF_GROS" : ph.price_list_code === "REVENDEUR" ? "VENTE_TARIF_REVENDEUR" : "VENTE_TARIF_DETAIL";
    events.push({
      id: `ph-${ph.id}`,
      created_at: ph.created_at,
      kind,
      kind_label: `Tarif vente ${ph.price_list_code}`,
      packaging_name: ph.packaging_name,
      conversion_factor: ph.conversion_factor,
      previous_xof: ph.previous_price_xof,
      new_xof: ph.new_price_xof,
      unit_normalized_xof: unitNorm,
      details: `${ph.reason} (${ph.packaging_name})`
    });
  }
  for (const pe of purchaseEvents) {
    const unitNorm = Math.round(pe.unit_cost_xof / Math.max(1, pe.conversion_factor));
    events.push({
      id: `po-${pe.id}`,
      created_at: pe.created_at,
      kind: "ACHAT_BON",
      kind_label: "Achat fournisseur",
      packaging_name: pe.packaging_name,
      conversion_factor: pe.conversion_factor,
      previous_xof: null,
      new_xof: pe.unit_cost_xof,
      unit_normalized_xof: unitNorm,
      details: `${pe.doc_number} \xB7 ${pe.party_name} (${pe.qty} \xD7 ${pe.packaging_name})`
    });
  }
  for (const se of saleEvents) {
    const unitNorm = Math.round(se.unit_price_xof / Math.max(1, se.conversion_factor));
    events.push({
      id: `sl-${se.id}`,
      created_at: se.created_at,
      kind: "VENTE_CLIENT",
      kind_label: `Vente (${se.price_list_code})`,
      packaging_name: se.packaging_name,
      conversion_factor: se.conversion_factor,
      previous_xof: null,
      new_xof: se.unit_price_xof,
      unit_normalized_xof: unitNorm,
      details: `${se.doc_number} \xB7 ${se.party_name} (${se.qty} \xD7 ${se.packaging_name})`
    });
  }
  events.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const curUnitDetail = currentPrices.find((p) => p.price_list_code === "DETAIL" && p.conversion_factor === 1)?.price_xof ?? Math.round(
    (currentPrices.find((p) => p.price_list_code === "DETAIL")?.price_xof ?? 0) / Math.max(1, currentPrices.find((p) => p.price_list_code === "DETAIL")?.conversion_factor ?? 1)
  );
  const curUnitGros = currentPrices.find((p) => p.price_list_code === "GROS" && p.conversion_factor === 1)?.price_xof ?? Math.round(
    (currentPrices.find((p) => p.price_list_code === "GROS")?.price_xof ?? 0) / Math.max(1, currentPrices.find((p) => p.price_list_code === "GROS")?.conversion_factor ?? 1)
  );
  let runningCost = costHistory[0]?.previous_cost_xof ?? product.purchase_cost_xof;
  let runningDetail = priceHistory.find((p) => p.price_list_code === "DETAIL" && p.conversion_factor === 1)?.new_price_xof ?? curUnitDetail;
  let runningGros = priceHistory.find((p) => p.price_list_code === "GROS" && p.conversion_factor === 1)?.new_price_xof ?? curUnitGros;
  const chartPoints = [];
  for (const ev of events) {
    if (ev.kind === "ACHAT_CUMP" || ev.kind === "ACHAT_BON") {
      runningCost = ev.unit_normalized_xof;
    } else if (ev.kind === "VENTE_TARIF_DETAIL") {
      if (ev.conversion_factor === 1 || runningDetail === 0) {
        runningDetail = ev.unit_normalized_xof;
      }
    } else if (ev.kind === "VENTE_TARIF_GROS") {
      if (ev.conversion_factor === 1 || runningGros === 0) {
        runningGros = ev.unit_normalized_xof;
      }
    } else if (ev.kind === "VENTE_CLIENT") {
      if (ev.details.includes("DETAIL") || ev.kind_label.includes("DETAIL")) {
        runningDetail = ev.unit_normalized_xof;
      } else if (ev.kind_label.includes("GROS")) {
        runningGros = ev.unit_normalized_xof;
      }
    }
    const dayKey = ev.created_at.slice(0, 10);
    const label = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short" }).format(new Date(ev.created_at));
    const existingIdx = chartPoints.findIndex((pt) => pt.date === dayKey);
    const point = {
      date: dayKey,
      label,
      purchase_cost_xof: runningCost,
      sale_detail_xof: runningDetail,
      sale_gros_xof: runningGros,
      note: `${ev.kind_label} \xB7 ${ev.details}`
    };
    if (existingIdx >= 0) {
      chartPoints[existingIdx] = point;
    } else {
      chartPoints.push(point);
    }
  }
  const todayKey = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const todayPoint = {
    date: todayKey,
    label: "Actuel",
    purchase_cost_xof: product.purchase_cost_xof,
    sale_detail_xof: curUnitDetail,
    sale_gros_xof: curUnitGros,
    note: "Tarifs et co\xFBt CUMP actuels du catalogue"
  };
  if (chartPoints.length === 0) {
    chartPoints.push(todayPoint);
  } else {
    const last = chartPoints[chartPoints.length - 1];
    if (last.purchase_cost_xof !== todayPoint.purchase_cost_xof || last.sale_detail_xof !== todayPoint.sale_detail_xof || last.sale_gros_xof !== todayPoint.sale_gros_xof) {
      chartPoints.push(todayPoint);
    }
  }
  res.json({
    product,
    currentPackagings,
    currentPrices,
    events: [...events].reverse(),
    // Most recent first for table
    chartPoints
  });
});
coreRouter.patch("/products/:id/archive", requirePermission("catalog_edit"), (req, res) => {
  const db = getDb();
  const productId = Number(req.params.id);
  const { active } = req.body;
  db.prepare("UPDATE products SET active = ? WHERE id = ?").run(active ? 1 : 0, productId);
  writeAuditLog(db, {
    userId: req.user.id,
    userName: req.user.full_name,
    action: active ? "REACTIVATION_PRODUIT" : "ARCHIVAGE_PRODUIT",
    entityType: "PRODUIT",
    entityId: productId,
    details: active ? "Produit r\xE9activ\xE9" : "Produit archiv\xE9 (historique conserv\xE9)"
  });
  res.json({ ok: true });
});
coreRouter.post("/products/import", requirePermission("catalog_edit"), (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({ error: "Aucune ligne valide \xE0 importer." });
      return;
    }
    let createdCount = 0;
    let skippedCount = 0;
    runInTransaction((tx) => {
      const now = (/* @__PURE__ */ new Date()).toISOString();
      let defaultUnit = tx.prepare("SELECT id FROM units ORDER BY id ASC LIMIT 1").get();
      if (!defaultUnit) {
        const uIns = tx.prepare("INSERT INTO units (code, label) VALUES ('PCS', 'Pi\xE8ce')").run();
        defaultUnit = { id: Number(uIns.lastInsertRowid) };
      }
      const plDetail = tx.prepare("SELECT id FROM price_lists WHERE code = 'DETAIL'").get()?.id ?? tx.prepare("SELECT id FROM price_lists ORDER BY id ASC LIMIT 1").get().id;
      const plGros = tx.prepare("SELECT id FROM price_lists WHERE code = 'GROS'").get()?.id ?? plDetail;
      for (const r of rows) {
        const sku = String(r.sku || "").trim().toUpperCase();
        const name = String(r.name || "").trim();
        if (!sku || !name) {
          skippedCount++;
          continue;
        }
        const exists = tx.prepare("SELECT id FROM products WHERE sku = ?").get(sku);
        if (exists) {
          skippedCount++;
          continue;
        }
        const catName = String(r.category || "").trim() || "G\xE9n\xE9ral";
        let cat = tx.prepare("SELECT id FROM categories WHERE name = ?").get(catName);
        if (!cat) {
          const cRes = tx.prepare("INSERT INTO categories (name) VALUES (?)").run(catName);
          cat = { id: Number(cRes.lastInsertRowid) };
        }
        const brandName = String(r.brand || "").trim() || "G\xE9n\xE9rique";
        let brand = tx.prepare("SELECT id FROM brands WHERE name = ?").get(brandName);
        if (!brand) {
          const bRes = tx.prepare("INSERT INTO brands (name) VALUES (?)").run(brandName);
          brand = { id: Number(bRes.lastInsertRowid) };
        }
        const cost = Math.max(0, Math.round(Number(r.purchase_cost_xof) || 0));
        const factor = Math.max(1, Math.round(Number(r.factor) || 1));
        const pIns = tx.prepare(
          `INSERT INTO products (sku, name, category_id, brand_id, unit_id, purchase_cost_xof, min_threshold, safety_stock, active, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, 0, 1, ?)`
        ).run(sku, name, cat.id, brand.id, defaultUnit.id, cost, now);
        const pid = Number(pIns.lastInsertRowid);
        const packName = String(r.pack_name || "").trim() || (factor > 1 ? `Lot \xD7${factor}` : "Unit\xE9");
        const pkIns = tx.prepare(
          `INSERT INTO product_packagings (product_id, name, conversion_factor, is_default_sale, is_default_purchase, apply_deposit)
             VALUES (?, ?, ?, 1, 1, 0)`
        ).run(pid, packName, factor);
        const pkId = Number(pkIns.lastInsertRowid);
        const detailPrice = Math.max(0, Math.round(Number(r.price_detail_xof) || 0));
        const grosPrice = Math.max(0, Math.round(Number(r.price_gros_xof) || 0));
        tx.prepare("INSERT INTO product_prices (product_id, packaging_id, price_list_id, price_xof) VALUES (?, ?, ?, ?)").run(
          pid,
          pkId,
          plDetail,
          detailPrice
        );
        if (plGros !== plDetail) {
          tx.prepare("INSERT INTO product_prices (product_id, packaging_id, price_list_id, price_xof) VALUES (?, ?, ?, ?)").run(
            pid,
            pkId,
            plGros,
            grosPrice
          );
        }
        tx.prepare(
          `INSERT INTO product_cost_history (product_id, previous_cost_xof, new_cost_xof, reason, user_id, created_at)
           VALUES (?, ?, ?, 'Import CSV catalogue', ?, ?)`
        ).run(pid, cost, cost, req.user.id, now);
        tx.prepare(
          `INSERT INTO product_price_history
           (product_id, packaging_name, conversion_factor, price_list_code, previous_price_xof, new_price_xof, reason, user_id, created_at)
           VALUES (?, ?, ?, 'DETAIL', NULL, ?, 'Import CSV catalogue', ?, ?)`
        ).run(pid, packName, factor, detailPrice, req.user.id, now);
        tx.prepare(
          `INSERT INTO product_price_history
           (product_id, packaging_name, conversion_factor, price_list_code, previous_price_xof, new_price_xof, reason, user_id, created_at)
           VALUES (?, ?, ?, 'GROS', NULL, ?, 'Import CSV catalogue', ?, ?)`
        ).run(pid, packName, factor, grosPrice, req.user.id, now);
        tx.prepare("INSERT INTO stock_balances (product_id, physical_qty, reserved_qty) VALUES (?, 0, 0)").run(pid);
        createdCount++;
      }
      writeAuditLog(tx, {
        userId: req.user.id,
        userName: req.user.full_name,
        action: "IMPORT_CATALOGUE",
        entityType: "PRODUIT",
        details: `Import catalogue : ${createdCount} cr\xE9\xE9(s), ${skippedCount} ignor\xE9(s)`
      });
    });
    res.json({ createdCount, skippedCount });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
coreRouter.get("/stock", requirePermission("stock"), (_req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT p.id, p.sku, p.name, c.name AS category_name, b.name AS brand_name,
              u.label AS unit_label, p.purchase_cost_xof, p.min_threshold, p.safety_stock, p.track_batches,
              COALESCE(sb.physical_qty, 0) AS physical_qty,
              COALESCE(sb.reserved_qty, 0) AS reserved_qty,
              (COALESCE(sb.physical_qty, 0) - COALESCE(sb.reserved_qty, 0)) AS available_qty,
              (COALESCE(sb.physical_qty, 0) * p.purchase_cost_xof) AS stock_value_xof
       FROM products p
       JOIN categories c ON c.id = p.category_id
       JOIN brands b ON b.id = p.brand_id
       JOIN units u ON u.id = p.unit_id
       LEFT JOIN stock_balances sb ON sb.product_id = p.id
       WHERE p.active = 1
       ORDER BY p.name ASC`
  ).all();
  const batches = db.prepare(
    `SELECT pb.*, p.sku, p.name AS product_name
       FROM product_batches pb
       JOIN products p ON p.id = pb.product_id
       WHERE pb.qty_remaining > 0
       ORDER BY pb.expiry_date ASC`
  ).all();
  res.json({ stock: rows, batches });
});
coreRouter.get("/stock/movements", requirePermission("stock"), (req, res) => {
  const db = getDb();
  const productId = req.query.productId ? Number(req.query.productId) : null;
  const rows = db.prepare(
    `SELECT sm.*, p.sku, p.name AS product_name, u.full_name AS user_name
       FROM stock_movements sm
       JOIN products p ON p.id = sm.product_id
       LEFT JOIN users u ON u.id = sm.user_id
       ${productId ? "WHERE sm.product_id = ?" : ""}
       ORDER BY sm.id DESC
       LIMIT 300`
  ).all(...productId ? [productId] : []);
  res.json(rows);
});
coreRouter.post("/stock/adjust", requirePermission("stock_adjust"), (req, res) => {
  try {
    const { product_id, movement_type, qty, comment } = req.body;
    const positiveQty = toPositiveInt(qty, "quantit\xE9");
    if (!comment?.trim()) {
      res.status(400).json({ error: "Un motif explicite est obligatoire pour tout ajustement de stock." });
      return;
    }
    const signed = movement_type === "AJUSTEMENT_ENTREE" ? positiveQty : -positiveQty;
    runInTransaction((tx) => {
      const prod = tx.prepare(
        `SELECT p.id, p.name, p.purchase_cost_xof, sb.physical_qty
           FROM products p JOIN stock_balances sb ON sb.product_id = p.id
           WHERE p.id = ?`
      ).get(product_id);
      if (!prod) throw new Error("Produit introuvable.");
      if (prod.physical_qty + signed < 0) {
        throw new Error(`Stock physique insuffisant (${prod.physical_qty} disponible).`);
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      tx.prepare("UPDATE stock_balances SET physical_qty = physical_qty + ? WHERE product_id = ?").run(
        signed,
        product_id
      );
      tx.prepare(
        `INSERT INTO stock_movements (product_id, movement_type, qty_signed, unit_cost_xof, reference_doc, comment, user_id, created_at)
         VALUES (?, ?, ?, ?, 'AJUST-MANUEL', ?, ?, ?)`
      ).run(product_id, movement_type, signed, prod.purchase_cost_xof, comment.trim(), req.user.id, now);
      writeAuditLog(tx, {
        userId: req.user.id,
        userName: req.user.full_name,
        action: `AJUSTEMENT_STOCK_${movement_type}`,
        entityType: "STOCK",
        entityId: product_id,
        details: `${prod.name} : ${signed > 0 ? "+" : ""}${signed} unit\xE9(s) \u2014 ${comment.trim()}`
      });
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
coreRouter.get("/stock/reconcile", requirePermission("stock"), (_req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT p.id, p.sku, p.name,
              COALESCE(sb.physical_qty, 0) AS balance_qty,
              COALESCE((SELECT SUM(sm.qty_signed) FROM stock_movements sm WHERE sm.product_id = p.id), 0) AS ledger_sum_qty
       FROM products p
       LEFT JOIN stock_balances sb ON sb.product_id = p.id
       ORDER BY p.name ASC`
  ).all();
  const discrepancies = rows.filter((r) => r.balance_qty !== r.ledger_sum_qty);
  res.json({ totalChecked: rows.length, discrepanciesCount: discrepancies.length, rows });
});
coreRouter.get("/deposits", requirePermission("deposits"), (_req, res) => {
  const db = getDb();
  const packagingTypes = db.prepare("SELECT * FROM returnable_packaging WHERE active = 1 ORDER BY code").all();
  const customerBalances = db.prepare(
    `SELECT dm.party_id AS customer_id, c.code AS customer_code, c.name AS customer_name,
              rp.id AS packaging_id, rp.code AS packaging_code, rp.label AS packaging_label, rp.deposit_value_xof,
              SUM(dm.qty_signed) AS qty_balance,
              SUM(dm.qty_signed) * rp.deposit_value_xof AS value_balance_xof
       FROM deposit_movements dm
       JOIN customers c ON c.id = dm.party_id
       JOIN returnable_packaging rp ON rp.id = dm.packaging_id
       WHERE dm.party_type = 'CLIENT'
       GROUP BY dm.party_id, dm.packaging_id
       HAVING SUM(dm.qty_signed) != 0
       ORDER BY c.name ASC`
  ).all();
  const supplierBalances = db.prepare(
    `SELECT dm.party_id AS supplier_id, s.code AS supplier_code, s.name AS supplier_name,
              rp.id AS packaging_id, rp.code AS packaging_code, rp.label AS packaging_label, rp.deposit_value_xof,
              SUM(dm.qty_signed) AS qty_balance,
              SUM(dm.qty_signed) * rp.deposit_value_xof AS value_balance_xof
       FROM deposit_movements dm
       JOIN suppliers s ON s.id = dm.party_id
       JOIN returnable_packaging rp ON rp.id = dm.packaging_id
       WHERE dm.party_type = 'FOURNISSEUR'
       GROUP BY dm.party_id, dm.packaging_id
       HAVING SUM(dm.qty_signed) != 0
       ORDER BY s.name ASC`
  ).all();
  const movements = db.prepare(
    `SELECT dm.*, rp.code AS packaging_code, rp.label AS packaging_label,
              CASE WHEN dm.party_type = 'CLIENT' THEN (SELECT name FROM customers WHERE id = dm.party_id)
                   WHEN dm.party_type = 'FOURNISSEUR' THEN (SELECT name FROM suppliers WHERE id = dm.party_id)
                   ELSE 'D\xE9p\xF4t interne' END AS party_name,
              u.full_name AS user_name
       FROM deposit_movements dm
       JOIN returnable_packaging rp ON rp.id = dm.packaging_id
       LEFT JOIN users u ON u.id = dm.user_id
       ORDER BY dm.id DESC
       LIMIT 200`
  ).all();
  res.json({ packagingTypes, customerBalances, supplierBalances, movements });
});
coreRouter.post("/deposits/record", requirePermission("deposits"), (req, res) => {
  try {
    const { party_type, party_id, packaging_id, movement_kind, qty, payment_method, comment } = req.body;
    const posQty = toPositiveInt(qty, "quantit\xE9 d\u2019emballages");
    runInTransaction((tx) => {
      const pkg = tx.prepare("SELECT id, label, deposit_value_xof FROM returnable_packaging WHERE id = ?").get(packaging_id);
      if (!pkg) throw new Error("Type d\u2019emballage introuvable.");
      const qtySigned = movement_kind === "RETOUR_CLIENT" || movement_kind === "RENDU_FOURNISSEUR" ? -posQty : posQty;
      const amountXof = qtySigned * pkg.deposit_value_xof;
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const payMethod = payment_method || "ESPECES";
      tx.prepare(
        `INSERT INTO deposit_movements (
          party_type, party_id, packaging_id, movement_kind, qty_signed, amount_xof,
          payment_method, reference_doc, comment, user_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'CONSIGNE-MAN', ?, ?, ?)`
      ).run(
        party_type,
        party_id || 0,
        packaging_id,
        movement_kind,
        qtySigned,
        amountXof,
        payMethod,
        comment?.trim() || pkg.label,
        req.user.id,
        now
      );
      if (party_type === "CLIENT" && (movement_kind === "REMISE_CLIENT" || movement_kind === "RETOUR_CLIENT")) {
        const openSess = tx.prepare("SELECT id FROM cash_sessions WHERE status = 'OUVERTE' ORDER BY id DESC LIMIT 1").get();
        const cashMoveType = movement_kind === "REMISE_CLIENT" ? "CONSIGNE_ENCAISSEMENT" : "CONSIGNE_REMBOURSEMENT";
        tx.prepare(
          `INSERT INTO cash_movements (session_id, movement_type, payment_method, amount_signed_xof, reference_doc, comment, user_id, created_at)
           VALUES (?, ?, ?, ?, 'CONSIGNE', ?, ?, ?)`
        ).run(
          openSess?.id ?? null,
          cashMoveType,
          payMethod,
          amountXof,
          `${movement_kind} (${posQty} x ${pkg.label})`,
          req.user.id,
          now
        );
        if (openSess && payMethod === "ESPECES") {
          tx.prepare("UPDATE cash_sessions SET theoretical_cash_xof = theoretical_cash_xof + ? WHERE id = ?").run(
            amountXof,
            openSess.id
          );
        }
      }
      writeAuditLog(tx, {
        userId: req.user.id,
        userName: req.user.full_name,
        action: `CONSIGNE_${movement_kind}`,
        entityType: "CONSIGNE",
        entityId: packaging_id,
        details: `${movement_kind} : ${posQty} \xD7 ${pkg.label} (${amountXof} FCFA)`
      });
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// server/routes-sales.ts
import { Router as Router2 } from "express";
var salesRouter = Router2();
salesRouter.get("/customers", requireAuth, (_req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT c.*, pl.code AS price_list_code, pl.label AS price_list_label,
              COALESCE((SELECT SUM(s.credit_due_xof) FROM sales s WHERE s.customer_id = c.id AND s.status != 'ANNULEE'), 0) AS balance_due_xof,
              COALESCE((SELECT SUM(dm.qty_signed) FROM deposit_movements dm WHERE dm.party_type = 'CLIENT' AND dm.party_id = c.id), 0) AS deposit_qty_balance,
              (SELECT MAX(s.created_at) FROM sales s WHERE s.customer_id = c.id) AS last_operation_at
       FROM customers c
       JOIN price_lists pl ON pl.id = c.price_list_id
       WHERE c.active = 1
       ORDER BY CASE WHEN c.code = 'CLI-000' THEN 0 ELSE 1 END, c.name ASC`
  ).all();
  res.json(rows);
});
salesRouter.post("/customers", requirePermission("customers"), (req, res) => {
  try {
    const { name, phone, address, customer_type, price_list_id, credit_limit_xof } = req.body;
    if (!name?.trim()) {
      res.status(400).json({ error: "Le nom du client est obligatoire." });
      return;
    }
    const limit = toIntXof(credit_limit_xof ?? 0, "plafond de cr\xE9dit");
    if (limit < 0) throw new Error("Le plafond de cr\xE9dit doit \xEAtre positif ou nul.");
    const customerId = runInTransaction((tx) => {
      const cnt = tx.prepare("SELECT COUNT(*) as c FROM customers").get().c;
      const code = `CLI-${String(cnt).padStart(3, "0")}`;
      const ins = tx.prepare(
        `INSERT INTO customers (code, name, phone, address, customer_type, price_list_id, credit_limit_xof, active, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
      ).run(
        code,
        name.trim(),
        phone?.trim() ?? "",
        address?.trim() ?? "",
        customer_type || "Gros",
        price_list_id,
        limit,
        (/* @__PURE__ */ new Date()).toISOString()
      );
      writeAuditLog(tx, {
        userId: req.user.id,
        userName: req.user.full_name,
        action: "CREATION_CLIENT",
        entityType: "CLIENT",
        entityId: Number(ins.lastInsertRowid),
        details: `Client ${code} \u2014 ${name.trim()} (Plafond ${limit} FCFA)`
      });
      return Number(ins.lastInsertRowid);
    });
    res.status(201).json({ id: customerId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
salesRouter.put("/customers/:id", requirePermission("customers"), (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, phone, address, customer_type, price_list_id, credit_limit_xof } = req.body;
    const limit = toIntXof(credit_limit_xof ?? 0, "plafond de cr\xE9dit");
    const db = getDb();
    db.prepare(
      `UPDATE customers SET name = ?, phone = ?, address = ?, customer_type = ?, price_list_id = ?, credit_limit_xof = ? WHERE id = ?`
    ).run(name.trim(), phone?.trim() ?? "", address?.trim() ?? "", customer_type || "Gros", price_list_id, limit, id);
    writeAuditLog(db, {
      userId: req.user.id,
      userName: req.user.full_name,
      action: "MODIFICATION_CLIENT",
      entityType: "CLIENT",
      entityId: id,
      details: `Mise \xE0 jour client ${name.trim()} (Plafond ${limit} FCFA)`
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
salesRouter.get("/customers/:id/statement", requirePermission("customers"), (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const customer = db.prepare(
    `SELECT c.*, pl.label AS price_list_label
       FROM customers c JOIN price_lists pl ON pl.id = c.price_list_id
       WHERE c.id = ?`
  ).get(id);
  if (!customer) {
    res.status(404).json({ error: "Client introuvable." });
    return;
  }
  const sales = db.prepare(
    `SELECT id, sale_number, status, total_xof, paid_xof, credit_due_xof, due_date, payment_summary, created_at
       FROM sales WHERE customer_id = ? ORDER BY id DESC`
  ).all(id);
  const payments = db.prepare(
    `SELECT cp.*, u.full_name AS user_name
       FROM customer_payments cp
       LEFT JOIN users u ON u.id = cp.user_id
       WHERE cp.customer_id = ? ORDER BY cp.id DESC`
  ).all(id);
  const deposits = db.prepare(
    `SELECT rp.code AS packaging_code, rp.label AS packaging_label, rp.deposit_value_xof,
              SUM(dm.qty_signed) AS qty_balance,
              SUM(dm.qty_signed) * rp.deposit_value_xof AS value_xof
       FROM deposit_movements dm
       JOIN returnable_packaging rp ON rp.id = dm.packaging_id
       WHERE dm.party_type = 'CLIENT' AND dm.party_id = ?
       GROUP BY dm.packaging_id
       HAVING SUM(dm.qty_signed) != 0`
  ).all(id);
  res.json({ customer, sales, payments, deposits });
});
salesRouter.post("/customers/payments", requirePermission("customers"), (req, res) => {
  try {
    const { customer_id, amount_xof, payment_method, reference_note, sale_ids } = req.body;
    const amount = toPositiveInt(amount_xof, "montant du r\xE8glement");
    const result = runInTransaction((tx) => {
      const openSales = tx.prepare(
        `SELECT id, sale_number, credit_due_xof
           FROM sales
           WHERE customer_id = ? AND status != 'ANNULEE' AND credit_due_xof > 0
           ORDER BY created_at ASC, id ASC`
      ).all(customer_id);
      const targetSales = sale_ids && sale_ids.length > 0 ? openSales.filter((s) => sale_ids.includes(s.id)) : openSales;
      const totalOpen = targetSales.reduce((acc, s) => acc + s.credit_due_xof, 0);
      if (totalOpen === 0) {
        throw new Error("Ce client n\u2019a aucune cr\xE9ance ouverte \xE0 r\xE9gler.");
      }
      if (amount > totalOpen) {
        throw new Error(
          `Le r\xE8glement (${amount} FCFA) d\xE9passe le solde d\xFB des factures s\xE9lectionn\xE9es (${totalOpen} FCFA).`
        );
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const payNum = nextDocumentNumber(tx, "PAY");
      const pIns = tx.prepare(
        `INSERT INTO customer_payments (payment_number, customer_id, amount_xof, payment_method, reference_note, user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(payNum, customer_id, amount, payment_method || "ESPECES", reference_note?.trim() ?? "", req.user.id, now);
      const paymentId = Number(pIns.lastInsertRowid);
      let remaining = amount;
      for (const s of targetSales) {
        if (remaining <= 0) break;
        const alloc = Math.min(remaining, s.credit_due_xof);
        tx.prepare("INSERT INTO payment_allocations (payment_id, sale_id, allocated_xof) VALUES (?, ?, ?)").run(
          paymentId,
          s.id,
          alloc
        );
        tx.prepare("UPDATE sales SET paid_xof = paid_xof + ?, credit_due_xof = credit_due_xof - ? WHERE id = ?").run(
          alloc,
          alloc,
          s.id
        );
        remaining -= alloc;
      }
      const openSess = tx.prepare("SELECT id FROM cash_sessions WHERE status = 'OUVERTE' ORDER BY id DESC LIMIT 1").get();
      tx.prepare(
        `INSERT INTO cash_movements (session_id, movement_type, payment_method, amount_signed_xof, reference_doc, comment, user_id, created_at)
         VALUES (?, 'REGLEMENT_CREANCE', ?, ?, ?, 'R\xE8glement cr\xE9ance client (CA inchang\xE9)', ?, ?)`
      ).run(openSess?.id ?? null, payment_method || "ESPECES", amount, payNum, req.user.id, now);
      if (openSess && (payment_method || "ESPECES") === "ESPECES") {
        tx.prepare("UPDATE cash_sessions SET theoretical_cash_xof = theoretical_cash_xof + ? WHERE id = ?").run(
          amount,
          openSess.id
        );
      }
      writeAuditLog(tx, {
        userId: req.user.id,
        userName: req.user.full_name,
        action: "REGLEMENT_CREANCE_CLIENT",
        entityType: "PAIEMENT_CLIENT",
        entityId: paymentId,
        details: `${payNum} \u2014 Encaissement ${amount} FCFA (${payment_method || "ESPECES"})`
      });
      return { paymentId, paymentNumber: payNum };
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
salesRouter.get("/sales", requireAuth, (req, res) => {
  const db = getDb();
  const limit = Number(req.query.limit || 100);
  const rows = db.prepare(
    `SELECT s.*, c.name AS customer_name, c.code AS customer_code, u.full_name AS cashier_name
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       LEFT JOIN users u ON u.id = s.user_id
       ORDER BY s.id DESC
       LIMIT ?`
  ).all(limit);
  res.json(rows);
});
salesRouter.get("/sales/:id", requireAuth, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const sale = db.prepare(
    `SELECT s.*, c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address,
              pl.label AS price_list_label, u.full_name AS cashier_name
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       JOIN price_lists pl ON pl.id = s.price_list_id
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`
  ).get(id);
  if (!sale) {
    res.status(404).json({ error: "Vente introuvable." });
    return;
  }
  const lines = db.prepare("SELECT * FROM sale_lines WHERE sale_id = ?").all(id);
  const returns = db.prepare("SELECT * FROM sale_returns WHERE sale_id = ? ORDER BY id DESC").all(id);
  res.json({ sale, lines, returns });
});
salesRouter.post("/sales", requirePermission("pos"), (req, res) => {
  try {
    const body = req.body;
    if (!body.lines || body.lines.length === 0) {
      res.status(400).json({ error: "Le panier est vide." });
      return;
    }
    const globalDiscount = toIntXof(body.global_discount_xof ?? 0, "remise globale");
    if (globalDiscount < 0) throw new Error("La remise globale ne peut pas \xEAtre n\xE9gative.");
    const result = runInTransaction((tx) => {
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const settings = tx.prepare("SELECT tax_enabled, tax_rate FROM company_settings WHERE id = 1").get();
      const customer = tx.prepare("SELECT id, name, credit_limit_xof FROM customers WHERE id = ?").get(body.customer_id);
      if (!customer) throw new Error("Client introuvable.");
      let subtotal = 0;
      let totalDeposit = 0;
      const preparedLines = [];
      const neededByProduct = {};
      for (const l of body.lines) {
        const qty = toPositiveInt(l.qty, "quantit\xE9");
        const unitPrice = toIntXof(l.unit_price_xof, "prix unitaire");
        const lineDiscount = toIntXof(l.discount_xof ?? 0, "remise de ligne");
        if (unitPrice < 0 || lineDiscount < 0) throw new Error("Prix et remises doivent \xEAtre positifs.");
        const prod = tx.prepare(
          `SELECT p.id, p.name, p.purchase_cost_xof, p.packaging_deposit_id, p.deposit_units_per_crate,
                    rp.deposit_value_xof
             FROM products p
             LEFT JOIN returnable_packaging rp ON rp.id = p.packaging_deposit_id
             WHERE p.id = ? AND p.active = 1`
        ).get(l.product_id);
        if (!prod) throw new Error("Un produit du panier est introuvable ou archiv\xE9.");
        const pack = tx.prepare("SELECT id, name, conversion_factor, apply_deposit FROM product_packagings WHERE id = ? AND product_id = ?").get(l.packaging_id, l.product_id);
        if (!pack) throw new Error(`Conditionnement invalide pour ${prod.name}.`);
        const baseQty = qty * pack.conversion_factor;
        neededByProduct[prod.id] = (neededByProduct[prod.id] || 0) + baseQty;
        const rawLine = qty * unitPrice;
        const lineTotal = Math.max(0, rawLine - lineDiscount);
        subtotal += lineTotal;
        let lineDeposit = 0;
        if (body.include_deposit && pack.apply_deposit === 1 && prod.packaging_deposit_id && prod.deposit_value_xof) {
          lineDeposit = qty * prod.deposit_units_per_crate * prod.deposit_value_xof;
          totalDeposit += lineDeposit;
        }
        preparedLines.push({
          productId: prod.id,
          packagingId: pack.id,
          productName: prod.name,
          packagingName: pack.name,
          factor: pack.conversion_factor,
          qty,
          baseQty,
          unitPrice,
          discount: lineDiscount,
          unitCost: prod.purchase_cost_xof,
          lineTotal,
          lineDeposit,
          depositPkgId: lineDeposit > 0 ? prod.packaging_deposit_id : null
        });
      }
      for (const [pidStr, needed] of Object.entries(neededByProduct)) {
        const pid = Number(pidStr);
        const bal = tx.prepare(
          `SELECT p.name, sb.physical_qty, sb.reserved_qty
             FROM stock_balances sb JOIN products p ON p.id = sb.product_id
             WHERE sb.product_id = ?`
        ).get(pid);
        const available = bal.physical_qty - bal.reserved_qty;
        if (needed > available) {
          throw new Error(
            `Stock insuffisant pour "${bal.name}" : demand\xE9 ${needed} unit\xE9(s), disponible ${available} (physique ${bal.physical_qty}, r\xE9serv\xE9 ${bal.reserved_qty}).`
          );
        }
      }
      const netCommercial = Math.max(0, subtotal - globalDiscount);
      const taxXof = settings.tax_enabled ? Math.round(netCommercial * settings.tax_rate / 100) : 0;
      const totalXof = netCommercial + taxXof + totalDeposit;
      const payments = Array.isArray(body.payments) ? body.payments : [];
      let paidXof = 0;
      for (const p of payments) {
        const amt = toIntXof(p.amount_xof, "paiement");
        if (amt < 0) throw new Error("Un paiement ne peut pas \xEAtre n\xE9gatif.");
        paidXof += amt;
      }
      if (paidXof > totalXof) {
        throw new Error(`Le montant encaiss\xE9 (${paidXof} FCFA) d\xE9passe le total \xE0 payer (${totalXof} FCFA).`);
      }
      const creditDueXof = totalXof - paidXof;
      if (creditDueXof > 0) {
        if (customer.id === 1 && customer.credit_limit_xof === 0) {
          throw new Error("Le Client Comptoir ne peut pas acheter \xE0 cr\xE9dit. S\xE9lectionnez un client enregistr\xE9.");
        }
        const currentDebt = tx.prepare(
          `SELECT COALESCE(SUM(credit_due_xof), 0) as d FROM sales WHERE customer_id = ? AND status != 'ANNULEE'`
        ).get(customer.id).d;
        if (currentDebt + creditDueXof > customer.credit_limit_xof) {
          if (!body.supervisor_override || !verifySupervisorCredentials(body.supervisor_override.username, body.supervisor_override.secret)) {
            throw new Error(
              `PLAFOND_CREDIT_DEPASSE: Plafond d\xE9pass\xE9 pour ${customer.name} (dette actuelle ${currentDebt} + nouveau cr\xE9dit ${creditDueXof} > plafond ${customer.credit_limit_xof} FCFA). Validation responsable requise.`
            );
          }
          writeAuditLog(tx, {
            userId: req.user.id,
            userName: req.user.full_name,
            action: "DEROGATION_PLAFOND_CREDIT",
            entityType: "CLIENT",
            entityId: customer.id,
            details: `D\xE9passement autoris\xE9 par ${body.supervisor_override.username} pour ${customer.name} (+${creditDueXof} FCFA)`
          });
        }
      }
      const saleNumber = nextDocumentNumber(tx, "VTE");
      const paySummary = payments.filter((p) => p.amount_xof > 0).map((p) => p.method).join(" + ") || (creditDueXof > 0 ? "Cr\xE9dit" : "Esp\xE8ces");
      const saleIns = tx.prepare(
        `INSERT INTO sales (
            sale_number, customer_id, price_list_id, status, subtotal_xof, discount_xof, tax_xof,
            deposit_xof, total_xof, paid_xof, credit_due_xof, due_date, payment_summary, notes, user_id, created_at
          ) VALUES (?, ?, ?, 'VALIDEE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        saleNumber,
        customer.id,
        body.price_list_id,
        subtotal,
        globalDiscount,
        taxXof,
        totalDeposit,
        totalXof,
        paidXof,
        creditDueXof,
        creditDueXof > 0 ? body.due_date || null : null,
        creditDueXof > 0 && paidXof > 0 ? `${paySummary} + Cr\xE9dit` : paySummary,
        body.notes?.trim() ?? "",
        req.user.id,
        now
      );
      const saleId = Number(saleIns.lastInsertRowid);
      for (const pl of preparedLines) {
        tx.prepare(
          `INSERT INTO sale_lines (
            sale_id, product_id, packaging_id, product_name, packaging_name, conversion_factor,
            qty, base_qty, unit_price_xof, discount_xof, unit_cost_xof, line_total_xof, deposit_xof
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          saleId,
          pl.productId,
          pl.packagingId,
          pl.productName,
          pl.packagingName,
          pl.factor,
          pl.qty,
          pl.baseQty,
          pl.unitPrice,
          pl.discount,
          pl.unitCost,
          pl.lineTotal,
          pl.lineDeposit
        );
        tx.prepare("UPDATE stock_balances SET physical_qty = physical_qty - ? WHERE product_id = ?").run(
          pl.baseQty,
          pl.productId
        );
        tx.prepare(
          `INSERT INTO stock_movements (product_id, movement_type, qty_signed, unit_cost_xof, reference_doc, comment, user_id, created_at)
           VALUES (?, 'VENTE_SORTIE', ?, ?, ?, ?, ?, ?)`
        ).run(pl.productId, -pl.baseQty, pl.unitCost, saleNumber, `Vente ${pl.qty} \xD7 ${pl.packagingName}`, req.user.id, now);
        let remBatch = pl.baseQty;
        const batches = tx.prepare(
          `SELECT id, qty_remaining FROM product_batches WHERE product_id = ? AND qty_remaining > 0 ORDER BY expiry_date ASC`
        ).all(pl.productId);
        for (const b of batches) {
          if (remBatch <= 0) break;
          const take = Math.min(remBatch, b.qty_remaining);
          tx.prepare("UPDATE product_batches SET qty_remaining = qty_remaining - ? WHERE id = ?").run(take, b.id);
          remBatch -= take;
        }
        if (pl.depositPkgId && pl.lineDeposit > 0) {
          tx.prepare(
            `INSERT INTO deposit_movements (
              party_type, party_id, packaging_id, movement_kind, qty_signed, amount_xof,
              payment_method, reference_doc, comment, user_id, created_at
            ) VALUES ('CLIENT', ?, ?, 'REMISE_CLIENT', ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            customer.id,
            pl.depositPkgId,
            pl.qty,
            pl.lineDeposit,
            paySummary,
            saleNumber,
            `Consigne sur vente ${saleNumber}`,
            req.user.id,
            now
          );
        }
      }
      const openSess = tx.prepare("SELECT id FROM cash_sessions WHERE status = 'OUVERTE' ORDER BY id DESC LIMIT 1").get();
      for (const p of payments) {
        const amt = toIntXof(p.amount_xof, "paiement");
        if (amt <= 0) continue;
        tx.prepare(
          `INSERT INTO cash_movements (session_id, movement_type, payment_method, amount_signed_xof, reference_doc, comment, user_id, created_at)
           VALUES (?, 'VENTE_ENCAISSEMENT', ?, ?, ?, ?, ?, ?)`
        ).run(openSess?.id ?? null, p.method, amt, saleNumber, `Encaissement vente ${saleNumber}`, req.user.id, now);
        if (openSess && p.method === "ESPECES") {
          tx.prepare("UPDATE cash_sessions SET theoretical_cash_xof = theoretical_cash_xof + ? WHERE id = ?").run(
            amt,
            openSess.id
          );
        }
      }
      if (body.lines.some((l) => l.price_modified) || globalDiscount > 0) {
        writeAuditLog(tx, {
          userId: req.user.id,
          userName: req.user.full_name,
          action: "VENTE_AVEC_REMISE_OU_PRIX_MODIFIE",
          entityType: "VENTE",
          entityId: saleId,
          details: `${saleNumber} \u2014 Remise globale ${globalDiscount} FCFA, Total ${totalXof} FCFA`
        });
      }
      return { saleId, saleNumber, totalXof, paidXof, creditDueXof };
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
salesRouter.post("/sales/:id/cancel", requirePermission("pos"), (req, res) => {
  try {
    const saleId = Number(req.params.id);
    const { reason, supervisor_username, supervisor_secret } = req.body;
    if (!reason?.trim()) throw new Error("Motif d\u2019annulation obligatoire.");
    if (req.user.role === "CAISSIER") {
      if (!supervisor_username || !supervisor_secret || !verifySupervisorCredentials(supervisor_username, supervisor_secret)) {
        res.status(403).json({ error: "L\u2019annulation d\u2019une vente valid\xE9e n\xE9cessite l\u2019autorisation du G\xE9rant ou de l\u2019Administrateur." });
        return;
      }
    }
    runInTransaction((tx) => {
      const sale = tx.prepare("SELECT * FROM sales WHERE id = ?").get(saleId);
      if (!sale) throw new Error("Vente introuvable.");
      if (sale.status === "ANNULEE") throw new Error("Cette vente est d\xE9j\xE0 annul\xE9e.");
      const lines = tx.prepare("SELECT * FROM sale_lines WHERE sale_id = ?").all(saleId);
      const now = (/* @__PURE__ */ new Date()).toISOString();
      for (const l of lines) {
        const qtyToRestore = l.base_qty - l.returned_base_qty;
        if (qtyToRestore > 0) {
          tx.prepare("UPDATE stock_balances SET physical_qty = physical_qty + ? WHERE product_id = ?").run(
            qtyToRestore,
            l.product_id
          );
          tx.prepare(
            `INSERT INTO stock_movements (product_id, movement_type, qty_signed, unit_cost_xof, reference_doc, comment, user_id, created_at)
             VALUES (?, 'RETOUR_CLIENT', ?, ?, ?, ?, ?, ?)`
          ).run(
            l.product_id,
            qtyToRestore,
            l.unit_cost_xof,
            sale.sale_number,
            `Annulation vente ${sale.sale_number} : ${reason.trim()}`,
            req.user.id,
            now
          );
        }
      }
      if (sale.paid_xof > 0) {
        const openSess = tx.prepare("SELECT id FROM cash_sessions WHERE status = 'OUVERTE' ORDER BY id DESC LIMIT 1").get();
        const lastCashMove = tx.prepare(
          `SELECT cm.payment_method, pm.is_cash
             FROM cash_movements cm
             LEFT JOIN payment_methods pm ON pm.code = cm.payment_method
             WHERE cm.reference_doc = ? AND cm.movement_type = 'VENTE_ENCAISSEMENT'
             ORDER BY cm.id DESC LIMIT 1`
        ).get(sale.sale_number);
        const matchedMethod = lastCashMove?.payment_method || tx.prepare("SELECT code FROM payment_methods WHERE active = 1 ORDER BY is_cash DESC, id ASC LIMIT 1").get()?.code || "ESPECES";
        const method = matchedMethod;
        tx.prepare(
          `INSERT INTO cash_movements (session_id, movement_type, payment_method, amount_signed_xof, reference_doc, comment, user_id, created_at)
           VALUES (?, 'REMBOURSEMENT_CLIENT', ?, ?, ?, ?, ?, ?)`
        ).run(
          openSess?.id ?? null,
          method,
          -sale.paid_xof,
          sale.sale_number,
          `Contrepassation annulation ${sale.sale_number}`,
          req.user.id,
          now
        );
        if (openSess && method === "ESPECES") {
          tx.prepare("UPDATE cash_sessions SET theoretical_cash_xof = theoretical_cash_xof - ? WHERE id = ?").run(
            sale.paid_xof,
            openSess.id
          );
        }
      }
      tx.prepare("UPDATE sales SET status = 'ANNULEE', credit_due_xof = 0 WHERE id = ?").run(saleId);
      writeAuditLog(tx, {
        userId: req.user.id,
        userName: req.user.full_name,
        action: "ANNULATION_VENTE",
        entityType: "VENTE",
        entityId: saleId,
        details: `Annulation tra\xE7able ${sale.sale_number} \u2014 Motif : ${reason.trim()}`
      });
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
salesRouter.post("/sales/:id/return", requirePermission("pos"), (req, res) => {
  try {
    const saleId = Number(req.params.id);
    const { items, refund_method, restocked, reason } = req.body;
    if (!items || items.length === 0) throw new Error("S\xE9lectionnez au moins une ligne \xE0 retourner.");
    if (!reason?.trim()) throw new Error("Motif du retour obligatoire.");
    const resData = runInTransaction((tx) => {
      const sale = tx.prepare("SELECT * FROM sales WHERE id = ?").get(saleId);
      if (!sale) throw new Error("Vente introuvable.");
      if (sale.status === "ANNULEE") throw new Error("Impossible de retourner une vente annul\xE9e.");
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const retNum = nextDocumentNumber(tx, "RET");
      let totalRefund = 0;
      const returnLinesToInsert = [];
      for (const it of items) {
        const retQty = toPositiveInt(it.return_base_qty, "quantit\xE9 retourn\xE9e");
        const line = tx.prepare("SELECT * FROM sale_lines WHERE id = ? AND sale_id = ?").get(it.sale_line_id, saleId);
        if (!line) throw new Error("Ligne de vente introuvable.");
        const returnable = line.base_qty - line.returned_base_qty;
        if (retQty > returnable) {
          throw new Error(`Quantit\xE9 retourn\xE9e (${retQty}) sup\xE9rieure au solde retournable (${returnable}).`);
        }
        const unitNetPrice = Math.round(line.line_total_xof / line.base_qty);
        const refundAmt = retQty * unitNetPrice;
        totalRefund += refundAmt;
        returnLinesToInsert.push({
          sale_line_id: line.id,
          product_id: line.product_id,
          base_qty: retQty,
          refund_xof: refundAmt,
          unit_cost_xof: line.unit_cost_xof
        });
        tx.prepare("UPDATE sale_lines SET returned_base_qty = returned_base_qty + ? WHERE id = ?").run(retQty, line.id);
        if (restocked) {
          tx.prepare("UPDATE stock_balances SET physical_qty = physical_qty + ? WHERE product_id = ?").run(
            retQty,
            line.product_id
          );
          tx.prepare(
            `INSERT INTO stock_movements (product_id, movement_type, qty_signed, unit_cost_xof, reference_doc, comment, user_id, created_at)
             VALUES (?, 'RETOUR_CLIENT', ?, ?, ?, ?, ?, ?)`
          ).run(line.product_id, retQty, line.unit_cost_xof, retNum, `Retour client sur ${sale.sale_number}`, req.user.id, now);
        } else {
          tx.prepare(
            `INSERT INTO stock_movements (product_id, movement_type, qty_signed, unit_cost_xof, reference_doc, comment, user_id, created_at)
             VALUES (?, 'CASSE', 0, ?, ?, ?, ?, ?)`
          ).run(
            line.product_id,
            line.unit_cost_xof,
            retNum,
            `Retour non revendable/cass\xE9 sur ${sale.sale_number} (${retQty} unit\xE9s)`,
            req.user.id,
            now
          );
        }
      }
      const rIns = tx.prepare(
        `INSERT INTO sale_returns (return_number, sale_id, total_refund_xof, refund_method, restocked, reason, user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(retNum, saleId, totalRefund, refund_method || "ESPECES", restocked ? 1 : 0, reason.trim(), req.user.id, now);
      const returnId = Number(rIns.lastInsertRowid);
      for (const rl of returnLinesToInsert) {
        tx.prepare(
          `INSERT INTO sale_return_lines (return_id, sale_line_id, product_id, base_qty, refund_xof) VALUES (?, ?, ?, ?, ?)`
        ).run(returnId, rl.sale_line_id, rl.product_id, rl.base_qty, rl.refund_xof);
      }
      const creditReduction = Math.min(sale.credit_due_xof, totalRefund);
      const cashRefund = totalRefund - creditReduction;
      tx.prepare("UPDATE sales SET credit_due_xof = credit_due_xof - ?, status = 'REMBOURSEE_PARTIELLE' WHERE id = ?").run(
        creditReduction,
        saleId
      );
      if (cashRefund > 0) {
        const openSess = tx.prepare("SELECT id FROM cash_sessions WHERE status = 'OUVERTE' ORDER BY id DESC LIMIT 1").get();
        tx.prepare(
          `INSERT INTO cash_movements (session_id, movement_type, payment_method, amount_signed_xof, reference_doc, comment, user_id, created_at)
           VALUES (?, 'REMBOURSEMENT_CLIENT', ?, ?, ?, ?, ?, ?)`
        ).run(
          openSess?.id ?? null,
          refund_method || "ESPECES",
          -cashRefund,
          retNum,
          `Remboursement retour sur ${sale.sale_number}`,
          req.user.id,
          now
        );
        if (openSess && (refund_method || "ESPECES") === "ESPECES") {
          tx.prepare("UPDATE cash_sessions SET theoretical_cash_xof = theoretical_cash_xof - ? WHERE id = ?").run(
            cashRefund,
            openSess.id
          );
        }
      }
      writeAuditLog(tx, {
        userId: req.user.id,
        userName: req.user.full_name,
        action: "RETOUR_CLIENT",
        entityType: "VENTE",
        entityId: saleId,
        details: `${retNum} sur ${sale.sale_number} \u2014 Montant ${totalRefund} FCFA (${restocked ? "r\xE9int\xE9gr\xE9 en stock" : "non revendable"})`
      });
      return { returnNumber: retNum, totalRefund, cashRefund, creditReduction };
    });
    res.status(201).json(resData);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
salesRouter.get("/orders", requirePermission("orders"), (_req, res) => {
  const db = getDb();
  const orders = db.prepare(
    `SELECT co.*, c.name AS customer_name, c.phone AS customer_phone, u.full_name AS creator_name
       FROM customer_orders co
       JOIN customers c ON c.id = co.customer_id
       LEFT JOIN users u ON u.id = co.user_id
       ORDER BY co.id DESC`
  ).all();
  const lineStmt = db.prepare("SELECT * FROM customer_order_lines WHERE order_id = ?");
  res.json(orders.map((o) => ({ ...o, lines: lineStmt.all(o.id) })));
});
salesRouter.post("/orders", requirePermission("orders"), (req, res) => {
  try {
    const body = req.body;
    if (!body.lines || body.lines.length === 0) throw new Error("Ajoutez au moins un article \xE0 la commande.");
    const resData = runInTransaction((tx) => {
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const orderNum = nextDocumentNumber(tx, "CMD");
      const status = body.status || "CONFIRMEE";
      const settings = tx.prepare("SELECT reserve_stock_on_order FROM company_settings WHERE id = 1").get();
      let subtotal = 0;
      const orderLines = [];
      for (const l of body.lines) {
        const qty = toPositiveInt(l.qty, "quantit\xE9");
        const price = toIntXof(l.unit_price_xof, "prix unitaire");
        const prod = tx.prepare("SELECT id, name FROM products WHERE id = ?").get(l.product_id);
        const pack = tx.prepare("SELECT id, name, conversion_factor FROM product_packagings WHERE id = ?").get(l.packaging_id);
        const baseQty = qty * pack.conversion_factor;
        const lineTotal = qty * price;
        subtotal += lineTotal;
        orderLines.push({
          product_id: prod.id,
          packaging_id: pack.id,
          product_name: prod.name,
          packaging_name: pack.name,
          factor: pack.conversion_factor,
          qty,
          base_qty: baseQty,
          unit_price_xof: price,
          line_total_xof: lineTotal
        });
      }
      const ins = tx.prepare(
        `INSERT INTO customer_orders (order_number, customer_id, status, desired_date, delivery_address, notes, subtotal_xof, deposit_total_xof, total_xof, user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
      ).run(
        orderNum,
        body.customer_id,
        status,
        body.desired_date || null,
        body.delivery_address?.trim() ?? "",
        body.notes?.trim() ?? "",
        subtotal,
        subtotal,
        req.user.id,
        now
      );
      const orderId = Number(ins.lastInsertRowid);
      for (const ol of orderLines) {
        tx.prepare(
          `INSERT INTO customer_order_lines (order_id, product_id, packaging_id, product_name, packaging_name, conversion_factor, qty, base_qty, unit_price_xof, line_total_xof)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          orderId,
          ol.product_id,
          ol.packaging_id,
          ol.product_name,
          ol.packaging_name,
          ol.factor,
          ol.qty,
          ol.base_qty,
          ol.unit_price_xof,
          ol.line_total_xof
        );
        if (status === "CONFIRMEE" && settings.reserve_stock_on_order === 1) {
          tx.prepare("UPDATE stock_balances SET reserved_qty = reserved_qty + ? WHERE product_id = ?").run(
            ol.base_qty,
            ol.product_id
          );
        }
      }
      return { orderId, orderNumber: orderNum };
    });
    res.status(201).json(resData);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
salesRouter.patch("/orders/:id/status", requirePermission("orders"), (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const { status } = req.body;
    runInTransaction((tx) => {
      const ord = tx.prepare("SELECT id, status, order_number FROM customer_orders WHERE id = ?").get(orderId);
      if (!ord) throw new Error("Commande introuvable.");
      const settings = tx.prepare("SELECT reserve_stock_on_order FROM company_settings WHERE id = 1").get();
      const lines = tx.prepare("SELECT product_id, base_qty FROM customer_order_lines WHERE order_id = ?").all(orderId);
      if (ord.status === "BROUILLON" && status === "CONFIRMEE" && settings.reserve_stock_on_order === 1) {
        for (const l of lines) {
          tx.prepare("UPDATE stock_balances SET reserved_qty = reserved_qty + ? WHERE product_id = ?").run(
            l.base_qty,
            l.product_id
          );
        }
      } else if (status === "ANNULEE" && ["CONFIRMEE", "EN_PREPARATION", "PRETE"].includes(ord.status) && settings.reserve_stock_on_order === 1) {
        for (const l of lines) {
          tx.prepare("UPDATE stock_balances SET reserved_qty = MAX(0, reserved_qty - ?) WHERE product_id = ?").run(
            l.base_qty,
            l.product_id
          );
        }
      }
      tx.prepare("UPDATE customer_orders SET status = ? WHERE id = ?").run(status, orderId);
      writeAuditLog(tx, {
        userId: req.user.id,
        userName: req.user.full_name,
        action: "STATUT_COMMANDE",
        entityType: "COMMANDE",
        entityId: orderId,
        details: `${ord.order_number} -> ${status}`
      });
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
salesRouter.post("/orders/:id/convert", requirePermission("orders"), (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const { payment_method, paid_xof } = req.body;
    const out = runInTransaction((tx) => {
      const ord = tx.prepare("SELECT * FROM customer_orders WHERE id = ?").get(orderId);
      if (!ord) throw new Error("Commande introuvable.");
      if (ord.converted_sale_id) throw new Error("Cette commande a d\xE9j\xE0 \xE9t\xE9 transform\xE9e en vente.");
      const cust = tx.prepare("SELECT id, price_list_id FROM customers WHERE id = ?").get(ord.customer_id);
      const lines = tx.prepare("SELECT * FROM customer_order_lines WHERE order_id = ?").all(orderId);
      const settings = tx.prepare("SELECT reserve_stock_on_order FROM company_settings WHERE id = 1").get();
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const saleNumber = nextDocumentNumber(tx, "VTE");
      const paid = toIntXof(paid_xof ?? ord.total_xof, "montant pay\xE9");
      const credit = Math.max(0, ord.total_xof - paid);
      const method = payment_method || "ESPECES";
      const sIns = tx.prepare(
        `INSERT INTO sales (
            sale_number, customer_id, price_list_id, status, subtotal_xof, discount_xof, tax_xof,
            deposit_xof, total_xof, paid_xof, credit_due_xof, payment_summary, notes, user_id, created_at
          ) VALUES (?, ?, ?, 'VALIDEE', ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        saleNumber,
        ord.customer_id,
        cust.price_list_id,
        ord.total_xof,
        ord.total_xof,
        paid,
        credit,
        credit > 0 ? `${method} + Cr\xE9dit` : method,
        `Issu de la commande ${ord.order_number}`,
        req.user.id,
        now
      );
      const saleId = Number(sIns.lastInsertRowid);
      for (const l of lines) {
        const prod = tx.prepare("SELECT purchase_cost_xof FROM products WHERE id = ?").get(l.product_id);
        tx.prepare(
          `INSERT INTO sale_lines (
            sale_id, product_id, packaging_id, product_name, packaging_name, conversion_factor,
            qty, base_qty, unit_price_xof, discount_xof, unit_cost_xof, line_total_xof, deposit_xof
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0)`
        ).run(
          saleId,
          l.product_id,
          l.packaging_id,
          l.product_name,
          l.packaging_name,
          l.conversion_factor,
          l.qty,
          l.base_qty,
          l.unit_price_xof,
          prod.purchase_cost_xof,
          l.line_total_xof
        );
        if (["CONFIRMEE", "EN_PREPARATION", "PRETE"].includes(ord.status) && settings.reserve_stock_on_order === 1) {
          tx.prepare("UPDATE stock_balances SET reserved_qty = MAX(0, reserved_qty - ?) WHERE product_id = ?").run(
            l.base_qty,
            l.product_id
          );
        }
        tx.prepare("UPDATE stock_balances SET physical_qty = physical_qty - ? WHERE product_id = ?").run(
          l.base_qty,
          l.product_id
        );
        tx.prepare(
          `INSERT INTO stock_movements (product_id, movement_type, qty_signed, unit_cost_xof, reference_doc, comment, user_id, created_at)
           VALUES (?, 'VENTE_SORTIE', ?, ?, ?, ?, ?, ?)`
        ).run(l.product_id, -l.base_qty, prod.purchase_cost_xof, saleNumber, `Conversion commande ${ord.order_number}`, req.user.id, now);
      }
      if (paid > 0) {
        const openSess = tx.prepare("SELECT id FROM cash_sessions WHERE status = 'OUVERTE' ORDER BY id DESC LIMIT 1").get();
        tx.prepare(
          `INSERT INTO cash_movements (session_id, movement_type, payment_method, amount_signed_xof, reference_doc, comment, user_id, created_at)
           VALUES (?, 'VENTE_ENCAISSEMENT', ?, ?, ?, ?, ?, ?)`
        ).run(openSess?.id ?? null, method, paid, saleNumber, `Encaissement commande ${ord.order_number}`, req.user.id, now);
        if (openSess && method === "ESPECES") {
          tx.prepare("UPDATE cash_sessions SET theoretical_cash_xof = theoretical_cash_xof + ? WHERE id = ?").run(
            paid,
            openSess.id
          );
        }
      }
      tx.prepare("UPDATE customer_orders SET status = 'LIVREE', converted_sale_id = ? WHERE id = ?").run(
        saleId,
        orderId
      );
      return { saleId, saleNumber };
    });
    res.status(201).json(out);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
salesRouter.get("/deliveries", requirePermission("deliveries"), (_req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT d.*, c.name AS customer_name, c.phone AS customer_phone,
              co.order_number, co.total_xof AS order_total_xof, s.sale_number
       FROM deliveries d
       JOIN customers c ON c.id = d.customer_id
       LEFT JOIN customer_orders co ON co.id = d.order_id
       LEFT JOIN sales s ON s.id = d.sale_id
       ORDER BY d.id DESC`
  ).all();
  res.json(rows);
});
salesRouter.post("/deliveries", requirePermission("deliveries"), (req, res) => {
  try {
    const { order_id, sale_id, customer_id, driver_name, vehicle, address, scheduled_date, fee_xof } = req.body;
    const fee = toIntXof(fee_xof ?? 0, "frais de livraison");
    const db = getDb();
    const livNum = nextDocumentNumber(db, "LIV");
    const ins = db.prepare(
      `INSERT INTO deliveries (delivery_number, order_id, sale_id, customer_id, driver_name, vehicle, address, scheduled_date, fee_xof, status, user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PLANIFIEE', ?, ?)`
    ).run(
      livNum,
      order_id || null,
      sale_id || null,
      customer_id,
      driver_name.trim(),
      vehicle?.trim() ?? "",
      address.trim(),
      scheduled_date,
      fee,
      req.user.id,
      (/* @__PURE__ */ new Date()).toISOString()
    );
    res.status(201).json({ id: Number(ins.lastInsertRowid), delivery_number: livNum });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
salesRouter.patch("/deliveries/:id/status", requirePermission("deliveries"), (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status, proof_note, collected_xof } = req.body;
    const collected = toIntXof(collected_xof ?? 0, "montant encaiss\xE9");
    runInTransaction((tx) => {
      const deliv = tx.prepare("SELECT id, delivery_number, order_id FROM deliveries WHERE id = ?").get(id);
      if (!deliv) throw new Error("Livraison introuvable.");
      tx.prepare("UPDATE deliveries SET status = ?, proof_note = ?, collected_xof = ? WHERE id = ?").run(
        status,
        proof_note?.trim() ?? "",
        collected,
        id
      );
      if (deliv.order_id && status === "LIVREE") {
        tx.prepare("UPDATE customer_orders SET status = 'LIVREE' WHERE id = ?").run(deliv.order_id);
      } else if (deliv.order_id && status === "LIVREE_PARTIELLE") {
        tx.prepare("UPDATE customer_orders SET status = 'PARTIELLEMENT_LIVREE' WHERE id = ?").run(deliv.order_id);
      }
      writeAuditLog(tx, {
        userId: req.user.id,
        userName: req.user.full_name,
        action: "STATUT_LIVRAISON",
        entityType: "LIVRAISON",
        entityId: id,
        details: `${deliv.delivery_number} -> ${status} (${proof_note?.trim() || "RAS"})`
      });
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// server/routes-ops.ts
import { Router as Router3 } from "express";
import fs2 from "node:fs";
import path2 from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
var opsRouter = Router3();
opsRouter.get("/suppliers", requirePermission("suppliers"), (_req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT s.*,
              COALESCE((SELECT SUM(po.total_xof) FROM purchase_orders po WHERE po.supplier_id = s.id AND po.status IN ('CONFIRMEE', 'PARTIELLE', 'RECUE')), 0) AS total_purchased_xof,
              COALESCE((SELECT SUM(po.paid_xof) FROM purchase_orders po WHERE po.supplier_id = s.id AND po.status IN ('CONFIRMEE', 'PARTIELLE', 'RECUE')), 0) AS total_paid_xof,
              COALESCE((SELECT SUM(MAX(0, po.total_xof - po.paid_xof)) FROM purchase_orders po WHERE po.supplier_id = s.id AND po.status IN ('CONFIRMEE', 'PARTIELLE', 'RECUE')), 0) AS balance_due_xof
       FROM suppliers s
       WHERE s.active = 1
       ORDER BY s.name ASC`
  ).all();
  res.json(rows);
});
opsRouter.post("/suppliers", requirePermission("suppliers"), (req, res) => {
  try {
    const { name, contact_name, phone, address, payment_terms, lead_time_days } = req.body;
    if (!name?.trim()) throw new Error("Raison sociale obligatoire.");
    const db = getDb();
    const cnt = db.prepare("SELECT COUNT(*) as c FROM suppliers").get().c;
    const code = `FRN-${String(cnt + 1).padStart(3, "0")}`;
    const ins = db.prepare(
      `INSERT INTO suppliers (code, name, contact_name, phone, address, payment_terms, lead_time_days, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).run(
      code,
      name.trim(),
      contact_name?.trim() ?? "",
      phone?.trim() ?? "",
      address?.trim() ?? "",
      payment_terms?.trim() || "Comptant",
      Math.max(1, Number(lead_time_days) || 2),
      (/* @__PURE__ */ new Date()).toISOString()
    );
    res.status(201).json({ id: Number(ins.lastInsertRowid), code });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
opsRouter.post("/suppliers/payments", requirePermission("suppliers"), (req, res) => {
  try {
    const { supplier_id, po_id, amount_xof, payment_method, reference_note } = req.body;
    const amount = toPositiveInt(amount_xof, "montant pay\xE9");
    const out = runInTransaction((tx) => {
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const payNum = nextDocumentNumber(tx, "PAY");
      tx.prepare(
        `INSERT INTO supplier_payments (payment_number, supplier_id, po_id, amount_xof, payment_method, reference_note, user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(payNum, supplier_id, po_id || null, amount, payment_method || "ESPECES", reference_note?.trim() ?? "", req.user.id, now);
      if (po_id) {
        tx.prepare("UPDATE purchase_orders SET paid_xof = paid_xof + ? WHERE id = ?").run(amount, po_id);
      } else {
        const openPOs = tx.prepare(
          `SELECT id, total_xof, paid_xof FROM purchase_orders WHERE supplier_id = ? AND status IN ('CONFIRMEE', 'PARTIELLE', 'RECUE') AND total_xof > paid_xof ORDER BY id ASC`
        ).all(supplier_id);
        let rem = amount;
        for (const po of openPOs) {
          if (rem <= 0) break;
          const alloc = Math.min(rem, po.total_xof - po.paid_xof);
          tx.prepare("UPDATE purchase_orders SET paid_xof = paid_xof + ? WHERE id = ?").run(alloc, po.id);
          rem -= alloc;
        }
      }
      const openSess = tx.prepare("SELECT id FROM cash_sessions WHERE status = 'OUVERTE' ORDER BY id DESC LIMIT 1").get();
      tx.prepare(
        `INSERT INTO cash_movements (session_id, movement_type, payment_method, amount_signed_xof, reference_doc, comment, user_id, created_at)
         VALUES (?, 'PAIEMENT_FOURNISSEUR', ?, ?, ?, 'R\xE8glement fournisseur', ?, ?)`
      ).run(openSess?.id ?? null, payment_method || "ESPECES", -amount, payNum, req.user.id, now);
      if (openSess && (payment_method || "ESPECES") === "ESPECES") {
        tx.prepare("UPDATE cash_sessions SET theoretical_cash_xof = theoretical_cash_xof - ? WHERE id = ?").run(
          amount,
          openSess.id
        );
      }
      writeAuditLog(tx, {
        userId: req.user.id,
        userName: req.user.full_name,
        action: "REGLEMENT_FOURNISSEUR",
        entityType: "FOURNISSEUR",
        entityId: supplier_id,
        details: `${payNum} \u2014 R\xE8glement ${amount} FCFA (${payment_method || "ESPECES"})`
      });
      return { payNum };
    });
    res.status(201).json(out);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
opsRouter.get("/purchases", requirePermission("purchases"), (_req, res) => {
  const db = getDb();
  const pos = db.prepare(
    `SELECT po.*, s.name AS supplier_name, u.full_name AS creator_name
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN users u ON u.id = po.user_id
       ORDER BY po.id DESC`
  ).all();
  const lineStmt = db.prepare("SELECT * FROM purchase_order_lines WHERE po_id = ?");
  const recStmt = db.prepare("SELECT * FROM goods_receipts WHERE po_id = ? ORDER BY id DESC");
  res.json(
    pos.map((po) => ({
      ...po,
      lines: lineStmt.all(po.id),
      receipts: recStmt.all(po.id)
    }))
  );
});
opsRouter.get("/purchases/suggestions", requirePermission("purchases"), (_req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT p.id, p.sku, p.name, p.min_threshold, p.safety_stock, p.avg_daily_sales, p.purchase_cost_xof,
              s.id AS supplier_id, s.name AS supplier_name, COALESCE(s.lead_time_days, 2) AS lead_time_days,
              (COALESCE(sb.physical_qty, 0) - COALESCE(sb.reserved_qty, 0)) AS available_qty,
              COALESCE((
                SELECT SUM((pol.qty_ordered - pol.qty_received) * pol.conversion_factor)
                FROM purchase_order_lines pol
                JOIN purchase_orders po ON po.id = pol.po_id
                WHERE pol.product_id = p.id AND po.status IN ('CONFIRMEE', 'PARTIELLE')
              ), 0) AS expected_qty,
              COALESCE((SELECT name FROM product_packagings WHERE product_id = p.id AND is_default_purchase = 1 LIMIT 1), 'Unit\xE9') AS pack_name,
              COALESCE((SELECT conversion_factor FROM product_packagings WHERE product_id = p.id AND is_default_purchase = 1 LIMIT 1), 1) AS pack_factor
       FROM products p
       LEFT JOIN stock_balances sb ON sb.product_id = p.id
       LEFT JOIN suppliers s ON s.id = p.default_supplier_id
       WHERE p.active = 1 AND (COALESCE(sb.physical_qty, 0) - COALESCE(sb.reserved_qty, 0)) <= p.min_threshold
       ORDER BY available_qty ASC`
  ).all();
  const suggestions = rows.map((r) => {
    const demandLead = Math.round(r.avg_daily_sales * (r.lead_time_days + 5));
    const recommendedBase = Math.max(0, demandLead + r.safety_stock - r.available_qty - r.expected_qty);
    const recommendedPacks = Math.max(1, Math.ceil(recommendedBase / Math.max(1, r.pack_factor)));
    return {
      ...r,
      recommended_base_qty: recommendedBase,
      recommended_packs: recommendedPacks,
      estimated_cost_xof: recommendedPacks * r.pack_factor * r.purchase_cost_xof
    };
  });
  res.json(suggestions);
});
opsRouter.post("/purchases", requirePermission("purchases"), (req, res) => {
  try {
    const { supplier_id, expected_date, shipping_fee_xof, notes, lines } = req.body;
    if (!lines || lines.length === 0) throw new Error("Ajoutez au moins une ligne d\u2019achat.");
    const shipping = toIntXof(shipping_fee_xof ?? 0, "frais d\u2019approche");
    const out = runInTransaction((tx) => {
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const poNum = nextDocumentNumber(tx, "ACH");
      let total = shipping;
      const prepared = [];
      for (const l of lines) {
        const qty = toPositiveInt(l.qty_ordered, "quantit\xE9 command\xE9e");
        const cost = toIntXof(l.unit_cost_xof, "co\xFBt unitaire");
        const prod = tx.prepare("SELECT id, name FROM products WHERE id = ?").get(l.product_id);
        const pack = tx.prepare("SELECT id, name, conversion_factor FROM product_packagings WHERE id = ?").get(l.packaging_id);
        const lineTotal = qty * cost;
        total += lineTotal;
        prepared.push({
          product_id: prod.id,
          packaging_id: pack.id,
          product_name: prod.name,
          packaging_name: pack.name,
          factor: pack.conversion_factor,
          qty,
          unit_cost: cost,
          line_total: lineTotal
        });
      }
      const ins = tx.prepare(
        `INSERT INTO purchase_orders (po_number, supplier_id, status, expected_date, shipping_fee_xof, total_xof, paid_xof, notes, user_id, created_at)
           VALUES (?, ?, 'CONFIRMEE', ?, ?, ?, 0, ?, ?, ?)`
      ).run(poNum, supplier_id, expected_date || null, shipping, total, notes?.trim() ?? "", req.user.id, now);
      const poId = Number(ins.lastInsertRowid);
      for (const p of prepared) {
        tx.prepare(
          `INSERT INTO purchase_order_lines (po_id, product_id, packaging_id, product_name, packaging_name, conversion_factor, qty_ordered, qty_received, unit_cost_xof, line_total_xof)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
        ).run(poId, p.product_id, p.packaging_id, p.product_name, p.packaging_name, p.factor, p.qty, p.unit_cost, p.line_total);
      }
      writeAuditLog(tx, {
        userId: req.user.id,
        userName: req.user.full_name,
        action: "CREATION_COMMANDE_ACHAT",
        entityType: "ACHAT",
        entityId: poId,
        details: `${poNum} \u2014 Total ${total} FCFA (stock inchang\xE9 avant r\xE9ception)`
      });
      return { poId, poNumber: poNum };
    });
    res.status(201).json(out);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
opsRouter.post("/purchases/:id/receive", requirePermission("purchases"), (req, res) => {
  try {
    const poId = Number(req.params.id);
    const { notes, lines } = req.body;
    if (!lines || lines.length === 0) throw new Error("Aucune ligne \xE0 r\xE9ceptionner.");
    const out = runInTransaction((tx) => {
      const po = tx.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(poId);
      if (!po) throw new Error("Commande d\u2019achat introuvable.");
      if (po.status === "RECUE" || po.status === "ANNULEE") {
        throw new Error("Cette commande est d\xE9j\xE0 cl\xF4tur\xE9e.");
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const recNum = nextDocumentNumber(tx, "REC");
      let recTotalValue = 0;
      const rIns = tx.prepare(
        `INSERT INTO goods_receipts (receipt_number, po_id, supplier_id, total_value_xof, notes, user_id, created_at)
           VALUES (?, ?, ?, 0, ?, ?, ?)`
      ).run(recNum, poId, po.supplier_id, notes?.trim() ?? "", req.user.id, now);
      const recId = Number(rIns.lastInsertRowid);
      let anyReceived = false;
      for (const rl of lines) {
        const qtyRec = toIntXof(rl.qty_received, "quantit\xE9 re\xE7ue");
        const qtyRej = toIntXof(rl.qty_rejected ?? 0, "quantit\xE9 refus\xE9e");
        if (qtyRec < 0 || qtyRej < 0) throw new Error("Quantit\xE9s re\xE7ues/refus\xE9es invalides.");
        if (qtyRec === 0 && qtyRej === 0) continue;
        const pol = tx.prepare("SELECT * FROM purchase_order_lines WHERE id = ? AND po_id = ?").get(rl.po_line_id, poId);
        if (!pol) throw new Error("Ligne d\u2019achat introuvable.");
        if (pol.qty_received + qtyRec > pol.qty_ordered) {
          throw new Error("La quantit\xE9 re\xE7ue d\xE9passe le reliquat command\xE9.");
        }
        anyReceived = true;
        const packCost = rl.unit_cost_xof !== void 0 ? toIntXof(rl.unit_cost_xof, "co\xFBt") : pol.unit_cost_xof;
        const baseCost = Math.round(packCost / Math.max(1, pol.conversion_factor));
        const baseQtyRec = qtyRec * pol.conversion_factor;
        recTotalValue += qtyRec * packCost;
        const prod = tx.prepare(
          `SELECT p.purchase_cost_xof, sb.physical_qty
             FROM products p JOIN stock_balances sb ON sb.product_id = p.id
             WHERE p.id = ?`
        ).get(pol.product_id);
        const curQty = Math.max(0, prod.physical_qty);
        const newCump = curQty + baseQtyRec > 0 ? Math.round((curQty * prod.purchase_cost_xof + baseQtyRec * baseCost) / (curQty + baseQtyRec)) : baseCost;
        if (newCump !== prod.purchase_cost_xof) {
          tx.prepare(
            `INSERT INTO product_cost_history (product_id, previous_cost_xof, new_cost_xof, reason, user_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(pol.product_id, prod.purchase_cost_xof, newCump, `R\xE9ception ${recNum} (CUMP)`, req.user.id, now);
          tx.prepare("UPDATE products SET purchase_cost_xof = ? WHERE id = ?").run(newCump, pol.product_id);
        }
        tx.prepare("UPDATE purchase_order_lines SET qty_received = qty_received + ? WHERE id = ?").run(qtyRec, pol.id);
        tx.prepare("UPDATE stock_balances SET physical_qty = physical_qty + ? WHERE product_id = ?").run(
          baseQtyRec,
          pol.product_id
        );
        tx.prepare(
          `INSERT INTO stock_movements (product_id, movement_type, qty_signed, unit_cost_xof, reference_doc, comment, user_id, created_at)
           VALUES (?, 'ACHAT_RECEPTION', ?, ?, ?, ?, ?, ?)`
        ).run(
          pol.product_id,
          baseQtyRec,
          baseCost,
          recNum,
          `R\xE9ception sur ${po.po_number} (${qtyRec} cond.)`,
          req.user.id,
          now
        );
        if (rl.batch_number?.trim() && rl.expiry_date) {
          tx.prepare(
            `INSERT INTO product_batches (product_id, batch_number, expiry_date, qty_remaining, received_at)
             VALUES (?, ?, ?, ?, ?)`
          ).run(pol.product_id, rl.batch_number.trim(), rl.expiry_date, baseQtyRec, now);
        }
        tx.prepare(
          `INSERT INTO goods_receipt_lines (receipt_id, po_line_id, product_id, qty_received, qty_rejected, base_qty_received, unit_cost_xof, batch_number, expiry_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          recId,
          pol.id,
          pol.product_id,
          qtyRec,
          qtyRej,
          baseQtyRec,
          baseCost,
          rl.batch_number?.trim() || null,
          rl.expiry_date || null
        );
      }
      if (!anyReceived) throw new Error("Saisissez au moins une quantit\xE9 re\xE7ue sup\xE9rieure \xE0 z\xE9ro.");
      tx.prepare("UPDATE goods_receipts SET total_value_xof = ? WHERE id = ?").run(recTotalValue, recId);
      const remRow = tx.prepare("SELECT SUM(qty_ordered - qty_received) as rem FROM purchase_order_lines WHERE po_id = ?").get(poId);
      const newStatus = remRow.rem <= 0 ? "RECUE" : "PARTIELLE";
      tx.prepare("UPDATE purchase_orders SET status = ? WHERE id = ?").run(newStatus, poId);
      writeAuditLog(tx, {
        userId: req.user.id,
        userName: req.user.full_name,
        action: "RECEPTION_ACHAT",
        entityType: "RECEPTION",
        entityId: recId,
        details: `${recNum} sur ${po.po_number} \u2014 Valeur ${recTotalValue} FCFA (${newStatus})`
      });
      return { receiptNumber: recNum, newStatus, recTotalValue };
    });
    res.status(201).json(out);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
opsRouter.get("/cash/current", requirePermission("cash_expenses"), (_req, res) => {
  const db = getDb();
  const session = db.prepare("SELECT * FROM cash_sessions WHERE status = 'OUVERTE' ORDER BY id DESC LIMIT 1").get();
  let movements = [];
  let nonCashTotals = [];
  if (session) {
    movements = db.prepare(
      `SELECT cm.*, u.full_name AS user_name
         FROM cash_movements cm LEFT JOIN users u ON u.id = cm.user_id
         WHERE cm.session_id = ?
         ORDER BY cm.id DESC`
    ).all(session.id);
    nonCashTotals = db.prepare(
      `SELECT payment_method, SUM(amount_signed_xof) AS total_xof
         FROM cash_movements
         WHERE session_id = ? AND payment_method != 'ESPECES'
         GROUP BY payment_method`
    ).all(session.id);
  }
  const history = db.prepare("SELECT * FROM cash_sessions ORDER BY id DESC LIMIT 20").all();
  res.json({ session: session ?? null, movements, nonCashTotals, history });
});
opsRouter.post("/cash/open", requirePermission("cash_expenses"), (req, res) => {
  try {
    const { opening_float_xof, comment } = req.body;
    const floatXof = toIntXof(opening_float_xof, "fond de caisse initial");
    if (floatXof < 0) throw new Error("Le fond initial ne peut pas \xEAtre n\xE9gatif.");
    const db = getDb();
    const existing = db.prepare("SELECT id FROM cash_sessions WHERE status = 'OUVERTE'").get();
    if (existing) throw new Error("Une session de caisse est d\xE9j\xE0 ouverte.");
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const ins = db.prepare(
      `INSERT INTO cash_sessions (user_id, user_name, opened_at, opening_float_xof, theoretical_cash_xof, status, comment)
         VALUES (?, ?, ?, ?, ?, 'OUVERTE', ?)`
    ).run(req.user.id, req.user.full_name, now, floatXof, floatXof, comment?.trim() ?? "");
    writeAuditLog(db, {
      userId: req.user.id,
      userName: req.user.full_name,
      action: "OUVERTURE_CAISSE",
      entityType: "CAISSE",
      entityId: Number(ins.lastInsertRowid),
      details: `Ouverture avec fond de caisse ${floatXof} FCFA`
    });
    res.status(201).json({ id: Number(ins.lastInsertRowid) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
opsRouter.post("/cash/movement", requirePermission("cash_expenses"), (req, res) => {
  try {
    const { movement_type, amount_xof, payment_method, comment } = req.body;
    const amt = toPositiveInt(amount_xof, "montant");
    if (!comment?.trim()) throw new Error("Motif obligatoire.");
    const method = payment_method || "ESPECES";
    const signed = movement_type === "APPORT" ? amt : -amt;
    runInTransaction((tx) => {
      const openSess = tx.prepare("SELECT id FROM cash_sessions WHERE status = 'OUVERTE' ORDER BY id DESC LIMIT 1").get();
      if (!openSess) throw new Error("Aucune caisse ouverte actuellement.");
      tx.prepare(
        `INSERT INTO cash_movements (session_id, movement_type, payment_method, amount_signed_xof, reference_doc, comment, user_id, created_at)
         VALUES (?, ?, ?, ?, 'CAISSE-MVT', ?, ?, ?)`
      ).run(openSess.id, movement_type, method, signed, comment.trim(), req.user.id, (/* @__PURE__ */ new Date()).toISOString());
      if (method === "ESPECES") {
        tx.prepare("UPDATE cash_sessions SET theoretical_cash_xof = theoretical_cash_xof + ? WHERE id = ?").run(
          signed,
          openSess.id
        );
      }
      writeAuditLog(tx, {
        userId: req.user.id,
        userName: req.user.full_name,
        action: `CAISSE_${movement_type}`,
        entityType: "CAISSE",
        entityId: openSess.id,
        details: `${movement_type} ${amt} FCFA (${method}) \u2014 ${comment.trim()}`
      });
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
opsRouter.post("/cash/close", requirePermission("cash_expenses"), (req, res) => {
  try {
    const { counted_cash_xof, comment } = req.body;
    const counted = toIntXof(counted_cash_xof, "montant compt\xE9");
    if (counted < 0) throw new Error("Le montant compt\xE9 ne peut pas \xEAtre n\xE9gatif.");
    const result = runInTransaction((tx) => {
      const sess = tx.prepare("SELECT * FROM cash_sessions WHERE status = 'OUVERTE' ORDER BY id DESC LIMIT 1").get();
      if (!sess) throw new Error("Aucune session ouverte \xE0 cl\xF4turer.");
      const variance = counted - sess.theoretical_cash_xof;
      if (variance !== 0 && !comment?.trim()) {
        throw new Error("Un commentaire explicatif est obligatoire lorsqu\u2019il existe un \xE9cart de caisse.");
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      tx.prepare(
        `UPDATE cash_sessions
         SET status = 'CLOTUREE', closed_at = ?, counted_cash_xof = ?, variance_xof = ?, comment = ?
         WHERE id = ?`
      ).run(now, counted, variance, comment?.trim() ?? "", sess.id);
      writeAuditLog(tx, {
        userId: req.user.id,
        userName: req.user.full_name,
        action: "CLOTURE_CAISSE",
        entityType: "CAISSE",
        entityId: sess.id,
        details: `Cl\xF4ture caisse #${sess.id} \u2014 Th\xE9orique ${sess.theoretical_cash_xof} F, Compt\xE9 ${counted} F, \xC9cart ${variance} F`
      });
      return { theoretical: sess.theoretical_cash_xof, counted, variance };
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
opsRouter.get("/expenses", requirePermission("cash_expenses"), (_req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT e.*, ec.name AS category_name, u.full_name AS user_name
       FROM expenses e
       JOIN expense_categories ec ON ec.id = e.category_id
       LEFT JOIN users u ON u.id = e.user_id
       ORDER BY e.id DESC`
  ).all();
  res.json(rows);
});
opsRouter.post("/expenses", requirePermission("cash_expenses"), (req, res) => {
  try {
    const { category_id, beneficiary, amount_xof, payment_method, reference_note, comment, expense_date } = req.body;
    const amt = toPositiveInt(amount_xof, "montant de la d\xE9pense");
    if (!beneficiary?.trim()) throw new Error("Le b\xE9n\xE9ficiaire est obligatoire.");
    const expNum = runInTransaction((tx) => {
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const num = nextDocumentNumber(tx, "DEP");
      const method = payment_method || "ESPECES";
      tx.prepare(
        `INSERT INTO expenses (expense_number, category_id, beneficiary, amount_xof, payment_method, reference_note, comment, expense_date, user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        num,
        category_id,
        beneficiary.trim(),
        amt,
        method,
        reference_note?.trim() ?? "",
        comment?.trim() ?? "",
        expense_date || now.slice(0, 10),
        req.user.id,
        now
      );
      const openSess = tx.prepare("SELECT id FROM cash_sessions WHERE status = 'OUVERTE' ORDER BY id DESC LIMIT 1").get();
      tx.prepare(
        `INSERT INTO cash_movements (session_id, movement_type, payment_method, amount_signed_xof, reference_doc, comment, user_id, created_at)
         VALUES (?, 'DEPENSE', ?, ?, ?, ?, ?, ?)`
      ).run(openSess?.id ?? null, method, -amt, num, `D\xE9pense : ${beneficiary.trim()}`, req.user.id, now);
      if (openSess && method === "ESPECES") {
        tx.prepare("UPDATE cash_sessions SET theoretical_cash_xof = theoretical_cash_xof - ? WHERE id = ?").run(
          amt,
          openSess.id
        );
      }
      writeAuditLog(tx, {
        userId: req.user.id,
        userName: req.user.full_name,
        action: "ENREGISTREMENT_DEPENSE",
        entityType: "DEPENSE",
        entityId: num,
        details: `${num} \u2014 ${amt} FCFA (${method}) \xE0 ${beneficiary.trim()}`
      });
      return num;
    });
    res.status(201).json({ expense_number: expNum });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
opsRouter.get("/inventories", requirePermission("inventories"), (_req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT inv.*, u.full_name AS user_name,
              (SELECT COUNT(*) FROM inventory_lines il WHERE il.inventory_id = inv.id) AS line_count,
              (SELECT COALESCE(SUM(il.variance_value_xof), 0) FROM inventory_lines il WHERE il.inventory_id = inv.id) AS total_variance_xof
       FROM inventory_sessions inv
       LEFT JOIN users u ON u.id = inv.user_id
       ORDER BY inv.id DESC`
  ).all();
  res.json(rows);
});
opsRouter.get("/inventories/:id", requirePermission("inventories"), (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const inv = db.prepare("SELECT * FROM inventory_sessions WHERE id = ?").get(id);
  if (!inv) {
    res.status(404).json({ error: "Inventaire introuvable." });
    return;
  }
  const lines = db.prepare(
    `SELECT il.*, p.sku, p.name AS product_name, c.name AS category_name, u.label AS unit_label
       FROM inventory_lines il
       JOIN products p ON p.id = il.product_id
       JOIN categories c ON c.id = p.category_id
       JOIN units u ON u.id = p.unit_id
       WHERE il.inventory_id = ?
       ORDER BY p.name ASC`
  ).all(id);
  res.json({ session: inv, lines });
});
opsRouter.post("/inventories", requirePermission("inventories"), (req, res) => {
  try {
    const { category_id, notes } = req.body;
    const out = runInTransaction((tx) => {
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const invNum = nextDocumentNumber(tx, "INV");
      let scope = "Global (tous les produits actifs)";
      if (category_id) {
        const cat = tx.prepare("SELECT name FROM categories WHERE id = ?").get(category_id);
        scope = `Cat\xE9gorie : ${cat?.name ?? category_id}`;
      }
      const ins = tx.prepare(
        `INSERT INTO inventory_sessions (inventory_number, scope, status, notes, user_id, created_at)
           VALUES (?, ?, 'BROUILLON', ?, ?, ?)`
      ).run(invNum, scope, notes?.trim() ?? "", req.user.id, now);
      const invId = Number(ins.lastInsertRowid);
      const products = tx.prepare(
        `SELECT p.id, p.purchase_cost_xof, COALESCE(sb.physical_qty, 0) AS physical_qty
           FROM products p LEFT JOIN stock_balances sb ON sb.product_id = p.id
           WHERE p.active = 1 ${category_id ? "AND p.category_id = ?" : ""}`
      ).all(...category_id ? [category_id] : []);
      for (const p of products) {
        tx.prepare(
          `INSERT INTO inventory_lines (inventory_id, product_id, theoretical_qty, counted_qty, variance_qty, unit_cost_xof, variance_value_xof)
           VALUES (?, ?, ?, ?, 0, ?, 0)`
        ).run(invId, p.id, p.physical_qty, p.physical_qty, p.purchase_cost_xof);
      }
      return { id: invId, inventory_number: invNum };
    });
    res.status(201).json(out);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
opsRouter.put("/inventories/:id/lines", requirePermission("inventories"), (req, res) => {
  try {
    const invId = Number(req.params.id);
    const { counts } = req.body;
    runInTransaction((tx) => {
      const inv = tx.prepare("SELECT status FROM inventory_sessions WHERE id = ?").get(invId);
      if (!inv) throw new Error("Inventaire introuvable.");
      if (inv.status === "VALIDE") throw new Error("Un inventaire valid\xE9 ne peut plus \xEAtre modifi\xE9.");
      for (const c of counts) {
        const counted = toIntXof(c.counted_qty, "quantit\xE9 compt\xE9e");
        if (counted < 0) throw new Error("La quantit\xE9 compt\xE9e ne peut pas \xEAtre n\xE9gative.");
        const line = tx.prepare("SELECT theoretical_qty, unit_cost_xof FROM inventory_lines WHERE id = ? AND inventory_id = ?").get(c.line_id, invId);
        if (!line) continue;
        const variance = counted - line.theoretical_qty;
        const varVal = variance * line.unit_cost_xof;
        tx.prepare(
          "UPDATE inventory_lines SET counted_qty = ?, variance_qty = ?, variance_value_xof = ? WHERE id = ?"
        ).run(counted, variance, varVal, c.line_id);
      }
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
opsRouter.post("/inventories/:id/validate", requirePermission("inventories"), (req, res) => {
  try {
    const invId = Number(req.params.id);
    runInTransaction((tx) => {
      const inv = tx.prepare("SELECT * FROM inventory_sessions WHERE id = ?").get(invId);
      if (!inv) throw new Error("Inventaire introuvable.");
      if (inv.status === "VALIDE") throw new Error("Cet inventaire est d\xE9j\xE0 valid\xE9.");
      const lines = tx.prepare("SELECT * FROM inventory_lines WHERE inventory_id = ?").all(invId);
      const now = (/* @__PURE__ */ new Date()).toISOString();
      let adjustedCount = 0;
      for (const l of lines) {
        if (l.variance_qty !== 0) {
          tx.prepare("UPDATE stock_balances SET physical_qty = physical_qty + ? WHERE product_id = ?").run(
            l.variance_qty,
            l.product_id
          );
          tx.prepare(
            `INSERT INTO stock_movements (product_id, movement_type, qty_signed, unit_cost_xof, reference_doc, comment, user_id, created_at)
             VALUES (?, 'INVENTAIRE_CORRECTION', ?, ?, ?, ?, ?, ?)`
          ).run(
            l.product_id,
            l.variance_qty,
            l.unit_cost_xof,
            inv.inventory_number,
            `R\xE9gularisation inventaire (th\xE9orique ${l.theoretical_qty}, compt\xE9 ${l.counted_qty})`,
            req.user.id,
            now
          );
          adjustedCount++;
        }
      }
      tx.prepare("UPDATE inventory_sessions SET status = 'VALIDE', validated_at = ? WHERE id = ?").run(now, invId);
      writeAuditLog(tx, {
        userId: req.user.id,
        userName: req.user.full_name,
        action: "VALIDATION_INVENTAIRE",
        entityType: "INVENTAIRE",
        entityId: invId,
        details: `${inv.inventory_number} valid\xE9 \u2014 ${adjustedCount} ligne(s) r\xE9gularis\xE9e(s)`
      });
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
opsRouter.get("/margins", requirePermission("margins"), (req, res) => {
  const db = getDb();
  const from = req.query.from ? `${req.query.from}T00:00:00.000Z` : "2000-01-01T00:00:00.000Z";
  const to = req.query.to ? `${req.query.to}T23:59:59.999Z` : "2099-12-31T23:59:59.999Z";
  const byProduct = db.prepare(
    `SELECT sl.product_id, p.sku, sl.product_name, c.name AS category_name,
              SUM(sl.base_qty - sl.returned_base_qty) AS net_base_qty,
              COALESCE(SUM(sl.line_total_xof), 0) AS revenue_xof,
              COALESCE(SUM((sl.base_qty - sl.returned_base_qty) * sl.unit_cost_xof), 0) AS cogs_xof,
              COALESCE(SUM(sl.line_total_xof - ((sl.base_qty - sl.returned_base_qty) * sl.unit_cost_xof)), 0) AS gross_margin_xof
       FROM sale_lines sl
       JOIN sales s ON s.id = sl.sale_id
       JOIN products p ON p.id = sl.product_id
       JOIN categories c ON c.id = p.category_id
       WHERE s.status != 'ANNULEE' AND s.created_at >= ? AND s.created_at <= ?
       GROUP BY sl.product_id
       ORDER BY gross_margin_xof DESC`
  ).all(from, to);
  const totalExpenses = db.prepare("SELECT COALESCE(SUM(amount_xof), 0) AS exp FROM expenses WHERE created_at >= ? AND created_at <= ?").get(from, to).exp;
  const totalRevenue = byProduct.reduce((a, b) => a + b.revenue_xof, 0);
  const totalCogs = byProduct.reduce((a, b) => a + b.cogs_xof, 0);
  const totalMargin = totalRevenue - totalCogs;
  const estimatedResult = totalMargin - totalExpenses;
  res.json({
    summary: {
      totalRevenue,
      totalCogs,
      totalMargin,
      totalExpenses,
      estimatedResult,
      marginRatePct: totalCogs > 0 ? Math.round(totalMargin / totalCogs * 1e3) / 10 : 0,
      markupRatePct: totalRevenue > 0 ? Math.round(totalMargin / totalRevenue * 1e3) / 10 : 0
    },
    byProduct: byProduct.map((r) => ({
      ...r,
      margin_rate_pct: r.cogs_xof > 0 ? Math.round(r.gross_margin_xof / r.cogs_xof * 1e3) / 10 : 0,
      markup_rate_pct: r.revenue_xof > 0 ? Math.round(r.gross_margin_xof / r.revenue_xof * 1e3) / 10 : 0
    }))
  });
});
opsRouter.get("/reports/:type", requirePermission("reports"), (req, res) => {
  const db = getDb();
  const type = req.params.type;
  const from = req.query.from ? `${req.query.from}T00:00:00.000Z` : "2000-01-01T00:00:00.000Z";
  const to = req.query.to ? `${req.query.to}T23:59:59.999Z` : "2099-12-31T23:59:59.999Z";
  let rows = [];
  if (type === "ventes") {
    rows = db.prepare(
      `SELECT s.sale_number, substr(s.created_at, 1, 16) AS date_heure, c.name AS client,
                s.status AS statut, s.subtotal_xof AS brut_xof, s.discount_xof AS remise_xof,
                s.deposit_xof AS consigne_xof, s.total_xof, s.paid_xof AS paye_xof, s.credit_due_xof AS credit_xof,
                s.payment_summary AS mode_paiement
         FROM sales s JOIN customers c ON c.id = s.customer_id
         WHERE s.created_at >= ? AND s.created_at <= ?
         ORDER BY s.id DESC`
    ).all(from, to);
  } else if (type === "encaissements") {
    rows = db.prepare(
      `SELECT substr(cm.created_at, 1, 16) AS date_heure, cm.movement_type AS nature,
                cm.payment_method AS moyen, cm.amount_signed_xof AS montant_xof,
                cm.reference_doc AS document, cm.comment AS commentaire, u.full_name AS utilisateur
         FROM cash_movements cm LEFT JOIN users u ON u.id = cm.user_id
         WHERE cm.amount_signed_xof > 0 AND cm.created_at >= ? AND cm.created_at <= ?
         ORDER BY cm.id DESC`
    ).all(from, to);
  } else if (type === "credits") {
    rows = db.prepare(
      `SELECT c.code, c.name AS client, c.phone AS telephone, c.credit_limit_xof AS plafond_xof,
                COALESCE(SUM(CASE WHEN s.status != 'ANNULEE' THEN s.total_xof ELSE 0 END), 0) AS total_achats_xof,
                COALESCE(SUM(CASE WHEN s.status != 'ANNULEE' THEN s.paid_xof ELSE 0 END), 0) AS total_paye_xof,
                COALESCE(SUM(CASE WHEN s.status != 'ANNULEE' THEN s.credit_due_xof ELSE 0 END), 0) AS solde_du_xof
         FROM customers c LEFT JOIN sales s ON s.customer_id = c.id
         GROUP BY c.id
         HAVING solde_du_xof > 0 OR c.credit_limit_xof > 0
         ORDER BY solde_du_xof DESC`
    ).all();
  } else if (type === "fournisseurs") {
    rows = db.prepare(
      `SELECT s.code, s.name AS fournisseur,
                COALESCE(SUM(po.total_xof), 0) AS total_commandes_xof,
                COALESCE(SUM(po.paid_xof), 0) AS total_paye_xof,
                COALESCE(SUM(MAX(0, po.total_xof - po.paid_xof)), 0) AS solde_du_xof
         FROM suppliers s LEFT JOIN purchase_orders po ON po.supplier_id = s.id AND po.status != 'ANNULEE'
         GROUP BY s.id`
    ).all();
  } else if (type === "stock") {
    rows = db.prepare(
      `SELECT p.sku, p.name AS produit, c.name AS categorie, sb.physical_qty AS physique,
                sb.reserved_qty AS reserve, (sb.physical_qty - sb.reserved_qty) AS disponible,
                p.min_threshold AS seuil, p.purchase_cost_xof AS cump_xof,
                (sb.physical_qty * p.purchase_cost_xof) AS valeur_xof
         FROM products p JOIN categories c ON c.id = p.category_id JOIN stock_balances sb ON sb.product_id = p.id
         WHERE p.active = 1 ORDER BY p.name`
    ).all();
  } else if (type === "marges") {
    rows = db.prepare(
      `SELECT p.sku, sl.product_name AS produit, SUM(sl.base_qty - sl.returned_base_qty) AS qte_nette,
                SUM(sl.line_total_xof) AS ca_net_xof,
                SUM((sl.base_qty - sl.returned_base_qty) * sl.unit_cost_xof) AS cout_vendu_xof,
                SUM(sl.line_total_xof - ((sl.base_qty - sl.returned_base_qty) * sl.unit_cost_xof)) AS marge_brute_xof
         FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id JOIN products p ON p.id = sl.product_id
         WHERE s.status != 'ANNULEE' AND s.created_at >= ? AND s.created_at <= ?
         GROUP BY sl.product_id ORDER BY marge_brute_xof DESC`
    ).all(from, to);
  } else if (type === "depenses") {
    rows = db.prepare(
      `SELECT e.expense_number, e.expense_date, ec.name AS categorie, e.beneficiary AS beneficiaire,
                e.payment_method AS moyen, e.amount_xof AS montant_xof, e.comment AS commentaire
         FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
         WHERE e.created_at >= ? AND e.created_at <= ? ORDER BY e.id DESC`
    ).all(from, to);
  } else if (type === "caisse") {
    rows = db.prepare(
      `SELECT id, user_name AS caissier, substr(opened_at, 1, 16) AS ouverture, substr(COALESCE(closed_at, '-'), 1, 16) AS fermeture,
                opening_float_xof AS fond_initial, theoretical_cash_xof AS theorique,
                COALESCE(counted_cash_xof, 0) AS compte, COALESCE(variance_xof, 0) AS ecart, status AS statut
         FROM cash_sessions ORDER BY id DESC`
    ).all();
  } else if (type === "consignes") {
    rows = db.prepare(
      `SELECT dm.party_type AS type_tiers,
                CASE WHEN dm.party_type = 'CLIENT' THEN (SELECT name FROM customers WHERE id = dm.party_id)
                     WHEN dm.party_type = 'FOURNISSEUR' THEN (SELECT name FROM suppliers WHERE id = dm.party_id)
                     ELSE 'D\xE9p\xF4t' END AS tiers,
                rp.label AS emballage, SUM(dm.qty_signed) AS solde_qte,
                SUM(dm.qty_signed) * rp.deposit_value_xof AS valeur_xof
         FROM deposit_movements dm JOIN returnable_packaging rp ON rp.id = dm.packaging_id
         GROUP BY dm.party_type, dm.party_id, dm.packaging_id
         HAVING solde_qte != 0`
    ).all();
  } else if (type === "livraisons") {
    rows = db.prepare(
      `SELECT d.delivery_number, d.scheduled_date, c.name AS client, d.driver_name AS livreur,
                d.fee_xof AS frais_xof, d.status AS statut, d.proof_note AS commentaire
         FROM deliveries d JOIN customers c ON c.id = d.customer_id
         WHERE d.created_at >= ? AND d.created_at <= ? ORDER BY d.id DESC`
    ).all(from, to);
  } else if (type === "inventaires") {
    rows = db.prepare(
      `SELECT inv.inventory_number, inv.scope, inv.status, substr(inv.created_at, 1, 16) AS date_creation,
                COALESCE(SUM(il.variance_value_xof), 0) AS ecart_valeur_xof
         FROM inventory_sessions inv LEFT JOIN inventory_lines il ON il.inventory_id = inv.id
         GROUP BY inv.id ORDER BY inv.id DESC`
    ).all();
  } else if (type === "activite") {
    rows = db.prepare(
      `SELECT substr(created_at, 1, 16) AS date_heure, user_name AS utilisateur,
                action, entity_type AS module, details
         FROM audit_logs
         WHERE created_at >= ? AND created_at <= ?
         ORDER BY id DESC LIMIT 200`
    ).all(from, to);
  }
  res.json({ type, rows });
});
opsRouter.get("/reconciliation", requirePermission("reports"), (_req, res) => {
  const db = getDb();
  const stockDiffs = db.prepare(
    `SELECT p.sku, p.name, sb.physical_qty AS balance,
              COALESCE((SELECT SUM(qty_signed) FROM stock_movements sm WHERE sm.product_id = p.id), 0) AS ledger
       FROM products p JOIN stock_balances sb ON sb.product_id = p.id
       WHERE sb.physical_qty != COALESCE((SELECT SUM(qty_signed) FROM stock_movements sm WHERE sm.product_id = p.id), 0)`
  ).all();
  const cashDiffs = db.prepare(
    `SELECT cs.id, cs.user_name, cs.theoretical_cash_xof,
              (cs.opening_float_xof + COALESCE((SELECT SUM(amount_signed_xof) FROM cash_movements cm WHERE cm.session_id = cs.id AND cm.payment_method = 'ESPECES'), 0)) AS ledger_cash
       FROM cash_sessions cs
       WHERE cs.theoretical_cash_xof != (cs.opening_float_xof + COALESCE((SELECT SUM(amount_signed_xof) FROM cash_movements cm WHERE cm.session_id = cs.id AND cm.payment_method = 'ESPECES'), 0))`
  ).all();
  const custIntegrity = db.prepare(
    `SELECT COUNT(*) AS checked,
              SUM(CASE WHEN total_xof != (paid_xof + credit_due_xof) AND status = 'VALIDEE' THEN 1 ELSE 0 END) AS anomalies
       FROM sales`
  ).get();
  const integrityCheck = db.prepare("PRAGMA integrity_check;").get();
  res.json({
    sqliteIntegrity: integrityCheck.integrity_check,
    stockDiscrepancies: stockDiffs,
    cashDiscrepancies: cashDiffs,
    salesBalanceAnomalies: custIntegrity.anomalies || 0,
    salesChecked: custIntegrity.checked
  });
});
opsRouter.get("/settings", requireAuth, (_req, res) => {
  const db = getDb();
  const company = db.prepare("SELECT * FROM company_settings WHERE id = 1").get();
  res.json(company);
});
opsRouter.put("/settings", requirePermission("settings_users"), (req, res) => {
  try {
    const body = req.body;
    const db = getDb();
    db.prepare(
      `UPDATE company_settings
       SET name = ?, phone = ?, address = ?, city = ?, registration_no = ?, footer_note = ?,
           tax_enabled = ?, tax_rate = ?, reserve_stock_on_order = ?, auto_backup_on_start = ?, retention_daily = ?
       WHERE id = 1`
    ).run(
      body.name.trim(),
      body.phone?.trim() ?? "",
      body.address?.trim() ?? "",
      body.city?.trim() ?? "",
      body.registration_no?.trim() ?? "",
      body.footer_note?.trim() ?? "",
      body.tax_enabled ? 1 : 0,
      Number(body.tax_rate) || 0,
      body.reserve_stock_on_order ? 1 : 0,
      body.auto_backup_on_start ? 1 : 0,
      Math.max(1, Number(body.retention_daily) || 7)
    );
    writeAuditLog(db, {
      userId: req.user.id,
      userName: req.user.full_name,
      action: "MODIFICATION_PARAMETRES",
      entityType: "PARAMETRES",
      details: `Mise \xE0 jour param\xE8tres d\xE9p\xF4t (${body.name.trim()})`
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
opsRouter.post("/settings/reference", requirePermission("settings_users"), (req, res) => {
  try {
    const { kind, name, code, deposit_value_xof, capacity, is_cash } = req.body;
    if (!name?.trim()) throw new Error("Libell\xE9 obligatoire.");
    const db = getDb();
    let createdId = 0;
    if (kind === "category") {
      const ins = db.prepare("INSERT INTO categories (name) VALUES (?)").run(name.trim());
      createdId = Number(ins.lastInsertRowid);
    } else if (kind === "brand") {
      const ins = db.prepare("INSERT INTO brands (name) VALUES (?)").run(name.trim());
      createdId = Number(ins.lastInsertRowid);
    } else if (kind === "expense_category") {
      const ins = db.prepare("INSERT INTO expense_categories (name) VALUES (?)").run(name.trim());
      createdId = Number(ins.lastInsertRowid);
    } else if (kind === "unit") {
      const cleanCode = (code?.trim() || name.trim().slice(0, 4)).toUpperCase();
      const ins = db.prepare("INSERT INTO units (code, label) VALUES (?, ?)").run(cleanCode, name.trim());
      createdId = Number(ins.lastInsertRowid);
    } else if (kind === "payment_method") {
      const cleanCode = (code?.trim() || name.trim().replace(/[^a-zA-Z0-9]+/g, "_")).toUpperCase();
      const ins = db.prepare("INSERT INTO payment_methods (code, label, is_cash, active) VALUES (?, ?, ?, 1)").run(cleanCode, name.trim(), is_cash ? 1 : 0);
      createdId = Number(ins.lastInsertRowid);
    } else if (kind === "packaging") {
      const ins = db.prepare("INSERT INTO returnable_packaging (code, label, capacity, deposit_value_xof) VALUES (?, ?, ?, ?)").run(
        (code?.trim() || name.trim().replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 8)).toUpperCase(),
        name.trim(),
        Math.max(1, Number(capacity) || 1),
        toIntXof(deposit_value_xof ?? 0, "valeur consigne")
      );
      createdId = Number(ins.lastInsertRowid);
    }
    writeAuditLog(db, {
      userId: req.user.id,
      userName: req.user.full_name,
      action: "AJOUT_REFERENTIEL",
      entityType: kind.toUpperCase(),
      entityId: createdId,
      details: `Ajout "${name.trim()}"`
    });
    res.status(201).json({ ok: true, id: createdId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
opsRouter.delete("/settings/reference/:kind/:id", requirePermission("settings_users"), (req, res) => {
  try {
    const kind = req.params.kind;
    const id = Number(req.params.id);
    const db = getDb();
    if (kind === "category") {
      db.prepare("UPDATE categories SET active = 0 WHERE id = ?").run(id);
    } else if (kind === "brand") {
      db.prepare("UPDATE brands SET active = 0 WHERE id = ?").run(id);
    } else if (kind === "expense_category") {
      db.prepare("UPDATE expense_categories SET active = 0 WHERE id = ?").run(id);
    } else if (kind === "packaging") {
      db.prepare("UPDATE returnable_packaging SET active = 0 WHERE id = ?").run(id);
    } else if (kind === "payment_method") {
      db.prepare("UPDATE payment_methods SET active = 0 WHERE id = ?").run(id);
    } else if (kind === "unit") {
      const used = db.prepare("SELECT COUNT(*) as cnt FROM products WHERE unit_id = ?").get(id);
      if (used.cnt > 0) throw new Error("Unit\xE9 utilis\xE9e par au moins un produit du catalogue.");
      db.prepare("DELETE FROM units WHERE id = ?").run(id);
    } else {
      throw new Error("Type de r\xE9f\xE9rentiel inconnu.");
    }
    writeAuditLog(db, {
      userId: req.user.id,
      userName: req.user.full_name,
      action: "SUPPRESSION_REFERENTIEL",
      entityType: kind.toUpperCase(),
      entityId: id,
      details: `D\xE9sactivation / suppression \xE9l\xE9ment #${id}`
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
opsRouter.get("/users", requirePermission("settings_users"), (_req, res) => {
  const db = getDb();
  const users = db.prepare(
    `SELECT id, username, full_name, role, active, failed_attempts, last_login_at, created_at
       FROM users ORDER BY id ASC`
  ).all();
  res.json(users);
});
opsRouter.post("/users", requirePermission("settings_users"), (req, res) => {
  try {
    const { username, full_name, role, password, pin } = req.body;
    if (!username?.trim() || !full_name?.trim() || !password) {
      throw new Error("Identifiant, nom complet et mot de passe sont obligatoires.");
    }
    const db = getDb();
    const ins = db.prepare(
      `INSERT INTO users (username, full_name, role, password_hash, pin_hash, active, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`
    ).run(
      username.trim().toLowerCase(),
      full_name.trim(),
      role,
      hashSecret(password),
      pin ? hashSecret(pin) : null,
      (/* @__PURE__ */ new Date()).toISOString()
    );
    writeAuditLog(db, {
      userId: req.user.id,
      userName: req.user.full_name,
      action: "CREATION_UTILISATEUR",
      entityType: "UTILISATEUR",
      entityId: Number(ins.lastInsertRowid),
      details: `Cr\xE9ation ${username.trim()} (${role})`
    });
    res.status(201).json({ id: Number(ins.lastInsertRowid) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
opsRouter.put("/users/:id", requirePermission("settings_users"), (req, res) => {
  try {
    const id = Number(req.params.id);
    const { full_name, role, active, new_password, new_pin } = req.body;
    const db = getDb();
    const existing = db.prepare("SELECT id, username, role, active FROM users WHERE id = ?").get(id);
    if (!existing) throw new Error("Utilisateur introuvable.");
    if (existing.id === req.user.id && active === 0) {
      throw new Error("Vous ne pouvez pas d\xE9sactiver votre propre compte pendant votre session.");
    }
    if (full_name && role) {
      db.prepare("UPDATE users SET full_name = ?, role = ? WHERE id = ?").run(full_name.trim(), role, id);
    }
    if (active !== void 0) {
      db.prepare("UPDATE users SET active = ?, failed_attempts = 0 WHERE id = ?").run(active ? 1 : 0, id);
    }
    if (new_password) {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashSecret(new_password), id);
    }
    if (new_pin) {
      db.prepare("UPDATE users SET pin_hash = ? WHERE id = ?").run(hashSecret(new_pin), id);
    }
    writeAuditLog(db, {
      userId: req.user.id,
      userName: req.user.full_name,
      action: "MODIFICATION_UTILISATEUR",
      entityType: "UTILISATEUR",
      entityId: id,
      details: `Mise \xE0 jour utilisateur ${existing.username} (actif: ${active ?? existing.active})`
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
opsRouter.get("/audit-logs", requirePermission("settings_users"), (req, res) => {
  const db = getDb();
  const limit = Number(req.query.limit || 150);
  const rows = db.prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?").all(limit);
  res.json(rows);
});
opsRouter.get("/backups", requirePermission("backups"), (_req, res) => {
  const db = getDb();
  const history = db.prepare("SELECT * FROM backup_history ORDER BY id DESC").all();
  const integrity = db.prepare("PRAGMA integrity_check;").get();
  const stat = fs2.existsSync(DB_PATH) ? fs2.statSync(DB_PATH) : null;
  res.json({
    dbPath: DB_PATH,
    backupsDir: BACKUPS_DIR,
    mirrorDir: getAutoBackupMirrorDir(),
    dbSizeBytes: stat?.size ?? 0,
    liveIntegrity: integrity.integrity_check,
    history
  });
});
opsRouter.post("/backups/create", requirePermission("backups"), async (req, res) => {
  try {
    const { note } = req.body;
    const bkp = await createSqliteBackup("MANUELLE", note);
    const db = getDb();
    writeAuditLog(db, {
      userId: req.user.id,
      userName: req.user.full_name,
      action: "SAUVEGARDE_MANUELLE",
      entityType: "SAUVEGARDE",
      entityId: bkp.id,
      details: `Sauvegarde SQLite cr\xE9\xE9e (${bkp.filename}, ${bkp.size_bytes} octets, int\xE9grit\xE9=${bkp.integrity_ok ? "OK" : "ERREUR"})`
    });
    res.status(201).json(bkp);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
opsRouter.get("/backups/:id/download", requirePermission("backups"), (req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT filename, file_path FROM backup_history WHERE id = ?").get(Number(req.params.id));
  if (!row || !fs2.existsSync(row.file_path)) {
    res.status(404).json({ error: "Fichier de sauvegarde introuvable sur le disque." });
    return;
  }
  res.download(row.file_path, row.filename);
});
opsRouter.post("/backups/:id/restore", requirePermission("backups"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { admin_username, admin_secret } = req.body;
    if (!admin_username || !admin_secret) {
      res.status(400).json({ error: "L\u2019authentification d\u2019un administrateur est requise pour restaurer la base." });
      return;
    }
    const admin = verifySupervisorCredentials(admin_username, admin_secret);
    if (!admin || admin.role !== "ADMIN") {
      res.status(403).json({ error: "Authentification administrateur invalide." });
      return;
    }
    const db = getDb();
    const target = db.prepare("SELECT * FROM backup_history WHERE id = ?").get(id);
    if (!target || !fs2.existsSync(target.file_path)) {
      res.status(404).json({ error: "Fichier de sauvegarde introuvable." });
      return;
    }
    const testDb = new DatabaseSync2(target.file_path, { readOnly: true });
    let integrityOk = false;
    try {
      const chk = testDb.prepare("PRAGMA integrity_check;").get();
      integrityOk = chk.integrity_check === "ok";
    } finally {
      testDb.close();
    }
    if (!integrityOk) {
      res.status(400).json({ error: "Restauration annul\xE9e : la sauvegarde s\xE9lectionn\xE9e est corrompue." });
      return;
    }
    await createSqliteBackup("SECURITE_PRE_RESTAURATION", `Avant restauration de ${target.filename}`);
    closeDb();
    fs2.copyFileSync(target.file_path, DB_PATH);
    const walPath = `${DB_PATH}-wal`;
    const shmPath = `${DB_PATH}-shm`;
    if (fs2.existsSync(walPath)) fs2.unlinkSync(walPath);
    if (fs2.existsSync(shmPath)) fs2.unlinkSync(shmPath);
    const restoredDb = getDb();
    writeAuditLog(restoredDb, {
      userId: admin.id,
      userName: admin.full_name,
      action: "RESTAURATION_BASE",
      entityType: "SAUVEGARDE",
      entityId: target.id,
      details: `Base restaur\xE9e depuis ${target.filename} par ${admin.username}`
    });
    res.json({ ok: true, restoredFrom: target.filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
opsRouter.post("/backups/import", requirePermission("backups"), async (req, res) => {
  let tempPath = null;
  try {
    const { filename, base64Data, admin_username, admin_secret } = req.body;
    if (!admin_username || !admin_secret) {
      res.status(400).json({ error: "L\u2019authentification d\u2019un administrateur est requise pour importer une base." });
      return;
    }
    const admin = verifySupervisorCredentials(admin_username, admin_secret);
    if (!admin || admin.role !== "ADMIN") {
      res.status(403).json({ error: "Authentification administrateur invalide." });
      return;
    }
    if (!base64Data) {
      res.status(400).json({ error: "Aucun fichier de sauvegarde fourni." });
      return;
    }
    const buf = Buffer.from(base64Data, "base64");
    if (buf.length < 100 || buf.subarray(0, 15).toString("utf8") !== "SQLite format 3") {
      res.status(400).json({ error: "Le fichier s\xE9lectionn\xE9 n\u2019est pas une base SQLite valide." });
      return;
    }
    const safeName = (filename || "import.sqlite").replace(/[^a-zA-Z0-9._-]/g, "_");
    tempPath = path2.join(BACKUPS_DIR, `_import_${Date.now()}_${safeName}`);
    fs2.writeFileSync(tempPath, buf);
    const testDb = new DatabaseSync2(tempPath, { readOnly: true });
    let integrityOk = false;
    let hasUsersTable = false;
    try {
      const chk = testDb.prepare("PRAGMA integrity_check;").get();
      integrityOk = chk.integrity_check === "ok";
      const tbl = testDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
      hasUsersTable = !!tbl;
    } finally {
      testDb.close();
    }
    if (!integrityOk || !hasUsersTable) {
      fs2.unlinkSync(tempPath);
      tempPath = null;
      res.status(400).json({ error: "Import annul\xE9 : sauvegarde corrompue ou incompatible avec GestDepot." });
      return;
    }
    await createSqliteBackup("SECURITE_PRE_RESTAURATION", `Avant import externe (${safeName})`);
    closeDb();
    fs2.copyFileSync(tempPath, DB_PATH);
    fs2.unlinkSync(tempPath);
    tempPath = null;
    const walPath = `${DB_PATH}-wal`;
    const shmPath = `${DB_PATH}-shm`;
    if (fs2.existsSync(walPath)) fs2.unlinkSync(walPath);
    if (fs2.existsSync(shmPath)) fs2.unlinkSync(shmPath);
    const restoredDb = getDb();
    writeAuditLog(restoredDb, {
      userId: admin.id,
      userName: admin.full_name,
      action: "IMPORT_RESTAURATION_BASE",
      entityType: "SAUVEGARDE",
      details: `Base import\xE9e et restaur\xE9e depuis "${safeName}" par ${admin.username}`
    });
    res.json({ ok: true, restoredFrom: safeName });
  } catch (err) {
    if (tempPath && fs2.existsSync(tempPath)) {
      try {
        fs2.unlinkSync(tempPath);
      } catch {
      }
    }
    res.status(500).json({ error: err.message });
  }
});

// server.ts
async function startServer(options = {}) {
  initSchema();
  seedIfEmpty();
  try {
    const db = getDb();
    const settings = db.prepare("SELECT auto_backup_on_start FROM company_settings WHERE id = 1").get();
    const todayPrefix = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    const todayBackup = db.prepare("SELECT id FROM backup_history WHERE created_at LIKE ? LIMIT 1").get(`${todayPrefix}%`);
    if (settings?.auto_backup_on_start === 1 && !todayBackup) {
      await createSqliteBackup("AUTO_DEMARRAGE", "Sauvegarde automatique quotidienne au d\xE9marrage");
    }
  } catch (err) {
    console.error("Startup backup warning:", err);
  }
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.use(attachAuth);
  app.use("/api", coreRouter);
  app.use("/api", salesRouter);
  app.use("/api", opsRouter);
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = options.staticDistPath || path3.resolve(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path3.join(distPath, "index.html"));
    });
  }
  const requestedPort = options.port ?? Number(process.env.PORT ?? 3e3);
  const host = options.host ?? "0.0.0.0";
  const server = await new Promise((resolve, reject) => {
    const srv = app.listen(requestedPort, host, () => resolve(srv));
    srv.on("error", reject);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : requestedPort;
  console.log(`GestDepot server listening on http://${host}:${actualPort}`);
  let closed = false;
  const runAutoBackup = async (type = "AUTO_PERIODIQUE", reason = "Sauvegarde automatique vers le dossier local") => {
    if (closed) return null;
    return await createSqliteBackup(type, reason);
  };
  const shutdown = async (reason = "Fermeture propre du serveur") => {
    if (closed) return;
    closed = true;
    try {
      await createSqliteBackup("AUTO_FERMETURE", reason);
    } catch (err) {
      console.error("Shutdown backup warning:", err);
    }
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
    closeDb();
  };
  return { app, server, port: actualPort, runAutoBackup, shutdown };
}
if (process.env.GESTDEPOT_EMBEDDED !== "1") {
  startServer().catch((err) => {
    console.error("Failed to start GestDepot server:", err);
    process.exit(1);
  });
}
export {
  startServer
};
