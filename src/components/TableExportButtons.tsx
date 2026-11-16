import React from 'react';
import { FileSpreadsheet, FileText } from 'lucide-react';
import type { TableExportFormat } from '../utils/exportTable';

interface TableExportButtonsProps {
  onExport: (format: TableExportFormat) => void;
  disabled?: boolean;
  compact?: boolean;
}

export const TableExportButtons: React.FC<TableExportButtonsProps> = ({
  onExport,
  disabled = false,
  compact = false,
}) => {
  const baseClass = compact
    ? 'px-2.5 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed'
    : 'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed';

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onExport('csv')}
        title="Exporter le tableau au format CSV (séparateur point-virgule pour comptabilité)"
        className={`${baseClass} bg-white border border-slate-200 hover:bg-slate-50 text-slate-700`}
      >
        <FileText className="w-3.5 h-3.5 text-slate-500 shrink-0" />
        <span>Export CSV</span>
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onExport('xlsx')}
        title="Exporter le tableau au format Excel (.xlsx)"
        className={`${baseClass} bg-white border border-slate-200 hover:bg-slate-50 text-teal-800`}
      >
        <FileSpreadsheet className="w-3.5 h-3.5 text-teal-700 shrink-0" />
        <span>Export Excel</span>
      </button>
    </div>
  );
};
