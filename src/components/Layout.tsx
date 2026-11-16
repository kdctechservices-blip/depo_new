import React from 'react';
import {
  Archive,
  BarChart3,
  Boxes,
  Calculator,
  ClipboardCheck,
  DatabaseBackup,
  FileSpreadsheet,
  LayoutDashboard,
  Lock,
  LogOut,
  Package,
  ShoppingBag,
  ShoppingCart,
  Truck,
  Users,
  Wallet,
  Building2,
  Settings,
} from 'lucide-react';
import type { CompanySettings, NavKey, SessionUser } from '../types';
import { formatDate } from '../utils/format';
import { PWAInstallButton } from './PWAInstallButton';

interface NavItem {
  key: NavKey;
  label: string;
  permission: string;
  group: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', label: 'Tableau de bord', permission: 'dashboard', group: 'Exploitation', icon: LayoutDashboard },
  { key: 'pos', label: 'Ventes / Caisse', permission: 'pos', group: 'Exploitation', icon: ShoppingCart },
  { key: 'orders', label: 'Commandes clients', permission: 'orders', group: 'Exploitation', icon: ShoppingBag },
  { key: 'deliveries', label: 'Livraisons', permission: 'deliveries', group: 'Exploitation', icon: Truck },

  { key: 'catalog', label: 'Produits & catalogue', permission: 'catalog', group: 'Stocks & Emballages', icon: Package },
  { key: 'stock', label: 'Stocks & mouvements', permission: 'stock', group: 'Stocks & Emballages', icon: Boxes },
  { key: 'deposits', label: 'Consignes & casiers', permission: 'deposits', group: 'Stocks & Emballages', icon: Archive },
  { key: 'inventories', label: 'Inventaires', permission: 'inventories', group: 'Stocks & Emballages', icon: ClipboardCheck },

  { key: 'customers', label: 'Clients & crédits', permission: 'customers', group: 'Tiers & Achats', icon: Users },
  { key: 'suppliers', label: 'Fournisseurs', permission: 'suppliers', group: 'Tiers & Achats', icon: Building2 },
  { key: 'purchases', label: 'Achats & réappro', permission: 'purchases', group: 'Tiers & Achats', icon: Calculator },

  { key: 'cash_expenses', label: 'Caisse & dépenses', permission: 'cash_expenses', group: 'Finances & Système', icon: Wallet },
  { key: 'margins', label: 'Marges & rentabilité', permission: 'margins', group: 'Finances & Système', icon: BarChart3 },
  { key: 'reports', label: 'Rapports & exports', permission: 'reports', group: 'Finances & Système', icon: FileSpreadsheet },
  { key: 'settings_users', label: 'Paramètres avancés', permission: 'settings_users', group: 'Finances & Système', icon: Settings },
  { key: 'backups', label: 'Sauvegarde & restauration', permission: 'backups', group: 'Finances & Système', icon: DatabaseBackup },
];

interface LayoutProps {
  user: SessionUser;
  company: CompanySettings | null;
  activeNav: NavKey;
  onSelectNav: (nav: NavKey) => void;
  onLogout: () => void;
  lastBackupAt?: string | null;
  children: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({
  user,
  company,
  activeNav,
  onSelectNav,
  onLogout,
  lastBackupAt,
  children,
}) => {
  const allowedItems = NAV_ITEMS.filter((item) => user.permissions.includes(item.permission));
  const groups = Array.from(new Set(allowedItems.map((i) => i.group)));
  const currentItem = NAV_ITEMS.find((i) => i.key === activeNav);

  return (
    <div className="min-h-screen flex bg-slate-50 text-slate-900">
      {/* Permanent Sidebar */}
      <aside className="no-print w-64 shrink-0 bg-slate-900 text-slate-200 flex flex-col border-r border-slate-800 select-none">
        <div className="px-4 py-4 border-b border-slate-800 flex items-center gap-3">
          <img
            src="/src/assets/images/gestdepot_logo_1794830301767.jpg"
            alt="Logo GestDepot"
            referrerPolicy="no-referrer"
            className="w-9 h-9 rounded-lg object-cover bg-white shrink-0"
          />
          <div className="min-w-0">
            <div className="font-display font-bold text-white text-base tracking-tight truncate">GestDepot</div>
            <div className="text-[11px] text-slate-400 truncate">{company?.name || 'Dépôt de boissons'}</div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto py-3 px-2.5 space-y-4">
          {groups.map((grp) => (
            <div key={grp}>
              <div className="px-2.5 mb-1.5 text-[11px] font-semibold text-slate-400 tracking-wide">{grp}</div>
              <div className="space-y-0.5">
                {allowedItems
                  .filter((i) => i.group === grp)
                  .map((item) => {
                    const Icon = item.icon;
                    const active = item.key === activeNav;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => onSelectNav(item.key)}
                        className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] font-medium transition-colors text-left cursor-pointer ${
                          active
                            ? 'bg-teal-700 text-white'
                            : 'text-slate-300 hover:bg-slate-800/80 hover:text-white'
                        }`}
                      >
                        <Icon className="w-4 h-4 shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </button>
                    );
                  })}
              </div>
            </div>
          ))}
        </nav>

        <div className="p-3 border-t border-slate-800 text-xs text-slate-400 space-y-1">
          <div className="flex items-center justify-between">
            <span>Stockage local SQLite</span>
            <span className="font-mono text-slate-300">FCFA</span>
          </div>
          <div className="text-[11px] text-slate-500 truncate">
            Dernière sauvegarde : {lastBackupAt ? formatDate(lastBackupAt) : 'Aujourd’hui'}
          </div>
        </div>
      </aside>

      {/* Main Content Shell */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar (3-zone contract) */}
        <header className="no-print h-14 bg-white border-b border-slate-200 px-6 flex items-center justify-between gap-8 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs text-slate-400 whitespace-nowrap shrink-0">GestDepot</span>
            <span className="text-slate-300">/</span>
            <h1 className="font-display text-base font-semibold text-slate-900 truncate">
              {currentItem?.label || 'Accueil'}
            </h1>
          </div>

          <div className="hidden md:flex items-center gap-3 text-xs text-slate-500 whitespace-nowrap shrink-0">
            <span>{formatDate(new Date().toISOString())}</span>
            <span aria-hidden="true">·</span>
            <span>Mode hors ligne local</span>
            <span aria-hidden="true">·</span>
            <span className="font-medium text-slate-700">Accès protégé par Code PIN</span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <PWAInstallButton variant="topbar" />
            <button
              type="button"
              onClick={onLogout}
              title="Verrouiller la session GestDepot"
              className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Lock className="w-3.5 h-3.5" />
              <span>Verrouiller</span>
              <LogOut className="w-3.5 h-3.5 ml-0.5 text-slate-500" />
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
};
