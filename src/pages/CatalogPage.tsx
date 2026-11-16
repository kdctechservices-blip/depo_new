import React, { useEffect, useMemo, useState } from 'react';
import { Archive, Download, History, Plus, RefreshCw, Search, TrendingUp, Upload } from 'lucide-react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { apiFetch } from '../utils/api';
import { exportToExcel, exportToPDF, formatDateTime, formatXOF } from '../utils/format';
import type { CatalogMeta, CompanySettings, Product, SessionUser } from '../types';

interface CatalogPageProps {
  user: SessionUser;
  company: CompanySettings | null;
}

type PriceEventKind =
  | 'ACHAT_CUMP'
  | 'ACHAT_BON'
  | 'VENTE_TARIF_DETAIL'
  | 'VENTE_TARIF_GROS'
  | 'VENTE_TARIF_REVENDEUR'
  | 'VENTE_CLIENT';

interface PriceHistoryEvent {
  id: string;
  created_at: string;
  kind: PriceEventKind;
  kind_label: string;
  packaging_name: string;
  conversion_factor: number;
  previous_xof: number | null;
  new_xof: number;
  unit_normalized_xof: number;
  details: string;
}

interface PriceChartPoint {
  date: string;
  label: string;
  purchase_cost_xof: number;
  sale_detail_xof: number;
  sale_gros_xof: number;
  note: string;
}

interface PriceHistoryResponse {
  product: {
    id: number;
    sku: string;
    name: string;
    purchase_cost_xof: number;
    min_threshold: number;
    safety_stock: number;
    created_at: string;
    category_name: string;
    brand_name: string;
    unit_code: string;
    unit_label: string;
  };
  currentPackagings: Array<{ id: number; name: string; conversion_factor: number }>;
  currentPrices: Array<{
    price_xof: number;
    packaging_id: number;
    price_list_code: string;
    price_list_label: string;
    packaging_name: string;
    conversion_factor: number;
  }>;
  events: PriceHistoryEvent[];
  chartPoints: PriceChartPoint[];
}

function formatCompactPriceAxis(value: number): string {
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return String(value);
}

const PriceHistoryTooltip: React.FC<{
  active?: boolean;
  payload?: Array<{ payload?: PriceChartPoint }>;
}> = ({ active, payload }) => {
  const pt = payload?.[0]?.payload;
  if (!active || !pt) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-lg px-3 py-2.5 shadow-md text-xs space-y-1 max-w-xs">
      <div className="font-semibold text-slate-900">
        {pt.label} · {pt.date === 'Actuel' ? 'Tarif en vigueur' : formatDateTime(pt.date)}
      </div>
      {pt.note && <div className="text-[11px] text-slate-500 truncate">{pt.note}</div>}
      <div className="pt-1 space-y-1 border-t border-slate-100">
        <div className="flex items-center justify-between gap-4">
          <span className="text-slate-600">Coût achat / CUMP :</span>
          <span className="font-mono font-semibold text-slate-900 tabular-nums">{formatXOF(pt.purchase_cost_xof)}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-teal-700">Vente Détail (unité) :</span>
          <span className="font-mono font-semibold text-teal-800 tabular-nums">{formatXOF(pt.sale_detail_xof)}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-amber-700">Vente Gros (unité) :</span>
          <span className="font-mono font-semibold text-amber-800 tabular-nums">{formatXOF(pt.sale_gros_xof)}</span>
        </div>
      </div>
    </div>
  );
};

export const CatalogPage: React.FC<CatalogPageProps> = ({ user, company }) => {
  const canEdit = user.permissions.includes('catalog_edit');
  const [activeTab, setActiveTab] = useState<'catalogue' | 'price_history'>('catalogue');
  const [products, setProducts] = useState<Product[]>([]);
  const [meta, setMeta] = useState<CatalogMeta | null>(null);
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editModal, setEditModal] = useState<Partial<Product> | null>(null);
  const [importPreview, setImportPreview] = useState<
    Array<{
      sku: string;
      name: string;
      category: string;
      brand: string;
      purchase_cost_xof: number;
      pack_name: string;
      factor: number;
      price_detail_xof: number;
      price_gros_xof: number;
    }> | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Price history states
  const [historyProductId, setHistoryProductId] = useState<number | null>(null);
  const [priceHistoryData, setPriceHistoryData] = useState<PriceHistoryResponse | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyFilter, setHistoryFilter] = useState<'ALL' | 'ACHAT' | 'VENTE'>('ALL');

  // Form states for product create/edit
  const [formSku, setFormSku] = useState('');
  const [formName, setFormName] = useState('');
  const [formCatId, setFormCatId] = useState<number | ''>('');
  const [formBrandId, setFormBrandId] = useState<number | ''>('');
  const [formUnitId, setFormUnitId] = useState<number | ''>('');
  const [formBarcode, setFormBarcode] = useState('');
  const [formCost, setFormCost] = useState(0);
  const [formMin, setFormMin] = useState(0);
  const [formSafety, setFormSafety] = useState(0);
  const [formDepositId, setFormDepositId] = useState<number | ''>('');
  const [formSupId, setFormSupId] = useState<number | ''>('');
  const [formPackName, setFormPackName] = useState('');
  const [formFactor, setFormFactor] = useState(1);
  const [formUnitDetail, setFormUnitDetail] = useState(0);
  const [formUnitGros, setFormUnitGros] = useState(0);
  const [formPackDetail, setFormPackDetail] = useState(0);
  const [formPackGros, setFormPackGros] = useState(0);
  const [formInitStock, setFormInitStock] = useState(0);

  // Quick inline category/brand creation inside product modal
  const [inlineAddKind, setInlineAddKind] = useState<'category' | 'brand' | null>(null);
  const [inlineAddName, setInlineAddName] = useState('');
  const [inlineAddLoading, setInlineAddLoading] = useState(false);

  const loadData = async () => {
    const [prods, catMeta] = await Promise.all([
      apiFetch<Product[]>(`/api/products?archived=${showArchived ? '1' : '0'}`),
      apiFetch<CatalogMeta>('/api/catalog/meta'),
    ]);
    setProducts(prods);
    setMeta(catMeta);
    setHistoryProductId((prev) => {
      if (prev && prods.some((p) => p.id === prev)) return prev;
      return prods[0]?.id ?? null;
    });
  };

  const loadPriceHistory = async (productId: number) => {
    setLoadingHistory(true);
    setHistoryError(null);
    try {
      const res = await apiFetch<PriceHistoryResponse>(`/api/products/${productId}/price-history`);
      setPriceHistoryData(res);
    } catch (err) {
      setHistoryError((err as Error).message);
      setPriceHistoryData(null);
    } finally {
      setLoadingHistory(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [showArchived]);

  useEffect(() => {
    if (activeTab === 'price_history' && historyProductId) {
      void loadPriceHistory(historyProductId);
    }
  }, [activeTab, historyProductId]);

  const openProductHistory = (productId: number) => {
    setHistoryProductId(productId);
    setHistoryFilter('ALL');
    setActiveTab('price_history');
  };

  const openNewProduct = () => {
    setEditModal({});
    setFormSku('');
    setFormName('');
    setFormCatId(meta?.categories[0]?.id ?? '');
    setFormBrandId(meta?.brands[0]?.id ?? '');
    setFormUnitId(meta?.units[0]?.id ?? '');
    setFormBarcode('');
    setFormCost(0);
    setFormMin(0);
    setFormSafety(0);
    setFormDepositId('');
    setFormSupId(meta?.suppliers[0]?.id ?? '');
    setFormPackName('');
    setFormFactor(1);
    setFormUnitDetail(0);
    setFormUnitGros(0);
    setFormPackDetail(0);
    setFormPackGros(0);
    setFormInitStock(0);
    setInlineAddKind(null);
    setInlineAddName('');
    setError(null);
  };

  const openEditProduct = (p: Product) => {
    setEditModal(p);
    setFormSku(p.sku);
    setFormName(p.name);
    setFormCatId(p.category_id);
    setFormBrandId(p.brand_id);
    setFormUnitId(p.unit_id);
    setFormBarcode(p.barcode || '');
    setFormCost(p.purchase_cost_xof);
    setFormMin(p.min_threshold);
    setFormSafety(p.safety_stock);
    setFormDepositId(p.packaging_deposit_id || '');
    setFormSupId(p.default_supplier_id || '');

    const unitPack = p.packagings.find((pk) => pk.conversion_factor === 1);
    const cratePack = p.packagings.find((pk) => pk.conversion_factor > 1) || p.packagings[0];
    setFormPackName(cratePack?.name || '');
    setFormFactor(cratePack?.conversion_factor || 1);

    const getP = (packId: number | undefined, code: string) =>
      p.prices.find((pr) => pr.packaging_id === packId && pr.price_list_code === code)?.price_xof ?? 0;

    setFormUnitDetail(getP(unitPack?.id, 'DETAIL'));
    setFormUnitGros(getP(unitPack?.id, 'GROS'));
    setFormPackDetail(getP(cratePack?.id, 'DETAIL'));
    setFormPackGros(getP(cratePack?.id, 'GROS'));
    setInlineAddKind(null);
    setInlineAddName('');
    setError(null);
  };

  const handleCreateInlineRef = async () => {
    if (!inlineAddKind || !inlineAddName.trim()) return;
    setInlineAddLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ ok: boolean; id: number }>('/api/settings/reference', {
        method: 'POST',
        body: JSON.stringify({ kind: inlineAddKind, name: inlineAddName.trim() }),
      });
      const updatedMeta = await apiFetch<CatalogMeta>('/api/catalog/meta');
      setMeta(updatedMeta);
      if (inlineAddKind === 'category') setFormCatId(res.id);
      if (inlineAddKind === 'brand') setFormBrandId(res.id);
      setInlineAddName('');
      setInlineAddKind(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setInlineAddLoading(false);
    }
  };

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (!formCatId || !formBrandId || !formUnitId) {
        setError('Veuillez sélectionner ou créer une catégorie, une marque et une unité.');
        return;
      }
      const plDetail = meta?.priceLists.find((l) => l.code === 'DETAIL')?.id ?? meta?.priceLists[0]?.id ?? 1;
      const plGros = meta?.priceLists.find((l) => l.code === 'GROS')?.id ?? plDetail;
      const plRev = meta?.priceLists.find((l) => l.code === 'REVENDEUR')?.id ?? plGros;

      const selectedUnitLabel = meta?.units.find((u) => u.id === formUnitId)?.label || 'Unité';
      const packagings = [
        {
          name: selectedUnitLabel,
          conversion_factor: 1,
          is_default_sale: formFactor === 1 ? 1 : 0,
          apply_deposit: 0,
          prices: {
            [plDetail]: formUnitDetail,
            [plGros]: formUnitGros,
            [plRev]: formUnitGros,
          },
        },
      ];
      if (formFactor > 1) {
        packagings.push({
          name: formPackName.trim() || `Lot ×${formFactor}`,
          conversion_factor: formFactor,
          is_default_sale: 1,
          apply_deposit: formDepositId ? 1 : 0,
          prices: {
            [plDetail]: formPackDetail,
            [plGros]: formPackGros,
            [plRev]: formPackGros,
          },
        });
      }

      const payload = {
        sku: formSku,
        name: formName,
        category_id: Number(formCatId),
        brand_id: Number(formBrandId),
        unit_id: Number(formUnitId),
        barcode: formBarcode,
        purchase_cost_xof: formCost,
        min_threshold: formMin,
        safety_stock: formSafety,
        packaging_deposit_id: formDepositId || null,
        default_supplier_id: formSupId || null,
        initial_stock: formInitStock,
        packagings,
      };

      const savedId = editModal?.id;
      if (savedId) {
        await apiFetch(`/api/products/${savedId}`, { method: 'PUT', body: JSON.stringify(payload) });
        setMsg(`Produit ${formName} mis à jour.`);
      } else {
        await apiFetch('/api/products', { method: 'POST', body: JSON.stringify(payload) });
        setMsg(`Produit ${formName} créé.`);
      }
      setEditModal(null);
      await loadData();
      if (activeTab === 'price_history' && savedId && savedId === historyProductId) {
        await loadPriceHistory(savedId);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const toggleArchive = async (p: Product) => {
    await apiFetch(`/api/products/${p.id}/archive`, {
      method: 'PATCH',
      body: JSON.stringify({ active: p.active ? 0 : 1 }),
    });
    setMsg(p.active ? `${p.name} archivé.` : `${p.name} réactivé.`);
    await loadData();
  };

  const handleCsvSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      const parsed = lines.slice(1).map((line) => {
        const cols = line.split(/[;,]/).map((c) => c.trim());
        return {
          sku: cols[0] || '',
          name: cols[1] || '',
          category: cols[2] || meta?.categories[0]?.name || 'Général',
          brand: cols[3] || meta?.brands[0]?.name || 'Générique',
          purchase_cost_xof: Number(cols[4]) || 0,
          pack_name: cols[5] || '',
          factor: Number(cols[6]) || 1,
          price_detail_xof: Number(cols[7]) || 0,
          price_gros_xof: Number(cols[8]) || 0,
        };
      });
      setImportPreview(parsed.filter((r) => r.sku && r.name));
    };
    reader.readAsText(file);
  };

  const confirmImport = async () => {
    if (!importPreview) return;
    const res = await apiFetch<{ createdCount: number; skippedCount: number }>('/api/products/import', {
      method: 'POST',
      body: JSON.stringify({ rows: importPreview }),
    });
    setMsg(`Import terminé : ${res.createdCount} créé(s), ${res.skippedCount} doublon(s) ignoré(s).`);
    setImportPreview(null);
    await loadData();
  };

  const filtered = products.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.sku.toLowerCase().includes(search.toLowerCase()) ||
      p.category_name.toLowerCase().includes(search.toLowerCase()),
  );

  const filteredEvents = useMemo(() => {
    if (!priceHistoryData) return [];
    return priceHistoryData.events.filter((ev) => {
      if (historyFilter === 'ACHAT') return ev.kind.startsWith('ACHAT');
      if (historyFilter === 'VENTE') return ev.kind.startsWith('VENTE');
      return true;
    });
  }, [priceHistoryData, historyFilter]);

  const historySummary = useMemo(() => {
    if (!priceHistoryData) return null;
    const cost = priceHistoryData.product.purchase_cost_xof;
    const lastChart = priceHistoryData.chartPoints[priceHistoryData.chartPoints.length - 1];
    const unitDetail = lastChart?.sale_detail_xof ?? 0;
    const unitGros = lastChart?.sale_gros_xof ?? 0;
    const detailMarginPct = cost > 0 && unitDetail > 0 ? Math.round(((unitDetail - cost) / cost) * 100) : null;
    const grosMarginPct = cost > 0 && unitGros > 0 ? Math.round(((unitGros - cost) / cost) * 100) : null;
    const purchaseEventsCount = priceHistoryData.events.filter((e) => e.kind.startsWith('ACHAT')).length;
    const saleEventsCount = priceHistoryData.events.filter((e) => e.kind.startsWith('VENTE')).length;
    return {
      cost,
      unitDetail,
      unitGros,
      detailMarginPct,
      grosMarginPct,
      purchaseEventsCount,
      saleEventsCount,
    };
  }, [priceHistoryData]);

  return (
    <div className="space-y-4">
      {/* Sub-navigation Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          <button
            type="button"
            onClick={() => setActiveTab('catalogue')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'catalogue' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Catalogue & Tarifs
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('price_history')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer ${
              activeTab === 'price_history'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <TrendingUp className="w-3.5 h-3.5" />
            Historique des prix
          </button>
        </div>
      </div>

      {msg && <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800">{msg}</div>}

      {activeTab === 'catalogue' ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-1 min-w-[260px] max-w-md">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Rechercher par référence, nom ou catégorie..."
                  className="w-full pl-9 pr-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                />
              </div>
              <label className="flex items-center gap-1.5 text-xs text-slate-600 whitespace-nowrap cursor-pointer">
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(e) => setShowArchived(e.target.checked)}
                  className="accent-teal-700"
                />
                Archivés
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  exportToExcel(
                    [
                      {
                        name: 'Catalogue',
                        rows: filtered.map((p) => ({
                          Reference: p.sku,
                          Designation: p.name,
                          Categorie: p.category_name,
                          Marque: p.brand_name,
                          Cout_Achat_FCFA: p.purchase_cost_xof,
                          Stock_Disponible: p.available_qty,
                          Seuil_Min: p.min_threshold,
                        })),
                      },
                    ],
                    'GestDepot_Catalogue.xlsx',
                  )
                }
                className="px-3 py-2 text-xs font-medium bg-white border border-slate-200 hover:bg-slate-50 rounded-lg flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Excel
              </button>
              <button
                type="button"
                onClick={() =>
                  exportToPDF({
                    title: 'Catalogue Produits & Tarifs',
                    company,
                    columns: ['Référence', 'Désignation', 'Catégorie', 'Coût CUMP', 'Stock Dispo', 'Seuil'],
                    rows: filtered.map((p) => [
                      p.sku,
                      p.name,
                      p.category_name,
                      formatXOF(p.purchase_cost_xof),
                      p.available_qty,
                      p.min_threshold,
                    ]),
                    filename: 'GestDepot_Catalogue.pdf',
                  })
                }
                className="px-3 py-2 text-xs font-medium bg-white border border-slate-200 hover:bg-slate-50 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
              >
                PDF
              </button>
              {canEdit && (
                <>
                  <label className="px-3 py-2 text-xs font-medium bg-white border border-slate-200 hover:bg-slate-50 rounded-lg flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer">
                    <Upload className="w-3.5 h-3.5" />
                    Importer CSV
                    <input type="file" accept=".csv,.txt" onChange={handleCsvSelect} className="hidden" />
                  </label>
                  <button
                    type="button"
                    onClick={openNewProduct}
                    className="px-3.5 py-2 text-xs font-semibold bg-teal-700 hover:bg-teal-800 text-white rounded-lg flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Nouveau produit
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                  <tr>
                    <th className="text-left px-4 py-3 font-semibold">Référence</th>
                    <th className="text-left px-4 py-3 font-semibold">Produit</th>
                    <th className="text-left px-4 py-3 font-semibold">Conditionnements</th>
                    <th className="text-right px-4 py-3 font-semibold">Stock dispo</th>
                    <th className="text-right px-4 py-3 font-semibold">Coût (CUMP)</th>
                    <th className="text-right px-4 py-3 font-semibold">Prix Détail</th>
                    <th className="text-right px-4 py-3 font-semibold">Prix Gros</th>
                    <th className="text-right px-4 py-3 font-semibold">Seuil</th>
                    <th className="text-right px-4 py-3 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((p) => {
                    const cratePack = p.packagings.find((pk) => pk.conversion_factor > 1) || p.packagings[0];
                    const detailP =
                      p.prices.find((pr) => pr.packaging_id === cratePack?.id && pr.price_list_code === 'DETAIL')
                        ?.price_xof ?? 0;
                    const grosP =
                      p.prices.find((pr) => pr.packaging_id === cratePack?.id && pr.price_list_code === 'GROS')
                        ?.price_xof ?? 0;
                    return (
                      <tr key={p.id} className={`hover:bg-slate-50 ${p.active ? '' : 'opacity-50'}`}>
                        <td className="px-4 py-2.5 font-mono text-slate-700">{p.sku}</td>
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-slate-900">{p.name}</div>
                          <div className="text-[11px] text-slate-500">
                            {p.category_name} · {p.brand_name}
                            {p.deposit_code ? ` · Consigne ${p.deposit_code}` : ''}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">
                          {p.packagings.map((pk) => `${pk.name} (×${pk.conversion_factor})`).join(' · ')}
                        </td>
                        <td
                          className={`px-4 py-2.5 text-right font-mono tabular-nums font-semibold ${
                            p.available_qty <= 0
                              ? 'text-red-700'
                              : p.available_qty <= p.min_threshold
                                ? 'text-amber-700'
                                : 'text-slate-900'
                          }`}
                        >
                          {p.available_qty} {p.unit_code}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                          {formatXOF(p.purchase_cost_xof)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatXOF(detailP)}</td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums text-teal-800 font-medium">
                          {formatXOF(grosP)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-500">
                          {p.min_threshold}
                        </td>
                        <td className="px-4 py-2.5 text-right space-x-2.5 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => openProductHistory(p.id)}
                            className="text-slate-700 hover:text-teal-700 font-medium inline-flex items-center gap-1 cursor-pointer"
                            title="Voir l’historique des prix d’achat et de vente"
                          >
                            <History className="w-3.5 h-3.5" />
                            Historique
                          </button>
                          {canEdit && (
                            <>
                              <button
                                type="button"
                                onClick={() => openEditProduct(p)}
                                className="text-teal-700 hover:underline font-medium cursor-pointer"
                              >
                                Modifier
                              </button>
                              <button
                                type="button"
                                onClick={() => void toggleArchive(p)}
                                className="text-slate-500 hover:text-slate-800 cursor-pointer"
                                title={p.active ? 'Archiver' : 'Réactiver'}
                              >
                                <Archive className="w-3.5 h-3.5 inline" />
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-4 py-10 text-center text-slate-500">
                        {products.length === 0
                          ? 'Aucun produit enregistré dans votre catalogue. Cliquez sur « Nouveau produit » ou importez un fichier CSV.'
                          : 'Aucun produit ne correspond à votre recherche.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        /* Historique des prix Tab */
        <div className="space-y-4">
          {/* Product Selector & Export Toolbar */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3 flex-1 min-w-[260px]">
              <label htmlFor="history-product-select" className="text-xs font-semibold text-slate-700 whitespace-nowrap">
                Produit suivi :
              </label>
              <select
                id="history-product-select"
                value={historyProductId ?? ''}
                onChange={(e) => setHistoryProductId(e.target.value ? Number(e.target.value) : null)}
                className="flex-1 min-w-[240px] max-w-md px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg font-medium text-slate-900"
              >
                {products.length === 0 && <option value="">Aucun produit disponible</option>}
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.sku} — {p.name} ({p.category_name})
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {historyProductId && (
                <button
                  type="button"
                  onClick={() => void loadPriceHistory(historyProductId)}
                  className="px-3 py-2 text-xs font-medium bg-white border border-slate-200 hover:bg-slate-50 rounded-lg flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingHistory ? 'animate-spin' : ''}`} />
                  Actualiser
                </button>
              )}
              {priceHistoryData && (
                <button
                  type="button"
                  onClick={() =>
                    exportToExcel(
                      [
                        {
                          name: 'Historique_Prix',
                          rows: filteredEvents.map((ev) => ({
                            Date: formatDateTime(ev.created_at),
                            Produit: priceHistoryData.product.name,
                            Type: ev.kind_label,
                            Conditionnement: `${ev.packaging_name} (x${ev.conversion_factor})`,
                            Ancien_Prix_FCFA: ev.previous_xof ?? '',
                            Nouveau_Prix_FCFA: ev.new_xof,
                            Prix_Unitaire_Eq_FCFA: ev.unit_normalized_xof,
                            Details: ev.details,
                          })),
                        },
                      ],
                      `GestDepot_Historique_Prix_${priceHistoryData.product.sku}.xlsx`,
                    )
                  }
                  className="px-3 py-2 text-xs font-medium bg-white border border-slate-200 hover:bg-slate-50 rounded-lg flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  Exporter Excel
                </button>
              )}
            </div>
          </div>

          {historyError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{historyError}</div>
          )}

          {loadingHistory && !priceHistoryData ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-24 bg-white border border-slate-200 rounded-xl" />
                ))}
              </div>
              <div className="h-80 bg-white border border-slate-200 rounded-xl" />
            </div>
          ) : priceHistoryData && historySummary ? (
            <>
              {/* Summary KPIs */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <div className="text-xs text-slate-500">Coût achat / CUMP actuel</div>
                  <div className="mt-1.5 font-mono text-xl font-bold text-slate-900 tabular-nums">
                    {formatXOF(historySummary.cost)}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500">
                    Par {priceHistoryData.product.unit_label.toLowerCase()} ({priceHistoryData.product.unit_code})
                  </div>
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <div className="text-xs text-slate-500">Prix Détail actuel (unité)</div>
                  <div className="mt-1.5 font-mono text-xl font-bold text-teal-800 tabular-nums">
                    {formatXOF(historySummary.unitDetail)}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500 tabular-nums">
                    {historySummary.detailMarginPct !== null
                      ? `Marge +${historySummary.detailMarginPct}% vs CUMP`
                      : 'Tarif de vente au détail'}
                  </div>
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <div className="text-xs text-slate-500">Prix Gros actuel (unité)</div>
                  <div className="mt-1.5 font-mono text-xl font-bold text-amber-700 tabular-nums">
                    {formatXOF(historySummary.unitGros)}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500 tabular-nums">
                    {historySummary.grosMarginPct !== null
                      ? `Marge +${historySummary.grosMarginPct}% vs CUMP`
                      : 'Tarif de vente en gros'}
                  </div>
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <div className="text-xs text-slate-500">Variations & transactions</div>
                  <div className="mt-1.5 font-mono text-xl font-bold text-slate-900 tabular-nums">
                    {priceHistoryData.events.length}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500 tabular-nums">
                    {historySummary.purchaseEventsCount} achat(s) · {historySummary.saleEventsCount} vente(s)
                  </div>
                </div>
              </div>

              {/* Current Packaging Prices Strip */}
              <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="text-slate-600">
                  <span className="font-semibold text-slate-900">{priceHistoryData.product.name}</span>
                  <span className="mx-1.5 text-slate-400">·</span>
                  <span className="font-mono">{priceHistoryData.product.sku}</span>
                  <span className="mx-1.5 text-slate-400">·</span>
                  <span>
                    {priceHistoryData.product.category_name} / {priceHistoryData.product.brand_name}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-slate-600 font-mono tabular-nums">
                  {priceHistoryData.currentPrices
                    .filter((cp) => cp.price_list_code !== 'REVENDEUR')
                    .map((cp, idx) => (
                      <span key={`${cp.packaging_id}-${cp.price_list_code}-${idx}`}>
                        {cp.packaging_name} ({cp.price_list_label}) :{' '}
                        <strong className="text-slate-900">{formatXOF(cp.price_xof)}</strong>
                      </span>
                    ))}
                </div>
              </div>

              {/* Recharts Evolution Line Chart */}
              <div className="bg-white border border-slate-200 rounded-xl p-5">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                  <div>
                    <h2 className="font-display font-semibold text-sm text-slate-900">
                      Évolution des prix d’achat et de vente (équivalent par{' '}
                      {priceHistoryData.product.unit_label.toLowerCase()})
                    </h2>
                    <p className="text-xs text-slate-500">
                      Comparaison chronologique du coût d’achat (CUMP / réceptions) et des tarifs de vente Détail & Gros
                    </p>
                  </div>
                </div>

                {priceHistoryData.chartPoints.length === 0 ? (
                  <div className="h-72 flex items-center justify-center text-xs text-slate-500">
                    Aucune donnée tarifaire historique disponible pour ce produit.
                  </div>
                ) : (
                  <div className="h-72 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={priceHistoryData.chartPoints} margin={{ top: 10, right: 16, left: 4, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                        <XAxis
                          dataKey="label"
                          tick={{ fontSize: 11, fill: '#64748b' }}
                          axisLine={{ stroke: '#e2e8f0' }}
                          tickLine={false}
                        />
                        <YAxis
                          tickFormatter={formatCompactPriceAxis}
                          tick={{ fontSize: 11, fill: '#64748b' }}
                          axisLine={false}
                          tickLine={false}
                          width={52}
                        />
                        <Tooltip content={<PriceHistoryTooltip />} />
                        <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }} />
                        <Line
                          type="stepAfter"
                          dataKey="purchase_cost_xof"
                          name="Coût achat / CUMP"
                          stroke="#334155"
                          strokeWidth={2.2}
                          dot={{ r: 3.5, fill: '#334155' }}
                          activeDot={{ r: 5.5 }}
                        />
                        <Line
                          type="stepAfter"
                          dataKey="sale_detail_xof"
                          name="Prix Détail (unité)"
                          stroke="#0f766e"
                          strokeWidth={2.2}
                          dot={{ r: 3.5, fill: '#0f766e' }}
                          activeDot={{ r: 5.5 }}
                        />
                        <Line
                          type="stepAfter"
                          dataKey="sale_gros_xof"
                          name="Prix Gros (unité)"
                          stroke="#d97706"
                          strokeWidth={2.2}
                          dot={{ r: 3.5, fill: '#d97706' }}
                          activeDot={{ r: 5.5 }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>

              {/* Chronological Audit Table */}
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="font-display font-semibold text-sm text-slate-900">
                      Journal chronologique des mouvements de prix
                    </h3>
                    <p className="text-xs text-slate-500">
                      Révisions catalogue, réceptions fournisseurs (CUMP) et tarifs pratiqués en caisse
                    </p>
                  </div>
                  <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setHistoryFilter('ALL')}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        historyFilter === 'ALL' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Tous ({priceHistoryData.events.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setHistoryFilter('ACHAT')}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        historyFilter === 'ACHAT'
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Achats / Coûts ({historySummary.purchaseEventsCount})
                    </button>
                    <button
                      type="button"
                      onClick={() => setHistoryFilter('VENTE')}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        historyFilter === 'VENTE'
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Ventes / Tarifs ({historySummary.saleEventsCount})
                    </button>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                      <tr>
                        <th className="text-left px-4 py-2.5 font-semibold">Date & heure</th>
                        <th className="text-left px-4 py-2.5 font-semibold">Type d’opération</th>
                        <th className="text-left px-4 py-2.5 font-semibold">Conditionnement</th>
                        <th className="text-right px-4 py-2.5 font-semibold">Ancien prix</th>
                        <th className="text-right px-4 py-2.5 font-semibold">Nouveau prix</th>
                        <th className="text-right px-4 py-2.5 font-semibold">Variation</th>
                        <th className="text-right px-4 py-2.5 font-semibold">Éq. unitaire</th>
                        <th className="text-left px-4 py-2.5 font-semibold">Détails / Motif</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredEvents.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="px-4 py-8 text-center text-slate-500">
                            Aucun événement de prix enregistré pour ce filtre.
                          </td>
                        </tr>
                      ) : (
                        filteredEvents.map((ev) => {
                          const delta = ev.previous_xof !== null ? ev.new_xof - ev.previous_xof : null;
                          const isPurchase = ev.kind.startsWith('ACHAT');
                          return (
                            <tr key={ev.id} className="hover:bg-slate-50">
                              <td className="px-4 py-2.5 font-mono tabular-nums text-slate-600 whitespace-nowrap">
                                {formatDateTime(ev.created_at)}
                              </td>
                              <td
                                className={`px-4 py-2.5 font-medium whitespace-nowrap ${
                                  isPurchase ? 'text-slate-900' : 'text-teal-800'
                                }`}
                              >
                                {ev.kind_label}
                              </td>
                              <td className="px-4 py-2.5 text-slate-600 whitespace-nowrap">
                                {ev.packaging_name}
                                {ev.conversion_factor > 1 ? ` (×${ev.conversion_factor})` : ''}
                              </td>
                              <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-500">
                                {ev.previous_xof !== null ? formatXOF(ev.previous_xof) : '—'}
                              </td>
                              <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-slate-900">
                                {formatXOF(ev.new_xof)}
                              </td>
                              <td
                                className={`px-4 py-2.5 text-right font-mono tabular-nums font-medium whitespace-nowrap ${
                                  delta === null || delta === 0
                                    ? 'text-slate-400'
                                    : delta > 0
                                      ? isPurchase
                                        ? 'text-amber-700'
                                        : 'text-emerald-700'
                                      : isPurchase
                                        ? 'text-emerald-700'
                                        : 'text-red-700'
                                }`}
                              >
                                {delta === null ? '—' : delta > 0 ? `+${formatXOF(delta)}` : formatXOF(delta)}
                              </td>
                              <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-600">
                                {formatXOF(ev.unit_normalized_xof)}
                              </td>
                              <td className="px-4 py-2.5 text-slate-600">{ev.details}</td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : (
            <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-xs text-slate-500">
              Sélectionnez un produit dans le catalogue pour consulter son historique des prix.
            </div>
          )}
        </div>
      )}

      {/* Create / Edit Modal */}
      {editModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleSaveProduct}
            className="bg-white border border-slate-200 rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 space-y-4 shadow-lg"
          >
            <h3 className="font-display font-bold text-base text-slate-900">
              {editModal.id ? `Modifier : ${editModal.name}` : 'Nouvelle fiche produit'}
            </h3>
            {error && <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{error}</div>}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Référence interne (SKU)</label>
                <input
                  type="text"
                  required
                  disabled={Boolean(editModal.id)}
                  value={formSku}
                  onChange={(e) => setFormSku(e.target.value)}
                  placeholder="REF-001"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono disabled:bg-slate-100"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Désignation complète</label>
                <input
                  type="text"
                  required
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="Désignation du produit"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="font-medium text-slate-700">Catégorie</label>
                  <button
                    type="button"
                    onClick={() => {
                      setInlineAddKind(inlineAddKind === 'category' ? null : 'category');
                      setInlineAddName('');
                    }}
                    className="text-[11px] font-medium text-teal-700 hover:underline cursor-pointer"
                  >
                    + Ajouter
                  </button>
                </div>
                <select
                  required
                  value={formCatId}
                  onChange={(e) => setFormCatId(e.target.value ? Number(e.target.value) : '')}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                >
                  <option value="">Sélectionner une catégorie...</option>
                  {meta?.categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {inlineAddKind === 'category' && (
                  <div className="mt-1.5 flex gap-1.5">
                    <input
                      type="text"
                      value={inlineAddName}
                      onChange={(e) => setInlineAddName(e.target.value)}
                      placeholder="Nouvelle catégorie"
                      className="flex-1 px-2.5 py-1 border border-slate-300 rounded"
                    />
                    <button
                      type="button"
                      disabled={inlineAddLoading || !inlineAddName.trim()}
                      onClick={() => void handleCreateInlineRef()}
                      className="px-2.5 py-1 bg-teal-700 text-white rounded font-medium disabled:opacity-40 cursor-pointer"
                    >
                      OK
                    </button>
                  </div>
                )}
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="font-medium text-slate-700">Marque / Fabricant</label>
                  <button
                    type="button"
                    onClick={() => {
                      setInlineAddKind(inlineAddKind === 'brand' ? null : 'brand');
                      setInlineAddName('');
                    }}
                    className="text-[11px] font-medium text-teal-700 hover:underline cursor-pointer"
                  >
                    + Ajouter
                  </button>
                </div>
                <select
                  required
                  value={formBrandId}
                  onChange={(e) => setFormBrandId(e.target.value ? Number(e.target.value) : '')}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                >
                  <option value="">
                    {meta?.brands.length ? 'Sélectionner une marque...' : 'Aucune marque — cliquez sur + Ajouter'}
                  </option>
                  {meta?.brands.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                {inlineAddKind === 'brand' && (
                  <div className="mt-1.5 flex gap-1.5">
                    <input
                      type="text"
                      value={inlineAddName}
                      onChange={(e) => setInlineAddName(e.target.value)}
                      placeholder="Nom de la marque"
                      className="flex-1 px-2.5 py-1 border border-slate-300 rounded"
                    />
                    <button
                      type="button"
                      disabled={inlineAddLoading || !inlineAddName.trim()}
                      onClick={() => void handleCreateInlineRef()}
                      className="px-2.5 py-1 bg-teal-700 text-white rounded font-medium disabled:opacity-40 cursor-pointer"
                    >
                      OK
                    </button>
                  </div>
                )}
              </div>

              <div>
                <label className="block font-medium text-slate-700 mb-1">Unité de base</label>
                <select
                  required
                  value={formUnitId}
                  onChange={(e) => setFormUnitId(e.target.value ? Number(e.target.value) : '')}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                >
                  <option value="">Sélectionner une unité...</option>
                  {meta?.units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.label} ({u.code})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Code-barres (facultatif)</label>
                <input
                  type="text"
                  value={formBarcode}
                  onChange={(e) => setFormBarcode(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-700 mb-1">Coût unitaire base (FCFA)</label>
                <input
                  type="number"
                  min={0}
                  value={formCost}
                  onChange={(e) => setFormCost(Math.round(Number(e.target.value) || 0))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Consigne associée</label>
                <select
                  value={formDepositId}
                  onChange={(e) => setFormDepositId(e.target.value ? Number(e.target.value) : '')}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                >
                  <option value="">Aucune (emballage perdu)</option>
                  {meta?.returnablePackagings.map((rp) => (
                    <option key={rp.id} value={rp.id}>
                      {rp.label} ({formatXOF(rp.deposit_value_xof)})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-medium text-slate-700 mb-1">Seuil alerte minimum (unités base)</label>
                <input
                  type="number"
                  min={0}
                  value={formMin}
                  onChange={(e) => setFormMin(Math.round(Number(e.target.value) || 0))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Stock de sécurité (unités base)</label>
                <input
                  type="number"
                  min={0}
                  value={formSafety}
                  onChange={(e) => setFormSafety(Math.round(Number(e.target.value) || 0))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono"
                />
              </div>
            </div>

            {/* Packaging & Pricing */}
            <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-3 text-xs">
              <div className="font-semibold text-slate-800">Conditionnement principal & Tarifs (FCFA)</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <div>
                  <label className="block text-slate-600 mb-1">Nom conditionnement</label>
                  <input
                    type="text"
                    value={formPackName}
                    onChange={(e) => setFormPackName(e.target.value)}
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">Facteur conversion</label>
                  <input
                    type="number"
                    min={1}
                    value={formFactor}
                    onChange={(e) => setFormFactor(Math.max(1, Math.round(Number(e.target.value) || 1)))}
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">Prix Détail (Cond.)</label>
                  <input
                    type="number"
                    min={0}
                    value={formPackDetail}
                    onChange={(e) => setFormPackDetail(Math.round(Number(e.target.value) || 0))}
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">Prix Gros (Cond.)</label>
                  <input
                    type="number"
                    min={0}
                    value={formPackGros}
                    onChange={(e) => setFormPackGros(Math.round(Number(e.target.value) || 0))}
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">Prix Détail (Unité)</label>
                  <input
                    type="number"
                    min={0}
                    value={formUnitDetail}
                    onChange={(e) => setFormUnitDetail(Math.round(Number(e.target.value) || 0))}
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">Prix Gros (Unité)</label>
                  <input
                    type="number"
                    min={0}
                    value={formUnitGros}
                    onChange={(e) => setFormUnitGros(Math.round(Number(e.target.value) || 0))}
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white font-mono"
                  />
                </div>
                {!editModal.id && (
                  <div>
                    <label className="block text-slate-600 mb-1">Stock initial (base)</label>
                    <input
                      type="number"
                      min={0}
                      value={formInitStock}
                      onChange={(e) => setFormInitStock(Math.round(Number(e.target.value) || 0))}
                      className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white font-mono"
                    />
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditModal(null)}
                className="px-4 py-2 text-xs font-medium bg-slate-100 rounded-lg cursor-pointer"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold bg-teal-700 hover:bg-teal-800 text-white rounded-lg cursor-pointer"
              >
                Enregistrer la fiche
              </button>
            </div>
          </form>
        </div>
      )}

      {/* CSV Import Preview Modal */}
      {importPreview && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-2xl p-6 space-y-4 shadow-lg">
            <h3 className="font-display font-bold text-base text-slate-900">
              Prévisualisation de l’import CSV ({importPreview.length} ligne(s))
            </h3>
            <p className="text-xs text-slate-600">
              Les références existantes sont automatiquement ignorées sans écraser les données en place.
            </p>
            <div className="max-h-60 overflow-y-auto border border-slate-200 rounded-lg">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="text-left px-3 py-2">SKU</th>
                    <th className="text-left px-3 py-2">Nom</th>
                    <th className="text-right px-3 py-2">Coût</th>
                    <th className="text-right px-3 py-2">Facteur</th>
                    <th className="text-right px-3 py-2">Prix Gros</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {importPreview.map((r, i) => (
                    <tr key={i}>
                      <td className="px-3 py-1.5 font-mono">{r.sku}</td>
                      <td className="px-3 py-1.5">{r.name}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{r.purchase_cost_xof}</td>
                      <td className="px-3 py-1.5 text-right font-mono">×{r.factor}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{r.price_gros_xof}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setImportPreview(null)}
                className="px-4 py-2 text-xs bg-slate-100 rounded-lg cursor-pointer"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={() => void confirmImport()}
                className="px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-lg cursor-pointer"
              >
                Confirmer l’importation
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
