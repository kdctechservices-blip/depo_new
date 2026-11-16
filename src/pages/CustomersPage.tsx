import React, { useEffect, useState } from 'react';
import { CreditCard, FileText, Plus, Search } from 'lucide-react';
import { apiFetch } from '../utils/api';
import { exportToPDF, formatDate, formatDateTime, formatXOF } from '../utils/format';
import { accountingDateStamp, exportTableData, type TableExportFormat } from '../utils/exportTable';
import { TableExportButtons } from '../components/TableExportButtons';
import type { CatalogMeta, CompanySettings, Customer } from '../types';

interface StatementData {
  customer: Customer;
  sales: Array<{
    id: number;
    sale_number: string;
    status: string;
    total_xof: number;
    paid_xof: number;
    credit_due_xof: number;
    due_date: string | null;
    created_at: string;
  }>;
  payments: Array<{
    id: number;
    payment_number: string;
    amount_xof: number;
    payment_method: string;
    reference_note: string;
    user_name: string;
    created_at: string;
  }>;
  deposits: Array<{ packaging_code: string; packaging_label: string; qty_balance: number; value_xof: number }>;
}

export const CustomersPage: React.FC<{ company: CompanySettings | null }> = ({ company }) => {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [meta, setMeta] = useState<CatalogMeta | null>(null);
  const [search, setSearch] = useState('');
  const [statement, setStatement] = useState<StatementData | null>(null);

  const [newModal, setNewModal] = useState(false);
  const [fName, setFName] = useState('');
  const [fPhone, setFPhone] = useState('');
  const [fAddress, setFAddress] = useState('');
  const [fType, setFType] = useState('Gros');
  const [fPriceListId, setFPriceListId] = useState<number | ''>('');
  const [fLimit, setFLimit] = useState(0);

  const [payModalCust, setPayModalCust] = useState<Customer | null>(null);
  const [payAmount, setPayAmount] = useState(0);
  const [payMethod, setPayMethod] = useState('ESPECES');
  const [payNote, setPayNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const loadData = async () => {
    const [custs, m] = await Promise.all([
      apiFetch<Customer[]>('/api/customers'),
      apiFetch<CatalogMeta>('/api/catalog/meta'),
    ]);
    setCustomers(custs);
    setMeta(m);
    setFPriceListId((prev) => (prev && m.priceLists.some((p) => p.id === prev) ? prev : (m.priceLists[0]?.id ?? '')));
    if (m.paymentMethods.length > 0 && !m.paymentMethods.some((pm) => pm.code === payMethod)) {
      setPayMethod(m.paymentMethods[0].code);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const openStatement = async (id: number) => {
    const st = await apiFetch<StatementData>(`/api/customers/${id}/statement`);
    setStatement(st);
  };

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!fPriceListId) {
      setError('Sélectionnez une grille tarifaire.');
      return;
    }
    try {
      await apiFetch('/api/customers', {
        method: 'POST',
        body: JSON.stringify({
          name: fName,
          phone: fPhone,
          address: fAddress,
          customer_type: fType,
          price_list_id: Number(fPriceListId),
          credit_limit_xof: fLimit,
        }),
      });
      setNewModal(false);
      setFName('');
      setFPhone('');
      setFAddress('');
      setFLimit(0);
      setMsg('Client créé.');
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payModalCust) return;
    setError(null);
    try {
      const res = await apiFetch<{ paymentNumber: string }>('/api/customers/payments', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: payModalCust.id,
          amount_xof: payAmount,
          payment_method: payMethod,
          reference_note: payNote,
        }),
      });
      setPayModalCust(null);
      setPayNote('');
      setMsg(`Règlement ${res.paymentNumber} encaissé et affecté aux factures ouvertes.`);
      await loadData();
      if (statement && statement.customer.id === payModalCust.id) {
        await openStatement(payModalCust.id);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const filtered = customers.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.code.toLowerCase().includes(search.toLowerCase()) ||
      c.phone.includes(search),
  );

  const handleExportCustomers = (format: TableExportFormat) => {
    exportTableData({
      format,
      filename: `GestDepot_Clients_Credits_${accountingDateStamp()}`,
      sheetName: 'Clients et crédits',
      rows: filtered,
      columns: [
        { header: 'Code client', accessor: (c) => c.code },
        { header: 'Nom / Raison sociale', accessor: (c) => c.name },
        { header: 'Type client', accessor: (c) => c.customer_type },
        { header: 'Téléphone', accessor: (c) => c.phone || '' },
        { header: 'Adresse', accessor: (c) => c.address || '' },
        { header: 'Grille tarifaire', accessor: (c) => c.price_list_label },
        { header: 'Plafond crédit (FCFA)', accessor: (c) => c.credit_limit_xof },
        { header: 'Solde créance dû (FCFA)', accessor: (c) => c.balance_due_xof },
        { header: 'Casiers consignés dus', accessor: (c) => c.deposit_qty_balance },
      ],
    });
  };

  const handleExportStatement = (format: TableExportFormat) => {
    if (!statement) return;
    exportTableData({
      format,
      filename: `GestDepot_Releve_${statement.customer.code}_${accountingDateStamp()}`,
      sheetName: `Relevé ${statement.customer.code}`,
      rows: statement.sales,
      columns: [
        { header: 'N° Document', accessor: (s) => s.sale_number },
        { header: 'Date', accessor: (s) => formatDateTime(s.created_at) },
        { header: 'Statut', accessor: (s) => s.status },
        { header: 'Total (FCFA)', accessor: (s) => s.total_xof },
        { header: 'Payé (FCFA)', accessor: (s) => s.paid_xof },
        { header: 'Reste dû (FCFA)', accessor: (s) => s.credit_due_xof },
        { header: 'Échéance', accessor: (s) => (s.due_date ? formatDate(s.due_date) : '') },
      ],
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher un client par nom, code ou téléphone..."
            className="w-full pl-9 pr-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TableExportButtons onExport={handleExportCustomers} disabled={filtered.length === 0} />
          <button
            type="button"
            onClick={() => setNewModal(true)}
            className="px-3.5 py-2 text-xs font-semibold bg-teal-700 hover:bg-teal-800 text-white rounded-lg flex items-center gap-1.5 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Nouveau client
          </button>
        </div>
      </div>

      {msg && <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800">{msg}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        <div className={`${statement ? 'lg:col-span-7' : 'lg:col-span-12'} bg-white border border-slate-200 rounded-xl overflow-hidden`}>
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">Client</th>
                <th className="text-left px-4 py-3 font-semibold">Tarif</th>
                <th className="text-right px-4 py-3 font-semibold">Plafond crédit</th>
                <th className="text-right px-4 py-3 font-semibold">Solde dû</th>
                <th className="text-right px-4 py-3 font-semibold">Casiers dus</th>
                <th className="text-right px-4 py-3 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-slate-900">{c.name}</div>
                    <div className="text-[11px] text-slate-500">
                      {c.code} {c.phone ? `· ${c.phone}` : ''}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-slate-700">{c.price_list_label}</td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatXOF(c.credit_limit_xof)}</td>
                  <td
                    className={`px-4 py-2.5 text-right font-mono tabular-nums font-bold ${
                      c.balance_due_xof > 0 ? 'text-amber-700' : 'text-slate-600'
                    }`}
                  >
                    {formatXOF(c.balance_due_xof)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums">{c.deposit_qty_balance}</td>
                  <td className="px-4 py-2.5 text-right space-x-2 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => void openStatement(c.id)}
                      className="text-teal-700 hover:underline font-medium cursor-pointer"
                    >
                      Relevé
                    </button>
                    {c.balance_due_xof > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          setPayModalCust(c);
                          setPayAmount(c.balance_due_xof);
                          setError(null);
                        }}
                        className="text-emerald-700 hover:underline font-semibold cursor-pointer"
                      >
                        Encaisser
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Customer Statement Drawer */}
        {statement && (
          <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-2 border-b border-slate-100 pb-3">
              <div>
                <h3 className="font-display font-bold text-base text-slate-900">{statement.customer.name}</h3>
                <p className="text-xs text-slate-500">
                  {statement.customer.code} · {statement.customer.address || 'Adresse non renseignée'}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <TableExportButtons
                  compact
                  onExport={handleExportStatement}
                  disabled={statement.sales.length === 0}
                />
                <button
                  type="button"
                  onClick={() =>
                    exportToPDF({
                      title: `Relevé de compte — ${statement.customer.name}`,
                      subtitle: `Code : ${statement.customer.code} · Tarif : ${statement.customer.price_list_label}`,
                      company,
                      columns: ['Document', 'Date', 'Total', 'Payé', 'Reste dû', 'Échéance'],
                      rows: statement.sales.map((s) => [
                        s.sale_number,
                        formatDate(s.created_at),
                        formatXOF(s.total_xof),
                        formatXOF(s.paid_xof),
                        formatXOF(s.credit_due_xof),
                        s.due_date ? formatDate(s.due_date) : '—',
                      ]),
                      filename: `Releve_${statement.customer.code}.pdf`,
                    })
                  }
                  className="px-2.5 py-1 text-xs bg-slate-100 hover:bg-slate-200 rounded-md flex items-center gap-1 cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5" />
                  PDF
                </button>
                <button
                  type="button"
                  onClick={() => setStatement(null)}
                  className="px-2 py-1 text-xs text-slate-500 hover:text-slate-900 cursor-pointer"
                >
                  Fermer
                </button>
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold text-slate-800 mb-2">Ventes & Factures</div>
              <div className="max-h-52 overflow-y-auto divide-y divide-slate-100 text-xs">
                {statement.sales.map((s) => (
                  <div key={s.id} className="py-2 flex items-center justify-between">
                    <div>
                      <div className="font-mono font-semibold text-slate-900">{s.sale_number}</div>
                      <div className="text-[11px] text-slate-500">
                        {formatDateTime(s.created_at)}
                        {s.due_date && s.credit_due_xof > 0 ? ` · Éch. ${formatDate(s.due_date)}` : ''}
                      </div>
                    </div>
                    <div className="text-right font-mono tabular-nums">
                      <div>{formatXOF(s.total_xof)}</div>
                      {s.credit_due_xof > 0 && (
                        <div className="text-[11px] text-amber-700 font-semibold">
                          Dû : {formatXOF(s.credit_due_xof)}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {statement.payments.length > 0 && (
              <div className="pt-2 border-t border-slate-100">
                <div className="text-xs font-semibold text-slate-800 mb-2">Règlements de créances</div>
                <div className="divide-y divide-slate-100 text-xs">
                  {statement.payments.map((p) => (
                    <div key={p.id} className="py-1.5 flex items-center justify-between">
                      <div>
                        <span className="font-mono">{p.payment_number}</span> · {p.payment_method}
                      </div>
                      <span className="font-mono font-semibold text-emerald-700 tabular-nums">
                        +{formatXOF(p.amount_xof)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {statement.deposits.length > 0 && (
              <div className="pt-2 border-t border-slate-100">
                <div className="text-xs font-semibold text-slate-800 mb-1.5">Emballages consignés détenus</div>
                {statement.deposits.map((d, idx) => (
                  <div key={idx} className="flex justify-between text-xs py-1">
                    <span>{d.packaging_label}</span>
                    <span className="font-mono font-semibold">
                      {d.qty_balance} ({formatXOF(d.value_xof)})
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* New Customer Modal */}
      {newModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateCustomer}
            className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-3 shadow-lg text-xs"
          >
            <h3 className="font-display font-bold text-base text-slate-900">Nouveau client</h3>
            {error && <div className="p-2 bg-red-50 border border-red-200 rounded text-red-700">{error}</div>}
            <div>
              <label className="block font-medium text-slate-700 mb-1">Nom / Raison sociale</label>
              <input
                type="text"
                required
                value={fName}
                onChange={(e) => setFName(e.target.value)}
                placeholder="Nom ou raison sociale du client"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Téléphone</label>
                <input
                  type="text"
                  value={fPhone}
                  onChange={(e) => setFPhone(e.target.value)}
                  placeholder="Numéro de téléphone"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Type client</label>
                <select
                  value={fType}
                  onChange={(e) => setFType(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                >
                  <option value="Gros">Grossiste</option>
                  <option value="Revendeur">Revendeur</option>
                  <option value="Détail">Détail</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Adresse / Quartier</label>
              <input
                type="text"
                value={fAddress}
                onChange={(e) => setFAddress(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Grille tarifaire</label>
                <select
                  required
                  value={fPriceListId}
                  onChange={(e) => setFPriceListId(e.target.value ? Number(e.target.value) : '')}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                >
                  <option value="">Sélectionner un tarif...</option>
                  {meta?.priceLists.map((pl) => (
                    <option key={pl.id} value={pl.id}>
                      {pl.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Plafond crédit (FCFA)</label>
                <input
                  type="number"
                  min={0}
                  value={fLimit}
                  onChange={(e) => setFLimit(Math.round(Number(e.target.value) || 0))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setNewModal(false)}
                className="px-4 py-2 bg-slate-100 rounded-lg cursor-pointer"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="px-4 py-2 font-semibold bg-teal-700 text-white rounded-lg cursor-pointer"
              >
                Créer le client
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Payment Modal */}
      {payModalCust && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleRecordPayment}
            className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4 shadow-lg text-xs"
          >
            <h3 className="font-display font-bold text-base text-slate-900 flex items-center gap-2">
              <CreditCard className="w-4 h-4 text-teal-700" />
              Règlement créance — {payModalCust.name}
            </h3>
            <p className="text-slate-600">
              Solde ouvert total : <strong className="font-mono">{formatXOF(payModalCust.balance_due_xof)}</strong>
            </p>
            {error && <div className="p-2 bg-red-50 border border-red-200 rounded text-red-700">{error}</div>}
            <div>
              <label className="block font-medium text-slate-700 mb-1">Montant encaissé (FCFA)</label>
              <input
                type="number"
                min={1}
                max={payModalCust.balance_due_xof}
                value={payAmount}
                onChange={(e) => setPayAmount(Math.round(Number(e.target.value) || 0))}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono text-sm font-bold"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Moyen de paiement</label>
              <select
                value={payMethod}
                onChange={(e) => setPayMethod(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
              >
                {meta?.paymentMethods.map((pm) => (
                  <option key={pm.code} value={pm.code}>
                    {pm.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Référence / Commentaire</label>
              <input
                type="text"
                value={payNote}
                onChange={(e) => setPayNote(e.target.value)}
                placeholder="Référence ou commentaire"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPayModalCust(null)}
                className="px-4 py-2 bg-slate-100 rounded-lg cursor-pointer"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="px-4 py-2 font-semibold bg-teal-700 text-white rounded-lg cursor-pointer"
              >
                Encaisser le règlement
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
