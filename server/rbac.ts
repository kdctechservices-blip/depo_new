export type UserRole = 'ADMIN' | 'GERANT' | 'CAISSIER' | 'MAGASINIER' | 'LIVREUR';

export type ModulePermission =
  | 'dashboard'
  | 'pos'
  | 'orders'
  | 'catalog'
  | 'catalog_edit'
  | 'stock'
  | 'stock_adjust'
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
  | 'backups'
  | 'sensitive_override';

const ROLE_PERMISSIONS: Record<UserRole, ModulePermission[]> = {
  ADMIN: [
    'dashboard',
    'pos',
    'orders',
    'catalog',
    'catalog_edit',
    'stock',
    'stock_adjust',
    'deposits',
    'customers',
    'deliveries',
    'suppliers',
    'purchases',
    'cash_expenses',
    'inventories',
    'margins',
    'reports',
    'settings_users',
    'backups',
    'sensitive_override',
  ],
  GERANT: [
    'dashboard',
    'pos',
    'orders',
    'catalog',
    'catalog_edit',
    'stock',
    'stock_adjust',
    'deposits',
    'customers',
    'deliveries',
    'suppliers',
    'purchases',
    'cash_expenses',
    'inventories',
    'margins',
    'reports',
    'sensitive_override',
  ],
  CAISSIER: ['dashboard', 'pos', 'orders', 'customers', 'deposits', 'cash_expenses'],
  MAGASINIER: ['dashboard', 'catalog', 'stock', 'stock_adjust', 'deposits', 'purchases', 'inventories', 'deliveries'],
  LIVREUR: ['deliveries'],
};

export function hasPermission(role: UserRole, permission: ModulePermission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function getPermissionsForRole(role: UserRole): ModulePermission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: 'Administrateur',
  GERANT: 'Gérant',
  CAISSIER: 'Caissier',
  MAGASINIER: 'Magasinier',
  LIVREUR: 'Livreur',
};
