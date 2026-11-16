import React, { useEffect, useState } from 'react';
import { PlusCircle } from 'lucide-react';
import { apiFetch } from '../utils/api';
import { formatDateTime, formatXOF } from '../utils/format';
import type { CatalogMeta, Customer } from '../types';

interface DepositsData {
  packagingTypes: Array<{ id: number; code: string; label: string; capacity: number; deposit_value_xof: number }>;
  customerBalances: Array<{
    customer_id: number;
    customer_code: string;
    customer_name: string;
    packaging_id: number;
    packaging_code: string;
    packaging_label: string;
    qty_balance: number;
    value_balance_xof: number;
  }>;
  supplierBalances: Array<{
    supplier_id: number;
    supplier_code: string;
    supplier_name: string;
    packaging_id: number;
    packaging_code: string;
    packaging_label: string;
    qty_balance: number;
    value_balance_xof: number;
  }>;
  movements: Array<{
    id: number;
    party_type: string;
    party_name: string;
    packaging_code: string;
    packaging_label: string;
    movement_kind: string;
    qty_signed: number;
    amount_xof: number;
    payment_method: string;
    comment: string;
    user_name: string;
    created_at: string;
  }>;
}

export const DepositsPage: React.FC = () => {
  const [data, setData] = useState<DepositsData | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [suppliers, setSuppliers] = useState<Array<{ id: number; name: string }>>([]);
  const [paymentMethods, setPaymentMethods] = useState<CatalogMeta['paymentMethods']>([]);
  const [tab, setTab] = useState<'clients' | 'fournisseurs' | 'journal'>('clients');
  const [modalOpen, setModalOpen] = useState(false);

  const [partyType, setPartyType] = useState<'CLIENT' | 'FOURNISSEUR' | 'INTERNE'>('CLIENT');
  const [partyId, setPartyId] = useState<number | ''>('');
  const [packagingId, setPackagingId] = useState<number | ''>('');
  const [movementKind, setMovementKind] = useState<
    'REMISE_CLIENT' | 'RETOUR_CLIENT' | 'RECU_FOURNISSEUR' | 'RENDU_FOURNISSEUR' | 'CASSE_PERTE'
  >('RETOUR_CLIENT');
  const [qty, setQty] = useState(1);
  const [payMethod, setPayMethod] = useState('ESPECES');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    const [dep, custs, meta] = await Promise.all([
      apiFetch<DepositsData>('/api/deposits'),
      apiFetch<Customer[]>('/api/customers'),
      apiFetch<CatalogMeta>('/api/catalog/meta'),
    ]);
    setData(dep);
    setCustomers(custs);
    setSuppliers(meta.suppliers);
    setPaymentMethods(meta.paymentMethods);
    setPackagingId((prev) =>
      prev && dep.packagingTypes.some((p) => p.id === prev) ? prev : (dep.packagingTypes[0]?.id ?? ''),
    );
    setPartyId((prev) => (prev ? prev : (custs[0]?.id ?? '')));
    if (meta.paymentMethods.length > 0 && !meta.paymentMethods.some((pm) => pm.code === payMethod)) {
      setPayMethod(meta.paymentMethods[0].code);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!packagingId) {
      setError('Créez d’abord un type d’emballage consigné dans Paramètres avancés.');
      return;
    }
    try {
      await apiFetch('/api/deposits/record', {
        method: 'POST',
        body: JSON.stringify({
          party_type: partyType,
          party_id: partyType === 'INTERNE' ? 0 : Number(partyId || 0),
          packaging_id: Number(packagingId),
          movement_kind: movementKind,
          qty,
          payment_method: payMethod,
          comment,
        }),
      });
      setModalOpen(false);
      setComment('');
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const totalClientVal = data?.customerBalances.reduce((a, b) => a + b.value_balance_xof, 0) ?? 0;
  const totalSupplierVal = data?.supplierBalances.reduce((a, b) => a + b.value_balance_xof, 0) ?? 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Emballages détenus par les clients</div>
          <div className="font-mono text-xl font-bold text-amber-700 mt-1 tabular-nums">
            {formatXOF(totalClientVal)}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">Consignes remboursables / suivies hors CA</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Emballages consignés chez fournisseurs</div>
          <div className="font-mono text-xl font-bold text-slate-900 mt-1 tabular-nums">
            {formatXOF(totalSupplierVal)}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">Parc casiers & fûts brasseries</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between">
          <div>
            <div className="text-xs text-slate-500">Types d’emballages actifs</div>
            <div className="font-mono text-xl font-bold text-slate-900 mt-1">
              {data?.packagingTypes.length ?? 0}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="px-3.5 py-2 text-xs font-semibold bg-teal-700 hover:bg-teal-800 text-white rounded-lg flex items-center gap-1.5 cursor-pointer"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            Mouvement consigne
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg w-fit">
        <button
          type="button"
          onClick={() => setTab('clients')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
            tab === 'clients' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
          }`}
        >
          Soldes clients
        </button>
        <button
          type="button"
          onClick={() => setTab('fournisseurs')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
            tab === 'fournisseurs' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
          }`}
        >
          Soldes fournisseurs
        </button>
        <button
          type="button"
          onClick={() => setTab('journal')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
            tab === 'journal' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
          }`}
        >
          Journal des emballages
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {tab === 'clients' && (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">Client</th>
                <th className="text-left px-4 py-3 font-semibold">Emballage</th>
                <th className="text-right px-4 py-3 font-semibold">Quantité due</th>
                <th className="text-right px-4 py-3 font-semibold">Valeur consigne</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data?.customerBalances.map((cb, idx) => (
                <tr key={idx}>
                  <td className="px-4 py-2.5 font-medium text-slate-900">
                    {cb.customer_name} <span className="text-slate-400 font-mono">({cb.customer_code})</span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-700">{cb.packaging_label}</td>
                  <td className="px-4 py-2.5 text-right font-mono font-bold tabular-nums">{cb.qty_balance}</td>
                  <td className="px-4 py-2.5 text-right font-mono font-semibold tabular-nums text-amber-700">
                    {formatXOF(cb.value_balance_xof)}
                  </td>
                </tr>
              ))}
              {data?.customerBalances.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-slate-500">
                    Aucun solde d’emballage ouvert chez les clients.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {tab === 'fournisseurs' && (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">Fournisseur</th>
                <th className="text-left px-4 py-3 font-semibold">Emballage</th>
                <th className="text-right px-4 py-3 font-semibold">Quantité en parc</th>
                <th className="text-right px-4 py-3 font-semibold">Valeur consigne</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data?.supplierBalances.map((sb, idx) => (
                <tr key={idx}>
                  <td className="px-4 py-2.5 font-medium text-slate-900">{sb.supplier_name}</td>
                  <td className="px-4 py-2.5 text-slate-700">{sb.packaging_label}</td>
                  <td className="px-4 py-2.5 text-right font-mono font-bold tabular-nums">{sb.qty_balance}</td>
                  <td className="px-4 py-2.5 text-right font-mono font-semibold tabular-nums">
                    {formatXOF(sb.value_balance_xof)}
                  </td>
                </tr>
              ))}
              {data?.supplierBalances.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-slate-500">
                    Aucun solde d’emballage ouvert chez les fournisseurs.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {tab === 'journal' && (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">Date</th>
                <th className="text-left px-4 py-3 font-semibold">Tiers</th>
                <th className="text-left px-4 py-3 font-semibold">Opération</th>
                <th className="text-left px-4 py-3 font-semibold">Emballage</th>
                <th className="text-right px-4 py-3 font-semibold">Qté</th>
                <th className="text-right px-4 py-3 font-semibold">Montant</th>
                <th className="text-left px-4 py-3 font-semibold">Note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data?.movements.map((m) => (
                <tr key={m.id}>
                  <td className="px-4 py-2 text-slate-600 tabular-nums">{formatDateTime(m.created_at)}</td>
                  <td className="px-4 py-2 font-medium">{m.party_name}</td>
                  <td className="px-4 py-2 text-slate-700">{m.movement_kind}</td>
                  <td className="px-4 py-2 text-slate-700">{m.packaging_label}</td>
                  <td
                    className={`px-4 py-2 text-right font-mono font-bold tabular-nums ${
                      m.qty_signed > 0 ? 'text-amber-700' : 'text-emerald-700'
                    }`}
                  >
                    {m.qty_signed > 0 ? `+${m.qty_signed}` : m.qty_signed}
                  </td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums">{formatXOF(m.amount_xof)}</td>
                  <td className="px-4 py-2 text-slate-500">{m.comment}</td>
                </tr>
              ))}
              {data?.movements.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    Aucun mouvement de consigne enregistré.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleRecord}
            className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4 shadow-lg"
          >
            <h3 className="font-display font-bold text-base text-slate-900">Enregistrer un mouvement de consigne</h3>
            {error && <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{error}</div>}
            <div className="space-y-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Type d’opération</label>
                <select
                  value={movementKind}
                  onChange={(e) => {
                    const k = e.target.value as typeof movementKind;
                    setMovementKind(k);
                    if (k === 'REMISE_CLIENT' || k === 'RETOUR_CLIENT') {
                      setPartyType('CLIENT');
                      setPartyId(customers[0]?.id ?? '');
                    } else if (k === 'RECU_FOURNISSEUR' || k === 'RENDU_FOURNISSEUR') {
                      setPartyType('FOURNISSEUR');
                      setPartyId(suppliers[0]?.id ?? '');
                    } else {
                      setPartyType('INTERNE');
                    }
                  }}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                >
                  <option value="RETOUR_CLIENT">Retour d’emballages par un client (remboursement)</option>
                  <option value="REMISE_CLIENT">Remise d’emballages à un client (encaissement)</option>
                  <option value="RECU_FOURNISSEUR">Emballages reçus d’un fournisseur</option>
                  <option value="RENDU_FOURNISSEUR">Emballages rendus au fournisseur</option>
                  <option value="CASSE_PERTE">Casse / Perte d’emballage interne</option>
                </select>
              </div>

              {partyType !== 'INTERNE' && (
                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    {partyType === 'CLIENT' ? 'Client' : 'Fournisseur'}
                  </label>
                  <select
                    required
                    value={partyId}
                    onChange={(e) => setPartyId(e.target.value ? Number(e.target.value) : '')}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="">Sélectionner...</option>
                    {partyType === 'CLIENT'
                      ? customers.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))
                      : suppliers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block font-medium text-slate-700 mb-1">Type d’emballage</label>
                <select
                  required
                  value={packagingId}
                  onChange={(e) => setPackagingId(e.target.value ? Number(e.target.value) : '')}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                >
                  <option value="">
                    {data?.packagingTypes.length ? 'Sélectionner un emballage...' : 'Aucun emballage configuré'}
                  </option>
                  {data?.packagingTypes.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} ({formatXOF(p.deposit_value_xof)})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Quantité</label>
                  <input
                    type="number"
                    min={1}
                    value={qty}
                    onChange={(e) => setQty(Math.max(1, Math.round(Number(e.target.value) || 1)))}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Moyen règlement</label>
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
              </div>

              <div>
                <label className="block font-medium text-slate-700 mb-1">Commentaire</label>
                <input
                  type="text"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Observation sur le mouvement"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="px-4 py-2 text-xs bg-slate-100 rounded-lg cursor-pointer"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg cursor-pointer"
              >
                Valider le mouvement
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
