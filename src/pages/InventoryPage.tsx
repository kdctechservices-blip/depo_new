import React, { useEffect, useState } from 'react';
import { CheckCircle2, ClipboardCheck, Plus, Save } from 'lucide-react';
import { apiFetch } from '../utils/api';
import { formatDateTime, formatXOF } from '../utils/format';
import type { CatalogMeta } from '../types';

interface InventorySessionSummary {
  id: number;
  inventory_number: string;
  scope: string;
  status: string;
  notes: string;
  user_name: string;
  line_count: number;
  total_variance_xof: number;
  created_at: string;
  validated_at: string | null;
}

interface InventoryDetail {
  session: InventorySessionSummary;
  lines: Array<{
    id: number;
    sku: string;
    product_name: string;
    category_name: string;
    unit_label: string;
    theoretical_qty: number;
    counted_qty: number;
    variance_qty: number;
    unit_cost_xof: number;
    variance_value_xof: number;
  }>;
}

export const InventoryPage: React.FC = () => {
  const [sessions, setSessions] = useState<InventorySessionSummary[]>([]);
  const [activeDetail, setActiveDetail] = useState<InventoryDetail | null>(null);
  const [meta, setMeta] = useState<CatalogMeta | null>(null);

  const [newOpen, setNewOpen] = useState(false);
  const [catFilter, setCatFilter] = useState<string>('');
  const [notes, setNotes] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const loadData = async () => {
    const [invs, m] = await Promise.all([
      apiFetch<InventorySessionSummary[]>('/api/inventories'),
      apiFetch<CatalogMeta>('/api/catalog/meta'),
    ]);
    setSessions(invs);
    setMeta(m);
  };

  useEffect(() => {
    void loadData();
  }, []);

  const openSession = async (id: number) => {
    const det = await apiFetch<InventoryDetail>(`/api/inventories/${id}`);
    setActiveDetail(det);
  };

  const createSession = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await apiFetch<{ id: number; inventory_number: string }>('/api/inventories', {
      method: 'POST',
      body: JSON.stringify({
        category_id: catFilter ? Number(catFilter) : null,
        notes,
      }),
    });
    setNewOpen(false);
    setNotes('');
    await loadData();
    await openSession(res.id);
  };

  const saveCounts = async () => {
    if (!activeDetail) return;
    await apiFetch(`/api/inventories/${activeDetail.session.id}/lines`, {
      method: 'PUT',
      body: JSON.stringify({
        counts: activeDetail.lines.map((l) => ({ line_id: l.id, counted_qty: l.counted_qty })),
      }),
    });
    setMsg('Comptages sauvegardés.');
    await openSession(activeDetail.session.id);
    await loadData();
  };

  const validateInventory = async () => {
    if (!activeDetail) return;
    await saveCounts();
    await apiFetch(`/api/inventories/${activeDetail.session.id}/validate`, { method: 'POST' });
    setMsg(`Inventaire ${activeDetail.session.inventory_number} validé. Les mouvements correctifs ont été générés.`);
    await openSession(activeDetail.session.id);
    await loadData();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-600">
          Comptage physique par produit, analyse des écarts en quantité et en FCFA, et régularisation traçable.
        </p>
        <button
          type="button"
          onClick={() => setNewOpen(true)}
          className="px-3.5 py-2 text-xs font-semibold bg-teal-700 hover:bg-teal-800 text-white rounded-lg flex items-center gap-1.5 cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          Nouvelle session d’inventaire
        </button>
      </div>

      {msg && <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800">{msg}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-700">
            Sessions d’inventaire
          </div>
          <div className="divide-y divide-slate-100">
            {sessions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => void openSession(s.id)}
                className={`w-full text-left px-4 py-3 text-xs hover:bg-slate-50 transition-colors cursor-pointer ${
                  activeDetail?.session.id === s.id ? 'bg-teal-50/70' : ''
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono font-semibold text-slate-900">{s.inventory_number}</span>
                  <span
                    className={`font-semibold ${
                      s.status === 'VALIDE' ? 'text-emerald-700' : 'text-amber-700'
                    }`}
                  >
                    {s.status}
                  </span>
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {s.scope} · {s.line_count} articles
                </div>
                <div className="flex justify-between text-[11px] text-slate-500 mt-1">
                  <span>{formatDateTime(s.created_at)}</span>
                  <span className="font-mono font-medium">{formatXOF(s.total_variance_xof)}</span>
                </div>
              </button>
            ))}
            {sessions.length === 0 && (
              <div className="p-6 text-center text-xs text-slate-500">
                Aucune session d’inventaire créée. Démarrez un comptage.
              </div>
            )}
          </div>
        </div>

        <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden">
          {!activeDetail ? (
            <div className="p-12 text-center text-xs text-slate-500">
              <ClipboardCheck className="w-8 h-8 mx-auto mb-2 text-slate-300" />
              Sélectionnez ou créez une session d’inventaire pour saisir les quantités comptées.
            </div>
          ) : (
            <div>
              <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-display font-bold text-sm text-slate-900">
                    {activeDetail.session.inventory_number} — {activeDetail.session.scope}
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    Statut : {activeDetail.session.status}
                    {activeDetail.session.validated_at && ` · Validé le ${formatDateTime(activeDetail.session.validated_at)}`}
                  </p>
                </div>
                {activeDetail.session.status === 'BROUILLON' && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void saveCounts()}
                      className="px-3 py-1.5 text-xs font-medium bg-white border border-slate-300 hover:bg-slate-50 rounded-lg flex items-center gap-1 cursor-pointer"
                    >
                      <Save className="w-3.5 h-3.5" />
                      Enregistrer saisie
                    </button>
                    <button
                      type="button"
                      onClick={() => void validateInventory()}
                      className="px-3 py-1.5 text-xs font-semibold bg-teal-700 hover:bg-teal-800 text-white rounded-lg flex items-center gap-1 cursor-pointer"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Valider & régulariser stock
                    </button>
                  </div>
                )}
              </div>

              <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 sticky top-0">
                    <tr>
                      <th className="text-left px-4 py-2.5 font-semibold">Produit</th>
                      <th className="text-right px-4 py-2.5 font-semibold">Théorique</th>
                      <th className="text-right px-4 py-2.5 font-semibold">Compté</th>
                      <th className="text-right px-4 py-2.5 font-semibold">Écart qté</th>
                      <th className="text-right px-4 py-2.5 font-semibold">Écart valeur</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {activeDetail.lines.map((l, idx) => {
                      const diff = l.counted_qty - l.theoretical_qty;
                      const diffVal = diff * l.unit_cost_xof;
                      return (
                        <tr key={l.id}>
                          <td className="px-4 py-2">
                            <div className="font-medium text-slate-900">{l.product_name}</div>
                            <div className="text-[11px] text-slate-500 font-mono">{l.sku}</div>
                          </td>
                          <td className="px-4 py-2 text-right font-mono tabular-nums">{l.theoretical_qty}</td>
                          <td className="px-4 py-2 text-right">
                            <input
                              type="number"
                              min={0}
                              disabled={activeDetail.session.status === 'VALIDE'}
                              value={l.counted_qty}
                              onChange={(e) => {
                                const val = Math.max(0, Math.round(Number(e.target.value) || 0));
                                setActiveDetail((prev) =>
                                  prev
                                    ? {
                                        ...prev,
                                        lines: prev.lines.map((x, i) => (i === idx ? { ...x, counted_qty: val } : x)),
                                      }
                                    : null,
                                );
                              }}
                              className="w-20 text-right px-2 py-1 border border-slate-300 rounded font-mono disabled:bg-slate-100"
                            />
                          </td>
                          <td
                            className={`px-4 py-2 text-right font-mono tabular-nums font-bold ${
                              diff === 0 ? 'text-slate-400' : diff > 0 ? 'text-emerald-700' : 'text-red-700'
                            }`}
                          >
                            {diff > 0 ? `+${diff}` : diff}
                          </td>
                          <td
                            className={`px-4 py-2 text-right font-mono tabular-nums font-semibold ${
                              diffVal === 0 ? 'text-slate-400' : diffVal > 0 ? 'text-emerald-700' : 'text-red-700'
                            }`}
                          >
                            {formatXOF(diffVal)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      {newOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <form
            onSubmit={createSession}
            className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4 shadow-lg text-xs"
          >
            <h3 className="font-display font-bold text-base text-slate-900">Démarrer un inventaire physique</h3>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Périmètre de comptage</label>
              <select
                value={catFilter}
                onChange={(e) => setCatFilter(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
              >
                <option value="">Inventaire global (tous les produits)</option>
                {meta?.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    Catégorie : {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Observations</label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="ex. Inventaire mensuel zone A"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>
            <div className="flex justify-end gap-2">
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
                Créer la feuille de comptage
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
