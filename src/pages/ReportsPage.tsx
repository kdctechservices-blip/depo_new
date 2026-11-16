import React, { useEffect, useState } from 'react';
import { CheckCircle2, Download, FileText, ShieldCheck } from 'lucide-react';
import { apiFetch } from '../utils/api';
import { exportToExcel, exportToPDF } from '../utils/format';
import { exportTableData } from '../utils/exportTable';
import type { CompanySettings } from '../types';

const REPORT_TYPES = [
  { id: 'ventes', label: 'Ventes' },
  { id: 'encaissements', label: 'Encaissements' },
  { id: 'credits', label: 'Crédits clients' },
  { id: 'fournisseurs', label: 'Fournisseurs' },
  { id: 'stock', label: 'Stock valorisé' },
  { id: 'marges', label: 'Marges' },
  { id: 'depenses', label: 'Dépenses' },
  { id: 'caisse', label: 'Sessions de caisse' },
  { id: 'consignes', label: 'Consignes' },
  { id: 'livraisons', label: 'Livraisons' },
  { id: 'inventaires', label: 'Inventaires' },
  { id: 'activite', label: 'Activité utilisateurs' },
];

export const ReportsPage: React.FC<{ company: CompanySettings | null }> = ({ company }) => {
  const [selectedType, setSelectedType] = useState('ventes');
  const [fromDate, setFromDate] = useState(() => new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [reconciliation, setReconciliation] = useState<{
    sqliteIntegrity: string;
    stockDiscrepancies: unknown[];
    cashDiscrepancies: unknown[];
    salesBalanceAnomalies: number;
    salesChecked: number;
  } | null>(null);

  const loadReport = async () => {
    const res = await apiFetch<{ type: string; rows: Array<Record<string, unknown>> }>(
      `/api/reports/${selectedType}?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`,
    );
    setRows(res.rows);
  };

  useEffect(() => {
    void loadReport();
  }, [selectedType, fromDate, toDate]);

  const runGlobalReconciliation = async () => {
    const res = await apiFetch<typeof reconciliation>('/api/reconciliation');
    setReconciliation(res);
  };

  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  const activeReportLabel = REPORT_TYPES.find((r) => r.id === selectedType)?.label || selectedType;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg"
          />
          <span className="text-slate-400">au</span>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void runGlobalReconciliation()}
            className="px-3 py-2 text-xs font-medium bg-white border border-slate-200 hover:bg-slate-50 rounded-lg flex items-center gap-1.5 cursor-pointer"
          >
            <ShieldCheck className="w-3.5 h-3.5 text-teal-700" />
            Rapprochement global
          </button>
          <button
            type="button"
            onClick={() =>
              exportTableData<Record<string, unknown>>({
                format: 'csv',
                rows,
                columns: columns.map((col) => ({
                  header: col,
                  accessor: (r) => r[col] as string | number | null | undefined,
                })),
                filename: `GestDepot_Rapport_${selectedType}_${fromDate}_${toDate}`,
              })
            }
            disabled={rows.length === 0}
            className="px-3.5 py-2 text-xs font-medium bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-45 text-slate-700 rounded-lg flex items-center gap-1.5 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Exporter CSV
          </button>
          <button
            type="button"
            onClick={() =>
              exportToExcel(
                [{ name: activeReportLabel, rows }],
                `GestDepot_Rapport_${selectedType}_${fromDate}_${toDate}.xlsx`,
              )
            }
            className="px-3.5 py-2 text-xs font-semibold bg-teal-700 hover:bg-teal-800 text-white rounded-lg flex items-center gap-1.5 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Exporter Excel (.xlsx)
          </button>
          <button
            type="button"
            onClick={() =>
              exportToPDF({
                title: `Rapport : ${activeReportLabel}`,
                subtitle: `Période du ${fromDate} au ${toDate} · ${rows.length} ligne(s)`,
                company,
                columns,
                rows: rows.map((r) => columns.map((c) => String(r[c] ?? '—'))),
                filename: `GestDepot_Rapport_${selectedType}.pdf`,
              })
            }
            className="px-3.5 py-2 text-xs font-medium bg-slate-900 hover:bg-slate-800 text-white rounded-lg flex items-center gap-1.5 cursor-pointer"
          >
            <FileText className="w-3.5 h-3.5" />
            Exporter PDF
          </button>
        </div>
      </div>

      {reconciliation && (
        <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-900 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-1.5 font-semibold">
            <CheckCircle2 className="w-4 h-4 text-emerald-700" />
            Contrôle d’intégrité SQLite : {reconciliation.sqliteIntegrity.toUpperCase()}
          </div>
          <span>·</span>
          <span>Écarts stock/journal : {reconciliation.stockDiscrepancies.length}</span>
          <span>·</span>
          <span>Écarts caisse/mouvements : {reconciliation.cashDiscrepancies.length}</span>
          <span>·</span>
          <span>
            Cohérence ventes/paiements ({reconciliation.salesChecked} vtes) : {reconciliation.salesBalanceAnomalies}{' '}
            anomalie(s)
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        <div className="lg:col-span-3 bg-white border border-slate-200 rounded-xl p-2 space-y-0.5">
          {REPORT_TYPES.map((rt) => (
            <button
              key={rt.id}
              type="button"
              onClick={() => setSelectedType(rt.id)}
              className={`w-full text-left px-3 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                selectedType === rt.id ? 'bg-teal-700 text-white' : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              {rt.label}
            </button>
          ))}
        </div>

        <div className="lg:col-span-9 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-900">Aperçu : {activeReportLabel}</span>
            <span className="text-slate-500">{rows.length} enregistrement(s)</span>
          </div>
          <div className="overflow-x-auto max-h-[540px]">
            {rows.length === 0 ? (
              <div className="p-10 text-center text-xs text-slate-500">
                Aucune donnée trouvée pour cette période.
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 sticky top-0">
                  <tr>
                    {columns.map((col) => (
                      <th key={col} className="text-left px-3 py-2.5 font-semibold whitespace-nowrap">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r, i) => (
                    <tr key={i} className="hover:bg-slate-50">
                      {columns.map((col) => (
                        <td key={col} className="px-3 py-2 font-mono text-[11px] text-slate-800 whitespace-nowrap">
                          {String(r[col] ?? '—')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
