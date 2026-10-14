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
  referral: "Referans",
  online: "Online",
  social_media: "Sosyal Medya",
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

interface StaffOption {
  id: string;
  full_name: string;
}

const emptyForm = {
  full_name: "",
  phone: "",
  email: "",
  address: "",
  source: "",
  status: "new" as LeadStatus,
  assigned_to: "",
  notes: "",
};

type FormKey = keyof typeof emptyForm;

const toForm = (lead: Lead) => ({
  full_name: lead.full_name,
  phone: lead.phone,
  email: lead.email ?? "",
  address: lead.address ?? "",
  source: lead.source ?? "",
  status: lead.status,
  assigned_to: lead.assigned_to ?? "",
  notes: lead.notes ?? "",
});

const formatDate = (value: string | null) =>
  value ? new Date(value).toLocaleDateString("tr-TR") : "-";

export default function LeadDetailPage() {
  const params = useParams<{ id: string }>();
  const leadId = params.id;
  const { user } = useAuthStore();
  const supabase = createClient();

  const [lead, setLead] = useState<Lead | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.clinic_id) return;

    const clinicId = user.clinic_id;
    const client = createClient();

    const fetchStaff = async () => {
      const { data, error } = await client
        .from("users")
        .select("id, full_name, is_active")
        .eq("clinic_id", clinicId)
        .order("full_name", { ascending: true });

      if (error) {
        console.error("Error fetching staff:", error);
        return;
      }
      setStaff((data || []).filter((u) => u.is_active !== false));
    };

    fetchStaff();
  }, [user?.clinic_id]);

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
          setForm(toForm(data));
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

  const setField =
    (key: FormKey) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lead || !user?.clinic_id) return;

    const fullName = form.full_name.trim();
    const phone = form.phone.trim();
    if (!fullName || !phone) {
      setMessage(null);
      setError("Ad soyad ve telefon zorunludur.");
      return;
    }

    setSaving(true);
    setMessage(null);
    setError(null);

    const now = new Date().toISOString();
    // converted_at is stamped when the lead becomes a customer and cleared when it leaves that status.
    const convertedAt =
      form.status === "converted"
        ? lead.status === "converted"
          ? lead.converted_at
          : now
        : null;

    const changes = {
      full_name: fullName,
      phone,
      email: form.email.trim() || null,
      address: form.address.trim() || null,
      source: form.source || null,
      status: form.status,
      assigned_to: form.assigned_to || null,
      notes: form.notes.trim() || null,
      converted_at: convertedAt,
      updated_at: now,
    };

    try {
      const { data, error } = await supabase
        .from("leads")
        .update(changes)
        .eq("id", lead.id)
        .eq("clinic_id", user.clinic_id)
        .select("id")
        .maybeSingle();

      if (error) throw error;
      if (!data) throw new Error("Lead güncellenemedi");

      const assignee =
        changes.assigned_to === lead.assigned_to
          ? lead.assignee
          : (staff.find((s) => s.id === changes.assigned_to) ?? null);
      const updated = { ...lead, ...changes, assignee };
      setLead(updated);
      setForm(toForm(updated));
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

  const saved = toForm(lead);
  const unchanged = (Object.keys(emptyForm) as FormKey[]).every((k) => form[k] === saved[k]);

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
          <div className="font-semibold text-gray-900 whitespace-pre-line">{lead.address || "-"}</div>
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="full_name" className="block text-sm font-semibold text-gray-900 mb-2">
              Ad Soyad
            </label>
            <input
              id="full_name"
              type="text"
              value={form.full_name}
              onChange={setField("full_name")}
              className="w-full px-4 py-2 border rounded text-gray-900"
              required
            />
          </div>

          <div>
            <label htmlFor="phone" className="block text-sm font-semibold text-gray-900 mb-2">
              Telefon
            </label>
            <input
              id="phone"
              type="tel"
              value={form.phone}
              onChange={setField("phone")}
              className="w-full px-4 py-2 border rounded text-gray-900"
              required
            />
          </div>

          <div>
            <label htmlFor="email" className="block text-sm font-semibold text-gray-900 mb-2">
              E-posta
            </label>
            <input
              id="email"
              type="email"
              value={form.email}
              onChange={setField("email")}
              className="w-full px-4 py-2 border rounded text-gray-900"
            />
          </div>

          <div>
            <label htmlFor="source" className="block text-sm font-semibold text-gray-900 mb-2">
              Kaynak
            </label>
            <select
              id="source"
              value={form.source}
              onChange={setField("source")}
              className="w-full px-4 py-2 border rounded text-gray-900"
            >
              <option value="">Seç...</option>
              {Object.entries(SOURCE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
              {/* Keep a legacy free-text source selectable so saving does not drop it. */}
              {lead.source && !(lead.source in SOURCE_LABELS) && (
                <option value={lead.source}>{lead.source}</option>
              )}
            </select>
          </div>
        </div>

        <div>
          <label htmlFor="address" className="block text-sm font-semibold text-gray-900 mb-2">
            Adres
          </label>
          <textarea
            id="address"
            rows={2}
            value={form.address}
            onChange={setField("address")}
            className="w-full px-4 py-2 border rounded text-gray-900"
          />
        </div>

        <div>
          <label htmlFor="status" className="block text-sm font-semibold text-gray-900 mb-2">
            Durum
          </label>
          <select
            id="status"
            value={form.status}
            onChange={setField("status")}
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
          <label htmlFor="assigned_to" className="block text-sm font-semibold text-gray-900 mb-2">
            Atanan Kişi
          </label>
          <select
            id="assigned_to"
            value={form.assigned_to}
            onChange={setField("assigned_to")}
            className="w-full px-4 py-2 border rounded text-gray-900"
          >
            <option value="">Atanmamış</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.full_name}
              </option>
            ))}
            {/* Keep an inactive or unlisted assignee selectable so saving does not drop it. */}
            {lead.assigned_to && !staff.some((s) => s.id === lead.assigned_to) && (
              <option value={lead.assigned_to}>{lead.assignee?.full_name ?? "Atanmış kullanıcı"}</option>
            )}
          </select>
        </div>

        <div>
          <label htmlFor="notes" className="block text-sm font-semibold text-gray-900 mb-2">
            Notlar
          </label>
          <textarea
            id="notes"
            rows={6}
            value={form.notes}
            onChange={setField("notes")}
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
