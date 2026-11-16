import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  DatabaseBackup,
  Download,
  ExternalLink,
  FolderCog,
  FolderOpen,
  HardDrive,
  RotateCcw,
  Upload,
} from 'lucide-react';
import { apiFetch, getSessionToken } from '../utils/api';
import { formatBytes, formatDateTime } from '../utils/format';
import { SupervisorModal } from '../components/SupervisorModal';
import type { GestDepotDesktopConfig } from '../types';

interface BackupState {
  dbPath: string;
  backupsDir: string;
  mirrorDir?: string | null;
  dbSizeBytes: number;
  liveIntegrity: string;
  history: Array<{
    id: number;
    filename: string;
    file_path: string;
    size_bytes: number;
    integrity_ok: number;
    backup_type: string;
    status: string;
    message: string;
    created_at: string;
  }>;
}

export const BackupPage: React.FC = () => {
  const [data, setData] = useState<BackupState | null>(null);
  const [desktopCfg, setDesktopCfg] = useState<GestDepotDesktopConfig | null>(null);
  const [creating, setCreating] = useState(false);
  const [syncingDesktop, setSyncingDesktop] = useState(false);
  const [restoreTargetId, setRestoreTargetId] = useState<number | null>(null);
  const [pendingImport, setPendingImport] = useState<{ filename: string; base64Data: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadData = async () => {
    const [backupRes, cfgRes] = await Promise.all([
      apiFetch<BackupState>('/api/backups'),
      window.gestdepotDesktop?.getDesktopConfig ? window.gestdepotDesktop.getDesktopConfig() : Promise.resolve(null),
    ]);
    setData(backupRes);
    setDesktopCfg(cfgRes);
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleCreateBackup = async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await apiFetch<{ filename: string; integrity_ok: number; mirror_path?: string | null }>(
        '/api/backups/create',
        {
          method: 'POST',
          body: JSON.stringify({ note: 'Sauvegarde manuelle depuis l’interface' }),
        },
      );
      setMsg(
        `Sauvegarde ${res.filename} créée et vérifiée (PRAGMA integrity_check : ${
          res.integrity_ok ? 'OK' : 'ERREUR'
        })${res.mirror_path ? ` et synchronisée vers ${res.mirror_path}` : ''}.`,
      );
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleSelectDesktopFolder = async () => {
    if (!window.gestdepotDesktop) return;
    setError(null);
    setMsg(null);
    const res = await window.gestdepotDesktop.selectAutoBackupDir();
    if (!res.canceled) {
      setMsg(`Dossier de sauvegarde automatique configuré : ${res.autoBackupDir}`);
      await loadData();
    }
  };

  const handleIntervalChange = async (minutes: number) => {
    if (!window.gestdepotDesktop) return;
    await window.gestdepotDesktop.setAutoBackupInterval(minutes);
    await loadData();
    setMsg(`Fréquence de sauvegarde automatique réglée sur toutes les ${minutes} minutes.`);
  };

  const handleRunDesktopBackupNow = async () => {
    if (!window.gestdepotDesktop) return;
    setSyncingDesktop(true);
    setError(null);
    setMsg(null);
    try {
      const res = await window.gestdepotDesktop.runAutoBackupNow();
      if (res.ok) {
        setMsg(`Sauvegarde automatique effectuée vers : ${res.mirrorPath || res.filename}`);
        await loadData();
      } else {
        setError(res.error || 'Échec de la sauvegarde automatique Electron.');
      }
    } finally {
      setSyncingDesktop(false);
    }
  };

  const handleDownload = (id: number) => {
    const token = getSessionToken();
    window.location.href = `/api/backups/${id}/download?token=${encodeURIComponent(token || '')}`;
  };

  const handleSelectImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setMsg(null);

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (!(result instanceof ArrayBuffer)) {
        setError('Impossible de lire le fichier sélectionné.');
        return;
      }
      const bytes = new Uint8Array(result);
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      setPendingImport({
        filename: file.name,
        base64Data: btoa(binary),
      });
    };
    reader.onerror = () => {
      setError('Erreur de lecture du fichier de sauvegarde.');
    };
    reader.readAsArrayBuffer(file);
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-5 space-y-2.5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-display font-bold text-sm text-slate-900">
              Base de données 100 % locale SQLite (WAL + Synchronous FULL)
            </h2>
            <span className="text-xs font-medium text-emerald-700 flex items-center gap-1 whitespace-nowrap shrink-0">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Intégrité : {data?.liveIntegrity.toUpperCase() || 'OK'}
            </span>
          </div>
          <p className="text-xs text-slate-600">
            Toutes les données (ventes, stocks, clients, consignes, achats, caisse) sont enregistrées localement sur
            votre ordinateur avec validation disque immédiate (<span className="font-mono">PRAGMA synchronous = FULL</span>)
            et sauvegardes automatiques à l’ouverture, en cours d’utilisation et à la fermeture.
          </p>
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5 space-y-1 text-[11px] font-mono text-slate-700 break-all">
            <div className="flex items-start gap-1.5">
              <FolderOpen className="w-3.5 h-3.5 text-teal-700 shrink-0 mt-0.5" />
              <span>
                <strong className="font-sans text-slate-800">Base active :</strong> {data?.dbPath || '—'} (
                {data ? formatBytes(data.dbSizeBytes) : '—'})
              </span>
            </div>
            <div className="pl-5">
              <strong className="font-sans text-slate-800">Dossier sauvegardes principal :</strong>{' '}
              {data?.backupsDir || '—'}
            </div>
            {data?.mirrorDir && (
              <div className="pl-5 text-teal-800">
                <strong className="font-sans text-teal-900">Dossier miroir automatique :</strong> {data.mirrorDir}
              </div>
            )}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-3">
          <p className="text-xs text-slate-600">
            Créez une copie sur disque, exportez-la sur clé USB ou restaurez un fichier{' '}
            <span className="font-mono">.sqlite</span> externe.
          </p>
          <div className="space-y-2">
            <button
              type="button"
              disabled={creating}
              onClick={() => void handleCreateBackup()}
              className="w-full py-2.5 px-4 bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-2 cursor-pointer"
            >
              <DatabaseBackup className="w-4 h-4" />
              {creating ? 'Sauvegarde en cours...' : 'Créer une sauvegarde maintenant'}
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept=".sqlite,.db"
              onChange={handleSelectImportFile}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full py-2 px-4 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-medium rounded-lg flex items-center justify-center gap-2 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              Importer un fichier (.sqlite)
            </button>
          </div>
        </div>
      </div>

      {/* Electron Desktop Auto-Backup Folder Integration */}
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5 max-w-2xl">
            <h3 className="font-display font-bold text-sm text-slate-900 flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-teal-700" />
              Sauvegarde automatique vers un dossier système dédié (Contexte Electron)
            </h3>
            {desktopCfg ? (
              <>
                <p className="text-xs text-slate-600">
                  Mode Desktop actif : une copie SQLite vérifiée est automatiquement enregistrée dans le dossier choisi
                  au démarrage, à la fréquence définie, lors de la fermeture de la fenêtre et à l’arrêt de l’application
                  (les 30 dernières copies automatiques sont conservées).
                </p>
                <div className="text-[11px] font-mono text-slate-800 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 break-all">
                  Dossier cible : {desktopCfg.autoBackupDir}
                  {desktopCfg.lastMirrorSyncAt && (
                    <div className="text-slate-500 mt-0.5 font-sans">
                      Dernière synchronisation : {formatDateTime(desktopCfg.lastMirrorSyncAt)}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <p className="text-xs text-slate-600">
                Dans l’application autonome Electron (MacBook Pro / Windows), GestDepot duplique automatiquement
                chaque sauvegarde SQLite vers un dossier système dédié (par défaut{' '}
                <span className="font-mono">~/Documents/GestDepot-Sauvegardes</span>), y compris à la fermeture de la
                fenêtre. Vous pouvez aussi définir la variable d’environnement{' '}
                <span className="font-mono">GESTDEPOT_AUTO_BACKUP_DIR</span> si vous lancez le serveur en ligne de
                commande.
              </p>
            )}
          </div>

          {desktopCfg && (
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <select
                aria-label="Fréquence sauvegarde automatique"
                value={desktopCfg.autoBackupIntervalMinutes}
                onChange={(e) => void handleIntervalChange(Number(e.target.value))}
                className="px-2.5 py-2 text-xs font-medium border border-slate-300 rounded-lg bg-white text-slate-800 cursor-pointer"
              >
                <option value={15}>Toutes les 15 min</option>
                <option value={30}>Toutes les 30 min</option>
                <option value={60}>Toutes les 60 min</option>
              </select>

              <button
                type="button"
                onClick={() => void handleSelectDesktopFolder()}
                className="px-3 py-2 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <FolderCog className="w-3.5 h-3.5" />
                Changer de dossier
              </button>

              <button
                type="button"
                onClick={() => void window.gestdepotDesktop?.openFolder(desktopCfg.autoBackupDir)}
                className="px-3 py-2 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Ouvrir
              </button>

              <button
                type="button"
                disabled={syncingDesktop}
                onClick={() => void handleRunDesktopBackupNow()}
                className="px-3 py-2 text-xs font-semibold bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white rounded-lg flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <DatabaseBackup className="w-3.5 h-3.5" />
                {syncingDesktop ? 'Synchro...' : 'Synchroniser maintenant'}
              </button>
            </div>
          )}
        </div>
      </div>

      {msg && <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800">{msg}</div>}
      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{error}</div>}

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
            <tr>
              <th className="text-left px-4 py-3 font-semibold">Date & Heure</th>
              <th className="text-left px-4 py-3 font-semibold">Fichier</th>
              <th className="text-left px-4 py-3 font-semibold">Type</th>
              <th className="text-right px-4 py-3 font-semibold">Taille</th>
              <th className="text-left px-4 py-3 font-semibold">Intégrité</th>
              <th className="text-right px-4 py-3 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data?.history.map((b) => (
              <tr key={b.id} className="hover:bg-slate-50">
                <td className="px-4 py-2.5 tabular-nums text-slate-600">{formatDateTime(b.created_at)}</td>
                <td className="px-4 py-2.5 font-mono text-slate-900">{b.filename}</td>
                <td className="px-4 py-2.5 text-slate-700">{b.backup_type}</td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatBytes(b.size_bytes)}</td>
                <td className="px-4 py-2.5">
                  <span className={`font-medium ${b.integrity_ok ? 'text-emerald-700' : 'text-red-700'}`}>
                    {b.integrity_ok ? 'Valide (OK)' : 'Corrompue'}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right space-x-3 whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => handleDownload(b.id)}
                    className="text-teal-700 hover:underline font-medium inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Copie USB
                  </button>
                  {b.integrity_ok === 1 && (
                    <button
                      type="button"
                      onClick={() => setRestoreTargetId(b.id)}
                      className="text-amber-700 hover:underline font-semibold inline-flex items-center gap-1 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Restaurer
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {restoreTargetId !== null && (
        <SupervisorModal
          title="Restauration contrôlée de la base de données"
          description="Une sauvegarde de sécurité de la base actuelle sera créée automatiquement avant restauration. Authentification Administrateur obligatoire."
          onCancel={() => setRestoreTargetId(null)}
          onConfirm={async (adminUser, adminSecret) => {
            const res = await apiFetch<{ restoredFrom: string }>(`/api/backups/${restoreTargetId}/restore`, {
              method: 'POST',
              body: JSON.stringify({ admin_username: adminUser, admin_secret: adminSecret }),
            });
            setRestoreTargetId(null);
            setMsg(`Base restaurée avec succès depuis ${res.restoredFrom}.`);
            await loadData();
          }}
        />
      )}

      {pendingImport && (
        <SupervisorModal
          title={`Importer la sauvegarde « ${pendingImport.filename} »`}
          description="L’intégrité du fichier sera vérifiée avant toute modification et une copie de sécurité de la base actuelle sera enregistrée automatiquement."
          onCancel={() => setPendingImport(null)}
          onConfirm={async (adminUser, adminSecret) => {
            const res = await apiFetch<{ restoredFrom: string }>('/api/backups/import', {
              method: 'POST',
              body: JSON.stringify({
                filename: pendingImport.filename,
                base64Data: pendingImport.base64Data,
                admin_username: adminUser,
                admin_secret: adminSecret,
              }),
            });
            setPendingImport(null);
            setMsg(`Sauvegarde externe ${res.restoredFrom} vérifiée et restaurée avec succès.`);
            await loadData();
          }}
        />
      )}
    </div>
  );
};
