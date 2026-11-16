import React, { useEffect, useState } from 'react';
import { Lock, Plus, Unlock } from 'lucide-react';
import { apiFetch } from '../utils/api';
import { formatDateTime, formatXOF } from '../utils/format';
import type { CatalogMeta } from '../types';

interface CashState {
  session: {
    id: number;
    user_name: string;
    opened_at: string;
    opening_float_xof: number;
    theoretical_cash_xof: number;
    status: string;
  } | null;
  movements: Array<{
    id: number;
    movement_type: string;
    payment_method: string;
    amount_signed_xof: number;
    reference_doc: string;
    comment: string;
    user_name: string;
    created_at: string;
  }>;
  nonCashTotals: Array<{ payment_method: string; total_xof: number }>;
  history: Array<{
    id: number;
    user_name: string;
    opened_at: string;
    closed_at: string | null;
    opening_float_xof: number;
    theoretical_cash_xof: number;
    counted_cash_xof: number | null;
    variance_xof: number | null;
    comment: string;
    status: string;
  }>;
}

interface ExpenseRow {
  id: number;
  expense_number: string;
  category_name: string;
  beneficiary: string;
  amount_xof: number;
  payment_method: string;
  comment: string;
  expense_date: string;
  user_name: string;
}

export const CashExpensesPage: React.FC = () => {
  const [tab, setTab] = useState<'caisse' | 'depenses' | 'clotures'>('caisse');
  const [cash, setCash] = useState<CashState | null>(null);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [meta, setMeta] = useState<CatalogMeta | null>(null);

  const [openFloat, setOpenFloat] = useState(0);
  const [closeModal, setCloseModal] = useState(false);
  const [countedCash, setCountedCash] = useState(0);
  const [closeComment, setCloseComment] = useState('');

  const [moveModal, setMoveModal] = useState(false);
  const [moveType, setMoveType] = useState<'APPORT' | 'RETRAIT'>('RETRAIT');
  const [moveAmt, setMoveAmt] = useState(0);
  const [moveComment, setMoveComment] = useState('');

  const [expModal, setExpModal] = useState(false);
  const [expCatId, setExpCatId] = useState<number | ''>('');
  const [expBeneficiary, setExpBeneficiary] = useState('');
  const [expAmt, setExpAmt] = useState(0);
  const [expMethod, setExpMethod] = useState('ESPECES');
  const [expComment, setExpComment] = useState('');

  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    const [c, e, m] = await Promise.all([
      apiFetch<CashState>('/api/cash/current'),
      apiFetch<ExpenseRow[]>('/api/expenses'),
      apiFetch<CatalogMeta>('/api/catalog/meta'),
    ]);
    setCash(c);
    setExpenses(e);
    setMeta(m);
    if (c.session) setCountedCash(c.session.theoretical_cash_xof);
    setExpCatId((prev) =>
      prev && m.expenseCategories.some((ec) => ec.id === prev) ? prev : (m.expenseCategories[0]?.id ?? ''),
    );
    if (m.paymentMethods.length > 0 && !m.paymentMethods.some((pm) => pm.code === expMethod)) {
      setExpMethod(m.paymentMethods[0].code);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleOpenCash = async () => {
    setError(null);
    try {
      await apiFetch('/api/cash/open', {
        method: 'POST',
        body: JSON.stringify({ opening_float_xof: openFloat }),
      });
      setMsg('Session de caisse ouverte.');
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleCloseCash = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await apiFetch<{ variance: number }>('/api/cash/close', {
        method: 'POST',
        body: JSON.stringify({ counted_cash_xof: countedCash, comment: closeComment }),
      });
      setCloseModal(false);
      setCloseComment('');
      setMsg(`Caisse clôturée (écart constaté : ${formatXOF(res.variance)}).`);
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleCashMove = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/cash/movement', {
        method: 'POST',
        body: JSON.stringify({ movement_type: moveType, amount_xof: moveAmt, comment: moveComment }),
      });
      setMoveModal(false);
      setMoveComment('');
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleCreateExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!expCatId) return;
    setError(null);
    try {
      const res = await apiFetch<{ expense_number: string }>('/api/expenses', {
        method: 'POST',
        body: JSON.stringify({
          category_id: Number(expCatId),
          beneficiary: expBeneficiary,
          amount_xof: expAmt,
          payment_method: expMethod,
          comment: expComment,
        }),
      });
      setExpModal(false);
      setExpBeneficiary('');
      setExpComment('');
      setExpAmt(0);
      setMsg(`Dépense ${res.expense_number} enregistrée.`);
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
            onClick={() => setTab('caisse')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              tab === 'caisse' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Caisse en cours
          </button>
          <button
            type="button"
            onClick={() => setTab('depenses')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              tab === 'depenses' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Dépenses ({expenses.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('clotures')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              tab === 'clotures' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Historique clôtures
          </button>
        </div>

        <div className="flex items-center gap-2">
          {cash?.session && (
            <>
              <button
                type="button"
                onClick={() => setMoveModal(true)}
                className="px-3 py-2 text-xs font-medium bg-white border border-slate-200 hover:bg-slate-50 rounded-lg cursor-pointer"
              >
                Apport / Retrait espèces
              </button>
              <button
                type="button"
                onClick={() => setCloseModal(true)}
                className="px-3 py-2 text-xs font-medium bg-amber-700 hover:bg-amber-800 text-white rounded-lg flex items-center gap-1.5 cursor-pointer"
              >
                <Lock className="w-3.5 h-3.5" />
                Clôturer la caisse
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setExpModal(true)}
            className="px-3.5 py-2 text-xs font-semibold bg-teal-700 hover:bg-teal-800 text-white rounded-lg flex items-center gap-1.5 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Enregistrer une dépense
          </button>
        </div>
      </div>

      {msg && <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800">{msg}</div>}
      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{error}</div>}

      {tab === 'caisse' && (
        <>
          {!cash?.session ? (
            <div className="bg-white border border-slate-200 rounded-xl p-6 max-w-md space-y-4">
              <h3 className="font-display font-bold text-base text-slate-900 flex items-center gap-2">
                <Unlock className="w-4 h-4 text-teal-700" />
                Aucune caisse ouverte
              </h3>
              <p className="text-xs text-slate-600">
                Saisissez le fond de caisse initial en espèces pour démarrer la journée.
              </p>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Fond initial espèces (FCFA)</label>
                <input
                  type="number"
                  min={0}
                  value={openFloat}
                  onChange={(e) => setOpenFloat(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <button
                type="button"
                onClick={() => void handleOpenCash()}
                className="px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg cursor-pointer"
              >
                Ouvrir la session de caisse
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <div className="text-xs text-slate-500">Fond initial espèces</div>
                  <div className="font-mono text-xl font-bold text-slate-900 mt-1 tabular-nums">
                    {formatXOF(cash.session.opening_float_xof)}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    Ouverte par {cash.session.user_name} · {formatDateTime(cash.session.opened_at)}
                  </div>
                </div>
                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <div className="text-xs text-slate-500">Solde théorique espèces en tiroir</div>
                  <div className="font-mono text-xl font-bold text-teal-800 mt-1 tabular-nums">
                    {formatXOF(cash.session.theoretical_cash_xof)}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">Flux espèces uniquement</div>
                </div>
                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <div className="text-xs text-slate-500">Flux non-espèces (Mobile Money / Virement)</div>
                  <div className="mt-1 space-y-0.5 text-xs">
                    {cash.nonCashTotals.length === 0 ? (
                      <span className="text-slate-400">Aucun flux non-espèces</span>
                    ) : (
                      cash.nonCashTotals.map((nc) => (
                        <div key={nc.payment_method} className="flex justify-between font-mono">
                          <span className="text-slate-600">{nc.payment_method}</span>
                          <span className="font-bold text-slate-900">{formatXOF(nc.total_xof)}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <tr>
                      <th className="text-left px-4 py-3 font-semibold">Heure</th>
                      <th className="text-left px-4 py-3 font-semibold">Opération</th>
                      <th className="text-left px-4 py-3 font-semibold">Moyen</th>
                      <th className="text-left px-4 py-3 font-semibold">Référence</th>
                      <th className="text-left px-4 py-3 font-semibold">Commentaire</th>
                      <th className="text-right px-4 py-3 font-semibold">Montant</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {cash.movements.map((m) => (
                      <tr key={m.id}>
                        <td className="px-4 py-2 text-slate-600 tabular-nums">{formatDateTime(m.created_at)}</td>
                        <td className="px-4 py-2 font-medium text-slate-900">{m.movement_type}</td>
                        <td className="px-4 py-2 text-slate-700">{m.payment_method}</td>
                        <td className="px-4 py-2 font-mono text-slate-600">{m.reference_doc}</td>
                        <td className="px-4 py-2 text-slate-600">{m.comment}</td>
                        <td
                          className={`px-4 py-2 text-right font-mono tabular-nums font-bold ${
                            m.amount_signed_xof >= 0 ? 'text-emerald-700' : 'text-red-700'
                          }`}
                        >
                          {m.amount_signed_xof > 0 ? `+${formatXOF(m.amount_signed_xof)}` : formatXOF(m.amount_signed_xof)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'depenses' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">N° Dépense</th>
                <th className="text-left px-4 py-3 font-semibold">Date</th>
                <th className="text-left px-4 py-3 font-semibold">Catégorie</th>
                <th className="text-left px-4 py-3 font-semibold">Bénéficiaire</th>
                <th className="text-left px-4 py-3 font-semibold">Moyen</th>
                <th className="text-right px-4 py-3 font-semibold">Montant</th>
                <th className="text-left px-4 py-3 font-semibold">Commentaire</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {expenses.map((e) => (
                <tr key={e.id}>
                  <td className="px-4 py-2.5 font-mono font-semibold">{e.expense_number}</td>
                  <td className="px-4 py-2.5 tabular-nums">{e.expense_date}</td>
                  <td className="px-4 py-2.5 text-slate-700">{e.category_name}</td>
                  <td className="px-4 py-2.5 font-medium text-slate-900">{e.beneficiary}</td>
                  <td className="px-4 py-2.5 text-slate-600">{e.payment_method}</td>
                  <td className="px-4 py-2.5 text-right font-mono font-bold text-red-700 tabular-nums">
                    {formatXOF(e.amount_xof)}
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">{e.comment}</td>
                </tr>
              ))}
              {expenses.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                    Aucune dépense enregistrée pour le moment.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'clotures' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">Session</th>
                <th className="text-left px-4 py-3 font-semibold">Caissier</th>
                <th className="text-right px-4 py-3 font-semibold">Fond initial</th>
                <th className="text-right px-4 py-3 font-semibold">Théorique</th>
                <th className="text-right px-4 py-3 font-semibold">Compté</th>
                <th className="text-right px-4 py-3 font-semibold">Écart</th>
                <th className="text-left px-4 py-3 font-semibold">Statut</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {cash?.history.map((h) => (
                <tr key={h.id}>
                  <td className="px-4 py-2.5 font-mono">
                    #{h.id} · {formatDateTime(h.opened_at)}
                  </td>
                  <td className="px-4 py-2.5 font-medium">{h.user_name}</td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatXOF(h.opening_float_xof)}</td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatXOF(h.theoretical_cash_xof)}</td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                    {h.counted_cash_xof !== null ? formatXOF(h.counted_cash_xof) : '—'}
                  </td>
                  <td
                    className={`px-4 py-2.5 text-right font-mono tabular-nums font-bold ${
                      h.variance_xof && h.variance_xof !== 0 ? 'text-red-700' : 'text-emerald-700'
                    }`}
                  >
                    {h.variance_xof !== null ? formatXOF(h.variance_xof) : '—'}
                  </td>
                  <td className="px-4 py-2.5">{h.status}</td>
                </tr>
              ))}
              {(!cash?.history || cash.history.length === 0) && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                    Aucune clôture de caisse enregistrée pour le moment.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Close Cash Modal */}
      {closeModal && cash?.session && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleCloseCash}
            className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4 shadow-lg text-xs"
          >
            <h3 className="font-display font-bold text-base text-slate-900">Clôture de caisse</h3>
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg flex justify-between">
              <span>Solde théorique espèces</span>
              <span className="font-mono font-bold text-slate-900">{formatXOF(cash.session.theoretical_cash_xof)}</span>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Montant physique compté en espèces (FCFA)</label>
              <input
                type="number"
                min={0}
                value={countedCash}
                onChange={(e) => setCountedCash(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono text-sm font-bold"
              />
            </div>
            <div className="flex justify-between font-medium">
              <span>Écart calculé</span>
              <span
                className={`font-mono font-bold ${
                  countedCash - cash.session.theoretical_cash_xof !== 0 ? 'text-red-700' : 'text-emerald-700'
                }`}
              >
                {formatXOF(countedCash - cash.session.theoretical_cash_xof)}
              </span>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Commentaire (obligatoire si écart non nul)
              </label>
              <input
                type="text"
                value={closeComment}
                onChange={(e) => setCloseComment(e.target.value)}
                required={countedCash - cash.session.theoretical_cash_xof !== 0}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCloseModal(false)}
                className="px-4 py-2 bg-slate-100 rounded-lg cursor-pointer"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="px-4 py-2 font-semibold bg-amber-700 text-white rounded-lg cursor-pointer"
              >
                Confirmer la clôture
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Cash Apport / Retrait Modal */}
      {moveModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleCashMove}
            className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-3 shadow-lg text-xs"
          >
            <h3 className="font-display font-bold text-base text-slate-900">Mouvement de caisse espèces</h3>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Type</label>
              <select
                value={moveType}
                onChange={(e) => setMoveType(e.target.value as 'APPORT' | 'RETRAIT')}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
              >
                <option value="RETRAIT">Retrait / Dépôt banque</option>
                <option value="APPORT">Apport monnaie / fond complémentaire</option>
              </select>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Montant (FCFA)</label>
              <input
                type="number"
                min={1}
                value={moveAmt}
                onChange={(e) => setMoveAmt(Math.max(1, Math.round(Number(e.target.value) || 1)))}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Motif</label>
              <input
                type="text"
                required
                value={moveComment}
                onChange={(e) => setMoveComment(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setMoveModal(false)}
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

      {/* Expense Modal */}
      {expModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateExpense}
            className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-3 shadow-lg text-xs"
          >
            <h3 className="font-display font-bold text-base text-slate-900">Enregistrer une dépense</h3>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Catégorie</label>
              <select
                required
                value={expCatId}
                onChange={(e) => setExpCatId(e.target.value ? Number(e.target.value) : '')}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
              >
                <option value="">Sélectionner une catégorie...</option>
                {meta?.expenseCategories.map((ec) => (
                  <option key={ec.id} value={ec.id}>
                    {ec.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Bénéficiaire</label>
              <input
                type="text"
                required
                value={expBeneficiary}
                onChange={(e) => setExpBeneficiary(e.target.value)}
                placeholder="Nom du bénéficiaire ou prestataire"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Montant (FCFA)</label>
                <input
                  type="number"
                  min={1}
                  value={expAmt}
                  onChange={(e) => setExpAmt(Math.max(1, Math.round(Number(e.target.value) || 1)))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Moyen de paiement</label>
                <select
                  value={expMethod}
                  onChange={(e) => setExpMethod(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                >
                  {meta?.paymentMethods.map((pm) => (
                    <option key={pm.code} value={pm.code}>
                      {pm.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Commentaire / Justificatif</label>
              <input
                type="text"
                value={expComment}
                onChange={(e) => setExpComment(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setExpModal(false)}
                className="px-4 py-2 bg-slate-100 rounded-lg cursor-pointer"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="px-4 py-2 font-semibold bg-teal-700 text-white rounded-lg cursor-pointer"
              >
                Valider la dépense
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
