import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BACKUPS_DIR,
  DB_PATH,
  closeDb,
  createSqliteBackup,
  getAutoBackupMirrorDir,
  getDb,
  hashSecret,
  nextDocumentNumber,
  runInTransaction,
  writeAuditLog,
} from './db.ts';
import {
  type AuthedRequest,
  requireAuth,
  requirePermission,
  toIntXof,
  toPositiveInt,
  verifySupervisorCredentials,
} from './middleware.ts';
import type { UserRole } from './rbac.ts';

export const opsRouter = Router();

// ==================== FOURNISSEURS & ACHATS ====================

opsRouter.get('/suppliers', requirePermission('suppliers'), (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.*,
              COALESCE((SELECT SUM(po.total_xof) FROM purchase_orders po WHERE po.supplier_id = s.id AND po.status IN ('CONFIRMEE', 'PARTIELLE', 'RECUE')), 0) AS total_purchased_xof,
              COALESCE((SELECT SUM(po.paid_xof) FROM purchase_orders po WHERE po.supplier_id = s.id AND po.status IN ('CONFIRMEE', 'PARTIELLE', 'RECUE')), 0) AS total_paid_xof,
              COALESCE((SELECT SUM(MAX(0, po.total_xof - po.paid_xof)) FROM purchase_orders po WHERE po.supplier_id = s.id AND po.status IN ('CONFIRMEE', 'PARTIELLE', 'RECUE')), 0) AS balance_due_xof
       FROM suppliers s
       WHERE s.active = 1
       ORDER BY s.name ASC`,
    )
    .all();
  res.json(rows);
});

opsRouter.post('/suppliers', requirePermission('suppliers'), (req: AuthedRequest, res) => {
  try {
    const { name, contact_name, phone, address, payment_terms, lead_time_days } = req.body as {
      name: string;
      contact_name?: string;
      phone?: string;
      address?: string;
      payment_terms?: string;
      lead_time_days?: number;
    };
    if (!name?.trim()) throw new Error('Raison sociale obligatoire.');
    const db = getDb();
    const cnt = (db.prepare('SELECT COUNT(*) as c FROM suppliers').get() as { c: number }).c;
    const code = `FRN-${String(cnt + 1).padStart(3, '0')}`;
    const ins = db
      .prepare(
        `INSERT INTO suppliers (code, name, contact_name, phone, address, payment_terms, lead_time_days, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        code,
        name.trim(),
        contact_name?.trim() ?? '',
        phone?.trim() ?? '',
        address?.trim() ?? '',
        payment_terms?.trim() || 'Comptant',
        Math.max(1, Number(lead_time_days) || 2),
        new Date().toISOString(),
      );
    res.status(201).json({ id: Number(ins.lastInsertRowid), code });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

opsRouter.post('/suppliers/payments', requirePermission('suppliers'), (req: AuthedRequest, res) => {
  try {
    const { supplier_id, po_id, amount_xof, payment_method, reference_note } = req.body as {
      supplier_id: number;
      po_id?: number;
      amount_xof: number;
      payment_method: string;
      reference_note?: string;
    };
    const amount = toPositiveInt(amount_xof, 'montant payé');
    const out = runInTransaction((tx) => {
      const now = new Date().toISOString();
      const payNum = nextDocumentNumber(tx, 'PAY');
      tx.prepare(
        `INSERT INTO supplier_payments (payment_number, supplier_id, po_id, amount_xof, payment_method, reference_note, user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(payNum, supplier_id, po_id || null, amount, payment_method || 'ESPECES', reference_note?.trim() ?? '', req.user!.id, now);

      if (po_id) {
        tx.prepare('UPDATE purchase_orders SET paid_xof = paid_xof + ? WHERE id = ?').run(amount, po_id);
      } else {
        // Allocate across open POs
        const openPOs = tx
          .prepare(
            `SELECT id, total_xof, paid_xof FROM purchase_orders WHERE supplier_id = ? AND status IN ('CONFIRMEE', 'PARTIELLE', 'RECUE') AND total_xof > paid_xof ORDER BY id ASC`,
          )
          .all(supplier_id) as Array<{ id: number; total_xof: number; paid_xof: number }>;
        let rem = amount;
        for (const po of openPOs) {
          if (rem <= 0) break;
          const alloc = Math.min(rem, po.total_xof - po.paid_xof);
          tx.prepare('UPDATE purchase_orders SET paid_xof = paid_xof + ? WHERE id = ?').run(alloc, po.id);
          rem -= alloc;
        }
      }

      const openSess = tx
        .prepare("SELECT id FROM cash_sessions WHERE status = 'OUVERTE' ORDER BY id DESC LIMIT 1")
        .get() as { id: number } | undefined;
      tx.prepare(
        `INSERT INTO cash_movements (session_id, movement_type, payment_method, amount_signed_xof, reference_doc, comment, user_id, created_at)
         VALUES (?, 'PAIEMENT_FOURNISSEUR', ?, ?, ?, 'Règlement fournisseur', ?, ?)`,
      ).run(openSess?.id ?? null, payment_method || 'ESPECES', -amount, payNum, req.user!.id, now);
      if (openSess && (payment_method || 'ESPECES') === 'ESPECES') {
        tx.prepare('UPDATE cash_sessions SET theoretical_cash_xof = theoretical_cash_xof - ? WHERE id = ?').run(
          amount,
          openSess.id,
        );
      }

      writeAuditLog(tx, {
        userId: req.user!.id,
        userName: req.user!.full_name,
        action: 'REGLEMENT_FOURNISSEUR',
        entityType: 'FOURNISSEUR',
        entityId: supplier_id,
        details: `${payNum} — Règlement ${amount} FCFA (${payment_method || 'ESPECES'})`,
      });
      return { payNum };
    });

    res.status(201).json(out);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

opsRouter.get('/purchases', requirePermission('purchases'), (_req, res) => {
  const db = getDb();
  const pos = db
    .prepare(
      `SELECT po.*, s.name AS supplier_name, u.full_name AS creator_name
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN users u ON u.id = po.user_id
       ORDER BY po.id DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  const lineStmt = db.prepare('SELECT * FROM purchase_order_lines WHERE po_id = ?');
  const recStmt = db.prepare('SELECT * FROM goods_receipts WHERE po_id = ? ORDER BY id DESC');
  res.json(
    pos.map((po) => ({
      ...po,
      lines: lineStmt.all(po.id as number),
      receipts: recStmt.all(po.id as number),
    })),
  );
});

opsRouter.get('/purchases/suggestions', requirePermission('purchases'), (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT p.id, p.sku, p.name, p.min_threshold, p.safety_stock, p.avg_daily_sales, p.purchase_cost_xof,
              s.id AS supplier_id, s.name AS supplier_name, COALESCE(s.lead_time_days, 2) AS lead_time_days,
              (COALESCE(sb.physical_qty, 0) - COALESCE(sb.reserved_qty, 0)) AS available_qty,
              COALESCE((
                SELECT SUM((pol.qty_ordered - pol.qty_received) * pol.conversion_factor)
                FROM purchase_order_lines pol
                JOIN purchase_orders po ON po.id = pol.po_id
                WHERE pol.product_id = p.id AND po.status IN ('CONFIRMEE', 'PARTIELLE')
              ), 0) AS expected_qty,
              COALESCE((SELECT name FROM product_packagings WHERE product_id = p.id AND is_default_purchase = 1 LIMIT 1), 'Unité') AS pack_name,
              COALESCE((SELECT conversion_factor FROM product_packagings WHERE product_id = p.id AND is_default_purchase = 1 LIMIT 1), 1) AS pack_factor
       FROM products p
       LEFT JOIN stock_balances sb ON sb.product_id = p.id
       LEFT JOIN suppliers s ON s.id = p.default_supplier_id
       WHERE p.active = 1 AND (COALESCE(sb.physical_qty, 0) - COALESCE(sb.reserved_qty, 0)) <= p.min_threshold
       ORDER BY available_qty ASC`,
    )
    .all() as Array<{
    id: number;
    sku: string;
    name: string;
    min_threshold: number;
    safety_stock: number;
    avg_daily_sales: number;
    purchase_cost_xof: number;
    supplier_id: number | null;
    supplier_name: string | null;
    lead_time_days: number;
    available_qty: number;
    expected_qty: number;
    pack_name: string;
    pack_factor: number;
  }>;

  const suggestions = rows.map((r) => {
    const demandLead = Math.round(r.avg_daily_sales * (r.lead_time_days + 5));
    const recommendedBase = Math.max(0, demandLead + r.safety_stock - r.available_qty - r.expected_qty);
    const recommendedPacks = Math.max(1, Math.ceil(recommendedBase / Math.max(1, r.pack_factor)));
    return {
      ...r,
      recommended_base_qty: recommendedBase,
      recommended_packs: recommendedPacks,
      estimated_cost_xof: recommendedPacks * r.pack_factor * r.purchase_cost_xof,
    };
  });

  res.json(suggestions);
});

opsRouter.post('/purchases', requirePermission('purchases'), (req: AuthedRequest, res) => {
  try {
    const { supplier_id, expected_date, shipping_fee_xof, notes, lines } = req.body as {
      supplier_id: number;
      expected_date?: string;
      shipping_fee_xof?: number;
      notes?: string;
      lines: Array<{ product_id: number; packaging_id: number; qty_ordered: number; unit_cost_xof: number }>;
    };
    if (!lines || lines.length === 0) throw new Error('Ajoutez au moins une ligne d’achat.');
    const shipping = toIntXof(shipping_fee_xof ?? 0, 'frais d’approche');

    const out = runInTransaction((tx) => {
      const now = new Date().toISOString();
      const poNum = nextDocumentNumber(tx, 'ACH');
      let total = shipping;
      const prepared: Array<{
        product_id: number;
        packaging_id: number;
        product_name: string;
        packaging_name: string;
        factor: number;
        qty: number;
        unit_cost: number;
        line_total: number;
      }> = [];

      for (const l of lines) {
        const qty = toPositiveInt(l.qty_ordered, 'quantité commandée');
        const cost = toIntXof(l.unit_cost_xof, 'coût unitaire');
        const prod = tx.prepare('SELECT id, name FROM products WHERE id = ?').get(l.product_id) as {
          id: number;
          name: string;
        };
        const pack = tx
          .prepare('SELECT id, name, conversion_factor FROM product_packagings WHERE id = ?')
          .get(l.packaging_id) as { id: number; name: string; conversion_factor: number };
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
          line_total: lineTotal,
        });
      }

      const ins = tx
        .prepare(
          `INSERT INTO purchase_orders (po_number, supplier_id, status, expected_date, shipping_fee_xof, total_xof, paid_xof, notes, user_id, created_at)
           VALUES (?, ?, 'CONFIRMEE', ?, ?, ?, 0, ?, ?, ?)`,
        )
        .run(poNum, supplier_id, expected_date || null, shipping, total, notes?.trim() ?? '', req.user!.id, now);
      const poId = Number(ins.lastInsertRowid);

      for (const p of prepared) {
        tx.prepare(
          `INSERT INTO purchase_order_lines (po_id, product_id, packaging_id, product_name, packaging_name, conversion_factor, qty_ordered, qty_received, unit_cost_xof, line_total_xof)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        ).run(poId, p.product_id, p.packaging_id, p.product_name, p.packaging_name, p.factor, p.qty, p.unit_cost, p.line_total);
      }

      writeAuditLog(tx, {
        userId: req.user!.id,
        userName: req.user!.full_name,
        action: 'CREATION_COMMANDE_ACHAT',
        entityType: 'ACHAT',
        entityId: poId,
        details: `${poNum} — Total ${total} FCFA (stock inchangé avant réception)`,
      });

      return { poId, poNumber: poNum };
    });

    res.status(201).json(out);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

opsRouter.post('/purchases/:id/receive', requirePermission('purchases'), (req: AuthedRequest, res) => {
  try {
    const poId = Number(req.params.id);
    const { notes, lines } = req.body as {
      notes?: string;
      lines: Array<{
        po_line_id: number;
        qty_received: number;
        qty_rejected?: number;
        unit_cost_xof?: number;
        batch_number?: string;
        expiry_date?: string;
      }>;
    };
    if (!lines || lines.length === 0) throw new Error('Aucune ligne à réceptionner.');

    const out = runInTransaction((tx) => {
      const po = tx.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId) as
        | { id: number; po_number: string; supplier_id: number; status: string }
        | undefined;
      if (!po) throw new Error('Commande d’achat introuvable.');
      if (po.status === 'RECUE' || po.status === 'ANNULEE') {
        throw new Error('Cette commande est déjà clôturée.');
      }

      const now = new Date().toISOString();
      const recNum = nextDocumentNumber(tx, 'REC');
      let recTotalValue = 0;

      const rIns = tx
        .prepare(
          `INSERT INTO goods_receipts (receipt_number, po_id, supplier_id, total_value_xof, notes, user_id, created_at)
           VALUES (?, ?, ?, 0, ?, ?, ?)`,
        )
        .run(recNum, poId, po.supplier_id, notes?.trim() ?? '', req.user!.id, now);
      const recId = Number(rIns.lastInsertRowid);

      let anyReceived = false;
      for (const rl of lines) {
        const qtyRec = toIntXof(rl.qty_received, 'quantité reçue');
        const qtyRej = toIntXof(rl.qty_rejected ?? 0, 'quantité refusée');
        if (qtyRec < 0 || qtyRej < 0) throw new Error('Quantités reçues/refusées invalides.');
        if (qtyRec === 0 && qtyRej === 0) continue;

        const pol = tx.prepare('SELECT * FROM purchase_order_lines WHERE id = ? AND po_id = ?').get(rl.po_line_id, poId) as
          | {
              id: number;
              product_id: number;
              conversion_factor: number;
              qty_ordered: number;
              qty_received: number;
              unit_cost_xof: number;
            }
          | undefined;
        if (!pol) throw new Error('Ligne d’achat introuvable.');
        if (pol.qty_received + qtyRec > pol.qty_ordered) {
          throw new Error('La quantité reçue dépasse le reliquat commandé.');
        }

        anyReceived = true;
        const packCost = rl.unit_cost_xof !== undefined ? toIntXof(rl.unit_cost_xof, 'coût') : pol.unit_cost_xof;
        const baseCost = Math.round(packCost / Math.max(1, pol.conversion_factor));
        const baseQtyRec = qtyRec * pol.conversion_factor;
        recTotalValue += qtyRec * packCost;

        // CUMP update: weighted average cost on base units
        const prod = tx
          .prepare(
            `SELECT p.purchase_cost_xof, sb.physical_qty
             FROM products p JOIN stock_balances sb ON sb.product_id = p.id
             WHERE p.id = ?`,
          )
          .get(pol.product_id) as { purchase_cost_xof: number; physical_qty: number };

        const curQty = Math.max(0, prod.physical_qty);
        const newCump =
          curQty + baseQtyRec > 0
            ? Math.round((curQty * prod.purchase_cost_xof + baseQtyRec * baseCost) / (curQty + baseQtyRec))
            : baseCost;

        if (newCump !== prod.purchase_cost_xof) {
          tx.prepare(
            `INSERT INTO product_cost_history (product_id, previous_cost_xof, new_cost_xof, reason, user_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(pol.product_id, prod.purchase_cost_xof, newCump, `Réception ${recNum} (CUMP)`, req.user!.id, now);
          tx.prepare('UPDATE products SET purchase_cost_xof = ? WHERE id = ?').run(newCump, pol.product_id);
        }

        tx.prepare('UPDATE purchase_order_lines SET qty_received = qty_received + ? WHERE id = ?').run(qtyRec, pol.id);
        tx.prepare('UPDATE stock_balances SET physical_qty = physical_qty + ? WHERE product_id = ?').run(
          baseQtyRec,
          pol.product_id,
        );
        tx.prepare(
          `INSERT INTO stock_movements (product_id, movement_type, qty_signed, unit_cost_xof, reference_doc, comment, user_id, created_at)
           VALUES (?, 'ACHAT_RECEPTION', ?, ?, ?, ?, ?, ?)`,
        ).run(
          pol.product_id,
          baseQtyRec,
          baseCost,
          recNum,
          `Réception sur ${po.po_number} (${qtyRec} cond.)`,
          req.user!.id,
          now,
        );

        if (rl.batch_number?.trim() && rl.expiry_date) {
          tx.prepare(
            `INSERT INTO product_batches (product_id, batch_number, expiry_date, qty_remaining, received_at)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(pol.product_id, rl.batch_number.trim(), rl.expiry_date, baseQtyRec, now);
        }

        tx.prepare(
          `INSERT INTO goods_receipt_lines (receipt_id, po_line_id, product_id, qty_received, qty_rejected, base_qty_received, unit_cost_xof, batch_number, expiry_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          recId,
          pol.id,
          pol.product_id,
          qtyRec,
          qtyRej,
          baseQtyRec,
          baseCost,
          rl.batch_number?.trim() || null,
          rl.expiry_date || null,
        );
      }

      if (!anyReceived) throw new Error('Saisissez au moins une quantité reçue supérieure à zéro.');

      tx.prepare('UPDATE goods_receipts SET total_value_xof = ? WHERE id = ?').run(recTotalValue, recId);

      // Update PO status (RECUE vs PARTIELLE)
      const remRow = tx
        .prepare('SELECT SUM(qty_ordered - qty_received) as rem FROM purchase_order_lines WHERE po_id = ?')
        .get(poId) as { rem: number };
      const newStatus = remRow.rem <= 0 ? 'RECUE' : 'PARTIELLE';
      tx.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(newStatus, poId);

      writeAuditLog(tx, {
        userId: req.user!.id,
        userName: req.user!.full_name,
        action: 'RECEPTION_ACHAT',
        entityType: 'RECEPTION',
        entityId: recId,
        details: `${recNum} sur ${po.po_number} — Valeur ${recTotalValue} FCFA (${newStatus})`,
      });

      return { receiptNumber: recNum, newStatus, recTotalValue };
    });

    res.status(201).json(out);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ==================== CAISSE & DÉPENSES ====================

opsRouter.get('/cash/current', requirePermission('cash_expenses'), (_req, res) => {
  const db = getDb();
  const session = db
    .prepare("SELECT * FROM cash_sessions WHERE status = 'OUVERTE' ORDER BY id DESC LIMIT 1")
    .get() as Record<string, unknown> | undefined;

  let movements: unknown[] = [];
  let nonCashTotals: unknown[] = [];
  if (session) {
    movements = db
      .prepare(
        `SELECT cm.*, u.full_name AS user_name
         FROM cash_movements cm LEFT JOIN users u ON u.id = cm.user_id
         WHERE cm.session_id = ?
         ORDER BY cm.id DESC`,
      )
      .all(session.id as number);
    nonCashTotals = db
      .prepare(
        `SELECT payment_method, SUM(amount_signed_xof) AS total_xof
         FROM cash_movements
         WHERE session_id = ? AND payment_method != 'ESPECES'
         GROUP BY payment_method`,
      )
      .all(session.id as number);
  }

  const history = db.prepare('SELECT * FROM cash_sessions ORDER BY id DESC LIMIT 20').all();
  res.json({ session: session ?? null, movements, nonCashTotals, history });
});

opsRouter.post('/cash/open', requirePermission('cash_expenses'), (req: AuthedRequest, res) => {
  try {
    const { opening_float_xof, comment } = req.body as { opening_float_xof: number; comment?: string };
    const floatXof = toIntXof(opening_float_xof, 'fond de caisse initial');
    if (floatXof < 0) throw new Error('Le fond initial ne peut pas être négatif.');

    const db = getDb();
    const existing = db.prepare("SELECT id FROM cash_sessions WHERE status = 'OUVERTE'").get();
    if (existing) throw new Error('Une session de caisse est déjà ouverte.');

    const now = new Date().toISOString();
    const ins = db
      .prepare(
        `INSERT INTO cash_sessions (user_id, user_name, opened_at, opening_float_xof, theoretical_cash_xof, status, comment)
         VALUES (?, ?, ?, ?, ?, 'OUVERTE', ?)`,
      )
      .run(req.user!.id, req.user!.full_name, now, floatXof, floatXof, comment?.trim() ?? '');

    writeAuditLog(db, {
      userId: req.user!.id,
      userName: req.user!.full_name,
      action: 'OUVERTURE_CAISSE',
      entityType: 'CAISSE',
      entityId: Number(ins.lastInsertRowid),
      details: `Ouverture avec fond de caisse ${floatXof} FCFA`,
    });
    res.status(201).json({ id: Number(ins.lastInsertRowid) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

opsRouter.post('/cash/movement', requirePermission('cash_expenses'), (req: AuthedRequest, res) => {
  try {
    const { movement_type, amount_xof, payment_method, comment } = req.body as {
      movement_type: 'APPORT' | 'RETRAIT';
      amount_xof: number;
      payment_method?: string;
      comment: string;
    };
    const amt = toPositiveInt(amount_xof, 'montant');
    if (!comment?.trim()) throw new Error('Motif obligatoire.');
    const method = payment_method || 'ESPECES';
    const signed = movement_type === 'APPORT' ? amt : -amt;

    runInTransaction((tx) => {
      const openSess = tx
        .prepare("SELECT id FROM cash_sessions WHERE status = 'OUVERTE' ORDER BY id DESC LIMIT 1")
        .get() as { id: number } | undefined;
      if (!openSess) throw new Error('Aucune caisse ouverte actuellement.');

      tx.prepare(
        `INSERT INTO cash_movements (session_id, movement_type, payment_method, amount_signed_xof, reference_doc, comment, user_id, created_at)
         VALUES (?, ?, ?, ?, 'CAISSE-MVT', ?, ?, ?)`,
      ).run(openSess.id, movement_type, method, signed, comment.trim(), req.user!.id, new Date().toISOString());

      if (method === 'ESPECES') {
        tx.prepare('UPDATE cash_sessions SET theoretical_cash_xof = theoretical_cash_xof + ? WHERE id = ?').run(
          signed,
          openSess.id,
        );
      }

      writeAuditLog(tx, {
        userId: req.user!.id,
        userName: req.user!.full_name,
        action: `CAISSE_${movement_type}`,
        entityType: 'CAISSE',
        entityId: openSess.id,
        details: `${movement_type} ${amt} FCFA (${method}) — ${comment.trim()}`,
      });
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

opsRouter.post('/cash/close', requirePermission('cash_expenses'), (req: AuthedRequest, res) => {
  try {
    const { counted_cash_xof, comment } = req.body as { counted_cash_xof: number; comment?: string };
    const counted = toIntXof(counted_cash_xof, 'montant compté');
    if (counted < 0) throw new Error('Le montant compté ne peut pas être négatif.');

    const result = runInTransaction((tx) => {
      const sess = tx
        .prepare("SELECT * FROM cash_sessions WHERE status = 'OUVERTE' ORDER BY id DESC LIMIT 1")
        .get() as { id: number; theoretical_cash_xof: number } | undefined;
      if (!sess) throw new Error('Aucune session ouverte à clôturer.');

      const variance = counted - sess.theoretical_cash_xof;
      if (variance !== 0 && !comment?.trim()) {
        throw new Error('Un commentaire explicatif est obligatoire lorsqu’il existe un écart de caisse.');
      }

      const now = new Date().toISOString();
      tx.prepare(
        `UPDATE cash_sessions
         SET status = 'CLOTUREE', closed_at = ?, counted_cash_xof = ?, variance_xof = ?, comment = ?
         WHERE id = ?`,
      ).run(now, counted, variance, comment?.trim() ?? '', sess.id);

      writeAuditLog(tx, {
        userId: req.user!.id,
        userName: req.user!.full_name,
        action: 'CLOTURE_CAISSE',
        entityType: 'CAISSE',
        entityId: sess.id,
        details: `Clôture caisse #${sess.id} — Théorique ${sess.theoretical_cash_xof} F, Compté ${counted} F, Écart ${variance} F`,
      });

      return { theoretical: sess.theoretical_cash_xof, counted, variance };
    });

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

opsRouter.get('/expenses', requirePermission('cash_expenses'), (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT e.*, ec.name AS category_name, u.full_name AS user_name
       FROM expenses e
       JOIN expense_categories ec ON ec.id = e.category_id
       LEFT JOIN users u ON u.id = e.user_id
       ORDER BY e.id DESC`,
    )
    .all();
  res.json(rows);
});

opsRouter.post('/expenses', requirePermission('cash_expenses'), (req: AuthedRequest, res) => {
  try {
    const { category_id, beneficiary, amount_xof, payment_method, reference_note, comment, expense_date } =
      req.body as {
        category_id: number;
        beneficiary: string;
        amount_xof: number;
        payment_method: string;
        reference_note?: string;
        comment?: string;
        expense_date?: string;
      };
    const amt = toPositiveInt(amount_xof, 'montant de la dépense');
    if (!beneficiary?.trim()) throw new Error('Le bénéficiaire est obligatoire.');

    const expNum = runInTransaction((tx) => {
      const now = new Date().toISOString();
      const num = nextDocumentNumber(tx, 'DEP');
      const method = payment_method || 'ESPECES';
      tx.prepare(
        `INSERT INTO expenses (expense_number, category_id, beneficiary, amount_xof, payment_method, reference_note, comment, expense_date, user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        num,
        category_id,
        beneficiary.trim(),
        amt,
        method,
        reference_note?.trim() ?? '',
        comment?.trim() ?? '',
        expense_date || now.slice(0, 10),
        req.user!.id,
        now,
      );

      const openSess = tx
        .prepare("SELECT id FROM cash_sessions WHERE status = 'OUVERTE' ORDER BY id DESC LIMIT 1")
        .get() as { id: number } | undefined;

      tx.prepare(
        `INSERT INTO cash_movements (session_id, movement_type, payment_method, amount_signed_xof, reference_doc, comment, user_id, created_at)
         VALUES (?, 'DEPENSE', ?, ?, ?, ?, ?, ?)`,
      ).run(openSess?.id ?? null, method, -amt, num, `Dépense : ${beneficiary.trim()}`, req.user!.id, now);

      if (openSess && method === 'ESPECES') {
        tx.prepare('UPDATE cash_sessions SET theoretical_cash_xof = theoretical_cash_xof - ? WHERE id = ?').run(
          amt,
          openSess.id,
        );
      }

      writeAuditLog(tx, {
        userId: req.user!.id,
        userName: req.user!.full_name,
        action: 'ENREGISTREMENT_DEPENSE',
        entityType: 'DEPENSE',
        entityId: num,
        details: `${num} — ${amt} FCFA (${method}) à ${beneficiary.trim()}`,
      });
      return num;
    });

    res.status(201).json({ expense_number: expNum });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ==================== INVENTAIRES ====================

opsRouter.get('/inventories', requirePermission('inventories'), (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT inv.*, u.full_name AS user_name,
              (SELECT COUNT(*) FROM inventory_lines il WHERE il.inventory_id = inv.id) AS line_count,
              (SELECT COALESCE(SUM(il.variance_value_xof), 0) FROM inventory_lines il WHERE il.inventory_id = inv.id) AS total_variance_xof
       FROM inventory_sessions inv
       LEFT JOIN users u ON u.id = inv.user_id
       ORDER BY inv.id DESC`,
    )
    .all();
  res.json(rows);
});

opsRouter.get('/inventories/:id', requirePermission('inventories'), (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const inv = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(id);
  if (!inv) {
    res.status(404).json({ error: 'Inventaire introuvable.' });
    return;
  }
  const lines = db
    .prepare(
      `SELECT il.*, p.sku, p.name AS product_name, c.name AS category_name, u.label AS unit_label
       FROM inventory_lines il
       JOIN products p ON p.id = il.product_id
       JOIN categories c ON c.id = p.category_id
       JOIN units u ON u.id = p.unit_id
       WHERE il.inventory_id = ?
       ORDER BY p.name ASC`,
    )
    .all(id);
  res.json({ session: inv, lines });
});

opsRouter.post('/inventories', requirePermission('inventories'), (req: AuthedRequest, res) => {
  try {
    const { category_id, notes } = req.body as { category_id?: number | null; notes?: string };
    const out = runInTransaction((tx) => {
      const now = new Date().toISOString();
      const invNum = nextDocumentNumber(tx, 'INV');
      let scope = 'Global (tous les produits actifs)';
      if (category_id) {
        const cat = tx.prepare('SELECT name FROM categories WHERE id = ?').get(category_id) as { name: string };
        scope = `Catégorie : ${cat?.name ?? category_id}`;
      }

      const ins = tx
        .prepare(
          `INSERT INTO inventory_sessions (inventory_number, scope, status, notes, user_id, created_at)
           VALUES (?, ?, 'BROUILLON', ?, ?, ?)`,
        )
        .run(invNum, scope, notes?.trim() ?? '', req.user!.id, now);
      const invId = Number(ins.lastInsertRowid);

      const products = tx
        .prepare(
          `SELECT p.id, p.purchase_cost_xof, COALESCE(sb.physical_qty, 0) AS physical_qty
           FROM products p LEFT JOIN stock_balances sb ON sb.product_id = p.id
           WHERE p.active = 1 ${category_id ? 'AND p.category_id = ?' : ''}`,
        )
        .all(...(category_id ? [category_id] : [])) as Array<{
        id: number;
        purchase_cost_xof: number;
        physical_qty: number;
      }>;

      for (const p of products) {
        tx.prepare(
          `INSERT INTO inventory_lines (inventory_id, product_id, theoretical_qty, counted_qty, variance_qty, unit_cost_xof, variance_value_xof)
           VALUES (?, ?, ?, ?, 0, ?, 0)`,
        ).run(invId, p.id, p.physical_qty, p.physical_qty, p.purchase_cost_xof);
      }

      return { id: invId, inventory_number: invNum };
    });

    res.status(201).json(out);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

opsRouter.put('/inventories/:id/lines', requirePermission('inventories'), (req, res) => {
  try {
    const invId = Number(req.params.id);
    const { counts } = req.body as { counts: Array<{ line_id: number; counted_qty: number }> };
    runInTransaction((tx) => {
      const inv = tx.prepare('SELECT status FROM inventory_sessions WHERE id = ?').get(invId) as
        | { status: string }
        | undefined;
      if (!inv) throw new Error('Inventaire introuvable.');
      if (inv.status === 'VALIDE') throw new Error('Un inventaire validé ne peut plus être modifié.');

      for (const c of counts) {
        const counted = toIntXof(c.counted_qty, 'quantité comptée');
        if (counted < 0) throw new Error('La quantité comptée ne peut pas être négative.');
        const line = tx
          .prepare('SELECT theoretical_qty, unit_cost_xof FROM inventory_lines WHERE id = ? AND inventory_id = ?')
          .get(c.line_id, invId) as { theoretical_qty: number; unit_cost_xof: number } | undefined;
        if (!line) continue;
        const variance = counted - line.theoretical_qty;
        const varVal = variance * line.unit_cost_xof;
        tx.prepare(
          'UPDATE inventory_lines SET counted_qty = ?, variance_qty = ?, variance_value_xof = ? WHERE id = ?',
        ).run(counted, variance, varVal, c.line_id);
      }
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

opsRouter.post('/inventories/:id/validate', requirePermission('inventories'), (req: AuthedRequest, res) => {
  try {
    const invId = Number(req.params.id);
    runInTransaction((tx) => {
      const inv = tx.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(invId) as
        | { id: number; inventory_number: string; status: string }
        | undefined;
      if (!inv) throw new Error('Inventaire introuvable.');
      if (inv.status === 'VALIDE') throw new Error('Cet inventaire est déjà validé.');

      const lines = tx.prepare('SELECT * FROM inventory_lines WHERE inventory_id = ?').all(invId) as Array<{
        product_id: number;
        theoretical_qty: number;
        counted_qty: number;
        variance_qty: number;
        unit_cost_xof: number;
      }>;

      const now = new Date().toISOString();
      let adjustedCount = 0;

      for (const l of lines) {
        if (l.variance_qty !== 0) {
          tx.prepare('UPDATE stock_balances SET physical_qty = physical_qty + ? WHERE product_id = ?').run(
            l.variance_qty,
            l.product_id,
          );
          tx.prepare(
            `INSERT INTO stock_movements (product_id, movement_type, qty_signed, unit_cost_xof, reference_doc, comment, user_id, created_at)
             VALUES (?, 'INVENTAIRE_CORRECTION', ?, ?, ?, ?, ?, ?)`,
          ).run(
            l.product_id,
            l.variance_qty,
            l.unit_cost_xof,
            inv.inventory_number,
            `Régularisation inventaire (théorique ${l.theoretical_qty}, compté ${l.counted_qty})`,
            req.user!.id,
            now,
          );
          adjustedCount++;
        }
      }

      tx.prepare("UPDATE inventory_sessions SET status = 'VALIDE', validated_at = ? WHERE id = ?").run(now, invId);
      writeAuditLog(tx, {
        userId: req.user!.id,
        userName: req.user!.full_name,
        action: 'VALIDATION_INVENTAIRE',
        entityType: 'INVENTAIRE',
        entityId: invId,
        details: `${inv.inventory_number} validé — ${adjustedCount} ligne(s) régularisée(s)`,
      });
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ==================== MARGES, RAPPORTS & RAPPROCHEMENTS ====================

opsRouter.get('/margins', requirePermission('margins'), (req, res) => {
  const db = getDb();
  const from = req.query.from ? `${req.query.from}T00:00:00.000Z` : '2000-01-01T00:00:00.000Z';
  const to = req.query.to ? `${req.query.to}T23:59:59.999Z` : '2099-12-31T23:59:59.999Z';

  const byProduct = db
    .prepare(
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
       ORDER BY gross_margin_xof DESC`,
    )
    .all(from, to) as Array<{
    product_id: number;
    sku: string;
    product_name: string;
    category_name: string;
    net_base_qty: number;
    revenue_xof: number;
    cogs_xof: number;
    gross_margin_xof: number;
  }>;

  const totalExpenses = (
    db
      .prepare('SELECT COALESCE(SUM(amount_xof), 0) AS exp FROM expenses WHERE created_at >= ? AND created_at <= ?')
      .get(from, to) as { exp: number }
  ).exp;

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
      marginRatePct: totalCogs > 0 ? Math.round((totalMargin / totalCogs) * 1000) / 10 : 0,
      markupRatePct: totalRevenue > 0 ? Math.round((totalMargin / totalRevenue) * 1000) / 10 : 0,
    },
    byProduct: byProduct.map((r) => ({
      ...r,
      margin_rate_pct: r.cogs_xof > 0 ? Math.round((r.gross_margin_xof / r.cogs_xof) * 1000) / 10 : 0,
      markup_rate_pct: r.revenue_xof > 0 ? Math.round((r.gross_margin_xof / r.revenue_xof) * 1000) / 10 : 0,
    })),
  });
});

opsRouter.get('/reports/:type', requirePermission('reports'), (req, res) => {
  const db = getDb();
  const type = req.params.type;
  const from = req.query.from ? `${req.query.from}T00:00:00.000Z` : '2000-01-01T00:00:00.000Z';
  const to = req.query.to ? `${req.query.to}T23:59:59.999Z` : '2099-12-31T23:59:59.999Z';

  let rows: unknown[] = [];
  if (type === 'ventes') {
    rows = db
      .prepare(
        `SELECT s.sale_number, substr(s.created_at, 1, 16) AS date_heure, c.name AS client,
                s.status AS statut, s.subtotal_xof AS brut_xof, s.discount_xof AS remise_xof,
                s.deposit_xof AS consigne_xof, s.total_xof, s.paid_xof AS paye_xof, s.credit_due_xof AS credit_xof,
                s.payment_summary AS mode_paiement
         FROM sales s JOIN customers c ON c.id = s.customer_id
         WHERE s.created_at >= ? AND s.created_at <= ?
         ORDER BY s.id DESC`,
      )
      .all(from, to);
  } else if (type === 'encaissements') {
    rows = db
      .prepare(
        `SELECT substr(cm.created_at, 1, 16) AS date_heure, cm.movement_type AS nature,
                cm.payment_method AS moyen, cm.amount_signed_xof AS montant_xof,
                cm.reference_doc AS document, cm.comment AS commentaire, u.full_name AS utilisateur
         FROM cash_movements cm LEFT JOIN users u ON u.id = cm.user_id
         WHERE cm.amount_signed_xof > 0 AND cm.created_at >= ? AND cm.created_at <= ?
         ORDER BY cm.id DESC`,
      )
      .all(from, to);
  } else if (type === 'credits') {
    rows = db
      .prepare(
        `SELECT c.code, c.name AS client, c.phone AS telephone, c.credit_limit_xof AS plafond_xof,
                COALESCE(SUM(CASE WHEN s.status != 'ANNULEE' THEN s.total_xof ELSE 0 END), 0) AS total_achats_xof,
                COALESCE(SUM(CASE WHEN s.status != 'ANNULEE' THEN s.paid_xof ELSE 0 END), 0) AS total_paye_xof,
                COALESCE(SUM(CASE WHEN s.status != 'ANNULEE' THEN s.credit_due_xof ELSE 0 END), 0) AS solde_du_xof
         FROM customers c LEFT JOIN sales s ON s.customer_id = c.id
         GROUP BY c.id
         HAVING solde_du_xof > 0 OR c.credit_limit_xof > 0
         ORDER BY solde_du_xof DESC`,
      )
      .all();
  } else if (type === 'fournisseurs') {
    rows = db
      .prepare(
        `SELECT s.code, s.name AS fournisseur,
                COALESCE(SUM(po.total_xof), 0) AS total_commandes_xof,
                COALESCE(SUM(po.paid_xof), 0) AS total_paye_xof,
                COALESCE(SUM(MAX(0, po.total_xof - po.paid_xof)), 0) AS solde_du_xof
         FROM suppliers s LEFT JOIN purchase_orders po ON po.supplier_id = s.id AND po.status != 'ANNULEE'
         GROUP BY s.id`,
      )
      .all();
  } else if (type === 'stock') {
    rows = db
      .prepare(
        `SELECT p.sku, p.name AS produit, c.name AS categorie, sb.physical_qty AS physique,
                sb.reserved_qty AS reserve, (sb.physical_qty - sb.reserved_qty) AS disponible,
                p.min_threshold AS seuil, p.purchase_cost_xof AS cump_xof,
                (sb.physical_qty * p.purchase_cost_xof) AS valeur_xof
         FROM products p JOIN categories c ON c.id = p.category_id JOIN stock_balances sb ON sb.product_id = p.id
         WHERE p.active = 1 ORDER BY p.name`,
      )
      .all();
  } else if (type === 'marges') {
    rows = db
      .prepare(
        `SELECT p.sku, sl.product_name AS produit, SUM(sl.base_qty - sl.returned_base_qty) AS qte_nette,
                SUM(sl.line_total_xof) AS ca_net_xof,
                SUM((sl.base_qty - sl.returned_base_qty) * sl.unit_cost_xof) AS cout_vendu_xof,
                SUM(sl.line_total_xof - ((sl.base_qty - sl.returned_base_qty) * sl.unit_cost_xof)) AS marge_brute_xof
         FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id JOIN products p ON p.id = sl.product_id
         WHERE s.status != 'ANNULEE' AND s.created_at >= ? AND s.created_at <= ?
         GROUP BY sl.product_id ORDER BY marge_brute_xof DESC`,
      )
      .all(from, to);
  } else if (type === 'depenses') {
    rows = db
      .prepare(
        `SELECT e.expense_number, e.expense_date, ec.name AS categorie, e.beneficiary AS beneficiaire,
                e.payment_method AS moyen, e.amount_xof AS montant_xof, e.comment AS commentaire
         FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
         WHERE e.created_at >= ? AND e.created_at <= ? ORDER BY e.id DESC`,
      )
      .all(from, to);
  } else if (type === 'caisse') {
    rows = db
      .prepare(
        `SELECT id, user_name AS caissier, substr(opened_at, 1, 16) AS ouverture, substr(COALESCE(closed_at, '-'), 1, 16) AS fermeture,
                opening_float_xof AS fond_initial, theoretical_cash_xof AS theorique,
                COALESCE(counted_cash_xof, 0) AS compte, COALESCE(variance_xof, 0) AS ecart, status AS statut
         FROM cash_sessions ORDER BY id DESC`,
      )
      .all();
  } else if (type === 'consignes') {
    rows = db
      .prepare(
        `SELECT dm.party_type AS type_tiers,
                CASE WHEN dm.party_type = 'CLIENT' THEN (SELECT name FROM customers WHERE id = dm.party_id)
                     WHEN dm.party_type = 'FOURNISSEUR' THEN (SELECT name FROM suppliers WHERE id = dm.party_id)
                     ELSE 'Dépôt' END AS tiers,
                rp.label AS emballage, SUM(dm.qty_signed) AS solde_qte,
                SUM(dm.qty_signed) * rp.deposit_value_xof AS valeur_xof
         FROM deposit_movements dm JOIN returnable_packaging rp ON rp.id = dm.packaging_id
         GROUP BY dm.party_type, dm.party_id, dm.packaging_id
         HAVING solde_qte != 0`,
      )
      .all();
  } else if (type === 'livraisons') {
    rows = db
      .prepare(
        `SELECT d.delivery_number, d.scheduled_date, c.name AS client, d.driver_name AS livreur,
                d.fee_xof AS frais_xof, d.status AS statut, d.proof_note AS commentaire
         FROM deliveries d JOIN customers c ON c.id = d.customer_id
         WHERE d.created_at >= ? AND d.created_at <= ? ORDER BY d.id DESC`,
      )
      .all(from, to);
  } else if (type === 'inventaires') {
    rows = db
      .prepare(
        `SELECT inv.inventory_number, inv.scope, inv.status, substr(inv.created_at, 1, 16) AS date_creation,
                COALESCE(SUM(il.variance_value_xof), 0) AS ecart_valeur_xof
         FROM inventory_sessions inv LEFT JOIN inventory_lines il ON il.inventory_id = inv.id
         GROUP BY inv.id ORDER BY inv.id DESC`,
      )
      .all();
  } else if (type === 'activite') {
    rows = db
      .prepare(
        `SELECT substr(created_at, 1, 16) AS date_heure, user_name AS utilisateur,
                action, entity_type AS module, details
         FROM audit_logs
         WHERE created_at >= ? AND created_at <= ?
         ORDER BY id DESC LIMIT 200`,
      )
      .all(from, to);
  }

  res.json({ type, rows });
});

opsRouter.get('/reconciliation', requirePermission('reports'), (_req, res) => {
  const db = getDb();

  const stockDiffs = db
    .prepare(
      `SELECT p.sku, p.name, sb.physical_qty AS balance,
              COALESCE((SELECT SUM(qty_signed) FROM stock_movements sm WHERE sm.product_id = p.id), 0) AS ledger
       FROM products p JOIN stock_balances sb ON sb.product_id = p.id
       WHERE sb.physical_qty != COALESCE((SELECT SUM(qty_signed) FROM stock_movements sm WHERE sm.product_id = p.id), 0)`,
    )
    .all();

  const cashDiffs = db
    .prepare(
      `SELECT cs.id, cs.user_name, cs.theoretical_cash_xof,
              (cs.opening_float_xof + COALESCE((SELECT SUM(amount_signed_xof) FROM cash_movements cm WHERE cm.session_id = cs.id AND cm.payment_method = 'ESPECES'), 0)) AS ledger_cash
       FROM cash_sessions cs
       WHERE cs.theoretical_cash_xof != (cs.opening_float_xof + COALESCE((SELECT SUM(amount_signed_xof) FROM cash_movements cm WHERE cm.session_id = cs.id AND cm.payment_method = 'ESPECES'), 0))`,
    )
    .all();

  const custIntegrity = db
    .prepare(
      `SELECT COUNT(*) AS checked,
              SUM(CASE WHEN total_xof != (paid_xof + credit_due_xof) AND status = 'VALIDEE' THEN 1 ELSE 0 END) AS anomalies
       FROM sales`,
    )
    .get() as { checked: number; anomalies: number };

  const integrityCheck = db.prepare('PRAGMA integrity_check;').get() as { integrity_check: string };

  res.json({
    sqliteIntegrity: integrityCheck.integrity_check,
    stockDiscrepancies: stockDiffs,
    cashDiscrepancies: cashDiffs,
    salesBalanceAnomalies: custIntegrity.anomalies || 0,
    salesChecked: custIntegrity.checked,
  });
});

// ==================== PARAMÈTRES, UTILISATEURS & AUDIT ====================

opsRouter.get('/settings', requireAuth, (_req, res) => {
  const db = getDb();
  const company = db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
  res.json(company);
});

opsRouter.put('/settings', requirePermission('settings_users'), (req: AuthedRequest, res) => {
  try {
    const body = req.body as {
      name: string;
      phone: string;
      address: string;
      city: string;
      registration_no: string;
      footer_note: string;
      tax_enabled: number;
      tax_rate: number;
      reserve_stock_on_order: number;
      auto_backup_on_start: number;
      retention_daily: number;
    };
    const db = getDb();
    db.prepare(
      `UPDATE company_settings
       SET name = ?, phone = ?, address = ?, city = ?, registration_no = ?, footer_note = ?,
           tax_enabled = ?, tax_rate = ?, reserve_stock_on_order = ?, auto_backup_on_start = ?, retention_daily = ?
       WHERE id = 1`,
    ).run(
      body.name.trim(),
      body.phone?.trim() ?? '',
      body.address?.trim() ?? '',
      body.city?.trim() ?? '',
      body.registration_no?.trim() ?? '',
      body.footer_note?.trim() ?? '',
      body.tax_enabled ? 1 : 0,
      Number(body.tax_rate) || 0,
      body.reserve_stock_on_order ? 1 : 0,
      body.auto_backup_on_start ? 1 : 0,
      Math.max(1, Number(body.retention_daily) || 7),
    );
    writeAuditLog(db, {
      userId: req.user!.id,
      userName: req.user!.full_name,
      action: 'MODIFICATION_PARAMETRES',
      entityType: 'PARAMETRES',
      details: `Mise à jour paramètres dépôt (${body.name.trim()})`,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

opsRouter.post('/settings/reference', requirePermission('settings_users'), (req: AuthedRequest, res) => {
  try {
    const { kind, name, code, deposit_value_xof, capacity, is_cash } = req.body as {
      kind: 'category' | 'brand' | 'expense_category' | 'packaging' | 'unit' | 'payment_method';
      name: string;
      code?: string;
      deposit_value_xof?: number;
      capacity?: number;
      is_cash?: boolean;
    };
    if (!name?.trim()) throw new Error('Libellé obligatoire.');
    const db = getDb();
    let createdId = 0;
    if (kind === 'category') {
      const ins = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name.trim());
      createdId = Number(ins.lastInsertRowid);
    } else if (kind === 'brand') {
      const ins = db.prepare('INSERT INTO brands (name) VALUES (?)').run(name.trim());
      createdId = Number(ins.lastInsertRowid);
    } else if (kind === 'expense_category') {
      const ins = db.prepare('INSERT INTO expense_categories (name) VALUES (?)').run(name.trim());
      createdId = Number(ins.lastInsertRowid);
    } else if (kind === 'unit') {
      const cleanCode = (code?.trim() || name.trim().slice(0, 4)).toUpperCase();
      const ins = db.prepare('INSERT INTO units (code, label) VALUES (?, ?)').run(cleanCode, name.trim());
      createdId = Number(ins.lastInsertRowid);
    } else if (kind === 'payment_method') {
      const cleanCode = (code?.trim() || name.trim().replace(/[^a-zA-Z0-9]+/g, '_')).toUpperCase();
      const ins = db
        .prepare('INSERT INTO payment_methods (code, label, is_cash, active) VALUES (?, ?, ?, 1)')
        .run(cleanCode, name.trim(), is_cash ? 1 : 0);
      createdId = Number(ins.lastInsertRowid);
    } else if (kind === 'packaging') {
      const ins = db
        .prepare('INSERT INTO returnable_packaging (code, label, capacity, deposit_value_xof) VALUES (?, ?, ?, ?)')
        .run(
          (code?.trim() || name.trim().replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 8)).toUpperCase(),
          name.trim(),
          Math.max(1, Number(capacity) || 1),
          toIntXof(deposit_value_xof ?? 0, 'valeur consigne'),
        );
      createdId = Number(ins.lastInsertRowid);
    }
    writeAuditLog(db, {
      userId: req.user!.id,
      userName: req.user!.full_name,
      action: 'AJOUT_REFERENTIEL',
      entityType: kind.toUpperCase(),
      entityId: createdId,
      details: `Ajout "${name.trim()}"`,
    });
    res.status(201).json({ ok: true, id: createdId });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

opsRouter.delete('/settings/reference/:kind/:id', requirePermission('settings_users'), (req: AuthedRequest, res) => {
  try {
    const kind = req.params.kind;
    const id = Number(req.params.id);
    const db = getDb();
    if (kind === 'category') {
      db.prepare('UPDATE categories SET active = 0 WHERE id = ?').run(id);
    } else if (kind === 'brand') {
      db.prepare('UPDATE brands SET active = 0 WHERE id = ?').run(id);
    } else if (kind === 'expense_category') {
      db.prepare('UPDATE expense_categories SET active = 0 WHERE id = ?').run(id);
    } else if (kind === 'packaging') {
      db.prepare('UPDATE returnable_packaging SET active = 0 WHERE id = ?').run(id);
    } else if (kind === 'payment_method') {
      db.prepare('UPDATE payment_methods SET active = 0 WHERE id = ?').run(id);
    } else if (kind === 'unit') {
      const used = db.prepare('SELECT COUNT(*) as cnt FROM products WHERE unit_id = ?').get(id) as { cnt: number };
      if (used.cnt > 0) throw new Error('Unité utilisée par au moins un produit du catalogue.');
      db.prepare('DELETE FROM units WHERE id = ?').run(id);
    } else {
      throw new Error('Type de référentiel inconnu.');
    }
    writeAuditLog(db, {
      userId: req.user!.id,
      userName: req.user!.full_name,
      action: 'SUPPRESSION_REFERENTIEL',
      entityType: kind.toUpperCase(),
      entityId: id,
      details: `Désactivation / suppression élément #${id}`,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

opsRouter.get('/users', requirePermission('settings_users'), (_req, res) => {
  const db = getDb();
  const users = db
    .prepare(
      `SELECT id, username, full_name, role, active, failed_attempts, last_login_at, created_at
       FROM users ORDER BY id ASC`,
    )
    .all();
  res.json(users);
});

opsRouter.post('/users', requirePermission('settings_users'), (req: AuthedRequest, res) => {
  try {
    const { username, full_name, role, password, pin } = req.body as {
      username: string;
      full_name: string;
      role: UserRole;
      password: string;
      pin?: string;
    };
    if (!username?.trim() || !full_name?.trim() || !password) {
      throw new Error('Identifiant, nom complet et mot de passe sont obligatoires.');
    }
    const db = getDb();
    const ins = db
      .prepare(
        `INSERT INTO users (username, full_name, role, password_hash, pin_hash, active, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        username.trim().toLowerCase(),
        full_name.trim(),
        role,
        hashSecret(password),
        pin ? hashSecret(pin) : null,
        new Date().toISOString(),
      );
    writeAuditLog(db, {
      userId: req.user!.id,
      userName: req.user!.full_name,
      action: 'CREATION_UTILISATEUR',
      entityType: 'UTILISATEUR',
      entityId: Number(ins.lastInsertRowid),
      details: `Création ${username.trim()} (${role})`,
    });
    res.status(201).json({ id: Number(ins.lastInsertRowid) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

opsRouter.put('/users/:id', requirePermission('settings_users'), (req: AuthedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const { full_name, role, active, new_password, new_pin } = req.body as {
      full_name?: string;
      role?: UserRole;
      active?: number;
      new_password?: string;
      new_pin?: string;
    };
    const db = getDb();
    const existing = db.prepare('SELECT id, username, role, active FROM users WHERE id = ?').get(id) as
      | { id: number; username: string; role: UserRole; active: number }
      | undefined;
    if (!existing) throw new Error('Utilisateur introuvable.');
    if (existing.id === req.user!.id && active === 0) {
      throw new Error('Vous ne pouvez pas désactiver votre propre compte pendant votre session.');
    }

    if (full_name && role) {
      db.prepare('UPDATE users SET full_name = ?, role = ? WHERE id = ?').run(full_name.trim(), role, id);
    }
    if (active !== undefined) {
      db.prepare('UPDATE users SET active = ?, failed_attempts = 0 WHERE id = ?').run(active ? 1 : 0, id);
    }
    if (new_password) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashSecret(new_password), id);
    }
    if (new_pin) {
      db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hashSecret(new_pin), id);
    }

    writeAuditLog(db, {
      userId: req.user!.id,
      userName: req.user!.full_name,
      action: 'MODIFICATION_UTILISATEUR',
      entityType: 'UTILISATEUR',
      entityId: id,
      details: `Mise à jour utilisateur ${existing.username} (actif: ${active ?? existing.active})`,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

opsRouter.get('/audit-logs', requirePermission('settings_users'), (req, res) => {
  const db = getDb();
  const limit = Number(req.query.limit || 150);
  const rows = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit);
  res.json(rows);
});

// ==================== SAUVEGARDE & RESTAURATION ====================

opsRouter.get('/backups', requirePermission('backups'), (_req, res) => {
  const db = getDb();
  const history = db.prepare('SELECT * FROM backup_history ORDER BY id DESC').all();
  const integrity = db.prepare('PRAGMA integrity_check;').get() as { integrity_check: string };
  const stat = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH) : null;
  res.json({
    dbPath: DB_PATH,
    backupsDir: BACKUPS_DIR,
    mirrorDir: getAutoBackupMirrorDir(),
    dbSizeBytes: stat?.size ?? 0,
    liveIntegrity: integrity.integrity_check,
    history,
  });
});

opsRouter.post('/backups/create', requirePermission('backups'), async (req: AuthedRequest, res) => {
  try {
    const { note } = req.body as { note?: string };
    const bkp = await createSqliteBackup('MANUELLE', note);
    const db = getDb();
    writeAuditLog(db, {
      userId: req.user!.id,
      userName: req.user!.full_name,
      action: 'SAUVEGARDE_MANUELLE',
      entityType: 'SAUVEGARDE',
      entityId: bkp.id,
      details: `Sauvegarde SQLite créée (${bkp.filename}, ${bkp.size_bytes} octets, intégrité=${bkp.integrity_ok ? 'OK' : 'ERREUR'})`,
    });
    res.status(201).json(bkp);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

opsRouter.get('/backups/:id/download', requirePermission('backups'), (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT filename, file_path FROM backup_history WHERE id = ?').get(Number(req.params.id)) as
    | { filename: string; file_path: string }
    | undefined;
  if (!row || !fs.existsSync(row.file_path)) {
    res.status(404).json({ error: 'Fichier de sauvegarde introuvable sur le disque.' });
    return;
  }
  res.download(row.file_path, row.filename);
});

opsRouter.post('/backups/:id/restore', requirePermission('backups'), async (req: AuthedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const { admin_username, admin_secret } = req.body as { admin_username?: string; admin_secret?: string };
    if (!admin_username || !admin_secret) {
      res.status(400).json({ error: 'L’authentification d’un administrateur est requise pour restaurer la base.' });
      return;
    }
    const admin = verifySupervisorCredentials(admin_username, admin_secret);
    if (!admin || admin.role !== 'ADMIN') {
      res.status(403).json({ error: 'Authentification administrateur invalide.' });
      return;
    }

    const db = getDb();
    const target = db.prepare('SELECT * FROM backup_history WHERE id = ?').get(id) as
      | { id: number; filename: string; file_path: string }
      | undefined;
    if (!target || !fs.existsSync(target.file_path)) {
      res.status(404).json({ error: 'Fichier de sauvegarde introuvable.' });
      return;
    }

    // 1. Verify backup integrity BEFORE touching live DB
    const testDb = new DatabaseSync(target.file_path, { readOnly: true });
    let integrityOk = false;
    try {
      const chk = testDb.prepare('PRAGMA integrity_check;').get() as { integrity_check: string };
      integrityOk = chk.integrity_check === 'ok';
    } finally {
      testDb.close();
    }
    if (!integrityOk) {
      res.status(400).json({ error: 'Restauration annulée : la sauvegarde sélectionnée est corrompue.' });
      return;
    }

    // 2. Create pre-restore safety backup of current DB
    await createSqliteBackup('SECURITE_PRE_RESTAURATION', `Avant restauration de ${target.filename}`);

    // 3. Close live connections, replace SQLite file (and clean WAL/SHM), reopen
    closeDb();
    fs.copyFileSync(target.file_path, DB_PATH);
    const walPath = `${DB_PATH}-wal`;
    const shmPath = `${DB_PATH}-shm`;
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);

    const restoredDb = getDb();
    writeAuditLog(restoredDb, {
      userId: admin.id,
      userName: admin.full_name,
      action: 'RESTAURATION_BASE',
      entityType: 'SAUVEGARDE',
      entityId: target.id,
      details: `Base restaurée depuis ${target.filename} par ${admin.username}`,
    });

    res.json({ ok: true, restoredFrom: target.filename });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

opsRouter.post('/backups/import', requirePermission('backups'), async (req: AuthedRequest, res) => {
  let tempPath: string | null = null;
  try {
    const { filename, base64Data, admin_username, admin_secret } = req.body as {
      filename?: string;
      base64Data?: string;
      admin_username?: string;
      admin_secret?: string;
    };

    if (!admin_username || !admin_secret) {
      res.status(400).json({ error: 'L’authentification d’un administrateur est requise pour importer une base.' });
      return;
    }
    const admin = verifySupervisorCredentials(admin_username, admin_secret);
    if (!admin || admin.role !== 'ADMIN') {
      res.status(403).json({ error: 'Authentification administrateur invalide.' });
      return;
    }

    if (!base64Data) {
      res.status(400).json({ error: 'Aucun fichier de sauvegarde fourni.' });
      return;
    }

    const buf = Buffer.from(base64Data, 'base64');
    if (buf.length < 100 || buf.subarray(0, 15).toString('utf8') !== 'SQLite format 3') {
      res.status(400).json({ error: 'Le fichier sélectionné n’est pas une base SQLite valide.' });
      return;
    }

    const safeName = (filename || 'import.sqlite').replace(/[^a-zA-Z0-9._-]/g, '_');
    tempPath = path.join(BACKUPS_DIR, `_import_${Date.now()}_${safeName}`);
    fs.writeFileSync(tempPath, buf);

    const testDb = new DatabaseSync(tempPath, { readOnly: true });
    let integrityOk = false;
    let hasUsersTable = false;
    try {
      const chk = testDb.prepare('PRAGMA integrity_check;').get() as { integrity_check: string };
      integrityOk = chk.integrity_check === 'ok';
      const tbl = testDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
        .get() as { name: string } | undefined;
      hasUsersTable = !!tbl;
    } finally {
      testDb.close();
    }

    if (!integrityOk || !hasUsersTable) {
      fs.unlinkSync(tempPath);
      tempPath = null;
      res.status(400).json({ error: 'Import annulé : sauvegarde corrompue ou incompatible avec GestDepot.' });
      return;
    }

    await createSqliteBackup('SECURITE_PRE_RESTAURATION', `Avant import externe (${safeName})`);

    closeDb();
    fs.copyFileSync(tempPath, DB_PATH);
    fs.unlinkSync(tempPath);
    tempPath = null;

    const walPath = `${DB_PATH}-wal`;
    const shmPath = `${DB_PATH}-shm`;
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);

    const restoredDb = getDb();
    writeAuditLog(restoredDb, {
      userId: admin.id,
      userName: admin.full_name,
      action: 'IMPORT_RESTAURATION_BASE',
      entityType: 'SAUVEGARDE',
      details: `Base importée et restaurée depuis "${safeName}" par ${admin.username}`,
    });

    res.json({ ok: true, restoredFrom: safeName });
  } catch (err) {
    if (tempPath && fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // ignore cleanup error
      }
    }
    res.status(500).json({ error: (err as Error).message });
  }
});
