import React, { useEffect, useState } from 'react';
import { PackageCheck, Plus, Sparkles } from 'lucide-react';
import { apiFetch } from '../utils/api';
import { formatDate, formatXOF } from '../utils/format';
import type { CatalogMeta, Product } from '../types';

interface PurchaseOrder {
  id: number;
  po_number: string;
  supplier_id: number;
  supplier_name: string;
  status: string;
  expected_date: string | null;
  shipping_fee_xof: number;
  total_xof: number;
  paid_xof: number;
  created_at: string;
  lines: Array<{
    id: number;
    product_id: number;
    product_name: string;
    packaging_name: string;
    conversion_factor: number;
    qty_ordered: number;
    qty_received: number;
    unit_cost_xof: number;
    line_total_xof: number;
  }>;
  receipts: Array<{ id: number; receipt_number: string; total_value_xof: number; created_at: string }>;
}

interface ReorderSuggestion {
  id: number;
  sku: string;
  name: string;
  supplier_id: number | null;
  supplier_name: string | null;
  available_qty: number;
  min_threshold: number;
  safety_stock: number;
  expected_qty: number;
  pack_name: string;
  pack_factor: number;
  recommended_packs: number;
  estimated_cost_xof: number;
}

export const PurchasesPage: React.FC = () => {
  const [tab, setTab] = useState<'commandes' | 'suggestions'>('commandes');
  const [pos, setPos] = useState<PurchaseOrder[]>([]);
  const [suggestions, setSuggestions] = useState<ReorderSuggestion[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [meta, setMeta] = useState<CatalogMeta | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [supplierId, setSupplierId] = useState<number | ''>('');
  const [expectedDate, setExpectedDate] = useState(() => new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10));
  const [shippingFee, setShippingFee] = useState(0);
  const [draftLines, setDraftLines] = useState<
    Array<{ product_id: number; packaging_id: number; name: string; packName: string; qty: number; unit_cost_xof: number }>
  >([]);
  const [selProdId, setSelProdId] = useState<number | ''>('');
  const [selQty, setSelQty] = useState(1);

  // Goods receipt modal
  const [receivePo, setReceivePo] = useState<PurchaseOrder | null>(null);
  const [receiveLines, setReceiveLines] = useState<
    Array<{
      po_line_id: number;
      product_name: string;
      packaging_name: string;
      remaining: number;
      qty_received: number;
      qty_rejected: number;
      unit_cost_xof: number;
      batch_number: string;
      expiry_date: string;
    }>
  >([]);
  const [receiveNotes, setReceiveNotes] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    const [poList, sugList, prods, m] = await Promise.all([
      apiFetch<PurchaseOrder[]>('/api/purchases'),
      apiFetch<ReorderSuggestion[]>('/api/purchases/suggestions'),
      apiFetch<Product[]>('/api/products'),
      apiFetch<CatalogMeta>('/api/catalog/meta'),
    ]);
    setPos(poList);
    setSuggestions(sugList);
    setProducts(prods);
    setMeta(m);
    setSelProdId((prev) => (prev && prods.some((p) => p.id === prev) ? prev : (prods[0]?.id ?? '')));
    setSupplierId((prev) => (prev && m.suppliers.some((s) => s.id === prev) ? prev : (m.suppliers[0]?.id ?? '')));
  };

  useEffect(() => {
    void loadData();
  }, []);

  const addPoLine = () => {
    if (!selProdId) return;
    const prod = products.find((p) => p.id === Number(selProdId));
    if (!prod) return;
    const pack = prod.packagings.find((pk) => pk.is_default_purchase === 1) || prod.packagings[0];
    if (!pack) return;
    const packCost = prod.purchase_cost_xof * pack.conversion_factor;
    setDraftLines((prev) => [
      ...prev,
      {
        product_id: prod.id,
        packaging_id: pack.id,
        name: prod.name,
        packName: pack.name,
        qty: selQty,
        unit_cost_xof: packCost,
      },
    ]);
  };

  const handleCreatePo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supplierId || draftLines.length === 0) return;
    setError(null);
    try {
      const res = await apiFetch<{ poNumber: string }>('/api/purchases', {
        method: 'POST',
        body: JSON.stringify({
          supplier_id: Number(supplierId),
          expected_date: expectedDate,
          shipping_fee_xof: shippingFee,
          lines: draftLines.map((l) => ({
            product_id: l.product_id,
            packaging_id: l.packaging_id,
            qty_ordered: l.qty,
            unit_cost_xof: l.unit_cost_xof,
          })),
        }),
      });
      setCreateOpen(false);
      setDraftLines([]);
      setMsg(`Commande d’achat ${res.poNumber} confirmée (le stock sera crédité à la réception).`);
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const preparePoFromSuggestion = (s: ReorderSuggestion) => {
    const prod = products.find((p) => p.id === s.id);
    if (!prod) return;
    const pack = prod.packagings.find((pk) => pk.is_default_purchase === 1) || prod.packagings[0];
    if (s.supplier_id) setSupplierId(s.supplier_id);
    setDraftLines([
      {
        product_id: prod.id,
        packaging_id: pack.id,
        name: prod.name,
        packName: pack.name,
        qty: s.recommended_packs,
        unit_cost_xof: prod.purchase_cost_xof * pack.conversion_factor,
      },
    ]);
    setCreateOpen(true);
  };

  const openReceiveModal = (po: PurchaseOrder) => {
    setReceivePo(po);
    setReceiveNotes('');
    setError(null);
    setReceiveLines(
      po.lines
        .filter((l) => l.qty_ordered - l.qty_received > 0)
        .map((l) => ({
          po_line_id: l.id,
          product_name: l.product_name,
          packaging_name: l.packaging_name,
          remaining: l.qty_ordered - l.qty_received,
          qty_received: l.qty_ordered - l.qty_received,
          qty_rejected: 0,
          unit_cost_xof: l.unit_cost_xof,
          batch_number: '',
          expiry_date: '',
        })),
    );
  };

  const handleReceive = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!receivePo) return;
    setError(null);
    try {
      const res = await apiFetch<{ receiptNumber: string; newStatus: string }>(`/api/purchases/${receivePo.id}/receive`, {
        method: 'POST',
        body: JSON.stringify({
          notes: receiveNotes,
          lines: receiveLines.map((l) => ({
            po_line_id: l.po_line_id,
            qty_received: l.qty_received,
            qty_rejected: l.qty_rejected,
            unit_cost_xof: l.unit_cost_xof,
            batch_number: l.batch_number || undefined,
            expiry_date: l.expiry_date || undefined,
          })),
        }),
      });
      setReceivePo(null);
      setMsg(`Réception ${res.receiptNumber} validée (${res.newStatus}). Stock et CUMP mis à jour.`);
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          <button
            type="button"
            onClick={() => setTab('commandes')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              tab === 'commandes' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Commandes & Réceptions ({pos.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('suggestions')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              tab === 'suggestions' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Suggestions réapprovisionnement ({suggestions.length})
          </button>
        </div>

        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="px-3.5 py-2 text-xs font-semibold bg-teal-700 hover:bg-teal-800 text-white rounded-lg flex items-center gap-1.5 cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          Nouvel achat fournisseur
        </button>
      </div>

      {msg && <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800">{msg}</div>}

      {tab === 'commandes' ? (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">N° Achat</th>
                <th className="text-left px-4 py-3 font-semibold">Fournisseur</th>
                <th className="text-left px-4 py-3 font-semibold">Détail lignes (Reçu / Cmd)</th>
                <th className="text-left px-4 py-3 font-semibold">Livraison prévue</th>
                <th className="text-right px-4 py-3 font-semibold">Total</th>
                <th className="text-left px-4 py-3 font-semibold">Statut</th>
                <th className="text-right px-4 py-3 font-semibold">Réception</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pos.map((po) => (
                <tr key={po.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-mono font-semibold text-slate-900">
                    {po.po_number}
                    {po.receipts.length > 0 && (
                      <div className="text-[10px] text-slate-500">
                        {po.receipts.map((r) => r.receipt_number).join(', ')}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-medium text-slate-900">{po.supplier_name}</td>
                  <td className="px-4 py-2.5 text-slate-600">
                    {po.lines.map((l) => (
                      <div key={l.id}>
                        {l.product_name} : <span className="font-mono">{l.qty_received}/{l.qty_ordered}</span> {l.packaging_name}
                      </div>
                    ))}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{formatDate(po.expected_date)}</td>
                  <td className="px-4 py-2.5 text-right font-mono font-semibold tabular-nums">
                    {formatXOF(po.total_xof)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`font-semibold ${
                        po.status === 'RECUE'
                          ? 'text-emerald-700'
                          : po.status === 'PARTIELLE'
                            ? 'text-amber-700'
                            : 'text-slate-700'
                      }`}
                    >
                      {po.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {(po.status === 'CONFIRMEE' || po.status === 'PARTIELLE') && (
                      <button
                        type="button"
                        onClick={() => openReceiveModal(po)}
                        className="text-teal-700 hover:underline font-semibold inline-flex items-center gap-1 cursor-pointer"
                      >
                        <PackageCheck className="w-3.5 h-3.5" />
                        Réceptionner
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {pos.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                    Aucune commande d’achat enregistrée. Créez d’abord un fournisseur et des produits pour passer votre première commande.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 text-xs text-slate-600 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-teal-700" />
            <span>
              Calcul automatique : Besoin estimé + Stock sécurité − Stock disponible − Commandes déjà attendues.
            </span>
          </div>
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">Produit</th>
                <th className="text-left px-4 py-3 font-semibold">Fournisseur habituel</th>
                <th className="text-right px-4 py-3 font-semibold">Dispo / Seuil</th>
                <th className="text-right px-4 py-3 font-semibold">Attendu</th>
                <th className="text-right px-4 py-3 font-semibold">Recommandé</th>
                <th className="text-right px-4 py-3 font-semibold">Budget estimé</th>
                <th className="text-right px-4 py-3 font-semibold">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {suggestions.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-2.5 font-medium text-slate-900">
                    {s.name}
                    <div className="text-[11px] text-slate-500 font-mono">{s.sku}</div>
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">{s.supplier_name || 'À définir'}</td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums text-amber-700 font-semibold">
                    {s.available_qty} / {s.min_threshold}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums">{s.expected_qty}</td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums font-bold text-teal-800">
                    {s.recommended_packs} × {s.pack_name}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatXOF(s.estimated_cost_xof)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      type="button"
                      onClick={() => preparePoFromSuggestion(s)}
                      className="text-teal-700 hover:underline font-semibold cursor-pointer"
                    >
                      Préparer commande
                    </button>
                  </td>
                </tr>
              ))}
              {suggestions.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    Tous les produits sont au-dessus de leur seuil minimum.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Create PO Modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleCreatePo}
            className="bg-white border border-slate-200 rounded-xl w-full max-w-xl p-6 space-y-4 shadow-lg text-xs"
          >
            <h3 className="font-display font-bold text-base text-slate-900">Nouvelle commande d’achat</h3>
            {error && <div className="p-2 bg-red-50 border border-red-200 rounded text-red-700">{error}</div>}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Fournisseur</label>
                <select
                  required
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value ? Number(e.target.value) : '')}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                >
                  <option value="">
                    {meta?.suppliers.length ? 'Sélectionner un fournisseur...' : 'Aucun fournisseur enregistré'}
                  </option>
                  {meta?.suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Date prévue</label>
                <input
                  type="date"
                  value={expectedDate}
                  onChange={(e) => setExpectedDate(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Frais approche (FCFA)</label>
                <input
                  type="number"
                  min={0}
                  value={shippingFee}
                  onChange={(e) => setShippingFee(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono"
                />
              </div>
            </div>

            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
              <div className="flex gap-2">
                <select
                  value={selProdId}
                  onChange={(e) => setSelProdId(e.target.value ? Number(e.target.value) : '')}
                  className="flex-1 px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                >
                  <option value="">
                    {products.length ? 'Sélectionner un produit...' : 'Aucun produit dans le catalogue'}
                  </option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={1}
                  value={selQty}
                  onChange={(e) => setSelQty(Math.max(1, Number(e.target.value) || 1))}
                  className="w-20 text-center px-2 py-1.5 border border-slate-300 rounded font-mono bg-white"
                />
                <button
                  type="button"
                  onClick={addPoLine}
                  className="px-3 py-1.5 bg-slate-900 text-white rounded cursor-pointer"
                >
                  Ajouter
                </button>
              </div>
              {draftLines.map((dl, idx) => (
                <div key={idx} className="flex items-center justify-between py-1 border-b border-slate-200/70">
                  <span>
                    {dl.qty} × {dl.name} ({dl.packName})
                  </span>
                  <span className="font-mono font-semibold">{formatXOF(dl.qty * dl.unit_cost_xof)}</span>
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="px-4 py-2 bg-slate-100 rounded-lg cursor-pointer"
              >
                Annuler
              </button>
              <button
                type="submit"
                disabled={!supplierId || draftLines.length === 0}
                className="px-4 py-2 font-semibold bg-teal-700 disabled:opacity-40 text-white rounded-lg cursor-pointer"
              >
                Confirmer la commande
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Receive Goods Modal */}
      {receivePo && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleReceive}
            className="bg-white border border-slate-200 rounded-xl w-full max-w-2xl p-6 space-y-4 shadow-lg text-xs"
          >
            <h3 className="font-display font-bold text-base text-slate-900">
              Réception physique — {receivePo.po_number} ({receivePo.supplier_name})
            </h3>
            <p className="text-slate-600">
              Seules les quantités reçues entrent en stock et mettent à jour le Coût Moyen Pondéré (CUMP).
            </p>
            {error && <div className="p-2 bg-red-50 border border-red-200 rounded text-red-700">{error}</div>}

            <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto">
              {receiveLines.map((rl, idx) => (
                <div key={rl.po_line_id} className="py-2.5 grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-5">
                    <div className="font-medium text-slate-900">{rl.product_name}</div>
                    <div className="text-[11px] text-slate-500">
                      {rl.packaging_name} · Reliquat : {rl.remaining}
                    </div>
                  </div>
                  <div className="col-span-3">
                    <label className="block text-[10px] text-slate-500">Qté reçue</label>
                    <input
                      type="number"
                      min={0}
                      max={rl.remaining}
                      value={rl.qty_received}
                      onChange={(e) => {
                        const v = Math.min(rl.remaining, Math.max(0, Number(e.target.value) || 0));
                        setReceiveLines((prev) => prev.map((x, i) => (i === idx ? { ...x, qty_received: v } : x)));
                      }}
                      className="w-full px-2 py-1 border border-slate-300 rounded font-mono"
                    />
                  </div>
                  <div className="col-span-4">
                    <label className="block text-[10px] text-slate-500">Coût cond. (FCFA)</label>
                    <input
                      type="number"
                      min={0}
                      value={rl.unit_cost_xof}
                      onChange={(e) => {
                        const v = Math.max(0, Math.round(Number(e.target.value) || 0));
                        setReceiveLines((prev) => prev.map((x, i) => (i === idx ? { ...x, unit_cost_xof: v } : x)));
                      }}
                      className="w-full px-2 py-1 border border-slate-300 rounded font-mono"
                    />
                  </div>
                </div>
              ))}
            </div>

            <div>
              <label className="block font-medium text-slate-700 mb-1">Observations / N° bordereau livraison</label>
              <input
                type="text"
                value={receiveNotes}
                onChange={(e) => setReceiveNotes(e.target.value)}
                placeholder="N° bon de livraison ou remarque"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setReceivePo(null)}
                className="px-4 py-2 bg-slate-100 rounded-lg cursor-pointer"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="px-4 py-2 font-semibold bg-teal-700 text-white rounded-lg cursor-pointer"
              >
                Valider l’entrée en stock
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
