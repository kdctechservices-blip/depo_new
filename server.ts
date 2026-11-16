import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { type BackupKind, closeDb, createSqliteBackup, getDb, initSchema } from './server/db.ts';
import { seedIfEmpty } from './server/seed.ts';
import { attachAuth } from './server/middleware.ts';
import { coreRouter } from './server/routes-core.ts';
import { salesRouter } from './server/routes-sales.ts';
import { opsRouter } from './server/routes-ops.ts';

export interface StartServerOptions {
  port?: number;
  host?: string;
  staticDistPath?: string;
}

export interface StartedServer {
  app: express.Express;
  server: http.Server;
  port: number;
  runAutoBackup: (type?: BackupKind, reason?: string) => Promise<{
    id: number;
    filename: string;
    file_path: string;
    mirror_path: string | null;
    size_bytes: number;
    integrity_ok: number;
    created_at: string;
  } | null>;
  shutdown: (reason?: string) => Promise<void>;
}

export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  initSchema();
  seedIfEmpty();

  // Automatic daily startup backup check (if enabled and no backup today)
  try {
    const db = getDb();
    const settings = db.prepare('SELECT auto_backup_on_start FROM company_settings WHERE id = 1').get() as
      | { auto_backup_on_start: number }
      | undefined;
    const todayPrefix = new Date().toISOString().slice(0, 10);
    const todayBackup = db
      .prepare('SELECT id FROM backup_history WHERE created_at LIKE ? LIMIT 1')
      .get(`${todayPrefix}%`);
    if (settings?.auto_backup_on_start === 1 && !todayBackup) {
      await createSqliteBackup('AUTO_DEMARRAGE', 'Sauvegarde automatique quotidienne au démarrage');
    }
  } catch (err) {
    console.error('Startup backup warning:', err);
  }

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(attachAuth);

  app.use('/api', coreRouter);
  app.use('/api', salesRouter);
  app.use('/api', opsRouter);

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = options.staticDistPath || path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const requestedPort = options.port ?? Number(process.env.PORT ?? 3000);
  const host = options.host ?? '0.0.0.0';

  const server = await new Promise<http.Server>((resolve, reject) => {
    const srv = app.listen(requestedPort, host, () => resolve(srv));
    srv.on('error', reject);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : requestedPort;
  console.log(`GestDepot server listening on http://${host}:${actualPort}`);

  let closed = false;
  const runAutoBackup = async (
    type: BackupKind = 'AUTO_PERIODIQUE',
    reason = 'Sauvegarde automatique vers le dossier local',
  ) => {
    if (closed) return null;
    return await createSqliteBackup(type, reason);
  };

  const shutdown = async (reason = 'Fermeture propre du serveur') => {
    if (closed) return;
    closed = true;
    try {
      await createSqliteBackup('AUTO_FERMETURE', reason);
    } catch (err) {
      console.error('Shutdown backup warning:', err);
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    closeDb();
  };

  return { app, server, port: actualPort, runAutoBackup, shutdown };
}

if (process.env.GESTDEPOT_EMBEDDED !== '1') {
  startServer().catch((err) => {
    console.error('Failed to start GestDepot server:', err);
    process.exit(1);
  });
}
