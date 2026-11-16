import React, { useEffect, useState } from 'react';
import { CheckCircle2, KeyRound, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { apiFetch } from '../utils/api';
import { formatDateTime } from '../utils/format';
import type { CatalogMeta, CompanySettings } from '../types';

interface AuditLogRow {
  id: number;
  user_name: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: string;
  created_at: string;
}

export const SettingsUsersPage: React.FC<{ onSettingsUpdated: () => void }> = ({ onSettingsUpdated }) => {
  const [tab, setTab] = useState<'security' | 'depot' | 'referentiels' | 'audit'>('security');
  const [settings, setSettings] = useState<CompanySettings | null>(null);
  const [meta, setMeta] = useState<CatalogMeta | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogRow[]>([]);
  const [isDefaultPin, setIsDefaultPin] = useState(false);

  // PIN change form
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [savingPin, setSavingPin] = useState(false);

  const [refKind, setRefKind] = useState<
    'category' | 'brand' | 'unit' | 'payment_method' | 'expense_category' | 'packaging'
  >('category');
  const [refName, setRefName] = useState('');
  const [refCode, setRefCode] = useState('');
  const [refIsCash, setRefIsCash] = useState(false);
  const [refVal, setRefVal] = useState(0);

  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    const [meRes, st, m, logs] = await Promise.all([
      apiFetch<{ user: { isDefaultPin?: boolean } }>('/api/auth/me'),
      apiFetch<CompanySettings>('/api/settings'),
      apiFetch<CatalogMeta>('/api/catalog/meta'),
      apiFetch<AuditLogRow[]>('/api/audit-logs'),
    ]);
    setIsDefaultPin(Boolean(meRes.user.isDefaultPin));
    setSettings(st);
    setMeta(m);
    setAuditLogs(logs);
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleChangePin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMsg(null);

    if (!/^\d{4,8}$/.test(newPin)) {
      setError('Le nouveau code PIN doit contenir entre 4 et 8 chiffres.');
      return;
    }
    if (newPin !== confirmPin) {
      setError('La confirmation du nouveau code PIN ne correspond pas.');
      return;
    }

    setSavingPin(true);
    try {
      await apiFetch('/api/auth/pin', {
        method: 'PUT',
        body: JSON.stringify({ current_pin: currentPin, new_pin: newPin }),
      });
      setCurrentPin('');
      setNewPin('');
      setConfirmPin('');
      setMsg('Code PIN modifié avec succès. Le nouveau PIN est actif immédiatement.');
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingPin(false);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setError(null);
    setMsg(null);
    await apiFetch('/api/settings', { method: 'PUT', body: JSON.stringify(settings) });
    setMsg('Paramètres du dépôt enregistrés.');
    onSettingsUpdated();
    await loadData();
  };

  const handleAddReference = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMsg(null);
    try {
      await apiFetch('/api/settings/reference', {
        method: 'POST',
        body: JSON.stringify({
          kind: refKind,
          name: refName,
          code: refCode || undefined,
          deposit_value_xof: refVal,
          is_cash: refIsCash,
        }),
      });
      setRefName('');
      setRefCode('');
      setRefIsCash(false);
      setRefVal(0);
      setMsg('Élément de référentiel ajouté.');
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleDeleteReference = async (kind: string, id: number, label: string) => {
    setError(null);
    setMsg(null);
    try {
      await apiFetch(`/api/settings/reference/${kind}/${id}`, { method: 'DELETE' });
      setMsg(`Élément « ${label} » retiré des listes actives.`);
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          <button
            type="button"
            onClick={() => setTab('security')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer whitespace-nowrap shrink-0 ${
              tab === 'security' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Sécurité & Code PIN
          </button>
          <button
            type="button"
            onClick={() => setTab('depot')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer whitespace-nowrap shrink-0 ${
              tab === 'depot' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Paramètres du dépôt
          </button>
          <button
            type="button"
            onClick={() => setTab('referentiels')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer whitespace-nowrap shrink-0 ${
              tab === 'referentiels' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Listes & Référentiels
          </button>
          <button
            type="button"
            onClick={() => setTab('audit')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer whitespace-nowrap shrink-0 ${
              tab === 'audit' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Journal d’audit ({auditLogs.length})
          </button>
        </div>
      </div>

      {msg && <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800">{msg}</div>}
      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{error}</div>}

      {tab === 'security' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
          <form
            onSubmit={handleChangePin}
            className="bg-white border border-slate-200 rounded-xl p-6 space-y-4 text-xs"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display font-bold text-sm text-slate-900 flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-teal-700" />
                  Modifier le Code PIN d’accès
                </h2>
                <p className="text-slate-600 mt-1">
                  Ce Code PIN protège l’ouverture de GestDepot ainsi que les opérations sensibles (restauration de base,
                  annulation de vente, dépassement crédit).
                </p>
              </div>
            </div>

            {isDefaultPin ? (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-900">
                Vous utilisez actuellement le Code PIN par défaut (<span className="font-mono font-bold">5555</span>).
                Pensez à définir votre code personnel ci-dessous.
              </div>
            ) : (
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-800 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                Un Code PIN personnalisé est actif sur ce poste.
              </div>
            )}

            <div>
              <label htmlFor="pin-current" className="block font-medium text-slate-700 mb-1">
                Code PIN actuel
              </label>
              <input
                id="pin-current"
                type="password"
                inputMode="numeric"
                maxLength={8}
                required
                value={currentPin}
                onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                placeholder="Ex. 5555"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono tracking-widest"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="pin-new" className="block font-medium text-slate-700 mb-1">
                  Nouveau Code PIN (4 à 8 chiffres)
                </label>
                <input
                  id="pin-new"
                  type="password"
                  inputMode="numeric"
                  maxLength={8}
                  required
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                  placeholder="••••"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono tracking-widest"
                />
              </div>

              <div>
                <label htmlFor="pin-confirm" className="block font-medium text-slate-700 mb-1">
                  Confirmer le nouveau Code PIN
                </label>
                <input
                  id="pin-confirm"
                  type="password"
                  inputMode="numeric"
                  maxLength={8}
                  required
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                  placeholder="••••"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono tracking-widest"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={savingPin}
              className="px-4 py-2.5 font-semibold bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white rounded-lg flex items-center gap-1.5 cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              {savingPin ? 'Enregistrement...' : 'Enregistrer le nouveau Code PIN'}
            </button>
          </form>

          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3 text-xs">
            <h3 className="font-display font-bold text-sm text-slate-900 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-teal-700" />
              Sécurité locale de l’application bureau
            </h3>
            <ul className="space-y-2 text-slate-600 list-disc pl-4">
              <li>
                Le Code PIN est stocké localement sous forme d’empreinte cryptographique salée (
                <span className="font-mono">scrypt</span>) dans votre base SQLite.
              </li>
              <li>
                En cas de 5 tentatives erronées successives, une temporisation de sécurité de 15 secondes protège
                l’accès sans jamais bloquer définitivement votre poste.
              </li>
              <li>
                Vous pouvez verrouiller l’application à tout moment via le bouton <strong>Verrouiller</strong> en haut à
                droite.
              </li>
            </ul>
          </div>
        </div>
      )}

      {tab === 'depot' && settings && (
        <form
          onSubmit={handleSaveSettings}
          className="bg-white border border-slate-200 rounded-xl p-6 max-w-2xl space-y-4 text-xs"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block font-medium text-slate-700 mb-1">Nom du dépôt</label>
              <input
                type="text"
                value={settings.name}
                onChange={(e) => setSettings({ ...settings, name: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Téléphone</label>
              <input
                type="text"
                value={settings.phone}
                onChange={(e) => setSettings({ ...settings, phone: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Adresse</label>
              <input
                type="text"
                value={settings.address}
                onChange={(e) => setSettings({ ...settings, address: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">RCCM / NCC (Documents)</label>
              <input
                type="text"
                value={settings.registration_no}
                onChange={(e) => setSettings({ ...settings, registration_no: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          <div>
            <label className="block font-medium text-slate-700 mb-1">Pied de page des tickets et factures</label>
            <input
              type="text"
              value={settings.footer_note}
              onChange={(e) => setSettings({ ...settings, footer_note: e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg"
            />
          </div>

          <div className="space-y-2 pt-2 border-t border-slate-100">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.reserve_stock_on_order === 1}
                onChange={(e) => setSettings({ ...settings, reserve_stock_on_order: e.target.checked ? 1 : 0 })}
                className="accent-teal-700"
              />
              Réserver le stock dès la confirmation des commandes clients
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.auto_backup_on_start === 1}
                onChange={(e) => setSettings({ ...settings, auto_backup_on_start: e.target.checked ? 1 : 0 })}
                className="accent-teal-700"
              />
              Sauvegarde SQLite automatique quotidienne au premier démarrage
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.tax_enabled === 1}
                onChange={(e) => setSettings({ ...settings, tax_enabled: e.target.checked ? 1 : 0 })}
                className="accent-teal-700"
              />
              Activer le calcul de TVA / taxe paramétrable ({settings.tax_rate}%)
            </label>
          </div>

          <button
            type="submit"
            className="px-4 py-2 font-semibold bg-teal-700 hover:bg-teal-800 text-white rounded-lg flex items-center gap-1.5 cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" />
            Enregistrer les paramètres
          </button>
        </form>
      )}

      {tab === 'referentiels' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 text-xs">
          <form
            onSubmit={handleAddReference}
            className="bg-white border border-slate-200 rounded-xl p-5 space-y-3 h-fit"
          >
            <h3 className="font-display font-bold text-sm text-slate-900">Personnaliser les listes dynamiques</h3>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Type de liste</label>
              <select
                value={refKind}
                onChange={(e) => setRefKind(e.target.value as typeof refKind)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
              >
                <option value="category">Catégorie de produit</option>
                <option value="brand">Marque / Fabricant</option>
                <option value="unit">Unité de mesure</option>
                <option value="payment_method">Moyen de paiement</option>
                <option value="expense_category">Catégorie de dépense</option>
                <option value="packaging">Emballage consigné</option>
              </select>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Libellé</label>
              <input
                type="text"
                required
                value={refName}
                onChange={(e) => setRefName(e.target.value)}
                placeholder="Libellé affiché dans l’application"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>
            {(refKind === 'unit' || refKind === 'payment_method' || refKind === 'packaging') && (
              <div>
                <label className="block font-medium text-slate-700 mb-1">Code court (facultatif)</label>
                <input
                  type="text"
                  value={refCode}
                  onChange={(e) => setRefCode(e.target.value)}
                  placeholder="Généré automatiquement si vide"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono uppercase"
                />
              </div>
            )}
            {refKind === 'payment_method' && (
              <label className="flex items-center gap-2 cursor-pointer text-slate-700">
                <input
                  type="checkbox"
                  checked={refIsCash}
                  onChange={(e) => setRefIsCash(e.target.checked)}
                  className="accent-teal-700"
                />
                Impacte le tiroir espèces de la caisse
              </label>
            )}
            {refKind === 'packaging' && (
              <div>
                <label className="block font-medium text-slate-700 mb-1">Valeur de consigne (FCFA)</label>
                <input
                  type="number"
                  min={0}
                  value={refVal}
                  onChange={(e) => setRefVal(Math.round(Number(e.target.value) || 0))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono"
                />
              </div>
            )}
            <button
              type="submit"
              className="px-4 py-2 font-semibold bg-teal-700 text-white rounded-lg cursor-pointer"
            >
              Ajouter à la liste
            </button>
          </form>

          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <h3 className="font-display font-bold text-sm text-slate-900">Listes actives</h3>

            {[
              {
                title: 'Catégories',
                kind: 'category',
                items: meta?.categories.map((c) => ({ id: c.id, label: c.name })) ?? [],
              },
              {
                title: 'Marques / Fabricants',
                kind: 'brand',
                items: meta?.brands.map((b) => ({ id: b.id, label: b.name })) ?? [],
              },
              {
                title: 'Unités de base',
                kind: 'unit',
                items: meta?.units.map((u) => ({ id: u.id, label: `${u.label} (${u.code})` })) ?? [],
              },
              {
                title: 'Moyens de paiement',
                kind: 'payment_method',
                items: meta?.paymentMethods.map((p) => ({ id: p.id, label: p.label })) ?? [],
              },
              {
                title: 'Catégories de dépenses',
                kind: 'expense_category',
                items: meta?.expenseCategories.map((e) => ({ id: e.id, label: e.name })) ?? [],
              },
              {
                title: 'Emballages consignés',
                kind: 'packaging',
                items:
                  meta?.returnablePackagings.map((p) => ({ id: p.id, label: `${p.label} (${p.deposit_value_xof} F)` })) ??
                  [],
              },
            ].map((group) => (
              <div key={group.kind} className="space-y-1.5 border-b border-slate-100 pb-3 last:border-b-0 last:pb-0">
                <div className="font-semibold text-slate-900">{group.title}</div>
                {group.items.length === 0 ? (
                  <p className="text-slate-400">Aucun élément configuré.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {group.items.map((item) => (
                      <span
                        key={item.id}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-slate-50 border border-slate-200 rounded-md text-slate-700"
                      >
                        <span>{item.label}</span>
                        <button
                          type="button"
                          onClick={() => void handleDeleteReference(group.kind, item.id, item.label)}
                          title={`Retirer ${item.label}`}
                          className="text-slate-400 hover:text-red-600 cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'audit' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">Date & Heure</th>
                <th className="text-left px-4 py-3 font-semibold">Action</th>
                <th className="text-left px-4 py-3 font-semibold">Objet</th>
                <th className="text-left px-4 py-3 font-semibold">Détails</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {auditLogs.map((l) => (
                <tr key={l.id}>
                  <td className="px-4 py-2 text-slate-500 tabular-nums">{formatDateTime(l.created_at)}</td>
                  <td className="px-4 py-2 font-mono text-teal-800">{l.action}</td>
                  <td className="px-4 py-2 text-slate-600">{l.entity_type}</td>
                  <td className="px-4 py-2 text-slate-700">{l.details}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
