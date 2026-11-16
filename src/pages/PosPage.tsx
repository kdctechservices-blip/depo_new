import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Download,
  PauseCircle,
  PlayCircle,
  Printer,
  Receipt,
  RotateCcw,
  Search,
  ShoppingCart,
  Trash2,
  UserPlus,
  XCircle,
} from 'lucide-react';
import { apiFetch } from '../utils/api';
import { formatDateTime, formatXOF } from '../utils/format';
import { accountingDateStamp, exportTableData, type TableExportFormat } from '../utils/exportTable';
import {
  generateReceiptPdf,
  getSavedReceiptFormat,
  saveReceiptFormat,
  type ReceiptPaperFormat,
} from '../utils/receiptPdf';
import { TableExportButtons } from '../components/TableExportButtons';
import type { CatalogMeta, CompanySettings, Customer, Product, SaleSummary, SessionUser } from '../types';
import { ReceiptModal, type PrintableSaleData } from '../components/ReceiptModal';
import { SupervisorModal } from '../components/SupervisorModal';

interface CartLine {
  key: string;
  product: Product;
  packagingId: number;
  packagingName: string;
  factor: number;
  applyDeposit: boolean;
  qty: number;
  unitPriceXof: number;
  discountXof: number;
  priceModified: boolean;
}

interface SuspendedCart {
  id: string;
  label: string;
  customerId: number;
  lines: CartLine[];
  savedAt: string;
}

interface PosPageProps {
  user: SessionUser;
  company: CompanySettings | null;
}

export const PosPage: React.FC<PosPageProps> = ({ user, company }) => {
  const [tab, setTab] = useState<'caisse' | 'historique'>('caisse');
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [meta, setMeta] = useState<CatalogMeta | null>(null);
  const [salesHistory, setSalesHistory] = useState<SaleSummary[]>([]);

  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | ''>('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [globalDiscount, setGlobalDiscount] = useState<number>(0);
  const [includeDeposit, setIncludeDeposit] = useState<boolean>(true);
  const [suspendedCarts, setSuspendedCarts] = useState<SuspendedCart[]>([]);

  // Payment modal
  const [showPayModal, setShowPayModal] = useState(false);
  const [payments, setPayments] = useState<Array<{ method: string; amount_xof: number }>>([
    { method: 'ESPECES', amount_xof: 0 },
  ]);
  const [dueDate, setDueDate] = useState(() => new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
  const [saleNotes, setSaleNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Supervisor override for credit limit or cancellation
  const [supervisorPrompt, setSupervisorPrompt] = useState<{
    mode: 'credit' | 'cancel';
    title: string;
    description: string;
    saleId?: number;
    reason?: string;
  } | null>(null);

  // Cancel sale reason modal (replaces window.prompt)
  const [cancelSaleModal, setCancelSaleModal] = useState<{ sale: SaleSummary; reason: string } | null>(null);

  // Printable Receipt
  const [printableSale, setPrintableSale] = useState<PrintableSaleData | null>(null);
  const [receiptFormat, setReceiptFormat] = useState<ReceiptPaperFormat>(() => getSavedReceiptFormat());
  const [autoPrintReceipt, setAutoPrintReceipt] = useState(false);

  // Return Modal
  const [returnModalSale, setReturnModalSale] = useState<{
    sale: SaleSummary;
    lines: Array<{
      id: number;
      product_name: string;
      packaging_name: string;
      base_qty: number;
      returned_base_qty: number;
      line_total_xof: number;
      qtyToReturn: number;
    }>;
  } | null>(null);
  const [returnRestocked, setReturnRestocked] = useState(true);
  const [returnMethod, setReturnMethod] = useState('ESPECES');
  const [returnReason, setReturnReason] = useState('');

  const searchInputRef = useRef<HTMLInputElement>(null);
  const customerSelectRef = useRef<HTMLSelectElement>(null);

  const loadPosData = async () => {
    const [prods, custs, catMeta, sales] = await Promise.all([
      apiFetch<Product[]>('/api/products'),
      apiFetch<Customer[]>('/api/customers'),
      apiFetch<CatalogMeta>('/api/catalog/meta'),
      apiFetch<SaleSummary[]>('/api/sales?limit=80'),
    ]);
    setProducts(prods);
    setCustomers(custs);
    setMeta(catMeta);
    setSalesHistory(sales);
    setSelectedCustomerId((prev) => (prev && custs.some((c) => c.id === prev) ? prev : (custs[0]?.id ?? '')));
    if (catMeta.paymentMethods.length > 0 && !catMeta.paymentMethods.some((pm) => pm.code === returnMethod)) {
      setReturnMethod(catMeta.paymentMethods[0].code);
    }
  };

  useEffect(() => {
    void loadPosData();
  }, []);

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === selectedCustomerId) || customers[0],
    [customers, selectedCustomerId],
  );

  // Keyboard shortcuts (F2, F4, F6, F8, F9, Escape)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (tab !== 'caisse') return;
      if (e.key === 'F2') {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === 'F4') {
        e.preventDefault();
        customerSelectRef.current?.focus();
      } else if (e.key === 'F6') {
        e.preventDefault();
        if (cart.length > 0) openPaymentModal();
      } else if (e.key === 'F8') {
        e.preventDefault();
        if (cart.length > 0) suspendCurrentCart();
      } else if (e.key === 'F9') {
        e.preventDefault();
        if (showPayModal && !submitting) void submitSale();
        else if (cart.length > 0) openPaymentModal();
      } else if (e.key === 'Escape') {
        setShowPayModal(false);
        setReturnModalSale(null);
        setPrintableSale(null);
        setAutoPrintReceipt(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [tab, cart, showPayModal, submitting]);

  const getPriceForPack = (prod: Product, packagingId: number, priceListId: number): number => {
    const exact = prod.prices.find((p) => p.packaging_id === packagingId && p.price_list_id === priceListId);
    if (exact) return exact.price_xof;
    const fallback = prod.prices.find((p) => p.packaging_id === packagingId);
    return fallback?.price_xof ?? 0;
  };

  // Update cart prices when customer tarif changes
  const handleCustomerChange = (newCustId: number) => {
    setSelectedCustomerId(newCustId);
    const cust = customers.find((c) => c.id === newCustId);
    if (!cust) return;
    setCart((prev) =>
      prev.map((line) => {
        if (line.priceModified) return line;
        return {
          ...line,
          unitPriceXof: getPriceForPack(line.product, line.packagingId, cust.price_list_id),
        };
      }),
    );
  };

  const addToCart = (prod: Product, specificPackId?: number) => {
    setError(null);
    setSuccessMsg(null);
    if (prod.available_qty <= 0) {
      setError(`Stock disponible insuffisant pour ${prod.name} (disponible : ${prod.available_qty}).`);
      return;
    }
    const defaultPack =
      (specificPackId && prod.packagings.find((p) => p.id === specificPackId)) ||
      prod.packagings.find((p) => p.is_default_sale === 1) ||
      prod.packagings[0];
    if (!defaultPack) return;

    const priceListId = selectedCustomer?.price_list_id ?? 1;
    const unitPrice = getPriceForPack(prod, defaultPack.id, priceListId);
    const lineKey = `${prod.id}_${defaultPack.id}`;

    setCart((prev) => {
      const idx = prev.findIndex((l) => l.key === lineKey);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = { ...copy[idx], qty: copy[idx].qty + 1 };
        return copy;
      }
      return [
        ...prev,
        {
          key: lineKey,
          product: prod,
          packagingId: defaultPack.id,
          packagingName: defaultPack.name,
          factor: defaultPack.conversion_factor,
          applyDeposit: defaultPack.apply_deposit === 1,
          qty: 1,
          unitPriceXof: unitPrice,
          discountXof: 0,
          priceModified: false,
        },
      ];
    });
  };

  const handleBarcodeOrSearchEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && search.trim()) {
      const q = search.trim().toLowerCase();
      const exact = products.find(
        (p) => p.barcode?.toLowerCase() === q || p.sku.toLowerCase() === q,
      );
      if (exact) {
        addToCart(exact);
        setSearch('');
      } else if (filteredProducts.length === 1) {
        addToCart(filteredProducts[0]);
        setSearch('');
      }
    }
  };

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (selectedCategory !== 'ALL' && p.category_name !== selectedCategory) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.barcode && p.barcode.toLowerCase().includes(q))
      );
    });
  }, [products, search, selectedCategory]);

  const totals = useMemo(() => {
    let subtotal = 0;
    let deposit = 0;
    for (const l of cart) {
      subtotal += Math.max(0, l.qty * l.unitPriceXof - l.discountXof);
      if (includeDeposit && l.applyDeposit && l.product.deposit_value_xof) {
        deposit += l.qty * l.product.deposit_value_xof;
      }
    }
    const netCommercial = Math.max(0, subtotal - globalDiscount);
    const tax = company?.tax_enabled ? Math.round((netCommercial * company.tax_rate) / 100) : 0;
    const total = netCommercial + tax + deposit;
    return { subtotal, deposit, tax, total };
  }, [cart, globalDiscount, includeDeposit, company]);

  const openPaymentModal = () => {
    setError(null);
    const defaultMethod = meta?.paymentMethods[0]?.code ?? 'ESPECES';
    setPayments([{ method: defaultMethod, amount_xof: totals.total }]);
    setShowPayModal(true);
  };

  const suspendCurrentCart = () => {
    if (cart.length === 0) return;
    setSuspendedCarts((prev) => [
      ...prev,
      {
        id: String(Date.now()),
        label: `${selectedCustomer?.name || 'Comptoir'} (${cart.length} lig.)`,
        customerId: Number(selectedCustomerId || customers[0]?.id || 0),
        lines: cart,
        savedAt: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
      },
    ]);
    setCart([]);
    setGlobalDiscount(0);
    setSuccessMsg('Vente mise en attente.');
  };

  const resumeSuspended = (sc: SuspendedCart) => {
    setCart(sc.lines);
    setSelectedCustomerId(sc.customerId);
    setSuspendedCarts((prev) => prev.filter((x) => x.id !== sc.id));
  };

  const paidSum = payments.reduce((a, b) => a + (Number(b.amount_xof) || 0), 0);
  const creditRest = Math.max(0, totals.total - paidSum);

  const submitSale = async (supervisorOverride?: { username: string; secret: string }) => {
    setSubmitting(true);
    setError(null);
    try {
      const custId = Number(selectedCustomerId || customers[0]?.id || 0);
      if (!custId) throw new Error('Sélectionnez un client valide.');
      const payload = {
        customer_id: custId,
        price_list_id: selectedCustomer?.price_list_id ?? meta?.priceLists[0]?.id ?? 1,
        global_discount_xof: globalDiscount,
        include_deposit: includeDeposit,
        payments: payments.filter((p) => p.amount_xof > 0),
        due_date: creditRest > 0 ? dueDate : undefined,
        notes: saleNotes,
        supervisor_override: supervisorOverride,
        lines: cart.map((l) => ({
          product_id: l.product.id,
          packaging_id: l.packagingId,
          qty: l.qty,
          unit_price_xof: l.unitPriceXof,
          discount_xof: l.discountXof,
          price_modified: l.priceModified,
        })),
      };

      const res = await apiFetch<{ saleId: number; saleNumber: string }>('/api/sales', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      const fullSale = await apiFetch<PrintableSaleData>(`/api/sales/${res.saleId}`);
      setAutoPrintReceipt(false);
      setPrintableSale(fullSale);
      setCart([]);
      setGlobalDiscount(0);
      setSaleNotes('');
      setShowPayModal(false);
      setSupervisorPrompt(null);
      setSuccessMsg(`Vente ${res.saleNumber} validée avec succès.`);
      await loadPosData();
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.startsWith('PLAFOND_CREDIT_DEPASSE:')) {
        setSupervisorPrompt({
          mode: 'credit',
          title: 'Dépassement de plafond de crédit',
          description: msg.replace('PLAFOND_CREDIT_DEPASSE:', '').trim(),
        });
      } else {
        setError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleReceiptFormatChange = (next: ReceiptPaperFormat) => {
    setReceiptFormat(next);
    saveReceiptFormat(next);
  };

  const openReceiptForSale = async (saleId: number, autoPrint = false) => {
    try {
      const fullSale = await apiFetch<PrintableSaleData>(`/api/sales/${saleId}`);
      setAutoPrintReceipt(autoPrint);
      setPrintableSale(fullSale);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const downloadReceiptPdfForSale = async (saleId: number) => {
    try {
      const fullSale = await apiFetch<PrintableSaleData>(`/api/sales/${saleId}`);
      generateReceiptPdf(fullSale, company, receiptFormat);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const openReturnForSale = async (sale: SaleSummary) => {
    const full = await apiFetch<{
      sale: SaleSummary;
      lines: Array<{
        id: number;
        product_name: string;
        packaging_name: string;
        base_qty: number;
        returned_base_qty: number;
        line_total_xof: number;
      }>;
    }>(`/api/sales/${sale.id}`);
    setReturnModalSale({
      sale,
      lines: full.lines.map((l) => ({ ...l, qtyToReturn: 0 })),
    });
    setReturnReason('');
    setReturnRestocked(true);
  };

  const submitReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!returnModalSale) return;
    const items = returnModalSale.lines
      .filter((l) => l.qtyToReturn > 0)
      .map((l) => ({ sale_line_id: l.id, return_base_qty: l.qtyToReturn }));
    try {
      await apiFetch(`/api/sales/${returnModalSale.sale.id}/return`, {
        method: 'POST',
        body: JSON.stringify({
          items,
          refund_method: returnMethod,
          restocked: returnRestocked,
          reason: returnReason,
        }),
      });
      setReturnModalSale(null);
      setSuccessMsg('Retour enregistré et stock/caisse régularisés.');
      await loadPosData();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const cancelSaleRequest = (sale: SaleSummary) => {
    setCancelSaleModal({ sale, reason: '' });
  };

  const confirmCancelSale = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cancelSaleModal || !cancelSaleModal.reason.trim()) return;
    const { sale, reason } = cancelSaleModal;
    setCancelSaleModal(null);
    if (user.role === 'CAISSIER') {
      setSupervisorPrompt({
        mode: 'cancel',
        title: 'Autorisation d’annulation requise',
        description: `Annulation de la vente ${sale.sale_number} (${formatXOF(sale.total_xof)})`,
        saleId: sale.id,
        reason: reason.trim(),
      });
      return;
    }
    try {
      await apiFetch(`/api/sales/${sale.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      setSuccessMsg(`Vente ${sale.sale_number} annulée par contrepassation.`);
      await loadPosData();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleExportSales = (format: TableExportFormat) => {
    exportTableData({
      format,
      filename: `GestDepot_Ventes_${accountingDateStamp()}`,
      sheetName: 'Journal des ventes',
      rows: salesHistory,
      columns: [
        { header: 'N° Vente', accessor: (s) => s.sale_number },
        { header: 'Date et heure', accessor: (s) => formatDateTime(s.created_at) },
        { header: 'Client', accessor: (s) => s.customer_name },
        { header: 'Caissier', accessor: (s) => s.cashier_name || '' },
        { header: 'Mode paiement', accessor: (s) => s.payment_summary },
        { header: 'Sous-total HT/Brut (FCFA)', accessor: (s) => s.subtotal_xof },
        { header: 'Remise (FCFA)', accessor: (s) => s.discount_xof },
        { header: 'Consigne (FCFA)', accessor: (s) => s.deposit_xof },
        { header: 'Total TTC (FCFA)', accessor: (s) => s.total_xof },
        { header: 'Montant payé (FCFA)', accessor: (s) => s.paid_xof },
        { header: 'Crédit dû (FCFA)', accessor: (s) => s.credit_due_xof },
        { header: 'Statut', accessor: (s) => s.status },
      ],
    });
  };

  return (
    <>
      <div className={printableSale ? 'no-print space-y-4' : 'space-y-4'}>
        {/* Sub-navigation, thermal paper option & keyboard hints */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
            <button
              type="button"
              onClick={() => setTab('caisse')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md cursor-pointer whitespace-nowrap shrink-0 ${
                tab === 'caisse' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              Comptoir & Saisie rapide
            </button>
            <button
              type="button"
              onClick={() => setTab('historique')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md cursor-pointer whitespace-nowrap shrink-0 ${
                tab === 'historique' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              Historique des ventes ({salesHistory.length})
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 bg-white border border-slate-200 rounded-lg px-2.5 py-1">
              <span className="text-[11px] font-medium text-slate-500 whitespace-nowrap">Papier ticket :</span>
              <select
                aria-label="Format papier ticket"
                value={receiptFormat}
                onChange={(e) => handleReceiptFormatChange(e.target.value as ReceiptPaperFormat)}
                className="text-xs font-medium text-slate-800 bg-transparent focus:outline-none cursor-pointer"
              >
                <option value="ticket80">Thermique 80 mm</option>
                <option value="ticket58">Thermique 58 mm</option>
                <option value="a4">Facture A4</option>
              </select>
            </div>

            <button
              type="button"
              disabled={salesHistory.length === 0}
              onClick={() => salesHistory[0] && void openReceiptForSale(salesHistory[0].id)}
              className="px-3 py-1.5 text-xs font-medium bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-40 text-slate-700 rounded-lg flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Receipt className="w-3.5 h-3.5 text-teal-700" />
              Dernier ticket
            </button>

            <div className="hidden 2xl:flex items-center gap-2.5 text-[11px] text-slate-500 pl-2">
              <span>F2 Rechercher</span>
              <span>·</span>
              <span>F4 Client</span>
              <span>·</span>
              <span>F6 / F9 Paiement</span>
              <span>·</span>
              <span>F8 Suspendre</span>
            </div>
          </div>
        </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 font-medium">{error}</div>
      )}
      {successMsg && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800 font-medium">
          {successMsg}
        </div>
      )}

      {tab === 'caisse' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* Left: Product Picker */}
          <div className="lg:col-span-7 space-y-3">
            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={handleBarcodeOrSearchEnter}
                  placeholder="Scanner code-barres ou rechercher boisson / référence (F2)..."
                  className="w-full pl-9 pr-4 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
                />
              </div>

              <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                <button
                  type="button"
                  onClick={() => setSelectedCategory('ALL')}
                  className={`px-2.5 py-1 text-xs rounded-md whitespace-nowrap shrink-0 cursor-pointer ${
                    selectedCategory === 'ALL'
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  Toutes catégories
                </button>
                {meta?.categories.map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setSelectedCategory(cat.name)}
                    className={`px-2.5 py-1 text-xs rounded-md whitespace-nowrap shrink-0 cursor-pointer ${
                      selectedCategory === cat.name
                        ? 'bg-slate-900 text-white'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                    }`}
                  >
                    {cat.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-h-[620px] overflow-y-auto pr-1">
              {filteredProducts.map((prod) => {
                const defPack = prod.packagings.find((pk) => pk.is_default_sale === 1) || prod.packagings[0];
                const price = defPack
                  ? getPriceForPack(prod, defPack.id, selectedCustomer?.price_list_id ?? 1)
                  : 0;
                const outOfStock = prod.available_qty <= 0;
                return (
                  <div
                    key={prod.id}
                    className={`bg-white border rounded-xl p-3 flex flex-col justify-between transition-colors ${
                      outOfStock ? 'border-red-200 opacity-70' : 'border-slate-200 hover:border-teal-700/60'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between gap-1 text-[11px] text-slate-500">
                        <span className="font-mono truncate">{prod.sku}</span>
                        <span
                          className={`font-mono tabular-nums font-semibold ${
                            outOfStock
                              ? 'text-red-700'
                              : prod.available_qty <= prod.min_threshold
                                ? 'text-amber-700'
                                : 'text-emerald-700'
                          }`}
                        >
                          Dispo : {prod.available_qty}
                        </span>
                      </div>
                      <h3 className="font-medium text-xs text-slate-900 mt-1 line-clamp-2 min-h-[32px]">
                        {prod.name}
                      </h3>
                    </div>

                    <div className="mt-2 pt-2 border-t border-slate-100 space-y-1.5">
                      <div className="flex items-baseline justify-between">
                        <span className="text-[11px] text-slate-500">{defPack?.name}</span>
                        <span className="font-mono text-xs font-bold text-slate-900 tabular-nums">
                          {formatXOF(price)}
                        </span>
                      </div>
                      <div className="flex gap-1">
                        {prod.packagings.map((pk) => (
                          <button
                            key={pk.id}
                            type="button"
                            disabled={outOfStock}
                            onClick={() => addToCart(prod, pk.id)}
                            className={`flex-1 py-1.5 px-2 text-[11px] font-medium rounded-md transition-colors cursor-pointer disabled:opacity-40 ${
                              pk.is_default_sale === 1
                                ? 'bg-teal-700 hover:bg-teal-800 text-white'
                                : 'bg-slate-100 hover:bg-slate-200 text-slate-800'
                            }`}
                          >
                            + {pk.conversion_factor > 1 ? `×${pk.conversion_factor}` : 'Unité'}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
              {filteredProducts.length === 0 && (
                <div className="col-span-full bg-white border border-slate-200 rounded-xl p-8 text-center text-xs text-slate-500">
                  {products.length === 0
                    ? 'Aucun produit disponible dans votre catalogue. Ajoutez d’abord vos articles dans « Catalogue & Tarifs ».'
                    : 'Aucun article ne correspond à votre recherche.'}
                </div>
              )}
            </div>
          </div>

          {/* Right: Cart & Settlement */}
          <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-4 space-y-4">
            {/* Customer + Tarif */}
            <div className="space-y-2 pb-3 border-b border-slate-100">
              <div className="flex items-center justify-between text-xs">
                <label className="font-medium text-slate-700">Client & Tarif appliqué (F4)</label>
                {selectedCustomer && (
                  <span className="text-[11px] text-slate-500">
                    {selectedCustomer.price_list_label}
                    {selectedCustomer.balance_due_xof > 0 &&
                      ` · Dû ${formatXOF(selectedCustomer.balance_due_xof)}`}
                  </span>
                )}
              </div>
              <select
                ref={customerSelectRef}
                value={selectedCustomerId}
                onChange={(e) => handleCustomerChange(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:border-teal-700"
              >
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.price_list_code})
                    {c.credit_limit_xof > 0 ? ` — Plafond ${formatXOF(c.credit_limit_xof)}` : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* Suspended carts */}
            {suspendedCarts.length > 0 && (
              <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg space-y-1.5">
                <div className="text-[11px] font-semibold text-amber-800">Ventes en attente</div>
                <div className="flex flex-wrap gap-1.5">
                  {suspendedCarts.map((sc) => (
                    <button
                      key={sc.id}
                      type="button"
                      onClick={() => resumeSuspended(sc)}
                      className="px-2 py-1 text-[11px] bg-white border border-amber-300 rounded flex items-center gap-1 hover:bg-amber-100 cursor-pointer"
                    >
                      <PlayCircle className="w-3 h-3 text-amber-700" />
                      {sc.label} ({sc.savedAt})
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Cart Lines */}
            <div className="max-h-[290px] overflow-y-auto divide-y divide-slate-100">
              {cart.length === 0 ? (
                <div className="py-10 text-center text-xs text-slate-400">
                  <ShoppingCart className="w-7 h-7 mx-auto mb-2 text-slate-300" />
                  Cliquez sur une boisson à gauche ou scannez un code-barres.
                </div>
              ) : (
                cart.map((line, index) => (
                  <div key={line.key} className="py-2.5 space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-slate-900 truncate">{line.product.name}</div>
                        <div className="text-[11px] text-slate-500">
                          {line.packagingName} ({line.qty * line.factor} unités de base)
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setCart((prev) => prev.filter((_, i) => i !== index))}
                        className="text-slate-400 hover:text-red-600 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() =>
                            setCart((prev) =>
                              prev.map((l, i) => (i === index ? { ...l, qty: Math.max(1, l.qty - 1) } : l)),
                            )
                          }
                          className="w-7 h-7 bg-slate-100 hover:bg-slate-200 rounded text-sm font-bold cursor-pointer"
                        >
                          -
                        </button>
                        <input
                          type="number"
                          min={1}
                          value={line.qty}
                          onChange={(e) => {
                            const v = Math.max(1, Math.round(Number(e.target.value) || 1));
                            setCart((prev) => prev.map((l, i) => (i === index ? { ...l, qty: v } : l)));
                          }}
                          className="w-12 text-center py-1 text-xs font-mono border border-slate-300 rounded"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setCart((prev) => prev.map((l, i) => (i === index ? { ...l, qty: l.qty + 1 } : l)))
                          }
                          className="w-7 h-7 bg-slate-100 hover:bg-slate-200 rounded text-sm font-bold cursor-pointer"
                        >
                          +
                        </button>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          min={0}
                          value={line.unitPriceXof}
                          title="Prix unitaire FCFA"
                          onChange={(e) => {
                            const v = Math.max(0, Math.round(Number(e.target.value) || 0));
                            setCart((prev) =>
                              prev.map((l, i) => (i === index ? { ...l, unitPriceXof: v, priceModified: true } : l)),
                            );
                          }}
                          className="w-20 text-right py-1 px-1.5 text-xs font-mono border border-slate-300 rounded"
                        />
                        <span className="font-mono text-xs font-bold text-slate-900 tabular-nums w-24 text-right">
                          {formatXOF(Math.max(0, line.qty * line.unitPriceXof - line.discountXof))}
                        </span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Totals & Options */}
            <div className="pt-3 border-t border-slate-200 space-y-2 text-xs">
              <label className="flex items-center justify-between text-slate-700 cursor-pointer">
                <span>Appliquer consigne emballages</span>
                <input
                  type="checkbox"
                  checked={includeDeposit}
                  onChange={(e) => setIncludeDeposit(e.target.checked)}
                  className="accent-teal-700"
                />
              </label>

              <div className="flex items-center justify-between">
                <span className="text-slate-600">Remise globale (FCFA)</span>
                <input
                  type="number"
                  min={0}
                  value={globalDiscount}
                  onChange={(e) => setGlobalDiscount(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                  className="w-28 text-right px-2 py-1 font-mono border border-slate-300 rounded"
                />
              </div>

              <div className="flex justify-between text-slate-600">
                <span>Sous-total boissons</span>
                <span className="font-mono tabular-nums">{formatXOF(totals.subtotal)}</span>
              </div>
              {totals.deposit > 0 && (
                <div className="flex justify-between text-amber-800">
                  <span>Consignes casiers</span>
                  <span className="font-mono tabular-nums">{formatXOF(totals.deposit)}</span>
                </div>
              )}
              <div className="flex justify-between text-base font-bold text-slate-900 pt-2 border-t border-slate-200">
                <span>Total à payer</span>
                <span className="font-mono tabular-nums text-teal-800">{formatXOF(totals.total)}</span>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                disabled={cart.length === 0}
                onClick={suspendCurrentCart}
                className="px-3 py-2.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 disabled:opacity-40 text-slate-700 rounded-lg flex items-center gap-1.5 cursor-pointer"
              >
                <PauseCircle className="w-4 h-4" />
                Attente (F8)
              </button>
              <button
                type="button"
                disabled={cart.length === 0}
                onClick={openPaymentModal}
                className="flex-1 py-2.5 px-4 text-sm font-semibold bg-teal-700 hover:bg-teal-800 disabled:opacity-40 text-white rounded-lg cursor-pointer"
              >
                Encaisser / Valider (F6)
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* Sales History Tab */
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-slate-600">
              <span className="font-semibold text-slate-900">{salesHistory.length} vente(s)</span> affichée(s) · Export comptable
            </div>
            <TableExportButtons onExport={handleExportSales} disabled={salesHistory.length === 0} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <tr>
                  <th className="text-left px-4 py-3 font-semibold">N° Vente</th>
                  <th className="text-left px-4 py-3 font-semibold">Date & Heure</th>
                  <th className="text-left px-4 py-3 font-semibold">Client</th>
                  <th className="text-left px-4 py-3 font-semibold">Paiement</th>
                  <th className="text-right px-4 py-3 font-semibold">Total</th>
                  <th className="text-right px-4 py-3 font-semibold">Payé</th>
                  <th className="text-right px-4 py-3 font-semibold">Crédit</th>
                  <th className="text-left px-4 py-3 font-semibold">Statut</th>
                  <th className="text-right px-4 py-3 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {salesHistory.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-mono font-semibold text-slate-900">{s.sale_number}</td>
                    <td className="px-4 py-2.5 text-slate-600 tabular-nums">{formatDateTime(s.created_at)}</td>
                    <td className="px-4 py-2.5 font-medium text-slate-900">{s.customer_name}</td>
                    <td className="px-4 py-2.5 text-slate-600">{s.payment_summary}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold">
                      {formatXOF(s.total_xof)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-emerald-700">
                      {formatXOF(s.paid_xof)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-amber-700">
                      {s.credit_due_xof > 0 ? formatXOF(s.credit_due_xof) : '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`font-medium ${
                          s.status === 'VALIDEE'
                            ? 'text-emerald-700'
                            : s.status === 'ANNULEE'
                              ? 'text-red-700'
                              : 'text-amber-700'
                        }`}
                      >
                        {s.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2.5">
                        <button
                          type="button"
                          onClick={() => void openReceiptForSale(s.id)}
                          className="text-teal-700 hover:underline font-medium cursor-pointer"
                        >
                          Ticket
                        </button>
                        <button
                          type="button"
                          onClick={() => void openReceiptForSale(s.id, true)}
                          title={`Imprimer (${receiptFormat === 'a4' ? 'A4' : receiptFormat === 'ticket58' ? '58 mm' : '80 mm'})`}
                          className="text-slate-700 hover:underline font-medium inline-flex items-center gap-1 cursor-pointer"
                        >
                          <Printer className="w-3 h-3" />
                          Imprimer
                        </button>
                        <button
                          type="button"
                          onClick={() => void downloadReceiptPdfForSale(s.id)}
                          title={`Télécharger PDF (${receiptFormat === 'a4' ? 'A4' : receiptFormat === 'ticket58' ? '58 mm' : '80 mm'})`}
                          className="text-slate-700 hover:underline font-medium inline-flex items-center gap-1 cursor-pointer"
                        >
                          <Download className="w-3 h-3" />
                          PDF
                        </button>
                        {s.status !== 'ANNULEE' && (
                          <>
                            <button
                              type="button"
                              onClick={() => void openReturnForSale(s)}
                              className="text-amber-700 hover:underline font-medium cursor-pointer"
                            >
                              Retour
                            </button>
                            <button
                              type="button"
                              onClick={() => void cancelSaleRequest(s)}
                              className="text-red-700 hover:underline font-medium cursor-pointer"
                            >
                              Annuler
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Payment Modal (supports mixed payments & credit) */}
      {showPayModal && (
        <div className="fixed inset-0 z-40 bg-slate-950/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg p-6 space-y-4 shadow-lg">
            <div className="flex items-center justify-between">
              <h3 className="font-display font-bold text-base text-slate-900">Règlement & Validation</h3>
              <span className="font-mono text-lg font-bold text-teal-800 tabular-nums">
                {formatXOF(totals.total)}
              </span>
            </div>

            {error && <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{error}</div>}

            <div className="space-y-2.5">
              <div className="flex items-center justify-between text-xs font-medium text-slate-700">
                <span>Moyens de paiement (paiement mixte autorisé)</span>
                <button
                  type="button"
                  onClick={() => {
                    const nextMethod =
                      meta?.paymentMethods.find((m) => m.code !== payments[0]?.method)?.code ??
                      meta?.paymentMethods[0]?.code ??
                      'ESPECES';
                    setPayments((p) => [...p, { method: nextMethod, amount_xof: creditRest }]);
                  }}
                  className="text-teal-700 hover:underline flex items-center gap-1 cursor-pointer"
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  Ajouter un moyen
                </button>
              </div>

              {payments.map((pay, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <select
                    value={pay.method}
                    onChange={(e) =>
                      setPayments((prev) => prev.map((x, i) => (i === idx ? { ...x, method: e.target.value } : x)))
                    }
                    className="flex-1 px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                  >
                    {(meta?.paymentMethods ?? [{ code: 'ESPECES', label: 'Espèces' }]).map((pm) => (
                      <option key={pm.code} value={pm.code}>
                        {pm.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={0}
                    value={pay.amount_xof}
                    onChange={(e) => {
                      const val = Math.max(0, Math.round(Number(e.target.value) || 0));
                      setPayments((prev) => prev.map((x, i) => (i === idx ? { ...x, amount_xof: val } : x)));
                    }}
                    className="w-36 text-right px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                  {payments.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setPayments((prev) => prev.filter((_, i) => i !== idx))}
                      className="text-slate-400 hover:text-red-600 cursor-pointer"
                    >
                      <XCircle className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-1.5 text-xs">
              <div className="flex justify-between">
                <span>Total encaissé immédiatement</span>
                <span className="font-mono font-bold text-emerald-700 tabular-nums">{formatXOF(paidSum)}</span>
              </div>
              <div className="flex justify-between">
                <span>Reste mis à crédit client</span>
                <span
                  className={`font-mono font-bold tabular-nums ${
                    creditRest > 0 ? 'text-amber-700' : 'text-slate-600'
                  }`}
                >
                  {formatXOF(creditRest)}
                </span>
              </div>
              {creditRest > 0 && (
                <div className="pt-2 flex items-center justify-between">
                  <span className="text-slate-700">Date d’échéance du crédit</span>
                  <input
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="px-2.5 py-1 border border-slate-300 rounded bg-white text-xs"
                  />
                </div>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Note / Référence Mobile Money</label>
              <input
                type="text"
                value={saleNotes}
                onChange={(e) => setSaleNotes(e.target.value)}
                placeholder="Référence de transaction ou observation..."
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowPayModal(false)}
                className="px-4 py-2 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg cursor-pointer"
              >
                Annuler (Échap)
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void submitSale()}
                className="px-4 py-2 text-xs font-semibold bg-teal-700 hover:bg-teal-800 text-white rounded-lg flex items-center gap-1.5 cursor-pointer"
              >
                <Printer className="w-3.5 h-3.5" />
                {submitting ? 'Validation...' : 'Confirmer la vente (F9)'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Return Modal */}
      {returnModalSale && (
        <div className="fixed inset-0 z-40 bg-slate-950/50 flex items-center justify-center p-4">
          <form
            onSubmit={submitReturn}
            className="bg-white border border-slate-200 rounded-xl w-full max-w-lg p-6 space-y-4 shadow-lg"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display font-bold text-base text-slate-900 flex items-center gap-2">
                <RotateCcw className="w-4 h-4 text-amber-700" />
                Retour client sur {returnModalSale.sale.sale_number}
              </h3>
            </div>

            <div className="divide-y divide-slate-100 max-h-60 overflow-y-auto">
              {returnModalSale.lines.map((l, idx) => {
                const maxRet = l.base_qty - l.returned_base_qty;
                return (
                  <div key={l.id} className="py-2 flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900 truncate">{l.product_name}</div>
                      <div className="text-[11px] text-slate-500">
                        Vendu : {l.base_qty} u. · Retournable : {maxRet} u.
                      </div>
                    </div>
                    <input
                      type="number"
                      min={0}
                      max={maxRet}
                      value={l.qtyToReturn}
                      onChange={(e) => {
                        const v = Math.min(maxRet, Math.max(0, Math.round(Number(e.target.value) || 0)));
                        setReturnModalSale((prev) =>
                          prev
                            ? {
                                ...prev,
                                lines: prev.lines.map((x, i) => (i === idx ? { ...x, qtyToReturn: v } : x)),
                              }
                            : null,
                        );
                      }}
                      className="w-20 text-right px-2 py-1 font-mono border border-slate-300 rounded"
                    />
                  </div>
                );
              })}
            </div>

            <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={returnRestocked}
                onChange={(e) => setReturnRestocked(e.target.checked)}
                className="accent-teal-700"
              />
              Marchandise en bon état (réintégrer dans le stock revendable)
            </label>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Mode de remboursement</label>
                <select
                  value={returnMethod}
                  onChange={(e) => setReturnMethod(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  {(meta?.paymentMethods ?? [{ code: 'ESPECES', label: 'Espèces' }]).map((pm) => (
                    <option key={pm.code} value={pm.code}>
                      {pm.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Motif du retour</label>
                <input
                  type="text"
                  required
                  value={returnReason}
                  onChange={(e) => setReturnReason(e.target.value)}
                  placeholder="ex. Erreur commande, casse"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setReturnModalSale(null)}
                className="px-4 py-2 text-xs font-medium bg-slate-100 rounded-lg cursor-pointer"
              >
                Fermer
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold bg-amber-700 hover:bg-amber-800 text-white rounded-lg cursor-pointer"
              >
                Valider le retour
              </button>
            </div>
          </form>
        </div>
      )}

      {cancelSaleModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <form
            onSubmit={confirmCancelSale}
            className="bg-white border border-slate-200 rounded-xl w-full max-w-sm p-5 space-y-3 shadow-lg text-xs"
          >
            <h3 className="font-display font-bold text-sm text-slate-900">
              Annuler la vente {cancelSaleModal.sale.sale_number}
            </h3>
            <p className="text-slate-600">
              Montant : <span className="font-mono font-semibold">{formatXOF(cancelSaleModal.sale.total_xof)}</span>.
              Une écriture de contrepassation sera enregistrée.
            </p>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Motif d’annulation</label>
              <input
                type="text"
                required
                autoFocus
                value={cancelSaleModal.reason}
                onChange={(e) => setCancelSaleModal({ ...cancelSaleModal, reason: e.target.value })}
                placeholder="Saisissez le motif"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setCancelSaleModal(null)}
                className="px-3 py-1.5 bg-slate-100 rounded-lg cursor-pointer"
              >
                Fermer
              </button>
              <button
                type="submit"
                className="px-3 py-1.5 font-semibold bg-red-700 text-white rounded-lg cursor-pointer"
              >
                Confirmer l’annulation
              </button>
            </div>
          </form>
        </div>
      )}

      {supervisorPrompt && (
        <SupervisorModal
          title={supervisorPrompt.title}
          description={supervisorPrompt.description}
          onCancel={() => setSupervisorPrompt(null)}
          onConfirm={async (supUser, supSecret) => {
            if (supervisorPrompt.mode === 'credit') {
              await submitSale({ username: supUser, secret: supSecret });
            } else if (supervisorPrompt.mode === 'cancel' && supervisorPrompt.saleId) {
              await apiFetch(`/api/sales/${supervisorPrompt.saleId}/cancel`, {
                method: 'POST',
                body: JSON.stringify({
                  reason: supervisorPrompt.reason,
                  supervisor_username: supUser,
                  supervisor_secret: supSecret,
                }),
              });
              setSupervisorPrompt(null);
              setSuccessMsg('Vente annulée avec validation du responsable.');
              await loadPosData();
            }
          }}
        />
      )}

      </div>

      {printableSale && (
        <ReceiptModal
          data={printableSale}
          company={company}
          initialFormat={receiptFormat}
          autoPrint={autoPrintReceipt}
          onFormatChange={handleReceiptFormatChange}
          onClose={() => {
            setPrintableSale(null);
            setAutoPrintReceipt(false);
          }}
        />
      )}
    </>
  );
};
