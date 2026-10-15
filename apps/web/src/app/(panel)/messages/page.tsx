"use client";

import { useState, useEffect } from "react";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";
import { SmsNotActiveNotice } from "@/components/appointments/SmsNotActiveNotice";

interface Message {
  id: string;
  created_at: string;
  notification_type: string;
  message: string | null;
  status: string;
  patients: { full_name: string } | null;
}

const CHANNEL_LABELS: Record<string, string> = {
  sms: "SMS",
  email: "E-posta",
  in_app: "Uygulama İçi",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Bekleniyor",
  sent: "Gönderildi",
  failed: "Başarısız",
};

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-blue-100 text-blue-800",
  sent: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

const FILTERS = ["all", "pending", "sent", "failed"] as const;
type Filter = (typeof FILTERS)[number];

const truncate = (text: string | null, max = 80) => {
  if (!text) return "-";
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

const formatDateTime = (value: string) =>
  new Date(value).toLocaleString("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export default function MessagesPage() {
  const { user } = useAuthStore();
  const supabase = createClient();

  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    const clinicId = user?.clinic_id;
    if (!clinicId) {
      setLoading(false);
      return;
    }

    const fetchMessages = async () => {
      try {
        const { data, error } = await supabase
          .from("notifications")
          .select(
            "id, created_at, notification_type, message, status, patients(full_name)"
          )
          .eq("clinic_id", clinicId)
          .order("created_at", { ascending: false })
          .limit(100);

        if (error) throw error;
        setMessages((data || []) as unknown as Message[]);
      } catch (err) {
        console.error("Error fetching messages:", err);
        setError(true);
      } finally {
        setLoading(false);
      }
    };

    fetchMessages();
  }, [user?.clinic_id]);

  const filtered = messages.filter((m) => filter === "all" || m.status === filter);

  if (loading) return <div className="p-8">Yükleniyor...</div>;

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-6">Mesajlar</h1>

      <SmsNotActiveNotice className="mb-8" />

      {/* Filters */}
      <div className="mb-6 flex gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded font-semibold ${
              filter === f
                ? "bg-blue-600 text-white"
                : "bg-gray-200 text-gray-800 hover:bg-gray-300"
            }`}
          >
            {f === "all" ? "Tümü" : STATUS_LABELS[f]}
          </button>
        ))}
      </div>

      {/* Messages Table */}
      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-100 border-b">
            <tr>
              {["Tarih", "Hasta", "Kanal", "Mesaj", "Durum"].map((h) => (
                <th
                  key={h}
                  className="px-6 py-4 text-left text-sm font-semibold text-gray-800"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className={`px-6 py-8 text-center ${
                    error ? "text-red-600" : "text-gray-500"
                  }`}
                >
                  {error
                    ? "Mesajlar yüklenemedi. Lütfen sayfayı yenileyin."
                    : "Mesaj bulunamadı"}
                </td>
              </tr>
            ) : (
              filtered.map((m) => (
                <tr key={m.id} className="border-b hover:bg-gray-50">
                  <td className="px-6 py-4 text-sm text-gray-600 whitespace-nowrap">
                    {formatDateTime(m.created_at)}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-800 font-semibold">
                    {m.patients?.full_name || "Bilinmiyor"}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {CHANNEL_LABELS[m.notification_type] ?? m.notification_type}
                  </td>
                  <td
                    className="px-6 py-4 text-sm text-gray-600"
                    title={m.message ?? undefined}
                  >
                    {truncate(m.message)}
                  </td>
                  <td className="px-6 py-4 text-sm">
                    <span
                      className={`px-3 py-1 rounded text-sm font-semibold ${
                        STATUS_STYLES[m.status] ?? "bg-gray-100 text-gray-800"
                      }`}
                    >
                      {STATUS_LABELS[m.status] ?? m.status}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
