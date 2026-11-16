import React, { useEffect, useState } from 'react';
import { CheckCircle2, PlusCircle, Search, ShieldCheck } from 'lucide-react';
import { apiFetch } from '../utils/api';
import { formatDate, formatDateTime, formatXOF } from '../utils/format';
import { accountingDateStamp, exportTableData, type TableExportFormat } from '../utils/exportTable';
import { TableExportButtons } from '../components/TableExportButtons';
import type { SessionUser } from '../types';

interface StockRow {
  id: number;
  sku: string;
  name: string;
  category_name: string;
  unit_label: string;
  purchase_cost_xof: number;
  min_threshold: number;
  physical_qty: number;
  reserved_qty: number;
  available_qty: number;
  stock_value_xof: number;
}

interface StockMovement {
  id: number;
  sku: string;
  product_name: string;
  movement_type: string;
  qty_signed: number;
  unit_cost_xof: number;
  reference_doc: string;
  comment: string;
  user_name: string;
  created_at: string;
}

interface BatchRow {
  id: number;
  sku: string;
  product_name: string;
  batch_number: string;
  expiry_date: string;
  qty_remaining: number;
}

export const StockPage: React.FC<{ user: SessionUser }> = ({ user }) => {
  const canAdjust = user.permissions.includes('stock_adjust');
  const [tab, setTab] = useState<'etat' | 'mouvements' | 'lots'>('etat');
  const [stock, setStock] = useState<StockRow[]>([]);
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [search, setSearch] = useState('');

  const [adjustModal, setAdjustModal] = useState(false);
  const [adjProductId, setAdjProductId] = useState<number>(0);
  const [adjType, setAdjType] = useState<'CASSE' | 'PERTE' | 'PEREMPTION' | 'AJUSTEMENT_ENTREE'>('CASSE');
  const [adjQty, setAdjQty] = useState(1);
  const [adjComment, setAdjComment] = useState('');
  const [reconcileMsg, setReconcileMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    const [st, mv] = await Promise.all([
      apiFetch<{ stock: StockRow[]; batches: BatchRow[] }>('/api/stock'),
      apiFetch<StockMovement[]>('/api/stock/movements'),
    ]);
    setStock(st.stock);
    setBatches(st.batches);
    setMovements(mv);
    if (st.stock.length > 0 && adjProductId === 0) {
      setAdjProductId(st.stock[0].id);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleAdjust = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/stock/adjust', {
        method: 'POST',
        body: JSON.stringify({
          product_id: adjProductId,
          movement_type: adjType,
          qty: adjQty,
          comment: adjComment,
        }),
      });
      setAdjustModal(false);
      setAdjComment('');
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const runReconcile = async () => {
    const res = await apiFetch<{ totalChecked: number; discrepanciesCount: number }>('/api/stock/reconcile');
    setReconcileMsg(
      res.discrepanciesCount === 0
        ? `Rapprochement validé : ${res.totalChecked} produit(s) contrôlé(s), aucun écart entre les soldes et le journal.`
        : `Attention : ${res.discrepanciesCount} écart(s) détecté(s) sur ${res.totalChecked} produits.`,
    );
  };

  const filteredStock = stock.filter(
    (s) => s.name.toLowerCase().includes(search.toLowerCase()) || s.sku.toLowerCase().includes(search.toLowerCase()),
  );
  const totalValue = filteredStock.reduce((acc, s) => acc + s.stock_value_xof, 0);

  const handleExportStock = (format: TableExportFormat) => {
    const stamp = accountingDateStamp();
    if (tab === 'etat') {
      exportTableData({
        format,
        filename: `GestDepot_Stocks_${stamp}`,
        sheetName: 'État des stocks',
        rows: filteredStock,
        columns: [
          { header: 'SKU', accessor: (r) => r.sku },
          { header: 'Désignation', accessor: (r) => r.name },
          { header: 'Catégorie', accessor: (r) => r.category_name },
          { header: 'Unité', accessor: (r) => r.unit_label },
          { header: 'Stock physique', accessor: (r) => r.physical_qty },
          { header: 'Stock réservé', accessor: (r) => r.reserved_qty },
          { header: 'Stock disponible', accessor: (r) => r.available_qty },
          { header: 'Seuil minimum', accessor: (r) => r.min_threshold },
          { header: 'CUMP (FCFA)', accessor: (r) => r.purchase_cost_xof },
          { header: 'Valeur stock (FCFA)', accessor: (r) => r.stock_value_xof },
        ],
      });
    } else if (tab === 'mouvements') {
      exportTableData({
        format,
        filename: `GestDepot_Mouvements_Stock_${stamp}`,
        sheetName: 'Mouvements stock',
        rows: movements,
        columns: [
          { header: 'Date et heure', accessor: (r) => formatDateTime(r.created_at) },
          { header: 'SKU', accessor: (r) => r.sku },
          { header: 'Produit', accessor: (r) => r.product_name },
          { header: 'Type mouvement', accessor: (r) => r.movement_type },
          { header: 'Quantité signée', accessor: (r) => r.qty_signed },
          { header: 'Coût unitaire (FCFA)', accessor: (r) => r.unit_cost_xof },
          { header: 'Document', accessor: (r) => r.reference_doc || '' },
          { header: 'Utilisateur', accessor: (r) => r.user_name || 'Système' },
          { header: 'Motif / Commentaire', accessor: (r) => r.comment },
        ],
      });
    } else {
      exportTableData({
        format,
        filename: `GestDepot_Lots_FEFO_${stamp}`,
        sheetName: 'Lots péremption',
        rows: batches,
        columns: [
          { header: 'N° Lot', accessor: (r) => r.batch_number },
          { header: 'SKU', accessor: (r) => r.sku },
          { header: 'Produit', accessor: (r) => r.product_name },
          { header: 'Date expiration', accessor: (r) => formatDate(r.expiry_date) },
          { header: 'Quantité restante', accessor: (r) => r.qty_remaining },
        ],
      });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          <button
            type="button"
            onClick={() => setTab('etat')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              tab === 'etat' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            État des stocks ({stock.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('mouvements')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              tab === 'mouvements' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Journal des mouvements ({movements.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('lots')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              tab === 'lots' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Lots & Péremptions FEFO ({batches.length})
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <TableExportButtons
            onExport={handleExportStock}
            disabled={
              tab === 'etat'
                ? filteredStock.length === 0
                : tab === 'mouvements'
                  ? movements.length === 0
                  : batches.length === 0
            }
          />
          <button
            type="button"
            onClick={() => void runReconcile()}
            className="px-3 py-2 text-xs font-medium bg-white border border-slate-200 hover:bg-slate-50 rounded-lg flex items-center gap-1.5 cursor-pointer"
          >
            <ShieldCheck className="w-3.5 h-3.5 text-teal-700" />
            Rapprochement journal
          </button>
          {canAdjust && (
            <button
              type="button"
              onClick={() => setAdjustModal(true)}
              className="px-3.5 py-2 text-xs font-semibold bg-teal-700 hover:bg-teal-800 text-white rounded-lg flex items-center gap-1.5 cursor-pointer"
            >
              <PlusCircle className="w-3.5 h-3.5" />
              Déclarer casse / mouvement
            </button>
          )}
        </div>
      </div>

      {reconcileMsg && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          {reconcileMsg}
        </div>
      )}

      {tab === 'etat' && (
        <>
          <div className="flex items-center justify-between gap-3">
            <div className="relative max-w-sm flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filtrer les articles..."
                className="w-full pl-9 pr-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
              />
            </div>
            <div className="text-xs text-slate-600">
              Valorisation totale au CUMP :{' '}
              <span className="font-mono font-bold text-slate-900">{formatXOF(totalValue)}</span>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <tr>
                  <th className="text-left px-4 py-3 font-semibold">SKU</th>
                  <th className="text-left px-4 py-3 font-semibold">Désignation</th>
                  <th className="text-right px-4 py-3 font-semibold">Physique</th>
                  <th className="text-right px-4 py-3 font-semibold">Réservé</th>
                  <th className="text-right px-4 py-3 font-semibold">Disponible</th>
                  <th className="text-right px-4 py-3 font-semibold">Seuil</th>
                  <th className="text-right px-4 py-3 font-semibold">CUMP</th>
                  <th className="text-right px-4 py-3 font-semibold">Valeur stock</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredStock.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-mono text-slate-600">{s.sku}</td>
                    <td className="px-4 py-2.5 font-medium text-slate-900">
                      {s.name}
                      <div className="text-[11px] text-slate-500">{s.category_name}</div>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">{s.physical_qty}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-amber-700">{s.reserved_qty}</td>
                    <td
                      className={`px-4 py-2.5 text-right font-mono tabular-nums font-bold ${
                        s.available_qty <= 0
                          ? 'text-red-700'
                          : s.available_qty <= s.min_threshold
                            ? 'text-amber-700'
                            : 'text-emerald-700'
                      }`}
                    >
                      {s.available_qty} {s.unit_label}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-500">{s.min_threshold}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatXOF(s.purchase_cost_xof)}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold">
                      {formatXOF(s.stock_value_xof)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'mouvements' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">Date & Heure</th>
                <th className="text-left px-4 py-3 font-semibold">Produit</th>
                <th className="text-left px-4 py-3 font-semibold">Type</th>
                <th className="text-right px-4 py-3 font-semibold">Qté signée</th>
                <th className="text-left px-4 py-3 font-semibold">Document</th>
                <th className="text-left px-4 py-3 font-semibold">Utilisateur</th>
                <th className="text-left px-4 py-3 font-semibold">Motif / Commentaire</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {movements.map((m) => (
                <tr key={m.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2 text-slate-600 tabular-nums">{formatDateTime(m.created_at)}</td>
                  <td className="px-4 py-2 font-medium text-slate-900">{m.product_name}</td>
                  <td className="px-4 py-2 text-slate-700">{m.movement_type}</td>
                  <td
                    className={`px-4 py-2 text-right font-mono tabular-nums font-bold ${
                      m.qty_signed >= 0 ? 'text-emerald-700' : 'text-red-700'
                    }`}
                  >
                    {m.qty_signed > 0 ? `+${m.qty_signed}` : m.qty_signed}
                  </td>
                  <td className="px-4 py-2 font-mono text-slate-600">{m.reference_doc || '—'}</td>
                  <td className="px-4 py-2 text-slate-600">{m.user_name || 'Système'}</td>
                  <td className="px-4 py-2 text-slate-600">{m.comment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'lots' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">Lot</th>
                <th className="text-left px-4 py-3 font-semibold">Produit</th>
                <th className="text-left px-4 py-3 font-semibold">Date d’expiration</th>
                <th className="text-right px-4 py-3 font-semibold">Quantité restante</th>
                <th className="text-left px-4 py-3 font-semibold">Alerte</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {batches.map((b) => {
                const daysLeft = Math.ceil((new Date(b.expiry_date).getTime() - Date.now()) / 86400000);
                return (
                  <tr key={b.id}>
                    <td className="px-4 py-2.5 font-mono font-semibold">{b.batch_number}</td>
                    <td className="px-4 py-2.5 font-medium">{b.product_name}</td>
                    <td className="px-4 py-2.5 tabular-nums">{formatDate(b.expiry_date)}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">{b.qty_remaining}</td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`font-medium ${
                          daysLeft <= 0 ? 'text-red-700' : daysLeft <= 30 ? 'text-amber-700' : 'text-emerald-700'
                        }`}
                      >
                        {daysLeft <= 0 ? 'Expiré' : daysLeft <= 30 ? `Expire dans ${daysLeft} j` : 'Nominal'}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {batches.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                    Aucun lot actif suivi par date de péremption.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Stock Adjustment Modal */}
      {adjustModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleAdjust}
            className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4 shadow-lg"
          >
            <h3 className="font-display font-bold text-base text-slate-900">Mouvement de stock traçable</h3>
            {error && <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{error}</div>}
            <div className="space-y-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Produit concerné</label>
                <select
                  value={adjProductId}
                  onChange={(e) => setAdjProductId(Number(e.target.value))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                >
                  {stock.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} (Physique : {s.physical_qty})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Nature du mouvement</label>
                <select
                  value={adjType}
                  onChange={(e) => setAdjType(e.target.value as typeof adjType)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                >
                  <option value="CASSE">Casse (sortie)</option>
                  <option value="PERTE">Perte / Manquant (sortie)</option>
                  <option value="PEREMPTION">Péremption (sortie)</option>
                  <option value="AJUSTEMENT_ENTREE">Régularisation positive (entrée)</option>
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Quantité (unités de base)</label>
                <input
                  type="number"
                  min={1}
                  value={adjQty}
                  onChange={(e) => setAdjQty(Math.max(1, Math.round(Number(e.target.value) || 1)))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Commentaire justificatif</label>
                <input
                  type="text"
                  required
                  value={adjComment}
                  onChange={(e) => setAdjComment(e.target.value)}
                  placeholder="ex. 2 bouteilles cassées au déchargement"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setAdjustModal(false)}
                className="px-4 py-2 text-xs bg-slate-100 rounded-lg cursor-pointer"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg cursor-pointer"
              >
                Enregistrer le mouvement
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
