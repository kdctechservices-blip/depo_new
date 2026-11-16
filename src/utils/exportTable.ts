import * as XLSX from 'xlsx';

export interface ExportColumn<T> {
  header: string;
  accessor: (row: T) => string | number | boolean | null | undefined;
}

export type TableExportFormat = 'csv' | 'xlsx';

function normalizeCellValue(val: string | number | boolean | null | undefined): string | number {
  if (val === null || val === undefined) return '';
  if (typeof val === 'boolean') return val ? 'Oui' : 'Non';
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  return String(val);
}

function escapeCsvCell(value: string | number, delimiter: string): string {
  const str = String(value);
  if (
    str.includes(delimiter) ||
    str.includes('"') ||
    str.includes('\n') ||
    str.includes('\r')
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Exporte un tableau de données métier (Stocks, Ventes, Clients, etc.)
 * au format CSV (UTF-8 avec BOM, séparateur ";" par défaut pour Excel FR)
 * ou Excel (.xlsx) avec largeur de colonnes auto-ajustée.
 */
export function exportTableData<T>(options: {
  rows: T[];
  columns: ExportColumn<T>[];
  filename: string;
  sheetName?: string;
  format: TableExportFormat;
  delimiter?: ';' | ',';
}): void {
  const { rows, columns, filename, sheetName = 'Données', format, delimiter = ';' } = options;

  const baseName = filename.replace(/\.(csv|xlsx)$/i, '');

  if (format === 'csv') {
    const headerLine = columns.map((c) => escapeCsvCell(c.header, delimiter)).join(delimiter);
    const dataLines = rows.map((row) =>
      columns.map((c) => escapeCsvCell(normalizeCellValue(c.accessor(row)), delimiter)).join(delimiter),
    );
    // BOM UTF-8 (\uFEFF) pour une ouverture sans erreur d'accents dans Excel Windows/macOS
    const csvContent = '\uFEFF' + [headerLine, ...dataLines].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    triggerBlobDownload(blob, `${baseName}.csv`);
    return;
  }

  const sheetObjects: Array<Record<string, string | number>> =
    rows.length > 0
      ? rows.map((row) => {
          const obj: Record<string, string | number> = {};
          for (const col of columns) {
            obj[col.header] = normalizeCellValue(col.accessor(row));
          }
          return obj;
        })
      : [
          columns.reduce<Record<string, string | number>>((acc, col, idx) => {
            acc[col.header] = idx === 0 ? 'Aucune donnée disponible' : '';
            return acc;
          }, {}),
        ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(sheetObjects);
  ws['!cols'] = columns.map((col) => {
    let maxLen = col.header.length;
    for (const r of sheetObjects) {
      const cellLen = String(r[col.header] ?? '').length;
      if (cellLen > maxLen) maxLen = cellLen;
    }
    return { wch: Math.min(Math.max(maxLen + 3, 12), 48) };
  });
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  XLSX.writeFile(wb, `${baseName}.xlsx`);
}

export function accountingDateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}
