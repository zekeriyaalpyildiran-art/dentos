"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";

type LeadStatus = "new" | "contacted" | "interested" | "qualified" | "converted" | "lost";

const STATUS_LABELS: Record<LeadStatus, string> = {
  new: "Yeni",
  contacted: "İletişime Geçildi",
  interested: "İlgilendiği",
  qualified: "Nitelikli",
  converted: "Müşteri",
  lost: "Kaybedildi",
};

const SOURCE_LABELS: Record<string, string> = {
  direct: "Doğrudan",
  referral: "Tavsiye",
  online: "Online",
  social_media: "Sosyal",
  other: "Diğer",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Lead {
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
  address: string | null;
  source: string | null;
  status: LeadStatus;
  assigned_to: string | null;
  assignee: { full_name: string } | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  converted_at: string | null;
}

const formatDate = (value: string | null) =>
  value ? new Date(value).toLocaleDateString("tr-TR") : "-";

export default function LeadDetailPage() {
  const params = useParams<{ id: string }>();
  const leadId = params.id;
  const { user } = useAuthStore();
  const supabase = createClient();

  const [lead, setLead] = useState<Lead | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<LeadStatus>("new");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.clinic_id || !leadId) return;

    const fetchLead = async () => {
      try {
        // A non-uuid id would make Postgres reject the query, so it is treated as not found.
        if (!UUID_RE.test(leadId)) return;

        const { data, error } = await supabase
          .from("leads")
          .select("*, assignee:users(full_name)")
          .eq("id", leadId)
          .eq("clinic_id", user.clinic_id)
          .maybeSingle();

        if (error) throw error;
        if (data) {
          setLead(data);
          setStatus(data.status);
          setNotes(data.notes ?? "");
        }
      } catch (err) {
        console.error("Error fetching lead:", err);
        setError("Lead yüklenirken hata oluştu.");
      } finally {
        setLoading(false);
      }
    };

    fetchLead();
  }, [user?.clinic_id, leadId]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lead || !user?.clinic_id) return;

    setSaving(true);
    setMessage(null);
    setError(null);

    try {
      const { data, error } = await supabase
        .from("leads")
        .update({ status, notes: notes || null, updated_at: new Date().toISOString() })
        .eq("id", lead.id)
        .eq("clinic_id", user.clinic_id)
        .select("id")
        .maybeSingle();

      if (error) throw error;
      if (!data) throw new Error("Lead güncellenemedi");

      setLead({ ...lead, status, notes: notes || null });
      setMessage("Değişiklikler kaydedildi.");
    } catch (err) {
      console.error("Error saving lead:", err);
      setError("Kaydedilemedi, lütfen tekrar deneyin.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="p-8">Yükleniyor...</div>;
  }

  if (!lead) {
    return (
      <div className="p-8">
        <Link
          href="/crm/leads"
          className="inline-block mb-6 px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
        >
          ← Geri Dön
        </Link>
        <p className="text-gray-600">{error ?? "Lead bulunamadı"}</p>
      </div>
    );
  }

  const unchanged = status === lead.status && notes === (lead.notes ?? "");

  return (
    <div className="p-8">
      <Link
        href="/crm/leads"
        className="inline-block mb-6 px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
      >
        ← Geri Dön
      </Link>

      <h1 className="text-3xl font-bold mb-8">{lead.full_name}</h1>

      <div className="grid grid-cols-2 gap-4 mb-8 bg-gray-50 p-4 rounded">
        <div>
          <div className="text-sm text-gray-600">Telefon</div>
          <div className="font-semibold text-gray-900">{lead.phone}</div>
        </div>
        <div>
          <div className="text-sm text-gray-600">E-posta</div>
          <div className="font-semibold text-gray-900">{lead.email || "-"}</div>
        </div>
        <div>
          <div className="text-sm text-gray-600">Kaynak</div>
          <div className="font-semibold text-gray-900">
            {lead.source ? (SOURCE_LABELS[lead.source] ?? lead.source) : "-"}
          </div>
        </div>
        <div>
          <div className="text-sm text-gray-600">Atanan Kişi</div>
          <div className="font-semibold text-gray-900">
            {lead.assignee?.full_name ?? (lead.assigned_to ? "Atanmış" : "-")}
          </div>
        </div>
        <div className="col-span-2">
          <div className="text-sm text-gray-600">Adres</div>
          <div className="font-semibold text-gray-900">{lead.address || "-"}</div>
        </div>
        <div>
          <div className="text-sm text-gray-600">Oluşturulma Tarihi</div>
          <div className="font-semibold text-gray-900">{formatDate(lead.created_at)}</div>
        </div>
        <div>
          <div className="text-sm text-gray-600">Son Güncelleme</div>
          <div className="font-semibold text-gray-900">{formatDate(lead.updated_at)}</div>
        </div>
        <div className="col-span-2">
          <div className="text-sm text-gray-600">Müşteri Olma Tarihi</div>
          <div className="font-semibold text-gray-900">{formatDate(lead.converted_at)}</div>
        </div>
      </div>

      <form onSubmit={handleSave} className="bg-white rounded-lg shadow p-6 space-y-6 max-w-2xl">
        <div>
          <label htmlFor="status" className="block text-sm font-semibold text-gray-900 mb-2">
            Durum
          </label>
          <select
            id="status"
            value={status}
            onChange={(e) => setStatus(e.target.value as LeadStatus)}
            className="w-full px-4 py-2 border rounded text-gray-900"
          >
            {(Object.keys(STATUS_LABELS) as LeadStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="notes" className="block text-sm font-semibold text-gray-900 mb-2">
            Notlar
          </label>
          <textarea
            id="notes"
            rows={6}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full px-4 py-2 border rounded text-gray-900"
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {message && <p className="text-sm text-green-700">{message}</p>}

        <button
          type="submit"
          disabled={saving || unchanged}
          className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400"
        >
          {saving ? "Kaydediliyor..." : "Kaydet"}
        </button>
      </form>
    </div>
  );
}
