import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { CompanySettings } from '../types';

export function formatNumber(value: number | null | undefined): string {
  const num = Math.round(Number(value ?? 0));
  return new Intl.NumberFormat('fr-FR').format(num);
}

export function formatXOF(value: number | null | undefined): string {
  return `${formatNumber(value)} FCFA`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} Mo`;
}

export function exportToExcel(
  sheets: Array<{ name: string; rows: Array<Record<string, unknown>> }>,
  filename: string,
): void {
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const safeRows = sheet.rows.length > 0 ? sheet.rows : [{ Information: 'Aucune donnée pour cette période' }];
    const ws = XLSX.utils.json_to_sheet(safeRows);
    const cols = Object.keys(safeRows[0]).map((key) => ({
      wch: Math.max(key.length + 4, 16),
    }));
    ws['!cols'] = cols;
    XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
  }
  XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`);
}

export function exportToPDF(opts: {
  title: string;
  subtitle?: string;
  company?: CompanySettings | null;
  columns: string[];
  rows: Array<Array<string | number>>;
  totalsLine?: string;
  filename: string;
}): void {
  const doc = new jsPDF({ orientation: opts.columns.length > 6 ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();

  // Header band
  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, pageWidth, 24, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(14);
  doc.text(opts.company?.name || 'GestDepot', 14, 11);
  doc.setFontSize(9);
  doc.setTextColor(203, 213, 225);
  doc.text(
    [opts.company?.address, opts.company?.city, opts.company?.phone, opts.company?.registration_no]
      .filter(Boolean)
      .join(' · ') || `Devise ${opts.company?.currency || 'FCFA'}`,
    14,
    18,
  );

  doc.setTextColor(15, 23, 42);
  doc.setFontSize(13);
  doc.text(opts.title, 14, 34);
  if (opts.subtitle) {
    doc.setFontSize(9.5);
    doc.setTextColor(71, 85, 105);
    doc.text(opts.subtitle, 14, 40);
  }

  doc.setFontSize(8.5);
  doc.setTextColor(100, 116, 139);
  doc.text(`Généré le ${formatDateTime(new Date().toISOString())}`, pageWidth - 14, 34, { align: 'right' });

  autoTable(doc, {
    startY: opts.subtitle ? 45 : 40,
    head: [opts.columns],
    body: opts.rows,
    styles: { fontSize: 8.5, cellPadding: 2.5, textColor: [15, 23, 42] },
    headStyles: { fillColor: [15, 118, 110], textColor: [255, 255, 255], fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    didDrawPage: (data) => {
      const pageCount = doc.getNumberOfPages();
      doc.setFontSize(8);
      doc.setTextColor(100, 116, 139);
      doc.text(
        `GestDepot · Page ${data.pageNumber} / ${pageCount}`,
        pageWidth / 2,
        doc.internal.pageSize.getHeight() - 8,
        { align: 'center' },
      );
    },
  });

  if (opts.totalsLine) {
    const finalY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 60;
    doc.setFontSize(10);
    doc.setTextColor(15, 23, 42);
    doc.text(opts.totalsLine, 14, finalY + 10);
  }

  doc.save(opts.filename.endsWith('.pdf') ? opts.filename : `${opts.filename}.pdf`);
}
