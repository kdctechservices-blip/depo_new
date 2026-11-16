import React, { useEffect, useState } from 'react';
import { Download, FileText, Printer, Receipt, X } from 'lucide-react';
import type { CompanySettings } from '../types';
import { formatDateTime, formatXOF } from '../utils/format';
import {
  generateReceiptPdf,
  getSavedReceiptFormat,
  saveReceiptFormat,
  type ReceiptPaperFormat,
  type ReceiptPrintableSale,
} from '../utils/receiptPdf';

export type PrintableSaleData = ReceiptPrintableSale;

interface ReceiptModalProps {
  data: PrintableSaleData;
  company: CompanySettings | null;
  initialFormat?: ReceiptPaperFormat;
  autoPrint?: boolean;
  onFormatChange?: (format: ReceiptPaperFormat) => void;
  onClose: () => void;
}

export const ReceiptModal: React.FC<ReceiptModalProps> = ({
  data,
  company,
  initialFormat,
  autoPrint = false,
  onFormatChange,
  onClose,
}) => {
  const [formatMode, setFormatMode] = useState<ReceiptPaperFormat>(
    () => initialFormat ?? getSavedReceiptFormat(),
  );
  const { sale, lines } = data;

  const selectFormat = (next: ReceiptPaperFormat) => {
    setFormatMode(next);
    saveReceiptFormat(next);
    onFormatChange?.(next);
  };

  useEffect(() => {
    if (!autoPrint) return;
    const timer = window.setTimeout(() => {
      window.print();
    }, 180);
    return () => window.clearTimeout(timer);
  }, [autoPrint]);

  const pageCssRule =
    formatMode === 'ticket58'
      ? '@page { size: 58mm auto; margin: 2mm; }'
      : formatMode === 'ticket80'
        ? '@page { size: 80mm auto; margin: 2mm; }'
        : '@page { size: A4 portrait; margin: 10mm; }';

  const paperClass =
    formatMode === 'ticket58'
      ? 'receipt-paper receipt-paper-58 w-[240px] p-4 font-mono text-[11px]'
      : formatMode === 'ticket80'
        ? 'receipt-paper receipt-paper-80 w-[320px] p-5 font-mono text-xs'
        : 'receipt-paper receipt-paper-a4 w-full max-w-xl p-8 text-sm';

  return (
    <div className="receipt-modal-root fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
      <style media="print">{pageCssRule}</style>
      <div className="receipt-modal-frame bg-white border border-slate-200 rounded-xl w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden shadow-lg">
        <div className="no-print px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => selectFormat('ticket80')}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer ${
                formatMode === 'ticket80' ? 'bg-teal-700 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              <Receipt className="w-3.5 h-3.5" />
              Thermique 80 mm
            </button>
            <button
              type="button"
              onClick={() => selectFormat('ticket58')}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer ${
                formatMode === 'ticket58' ? 'bg-teal-700 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              <Receipt className="w-3.5 h-3.5" />
              Thermique 58 mm
            </button>
            <button
              type="button"
              onClick={() => selectFormat('a4')}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer ${
                formatMode === 'a4' ? 'bg-teal-700 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              Facture A4
            </button>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => generateReceiptPdf(data, company, formatMode)}
              className="px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              {formatMode === 'a4'
                ? 'PDF A4'
                : formatMode === 'ticket58'
                  ? 'PDF 58 mm'
                  : 'PDF 80 mm'}
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              className="px-3 py-1.5 text-xs font-medium bg-teal-700 hover:bg-teal-800 text-white rounded-lg flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Printer className="w-3.5 h-3.5" />
              Imprimer
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Fermer l’aperçu du ticket"
              className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="receipt-scroll-area flex-1 overflow-y-auto p-6 bg-slate-100 flex justify-center">
          <div className={`bg-white border border-slate-200 text-slate-900 ${paperClass}`}>
            <div className="text-center border-b border-dashed border-slate-300 pb-3 mb-3">
              <div className="font-display font-bold text-base">{company?.name || 'GestDepot'}</div>
              {company?.address && <div className="text-[11px] text-slate-600">{company.address}</div>}
              {company?.phone && <div className="text-[11px] text-slate-600">Tél : {company.phone}</div>}
              {company?.registration_no && <div className="text-[10px] text-slate-500">{company.registration_no}</div>}
            </div>

            <div className="space-y-0.5 text-[11px] mb-3 border-b border-dashed border-slate-300 pb-2">
              <div className="flex justify-between gap-2">
                <span>N° Document :</span>
                <span className="font-semibold">{sale.sale_number}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span>Date :</span>
                <span>{formatDateTime(sale.created_at)}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span>Client :</span>
                <span className="font-semibold text-right">{sale.customer_name}</span>
              </div>
              {sale.cashier_name && (
                <div className="flex justify-between gap-2">
                  <span>Caissier :</span>
                  <span>{sale.cashier_name}</span>
                </div>
              )}
            </div>

            <table className="w-full text-[11px] mb-3">
              <thead>
                <tr className="border-b border-slate-300 text-left">
                  <th className="py-1">Article</th>
                  <th className="py-1 text-right">Qté</th>
                  <th className="py-1 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, idx) => (
                  <tr key={idx} className="border-b border-slate-100">
                    <td className="py-1 pr-2">
                      <div className="font-medium">{l.product_name}</div>
                      <div className="text-[10px] text-slate-500">
                        {l.packaging_name} × {formatXOF(l.unit_price_xof)}
                      </div>
                    </td>
                    <td className="py-1 text-right tabular-nums align-top">{l.qty}</td>
                    <td className="py-1 text-right tabular-nums align-top font-medium">
                      {formatXOF(l.line_total_xof)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="space-y-1 text-xs border-t border-dashed border-slate-300 pt-2">
              <div className="flex justify-between gap-2">
                <span>Sous-total marchandises</span>
                <span className="tabular-nums shrink-0">{formatXOF(sale.subtotal_xof)}</span>
              </div>
              {sale.discount_xof > 0 && (
                <div className="flex justify-between gap-2 text-amber-700">
                  <span>Remise</span>
                  <span className="tabular-nums shrink-0">-{formatXOF(sale.discount_xof)}</span>
                </div>
              )}
              {sale.deposit_xof > 0 && (
                <div className="flex justify-between gap-2">
                  <span>Consignes emballages</span>
                  <span className="tabular-nums shrink-0">{formatXOF(sale.deposit_xof)}</span>
                </div>
              )}
              {sale.tax_xof > 0 && (
                <div className="flex justify-between gap-2">
                  <span>Taxes</span>
                  <span className="tabular-nums shrink-0">{formatXOF(sale.tax_xof)}</span>
                </div>
              )}
              <div className="flex justify-between gap-2 font-bold text-sm pt-1 border-t border-slate-300">
                <span>TOTAL À PAYER</span>
                <span className="tabular-nums shrink-0">{formatXOF(sale.total_xof)}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="truncate">Payé ({sale.payment_summary})</span>
                <span className="tabular-nums font-semibold shrink-0">{formatXOF(sale.paid_xof)}</span>
              </div>
              {sale.credit_due_xof > 0 && (
                <div className="flex justify-between gap-2 text-red-700 font-semibold">
                  <span>Reste à crédit</span>
                  <span className="tabular-nums shrink-0">{formatXOF(sale.credit_due_xof)}</span>
                </div>
              )}
            </div>

            {company?.footer_note && (
              <p className="text-[10px] text-center text-slate-500 mt-4 pt-3 border-t border-dashed border-slate-300">
                {company.footer_note}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
