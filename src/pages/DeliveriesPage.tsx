import React, { useEffect, useState } from 'react';
import { FileText, Plus, Truck } from 'lucide-react';
import { apiFetch } from '../utils/api';
import { exportToPDF, formatDate, formatXOF } from '../utils/format';
import type { CompanySettings, Customer } from '../types';

interface DeliveryRow {
  id: number;
  delivery_number: string;
  order_number: string | null;
  customer_name: string;
  customer_phone: string;
  driver_name: string;
  vehicle: string;
  address: string;
  scheduled_date: string;
  fee_xof: number;
  status: string;
  proof_note: string;
  collected_xof: number;
}

export const DeliveriesPage: React.FC<{ company: CompanySettings | null }> = ({ company }) => {
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [newOpen, setNewOpen] = useState(false);

  const [custId, setCustId] = useState<number | ''>('');
  const [driverName, setDriverName] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [address, setAddress] = useState('');
  const [schedDate, setSchedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [fee, setFee] = useState(0);
  const [proofModal, setProofModal] = useState<{ delivery: DeliveryRow; status: string; note: string } | null>(null);

  const loadData = async () => {
    const [dels, custs] = await Promise.all([
      apiFetch<DeliveryRow[]>('/api/deliveries'),
      apiFetch<Customer[]>('/api/customers'),
    ]);
    setDeliveries(dels);
    setCustomers(custs);
    setCustId((prev) => (prev && custs.some((c) => c.id === prev) ? prev : (custs[0]?.id ?? '')));
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!custId) return;
    await apiFetch('/api/deliveries', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: Number(custId),
        driver_name: driverName,
        vehicle,
        address,
        scheduled_date: schedDate,
        fee_xof: fee,
      }),
    });
    setNewOpen(false);
    setDriverName('');
    setVehicle('');
    setAddress('');
    setFee(0);
    await loadData();
  };

  const handleStatusChange = async (d: DeliveryRow, status: string) => {
    if (status === 'LIVREE' || status === 'ECHEC' || status === 'LIVREE_PARTIELLE') {
      setProofModal({ delivery: d, status, note: d.proof_note || '' });
      return;
    }
    await apiFetch(`/api/deliveries/${d.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, proof_note: d.proof_note || '', collected_xof: d.collected_xof }),
    });
    await loadData();
  };

  const confirmProofStatus = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!proofModal) return;
    await apiFetch(`/api/deliveries/${proofModal.delivery.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: proofModal.status,
        proof_note: proofModal.note,
        collected_xof: proofModal.delivery.collected_xof,
      }),
    });
    setProofModal(null);
    await loadData();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-600">
          Planification des tournées, suivi livreur et édition des bons de livraison.
        </p>
        <button
          type="button"
          onClick={() => setNewOpen(true)}
          className="px-3.5 py-2 text-xs font-semibold bg-teal-700 hover:bg-teal-800 text-white rounded-lg flex items-center gap-1.5 cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          Planifier une livraison
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
            <tr>
              <th className="text-left px-4 py-3 font-semibold">N° Livraison</th>
              <th className="text-left px-4 py-3 font-semibold">Client & Adresse</th>
              <th className="text-left px-4 py-3 font-semibold">Livreur / Véhicule</th>
              <th className="text-left px-4 py-3 font-semibold">Date prévue</th>
              <th className="text-right px-4 py-3 font-semibold">Frais</th>
              <th className="text-left px-4 py-3 font-semibold">Statut</th>
              <th className="text-right px-4 py-3 font-semibold">Bon PDF</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {deliveries.map((d) => (
              <tr key={d.id} className="hover:bg-slate-50">
                <td className="px-4 py-2.5 font-mono font-semibold text-slate-900">
                  <div className="flex items-center gap-1.5">
                    <Truck className="w-3.5 h-3.5 text-teal-700" />
                    {d.delivery_number}
                  </div>
                  {d.order_number && <div className="text-[11px] text-slate-500">{d.order_number}</div>}
                </td>
                <td className="px-4 py-2.5">
                  <div className="font-medium text-slate-900">{d.customer_name}</div>
                  <div className="text-[11px] text-slate-500">{d.address}</div>
                </td>
                <td className="px-4 py-2.5">
                  <div className="text-slate-900">{d.driver_name}</div>
                  <div className="text-[11px] text-slate-500">{d.vehicle}</div>
                </td>
                <td className="px-4 py-2.5 tabular-nums">{formatDate(d.scheduled_date)}</td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatXOF(d.fee_xof)}</td>
                <td className="px-4 py-2.5">
                  <select
                    value={d.status}
                    onChange={(e) => void handleStatusChange(d, e.target.value)}
                    className="px-2 py-1 text-[11px] border border-slate-300 rounded bg-white"
                  >
                    <option value="PLANIFIEE">Planifiée</option>
                    <option value="EN_COURS">En cours</option>
                    <option value="LIVREE_PARTIELLE">Livrée partiellement</option>
                    <option value="LIVREE">Livrée</option>
                    <option value="ECHEC">Échec</option>
                  </select>
                  {d.proof_note && <div className="text-[10px] text-slate-500 mt-0.5">{d.proof_note}</div>}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button
                    type="button"
                    onClick={() =>
                      exportToPDF({
                        title: `Bon de livraison ${d.delivery_number}`,
                        subtitle: `Client : ${d.customer_name} · Livreur : ${d.driver_name} (${d.vehicle})`,
                        company,
                        columns: ['N° Bon', 'Destination', 'Date prévue', 'Statut', 'Frais livraison'],
                        rows: [[d.delivery_number, d.address, formatDate(d.scheduled_date), d.status, formatXOF(d.fee_xof)]],
                        filename: `${d.delivery_number}.pdf`,
                      })
                    }
                    className="text-teal-700 hover:underline font-medium inline-flex items-center gap-1 cursor-pointer"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    BL PDF
                  </button>
                </td>
              </tr>
            ))}
            {deliveries.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                  Aucune livraison planifiée pour le moment.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {newOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleCreate}
            className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-3 shadow-lg text-xs"
          >
            <h3 className="font-display font-bold text-base text-slate-900">Planifier une livraison</h3>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Client</label>
              <select
                required
                value={custId}
                onChange={(e) => setCustId(e.target.value ? Number(e.target.value) : '')}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
              >
                <option value="">Sélectionner un client...</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Chauffeur / Livreur</label>
                <input
                  type="text"
                  required
                  value={driverName}
                  onChange={(e) => setDriverName(e.target.value)}
                  placeholder="Nom du livreur"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Véhicule</label>
                <input
                  type="text"
                  value={vehicle}
                  onChange={(e) => setVehicle(e.target.value)}
                  placeholder="Immatriculation ou type"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Adresse de livraison</label>
              <input
                type="text"
                required
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Quartier, rue ou point de repère"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Date prévue</label>
                <input
                  type="date"
                  value={schedDate}
                  onChange={(e) => setSchedDate(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Frais de livraison (FCFA)</label>
                <input
                  type="number"
                  min={0}
                  value={fee}
                  onChange={(e) => setFee(Math.round(Number(e.target.value) || 0))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setNewOpen(false)}
                className="px-4 py-2 bg-slate-100 rounded-lg cursor-pointer"
              >
                Annuler
              </button>
              <button
                type="submit"
                disabled={!custId}
                className="px-4 py-2 font-semibold bg-teal-700 disabled:opacity-40 text-white rounded-lg cursor-pointer"
              >
                Planifier
              </button>
            </div>
          </form>
        </div>
      )}

      {proofModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <form
            onSubmit={confirmProofStatus}
            className="bg-white border border-slate-200 rounded-xl w-full max-w-sm p-5 space-y-3 shadow-lg text-xs"
          >
            <h3 className="font-display font-bold text-sm text-slate-900">
              Confirmation statut — {proofModal.delivery.delivery_number}
            </h3>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Observation / Preuve de livraison</label>
              <input
                type="text"
                value={proofModal.note}
                onChange={(e) => setProofModal({ ...proofModal, note: e.target.value })}
                placeholder="Observation ou nom du réceptionnaire"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setProofModal(null)}
                className="px-3 py-1.5 bg-slate-100 rounded-lg cursor-pointer"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="px-3 py-1.5 font-semibold bg-teal-700 text-white rounded-lg cursor-pointer"
              >
                Enregistrer
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
