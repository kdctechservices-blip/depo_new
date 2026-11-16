import React, { useEffect, useState } from 'react';
import { CreditCard, Plus } from 'lucide-react';
import { apiFetch } from '../utils/api';
import { formatXOF } from '../utils/format';
import type { CatalogMeta } from '../types';

interface SupplierRow {
  id: number;
  code: string;
  name: string;
  contact_name: string;
  phone: string;
  address: string;
  payment_terms: string;
  lead_time_days: number;
  total_purchased_xof: number;
  total_paid_xof: number;
  balance_due_xof: number;
}

export const SuppliersPage: React.FC = () => {
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<CatalogMeta['paymentMethods']>([]);
  const [newOpen, setNewOpen] = useState(false);
  const [payTarget, setPayTarget] = useState<SupplierRow | null>(null);

  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [terms, setTerms] = useState('');
  const [lead, setLead] = useState(1);

  const [payAmount, setPayAmount] = useState(0);
  const [payMethod, setPayMethod] = useState('ESPECES');
  const [payRef, setPayRef] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    const [sups, meta] = await Promise.all([
      apiFetch<SupplierRow[]>('/api/suppliers'),
      apiFetch<CatalogMeta>('/api/catalog/meta'),
    ]);
    setSuppliers(sups);
    setPaymentMethods(meta.paymentMethods);
    if (meta.paymentMethods.length > 0 && !meta.paymentMethods.some((pm) => pm.code === payMethod)) {
      setPayMethod(meta.paymentMethods[0].code);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/suppliers', {
        method: 'POST',
        body: JSON.stringify({
          name,
          contact_name: contact,
          phone,
          address,
          payment_terms: terms,
          lead_time_days: lead,
        }),
      });
      setNewOpen(false);
      setName('');
      setContact('');
      setPhone('');
      setAddress('');
      setMsg('Fournisseur enregistré.');
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handlePay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payTarget) return;
    setError(null);
    try {
      const res = await apiFetch<{ payNum: string }>('/api/suppliers/payments', {
        method: 'POST',
        body: JSON.stringify({
          supplier_id: payTarget.id,
          amount_xof: payAmount,
          payment_method: payMethod,
          reference_note: payRef,
        }),
      });
      setPayTarget(null);
      setPayRef('');
      setMsg(`Règlement fournisseur ${res.payNum} enregistré.`);
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-600">
          Référentiel des brasseries et distributeurs, délais de livraison et soldes dus.
        </p>
        <button
          type="button"
          onClick={() => setNewOpen(true)}
          className="px-3.5 py-2 text-xs font-semibold bg-teal-700 hover:bg-teal-800 text-white rounded-lg flex items-center gap-1.5 cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          Nouveau fournisseur
        </button>
      </div>

      {msg && <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800">{msg}</div>}

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
            <tr>
              <th className="text-left px-4 py-3 font-semibold">Fournisseur</th>
              <th className="text-left px-4 py-3 font-semibold">Contact & Conditions</th>
              <th className="text-right px-4 py-3 font-semibold">Délai</th>
              <th className="text-right px-4 py-3 font-semibold">Total achats</th>
              <th className="text-right px-4 py-3 font-semibold">Total réglé</th>
              <th className="text-right px-4 py-3 font-semibold">Solde dû</th>
              <th className="text-right px-4 py-3 font-semibold">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {suppliers.map((s) => (
              <tr key={s.id} className="hover:bg-slate-50">
                <td className="px-4 py-2.5">
                  <div className="font-medium text-slate-900">{s.name}</div>
                  <div className="text-[11px] text-slate-500">
                    {s.code} · {s.address}
                  </div>
                </td>
                <td className="px-4 py-2.5 text-slate-600">
                  <div>
                    {s.contact_name} {s.phone ? `· ${s.phone}` : ''}
                  </div>
                  <div className="text-[11px] text-slate-500">{s.payment_terms}</div>
                </td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums">{s.lead_time_days} j</td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatXOF(s.total_purchased_xof)}</td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums text-emerald-700">
                  {formatXOF(s.total_paid_xof)}
                </td>
                <td
                  className={`px-4 py-2.5 text-right font-mono tabular-nums font-bold ${
                    s.balance_due_xof > 0 ? 'text-amber-700' : 'text-slate-600'
                  }`}
                >
                  {formatXOF(s.balance_due_xof)}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {s.balance_due_xof > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setPayTarget(s);
                        setPayAmount(s.balance_due_xof);
                        setError(null);
                      }}
                      className="text-teal-700 hover:underline font-semibold inline-flex items-center gap-1 cursor-pointer"
                    >
                      <CreditCard className="w-3.5 h-3.5" />
                      Régler
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {suppliers.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                  Aucun fournisseur enregistré pour le moment.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {newOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleCreate}
            className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-3 shadow-lg text-xs"
          >
            <h3 className="font-display font-bold text-base text-slate-900">Nouveau fournisseur</h3>
            {error && <div className="p-2 bg-red-50 border border-red-200 rounded text-red-700">{error}</div>}
            <div>
              <label className="block font-medium text-slate-700 mb-1">Raison sociale</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Contact</label>
                <input
                  type="text"
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Téléphone</label>
                <input
                  type="text"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Adresse</label>
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Conditions paiement</label>
                <input
                  type="text"
                  value={terms}
                  onChange={(e) => setTerms(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Délai habituel (jours)</label>
                <input
                  type="number"
                  min={1}
                  value={lead}
                  onChange={(e) => setLead(Math.max(1, Number(e.target.value) || 1))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setNewOpen(false)}
                className="px-4 py-2 bg-slate-100 rounded-lg cursor-pointer"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="px-4 py-2 font-semibold bg-teal-700 text-white rounded-lg cursor-pointer"
              >
                Enregistrer
              </button>
            </div>
          </form>
        </div>
      )}

      {payTarget && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <form
            onSubmit={handlePay}
            className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-3 shadow-lg text-xs"
          >
            <h3 className="font-display font-bold text-base text-slate-900">Règlement — {payTarget.name}</h3>
            {error && <div className="p-2 bg-red-50 border border-red-200 rounded text-red-700">{error}</div>}
            <div>
              <label className="block font-medium text-slate-700 mb-1">Montant payé (FCFA)</label>
              <input
                type="number"
                min={1}
                value={payAmount}
                onChange={(e) => setPayAmount(Math.round(Number(e.target.value) || 0))}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono text-sm font-bold"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Mode de règlement</label>
              <select
                value={payMethod}
                onChange={(e) => setPayMethod(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
              >
                {(paymentMethods.length > 0 ? paymentMethods : [{ code: 'ESPECES', label: 'Espèces' }]).map((pm) => (
                  <option key={pm.code} value={pm.code}>
                    {pm.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Référence facture / chèque</label>
              <input
                type="text"
                value={payRef}
                onChange={(e) => setPayRef(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPayTarget(null)}
                className="px-4 py-2 bg-slate-100 rounded-lg cursor-pointer"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="px-4 py-2 font-semibold bg-teal-700 text-white rounded-lg cursor-pointer"
              >
                Enregistrer paiement
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
