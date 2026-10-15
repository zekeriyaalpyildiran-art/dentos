"use client";

import { useState, useEffect, useRef } from "react";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";
import {
  REMINDER_CANCELLED_REASON,
  REMINDER_NOT_SENT_REASON,
  reminderDisplayStatus,
  type ReminderDisplayStatus,
} from "@/lib/appointments/reminders";
import { SmsNotActiveNotice } from "@/components/appointments/SmsNotActiveNotice";

const PAGE_SIZE = 50;

// "cancelled" and "not_sent" are not reminder_status values: they are failed reminders closed because the appointment
// was cancelled, or because no SMS is ever sent (migration 0028).
type DisplayStatus = ReminderDisplayStatus;
type Filter = "all" | DisplayStatus;

const FILTERS: Filter[] = ["all", "pending", "sent", "failed", "cancelled", "not_sent"];

const STATUS_LABELS: Record<DisplayStatus, string> = {
  pending: "Bekleniyor",
  sent: "Gönderildi",
  failed: "Başarısız",
  cancelled: "İptal",
  not_sent: "Gönderilmedi",
};

const STATUS_STYLES: Record<DisplayStatus, string> = {
  pending: "bg-blue-100 text-blue-800",
  sent: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  cancelled: "bg-gray-100 text-gray-800",
  not_sent: "bg-amber-100 text-amber-800",
};

interface Reminder {
  id: string;
  appointment_id: string;
  patient_name: string;
  doctor_name: string;
  appointment_time: string | null;
  reminder_type: "sms" | "email" | "in_app";
  scheduled_at: string;
  status: DisplayStatus;
  error_message: string | null;
}

interface ReminderRow {
  id: string;
  appointment_id: string;
  reminder_type: Reminder["reminder_type"];
  scheduled_at: string;
  status: "pending" | "sent" | "failed";
  error_message: string | null;
  appointments: {
    start_time: string;
    patients: { full_name: string } | null;
    doctors: { users: { full_name: string } | null } | null;
  } | null;
}

type Stats = Record<"total" | DisplayStatus, number>;

export default function RemindersPage() {
  const { user } = useAuthStore();
  const supabase = createClient();

  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [stats, setStats] = useState<Stats | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    if (!user?.clinic_id) return;
    fetchStats();
  }, [user?.clinic_id]);

  useEffect(() => {
    if (!user?.clinic_id) return;
    fetchReminders(0);
  }, [user?.clinic_id, filter]);

  // Counts come from head-only count queries, so they cover every reminder rather than the loaded page.
  const fetchStats = async () => {
    try {
      const countQuery = () =>
        supabase
          .from("reminders")
          .select("id", { count: "exact", head: true })
          .eq("clinic_id", user?.clinic_id);

      const results = await Promise.all([
        countQuery(),
        countQuery().eq("status", "pending"),
        countQuery().eq("status", "sent"),
        countQuery().eq("status", "failed"),
        countQuery().eq("status", "failed").eq("error_message", REMINDER_CANCELLED_REASON),
        countQuery().eq("status", "failed").eq("error_message", REMINDER_NOT_SENT_REASON),
      ]);

      const failedQuery = results.find((r) => r.error);
      if (failedQuery) throw failedQuery.error;

      const [total, pending, sent, failed, cancelled, notSent] = results.map((r) => r.count ?? 0);
      setStats({ total, pending, sent, failed: failed - cancelled - notSent, cancelled, not_sent: notSent });
    } catch (error) {
      console.error("Error fetching reminder stats:", error);
      setStats(null);
    }
  };

  const fetchReminders = async (from: number) => {
    const reqId = ++requestId.current;
    if (from === 0) setLoading(true);
    else setLoadingMore(true);
    try {
      let query = supabase
        .from("reminders")
        .select(
          `
          id,
          appointment_id,
          reminder_type,
          scheduled_at,
          status,
          error_message,
          appointments(
            start_time,
            patients(full_name),
            doctors(users(full_name))
          )
        `
        )
        .eq("clinic_id", user?.clinic_id);
      if (filter === "pending" || filter === "sent") {
        query = query.eq("status", filter);
      } else if (filter === "cancelled") {
        query = query.eq("status", "failed").eq("error_message", REMINDER_CANCELLED_REASON);
      } else if (filter === "not_sent") {
        query = query.eq("status", "failed").eq("error_message", REMINDER_NOT_SENT_REASON);
      } else if (filter === "failed") {
        query = query
          .eq("status", "failed")
          .or(
            `error_message.is.null,and(error_message.neq."${REMINDER_CANCELLED_REASON}",error_message.neq."${REMINDER_NOT_SENT_REASON}")`
          );
      }

      const { data, error } = await query
        .order("scheduled_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, from + PAGE_SIZE - 1);

      // A newer request (filter change or another page) supersedes this one.
      if (reqId !== requestId.current) return;
      if (error) throw error;

      const mapped: Reminder[] = ((data || []) as unknown as ReminderRow[]).map((r) => ({
        id: r.id,
        appointment_id: r.appointment_id,
        patient_name: r.appointments?.patients?.full_name || "-",
        doctor_name: r.appointments?.doctors?.users?.full_name || "-",
        appointment_time: r.appointments?.start_time ?? null,
        reminder_type: r.reminder_type,
        scheduled_at: r.scheduled_at,
        status: reminderDisplayStatus(r.status, r.error_message),
        error_message: r.error_message,
      }));

      setReminders((prev) => {
        if (from === 0) return mapped;
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...mapped.filter((r) => !seen.has(r.id))];
      });
      setHasMore(mapped.length === PAGE_SIZE);
    } catch (error) {
      console.error("Error fetching reminders:", error);
      if (from === 0) {
        setReminders([]);
        setHasMore(false);
      }
    } finally {
      if (reqId === requestId.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  };

  const getStatusBadge = (reminder: Reminder) => (
    <span
      className={`px-3 py-1 rounded text-sm font-semibold ${STATUS_STYLES[reminder.status]}`}
      title={
        reminder.status === "failed" || reminder.status === "not_sent" ? reminder.error_message ?? undefined : undefined
      }
    >
      {STATUS_LABELS[reminder.status]}
    </span>
  );

  const getReminderTypeBadge = (type: string) => {
    const icons = {
      sms: "📱 SMS",
      email: "📧 E-posta",
      in_app: "🔔 Uygulama içi",
    };
    return icons[type as keyof typeof icons] || type;
  };

  const formatDateTime = (dateString: string | null) => {
    if (!dateString) return "-";
    return new Date(dateString).toLocaleString("tr-TR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatCount = (key: keyof Stats) => (stats ? stats[key] : "-");

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-6">Randevu Hatırlatmaları</h1>

      <SmsNotActiveNotice className="mb-8" />

      {/* Statistics */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="text-gray-500 text-sm mb-2">Toplam</div>
          <div className="text-3xl font-bold text-gray-800">{formatCount("total")}</div>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="text-blue-700 text-sm mb-2">Bekleniyor</div>
          <div className="text-3xl font-bold text-blue-600">{formatCount("pending")}</div>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="text-green-700 text-sm mb-2">Gönderildi</div>
          <div className="text-3xl font-bold text-green-600">{formatCount("sent")}</div>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="text-red-700 text-sm mb-2">Başarısız</div>
          <div className="text-3xl font-bold text-red-600">{formatCount("failed")}</div>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="text-gray-500 text-sm mb-2">İptal</div>
          <div className="text-3xl font-bold text-gray-600">{formatCount("cancelled")}</div>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="text-amber-700 text-sm mb-2">Gönderilmedi</div>
          <div className="text-3xl font-bold text-amber-600">{formatCount("not_sent")}</div>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-6 flex flex-wrap gap-2">
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

      {/* Reminders Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-100 border-b">
            <tr>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Hasta
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Hekim
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Randevu Zamanı
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Hatırlatma Türü
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Planlanan Zaman
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Durum
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-6 py-8 text-center text-gray-500">
                  Yükleniyor...
                </td>
              </tr>
            ) : reminders.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-8 text-center text-gray-500">
                  Hatırlatma bulunamadı
                </td>
              </tr>
            ) : (
              reminders.map((reminder) => (
                <tr key={reminder.id} className="border-b hover:bg-gray-50">
                  <td className="px-6 py-4 text-sm text-gray-800">
                    {reminder.patient_name}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-800">
                    {reminder.doctor_name}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {formatDateTime(reminder.appointment_time)}
                  </td>
                  <td className="px-6 py-4 text-sm">
                    {getReminderTypeBadge(reminder.reminder_type)}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {formatDateTime(reminder.scheduled_at)}
                  </td>
                  <td className="px-6 py-4 text-sm">
                    {getStatusBadge(reminder)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {hasMore && !loading && (
        <div className="mt-6 flex justify-center">
          <button
            onClick={() => fetchReminders(reminders.length)}
            disabled={loadingMore}
            className="px-4 py-2 rounded font-semibold bg-gray-200 text-gray-800 hover:bg-gray-300 disabled:opacity-50"
          >
            {loadingMore ? "Yükleniyor..." : "Daha fazla yükle"}
          </button>
        </div>
      )}
    </div>
  );
}
