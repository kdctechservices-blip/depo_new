import { Router } from 'express';
import { getDb, nextDocumentNumber, runInTransaction, writeAuditLog } from './db.ts';
import {
  type AuthedRequest,
  requireAuth,
  requirePermission,
  verifySupervisorCredentials,
  toIntXof,
  toPositiveInt,
} from './middleware.ts';

export const salesRouter = Router();

// ==================== CLIENTS & CRÉDITS ====================

salesRouter.get('/customers', requireAuth, (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT c.*, pl.code AS price_list_code, pl.label AS price_list_label,
              COALESCE((SELECT SUM(s.credit_due_xof) FROM sales s WHERE s.customer_id = c.id AND s.status != 'ANNULEE'), 0) AS balance_due_xof,
              COALESCE((SELECT SUM(dm.qty_signed) FROM deposit_movements dm WHERE dm.party_type = 'CLIENT' AND dm.party_id = c.id), 0) AS deposit_qty_balance,
              (SELECT MAX(s.created_at) FROM sales s WHERE s.customer_id = c.id) AS last_operation_at
       FROM customers c
       JOIN price_lists pl ON pl.id = c.price_list_id
       WHERE c.active = 1
       ORDER BY CASE WHEN c.code = 'CLI-000' THEN 0 ELSE 1 END, c.name ASC`,
    )
    .all();
  res.json(rows);
});

salesRouter.post('/customers', requirePermission('customers'), (req: AuthedRequest, res) => {
  try {
    const { name, phone, address, customer_type, price_list_id, credit_limit_xof } = req.body as {
      name: string;
      phone?: string;
      address?: string;
      customer_type?: string;
      price_list_id: number;
      credit_limit_xof?: number;
    };
    if (!name?.trim()) {
      res.status(400).json({ error: 'Le nom du client est obligatoire.' });
      return;
    }
    const limit = toIntXof(credit_limit_xof ?? 0, 'plafond de crédit');
    if (limit < 0) throw new Error('Le plafond de crédit doit être positif ou nul.');

    const customerId = runInTransaction((tx) => {
      const cnt = (tx.prepare('SELECT COUNT(*) as c FROM customers').get() as { c: number }).c;
      const code = `CLI-${String(cnt).padStart(3, '0')}`;
      const ins = tx
        .prepare(
          `INSERT INTO customers (code, name, phone, address, customer_type, price_list_id, credit_limit_xof, active, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(
          code,
          name.trim(),
          phone?.trim() ?? '',
          address?.trim() ?? '',
          customer_type || 'Gros',
          price_list_id,
          limit,
          new Date().toISOString(),
        );
      writeAuditLog(tx, {
        userId: req.user!.id,
        userName: req.user!.full_name,
        action: 'CREATION_CLIENT',
        entityType: 'CLIENT',
        entityId: Number(ins.lastInsertRowid),
        details: `Client ${code} — ${name.trim()} (Plafond ${limit} FCFA)`,
      });
      return Number(ins.lastInsertRowid);
    });

    res.status(201).json({ id: customerId });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

salesRouter.put('/customers/:id', requirePermission('customers'), (req: AuthedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const { name, phone, address, customer_type, price_list_id, credit_limit_xof } = req.body as {
      name: string;
      phone?: string;
      address?: string;
      customer_type?: string;
      price_list_id: number;
      credit_limit_xof?: number;
    };
    const limit = toIntXof(credit_limit_xof ?? 0, 'plafond de crédit');
    const db = getDb();
    db.prepare(
      `UPDATE customers SET name = ?, phone = ?, address = ?, customer_type = ?, price_list_id = ?, credit_limit_xof = ? WHERE id = ?`,
    ).run(name.trim(), phone?.trim() ?? '', address?.trim() ?? '', customer_type || 'Gros', price_list_id, limit, id);
    writeAuditLog(db, {
      userId: req.user!.id,
      userName: req.user!.full_name,
      action: 'MODIFICATION_CLIENT',
      entityType: 'CLIENT',
      entityId: id,
      details: `Mise à jour client ${name.trim()} (Plafond ${limit} FCFA)`,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

salesRouter.get('/customers/:id/statement', requirePermission('customers'), (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const customer = db
    .prepare(
      `SELECT c.*, pl.label AS price_list_label
       FROM customers c JOIN price_lists pl ON pl.id = c.price_list_id
       WHERE c.id = ?`,
    )
    .get(id);
  if (!customer) {
    res.status(404).json({ error: 'Client introuvable.' });
    return;
  }

  const sales = db
    .prepare(
      `SELECT id, sale_number, status, total_xof, paid_xof, credit_due_xof, due_date, payment_summary, created_at
       FROM sales WHERE customer_id = ? ORDER BY id DESC`,
    )
    .all(id);

  const payments = db
    .prepare(
      `SELECT cp.*, u.full_name AS user_name
       FROM customer_payments cp
       LEFT JOIN users u ON u.id = cp.user_id
       WHERE cp.customer_id = ? ORDER BY cp.id DESC`,
    )
    .all(id);

  const deposits = db
    .prepare(
      `SELECT rp.code AS packaging_code, rp.label AS packaging_label, rp.deposit_value_xof,
              SUM(dm.qty_signed) AS qty_balance,
              SUM(dm.qty_signed) * rp.deposit_value_xof AS value_xof
       FROM deposit_movements dm
       JOIN returnable_packaging rp ON rp.id = dm.packaging_id
       WHERE dm.party_type = 'CLIENT' AND dm.party_id = ?
       GROUP BY dm.packaging_id
       HAVING SUM(dm.qty_signed) != 0`,
    )
    .all(id);

  res.json({ customer, sales, payments, deposits });
});

salesRouter.post('/customers/payments', requirePermission('customers'), (req: AuthedRequest, res) => {
  try {
    const { customer_id, amount_xof, payment_method, reference_note, sale_ids } = req.body as {
      customer_id: number;
      amount_xof: number;
      payment_method: string;
      reference_note?: string;
      sale_ids?: number[];
    };
    const amount = toPositiveInt(amount_xof, 'montant du règlement');

    const result = runInTransaction((tx) => {
      const openSales = tx
        .prepare(
          `SELECT id, sale_number, credit_due_xof
           FROM sales
           WHERE customer_id = ? AND status != 'ANNULEE' AND credit_due_xof > 0
           ORDER BY created_at ASC, id ASC`,
        )
        .all(customer_id) as Array<{ id: number; sale_number: string; credit_due_xof: number }>;

      const targetSales =
        sale_ids && sale_ids.length > 0 ? openSales.filter((s) => sale_ids.includes(s.id)) : openSales;

      const totalOpen = targetSales.reduce((acc, s) => acc + s.credit_due_xof, 0);
      if (totalOpen === 0) {
        throw new Error('Ce client n’a aucune créance ouverte à régler.');
      }
      if (amount > totalOpen) {
        throw new Error(
          `Le règlement (${amount} FCFA) dépasse le solde dû des factures sélectionnées (${totalOpen} FCFA).`,
        );
      }

      const now = new Date().toISOString();
      const payNum = nextDocumentNumber(tx, 'PAY');
      const pIns = tx
        .prepare(
          `INSERT INTO customer_payments (payment_number, customer_id, amount_xof, payment_method, reference_note, user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(payNum, customer_id, amount, payment_method || 'ESPECES', reference_note?.trim() ?? '', req.user!.id, now);
      const paymentId = Number(pIns.lastInsertRowid);

      let remaining = amount;
      for (const s of targetSales) {
        if (remaining <= 0) break;
        const alloc = Math.min(remaining, s.credit_due_xof);
        tx.prepare('INSERT INTO payment_allocations (payment_id, sale_id, allocated_xof) VALUES (?, ?, ?)').run(
          paymentId,
          s.id,
          alloc,
        );
        tx.prepare('UPDATE sales SET paid_xof = paid_xof + ?, credit_due_xof = credit_due_xof - ? WHERE id = ?').run(
          alloc,
          alloc,
          s.id,
        );
        remaining -= alloc;
      }

      const openSess = tx
        .prepare("SELECT id FROM cash_sessions WHERE status = 'OUVERTE' ORDER BY id DESC LIMIT 1")
        .get() as { id: number } | undefined;

      tx.prepare(
        `INSERT INTO cash_movements (session_id, movement_type, payment_method, amount_signed_xof, reference_doc, comment, user_id, created_at)
         VALUES (?, 'REGLEMENT_CREANCE', ?, ?, ?, 'Règlement créance client (CA inchangé)', ?, ?)`,
      ).run(openSess?.id ?? null, payment_method || 'ESPECES', amount, payNum, req.user!.id, now);

      if (openSess && (payment_method || 'ESPECES') === 'ESPECES') {
        tx.prepare('UPDATE cash_sessions SET theoretical_cash_xof = theoretical_cash_xof + ? WHERE id = ?').run(
          amount,
          openSess.id,
        );
      }

      writeAuditLog(tx, {
        userId: req.user!.id,
        userName: req.user!.full_name,
        action: 'REGLEMENT_CREANCE_CLIENT',
        entityType: 'PAIEMENT_CLIENT',
        entityId: paymentId,
        details: `${payNum} — Encaissement ${amount} FCFA (${payment_method || 'ESPECES'})`,
      });

      return { paymentId, paymentNumber: payNum };
    });

    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ==================== VENTES / POS ====================

salesRouter.get('/sales', requireAuth, (req, res) => {
  const db = getDb();
  const limit = Number(req.query.limit || 100);
  const rows = db
    .prepare(
      `SELECT s.*, c.name AS customer_name, c.code AS customer_code, u.full_name AS cashier_name
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       LEFT JOIN users u ON u.id = s.user_id
       ORDER BY s.id DESC
       LIMIT ?`,
    )
    .all(limit);
  res.json(rows);
});

salesRouter.get('/sales/:id', requireAuth, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const sale = db
    .prepare(
      `SELECT s.*, c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address,
              pl.label AS price_list_label, u.full_name AS cashier_name
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       JOIN price_lists pl ON pl.id = s.price_list_id
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`,
    )
    .get(id);
  if (!sale) {
    res.status(404).json({ error: 'Vente introuvable.' });
    return;
  }
  const lines = db.prepare('SELECT * FROM sale_lines WHERE sale_id = ?').all(id);
  const returns = db.prepare('SELECT * FROM sale_returns WHERE sale_id = ? ORDER BY id DESC').all(id);
  res.json({ sale, lines, returns });
});

salesRouter.post('/sales', requirePermission('pos'), (req: AuthedRequest, res) => {
  try {
    const body = req.body as {
      customer_id: number;
      price_list_id: number;
      global_discount_xof?: number;
      include_deposit?: boolean;
      payments: Array<{ method: string; amount_xof: number }>;
      due_date?: string;
      notes?: string;
      supervisor_override?: { username: string; secret: string };
      lines: Array<{
        product_id: number;
        packaging_id: number;
        qty: number;
        unit_price_xof: number;
        discount_xof?: number;
        price_modified?: boolean;
      }>;
    };

    if (!body.lines || body.lines.length === 0) {
      res.status(400).json({ error: 'Le panier est vide.' });
      return;
    }

    const globalDiscount = toIntXof(body.global_discount_xof ?? 0, 'remise globale');
    if (globalDiscount < 0) throw new Error('La remise globale ne peut pas être négative.');

    const result = runInTransaction((tx) => {
      const now = new Date().toISOString();
      const settings = tx.prepare('SELECT tax_enabled, tax_rate FROM company_settings WHERE id = 1').get() as {
        tax_enabled: number;
        tax_rate: number;
      };
      const customer = tx
        .prepare('SELECT id, name, credit_limit_xof FROM customers WHERE id = ?')
        .get(body.customer_id) as { id: number; name: string; credit_limit_xof: number } | undefined;
      if (!customer) throw new Error('Client introuvable.');

      let subtotal = 0;
      let totalDeposit = 0;
      const preparedLines: Array<{
        productId: number;
        packagingId: number;
        productName: string;
        packagingName: string;
        factor: number;
        qty: number;
        baseQty: number;
        unitPrice: number;
        discount: number;
        unitCost: number;
        lineTotal: number;
        lineDeposit: number;
        depositPkgId: number | null;
      }> = [];

      // Validate stock availability across aggregated product quantities
      const neededByProduct: Record<number, number> = {};
      for (const l of body.lines) {
        const qty = toPositiveInt(l.qty, 'quantité');
        const unitPrice = toIntXof(l.unit_price_xof, 'prix unitaire');
        const lineDiscount = toIntXof(l.discount_xof ?? 0, 'remise de ligne');
        if (unitPrice < 0 || lineDiscount < 0) throw new Error('Prix et remises doivent être positifs.');

        const prod = tx
          .prepare(
            `SELECT p.id, p.name, p.purchase_cost_xof, p.packaging_deposit_id, p.deposit_units_per_crate,
                    rp.deposit_value_xof
             FROM products p
             LEFT JOIN returnable_packaging rp ON rp.id = p.packaging_deposit_id
             WHERE p.id = ? AND p.active = 1`,
          )
          .get(l.product_id) as
          | {
              id: number;
              name: string;
              purchase_cost_xof: number;
              packaging_deposit_id: number | null;
              deposit_units_per_crate: number;
              deposit_value_xof: number | null;
            }
          | undefined;
        if (!prod) throw new Error('Un produit du panier est introuvable ou archivé.');

        const pack = tx
          .prepare('SELECT id, name, conversion_factor, apply_deposit FROM product_packagings WHERE id = ? AND product_id = ?')
          .get(l.packaging_id, l.product_id) as
          | { id: number; name: string; conversion_factor: number; apply_deposit: number }
          | undefined;
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
          depositPkgId: lineDeposit > 0 ? prod.packaging_deposit_id : null,
        });
      }

      // Check available stock (physical - reserved)
      for (const [pidStr, needed] of Object.entries(neededByProduct)) {
        const pid = Number(pidStr);
        const bal = tx
          .prepare(
            `SELECT p.name, sb.physical_qty, sb.reserved_qty
             FROM stock_balances sb JOIN products p ON p.id = sb.product_id
             WHERE sb.product_id = ?`,
          )
          .get(pid) as { name: string; physical_qty: number; reserved_qty: number };
        const available = bal.physical_qty - bal.reserved_qty;
        if (needed > available) {
          throw new Error(
            `Stock insuffisant pour "${bal.name}" : demandé ${needed} unité(s), disponible ${available} (physique ${bal.physical_qty}, réservé ${bal.reserved_qty}).`,
          );
        }
      }

      const netCommercial = Math.max(0, subtotal - globalDiscount);
      const taxXof = settings.tax_enabled ? Math.round((netCommercial * settings.tax_rate) / 100) : 0;
      const totalXof = netCommercial + taxXof + totalDeposit;

      const payments = Array.isArray(body.payments) ? body.payments : [];
      let paidXof = 0;
      for (const p of payments) {
        const amt = toIntXof(p.amount_xof, 'paiement');
        if (amt < 0) throw new Error('Un paiement ne peut pas être négatif.');
        paidXof += amt;
      }
      if (paidXof > totalXof) {
        throw new Error(`Le montant encaissé (${paidXof} FCFA) dépasse le total à payer (${totalXof} FCFA).`);
      }

      const creditDueXof = totalXof - paidXof;
      if (creditDueXof > 0) {
        if (customer.id === 1 && customer.credit_limit_xof === 0) {
          throw new Error('Le Client Comptoir ne peut pas acheter à crédit. Sélectionnez un client enregistré.');
        }
        const currentDebt = (
          tx
            .prepare(
              `SELECT COALESCE(SUM(credit_due_xof), 0) as d FROM sales WHERE customer_id = ? AND status != 'ANNULEE'`,
            )
            .get(customer.id) as { d: number }
        ).d;
        if (currentDebt + creditDueXof > customer.credit_limit_xof) {
          // Check supervisor override
          if (
            !body.supervisor_override ||
            !verifySupervisorCredentials(body.supervisor_override.username, body.supervisor_override.secret)
          ) {
            throw new Error(
              `PLAFOND_CREDIT_DEPASSE: Plafond dépassé pour ${customer.name} (dette actuelle ${currentDebt} + nouveau crédit ${creditDueXof} > plafond ${customer.credit_limit_xof} FCFA). Validation responsable requise.`,
            );
          }
          writeAuditLog(tx, {
            userId: req.user!.id,
            userName: req.user!.full_name,
            action: 'DEROGATION_PLAFOND_CREDIT',
            entityType: 'CLIENT',
            entityId: customer.id,
            details: `Dépassement autorisé par ${body.supervisor_override.username} pour ${customer.name} (+${creditDueXof} FCFA)`,
          });
        }
      }

      const saleNumber = nextDocumentNumber(tx, 'VTE');
      const paySummary =
        payments.filter((p) => p.amount_xof > 0).map((p) => p.method).join(' + ') ||
        (creditDueXof > 0 ? 'Crédit' : 'Espèces');

      const saleIns = tx
        .prepare(
          `INSERT INTO sales (
            sale_number, customer_id, price_list_id, status, subtotal_xof, discount_xof, tax_xof,
            deposit_xof, total_xof, paid_xof, credit_due_xof, due_date, payment_summary, notes, user_id, created_at
          ) VALUES (?, ?, ?, 'VALIDEE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
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
          creditDueXof > 0 && paidXof > 0 ? `${paySummary} + Crédit` : paySummary,
          body.notes?.trim() ?? '',
          req.user!.id,
          now,
        );
      const saleId = Number(saleIns.lastInsertRowid);

      for (const pl of preparedLines) {
        tx.prepare(
          `INSERT INTO sale_lines (
            sale_id, product_id, packaging_id, product_name, packaging_name, conversion_factor,
            qty, base_qty, unit_price_xof, discount_xof, unit_cost_xof, line_total_xof, deposit_xof
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          pl.lineDeposit,
        );

        // Deduct stock atomically & write immutable movement
        tx.prepare('UPDATE stock_balances SET physical_qty = physical_qty - ? WHERE product_id = ?').run(
          pl.baseQty,
          pl.productId,
        );
        tx.prepare(
          `INSERT INTO stock_movements (product_id, movement_type, qty_signed, unit_cost_xof, reference_doc, comment, user_id, created_at)
           VALUES (?, 'VENTE_SORTIE', ?, ?, ?, ?, ?, ?)`,
        ).run(pl.productId, -pl.baseQty, pl.unitCost, saleNumber, `Vente ${pl.qty} × ${pl.packagingName}`, req.user!.id, now);

        // FEFO batch deduction if product has batches
        let remBatch = pl.baseQty;
        const batches = tx
          .prepare(
            `SELECT id, qty_remaining FROM product_batches WHERE product_id = ? AND qty_remaining > 0 ORDER BY expiry_date ASC`,
          )
          .all(pl.productId) as Array<{ id: number; qty_remaining: number }>;
        for (const b of batches) {
          if (remBatch <= 0) break;
          const take = Math.min(remBatch, b.qty_remaining);
          tx.prepare('UPDATE product_batches SET qty_remaining = qty_remaining - ? WHERE id = ?').run(take, b.id);
          remBatch -= take;
        }

        // Deposit movement if applicable
        if (pl.depositPkgId && pl.lineDeposit > 0) {
          tx.prepare(
            `INSERT INTO deposit_movements (
              party_type, party_id, packaging_id, movement_kind, qty_signed, amount_xof,
              payment_method, reference_doc, comment, user_id, created_at
            ) VALUES ('CLIENT', ?, ?, 'REMISE_CLIENT', ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            customer.id,
            pl.depositPkgId,
            pl.qty,
            pl.lineDeposit,
            paySummary,
            saleNumber,
            `Consigne sur vente ${saleNumber}`,
            req.user!.id,
            now,
          );
        }
      }

      // Cash / payment movements
      const openSess = tx
        .prepare("SELECT id FROM cash_sessions WHERE status = 'OUVERTE' ORDER BY id DESC LIMIT 1")
        .get() as { id: number } | undefined;

      for (const p of payments) {
        const amt = toIntXof(p.amount_xof, 'paiement');
        if (amt <= 0) continue;
        tx.prepare(
          `INSERT INTO cash_movements (session_id, movement_type, payment_method, amount_signed_xof, reference_doc, comment, user_id, created_at)
           VALUES (?, 'VENTE_ENCAISSEMENT', ?, ?, ?, ?, ?, ?)`,
        ).run(openSess?.id ?? null, p.method, amt, saleNumber, `Encaissement vente ${saleNumber}`, req.user!.id, now);

        if (openSess && p.method === 'ESPECES') {
          tx.prepare('UPDATE cash_sessions SET theoretical_cash_xof = theoretical_cash_xof + ? WHERE id = ?').run(
            amt,
            openSess.id,
          );
        }
      }

      if (body.lines.some((l) => l.price_modified) || globalDiscount > 0) {
        writeAuditLog(tx, {
          userId: req.user!.id,
          userName: req.user!.full_name,
          action: 'VENTE_AVEC_REMISE_OU_PRIX_MODIFIE',
          entityType: 'VENTE',
          entityId: saleId,
          details: `${saleNumber} — Remise globale ${globalDiscount} FCFA, Total ${totalXof} FCFA`,
        });
      }

      return { saleId, saleNumber, totalXof, paidXof, creditDueXof };
    });

    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

salesRouter.post('/sales/:id/cancel', requirePermission('pos'), (req: AuthedRequest, res) => {
  try {
    const saleId = Number(req.params.id);
    const { reason, supervisor_username, supervisor_secret } = req.body as {
      reason: string;
      supervisor_username?: string;
      supervisor_secret?: string;
    };
    if (!reason?.trim()) throw new Error('Motif d’annulation obligatoire.');

    // Supervisor validation required if cashier
    if (req.user!.role === 'CAISSIER') {
      if (!supervisor_username || !supervisor_secret || !verifySupervisorCredentials(supervisor_username, supervisor_secret)) {
        res.status(403).json({ error: 'L’annulation d’une vente validée nécessite l’autorisation du Gérant ou de l’Administrateur.' });
        return;
      }
    }

    runInTransaction((tx) => {
      const sale = tx.prepare('SELECT * FROM sales WHERE id = ?').get(saleId) as
        | { id: number; sale_number: string; status: string; paid_xof: number; payment_summary: string }
        | undefined;
      if (!sale) throw new Error('Vente introuvable.');
      if (sale.status === 'ANNULEE') throw new Error('Cette vente est déjà annulée.');

      const lines = tx.prepare('SELECT * FROM sale_lines WHERE sale_id = ?').all(saleId) as Array<{
        product_id: number;
        base_qty: number;
        returned_base_qty: number;
        unit_cost_xof: number;
      }>;
      const now = new Date().toISOString();

      for (const l of lines) {
        const qtyToRestore = l.base_qty - l.returned_base_qty;
        if (qtyToRestore > 0) {
          tx.prepare('UPDATE stock_balances SET physical_qty = physical_qty + ? WHERE product_id = ?').run(
            qtyToRestore,
            l.product_id,
          );
          tx.prepare(
            `INSERT INTO stock_movements (product_id, movement_type, qty_signed, unit_cost_xof, reference_doc, comment, user_id, created_at)
             VALUES (?, 'RETOUR_CLIENT', ?, ?, ?, ?, ?, ?)`,
          ).run(
            l.product_id,
            qtyToRestore,
            l.unit_cost_xof,
            sale.sale_number,
            `Annulation vente ${sale.sale_number} : ${reason.trim()}`,
            req.user!.id,
            now,
          );
        }
      }

      if (sale.paid_xof > 0) {
        const openSess = tx
          .prepare("SELECT id FROM cash_sessions WHERE status = 'OUVERTE' ORDER BY id DESC LIMIT 1")
          .get() as { id: number } | undefined;
        const lastCashMove = tx
          .prepare(
            `SELECT cm.payment_method, pm.is_cash
             FROM cash_movements cm
             LEFT JOIN payment_methods pm ON pm.code = cm.payment_method
             WHERE cm.reference_doc = ? AND cm.movement_type = 'VENTE_ENCAISSEMENT'
             ORDER BY cm.id DESC LIMIT 1`,
          )
          .get(sale.sale_number) as { payment_method: string; is_cash: number | null } | undefined;
        const matchedMethod = lastCashMove?.payment_method
          || (tx.prepare('SELECT code FROM payment_methods WHERE active = 1 ORDER BY is_cash DESC, id ASC LIMIT 1').get() as { code: string } | undefined)?.code
          || 'ESPECES';
        const method = matchedMethod;
        tx.prepare(
          `INSERT INTO cash_movements (session_id, movement_type, payment_method, amount_signed_xof, reference_doc, comment, user_id, created_at)
           VALUES (?, 'REMBOURSEMENT_CLIENT', ?, ?, ?, ?, ?, ?)`,
        ).run(
          openSess?.id ?? null,
          method,
          -sale.paid_xof,
          sale.sale_number,
          `Contrepassation annulation ${sale.sale_number}`,
          req.user!.id,
          now,
        );
        if (openSess && method === 'ESPECES') {
          tx.prepare('UPDATE cash_sessions SET theoretical_cash_xof = theoretical_cash_xof - ? WHERE id = ?').run(
            sale.paid_xof,
            openSess.id,
          );
        }
      }

      tx.prepare("UPDATE sales SET status = 'ANNULEE', credit_due_xof = 0 WHERE id = ?").run(saleId);

      writeAuditLog(tx, {
        userId: req.user!.id,
        userName: req.user!.full_name,
        action: 'ANNULATION_VENTE',
        entityType: 'VENTE',
        entityId: saleId,
        details: `Annulation traçable ${sale.sale_number} — Motif : ${reason.trim()}`,
      });
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

salesRouter.post('/sales/:id/return', requirePermission('pos'), (req: AuthedRequest, res) => {
  try {
    const saleId = Number(req.params.id);
    const { items, refund_method, restocked, reason } = req.body as {
      items: Array<{ sale_line_id: number; return_base_qty: number }>;
      refund_method: string;
      restocked: boolean;
      reason: string;
    };
    if (!items || items.length === 0) throw new Error('Sélectionnez au moins une ligne à retourner.');
    if (!reason?.trim()) throw new Error('Motif du retour obligatoire.');

    const resData = runInTransaction((tx) => {
      const sale = tx.prepare('SELECT * FROM sales WHERE id = ?').get(saleId) as
        | { id: number; sale_number: string; status: string; credit_due_xof: number; paid_xof: number }
        | undefined;
      if (!sale) throw new Error('Vente introuvable.');
      if (sale.status === 'ANNULEE') throw new Error('Impossible de retourner une vente annulée.');

      const now = new Date().toISOString();
      const retNum = nextDocumentNumber(tx, 'RET');
      let totalRefund = 0;

      const returnLinesToInsert: Array<{
        sale_line_id: number;
        product_id: number;
        base_qty: number;
        refund_xof: number;
        unit_cost_xof: number;
      }> = [];

      for (const it of items) {
        const retQty = toPositiveInt(it.return_base_qty, 'quantité retournée');
        const line = tx.prepare('SELECT * FROM sale_lines WHERE id = ? AND sale_id = ?').get(it.sale_line_id, saleId) as
          | {
              id: number;
              product_id: number;
              base_qty: number;
              returned_base_qty: number;
              line_total_xof: number;
              unit_cost_xof: number;
            }
          | undefined;
        if (!line) throw new Error('Ligne de vente introuvable.');

        const returnable = line.base_qty - line.returned_base_qty;
        if (retQty > returnable) {
          throw new Error(`Quantité retournée (${retQty}) supérieure au solde retournable (${returnable}).`);
        }

        const unitNetPrice = Math.round(line.line_total_xof / line.base_qty);
        const refundAmt = retQty * unitNetPrice;
        totalRefund += refundAmt;

        returnLinesToInsert.push({
          sale_line_id: line.id,
          product_id: line.product_id,
          base_qty: retQty,
          refund_xof: refundAmt,
          unit_cost_xof: line.unit_cost_xof,
        });

        tx.prepare('UPDATE sale_lines SET returned_base_qty = returned_base_qty + ? WHERE id = ?').run(retQty, line.id);

        if (restocked) {
          tx.prepare('UPDATE stock_balances SET physical_qty = physical_qty + ? WHERE product_id = ?').run(
            retQty,
            line.product_id,
          );
          tx.prepare(
            `INSERT INTO stock_movements (product_id, movement_type, qty_signed, unit_cost_xof, reference_doc, comment, user_id, created_at)
             VALUES (?, 'RETOUR_CLIENT', ?, ?, ?, ?, ?, ?)`,
          ).run(line.product_id, retQty, line.unit_cost_xof, retNum, `Retour client sur ${sale.sale_number}`, req.user!.id, now);
        } else {
          tx.prepare(
            `INSERT INTO stock_movements (product_id, movement_type, qty_signed, unit_cost_xof, reference_doc, comment, user_id, created_at)
             VALUES (?, 'CASSE', 0, ?, ?, ?, ?, ?)`,
          ).run(
            line.product_id,
            line.unit_cost_xof,
            retNum,
            `Retour non revendable/cassé sur ${sale.sale_number} (${retQty} unités)`,
            req.user!.id,
            now,
          );
        }
      }

      const rIns = tx
        .prepare(
          `INSERT INTO sale_returns (return_number, sale_id, total_refund_xof, refund_method, restocked, reason, user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(retNum, saleId, totalRefund, refund_method || 'ESPECES', restocked ? 1 : 0, reason.trim(), req.user!.id, now);
      const returnId = Number(rIns.lastInsertRowid);

      for (const rl of returnLinesToInsert) {
        tx.prepare(
          `INSERT INTO sale_return_lines (return_id, sale_line_id, product_id, base_qty, refund_xof) VALUES (?, ?, ?, ?, ?)`,
        ).run(returnId, rl.sale_line_id, rl.product_id, rl.base_qty, rl.refund_xof);
      }

      // Reduce credit due first if open credit exists, otherwise cash refund
      const creditReduction = Math.min(sale.credit_due_xof, totalRefund);
      const cashRefund = totalRefund - creditReduction;

      tx.prepare("UPDATE sales SET credit_due_xof = credit_due_xof - ?, status = 'REMBOURSEE_PARTIELLE' WHERE id = ?").run(
        creditReduction,
        saleId,
      );

      if (cashRefund > 0) {
        const openSess = tx
          .prepare("SELECT id FROM cash_sessions WHERE status = 'OUVERTE' ORDER BY id DESC LIMIT 1")
          .get() as { id: number } | undefined;
        tx.prepare(
          `INSERT INTO cash_movements (session_id, movement_type, payment_method, amount_signed_xof, reference_doc, comment, user_id, created_at)
           VALUES (?, 'REMBOURSEMENT_CLIENT', ?, ?, ?, ?, ?, ?)`,
        ).run(
          openSess?.id ?? null,
          refund_method || 'ESPECES',
          -cashRefund,
          retNum,
          `Remboursement retour sur ${sale.sale_number}`,
          req.user!.id,
          now,
        );
        if (openSess && (refund_method || 'ESPECES') === 'ESPECES') {
          tx.prepare('UPDATE cash_sessions SET theoretical_cash_xof = theoretical_cash_xof - ? WHERE id = ?').run(
            cashRefund,
            openSess.id,
          );
        }
      }

      writeAuditLog(tx, {
        userId: req.user!.id,
        userName: req.user!.full_name,
        action: 'RETOUR_CLIENT',
        entityType: 'VENTE',
        entityId: saleId,
        details: `${retNum} sur ${sale.sale_number} — Montant ${totalRefund} FCFA (${restocked ? 'réintégré en stock' : 'non revendable'})`,
      });

      return { returnNumber: retNum, totalRefund, cashRefund, creditReduction };
    });

    res.status(201).json(resData);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ==================== COMMANDES CLIENTS & LIVRAISONS ====================

salesRouter.get('/orders', requirePermission('orders'), (_req, res) => {
  const db = getDb();
  const orders = db
    .prepare(
      `SELECT co.*, c.name AS customer_name, c.phone AS customer_phone, u.full_name AS creator_name
       FROM customer_orders co
       JOIN customers c ON c.id = co.customer_id
       LEFT JOIN users u ON u.id = co.user_id
       ORDER BY co.id DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  const lineStmt = db.prepare('SELECT * FROM customer_order_lines WHERE order_id = ?');
  res.json(orders.map((o) => ({ ...o, lines: lineStmt.all(o.id as number) })));
});

salesRouter.post('/orders', requirePermission('orders'), (req: AuthedRequest, res) => {
  try {
    const body = req.body as {
      customer_id: number;
      desired_date?: string;
      delivery_address?: string;
      notes?: string;
      status?: 'BROUILLON' | 'CONFIRMEE';
      lines: Array<{ product_id: number; packaging_id: number; qty: number; unit_price_xof: number }>;
    };
    if (!body.lines || body.lines.length === 0) throw new Error('Ajoutez au moins un article à la commande.');

    const resData = runInTransaction((tx) => {
      const now = new Date().toISOString();
      const orderNum = nextDocumentNumber(tx, 'CMD');
      const status = body.status || 'CONFIRMEE';
      const settings = tx.prepare('SELECT reserve_stock_on_order FROM company_settings WHERE id = 1').get() as {
        reserve_stock_on_order: number;
      };

      let subtotal = 0;
      const orderLines: Array<{
        product_id: number;
        packaging_id: number;
        product_name: string;
        packaging_name: string;
        factor: number;
        qty: number;
        base_qty: number;
        unit_price_xof: number;
        line_total_xof: number;
      }> = [];

      for (const l of body.lines) {
        const qty = toPositiveInt(l.qty, 'quantité');
        const price = toIntXof(l.unit_price_xof, 'prix unitaire');
        const prod = tx.prepare('SELECT id, name FROM products WHERE id = ?').get(l.product_id) as {
          id: number;
          name: string;
        };
        const pack = tx
          .prepare('SELECT id, name, conversion_factor FROM product_packagings WHERE id = ?')
          .get(l.packaging_id) as { id: number; name: string; conversion_factor: number };
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
          line_total_xof: lineTotal,
        });
      }

      const ins = tx
        .prepare(
          `INSERT INTO customer_orders (order_number, customer_id, status, desired_date, delivery_address, notes, subtotal_xof, deposit_total_xof, total_xof, user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        )
        .run(
          orderNum,
          body.customer_id,
          status,
          body.desired_date || null,
          body.delivery_address?.trim() ?? '',
          body.notes?.trim() ?? '',
          subtotal,
          subtotal,
          req.user!.id,
          now,
        );
      const orderId = Number(ins.lastInsertRowid);

      for (const ol of orderLines) {
        tx.prepare(
          `INSERT INTO customer_order_lines (order_id, product_id, packaging_id, product_name, packaging_name, conversion_factor, qty, base_qty, unit_price_xof, line_total_xof)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          ol.line_total_xof,
        );

        if (status === 'CONFIRMEE' && settings.reserve_stock_on_order === 1) {
          tx.prepare('UPDATE stock_balances SET reserved_qty = reserved_qty + ? WHERE product_id = ?').run(
            ol.base_qty,
            ol.product_id,
          );
        }
      }

      return { orderId, orderNumber: orderNum };
    });

    res.status(201).json(resData);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

salesRouter.patch('/orders/:id/status', requirePermission('orders'), (req: AuthedRequest, res) => {
  try {
    const orderId = Number(req.params.id);
    const { status } = req.body as {
      status: 'CONFIRMEE' | 'EN_PREPARATION' | 'PRETE' | 'PARTIELLEMENT_LIVREE' | 'LIVREE' | 'ANNULEE';
    };

    runInTransaction((tx) => {
      const ord = tx.prepare('SELECT id, status, order_number FROM customer_orders WHERE id = ?').get(orderId) as
        | { id: number; status: string; order_number: string }
        | undefined;
      if (!ord) throw new Error('Commande introuvable.');

      const settings = tx.prepare('SELECT reserve_stock_on_order FROM company_settings WHERE id = 1').get() as {
        reserve_stock_on_order: number;
      };
      const lines = tx.prepare('SELECT product_id, base_qty FROM customer_order_lines WHERE order_id = ?').all(orderId) as Array<{
        product_id: number;
        base_qty: number;
      }>;

      if (ord.status === 'BROUILLON' && status === 'CONFIRMEE' && settings.reserve_stock_on_order === 1) {
        for (const l of lines) {
          tx.prepare('UPDATE stock_balances SET reserved_qty = reserved_qty + ? WHERE product_id = ?').run(
            l.base_qty,
            l.product_id,
          );
        }
      } else if (
        status === 'ANNULEE' &&
        ['CONFIRMEE', 'EN_PREPARATION', 'PRETE'].includes(ord.status) &&
        settings.reserve_stock_on_order === 1
      ) {
        for (const l of lines) {
          tx.prepare('UPDATE stock_balances SET reserved_qty = MAX(0, reserved_qty - ?) WHERE product_id = ?').run(
            l.base_qty,
            l.product_id,
          );
        }
      }

      tx.prepare('UPDATE customer_orders SET status = ? WHERE id = ?').run(status, orderId);
      writeAuditLog(tx, {
        userId: req.user!.id,
        userName: req.user!.full_name,
        action: 'STATUT_COMMANDE',
        entityType: 'COMMANDE',
        entityId: orderId,
        details: `${ord.order_number} -> ${status}`,
      });
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

salesRouter.post('/orders/:id/convert', requirePermission('orders'), (req: AuthedRequest, res) => {
  try {
    const orderId = Number(req.params.id);
    const { payment_method, paid_xof } = req.body as { payment_method?: string; paid_xof?: number };

    const out = runInTransaction((tx) => {
      const ord = tx.prepare('SELECT * FROM customer_orders WHERE id = ?').get(orderId) as
        | {
            id: number;
            order_number: string;
            customer_id: number;
            status: string;
            total_xof: number;
            converted_sale_id: number | null;
          }
        | undefined;
      if (!ord) throw new Error('Commande introuvable.');
      if (ord.converted_sale_id) throw new Error('Cette commande a déjà été transformée en vente.');

      const cust = tx.prepare('SELECT id, price_list_id FROM customers WHERE id = ?').get(ord.customer_id) as {
        id: number;
        price_list_id: number;
      };
      const lines = tx.prepare('SELECT * FROM customer_order_lines WHERE order_id = ?').all(orderId) as Array<{
        product_id: number;
        packaging_id: number | null;
        product_name: string;
        packaging_name: string;
        conversion_factor: number;
        qty: number;
        base_qty: number;
        unit_price_xof: number;
        line_total_xof: number;
      }>;

      const settings = tx.prepare('SELECT reserve_stock_on_order FROM company_settings WHERE id = 1').get() as {
        reserve_stock_on_order: number;
      };

      const now = new Date().toISOString();
      const saleNumber = nextDocumentNumber(tx, 'VTE');
      const paid = toIntXof(paid_xof ?? ord.total_xof, 'montant payé');
      const credit = Math.max(0, ord.total_xof - paid);
      const method = payment_method || 'ESPECES';

      const sIns = tx
        .prepare(
          `INSERT INTO sales (
            sale_number, customer_id, price_list_id, status, subtotal_xof, discount_xof, tax_xof,
            deposit_xof, total_xof, paid_xof, credit_due_xof, payment_summary, notes, user_id, created_at
          ) VALUES (?, ?, ?, 'VALIDEE', ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          saleNumber,
          ord.customer_id,
          cust.price_list_id,
          ord.total_xof,
          ord.total_xof,
          paid,
          credit,
          credit > 0 ? `${method} + Crédit` : method,
          `Issu de la commande ${ord.order_number}`,
          req.user!.id,
          now,
        );
      const saleId = Number(sIns.lastInsertRowid);

      for (const l of lines) {
        const prod = tx.prepare('SELECT purchase_cost_xof FROM products WHERE id = ?').get(l.product_id) as {
          purchase_cost_xof: number;
        };
        tx.prepare(
          `INSERT INTO sale_lines (
            sale_id, product_id, packaging_id, product_name, packaging_name, conversion_factor,
            qty, base_qty, unit_price_xof, discount_xof, unit_cost_xof, line_total_xof, deposit_xof
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0)`,
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
          l.line_total_xof,
        );

        // Release reservation if reserved, then deduct physical stock once
        if (['CONFIRMEE', 'EN_PREPARATION', 'PRETE'].includes(ord.status) && settings.reserve_stock_on_order === 1) {
          tx.prepare('UPDATE stock_balances SET reserved_qty = MAX(0, reserved_qty - ?) WHERE product_id = ?').run(
            l.base_qty,
            l.product_id,
          );
        }
        tx.prepare('UPDATE stock_balances SET physical_qty = physical_qty - ? WHERE product_id = ?').run(
          l.base_qty,
          l.product_id,
        );
        tx.prepare(
          `INSERT INTO stock_movements (product_id, movement_type, qty_signed, unit_cost_xof, reference_doc, comment, user_id, created_at)
           VALUES (?, 'VENTE_SORTIE', ?, ?, ?, ?, ?, ?)`,
        ).run(l.product_id, -l.base_qty, prod.purchase_cost_xof, saleNumber, `Conversion commande ${ord.order_number}`, req.user!.id, now);
      }

      if (paid > 0) {
        const openSess = tx
          .prepare("SELECT id FROM cash_sessions WHERE status = 'OUVERTE' ORDER BY id DESC LIMIT 1")
          .get() as { id: number } | undefined;
        tx.prepare(
          `INSERT INTO cash_movements (session_id, movement_type, payment_method, amount_signed_xof, reference_doc, comment, user_id, created_at)
           VALUES (?, 'VENTE_ENCAISSEMENT', ?, ?, ?, ?, ?, ?)`,
        ).run(openSess?.id ?? null, method, paid, saleNumber, `Encaissement commande ${ord.order_number}`, req.user!.id, now);
        if (openSess && method === 'ESPECES') {
          tx.prepare('UPDATE cash_sessions SET theoretical_cash_xof = theoretical_cash_xof + ? WHERE id = ?').run(
            paid,
            openSess.id,
          );
        }
      }

      tx.prepare("UPDATE customer_orders SET status = 'LIVREE', converted_sale_id = ? WHERE id = ?").run(
        saleId,
        orderId,
      );

      return { saleId, saleNumber };
    });

    res.status(201).json(out);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

salesRouter.get('/deliveries', requirePermission('deliveries'), (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT d.*, c.name AS customer_name, c.phone AS customer_phone,
              co.order_number, co.total_xof AS order_total_xof, s.sale_number
       FROM deliveries d
       JOIN customers c ON c.id = d.customer_id
       LEFT JOIN customer_orders co ON co.id = d.order_id
       LEFT JOIN sales s ON s.id = d.sale_id
       ORDER BY d.id DESC`,
    )
    .all();
  res.json(rows);
});

salesRouter.post('/deliveries', requirePermission('deliveries'), (req: AuthedRequest, res) => {
  try {
    const { order_id, sale_id, customer_id, driver_name, vehicle, address, scheduled_date, fee_xof } = req.body as {
      order_id?: number;
      sale_id?: number;
      customer_id: number;
      driver_name: string;
      vehicle?: string;
      address: string;
      scheduled_date: string;
      fee_xof?: number;
    };
    const fee = toIntXof(fee_xof ?? 0, 'frais de livraison');
    const db = getDb();
    const livNum = nextDocumentNumber(db, 'LIV');
    const ins = db
      .prepare(
        `INSERT INTO deliveries (delivery_number, order_id, sale_id, customer_id, driver_name, vehicle, address, scheduled_date, fee_xof, status, user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PLANIFIEE', ?, ?)`,
      )
      .run(
        livNum,
        order_id || null,
        sale_id || null,
        customer_id,
        driver_name.trim(),
        vehicle?.trim() ?? '',
        address.trim(),
        scheduled_date,
        fee,
        req.user!.id,
        new Date().toISOString(),
      );
    res.status(201).json({ id: Number(ins.lastInsertRowid), delivery_number: livNum });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

salesRouter.patch('/deliveries/:id/status', requirePermission('deliveries'), (req: AuthedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const { status, proof_note, collected_xof } = req.body as {
      status: 'PLANIFIEE' | 'EN_COURS' | 'LIVREE_PARTIELLE' | 'LIVREE' | 'ECHEC';
      proof_note?: string;
      collected_xof?: number;
    };
    const collected = toIntXof(collected_xof ?? 0, 'montant encaissé');

    runInTransaction((tx) => {
      const deliv = tx.prepare('SELECT id, delivery_number, order_id FROM deliveries WHERE id = ?').get(id) as
        | { id: number; delivery_number: string; order_id: number | null }
        | undefined;
      if (!deliv) throw new Error('Livraison introuvable.');

      tx.prepare('UPDATE deliveries SET status = ?, proof_note = ?, collected_xof = ? WHERE id = ?').run(
        status,
        proof_note?.trim() ?? '',
        collected,
        id,
      );
      if (deliv.order_id && status === 'LIVREE') {
        tx.prepare("UPDATE customer_orders SET status = 'LIVREE' WHERE id = ?").run(deliv.order_id);
      } else if (deliv.order_id && status === 'LIVREE_PARTIELLE') {
        tx.prepare("UPDATE customer_orders SET status = 'PARTIELLEMENT_LIVREE' WHERE id = ?").run(deliv.order_id);
      }
      writeAuditLog(tx, {
        userId: req.user!.id,
        userName: req.user!.full_name,
        action: 'STATUT_LIVRAISON',
        entityType: 'LIVRAISON',
        entityId: id,
        details: `${deliv.delivery_number} -> ${status} (${proof_note?.trim() || 'RAS'})`,
      });
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
