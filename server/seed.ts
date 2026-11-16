import { getDb, hashSecret, runInTransaction, writeAuditLog } from './db.ts';

export function seedIfEmpty(): void {
  const db = getDb();
  const countRow = db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
  if (countRow.cnt > 0) return;

  runInTransaction((tx) => {
    const now = new Date().toISOString();

    // 1. Neutral company settings (ready to customize in Paramètres avancés)
    tx.prepare(
      `INSERT INTO company_settings (
        id, name, phone, address, city, registration_no, footer_note, currency,
        tax_enabled, tax_rate, reserve_stock_on_order, auto_backup_on_start, retention_daily,
        first_setup_completed, single_user_pin_migrated
      ) VALUES (1, ?, '', '', '', '', '', 'FCFA', 0, 0, 1, 1, 7, 0, 1)`,
    ).run('Mon Dépôt');

    // 2. Single-user desktop owner account (default PIN: 5555, modifiable in Paramètres avancés)
    tx.prepare(
      `INSERT INTO users (username, full_name, role, password_hash, pin_hash, active, created_at)
       VALUES ('admin', 'Administrateur', 'ADMIN', ?, ?, 1, ?)`,
    ).run(hashSecret('5555'), hashSecret('5555'), now);

    // 3. Structural reference lists (customizable dynamically via Paramètres avancés)
    const defaultCategories = [
      'Bières & Panachés',
      'Boissons Gazeuses',
      'Eaux Minérales',
      'Jus & Énergisants',
      'Vins & Spiritueux',
    ];
    for (const c of defaultCategories) {
      tx.prepare('INSERT INTO categories (name) VALUES (?)').run(c);
    }

    const defaultUnits = [
      { code: 'BTL', label: 'Bouteille' },
      { code: 'CAN', label: 'Canette' },
      { code: 'PCS', label: 'Pièce' },
      { code: 'LIT', label: 'Litre' },
    ];
    for (const u of defaultUnits) {
      tx.prepare('INSERT INTO units (code, label) VALUES (?, ?)').run(u.code, u.label);
    }

    tx.prepare("INSERT INTO price_lists (code, label, is_default) VALUES ('DETAIL', 'Tarif Détail', 1)").run();
    tx.prepare("INSERT INTO price_lists (code, label, is_default) VALUES ('GROS', 'Tarif Gros', 0)").run();
    tx.prepare("INSERT INTO price_lists (code, label, is_default) VALUES ('REVENDEUR', 'Tarif Revendeur', 0)").run();

    const defaultPayMethods = [
      { code: 'ESPECES', label: 'Espèces', isCash: 1 },
      { code: 'MOBILE_MONEY', label: 'Mobile Money', isCash: 0 },
      { code: 'CARTE', label: 'Carte bancaire', isCash: 0 },
      { code: 'VIREMENT', label: 'Virement bancaire', isCash: 0 },
      { code: 'CHEQUE', label: 'Chèque', isCash: 0 },
    ];
    for (const pm of defaultPayMethods) {
      tx.prepare('INSERT INTO payment_methods (code, label, is_cash) VALUES (?, ?, ?)').run(
        pm.code,
        pm.label,
        pm.isCash,
      );
    }

    const defaultExpenseCategories = [
      'Carburant & Livraison',
      'Manutention & Personnel',
      'Électricité & Eau',
      'Loyer & Entretien',
      'Fournitures & Divers',
    ];
    for (const ec of defaultExpenseCategories) {
      tx.prepare('INSERT INTO expense_categories (name) VALUES (?)').run(ec);
    }

    // 4. Default anonymous walk-in customer for direct POS cash sales
    const plDetail = (tx.prepare("SELECT id FROM price_lists WHERE code = 'DETAIL'").get() as { id: number }).id;
    tx.prepare(
      `INSERT INTO customers (code, name, phone, address, customer_type, price_list_id, credit_limit_xof, active, created_at)
       VALUES ('CLI-000', 'Client Comptoir', '', '', 'Comptoir', ?, 0, 1, ?)`,
    ).run(plDetail, now);

    writeAuditLog(tx, {
      userId: 1,
      userName: 'Administrateur',
      action: 'INITIALISATION_SYSTEME',
      entityType: 'SYSTEME',
      details: 'Base locale GestDepot initialisée vierge (prête pour vos données réelles).',
    });
  });
}
