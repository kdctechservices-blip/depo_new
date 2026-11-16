import React, { useState } from 'react';
import { Download, MonitorSmartphone, WifiOff, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

interface PWAInstallButtonProps {
  variant?: 'topbar' | 'login';
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({ variant = 'topbar' }) => {
  const { isInstallable, isInstalled, isIOS, isDesktop, install } = usePWAInstall();
  const [showGuideModal, setShowGuideModal] = useState(false);

  // Masquer si déjà lancé en PWA installée ou dans l'application bureau Electron
  if (isInstalled || isDesktop) {
    return null;
  }

  const handleClick = async () => {
    if (isInstallable) {
      await install();
      return;
    }
    setShowGuideModal(true);
  };

  const buttonClass =
    variant === 'login'
      ? 'w-full py-2 px-3 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 text-xs font-medium rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer'
      : 'px-3 py-1.5 text-xs font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer';

  const label = isInstallable
    ? "Installer l'app"
    : isIOS
      ? 'Installer sur iOS'
      : 'Installer PWA';

  return (
    <>
      <button
        type="button"
        onClick={() => void handleClick()}
        title="Installer GestDepot sur cet ordinateur ou mobile (Chrome / Edge / Safari)"
        className={buttonClass}
      >
        <Download className="w-3.5 h-3.5 shrink-0" />
        <span>{label}</span>
      </button>

      {showGuideModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-xl bg-white border border-slate-200 p-6 shadow-xl space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-lg bg-teal-50 text-teal-700 flex items-center justify-center shrink-0">
                  <MonitorSmartphone className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-display text-base font-bold text-slate-900">
                    {isIOS ? 'Installer sur iPhone / iPad' : 'Installer GestDepot (Chrome / Edge)'}
                  </h3>
                  <p className="text-xs text-slate-500">Application Web Progressive (PWA)</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowGuideModal(false)}
                className="p-1 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
                aria-label="Fermer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {isIOS ? (
              <ol className="text-sm text-slate-700 space-y-2 list-decimal list-inside">
                <li>
                  Touchez le bouton <strong>Partager</strong> dans la barre de Safari.
                </li>
                <li>
                  Faites défiler vers le bas et sélectionnez <strong>Sur l’écran d’accueil</strong>.
                </li>
                <li>
                  Validez avec <strong>Ajouter</strong> pour lancer GestDepot en plein écran.
                </li>
              </ol>
            ) : (
              <div className="text-sm text-slate-700 space-y-2.5">
                <p>
                  Pour installer GestDepot sur Windows, macOS ou Android depuis <strong>Chrome</strong> ou{' '}
                  <strong>Microsoft Edge</strong> :
                </p>
                <ol className="space-y-1.5 list-decimal list-inside text-xs text-slate-600">
                  <li>Ouvrez l’application dans un onglet navigateur principal (hors aperçu intégré).</li>
                  <li>
                    Cliquez sur l’icône <strong>Installer GestDepot</strong> à droite de la barre d’adresse, ou ouvrez
                    le menu du navigateur &rarr; <strong>Installer l’application</strong>.
                  </li>
                  <li>
                    Pour un poste caisse Windows ou macOS 100 % autonome avec SQLite intégré, utilisez le paquet bureau
                    Electron (<code>npm run dist:win</code> ou <code>npm run dist:mac</code>).
                  </li>
                </ol>
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowGuideModal(false)}
              className="w-full py-2 bg-teal-700 hover:bg-teal-800 text-white text-xs font-medium rounded-lg transition-colors cursor-pointer"
            >
              Compris
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div className="no-print fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white shadow-lg">
      <WifiOff className="w-3.5 h-3.5 shrink-0" />
      <span>Hors connexion réseau — cache PWA actif</span>
    </div>
  );
};
