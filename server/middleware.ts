import type { Request, Response, NextFunction } from 'express';
import { getDb, verifySecret } from './db.ts';
import { hasPermission, type ModulePermission, type UserRole } from './rbac.ts';

export interface AuthUser {
  id: number;
  username: string;
  full_name: string;
  role: UserRole;
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
  sessionToken?: string;
}

export function attachAuth(req: AuthedRequest, _res: Response, next: NextFunction): void {
  const token = (req.headers['x-session-token'] as string | undefined) || (req.query.token as string | undefined);
  if (!token) {
    return next();
  }
  const db = getDb();
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.full_name, u.role, u.active, s.expires_at
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`,
    )
    .get(token) as
    | { id: number; username: string; full_name: string; role: UserRole; active: number; expires_at: string }
    | undefined;

  if (row && row.active === 1 && new Date(row.expires_at).getTime() > Date.now()) {
    req.user = {
      id: row.id,
      username: row.username,
      full_name: row.full_name,
      role: row.role,
    };
    req.sessionToken = token;
  }
  next();
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentification requise. Veuillez vous connecter.' });
    return;
  }
  next();
}

export function requirePermission(permission: ModulePermission) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Session expirée ou non authentifiée.' });
      return;
    }
    if (!hasPermission(req.user.role, permission)) {
      res.status(403).json({
        error: `Accès refusé : le rôle ${req.user.role} ne dispose pas de la permission "${permission}".`,
      });
      return;
    }
    next();
  };
}

export function verifySupervisorCredentials(username: string, secret: string): AuthUser | null {
  const db = getDb();
  const cleanUser = username.trim();
  const row = (
    cleanUser && cleanUser !== 'admin'
      ? db
          .prepare(
            `SELECT id, username, full_name, role, password_hash, pin_hash, active
             FROM users WHERE username = ?`,
          )
          .get(cleanUser)
      : db
          .prepare(
            `SELECT id, username, full_name, role, password_hash, pin_hash, active
             FROM users WHERE active = 1 AND role = 'ADMIN' ORDER BY id ASC LIMIT 1`,
          )
          .get()
  ) as
    | {
        id: number;
        username: string;
        full_name: string;
        role: UserRole;
        password_hash: string;
        pin_hash: string | null;
        active: number;
      }
    | undefined;

  if (!row || row.active !== 1) return null;
  if (row.role !== 'ADMIN' && row.role !== 'GERANT') return null;

  const valid = verifySecret(secret.trim(), row.pin_hash) || verifySecret(secret.trim(), row.password_hash);
  if (!valid) return null;

  return {
    id: row.id,
    username: row.username,
    full_name: row.full_name,
    role: row.role,
  };
}

export function toIntXof(val: unknown, fieldName = 'montant'): number {
  const num = Number(val);
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new Error(`Le champ "${fieldName}" doit être un nombre entier exact en FCFA.`);
  }
  return num;
}

export function toPositiveInt(val: unknown, fieldName = 'quantité'): number {
  const num = Number(val);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
    throw new Error(`Le champ "${fieldName}" doit être un entier strictement positif.`);
  }
  return num;
}
