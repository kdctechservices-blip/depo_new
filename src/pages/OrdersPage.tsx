import React, { useEffect, useState } from 'react';
import { ArrowRightCircle, FileText, Plus } from 'lucide-react';
import { apiFetch } from '../utils/api';
import { exportToPDF, formatDate, formatXOF } from '../utils/format';
import type { CompanySettings, Customer, Product } from '../types';

interface OrderRow {
  id: number;
  order_number: string;
  customer_id: number;
  customer_name: string;
  status: string;
  desired_date: string | null;
  delivery_address: string;
  total_xof: number;
  converted_sale_id: number | null;
  created_at: string;
  lines: Array<{
    id: number;
    product_name: string;
    packaging_name: string;
    qty: number;
    unit_price_xof: number;
    line_total_xof: number;
  }>;
}

export const OrdersPage: React.FC<{ company: CompanySettings | null }> = ({ company }) => {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [createOpen, setCreateOpen] = useState(false);

  const [custId, setCustId] = useState<number | ''>('');
  const [desiredDate, setDesiredDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [address, setAddress] = useState('');
  const [lineProdId, setLineProdId] = useState<number | ''>('');
  const [lineQty, setLineQty] = useState(1);
  const [draftLines, setDraftLines] = useState<
    Array<{ product_id: number; packaging_id: number; name: string; packName: string; qty: number; price: number }>
  >([]);
  const [msg, setMsg] = useState<string | null>(null);

  const loadData = async () => {
    const [ords, custs, prods] = await Promise.all([
      apiFetch<OrderRow[]>('/api/orders'),
      apiFetch<Customer[]>('/api/customers'),
      apiFetch<Product[]>('/api/products'),
    ]);
    setOrders(ords);
    setCustomers(custs);
    setProducts(prods);
    setCustId((prev) => (prev && custs.some((c) => c.id === prev) ? prev : (custs[0]?.id ?? '')));
    setLineProdId((prev) => (prev && prods.some((p) => p.id === prev) ? prev : (prods[0]?.id ?? '')));
  };

  useEffect(() => {
    void loadData();
  }, []);

  const addDraftLine = () => {
    if (!lineProdId) return;
    const prod = products.find((p) => p.id === Number(lineProdId));
    if (!prod) return;
    const pack = prod.packagings.find((pk) => pk.is_default_sale === 1) || prod.packagings[0];
    if (!pack) return;
    const cust = customers.find((c) => c.id === Number(custId));
    const price =
      prod.prices.find((pr) => pr.packaging_id === pack.id && pr.price_list_id === (cust?.price_list_id ?? 1))
        ?.price_xof ?? 0;

    setDraftLines((prev) => [
      ...prev,
      { product_id: prod.id, packaging_id: pack.id, name: prod.name, packName: pack.name, qty: lineQty, price },
    ]);
  };

  const handleCreateOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!custId || draftLines.length === 0) return;
    await apiFetch('/api/orders', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: Number(custId),
        desired_date: desiredDate,
        delivery_address: address,
        status: 'CONFIRMEE',
        lines: draftLines.map((l) => ({
          product_id: l.product_id,
          packaging_id: l.packaging_id,
          qty: l.qty,
          unit_price_xof: l.price,
        })),
      }),
    });
    setCreateOpen(false);
    setDraftLines([]);
    setAddress('');
    setMsg('Commande client créée.');
    await loadData();
  };

  const updateStatus = async (id: number, status: string) => {
    await apiFetch(`/api/orders/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    await loadData();
  };

  const convertToSale = async (o: OrderRow) => {
    const res = await apiFetch<{ saleNumber: string }>(`/api/orders/${o.id}/convert`, {
      method: 'POST',
      body: JSON.stringify({ payment_method: 'ESPECES', paid_xof: o.total_xof }),
    });
    setMsg(`Commande ${o.order_number} convertie en vente ${res.saleNumber}.`);
    await loadData();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-600">
          Suivi des commandes clients avec réservation paramétrable du stock disponible.
        </p>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="px-3.5 py-2 text-xs font-semibold bg-teal-700 hover:bg-teal-800 text-white rounded-lg flex items-center gap-1.5 cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          Nouvelle commande
        </button>
      </div>

      {msg && <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800">{msg}</div>}

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
            <tr>
              <th className="text-left px-4 py-3 font-semibold">N° Commande</th>
              <th className="text-left px-4 py-3 font-semibold">Client</th>
              <th className="text-left px-4 py-3 font-semibold">Articles</th>
              <th className="text-left px-4 py-3 font-semibold">Date souhaitée</th>
              <th className="text-right px-4 py-3 font-semibold">Total</th>
              <th className="text-left px-4 py-3 font-semibold">Statut</th>
              <th className="text-right px-4 py-3 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {orders.map((o) => (
              <tr key={o.id} className="hover:bg-slate-50">
                <td className="px-4 py-2.5 font-mono font-semibold text-slate-900">{o.order_number}</td>
                <td className="px-4 py-2.5">
                  <div className="font-medium text-slate-900">{o.customer_name}</div>
                  <div className="text-[11px] text-slate-500">{o.delivery_address}</div>
                </td>
                <td className="px-4 py-2.5 text-slate-600">
                  {o.lines.map((l) => `${l.qty} × ${l.product_name}`).join(', ')}
                </td>
                <td className="px-4 py-2.5 tabular-nums">{formatDate(o.desired_date)}</td>
                <td className="px-4 py-2.5 text-right font-mono font-semibold tabular-nums">
                  {formatXOF(o.total_xof)}
                </td>
                <td className="px-4 py-2.5">
                  <select
                    value={o.status}
                    disabled={Boolean(o.converted_sale_id)}
                    onChange={(e) => void updateStatus(o.id, e.target.value)}
                    className="px-2 py-1 text-[11px] border border-slate-300 rounded bg-white"
                  >
                    <option value="BROUILLON">Brouillon</option>
                    <option value="CONFIRMEE">Confirmée</option>
                    <option value="EN_PREPARATION">En préparation</option>
                    <option value="PRETE">Prête</option>
                    <option value="LIVREE">Livrée</option>
                    <option value="ANNULEE">Annulée</option>
                  </select>
                </td>
                <td className="px-4 py-2.5 text-right space-x-2 whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() =>
                      exportToPDF({
                        title: `Bon de préparation ${o.order_number}`,
                        subtitle: `Client : ${o.customer_name} · Livraison : ${o.delivery_address || 'Comptoir'}`,
                        company,
                        columns: ['Produit', 'Conditionnement', 'Qté', 'P.U.', 'Total'],
                        rows: o.lines.map((l) => [
                          l.product_name,
                          l.packaging_name,
                          l.qty,
                          formatXOF(l.unit_price_xof),
                          formatXOF(l.line_total_xof),
                        ]),
                        totalsLine: `Total commande : ${formatXOF(o.total_xof)}`,
                        filename: `${o.order_number}.pdf`,
                      })
                    }
                    className="text-slate-600 hover:text-slate-900 cursor-pointer"
                    title="Bon de préparation PDF"
                  >
                    <FileText className="w-3.5 h-3.5 inline" />
                  </button>
                  {!o.converted_sale_id && o.status !== 'ANNULEE' && (
                    <button
                      type="button"
                      onClick={() => void convertToSale(o)}
                      className="text-teal-700 hover:underline font-semibold cursor-pointer inline-flex items-center gap-1"
                    >
                      <ArrowRightCircle className="w-3.5 h-3.5" />
                      Facturer
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                  Aucune commande client enregistrée pour le moment.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {createOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateOrder}
            className="bg-white border border-slate-200 rounded-xl w-full max-w-lg p-6 space-y-4 shadow-lg text-xs"
          >
            <h3 className="font-display font-bold text-base text-slate-900">Nouvelle commande client</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Client</label>
                <select
                  value={custId}
                  onChange={(e) => setCustId(e.target.value ? Number(e.target.value) : '')}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                >
                  <option value="">Sélectionner un client...</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Date livraison souhaitée</label>
                <input
                  type="date"
                  value={desiredDate}
                  onChange={(e) => setDesiredDate(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Adresse de livraison</label>
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Adresse de livraison"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>

            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
              <div className="flex gap-2">
                <select
                  value={lineProdId}
                  onChange={(e) => setLineProdId(e.target.value ? Number(e.target.value) : '')}
                  className="flex-1 px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                >
                  <option value="">
                    {products.length ? 'Sélectionner un produit...' : 'Aucun produit dans le catalogue'}
                  </option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} (dispo {p.available_qty})
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={1}
                  value={lineQty}
                  onChange={(e) => setLineQty(Math.max(1, Number(e.target.value) || 1))}
                  className="w-16 text-center px-2 py-1.5 border border-slate-300 rounded font-mono bg-white"
                />
                <button
                  type="button"
                  onClick={addDraftLine}
                  className="px-3 py-1.5 bg-slate-900 text-white rounded cursor-pointer"
                >
                  Ajouter
                </button>
              </div>
              {draftLines.map((dl, idx) => (
                <div key={idx} className="flex justify-between py-1 border-b border-slate-200/70">
                  <span>
                    {dl.qty} × {dl.name} ({dl.packName})
                  </span>
                  <span className="font-mono font-semibold">{formatXOF(dl.qty * dl.price)}</span>
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
                disabled={draftLines.length === 0}
                className="px-4 py-2 font-semibold bg-teal-700 disabled:opacity-40 text-white rounded-lg cursor-pointer"
              >
                Confirmer & réserver stock
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
