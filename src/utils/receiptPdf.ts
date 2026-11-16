import jsPDF from 'jspdf';
import type { CompanySettings } from '../types';
import { exportToPDF, formatDateTime, formatNumber, formatXOF } from './format';

export type ReceiptPaperFormat = 'ticket80' | 'ticket58' | 'a4';

const RECEIPT_FORMAT_STORAGE_KEY = 'gestdepot_receipt_format';

export function getSavedReceiptFormat(): ReceiptPaperFormat {
  try {
    const val = localStorage.getItem(RECEIPT_FORMAT_STORAGE_KEY);
    if (val === 'ticket80' || val === 'ticket58' || val === 'a4') {
      return val;
    }
  } catch {
    // ignore storage access issues
  }
  return 'ticket80';
}

export function saveReceiptFormat(format: ReceiptPaperFormat): void {
  try {
    localStorage.setItem(RECEIPT_FORMAT_STORAGE_KEY, format);
  } catch {
    // ignore storage access issues
  }
}

export interface ReceiptPrintableSale {
  sale: {
    sale_number: string;
    customer_name: string;
    customer_phone?: string;
    customer_address?: string;
    subtotal_xof: number;
    discount_xof: number;
    tax_xof: number;
    deposit_xof: number;
    total_xof: number;
    paid_xof: number;
    credit_due_xof: number;
    payment_summary: string;
    cashier_name?: string;
    created_at: string;
  };
  lines: Array<{
    product_name: string;
    packaging_name: string;
    qty: number;
    unit_price_xof: number;
    discount_xof: number;
    line_total_xof: number;
  }>;
}

export function generateReceiptPdf(
  data: ReceiptPrintableSale,
  company: CompanySettings | null,
  format: ReceiptPaperFormat,
): void {
  const { sale, lines } = data;

  if (format === 'a4') {
    exportToPDF({
      title: `Facture / Reçu ${sale.sale_number}`,
      subtitle: `Client : ${sale.customer_name} · Date : ${formatDateTime(sale.created_at)} · Paiement : ${sale.payment_summary}`,
      company,
      columns: ['Désignation', 'Cond.', 'Qté', 'P.U. (FCFA)', 'Remise', 'Total (FCFA)'],
      rows: lines.map((l) => [
        l.product_name,
        l.packaging_name,
        l.qty,
        l.unit_price_xof,
        l.discount_xof,
        l.line_total_xof,
      ]),
      totalsLine: `Total : ${formatXOF(sale.total_xof)} | Payé : ${formatXOF(sale.paid_xof)} | Crédit : ${formatXOF(sale.credit_due_xof)}`,
      filename: `${sale.sale_number}_A4.pdf`,
    });
    return;
  }

  const pageWidth = format === 'ticket58' ? 58 : 80;
  const marginX = format === 'ticket58' ? 3 : 4;
  const contentWidth = pageWidth - marginX * 2;
  const baseFontSize = format === 'ticket58' ? 7.5 : 8.5;

  // Estimate dynamic roll height based on header + items + totals + footer
  const headerLines = 4 + (company?.address ? 1 : 0) + (company?.phone ? 1 : 0) + (company?.registration_no ? 1 : 0);
  const metaLines = 4 + (sale.cashier_name ? 1 : 0);
  const itemLinesHeight = lines.length * 10;
  const totalsLines = 5 + (sale.discount_xof > 0 ? 1 : 0) + (sale.deposit_xof > 0 ? 1 : 0) + (sale.tax_xof > 0 ? 1 : 0) + (sale.credit_due_xof > 0 ? 1 : 0);
  const footerHeight = company?.footer_note ? 16 : 8;
  const pageHeight = Math.max(125, 22 + headerLines * 4 + metaLines * 4 + itemLinesHeight + totalsLines * 4.5 + footerHeight);

  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: [pageWidth, pageHeight],
  });

  doc.setFont('courier', 'normal');
  let y = 7;

  const drawDashedLine = () => {
    doc.setDrawColor(148, 163, 184);
    doc.setLineDashPattern([1, 1], 0);
    doc.line(marginX, y, pageWidth - marginX, y);
    doc.setLineDashPattern([], 0);
    y += 3.5;
  };

  // Company header
  doc.setFont('courier', 'bold');
  doc.setFontSize(baseFontSize + 2);
  doc.text(company?.name || 'GestDepot', pageWidth / 2, y, { align: 'center', maxWidth: contentWidth });
  y += 4.2;

  doc.setFont('courier', 'normal');
  doc.setFontSize(baseFontSize - 1);
  if (company?.address) {
    const addrLines = doc.splitTextToSize(company.address, contentWidth);
    doc.text(addrLines, pageWidth / 2, y, { align: 'center' });
    y += addrLines.length * 3.4;
  }
  if (company?.phone) {
    doc.text(`Tél : ${company.phone}`, pageWidth / 2, y, { align: 'center' });
    y += 3.5;
  }
  if (company?.registration_no) {
    doc.text(company.registration_no, pageWidth / 2, y, { align: 'center', maxWidth: contentWidth });
    y += 3.5;
  }

  y += 1;
  drawDashedLine();

  // Ticket metadata
  doc.setFontSize(baseFontSize - 0.5);
  const metaRows: Array<[string, string]> = [
    ['N° Ticket :', sale.sale_number],
    ['Date :', formatDateTime(sale.created_at)],
    ['Client :', sale.customer_name],
  ];
  if (sale.cashier_name) {
    metaRows.push(['Caissier :', sale.cashier_name]);
  }
  for (const [k, v] of metaRows) {
    doc.setFont('courier', 'normal');
    doc.text(k, marginX, y);
    doc.setFont('courier', 'bold');
    doc.text(v, pageWidth - marginX, y, { align: 'right', maxWidth: contentWidth * 0.65 });
    y += 3.8;
  }

  y += 0.5;
  drawDashedLine();

  // Items header
  doc.setFont('courier', 'bold');
  doc.setFontSize(baseFontSize - 0.5);
  doc.text('ARTICLE', marginX, y);
  doc.text('TOTAL', pageWidth - marginX, y, { align: 'right' });
  y += 3.6;

  // Items lines
  for (const l of lines) {
    doc.setFont('courier', 'bold');
    doc.setFontSize(baseFontSize - 0.5);
    const titleLines = doc.splitTextToSize(l.product_name, contentWidth - 16);
    doc.text(titleLines, marginX, y);
    doc.text(`${formatNumber(l.line_total_xof)} F`, pageWidth - marginX, y, { align: 'right' });
    y += titleLines.length * 3.4;

    doc.setFont('courier', 'normal');
    doc.setFontSize(baseFontSize - 1.2);
    doc.text(
      `${l.qty} × ${l.packaging_name} @ ${formatNumber(l.unit_price_xof)} F`,
      marginX,
      y,
      { maxWidth: contentWidth },
    );
    y += 3.8;
  }

  drawDashedLine();

  // Totals
  doc.setFont('courier', 'normal');
  doc.setFontSize(baseFontSize - 0.5);
  const addSummaryRow = (label: string, val: string, bold = false) => {
    doc.setFont('courier', bold ? 'bold' : 'normal');
    doc.text(label, marginX, y);
    doc.text(val, pageWidth - marginX, y, { align: 'right' });
    y += bold ? 4.5 : 3.8;
  };

  addSummaryRow('Sous-total :', `${formatNumber(sale.subtotal_xof)} F`);
  if (sale.discount_xof > 0) {
    addSummaryRow('Remise :', `-${formatNumber(sale.discount_xof)} F`);
  }
  if (sale.deposit_xof > 0) {
    addSummaryRow('Consignes :', `${formatNumber(sale.deposit_xof)} F`);
  }
  if (sale.tax_xof > 0) {
    addSummaryRow('Taxes :', `${formatNumber(sale.tax_xof)} F`);
  }

  doc.setFontSize(baseFontSize + 1);
  addSummaryRow('TOTAL A PAYER :', formatXOF(sale.total_xof), true);

  doc.setFontSize(baseFontSize - 0.5);
  addSummaryRow(`Payé (${sale.payment_summary}) :`, `${formatNumber(sale.paid_xof)} F`);
  if (sale.credit_due_xof > 0) {
    addSummaryRow('Reste crédit :', `${formatNumber(sale.credit_due_xof)} F`, true);
  }

  if (company?.footer_note) {
    y += 2;
    drawDashedLine();
    doc.setFont('courier', 'normal');
    doc.setFontSize(baseFontSize - 1.2);
    const fLines = doc.splitTextToSize(company.footer_note, contentWidth);
    doc.text(fLines, pageWidth / 2, y, { align: 'center' });
  }

  const suffix = format === 'ticket58' ? '58mm' : '80mm';
  doc.save(`${sale.sale_number}_${suffix}.pdf`);
}
