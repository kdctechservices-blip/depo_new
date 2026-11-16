import { Router } from 'express';
import crypto from 'node:crypto';
import { getDb, hashSecret, verifySecret, runInTransaction, writeAuditLog } from './db.ts';
import { getPermissionsForRole, type UserRole } from './rbac.ts';
import {
  type AuthedRequest,
  requireAuth,
  requirePermission,
  verifySupervisorCredentials,
  toIntXof,
  toPositiveInt,
} from './middleware.ts';

export const coreRouter = Router();

// ==================== AUTHENTIFICATION (CODE PIN UTILISATEUR UNIQUE) ====================

let pinCooldownUntil = 0;

coreRouter.get('/auth/pin-status', (_req, res) => {
  const db = getDb();
  const adminUser = db
    .prepare("SELECT pin_hash FROM users WHERE active = 1 AND role = 'ADMIN' ORDER BY id ASC LIMIT 1")
    .get() as { pin_hash: string | null } | undefined;
  const company = db.prepare('SELECT name FROM company_settings WHERE id = 1').get() as
    | { name: string }
    | undefined;

  res.json({
    isDefaultPin: adminUser?.pin_hash ? verifySecret('5555', adminUser.pin_hash) : false,
    depotName: company?.name || 'GestDepot',
  });
});

coreRouter.post('/auth/login', (req, res) => {
  const { pin, username, secret } = req.body as { pin?: string; username?: string; secret?: string };
  const providedPin = (pin ?? secret ?? '').trim();
  if (!providedPin) {
    res.status(400).json({ error: 'Veuillez saisir votre Code PIN.' });
    return;
  }

  if (Date.now() < pinCooldownUntil) {
    const secs = Math.max(1, Math.ceil((pinCooldownUntil - Date.now()) / 1000));
    res.status(429).json({ error: `Trop de tentatives. Réessayez dans ${secs} seconde(s).` });
    return;
  }

  const db = getDb();
  const user = (
    username?.trim()
      ? db
          .prepare(
            `SELECT id, username, full_name, role, password_hash, pin_hash, active, failed_attempts
             FROM users WHERE username = ?`,
          )
          .get(username.trim())
      : db
          .prepare(
            `SELECT id, username, full_name, role, password_hash, pin_hash, active, failed_attempts
             FROM users WHERE active = 1 AND role = 'ADMIN' ORDER BY id ASC LIMIT 1`,
          )
          .get()
  ) as
    | {
        id: number;
        username: string;
        full_name: string;
        role: UserRole;
        password_hash: string;
        pin_hash: string | null;
        active: number;
        failed_attempts: number;
      }
    | undefined;

  if (!user || user.active !== 1) {
    res.status(401).json({ error: 'Code PIN invalide.' });
    return;
  }

  const ok = pin !== undefined ? verifySecret(providedPin, user.pin_hash) : verifySecret(providedPin, user.pin_hash) || verifySecret(providedPin, user.password_hash);
  if (!ok) {
    const nextAttempts = user.failed_attempts + 1;
    if (nextAttempts >= 5) {
      pinCooldownUntil = Date.now() + 15_000;
      db.prepare('UPDATE users SET failed_attempts = 0 WHERE id = ?').run(user.id);
    } else {
      db.prepare('UPDATE users SET failed_attempts = ? WHERE id = ?').run(nextAttempts, user.id);
    }
    writeAuditLog(db, {
      userId: user.id,
      userName: user.full_name,
      action: 'CONNEXION_ECHEC',
      entityType: 'SECURITE',
      entityId: user.id,
      details: 'Tentative de déverrouillage avec Code PIN incorrect',
    });
    res.status(401).json({
      error: nextAttempts >= 5 ? 'Code PIN incorrect. Temporisation de sécurité de 15 secondes.' : 'Code PIN incorrect.',
    });
    return;
  }

  pinCooldownUntil = 0;
  const token = crypto.randomBytes(24).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + 24 * 3600 * 1000);

  runInTransaction((tx) => {
    tx.prepare('UPDATE users SET failed_attempts = 0, last_login_at = ? WHERE id = ?').run(
      now.toISOString(),
      user.id,
    );
    tx.prepare('INSERT INTO user_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
      token,
      user.id,
      now.toISOString(),
      expires.toISOString(),
    );
    writeAuditLog(tx, {
      userId: user.id,
      userName: user.full_name,
      action: 'CONNEXION_REUSSIE',
      entityType: 'SECURITE',
      entityId: user.id,
      details: 'Déverrouillage de session par Code PIN',
    });
  });

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      permissions: getPermissionsForRole(user.role),
    },
  });
});

coreRouter.put('/auth/pin', requireAuth, (req: AuthedRequest, res) => {
  try {
    const { current_pin, new_pin } = req.body as { current_pin?: string; new_pin?: string };
    const current = (current_pin ?? '').trim();
    const next = (new_pin ?? '').trim();

    if (!current) {
      res.status(400).json({ error: 'Veuillez saisir le code PIN actuel.' });
      return;
    }
    if (!/^\d{4,8}$/.test(next)) {
      res.status(400).json({ error: 'Le nouveau code PIN doit contenir uniquement entre 4 et 8 chiffres.' });
      return;
    }

    const db = getDb();
    const row = db
      .prepare('SELECT id, full_name, pin_hash FROM users WHERE id = ?')
      .get(req.user!.id) as { id: number; full_name: string; pin_hash: string | null } | undefined;

    if (!row || !verifySecret(current, row.pin_hash)) {
      res.status(403).json({ error: 'Le code PIN actuel est incorrect.' });
      return;
    }

    db.prepare('UPDATE users SET pin_hash = ?, failed_attempts = 0 WHERE id = ?').run(hashSecret(next), row.id);
    writeAuditLog(db, {
      userId: row.id,
      userName: row.full_name,
      action: 'MODIFICATION_CODE_PIN',
      entityType: 'SECURITE',
      entityId: row.id,
      details: 'Code PIN d’accès modifié depuis Paramètres avancés',
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

coreRouter.post('/auth/logout', requireAuth, (req: AuthedRequest, res) => {
  const db = getDb();
  if (req.sessionToken) {
    db.prepare('DELETE FROM user_sessions WHERE token = ?').run(req.sessionToken);
  }
  if (req.user) {
    writeAuditLog(db, {
      userId: req.user.id,
      userName: req.user.full_name,
      action: 'DECONNEXION',
      entityType: 'SECURITE',
      entityId: req.user.id,
      details: 'Verrouillage manuel de la session',
    });
  }
  res.json({ ok: true });
});

coreRouter.get('/auth/me', requireAuth, (req: AuthedRequest, res) => {
  const u = req.user!;
  const db = getDb();
  const row = db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(u.id) as { pin_hash: string | null } | undefined;
  res.json({
    user: {
      ...u,
      permissions: getPermissionsForRole(u.role),
      isDefaultPin: row?.pin_hash ? verifySecret('5555', row.pin_hash) : false,
    },
  });
});

coreRouter.post('/auth/verify-supervisor', requireAuth, (req: AuthedRequest, res) => {
  const { username, secret } = req.body as { username?: string; secret?: string };
  if (!secret) {
    res.status(400).json({ error: 'Code PIN requis.' });
    return;
  }
  const sup = verifySupervisorCredentials(username || 'admin', secret);
  if (!sup) {
    res.status(403).json({ error: 'Code PIN incorrect ou droits insuffisants.' });
    return;
  }
  res.json({ verified: true, supervisor: sup });
});

// ==================== TABLEAU DE BORD ====================

coreRouter.get('/dashboard', requireAuth, (req: AuthedRequest, res) => {
  const db = getDb();
  const period = (req.query.period as string) || '7d';
  const now = new Date();
  let start = new Date();
  let end = new Date();

  if (period === 'today') {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (period === 'yesterday') {
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() - 1);
    end.setHours(23, 59, 59, 999);
  } else if (period === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (period === 'custom' && req.query.from && req.query.to) {
    start = new Date(`${req.query.from}T00:00:00.000Z`);
    end = new Date(`${req.query.to}T23:59:59.999Z`);
  } else {
    // 7d
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  }

  const fromIso = start.toISOString();
  const toIso = end.toISOString();

  // Net Sales (excluding deposits, minus returns)
  const salesAgg = db
    .prepare(
      `SELECT
         COALESCE(SUM(subtotal_xof - discount_xof), 0) AS gross_sales_xof,
         COUNT(*) AS sales_count
       FROM sales
       WHERE status != 'ANNULEE' AND created_at >= ? AND created_at <= ?`,
    )
    .get(fromIso, toIso) as { gross_sales_xof: number; sales_count: number };

  const returnsAgg = db
    .prepare(
      `SELECT COALESCE(SUM(total_refund_xof), 0) AS returns_xof
       FROM sale_returns
       WHERE created_at >= ? AND created_at <= ?`,
    )
    .get(fromIso, toIso) as { returns_xof: number };

  const netRevenueXof = salesAgg.gross_sales_xof - returnsAgg.returns_xof;

  // Real cash/mobile collections in period (sales + debt repayments)
  const collectionsByMethod = db
    .prepare(
      `SELECT payment_method, COALESCE(SUM(amount_signed_xof), 0) AS total_xof
       FROM cash_movements
       WHERE movement_type IN ('VENTE_ENCAISSEMENT', 'REGLEMENT_CREANCE')
         AND created_at >= ? AND created_at <= ?
       GROUP BY payment_method
       ORDER BY total_xof DESC`,
    )
    .all(fromIso, toIso) as Array<{ payment_method: string; total_xof: number }>;

  const totalCollectionsXof = collectionsByMethod.reduce((acc, r) => acc + r.total_xof, 0);

  // Open customer receivables (global live balance)
  const receivablesAgg = db
    .prepare(
      `SELECT COALESCE(SUM(credit_due_xof), 0) AS open_receivables_xof,
              COUNT(CASE WHEN credit_due_xof > 0 THEN 1 END) AS open_credit_sales
       FROM sales WHERE status != 'ANNULEE' AND credit_due_xof > 0`,
    )
    .get() as { open_receivables_xof: number; open_credit_sales: number };

  // Overdue credit sales
  const todayDate = new Date().toISOString().slice(0, 10);
  const overdueCredits = db
    .prepare(
      `SELECT s.id, s.sale_number, c.name AS customer_name, s.credit_due_xof, s.due_date
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       WHERE s.status != 'ANNULEE' AND s.credit_due_xof > 0 AND s.due_date IS NOT NULL AND s.due_date < ?
       ORDER BY s.due_date ASC`,
    )
    .all(todayDate) as Array<{
    id: number;
    sale_number: string;
    customer_name: string;
    credit_due_xof: number;
    due_date: string;
  }>;

  // Open supplier payables (based on received goods value or confirmed POs minus paid)
  const payablesAgg = db
    .prepare(
      `SELECT COALESCE(SUM(MAX(0, total_xof - paid_xof)), 0) AS open_payables_xof
       FROM purchase_orders WHERE status IN ('CONFIRMEE', 'PARTIELLE', 'RECUE')`,
    )
    .get() as { open_payables_xof: number };

  // Expenses in period
  const expensesAgg = db
    .prepare(
      `SELECT COALESCE(SUM(amount_xof), 0) AS expenses_xof
       FROM expenses
       WHERE created_at >= ? AND created_at <= ?`,
    )
    .get(fromIso, toIso) as { expenses_xof: number };

  // Historical COGS and Gross Margin in period
  const marginAgg = db
    .prepare(
      `SELECT
         COALESCE(SUM(sl.line_total_xof), 0) AS line_rev_xof,
         COALESCE(SUM(sl.base_qty * sl.unit_cost_xof), 0) AS cogs_xof
       FROM sale_lines sl
       JOIN sales s ON s.id = sl.sale_id
       WHERE s.status != 'ANNULEE' AND s.created_at >= ? AND s.created_at <= ?`,
    )
    .get(fromIso, toIso) as { line_rev_xof: number; cogs_xof: number };

  const grossMarginXof = netRevenueXof - marginAgg.cogs_xof;
  const estimatedResultXof = grossMarginXof - expensesAgg.expenses_xof;

  // Stock value at CUMP & alerts
  const stockAgg = db
    .prepare(
      `SELECT
         COALESCE(SUM(MAX(0, sb.physical_qty) * p.purchase_cost_xof), 0) AS stock_value_xof,
         COUNT(CASE WHEN (sb.physical_qty - sb.reserved_qty) <= 0 THEN 1 END) AS out_of_stock_count,
         COUNT(CASE WHEN (sb.physical_qty - sb.reserved_qty) > 0 AND (sb.physical_qty - sb.reserved_qty) <= p.min_threshold THEN 1 END) AS low_stock_count
       FROM products p
       JOIN stock_balances sb ON sb.product_id = p.id
       WHERE p.active = 1`,
    )
    .get() as { stock_value_xof: number; out_of_stock_count: number; low_stock_count: number };

  const lowStockItems = db
    .prepare(
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
         p.name ASC`,
    )
    .all();

  const pendingOrdersCount = (
    db
      .prepare(
        `SELECT COUNT(*) as cnt FROM customer_orders WHERE status IN ('CONFIRMEE', 'EN_PREPARATION', 'PRETE')`,
      )
      .get() as { cnt: number }
  ).cnt;

  const pendingDeliveriesCount = (
    db
      .prepare(`SELECT COUNT(*) as cnt FROM deliveries WHERE status IN ('PLANIFIEE', 'EN_COURS', 'LIVREE_PARTIELLE')`)
      .get() as { cnt: number }
  ).cnt;

  // Charts: continuous daily sales (at least 7 days window) + 8-week weekly sales
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const toDayKey = (d: Date) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

  const endUtc = new Date(Date.UTC(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999));
  const startUtc = new Date(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0, 0));
  const spanDays = Math.max(1, Math.round((endUtc.getTime() - startUtc.getTime()) / 86400000) + 1);

  const dailyStartUtc =
    spanDays < 7
      ? new Date(Date.UTC(endUtc.getUTCFullYear(), endUtc.getUTCMonth(), endUtc.getUTCDate() - 6, 0, 0, 0, 0))
      : spanDays > 62
        ? new Date(Date.UTC(endUtc.getUTCFullYear(), endUtc.getUTCMonth(), endUtc.getUTCDate() - 61, 0, 0, 0, 0))
        : startUtc;

  const dailySalesRows = db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day,
              COALESCE(SUM(subtotal_xof - discount_xof), 0) AS revenue_xof,
              COUNT(*) AS count
       FROM sales
       WHERE status != 'ANNULEE' AND created_at >= ? AND created_at <= ?
       GROUP BY substr(created_at, 1, 10)`,
    )
    .all(dailyStartUtc.toISOString(), endUtc.toISOString()) as Array<{
    day: string;
    revenue_xof: number;
    count: number;
  }>;

  const dailyReturnsRows = db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day,
              COALESCE(SUM(total_refund_xof), 0) AS returns_xof
       FROM sale_returns
       WHERE created_at >= ? AND created_at <= ?
       GROUP BY substr(created_at, 1, 10)`,
    )
    .all(dailyStartUtc.toISOString(), endUtc.toISOString()) as Array<{ day: string; returns_xof: number }>;

  const dailySalesMap = new Map(dailySalesRows.map((r) => [r.day, r]));
  const dailyReturnsMap = new Map(dailyReturnsRows.map((r) => [r.day, r.returns_xof]));

  const salesByDay: Array<{
    day: string;
    label: string;
    revenue_xof: number;
    returns_xof: number;
    net_revenue_xof: number;
    count: number;
  }> = [];

  for (
    let cursor = new Date(dailyStartUtc.getTime());
    cursor.getTime() <= endUtc.getTime();
    cursor = new Date(cursor.getTime() + 86400000)
  ) {
    const key = toDayKey(cursor);
    const s = dailySalesMap.get(key);
    const ret = dailyReturnsMap.get(key) ?? 0;
    const rev = s?.revenue_xof ?? 0;
    salesByDay.push({
      day: key,
      label: new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(cursor),
      revenue_xof: Math.max(0, rev - ret),
      returns_xof: ret,
      net_revenue_xof: rev - ret,
      count: s?.count ?? 0,
    });
  }

  // Last 8 calendar weeks (Monday -> Sunday) ending at endUtc's week
  const endDow = (endUtc.getUTCDay() + 6) % 7; // Monday = 0, Sunday = 6
  const currentWeekMonday = new Date(
    Date.UTC(endUtc.getUTCFullYear(), endUtc.getUTCMonth(), endUtc.getUTCDate() - endDow, 0, 0, 0, 0),
  );
  const firstWeekMonday = new Date(currentWeekMonday.getTime() - 7 * 7 * 86400000);

  const weeklySalesRaw = db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day,
              COALESCE(SUM(subtotal_xof - discount_xof), 0) AS revenue_xof,
              COUNT(*) AS count
       FROM sales
       WHERE status != 'ANNULEE' AND created_at >= ? AND created_at <= ?
       GROUP BY substr(created_at, 1, 10)`,
    )
    .all(firstWeekMonday.toISOString(), endUtc.toISOString()) as Array<{
    day: string;
    revenue_xof: number;
    count: number;
  }>;

  const weeklyReturnsRaw = db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day,
              COALESCE(SUM(total_refund_xof), 0) AS returns_xof
       FROM sale_returns
       WHERE created_at >= ? AND created_at <= ?
       GROUP BY substr(created_at, 1, 10)`,
    )
    .all(firstWeekMonday.toISOString(), endUtc.toISOString()) as Array<{ day: string; returns_xof: number }>;

  const weekSalesMap = new Map(weeklySalesRaw.map((r) => [r.day, r]));
  const weekReturnsMap = new Map(weeklyReturnsRaw.map((r) => [r.day, r.returns_xof]));

  const getIsoWeek = (d: Date) => {
    const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    return Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  };

  const salesByWeek: Array<{
    week_key: string;
    label: string;
    week_start: string;
    week_end: string;
    revenue_xof: number;
    returns_xof: number;
    net_revenue_xof: number;
    count: number;
  }> = [];

  for (let w = 0; w < 8; w++) {
    const wStart = new Date(firstWeekMonday.getTime() + w * 7 * 86400000);
    const wEnd = new Date(wStart.getTime() + 6 * 86400000);
    let rev = 0;
    let ret = 0;
    let cnt = 0;
    for (let d = 0; d < 7; d++) {
      const dayKey = toDayKey(new Date(wStart.getTime() + d * 86400000));
      const row = weekSalesMap.get(dayKey);
      if (row) {
        rev += row.revenue_xof;
        cnt += row.count;
      }
      ret += weekReturnsMap.get(dayKey) ?? 0;
    }
    const isoW = getIsoWeek(wStart);
    const shortStart = new Intl.DateTimeFormat('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      timeZone: 'UTC',
    }).format(wStart);
    salesByWeek.push({
      week_key: `${wStart.getUTCFullYear()}-S${String(isoW).padStart(2, '0')}`,
      label: `S${isoW} (${shortStart})`,
      week_start: toDayKey(wStart),
      week_end: toDayKey(wEnd),
      revenue_xof: Math.max(0, rev - ret),
      returns_xof: ret,
      net_revenue_xof: rev - ret,
      count: cnt,
    });
  }

  const salesByCategory = db
    .prepare(
      `SELECT c.name AS category,
              COALESCE(SUM(sl.line_total_xof), 0) AS revenue_xof,
              COALESCE(SUM(sl.line_total_xof - (sl.base_qty * sl.unit_cost_xof)), 0) AS margin_xof
       FROM sale_lines sl
       JOIN sales s ON s.id = sl.sale_id
       JOIN products p ON p.id = sl.product_id
       JOIN categories c ON c.id = p.category_id
       WHERE s.status != 'ANNULEE' AND s.created_at >= ? AND s.created_at <= ?
       GROUP BY c.id
       ORDER BY revenue_xof DESC`,
    )
    .all(fromIso, toIso);

  const topProducts = db
    .prepare(
      `SELECT sl.product_id, sl.product_name,
              SUM(sl.base_qty) AS total_base_qty,
              COALESCE(SUM(sl.line_total_xof), 0) AS revenue_xof,
              COALESCE(SUM(sl.line_total_xof - (sl.base_qty * sl.unit_cost_xof)), 0) AS margin_xof
       FROM sale_lines sl
       JOIN sales s ON s.id = sl.sale_id
       WHERE s.status != 'ANNULEE' AND s.created_at >= ? AND s.created_at <= ?
       GROUP BY sl.product_id
       ORDER BY revenue_xof DESC
       LIMIT 6`,
    )
    .all(fromIso, toIso);

  const lastBackup = db
    .prepare('SELECT id, filename, integrity_ok, status, created_at FROM backup_history ORDER BY id DESC LIMIT 1')
    .get();

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
      pendingDeliveriesCount,
    },
    collectionsByMethod,
    salesByDay,
    salesByWeek,
    salesByCategory,
    topProducts,
    lowStockItems,
    overdueCredits,
    lastBackup: lastBackup ?? null,
  });
});

// ==================== CATALOGUE & RÉFÉRENTIELS ====================

coreRouter.get('/catalog/meta', requireAuth, (_req, res) => {
  const db = getDb();
  res.json({
    categories: db.prepare('SELECT * FROM categories WHERE active = 1 ORDER BY name').all(),
    brands: db.prepare('SELECT * FROM brands WHERE active = 1 ORDER BY name').all(),
    units: db.prepare('SELECT * FROM units ORDER BY label').all(),
    priceLists: db.prepare('SELECT * FROM price_lists ORDER BY id').all(),
    paymentMethods: db.prepare('SELECT * FROM payment_methods WHERE active = 1 ORDER BY id').all(),
    returnablePackagings: db.prepare('SELECT * FROM returnable_packaging WHERE active = 1 ORDER BY code').all(),
    suppliers: db.prepare('SELECT id, code, name FROM suppliers WHERE active = 1 ORDER BY name').all(),
    expenseCategories: db.prepare('SELECT * FROM expense_categories WHERE active = 1 ORDER BY name').all(),
  });
});

coreRouter.get('/products', requireAuth, (req, res) => {
  const db = getDb();
  const includeArchived = req.query.archived === '1';
  const products = db
    .prepare(
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
       ${includeArchived ? '' : 'WHERE p.active = 1'}
       ORDER BY p.is_favorite DESC, p.name ASC`,
    )
    .all() as Array<Record<string, unknown>>;

  const packStmt = db.prepare('SELECT * FROM product_packagings WHERE product_id = ? ORDER BY conversion_factor DESC');
  const priceStmt = db.prepare(
    `SELECT pp.*, pl.code AS price_list_code, pl.label AS price_list_label
     FROM product_prices pp
     JOIN price_lists pl ON pl.id = pp.price_list_id
     WHERE pp.product_id = ?`,
  );

  const enriched = products.map((p) => ({
    ...p,
    packagings: packStmt.all(p.id as number),
    prices: priceStmt.all(p.id as number),
  }));

  res.json(enriched);
});

coreRouter.post('/products', requirePermission('catalog_edit'), (req: AuthedRequest, res) => {
  try {
    const body = req.body as {
      sku: string;
      name: string;
      description?: string;
      category_id: number;
      brand_id: number;
      unit_id: number;
      barcode?: string;
      purchase_cost_xof: number;
      min_threshold: number;
      safety_stock: number;
      track_batches?: number;
      packaging_deposit_id?: number | null;
      default_supplier_id?: number | null;
      is_favorite?: number;
      initial_stock?: number;
      packagings: Array<{
        name: string;
        conversion_factor: number;
        is_default_sale: number;
        apply_deposit: number;
        prices: Record<number, number>; // price_list_id -> price_xof
      }>;
    };

    if (!body.sku?.trim() || !body.name?.trim()) {
      res.status(400).json({ error: 'Référence SKU et désignation obligatoires.' });
      return;
    }
    if (!body.packagings || body.packagings.length === 0) {
      res.status(400).json({ error: 'Définissez au moins un conditionnement (ex. Bouteille ou Casier).' });
      return;
    }

    const cost = toIntXof(body.purchase_cost_xof, 'prix d’achat');
    const minT = toIntXof(body.min_threshold ?? 0, 'seuil minimum');
    const safety = toIntXof(body.safety_stock ?? 0, 'stock de sécurité');
    const initStock = toIntXof(body.initial_stock ?? 0, 'stock initial');
    if (cost < 0 || minT < 0 || safety < 0 || initStock < 0) {
      res.status(400).json({ error: 'Les montants et seuils ne peuvent pas être négatifs.' });
      return;
    }

    const productId = runInTransaction((tx) => {
      const now = new Date().toISOString();
      const ins = tx
        .prepare(
          `INSERT INTO products (
            sku, name, description, category_id, brand_id, unit_id, barcode,
            purchase_cost_xof, min_threshold, safety_stock, track_batches,
            packaging_deposit_id, default_supplier_id, is_favorite, active, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(
          body.sku.trim().toUpperCase(),
          body.name.trim(),
          body.description?.trim() ?? '',
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
          now,
        );
      const pid = Number(ins.lastInsertRowid);

      tx.prepare(
        `INSERT INTO product_cost_history (product_id, previous_cost_xof, new_cost_xof, reason, user_id, created_at)
         VALUES (?, ?, ?, 'Création fiche produit', ?, ?)`,
      ).run(pid, cost, cost, req.user!.id, now);

      const plRows = tx.prepare('SELECT id, code FROM price_lists').all() as Array<{ id: number; code: string }>;
      const plCodeById = new Map(plRows.map((pl) => [pl.id, pl.code]));

      for (const pack of body.packagings) {
        const factor = toPositiveInt(pack.conversion_factor, 'facteur de conversion');
        const pIns = tx
          .prepare(
            `INSERT INTO product_packagings (product_id, name, conversion_factor, is_default_sale, is_default_purchase, apply_deposit)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(pid, pack.name.trim(), factor, pack.is_default_sale ? 1 : 0, factor > 1 ? 1 : 0, pack.apply_deposit ? 1 : 0);
        const packId = Number(pIns.lastInsertRowid);

        for (const [listIdStr, priceVal] of Object.entries(pack.prices || {})) {
          const listId = Number(listIdStr);
          const priceXof = toIntXof(priceVal, 'prix de vente');
          tx.prepare(
            'INSERT INTO product_prices (product_id, packaging_id, price_list_id, price_xof) VALUES (?, ?, ?, ?)',
          ).run(pid, packId, listId, priceXof);
          tx.prepare(
            `INSERT INTO product_price_history
             (product_id, packaging_name, conversion_factor, price_list_code, previous_price_xof, new_price_xof, reason, user_id, created_at)
             VALUES (?, ?, ?, ?, NULL, ?, 'Création fiche produit', ?, ?)`,
          ).run(pid, pack.name.trim(), factor, plCodeById.get(listId) || `TARIF_${listId}`, priceXof, req.user!.id, now);
        }
      }

      tx.prepare('INSERT INTO stock_balances (product_id, physical_qty, reserved_qty) VALUES (?, ?, 0)').run(
        pid,
        initStock,
      );
      if (initStock > 0) {
        tx.prepare(
          `INSERT INTO stock_movements (product_id, movement_type, qty_signed, unit_cost_xof, reference_doc, comment, user_id, created_at)
           VALUES (?, 'INITIAL', ?, ?, 'CATALOGUE-INIT', 'Stock initial à la création du produit', ?, ?)`,
        ).run(pid, initStock, cost, req.user!.id, now);
      }

      writeAuditLog(tx, {
        userId: req.user!.id,
        userName: req.user!.full_name,
        action: 'CREATION_PRODUIT',
        entityType: 'PRODUIT',
        entityId: pid,
        details: `Création ${body.sku.trim().toUpperCase()} — ${body.name.trim()} (coût ${cost} FCFA)`,
      });
      return pid;
    });

    res.status(201).json({ id: productId });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

coreRouter.put('/products/:id', requirePermission('catalog_edit'), (req: AuthedRequest, res) => {
  try {
    const productId = Number(req.params.id);
    const body = req.body as {
      name: string;
      description?: string;
      category_id: number;
      brand_id: number;
      unit_id: number;
      barcode?: string;
      purchase_cost_xof: number;
      min_threshold: number;
      safety_stock: number;
      track_batches?: number;
      packaging_deposit_id?: number | null;
      default_supplier_id?: number | null;
      is_favorite?: number;
      packagings?: Array<{
        id?: number;
        name: string;
        conversion_factor: number;
        is_default_sale: number;
        apply_deposit: number;
        prices: Record<number, number>;
      }>;
    };

    const cost = toIntXof(body.purchase_cost_xof, 'prix d’achat');
    const minT = toIntXof(body.min_threshold ?? 0, 'seuil minimum');
    const safety = toIntXof(body.safety_stock ?? 0, 'stock de sécurité');

    runInTransaction((tx) => {
      const existing = tx.prepare('SELECT id, purchase_cost_xof, name FROM products WHERE id = ?').get(productId) as
        | { id: number; purchase_cost_xof: number; name: string }
        | undefined;
      if (!existing) throw new Error('Produit introuvable.');

      if (existing.purchase_cost_xof !== cost) {
        tx.prepare(
          `INSERT INTO product_cost_history (product_id, previous_cost_xof, new_cost_xof, reason, user_id, created_at)
           VALUES (?, ?, ?, 'Modification fiche produit', ?, ?)`,
        ).run(productId, existing.purchase_cost_xof, cost, req.user!.id, new Date().toISOString());
      }

      tx.prepare(
        `UPDATE products
         SET name = ?, description = ?, category_id = ?, brand_id = ?, unit_id = ?, barcode = ?,
             purchase_cost_xof = ?, min_threshold = ?, safety_stock = ?, track_batches = ?,
             packaging_deposit_id = ?, default_supplier_id = ?, is_favorite = ?
         WHERE id = ?`,
      ).run(
        body.name.trim(),
        body.description?.trim() ?? '',
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
        productId,
      );

      if (body.packagings && body.packagings.length > 0) {
        const now = new Date().toISOString();
        const prevPriceRows = tx
          .prepare(
            `SELECT pk.conversion_factor, pl.code AS price_list_code, pp.price_xof
             FROM product_prices pp
             JOIN product_packagings pk ON pk.id = pp.packaging_id
             JOIN price_lists pl ON pl.id = pp.price_list_id
             WHERE pp.product_id = ?`,
          )
          .all(productId) as Array<{ conversion_factor: number; price_list_code: string; price_xof: number }>;

        const prevPriceMap = new Map<string, number>();
        for (const r of prevPriceRows) {
          prevPriceMap.set(`${r.conversion_factor}:${r.price_list_code}`, r.price_xof);
        }

        const plRows = tx.prepare('SELECT id, code FROM price_lists').all() as Array<{ id: number; code: string }>;
        const plCodeById = new Map(plRows.map((pl) => [pl.id, pl.code]));

        tx.prepare('DELETE FROM product_prices WHERE product_id = ?').run(productId);
        tx.prepare('DELETE FROM product_packagings WHERE product_id = ?').run(productId);
        for (const pack of body.packagings) {
          const factor = toPositiveInt(pack.conversion_factor, 'facteur de conversion');
          const pIns = tx
            .prepare(
              `INSERT INTO product_packagings (product_id, name, conversion_factor, is_default_sale, is_default_purchase, apply_deposit)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              productId,
              pack.name.trim(),
              factor,
              pack.is_default_sale ? 1 : 0,
              factor > 1 ? 1 : 0,
              pack.apply_deposit ? 1 : 0,
            );
          const packId = Number(pIns.lastInsertRowid);
          for (const [listIdStr, priceVal] of Object.entries(pack.prices || {})) {
            const listId = Number(listIdStr);
            const listCode = plCodeById.get(listId) || `TARIF_${listId}`;
            const nextPrice = toIntXof(priceVal, 'tarif');
            tx.prepare(
              'INSERT INTO product_prices (product_id, packaging_id, price_list_id, price_xof) VALUES (?, ?, ?, ?)',
            ).run(productId, packId, listId, nextPrice);

            const prevPrice = prevPriceMap.get(`${factor}:${listCode}`);
            if (prevPrice === undefined || prevPrice !== nextPrice) {
              tx.prepare(
                `INSERT INTO product_price_history
                 (product_id, packaging_name, conversion_factor, price_list_code, previous_price_xof, new_price_xof, reason, user_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'Modification fiche produit', ?, ?)`,
              ).run(
                productId,
                pack.name.trim(),
                factor,
                listCode,
                prevPrice ?? null,
                nextPrice,
                req.user!.id,
                now,
              );
            }
          }
        }
      }

      writeAuditLog(tx, {
        userId: req.user!.id,
        userName: req.user!.full_name,
        action: 'MODIFICATION_PRODUIT',
        entityType: 'PRODUIT',
        entityId: productId,
        details: `Mise à jour ${body.name.trim()} (coût courant ${cost} FCFA)`,
      });
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

coreRouter.get('/products/:id/price-history', requireAuth, (req, res) => {
  const db = getDb();
  const productId = Number(req.params.id);
  const product = db
    .prepare(
      `SELECT p.id, p.sku, p.name, p.purchase_cost_xof, p.min_threshold, p.safety_stock, p.created_at,
              c.name AS category_name, b.name AS brand_name, u.code AS unit_code, u.label AS unit_label
       FROM products p
       JOIN categories c ON c.id = p.category_id
       JOIN brands b ON b.id = p.brand_id
       JOIN units u ON u.id = p.unit_id
       WHERE p.id = ?`,
    )
    .get(productId) as
    | {
        id: number;
        sku: string;
        name: string;
        purchase_cost_xof: number;
        min_threshold: number;
        safety_stock: number;
        created_at: string;
        category_name: string;
        brand_name: string;
        unit_code: string;
        unit_label: string;
      }
    | undefined;

  if (!product) {
    res.status(404).json({ error: 'Produit introuvable.' });
    return;
  }

  const currentPackagings = db
    .prepare('SELECT * FROM product_packagings WHERE product_id = ? ORDER BY conversion_factor ASC')
    .all(productId) as Array<{ id: number; name: string; conversion_factor: number }>;

  const currentPrices = db
    .prepare(
      `SELECT pp.price_xof, pp.packaging_id, pl.code AS price_list_code, pl.label AS price_list_label,
              pk.name AS packaging_name, pk.conversion_factor
       FROM product_prices pp
       JOIN price_lists pl ON pl.id = pp.price_list_id
       JOIN product_packagings pk ON pk.id = pp.packaging_id
       WHERE pp.product_id = ?
       ORDER BY pk.conversion_factor ASC, pl.id ASC`,
    )
    .all(productId) as Array<{
    price_xof: number;
    packaging_id: number;
    price_list_code: string;
    price_list_label: string;
    packaging_name: string;
    conversion_factor: number;
  }>;

  const costHistory = db
    .prepare(
      `SELECT id, previous_cost_xof, new_cost_xof, reason, created_at
       FROM product_cost_history
       WHERE product_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(productId) as Array<{
    id: number;
    previous_cost_xof: number;
    new_cost_xof: number;
    reason: string;
    created_at: string;
  }>;

  const priceHistory = db
    .prepare(
      `SELECT id, packaging_name, conversion_factor, price_list_code, previous_price_xof, new_price_xof, reason, created_at
       FROM product_price_history
       WHERE product_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(productId) as Array<{
    id: number;
    packaging_name: string;
    conversion_factor: number;
    price_list_code: string;
    previous_price_xof: number | null;
    new_price_xof: number;
    reason: string;
    created_at: string;
  }>;

  const purchaseEvents = db
    .prepare(
      `SELECT pol.id, po.po_number AS doc_number, s.name AS party_name,
              pol.packaging_name, pol.conversion_factor, pol.qty_ordered AS qty,
              pol.unit_cost_xof, po.created_at
       FROM purchase_order_lines pol
       JOIN purchase_orders po ON po.id = pol.po_id
       JOIN suppliers s ON s.id = po.supplier_id
       WHERE pol.product_id = ? AND po.status != 'ANNULEE'
       ORDER BY po.created_at ASC, pol.id ASC`,
    )
    .all(productId) as Array<{
    id: number;
    doc_number: string;
    party_name: string;
    packaging_name: string;
    conversion_factor: number;
    qty: number;
    unit_cost_xof: number;
    created_at: string;
  }>;

  const saleEvents = db
    .prepare(
      `SELECT sl.id, sa.sale_number AS doc_number, cu.name AS party_name,
              sl.packaging_name, sl.conversion_factor, sl.qty,
              sl.unit_price_xof, pl.code AS price_list_code, sa.created_at
       FROM sale_lines sl
       JOIN sales sa ON sa.id = sl.sale_id
       JOIN customers cu ON cu.id = sa.customer_id
       JOIN price_lists pl ON pl.id = sa.price_list_id
       WHERE sl.product_id = ? AND sa.status != 'ANNULEE'
       ORDER BY sa.created_at ASC, sl.id ASC
       LIMIT 120`,
    )
    .all(productId) as Array<{
    id: number;
    doc_number: string;
    party_name: string;
    packaging_name: string;
    conversion_factor: number;
    qty: number;
    unit_price_xof: number;
    price_list_code: string;
    created_at: string;
  }>;

  type RawEvent = {
    id: string;
    created_at: string;
    kind: 'ACHAT_CUMP' | 'ACHAT_BON' | 'VENTE_TARIF_DETAIL' | 'VENTE_TARIF_GROS' | 'VENTE_TARIF_REVENDEUR' | 'VENTE_CLIENT';
    kind_label: string;
    packaging_name: string;
    conversion_factor: number;
    previous_xof: number | null;
    new_xof: number;
    unit_normalized_xof: number;
    details: string;
  };

  const events: RawEvent[] = [];

  for (const ch of costHistory) {
    events.push({
      id: `ch-${ch.id}`,
      created_at: ch.created_at,
      kind: 'ACHAT_CUMP',
      kind_label: 'Coût achat / CUMP (Unité)',
      packaging_name: product.unit_label,
      conversion_factor: 1,
      previous_xof: ch.previous_cost_xof,
      new_xof: ch.new_cost_xof,
      unit_normalized_xof: ch.new_cost_xof,
      details: ch.reason,
    });
  }

  for (const ph of priceHistory) {
    const unitNorm = Math.round(ph.new_price_xof / Math.max(1, ph.conversion_factor));
    const kind =
      ph.price_list_code === 'GROS'
        ? 'VENTE_TARIF_GROS'
        : ph.price_list_code === 'REVENDEUR'
          ? 'VENTE_TARIF_REVENDEUR'
          : 'VENTE_TARIF_DETAIL';
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
      details: `${ph.reason} (${ph.packaging_name})`,
    });
  }

  for (const pe of purchaseEvents) {
    const unitNorm = Math.round(pe.unit_cost_xof / Math.max(1, pe.conversion_factor));
    events.push({
      id: `po-${pe.id}`,
      created_at: pe.created_at,
      kind: 'ACHAT_BON',
      kind_label: 'Achat fournisseur',
      packaging_name: pe.packaging_name,
      conversion_factor: pe.conversion_factor,
      previous_xof: null,
      new_xof: pe.unit_cost_xof,
      unit_normalized_xof: unitNorm,
      details: `${pe.doc_number} · ${pe.party_name} (${pe.qty} × ${pe.packaging_name})`,
    });
  }

  for (const se of saleEvents) {
    const unitNorm = Math.round(se.unit_price_xof / Math.max(1, se.conversion_factor));
    events.push({
      id: `sl-${se.id}`,
      created_at: se.created_at,
      kind: 'VENTE_CLIENT',
      kind_label: `Vente (${se.price_list_code})`,
      packaging_name: se.packaging_name,
      conversion_factor: se.conversion_factor,
      previous_xof: null,
      new_xof: se.unit_price_xof,
      unit_normalized_xof: unitNorm,
      details: `${se.doc_number} · ${se.party_name} (${se.qty} × ${se.packaging_name})`,
    });
  }

  events.sort((a, b) => a.created_at.localeCompare(b.created_at));

  // Build normalized per-base-unit evolution curve
  const curUnitDetail =
    currentPrices.find((p) => p.price_list_code === 'DETAIL' && p.conversion_factor === 1)?.price_xof ??
    Math.round(
      (currentPrices.find((p) => p.price_list_code === 'DETAIL')?.price_xof ?? 0) /
        Math.max(1, currentPrices.find((p) => p.price_list_code === 'DETAIL')?.conversion_factor ?? 1),
    );
  const curUnitGros =
    currentPrices.find((p) => p.price_list_code === 'GROS' && p.conversion_factor === 1)?.price_xof ??
    Math.round(
      (currentPrices.find((p) => p.price_list_code === 'GROS')?.price_xof ?? 0) /
        Math.max(1, currentPrices.find((p) => p.price_list_code === 'GROS')?.conversion_factor ?? 1),
    );

  let runningCost = costHistory[0]?.previous_cost_xof ?? product.purchase_cost_xof;
  let runningDetail =
    priceHistory.find((p) => p.price_list_code === 'DETAIL' && p.conversion_factor === 1)?.new_price_xof ??
    curUnitDetail;
  let runningGros =
    priceHistory.find((p) => p.price_list_code === 'GROS' && p.conversion_factor === 1)?.new_price_xof ??
    curUnitGros;

  const chartPoints: Array<{
    date: string;
    label: string;
    purchase_cost_xof: number;
    sale_detail_xof: number;
    sale_gros_xof: number;
    note: string;
  }> = [];

  for (const ev of events) {
    if (ev.kind === 'ACHAT_CUMP' || ev.kind === 'ACHAT_BON') {
      runningCost = ev.unit_normalized_xof;
    } else if (ev.kind === 'VENTE_TARIF_DETAIL') {
      if (ev.conversion_factor === 1 || runningDetail === 0) {
        runningDetail = ev.unit_normalized_xof;
      }
    } else if (ev.kind === 'VENTE_TARIF_GROS') {
      if (ev.conversion_factor === 1 || runningGros === 0) {
        runningGros = ev.unit_normalized_xof;
      }
    } else if (ev.kind === 'VENTE_CLIENT') {
      if (ev.details.includes('DETAIL') || ev.kind_label.includes('DETAIL')) {
        runningDetail = ev.unit_normalized_xof;
      } else if (ev.kind_label.includes('GROS')) {
        runningGros = ev.unit_normalized_xof;
      }
    }

    const dayKey = ev.created_at.slice(0, 10);
    const label = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short' }).format(new Date(ev.created_at));
    const existingIdx = chartPoints.findIndex((pt) => pt.date === dayKey);
    const point = {
      date: dayKey,
      label,
      purchase_cost_xof: runningCost,
      sale_detail_xof: runningDetail,
      sale_gros_xof: runningGros,
      note: `${ev.kind_label} · ${ev.details}`,
    };
    if (existingIdx >= 0) {
      chartPoints[existingIdx] = point;
    } else {
      chartPoints.push(point);
    }
  }

  // Ensure current live state is always represented as the latest point
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayPoint = {
    date: todayKey,
    label: 'Actuel',
    purchase_cost_xof: product.purchase_cost_xof,
    sale_detail_xof: curUnitDetail,
    sale_gros_xof: curUnitGros,
    note: 'Tarifs et coût CUMP actuels du catalogue',
  };
  if (chartPoints.length === 0) {
    chartPoints.push(todayPoint);
  } else {
    const last = chartPoints[chartPoints.length - 1];
    if (
      last.purchase_cost_xof !== todayPoint.purchase_cost_xof ||
      last.sale_detail_xof !== todayPoint.sale_detail_xof ||
      last.sale_gros_xof !== todayPoint.sale_gros_xof
    ) {
      chartPoints.push(todayPoint);
    }
  }

  res.json({
    product,
    currentPackagings,
    currentPrices,
    events: [...events].reverse(), // Most recent first for table
    chartPoints,
  });
});

coreRouter.patch('/products/:id/archive', requirePermission('catalog_edit'), (req: AuthedRequest, res) => {
  const db = getDb();
  const productId = Number(req.params.id);
  const { active } = req.body as { active: number };
  db.prepare('UPDATE products SET active = ? WHERE id = ?').run(active ? 1 : 0, productId);
  writeAuditLog(db, {
    userId: req.user!.id,
    userName: req.user!.full_name,
    action: active ? 'REACTIVATION_PRODUIT' : 'ARCHIVAGE_PRODUIT',
    entityType: 'PRODUIT',
    entityId: productId,
    details: active ? 'Produit réactivé' : 'Produit archivé (historique conservé)',
  });
  res.json({ ok: true });
});

coreRouter.post('/products/import', requirePermission('catalog_edit'), (req: AuthedRequest, res) => {
  try {
    const { rows } = req.body as {
      rows: Array<{
        sku: string;
        name: string;
        category: string;
        brand: string;
        purchase_cost_xof: number;
        pack_name: string;
        factor: number;
        price_detail_xof: number;
        price_gros_xof: number;
      }>;
    };
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({ error: 'Aucune ligne valide à importer.' });
      return;
    }

    let createdCount = 0;
    let skippedCount = 0;
    runInTransaction((tx) => {
      const now = new Date().toISOString();
      let defaultUnit = tx.prepare('SELECT id FROM units ORDER BY id ASC LIMIT 1').get() as { id: number } | undefined;
      if (!defaultUnit) {
        const uIns = tx.prepare("INSERT INTO units (code, label) VALUES ('PCS', 'Pièce')").run();
        defaultUnit = { id: Number(uIns.lastInsertRowid) };
      }
      const plDetail = (tx.prepare("SELECT id FROM price_lists WHERE code = 'DETAIL'").get() as { id: number } | undefined)?.id
        ?? (tx.prepare('SELECT id FROM price_lists ORDER BY id ASC LIMIT 1').get() as { id: number }).id;
      const plGros = (tx.prepare("SELECT id FROM price_lists WHERE code = 'GROS'").get() as { id: number } | undefined)?.id ?? plDetail;

      for (const r of rows) {
        const sku = String(r.sku || '').trim().toUpperCase();
        const name = String(r.name || '').trim();
        if (!sku || !name) {
          skippedCount++;
          continue;
        }
        const exists = tx.prepare('SELECT id FROM products WHERE sku = ?').get(sku);
        if (exists) {
          skippedCount++;
          continue;
        }

        const catName = String(r.category || '').trim() || 'Général';
        let cat = tx.prepare('SELECT id FROM categories WHERE name = ?').get(catName) as
          | { id: number }
          | undefined;
        if (!cat) {
          const cRes = tx.prepare('INSERT INTO categories (name) VALUES (?)').run(catName);
          cat = { id: Number(cRes.lastInsertRowid) };
        }
        const brandName = String(r.brand || '').trim() || 'Générique';
        let brand = tx.prepare('SELECT id FROM brands WHERE name = ?').get(brandName) as
          | { id: number }
          | undefined;
        if (!brand) {
          const bRes = tx.prepare('INSERT INTO brands (name) VALUES (?)').run(brandName);
          brand = { id: Number(bRes.lastInsertRowid) };
        }

        const cost = Math.max(0, Math.round(Number(r.purchase_cost_xof) || 0));
        const factor = Math.max(1, Math.round(Number(r.factor) || 1));

        const pIns = tx
          .prepare(
            `INSERT INTO products (sku, name, category_id, brand_id, unit_id, purchase_cost_xof, min_threshold, safety_stock, active, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, 0, 1, ?)`,
          )
          .run(sku, name, cat.id, brand.id, defaultUnit.id, cost, now);
        const pid = Number(pIns.lastInsertRowid);

        const packName = String(r.pack_name || '').trim() || (factor > 1 ? `Lot ×${factor}` : 'Unité');
        const pkIns = tx
          .prepare(
            `INSERT INTO product_packagings (product_id, name, conversion_factor, is_default_sale, is_default_purchase, apply_deposit)
             VALUES (?, ?, ?, 1, 1, 0)`,
          )
          .run(pid, packName, factor);
        const pkId = Number(pkIns.lastInsertRowid);

        const detailPrice = Math.max(0, Math.round(Number(r.price_detail_xof) || 0));
        const grosPrice = Math.max(0, Math.round(Number(r.price_gros_xof) || 0));

        tx.prepare('INSERT INTO product_prices (product_id, packaging_id, price_list_id, price_xof) VALUES (?, ?, ?, ?)').run(
          pid,
          pkId,
          plDetail,
          detailPrice,
        );
        if (plGros !== plDetail) {
          tx.prepare('INSERT INTO product_prices (product_id, packaging_id, price_list_id, price_xof) VALUES (?, ?, ?, ?)').run(
            pid,
            pkId,
            plGros,
            grosPrice,
          );
        }
        tx.prepare(
          `INSERT INTO product_cost_history (product_id, previous_cost_xof, new_cost_xof, reason, user_id, created_at)
           VALUES (?, ?, ?, 'Import CSV catalogue', ?, ?)`,
        ).run(pid, cost, cost, req.user!.id, now);
        tx.prepare(
          `INSERT INTO product_price_history
           (product_id, packaging_name, conversion_factor, price_list_code, previous_price_xof, new_price_xof, reason, user_id, created_at)
           VALUES (?, ?, ?, 'DETAIL', NULL, ?, 'Import CSV catalogue', ?, ?)`,
        ).run(pid, packName, factor, detailPrice, req.user!.id, now);
        tx.prepare(
          `INSERT INTO product_price_history
           (product_id, packaging_name, conversion_factor, price_list_code, previous_price_xof, new_price_xof, reason, user_id, created_at)
           VALUES (?, ?, ?, 'GROS', NULL, ?, 'Import CSV catalogue', ?, ?)`,
        ).run(pid, packName, factor, grosPrice, req.user!.id, now);

        tx.prepare('INSERT INTO stock_balances (product_id, physical_qty, reserved_qty) VALUES (?, 0, 0)').run(pid);
        createdCount++;
      }

      writeAuditLog(tx, {
        userId: req.user!.id,
        userName: req.user!.full_name,
        action: 'IMPORT_CATALOGUE',
        entityType: 'PRODUIT',
        details: `Import catalogue : ${createdCount} créé(s), ${skippedCount} ignoré(s)`,
      });
    });

    res.json({ createdCount, skippedCount });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ==================== STOCKS & MOUVEMENTS ====================

coreRouter.get('/stock', requirePermission('stock'), (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
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
       ORDER BY p.name ASC`,
    )
    .all();
  const batches = db
    .prepare(
      `SELECT pb.*, p.sku, p.name AS product_name
       FROM product_batches pb
       JOIN products p ON p.id = pb.product_id
       WHERE pb.qty_remaining > 0
       ORDER BY pb.expiry_date ASC`,
    )
    .all();
  res.json({ stock: rows, batches });
});

coreRouter.get('/stock/movements', requirePermission('stock'), (req, res) => {
  const db = getDb();
  const productId = req.query.productId ? Number(req.query.productId) : null;
  const rows = db
    .prepare(
      `SELECT sm.*, p.sku, p.name AS product_name, u.full_name AS user_name
       FROM stock_movements sm
       JOIN products p ON p.id = sm.product_id
       LEFT JOIN users u ON u.id = sm.user_id
       ${productId ? 'WHERE sm.product_id = ?' : ''}
       ORDER BY sm.id DESC
       LIMIT 300`,
    )
    .all(...(productId ? [productId] : []));
  res.json(rows);
});

coreRouter.post('/stock/adjust', requirePermission('stock_adjust'), (req: AuthedRequest, res) => {
  try {
    const { product_id, movement_type, qty, comment } = req.body as {
      product_id: number;
      movement_type: 'CASSE' | 'PERTE' | 'PEREMPTION' | 'AJUSTEMENT_ENTREE';
      qty: number;
      comment: string;
    };
    const positiveQty = toPositiveInt(qty, 'quantité');
    if (!comment?.trim()) {
      res.status(400).json({ error: 'Un motif explicite est obligatoire pour tout ajustement de stock.' });
      return;
    }

    const signed = movement_type === 'AJUSTEMENT_ENTREE' ? positiveQty : -positiveQty;

    runInTransaction((tx) => {
      const prod = tx
        .prepare(
          `SELECT p.id, p.name, p.purchase_cost_xof, sb.physical_qty
           FROM products p JOIN stock_balances sb ON sb.product_id = p.id
           WHERE p.id = ?`,
        )
        .get(product_id) as { id: number; name: string; purchase_cost_xof: number; physical_qty: number } | undefined;
      if (!prod) throw new Error('Produit introuvable.');
      if (prod.physical_qty + signed < 0) {
        throw new Error(`Stock physique insuffisant (${prod.physical_qty} disponible).`);
      }

      const now = new Date().toISOString();
      tx.prepare('UPDATE stock_balances SET physical_qty = physical_qty + ? WHERE product_id = ?').run(
        signed,
        product_id,
      );
      tx.prepare(
        `INSERT INTO stock_movements (product_id, movement_type, qty_signed, unit_cost_xof, reference_doc, comment, user_id, created_at)
         VALUES (?, ?, ?, ?, 'AJUST-MANUEL', ?, ?, ?)`,
      ).run(product_id, movement_type, signed, prod.purchase_cost_xof, comment.trim(), req.user!.id, now);

      writeAuditLog(tx, {
        userId: req.user!.id,
        userName: req.user!.full_name,
        action: `AJUSTEMENT_STOCK_${movement_type}`,
        entityType: 'STOCK',
        entityId: product_id,
        details: `${prod.name} : ${signed > 0 ? '+' : ''}${signed} unité(s) — ${comment.trim()}`,
      });
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

coreRouter.get('/stock/reconcile', requirePermission('stock'), (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT p.id, p.sku, p.name,
              COALESCE(sb.physical_qty, 0) AS balance_qty,
              COALESCE((SELECT SUM(sm.qty_signed) FROM stock_movements sm WHERE sm.product_id = p.id), 0) AS ledger_sum_qty
       FROM products p
       LEFT JOIN stock_balances sb ON sb.product_id = p.id
       ORDER BY p.name ASC`,
    )
    .all() as Array<{ id: number; sku: string; name: string; balance_qty: number; ledger_sum_qty: number }>;

  const discrepancies = rows.filter((r) => r.balance_qty !== r.ledger_sum_qty);
  res.json({ totalChecked: rows.length, discrepanciesCount: discrepancies.length, rows });
});

// ==================== CONSIGNES & EMBALLAGES ====================

coreRouter.get('/deposits', requirePermission('deposits'), (_req, res) => {
  const db = getDb();
  const packagingTypes = db.prepare('SELECT * FROM returnable_packaging WHERE active = 1 ORDER BY code').all();

  const customerBalances = db
    .prepare(
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
       ORDER BY c.name ASC`,
    )
    .all();

  const supplierBalances = db
    .prepare(
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
       ORDER BY s.name ASC`,
    )
    .all();

  const movements = db
    .prepare(
      `SELECT dm.*, rp.code AS packaging_code, rp.label AS packaging_label,
              CASE WHEN dm.party_type = 'CLIENT' THEN (SELECT name FROM customers WHERE id = dm.party_id)
                   WHEN dm.party_type = 'FOURNISSEUR' THEN (SELECT name FROM suppliers WHERE id = dm.party_id)
                   ELSE 'Dépôt interne' END AS party_name,
              u.full_name AS user_name
       FROM deposit_movements dm
       JOIN returnable_packaging rp ON rp.id = dm.packaging_id
       LEFT JOIN users u ON u.id = dm.user_id
       ORDER BY dm.id DESC
       LIMIT 200`,
    )
    .all();

  res.json({ packagingTypes, customerBalances, supplierBalances, movements });
});

coreRouter.post('/deposits/record', requirePermission('deposits'), (req: AuthedRequest, res) => {
  try {
    const { party_type, party_id, packaging_id, movement_kind, qty, payment_method, comment } = req.body as {
      party_type: 'CLIENT' | 'FOURNISSEUR' | 'INTERNE';
      party_id: number;
      packaging_id: number;
      movement_kind: 'REMISE_CLIENT' | 'RETOUR_CLIENT' | 'RECU_FOURNISSEUR' | 'RENDU_FOURNISSEUR' | 'CASSE_PERTE';
      qty: number;
      payment_method?: string;
      comment?: string;
    };

    const posQty = toPositiveInt(qty, 'quantité d’emballages');

    runInTransaction((tx) => {
      const pkg = tx
        .prepare('SELECT id, label, deposit_value_xof FROM returnable_packaging WHERE id = ?')
        .get(packaging_id) as { id: number; label: string; deposit_value_xof: number } | undefined;
      if (!pkg) throw new Error('Type d’emballage introuvable.');

      const qtySigned =
        movement_kind === 'RETOUR_CLIENT' || movement_kind === 'RENDU_FOURNISSEUR' ? -posQty : posQty;
      const amountXof = qtySigned * pkg.deposit_value_xof;
      const now = new Date().toISOString();
      const payMethod = payment_method || 'ESPECES';

      tx.prepare(
        `INSERT INTO deposit_movements (
          party_type, party_id, packaging_id, movement_kind, qty_signed, amount_xof,
          payment_method, reference_doc, comment, user_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'CONSIGNE-MAN', ?, ?, ?)`,
      ).run(
        party_type,
        party_id || 0,
        packaging_id,
        movement_kind,
        qtySigned,
        amountXof,
        payMethod,
        comment?.trim() || pkg.label,
        req.user!.id,
        now,
      );

      // Update cash session / movements if cash deposit collected or refunded with a client
      if (party_type === 'CLIENT' && (movement_kind === 'REMISE_CLIENT' || movement_kind === 'RETOUR_CLIENT')) {
        const openSess = tx
          .prepare("SELECT id FROM cash_sessions WHERE status = 'OUVERTE' ORDER BY id DESC LIMIT 1")
          .get() as { id: number } | undefined;

        const cashMoveType =
          movement_kind === 'REMISE_CLIENT' ? 'CONSIGNE_ENCAISSEMENT' : 'CONSIGNE_REMBOURSEMENT';
        tx.prepare(
          `INSERT INTO cash_movements (session_id, movement_type, payment_method, amount_signed_xof, reference_doc, comment, user_id, created_at)
           VALUES (?, ?, ?, ?, 'CONSIGNE', ?, ?, ?)`,
        ).run(
          openSess?.id ?? null,
          cashMoveType,
          payMethod,
          amountXof,
          `${movement_kind} (${posQty} x ${pkg.label})`,
          req.user!.id,
          now,
        );

        if (openSess && payMethod === 'ESPECES') {
          tx.prepare('UPDATE cash_sessions SET theoretical_cash_xof = theoretical_cash_xof + ? WHERE id = ?').run(
            amountXof,
            openSess.id,
          );
        }
      }

      writeAuditLog(tx, {
        userId: req.user!.id,
        userName: req.user!.full_name,
        action: `CONSIGNE_${movement_kind}`,
        entityType: 'CONSIGNE',
        entityId: packaging_id,
        details: `${movement_kind} : ${posQty} × ${pkg.label} (${amountXof} FCFA)`,
      });
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
