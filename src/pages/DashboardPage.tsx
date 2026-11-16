import React, { useEffect, useState } from 'react';
import { AlertTriangle, ArrowUpRight, BellRing, Calendar, Eye, RefreshCw, X } from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { apiFetch } from '../utils/api';
import { formatDate, formatNumber, formatXOF } from '../utils/format';
import type { NavKey } from '../types';

interface DailySalePoint {
  day: string;
  label: string;
  revenue_xof: number;
  returns_xof: number;
  net_revenue_xof: number;
  count: number;
}

interface WeeklySalePoint {
  week_key: string;
  label: string;
  week_start: string;
  week_end: string;
  revenue_xof: number;
  returns_xof: number;
  net_revenue_xof: number;
  count: number;
}

interface DashboardData {
  period: string;
  kpis: {
    netRevenueXof: number;
    salesCount: number;
    returnsXof: number;
    totalCollectionsXof: number;
    openReceivablesXof: number;
    openCreditSales: number;
    openPayablesXof: number;
    expensesXof: number;
    grossMarginXof: number;
    estimatedResultXof: number;
    stockValueXof: number;
    outOfStockCount: number;
    lowStockCount: number;
    pendingOrdersCount: number;
    pendingDeliveriesCount: number;
  };
  collectionsByMethod: Array<{ payment_method: string; total_xof: number }>;
  salesByDay: DailySalePoint[];
  salesByWeek: WeeklySalePoint[];
  salesByCategory: Array<{ category: string; revenue_xof: number; margin_xof: number }>;
  topProducts: Array<{
    product_id: number;
    product_name: string;
    total_base_qty: number;
    revenue_xof: number;
    margin_xof: number;
  }>;
  lowStockItems: Array<{
    id: number;
    sku: string;
    name: string;
    category_name: string;
    available_qty: number;
    physical_qty: number;
    reserved_qty: number;
    min_threshold: number;
    safety_stock: number;
    unit_code: string;
    unit_label: string;
    default_supplier_name: string | null;
  }>;
  overdueCredits: Array<{
    id: number;
    sale_number: string;
    customer_name: string;
    credit_due_xof: number;
    due_date: string;
  }>;
  lastBackup: { id: number; filename: string; integrity_ok: number; created_at: string } | null;
}

interface DashboardPageProps {
  onNavigate: (nav: NavKey) => void;
}

const PERIOD_OPTIONS = [
  { id: 'today', label: 'Aujourd’hui' },
  { id: 'yesterday', label: 'Hier' },
  { id: '7d', label: '7 derniers jours' },
  { id: 'month', label: 'Mois en cours' },
  { id: 'custom', label: 'Période personnalisée' },
];

function formatCompactXofAxis(value: number): string {
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return String(value);
}

interface ChartTooltipPayloadItem<T> {
  payload?: T;
  value?: number;
}

const DailyChartTooltip: React.FC<{
  active?: boolean;
  payload?: Array<ChartTooltipPayloadItem<DailySalePoint>>;
}> = ({ active, payload }) => {
  const item = payload?.[0]?.payload;
  if (!active || !item) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-lg px-3 py-2 shadow-md text-xs space-y-1">
      <div className="font-semibold text-slate-900">{formatDate(item.day)}</div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-slate-500">CA net :</span>
        <span className="font-mono font-bold text-teal-800 tabular-nums">{formatXOF(item.revenue_xof)}</span>
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-slate-500">Tickets :</span>
        <span className="font-mono font-medium text-slate-800 tabular-nums">{item.count} vente(s)</span>
      </div>
      {item.returns_xof > 0 && (
        <div className="flex items-center justify-between gap-4">
          <span className="text-slate-500">Retours :</span>
          <span className="font-mono text-red-700 tabular-nums">-{formatXOF(item.returns_xof)}</span>
        </div>
      )}
    </div>
  );
};

const WeeklyChartTooltip: React.FC<{
  active?: boolean;
  payload?: Array<ChartTooltipPayloadItem<WeeklySalePoint>>;
}> = ({ active, payload }) => {
  const item = payload?.[0]?.payload;
  if (!active || !item) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-lg px-3 py-2 shadow-md text-xs space-y-1">
      <div className="font-semibold text-slate-900">
        {item.week_key} · {formatDate(item.week_start)} au {formatDate(item.week_end)}
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-slate-500">CA hebdomadaire :</span>
        <span className="font-mono font-bold text-teal-800 tabular-nums">{formatXOF(item.revenue_xof)}</span>
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-slate-500">Volume :</span>
        <span className="font-mono font-medium text-slate-800 tabular-nums">{item.count} vente(s)</span>
      </div>
      {item.returns_xof > 0 && (
        <div className="flex items-center justify-between gap-4">
          <span className="text-slate-500">Retours :</span>
          <span className="font-mono text-red-700 tabular-nums">-{formatXOF(item.returns_xof)}</span>
        </div>
      )}
    </div>
  );
};

export const DashboardPage: React.FC<DashboardPageProps> = ({ onNavigate }) => {
  const [period, setPeriod] = useState('7d');
  const [fromDate, setFromDate] = useState(() => new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10));
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [dailyChartMode, setDailyChartMode] = useState<'area' | 'bar'>('area');
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAllStockAlerts, setShowAllStockAlerts] = useState(false);
  const [dismissedStockAlert, setDismissedStockAlert] = useState(false);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const qs =
        period === 'custom'
          ? `?period=custom&from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`
          : `?period=${period}`;
      const res = await apiFetch<DashboardData>(`/api/dashboard${qs}`);
      setData(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [period, fromDate, toDate]);

  const maxCatRev = Math.max(1, ...(data?.salesByCategory.map((c) => c.revenue_xof) ?? [1]));
  const weeklyPoints = data?.salesByWeek ?? [];
  const currentWeekRev = weeklyPoints.length > 0 ? weeklyPoints[weeklyPoints.length - 1].revenue_xof : 0;
  const prevWeekRev = weeklyPoints.length > 1 ? weeklyPoints[weeklyPoints.length - 2].revenue_xof : 0;
  const weekDeltaPct =
    prevWeekRev > 0 ? Math.round(((currentWeekRev - prevWeekRev) / prevWeekRev) * 100) : null;

  return (
    <div className="space-y-6">
      {/* Period Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setPeriod(opt.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                period === opt.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {period === 'custom' && (
            <div className="flex items-center gap-2 text-xs">
              <Calendar className="w-3.5 h-3.5 text-slate-500" />
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs"
              />
              <span className="text-slate-400">au</span>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs"
              />
            </div>
          )}
          <button
            type="button"
            onClick={() => void loadData()}
            className="px-3 py-1.5 text-xs font-medium bg-white border border-slate-200 hover:bg-slate-50 rounded-lg flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Actualiser
          </button>
        </div>
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{error}</div>}

      {loading && !data ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-24 bg-white border border-slate-200 rounded-xl" />
          ))}
        </div>
      ) : data ? (
        <>
          {/* Visual Critical Stock Notification Banner */}
          {data.lowStockItems.length > 0 && !dismissedStockAlert && (
            <section
              role="alert"
              aria-live="polite"
              className={`rounded-xl border p-4 space-y-3 ${
                data.kpis.outOfStockCount > 0
                  ? 'bg-red-50/80 border-red-300 text-red-950'
                  : 'bg-amber-50/80 border-amber-300 text-amber-950'
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div
                    className={`p-2 rounded-lg shrink-0 ${
                      data.kpis.outOfStockCount > 0
                        ? 'bg-red-100 text-red-700'
                        : 'bg-amber-100 text-amber-700'
                    }`}
                  >
                    <BellRing className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="font-display font-bold text-sm">
                      Alerte stock critique : {data.lowStockItems.length} produit(s) sous le seuil du catalogue
                    </h2>
                    <p
                      className={`text-xs mt-0.5 ${
                        data.kpis.outOfStockCount > 0 ? 'text-red-800' : 'text-amber-800'
                      }`}
                    >
                      {data.kpis.outOfStockCount} produit(s) en rupture complète ·{' '}
                      {Math.max(0, data.lowStockItems.length - data.kpis.outOfStockCount)} produit(s) sous seuil minimum
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onNavigate('stock')}
                    className="px-3 py-1.5 text-xs font-medium bg-white border border-slate-200 text-slate-800 hover:bg-slate-50 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Voir les stocks
                  </button>
                  <button
                    type="button"
                    onClick={() => onNavigate('purchases')}
                    className={`px-3 py-1.5 text-xs font-semibold text-white rounded-lg whitespace-nowrap shrink-0 cursor-pointer ${
                      data.kpis.outOfStockCount > 0
                        ? 'bg-red-700 hover:bg-red-800'
                        : 'bg-amber-700 hover:bg-amber-800'
                    }`}
                  >
                    Créer un réapprovisionnement
                  </button>
                  <button
                    type="button"
                    onClick={() => setDismissedStockAlert(true)}
                    className="p-1.5 text-slate-600 hover:text-slate-900 rounded-lg hover:bg-white/70 cursor-pointer"
                    title="Masquer la bannière d’alerte"
                    aria-label="Masquer la bannière d’alerte"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="bg-white/90 border border-slate-200/80 rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50/90 border-b border-slate-200 text-slate-600">
                      <tr>
                        <th className="text-left px-3 py-2 font-semibold">Produit / Référence</th>
                        <th className="text-left px-3 py-2 font-semibold">État</th>
                        <th className="text-right px-3 py-2 font-semibold">Disponible</th>
                        <th className="text-right px-3 py-2 font-semibold">Seuil min.</th>
                        <th className="text-right px-3 py-2 font-semibold">Manquant</th>
                        <th className="text-left px-3 py-2 font-semibold">Fournisseur habituel</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(showAllStockAlerts ? data.lowStockItems : data.lowStockItems.slice(0, 4)).map((item) => {
                        const isOut = item.available_qty <= 0;
                        const deficit = Math.max(0, item.min_threshold - item.available_qty);
                        return (
                          <tr key={item.id} className="hover:bg-slate-50/70">
                            <td className="px-3 py-2">
                              <div className="font-medium text-slate-900">{item.name}</div>
                              <div className="text-[11px] text-slate-500">
                                {item.sku} · {item.category_name}
                              </div>
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              <span className={`font-semibold ${isOut ? 'text-red-700' : 'text-amber-700'}`}>
                                {isOut ? 'Rupture de stock' : 'Sous seuil critique'}
                              </span>
                            </td>
                            <td
                              className={`px-3 py-2 text-right font-mono tabular-nums font-bold ${
                                isOut ? 'text-red-700' : 'text-amber-700'
                              }`}
                            >
                              {formatNumber(item.available_qty)} {item.unit_code}
                            </td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-600">
                              {formatNumber(item.min_threshold)} {item.unit_code}
                            </td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums font-semibold text-slate-900">
                              {deficit > 0 ? `+${formatNumber(deficit)} ${item.unit_code}` : '—'}
                            </td>
                            <td className="px-3 py-2 text-slate-600">
                              {item.default_supplier_name || 'Non défini'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {data.lowStockItems.length > 4 && (
                  <div className="px-3 py-2 border-t border-slate-100 bg-slate-50/70 flex items-center justify-between text-xs">
                    <span className="text-slate-500">
                      {showAllStockAlerts
                        ? `Affichage des ${data.lowStockItems.length} produits en alerte`
                        : `${data.lowStockItems.length - 4} autre(s) produit(s) sous le seuil critique`}
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowAllStockAlerts((prev) => !prev)}
                      className="text-teal-700 hover:underline font-medium cursor-pointer"
                    >
                      {showAllStockAlerts
                        ? 'Réduire la liste'
                        : `Afficher tout (${data.lowStockItems.length})`}
                    </button>
                  </div>
                )}
              </div>
            </section>
          )}

          {data.lowStockItems.length > 0 && dismissedStockAlert && (
            <div className="flex items-center justify-between px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900">
              <span className="font-medium flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
                {data.lowStockItems.length} produit(s) sous le seuil critique du catalogue
              </span>
              <button
                type="button"
                onClick={() => setDismissedStockAlert(false)}
                className="text-amber-900 hover:underline font-semibold inline-flex items-center gap-1 cursor-pointer"
              >
                <Eye className="w-3.5 h-3.5" />
                Afficher l’alerte
              </button>
            </div>
          )}

          {/* 8 Primary KPIs (clickable to open detail) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <button
              type="button"
              onClick={() => onNavigate('pos')}
              className="text-left bg-white border border-slate-200 hover:border-teal-700/50 rounded-xl p-4 transition-colors cursor-pointer group"
            >
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>CA net (hors consignes)</span>
                <ArrowUpRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-teal-700" />
              </div>
              <div className="mt-1.5 font-mono text-xl font-bold text-slate-900 tabular-nums">
                {formatXOF(data.kpis.netRevenueXof)}
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                {data.kpis.salesCount} vente(s) · Retours {formatXOF(data.kpis.returnsXof)}
              </div>
            </button>

            <button
              type="button"
              onClick={() => onNavigate('cash_expenses')}
              className="text-left bg-white border border-slate-200 hover:border-teal-700/50 rounded-xl p-4 transition-colors cursor-pointer group"
            >
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>Encaissements réels</span>
                <ArrowUpRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-teal-700" />
              </div>
              <div className="mt-1.5 font-mono text-xl font-bold text-emerald-700 tabular-nums">
                {formatXOF(data.kpis.totalCollectionsXof)}
              </div>
              <div className="mt-1 text-[11px] text-slate-500 truncate">
                {data.collectionsByMethod.map((m) => `${m.payment_method}: ${formatNumber(m.total_xof)}`).join(' · ') ||
                  'Aucun encaissement'}
              </div>
            </button>

            <button
              type="button"
              onClick={() => onNavigate('customers')}
              className="text-left bg-white border border-slate-200 hover:border-teal-700/50 rounded-xl p-4 transition-colors cursor-pointer group"
            >
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>Créances clients ouvertes</span>
                <ArrowUpRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-teal-700" />
              </div>
              <div className="mt-1.5 font-mono text-xl font-bold text-amber-700 tabular-nums">
                {formatXOF(data.kpis.openReceivablesXof)}
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                {data.kpis.openCreditSales} facture(s) à recouvrer · {data.overdueCredits.length} échue(s)
              </div>
            </button>

            <button
              type="button"
              onClick={() => onNavigate('suppliers')}
              className="text-left bg-white border border-slate-200 hover:border-teal-700/50 rounded-xl p-4 transition-colors cursor-pointer group"
            >
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>Dettes fournisseurs</span>
                <ArrowUpRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-teal-700" />
              </div>
              <div className="mt-1.5 font-mono text-xl font-bold text-slate-900 tabular-nums">
                {formatXOF(data.kpis.openPayablesXof)}
              </div>
              <div className="mt-1 text-[11px] text-slate-500">Solde achats confirmés non réglés</div>
            </button>

            <button
              type="button"
              onClick={() => onNavigate('margins')}
              className="text-left bg-white border border-slate-200 hover:border-teal-700/50 rounded-xl p-4 transition-colors cursor-pointer group"
            >
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>Marge brute estimée</span>
                <ArrowUpRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-teal-700" />
              </div>
              <div className="mt-1.5 font-mono text-xl font-bold text-teal-800 tabular-nums">
                {formatXOF(data.kpis.grossMarginXof)}
              </div>
              <div className="mt-1 text-[11px] text-slate-500">Coûts mémorisés à la vente (CUMP)</div>
            </button>

            <button
              type="button"
              onClick={() => onNavigate('cash_expenses')}
              className="text-left bg-white border border-slate-200 hover:border-teal-700/50 rounded-xl p-4 transition-colors cursor-pointer group"
            >
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>Dépenses de la période</span>
                <ArrowUpRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-teal-700" />
              </div>
              <div className="mt-1.5 font-mono text-xl font-bold text-slate-900 tabular-nums">
                {formatXOF(data.kpis.expensesXof)}
              </div>
              <div className="mt-1 text-[11px] text-slate-500">Exploitation, carburant, énergie</div>
            </button>

            <button
              type="button"
              onClick={() => onNavigate('margins')}
              className="text-left bg-white border border-slate-200 hover:border-teal-700/50 rounded-xl p-4 transition-colors cursor-pointer group"
            >
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>Résultat estimatif de gestion</span>
                <ArrowUpRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-teal-700" />
              </div>
              <div
                className={`mt-1.5 font-mono text-xl font-bold tabular-nums ${
                  data.kpis.estimatedResultXof >= 0 ? 'text-emerald-700' : 'text-red-700'
                }`}
              >
                {formatXOF(data.kpis.estimatedResultXof)}
              </div>
              <div className="mt-1 text-[11px] text-slate-500">Marge brute − Dépenses</div>
            </button>

            <button
              type="button"
              onClick={() => onNavigate('stock')}
              className={`text-left border rounded-xl p-4 transition-colors cursor-pointer group ${
                data.kpis.outOfStockCount > 0
                  ? 'bg-red-50/40 border-red-300 hover:border-red-500'
                  : data.kpis.lowStockCount > 0
                    ? 'bg-amber-50/40 border-amber-300 hover:border-amber-500'
                    : 'bg-white border-slate-200 hover:border-teal-700/50'
              }`}
            >
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>Valeur du stock (CUMP)</span>
                <ArrowUpRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-teal-700" />
              </div>
              <div className="mt-1.5 font-mono text-xl font-bold text-slate-900 tabular-nums">
                {formatXOF(data.kpis.stockValueXof)}
              </div>
              <div
                className={`mt-1 text-[11px] font-medium ${
                  data.kpis.outOfStockCount > 0
                    ? 'text-red-700'
                    : data.kpis.lowStockCount > 0
                      ? 'text-amber-700'
                      : 'text-slate-500'
                }`}
              >
                {data.kpis.lowStockCount} sous seuil · {data.kpis.outOfStockCount} en rupture
              </div>
            </button>
          </div>

          {/* Recharts Row: Daily Sales + Weekly Sales */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Daily Sales Chart */}
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <div>
                  <h2 className="font-display font-semibold text-sm text-slate-900">Ventes journalières (FCFA)</h2>
                  <p className="text-xs text-slate-500">
                    Chiffre d’affaires quotidien net hors consignes ({data.salesByDay.length} jours)
                  </p>
                </div>
                <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setDailyChartMode('area')}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      dailyChartMode === 'area' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Courbe
                  </button>
                  <button
                    type="button"
                    onClick={() => setDailyChartMode('bar')}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      dailyChartMode === 'bar' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Barres
                  </button>
                </div>
              </div>

              {data.salesByDay.every((d) => d.revenue_xof === 0) ? (
                <div className="h-64 flex items-center justify-center text-xs text-slate-500">
                  Aucune vente enregistrée sur cette fenêtre journalière.
                </div>
              ) : (
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    {dailyChartMode === 'area' ? (
                      <AreaChart data={data.salesByDay} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="dailyRevenueFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#0f766e" stopOpacity={0.28} />
                            <stop offset="95%" stopColor="#0f766e" stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                        <XAxis
                          dataKey="label"
                          tick={{ fontSize: 11, fill: '#64748b' }}
                          axisLine={{ stroke: '#e2e8f0' }}
                          tickLine={false}
                        />
                        <YAxis
                          tickFormatter={formatCompactXofAxis}
                          tick={{ fontSize: 11, fill: '#64748b' }}
                          axisLine={false}
                          tickLine={false}
                          width={46}
                        />
                        <Tooltip content={<DailyChartTooltip />} />
                        <Area
                          type="monotone"
                          dataKey="revenue_xof"
                          stroke="#0f766e"
                          strokeWidth={2.2}
                          fill="url(#dailyRevenueFill)"
                          activeDot={{ r: 5, fill: '#0f766e', stroke: '#ffffff', strokeWidth: 2 }}
                        />
                      </AreaChart>
                    ) : (
                      <BarChart data={data.salesByDay} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                        <XAxis
                          dataKey="label"
                          tick={{ fontSize: 11, fill: '#64748b' }}
                          axisLine={{ stroke: '#e2e8f0' }}
                          tickLine={false}
                        />
                        <YAxis
                          tickFormatter={formatCompactXofAxis}
                          tick={{ fontSize: 11, fill: '#64748b' }}
                          axisLine={false}
                          tickLine={false}
                          width={46}
                        />
                        <Tooltip content={<DailyChartTooltip />} />
                        <Bar dataKey="revenue_xof" fill="#0f766e" radius={[6, 6, 0, 0]} maxBarSize={42} />
                      </BarChart>
                    )}
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            {/* Weekly Sales Chart (8 weeks) */}
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <div>
                  <h2 className="font-display font-semibold text-sm text-slate-900">Ventes hebdomadaires (8 semaines)</h2>
                  <p className="text-xs text-slate-500">
                    Comparatif hebdomadaire du lundi au dimanche · Semaine en cours :{' '}
                    <span className="font-mono font-semibold text-slate-800 tabular-nums">
                      {formatXOF(currentWeekRev)}
                    </span>
                  </p>
                </div>
                {weekDeltaPct !== null && (
                  <span
                    className={`text-xs font-mono font-semibold tabular-nums ${
                      weekDeltaPct >= 0 ? 'text-emerald-700' : 'text-red-700'
                    }`}
                  >
                    {weekDeltaPct >= 0 ? `+${weekDeltaPct}%` : `${weekDeltaPct}%`} vs S-1
                  </span>
                )}
              </div>

              {weeklyPoints.every((w) => w.revenue_xof === 0) ? (
                <div className="h-64 flex items-center justify-center text-xs text-slate-500">
                  Aucune vente enregistrée sur les 8 dernières semaines.
                </div>
              ) : (
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={weeklyPoints} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                      <XAxis
                        dataKey="label"
                        tick={{ fontSize: 11, fill: '#64748b' }}
                        axisLine={{ stroke: '#e2e8f0' }}
                        tickLine={false}
                      />
                      <YAxis
                        tickFormatter={formatCompactXofAxis}
                        tick={{ fontSize: 11, fill: '#64748b' }}
                        axisLine={false}
                        tickLine={false}
                        width={46}
                      />
                      <Tooltip content={<WeeklyChartTooltip />} />
                      <Bar dataKey="revenue_xof" radius={[6, 6, 0, 0]} maxBarSize={44}>
                        {weeklyPoints.map((entry, idx) => (
                          <Cell
                            key={entry.week_key}
                            fill={idx === weeklyPoints.length - 1 ? '#0f766e' : '#334155'}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>

          {/* Bottom Grid: Payment Methods, Category Sales, Top Products, Operational Alerts */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
            {/* Payment Methods Breakdown */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between">
              <div>
                <h2 className="font-display font-semibold text-sm text-slate-900">Répartition des encaissements</h2>
                <p className="text-xs text-slate-500 mb-4">Espèces, Mobile Money et virements</p>
                <div className="space-y-3">
                  {data.collectionsByMethod.length === 0 ? (
                    <p className="text-xs text-slate-500">Aucun encaissement sur la période.</p>
                  ) : (
                    data.collectionsByMethod.map((m) => {
                      const pct =
                        data.kpis.totalCollectionsXof > 0
                          ? Math.round((m.total_xof / data.kpis.totalCollectionsXof) * 100)
                          : 0;
                      return (
                        <div key={m.payment_method} className="space-y-1">
                          <div className="flex justify-between text-xs">
                            <span className="font-medium text-slate-700">{m.payment_method}</span>
                            <span className="font-mono tabular-nums text-slate-900">
                              {formatXOF(m.total_xof)} ({pct}%)
                            </span>
                          </div>
                          <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                            <div className="h-full bg-teal-700 rounded-full" style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              <div className="pt-4 mt-4 border-t border-slate-100 flex items-center justify-between text-xs text-slate-600">
                <span>Commandes : {data.kpis.pendingOrdersCount}</span>
                <span>Livraisons : {data.kpis.pendingDeliveriesCount}</span>
              </div>
            </div>

            {/* Sales by Category */}
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <h2 className="font-display font-semibold text-sm text-slate-900 mb-3">Ventes par catégorie</h2>
              <div className="space-y-3">
                {data.salesByCategory.map((c) => {
                  const pct = Math.round((c.revenue_xof / maxCatRev) * 100);
                  return (
                    <div key={c.category} className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="text-slate-700 font-medium truncate pr-2">{c.category}</span>
                        <span className="font-mono tabular-nums text-slate-900">{formatXOF(c.revenue_xof)}</span>
                      </div>
                      <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div className="h-full bg-slate-800 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
                {data.salesByCategory.length === 0 && (
                  <p className="text-xs text-slate-500">Aucune donnée par catégorie.</p>
                )}
              </div>
            </div>

            {/* Top Products */}
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-display font-semibold text-sm text-slate-900">Produits les plus vendus</h2>
                <button
                  type="button"
                  onClick={() => onNavigate('margins')}
                  className="text-xs text-teal-700 hover:underline cursor-pointer"
                >
                  Voir marges
                </button>
              </div>
              <div className="divide-y divide-slate-100">
                {data.topProducts.map((tp) => (
                  <div key={tp.product_id} className="py-2 flex items-center justify-between gap-2 text-xs">
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900 truncate">{tp.product_name}</div>
                      <div className="text-[11px] text-slate-500 tabular-nums">
                        {formatNumber(tp.total_base_qty)} unité(s) · Marge {formatXOF(tp.margin_xof)}
                      </div>
                    </div>
                    <div className="font-mono font-semibold text-slate-900 tabular-nums shrink-0">
                      {formatXOF(tp.revenue_xof)}
                    </div>
                  </div>
                ))}
                {data.topProducts.length === 0 && (
                  <p className="text-xs text-slate-500">Aucune vente enregistrée.</p>
                )}
              </div>
            </div>

            {/* Operational Alerts */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-display font-semibold text-sm text-slate-900 flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                  Alertes opérationnelles
                </h2>
                <button
                  type="button"
                  onClick={() => onNavigate('purchases')}
                  className="text-xs text-teal-700 hover:underline cursor-pointer"
                >
                  Réapprovisionner
                </button>
              </div>

              {data.lowStockItems.length > 0 && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] font-semibold text-slate-500">
                    <span>Stocks sous seuil minimum</span>
                    <span>{data.lowStockItems.length} réf.</span>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {data.lowStockItems.slice(0, 8).map((item) => (
                      <div key={item.id} className="py-1.5 flex items-center justify-between text-xs">
                        <span className="text-slate-800 truncate pr-2">{item.name}</span>
                        <span
                          className={`font-mono tabular-nums shrink-0 font-semibold ${
                            item.available_qty <= 0 ? 'text-red-700' : 'text-amber-700'
                          }`}
                        >
                          {item.available_qty} / {item.min_threshold}
                        </span>
                      </div>
                    ))}
                  </div>
                  {data.lowStockItems.length > 8 && (
                    <button
                      type="button"
                      onClick={() => onNavigate('stock')}
                      className="text-[11px] text-teal-700 hover:underline font-medium cursor-pointer"
                    >
                      Voir les {data.lowStockItems.length - 8} autres alertes dans Stock →
                    </button>
                  )}
                </div>
              )}

              {data.overdueCredits.length > 0 && (
                <div className="space-y-1.5 pt-2 border-t border-slate-100">
                  <div className="text-[11px] font-semibold text-red-700">Crédits clients échus</div>
                  <div className="divide-y divide-slate-100">
                    {data.overdueCredits.map((cr) => (
                      <div key={cr.id} className="py-1.5 flex items-center justify-between text-xs">
                        <div className="min-w-0 pr-2">
                          <div className="text-slate-900 font-medium truncate">{cr.customer_name}</div>
                          <div className="text-[11px] text-slate-500">
                            {cr.sale_number} · Échéance {formatDate(cr.due_date)}
                          </div>
                        </div>
                        <span className="font-mono font-semibold text-red-700 tabular-nums shrink-0">
                          {formatXOF(cr.credit_due_xof)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {data.lowStockItems.length === 0 && data.overdueCredits.length === 0 && (
                <p className="text-xs text-slate-500">Aucune alerte critique détectée.</p>
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
};
