import { useEffect, useState } from 'react';
import { apiFetch, getSessionToken, setSessionToken } from './utils/api';
import type { CompanySettings, NavKey, SessionUser } from './types';
import { LoginScreen } from './components/LoginScreen';
import { Layout, NAV_ITEMS } from './components/Layout';
import { OfflineIndicator } from './components/PWAInstallButton';
import { DashboardPage } from './pages/DashboardPage';
import { PosPage } from './pages/PosPage';
import { CatalogPage } from './pages/CatalogPage';
import { StockPage } from './pages/StockPage';
import { DepositsPage } from './pages/DepositsPage';
import { CustomersPage } from './pages/CustomersPage';
import { OrdersPage } from './pages/OrdersPage';
import { DeliveriesPage } from './pages/DeliveriesPage';
import { SuppliersPage } from './pages/SuppliersPage';
import { PurchasesPage } from './pages/PurchasesPage';
import { CashExpensesPage } from './pages/CashExpensesPage';
import { InventoryPage } from './pages/InventoryPage';
import { MarginsPage } from './pages/MarginsPage';
import { ReportsPage } from './pages/ReportsPage';
import { SettingsUsersPage } from './pages/SettingsUsersPage';
import { BackupPage } from './pages/BackupPage';

export default function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [company, setCompany] = useState<CompanySettings | null>(null);
  const [activeNav, setActiveNav] = useState<NavKey>('dashboard');
  const [booting, setBooting] = useState(true);

  const loadSettings = async () => {
    try {
      const st = await apiFetch<CompanySettings>('/api/settings');
      setCompany(st);
    } catch {
      // ignore if unauthenticated
    }
  };

  useEffect(() => {
    const restoreSession = async () => {
      const token = getSessionToken();
      if (!token) {
        setBooting(false);
        return;
      }
      try {
        const res = await apiFetch<{ user: SessionUser }>('/api/auth/me');
        setUser(res.user);
        const firstAllowed = NAV_ITEMS.find((i) => res.user.permissions.includes(i.permission));
        if (firstAllowed) setActiveNav(firstAllowed.key);
        await loadSettings();
      } catch {
        setSessionToken(null);
      } finally {
        setBooting(false);
      }
    };
    void restoreSession();
  }, []);

  const handleLoginSuccess = async (loggedUser: SessionUser) => {
    setUser(loggedUser);
    const firstAllowed = NAV_ITEMS.find((i) => loggedUser.permissions.includes(i.permission));
    if (firstAllowed) setActiveNav(firstAllowed.key);
    await loadSettings();
  };

  const handleLogout = async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    setSessionToken(null);
    setUser(null);
  };

  if (booting) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-600">
        Chargement de GestDepot...
      </div>
    );
  }

  if (!user) {
    return (
      <>
        <LoginScreen depotName={company?.name} onLoginSuccess={handleLoginSuccess} />
        <OfflineIndicator />
      </>
    );
  }

  const renderPage = () => {
    switch (activeNav) {
      case 'dashboard':
        return <DashboardPage onNavigate={setActiveNav} />;
      case 'pos':
        return <PosPage user={user} company={company} />;
      case 'orders':
        return <OrdersPage company={company} />;
      case 'catalog':
        return <CatalogPage user={user} company={company} />;
      case 'stock':
        return <StockPage user={user} />;
      case 'deposits':
        return <DepositsPage />;
      case 'customers':
        return <CustomersPage company={company} />;
      case 'deliveries':
        return <DeliveriesPage company={company} />;
      case 'suppliers':
        return <SuppliersPage />;
      case 'purchases':
        return <PurchasesPage />;
      case 'cash_expenses':
        return <CashExpensesPage />;
      case 'inventories':
        return <InventoryPage />;
      case 'margins':
        return <MarginsPage company={company} />;
      case 'reports':
        return <ReportsPage company={company} />;
      case 'settings_users':
        return <SettingsUsersPage onSettingsUpdated={loadSettings} />;
      case 'backups':
        return <BackupPage />;
      default:
        return <DashboardPage onNavigate={setActiveNav} />;
    }
  };

  return (
    <>
      <Layout
        user={user}
        company={company}
        activeNav={activeNav}
        onSelectNav={setActiveNav}
        onLogout={() => void handleLogout()}
      >
        {renderPage()}
      </Layout>
      <OfflineIndicator />
    </>
  );
}
