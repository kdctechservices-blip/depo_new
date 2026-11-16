import React, { useEffect, useState } from 'react';
import { apiFetch } from '../utils/api';
import { exportToExcel, exportToPDF, formatXOF } from '../utils/format';
import type { CompanySettings } from '../types';

interface MarginData {
  summary: {
    totalRevenue: number;
    totalCogs: number;
    totalMargin: number;
    totalExpenses: number;
    estimatedResult: number;
    marginRatePct: number;
    markupRatePct: number;
  };
  byProduct: Array<{
    product_id: number;
    sku: string;
    product_name: string;
    category_name: string;
    net_base_qty: number;
    revenue_xof: number;
    cogs_xof: number;
    gross_margin_xof: number;
    margin_rate_pct: number;
    markup_rate_pct: number;
  }>;
}

export const MarginsPage: React.FC<{ company: CompanySettings | null }> = ({ company }) => {
  const [fromDate, setFromDate] = useState(() => new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<MarginData | null>(null);

  const loadData = async () => {
    const res = await apiFetch<MarginData>(
      `/api/margins?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`,
    );
    setData(res);
  };

  useEffect(() => {
    void loadData();
  }, [fromDate, toDate]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-slate-600">Période d’analyse :</span>
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

        {data && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                exportToExcel(
                  [
                    {
                      name: 'Marges',
                      rows: data.byProduct.map((p) => ({
                        SKU: p.sku,
                        Produit: p.product_name,
                        Categorie: p.category_name,
                        Qte_Nette: p.net_base_qty,
                        CA_Net_FCFA: p.revenue_xof,
                        Cout_Vendu_FCFA: p.cogs_xof,
                        Marge_Brute_FCFA: p.gross_margin_xof,
                        Taux_Marge_Pct: p.margin_rate_pct,
                        Taux_Marque_Pct: p.markup_rate_pct,
                      })),
                    },
                  ],
                  `GestDepot_Marges_${fromDate}_${toDate}.xlsx`,
                )
              }
              className="px-3 py-1.5 text-xs font-medium bg-white border border-slate-200 hover:bg-slate-50 rounded-lg cursor-pointer"
            >
              Exporter Excel
            </button>
            <button
              type="button"
              onClick={() =>
                exportToPDF({
                  title: 'Analyse des marges et rentabilité',
                  subtitle: `Période du ${fromDate} au ${toDate} · Coûts historiques mémorisés à la vente`,
                  company,
                  columns: ['SKU', 'Produit', 'Qté nette', 'CA net', 'Coût vendu', 'Marge brute', 'Taux marge'],
                  rows: data.byProduct.map((p) => [
                    p.sku,
                    p.product_name,
                    p.net_base_qty,
                    formatXOF(p.revenue_xof),
                    formatXOF(p.cogs_xof),
                    formatXOF(p.gross_margin_xof),
                    `${p.margin_rate_pct}%`,
                  ]),
                  totalsLine: `Marge brute : ${formatXOF(data.summary.totalMargin)} | Dépenses : ${formatXOF(data.summary.totalExpenses)} | Résultat estimatif de gestion : ${formatXOF(data.summary.estimatedResult)}`,
                  filename: `GestDepot_Marges_${fromDate}_${toDate}.pdf`,
                })
              }
              className="px-3 py-1.5 text-xs font-medium bg-white border border-slate-200 hover:bg-slate-50 rounded-lg cursor-pointer"
            >
              Exporter PDF
            </button>
          </div>
        )}
      </div>

      {data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Ventes nettes (hors consignes)</div>
              <div className="font-mono text-lg font-bold text-slate-900 mt-1 tabular-nums">
                {formatXOF(data.summary.totalRevenue)}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Coût des marchandises vendues</div>
              <div className="font-mono text-lg font-bold text-slate-900 mt-1 tabular-nums">
                {formatXOF(data.summary.totalCogs)}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Marge brute période</div>
              <div className="font-mono text-lg font-bold text-teal-800 mt-1 tabular-nums">
                {formatXOF(data.summary.totalMargin)}
              </div>
              <div className="text-[11px] text-slate-500">
                Marge {data.summary.marginRatePct}% · Marque {data.summary.markupRatePct}%
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Dépenses prises en compte</div>
              <div className="font-mono text-lg font-bold text-slate-900 mt-1 tabular-nums">
                {formatXOF(data.summary.totalExpenses)}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Résultat estimatif de gestion</div>
              <div
                className={`font-mono text-lg font-bold mt-1 tabular-nums ${
                  data.summary.estimatedResult >= 0 ? 'text-emerald-700' : 'text-red-700'
                }`}
              >
                {formatXOF(data.summary.estimatedResult)}
              </div>
              <div className="text-[11px] text-slate-500">Indicateur de gestion interne</div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <tr>
                  <th className="text-left px-4 py-3 font-semibold">SKU</th>
                  <th className="text-left px-4 py-3 font-semibold">Produit</th>
                  <th className="text-right px-4 py-3 font-semibold">Qté nette</th>
                  <th className="text-right px-4 py-3 font-semibold">CA net</th>
                  <th className="text-right px-4 py-3 font-semibold">Coût historique vendu</th>
                  <th className="text-right px-4 py-3 font-semibold">Marge brute</th>
                  <th className="text-right px-4 py-3 font-semibold">Taux marge</th>
                  <th className="text-right px-4 py-3 font-semibold">Taux marque</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.byProduct.map((p) => (
                  <tr key={p.product_id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-mono text-slate-600">{p.sku}</td>
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-900">{p.product_name}</div>
                      <div className="text-[11px] text-slate-500">{p.category_name}</div>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">{p.net_base_qty}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatXOF(p.revenue_xof)}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-600">
                      {formatXOF(p.cogs_xof)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums font-bold text-teal-800">
                      {formatXOF(p.gross_margin_xof)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">{p.margin_rate_pct}%</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">{p.markup_rate_pct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};
