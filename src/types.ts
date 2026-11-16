export type UserRole = 'ADMIN' | 'GERANT' | 'CAISSIER' | 'MAGASINIER' | 'LIVREUR';

export type NavKey =
  | 'dashboard'
  | 'pos'
  | 'orders'
  | 'catalog'
  | 'stock'
  | 'deposits'
  | 'customers'
  | 'deliveries'
  | 'suppliers'
  | 'purchases'
  | 'cash_expenses'
  | 'inventories'
  | 'margins'
  | 'reports'
  | 'settings_users'
  | 'backups';

export interface SessionUser {
  id: number;
  username: string;
  full_name: string;
  role: UserRole;
  permissions: string[];
}

export interface CompanySettings {
  id: number;
  name: string;
  phone: string;
  address: string;
  city: string;
  registration_no: string;
  footer_note: string;
  currency: string;
  tax_enabled: number;
  tax_rate: number;
  reserve_stock_on_order: number;
  auto_backup_on_start: number;
  retention_daily: number;
}

export interface ProductPackaging {
  id: number;
  product_id: number;
  name: string;
  conversion_factor: number;
  is_default_sale: number;
  is_default_purchase: number;
  apply_deposit: number;
}

export interface ProductPrice {
  id: number;
  product_id: number;
  packaging_id: number;
  price_list_id: number;
  price_list_code: string;
  price_list_label: string;
  price_xof: number;
}

export interface Product {
  id: number;
  sku: string;
  name: string;
  description: string;
  category_id: number;
  category_name: string;
  brand_id: number;
  brand_name: string;
  unit_id: number;
  unit_code: string;
  unit_label: string;
  barcode: string | null;
  purchase_cost_xof: number;
  min_threshold: number;
  safety_stock: number;
  track_batches: number;
  packaging_deposit_id: number | null;
  deposit_code: string | null;
  deposit_label: string | null;
  deposit_value_xof: number | null;
  default_supplier_id: number | null;
  default_supplier_name: string | null;
  is_favorite: number;
  active: number;
  physical_qty: number;
  reserved_qty: number;
  available_qty: number;
  packagings: ProductPackaging[];
  prices: ProductPrice[];
}

export interface CatalogMeta {
  categories: Array<{ id: number; name: string }>;
  brands: Array<{ id: number; name: string }>;
  units: Array<{ id: number; code: string; label: string }>;
  priceLists: Array<{ id: number; code: string; label: string; is_default: number }>;
  paymentMethods: Array<{ id: number; code: string; label: string; is_cash: number }>;
  returnablePackagings: Array<{ id: number; code: string; label: string; capacity: number; deposit_value_xof: number }>;
  suppliers: Array<{ id: number; code: string; name: string }>;
  expenseCategories: Array<{ id: number; name: string }>;
}

export interface Customer {
  id: number;
  code: string;
  name: string;
  phone: string;
  address: string;
  customer_type: string;
  price_list_id: number;
  price_list_code: string;
  price_list_label: string;
  credit_limit_xof: number;
  balance_due_xof: number;
  deposit_qty_balance: number;
  last_operation_at: string | null;
}

export interface SaleSummary {
  id: number;
  sale_number: string;
  customer_id: number;
  customer_name: string;
  customer_code: string;
  status: 'VALIDEE' | 'ANNULEE' | 'REMBOURSEE_PARTIELLE';
  subtotal_xof: number;
  discount_xof: number;
  deposit_xof: number;
  total_xof: number;
  paid_xof: number;
  credit_due_xof: number;
  due_date: string | null;
  payment_summary: string;
  cashier_name: string;
  created_at: string;
}

export const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: 'Administrateur',
  GERANT: 'Gérant',
  CAISSIER: 'Caissier',
  MAGASINIER: 'Magasinier',
  LIVREUR: 'Livreur',
};

export interface GestDepotDesktopConfig {
  isDesktop: boolean;
  platform: string;
  dataDir: string;
  autoBackupDir: string;
  autoBackupIntervalMinutes: number;
  lastMirrorSyncAt: string | null;
  lastMirrorFile: string | null;
}

export interface GestDepotDesktopBridge {
  isDesktop: boolean;
  platform: string;
  getDesktopConfig: () => Promise<GestDepotDesktopConfig>;
  selectAutoBackupDir: () => Promise<{
    canceled: boolean;
    autoBackupDir: string;
    lastMirrorSyncAt?: string | null;
    lastMirrorFile?: string | null;
  }>;
  setAutoBackupInterval: (minutes: number) => Promise<{ autoBackupIntervalMinutes: number }>;
  runAutoBackupNow: () => Promise<{
    ok: boolean;
    filename?: string;
    mirrorPath?: string | null;
    createdAt?: string;
    error?: string;
  }>;
  openFolder: (targetPath: string) => Promise<void>;
}

declare global {
  interface Window {
    gestdepotDesktop?: GestDepotDesktopBridge;
  }
}
