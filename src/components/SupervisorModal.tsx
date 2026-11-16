import React, { useState } from 'react';
import { KeyRound, ShieldAlert, X } from 'lucide-react';

interface SupervisorModalProps {
  title: string;
  description: string;
  onCancel: () => void;
  onConfirm: (username: string, secret: string) => Promise<void>;
}

export const SupervisorModal: React.FC<SupervisorModalProps> = ({ title, description, onCancel, onConfirm }) => {
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await onConfirm('admin', pin);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-700 shrink-0">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-display font-bold text-slate-900 text-base">{title}</h3>
              <p className="text-xs text-slate-600 mt-0.5">{description}</p>
            </div>
          </div>
          <button type="button" onClick={onCancel} className="text-slate-400 hover:text-slate-700 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{error}</div>}

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label htmlFor="confirm-pin" className="block text-xs font-medium text-slate-700 mb-1">
              Code PIN de confirmation
            </label>
            <div className="relative">
              <KeyRound className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                id="confirm-pin"
                type="password"
                inputMode="numeric"
                maxLength={8}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                required
                autoFocus
                className="w-full pl-9 pr-3 py-2 text-sm font-mono tracking-widest border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
                placeholder="Saisissez votre Code PIN"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={loading || pin.length < 4}
              className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-lg cursor-pointer"
            >
              {loading ? 'Validation...' : 'Confirmer par PIN'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
