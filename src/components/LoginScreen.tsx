import React, { useEffect, useState } from 'react';
import { Delete, KeyRound, ShieldCheck } from 'lucide-react';
import { apiFetch, setSessionToken } from '../utils/api';
import type { SessionUser } from '../types';
import { PWAInstallButton } from './PWAInstallButton';

interface LoginScreenProps {
  depotName?: string;
  onLoginSuccess: (user: SessionUser) => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ depotName, onLoginSuccess }) => {
  const [pin, setPin] = useState('');
  const [isDefaultPin, setIsDefaultPin] = useState<boolean>(false);
  const [resolvedDepotName, setResolvedDepotName] = useState<string>(depotName || 'GestDepot');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/auth/pin-status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { isDefaultPin?: boolean; depotName?: string } | null) => {
        if (!active || !data) return;
        setIsDefaultPin(Boolean(data.isDefaultPin));
        if (data.depotName) setResolvedDepotName(data.depotName);
      })
      .catch(() => {
        // ignore if offline/booting
      });
    return () => {
      active = false;
    };
  }, []);

  const submitPin = async (pinValue: string) => {
    const clean = pinValue.trim();
    if (!clean || loading) return;
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch<{ token: string; user: SessionUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ pin: clean }),
      });
      setSessionToken(res.token);
      onLoginSuccess(res.user);
    } catch (err) {
      setError((err as Error).message);
      setPin('');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitPin(pin);
  };

  const appendDigit = (digit: string) => {
    setError(null);
    setPin((prev) => (prev.length < 8 ? `${prev}${digit}` : prev));
  };

  const handleBackspace = () => {
    setError(null);
    setPin((prev) => prev.slice(0, -1));
  };

  const handleClear = () => {
    setError(null);
    setPin('');
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col lg:flex-row">
      {/* Left Visual Column */}
      <div className="relative lg:w-1/2 min-h-[260px] lg:min-h-screen bg-slate-900 overflow-hidden flex flex-col justify-between p-8 lg:p-12">
        <img
          src="/src/assets/images/depot_warehouse_hero_1794830302806.jpg"
          alt="Entrepôt de distribution de boissons GestDepot"
          referrerPolicy="no-referrer"
          className="absolute inset-0 w-full h-full object-cover opacity-55"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-slate-950/90 via-slate-900/55 to-slate-950/70" />

        <div className="relative z-10 flex items-center gap-4">
          <img
            src="/src/assets/images/gestdepot_logo_1794830301767.jpg"
            alt="Logo GestDepot"
            referrerPolicy="no-referrer"
            className="w-12 h-12 rounded-lg object-cover border border-white/20 bg-white"
          />
          <div>
            <p className="font-display text-xl font-bold text-white tracking-tight">GestDepot</p>
            <p className="text-xs text-slate-300 tracking-wide">Gestion commerciale de dépôt de boissons</p>
          </div>
        </div>

        <div className="relative z-10 max-w-lg space-y-4 mt-12">
          <h1 className="font-display text-3xl lg:text-4xl font-bold text-white leading-tight [text-wrap:balance]">
            Pilotez vos ventes, stocks et emballages consignés sans connexion Internet.
          </h1>
          <p className="text-sm text-slate-200 leading-relaxed">
            Application bureau autonome · Base locale SQLite sécurisée · Montants exacts en FCFA (XOF) · Sauvegarde
            automatique sur votre ordinateur.
          </p>
        </div>

        <div className="relative z-10 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-300 pt-6 border-t border-white/15">
          <span>Mode hors ligne actif</span>
          <span aria-hidden="true">·</span>
          <span>Données locales protégées</span>
          <span aria-hidden="true">·</span>
          <span>Devise FCFA (XOF)</span>
        </div>
      </div>

      {/* Right Single-User PIN Screen */}
      <div className="flex-1 flex items-center justify-center p-6 sm:p-10 lg:p-16">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center">
            <p className="text-xs font-medium text-teal-700 mb-1">{depotName || resolvedDepotName}</p>
            <h2 className="font-display text-2xl font-bold text-slate-900">Déverrouillage par Code PIN</h2>
            <p className="text-sm text-slate-600 mt-1">
              Saisissez votre Code PIN pour ouvrir votre session GestDepot.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="bg-white border border-slate-200 rounded-xl p-6 space-y-5 shadow-sm">
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 font-medium text-center">
                {error}
              </div>
            )}

            <div>
              <label htmlFor="login-pin" className="sr-only">
                Code PIN d’accès
              </label>
              <div className="relative">
                <KeyRound className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  id="login-pin"
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={8}
                  value={pin}
                  onChange={(e) => {
                    setError(null);
                    setPin(e.target.value.replace(/\D/g, '').slice(0, 8));
                  }}
                  autoFocus
                  required
                  autoComplete="off"
                  placeholder="••••"
                  className="w-full pl-10 pr-4 py-3 text-center text-2xl tracking-[0.5em] font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>
            </div>

            {/* Tactile numeric keypad */}
            <div className="grid grid-cols-3 gap-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => appendDigit(d)}
                  className="py-2.5 text-base font-mono font-semibold bg-slate-50 hover:bg-slate-100 active:bg-slate-200 border border-slate-200 rounded-lg text-slate-900 transition-colors cursor-pointer"
                >
                  {d}
                </button>
              ))}
              <button
                type="button"
                onClick={handleClear}
                className="py-2.5 text-xs font-medium bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg text-slate-600 transition-colors cursor-pointer"
              >
                Effacer
              </button>
              <button
                type="button"
                onClick={() => appendDigit('0')}
                className="py-2.5 text-base font-mono font-semibold bg-slate-50 hover:bg-slate-100 active:bg-slate-200 border border-slate-200 rounded-lg text-slate-900 transition-colors cursor-pointer"
              >
                0
              </button>
              <button
                type="button"
                onClick={handleBackspace}
                aria-label="Effacer le dernier chiffre"
                className="py-2.5 flex items-center justify-center bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg text-slate-600 transition-colors cursor-pointer"
              >
                <Delete className="w-4 h-4" />
              </button>
            </div>

            <button
              type="submit"
              disabled={loading || pin.length < 4}
              className="w-full py-2.5 px-4 bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer"
            >
              <ShieldCheck className="w-4 h-4" />
              {loading ? 'Vérification...' : 'Déverrouiller GestDepot'}
            </button>

            {isDefaultPin && (
              <p className="text-[11px] text-center text-slate-500 pt-1">
                Code PIN par défaut : <span className="font-mono font-semibold text-slate-700">5555</span> (modifiable à
                tout moment dans <span className="font-medium">Paramètres avancés</span>)
              </p>
            )}
          </form>

          <div className="pt-1">
            <PWAInstallButton variant="login" />
          </div>
        </div>
      </div>
    </div>
  );
};
