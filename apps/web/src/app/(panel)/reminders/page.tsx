"use client";

import { useState, useEffect } from "react";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";

interface Reminder {
  id: string;
  appointment_id: string;
  patient_name: string;
  doctor_name: string;
  appointment_time: string;
  reminder_type: "sms" | "email" | "in_app";
  scheduled_at: string;
  status: "pending" | "sent" | "failed";
}

export default function RemindersPage() {
  const { user } = useAuthStore();
  const supabase = createClient();

  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "pending" | "sent" | "failed">(
    "all"
  );
  const [stats, setStats] = useState({
    total: 0,
    pending: 0,
    sent: 0,
    failed: 0,
  });

  useEffect(() => {
    if (!user?.clinic_id) return;
    fetchReminders();
  }, [user?.clinic_id]);

  const fetchReminders = async () => {
    try {
      const { data, error } = await supabase
        .from("reminders")
        .select(
          `
          id,
          appointment_id,
          reminder_type,
          scheduled_at,
          status,
          appointments(
            start_time,
            patients(full_name),
            doctors(full_name)
          )
        `
        )
        .eq("clinic_id", user?.clinic_id)
        .order("scheduled_at", { ascending: false })
        .limit(100);

      if (error) throw error;

      const mapped = (data || []).map((r: any) => ({
        id: r.id,
        appointment_id: r.appointment_id,
        patient_name: r.appointments?.patients?.full_name || "Unknown",
        doctor_name: r.appointments?.doctors?.full_name || "Unknown",
        appointment_time: r.appointments?.start_time,
        reminder_type: r.reminder_type,
        scheduled_at: r.scheduled_at,
        status: r.status,
      }));

      setReminders(mapped);

      setStats({
        total: mapped.length,
        pending: mapped.filter((r) => r.status === "pending").length,
        sent: mapped.filter((r) => r.status === "sent").length,
        failed: mapped.filter((r) => r.status === "failed").length,
      });
    } catch (error) {
      console.error("Error fetching reminders:", error);
    } finally {
      setLoading(false);
    }
  };

  const filtered = reminders.filter((r) => {
    if (filter === "all") return true;
    return r.status === filter;
  });

  const getStatusBadge = (status: string) => {
    const styles = {
      pending: "bg-blue-100 text-blue-800",
      sent: "bg-green-100 text-green-800",
      failed: "bg-red-100 text-red-800",
    };
    const labels = {
      pending: "Bekleniyor",
      sent: "Gönderildi",
      failed: "Başarısız",
    };
    return (
      <span className={`px-3 py-1 rounded text-sm font-semibold ${styles[status as keyof typeof styles]}`}>
        {labels[status as keyof typeof labels]}
      </span>
    );
  };

  const getReminderTypeBadge = (type: string) => {
    const icons = {
      sms: "📱 SMS",
      email: "📧 Email",
      in_app: "🔔 In-App",
    };
    return icons[type as keyof typeof icons] || type;
  };

  const formatDateTime = (dateString: string) => {
    return new Date(dateString).toLocaleString("tr-TR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  if (loading) {
    return <div className="p-8">Yükleniyor...</div>;
  }

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">Randevu Hatırlatmaları</h1>

      {/* Statistics */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="text-gray-500 text-sm mb-2">Toplam</div>
          <div className="text-3xl font-bold text-gray-800">{stats.total}</div>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="text-blue-500 text-sm mb-2">Bekleniyor</div>
          <div className="text-3xl font-bold text-blue-600">{stats.pending}</div>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="text-green-500 text-sm mb-2">Gönderildi</div>
          <div className="text-3xl font-bold text-green-600">{stats.sent}</div>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="text-red-500 text-sm mb-2">Başarısız</div>
          <div className="text-3xl font-bold text-red-600">{stats.failed}</div>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-6 flex gap-2">
        {(["all", "pending", "sent", "failed"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded font-semibold ${
              filter === f
                ? "bg-blue-600 text-white"
                : "bg-gray-200 text-gray-800 hover:bg-gray-300"
            }`}
          >
            {f === "all"
              ? "Tümü"
              : f === "pending"
              ? "Bekleniyor"
              : f === "sent"
              ? "Gönderildi"
              : "Başarısız"}
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
                Gönderme Zamanı
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Durum
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-8 text-center text-gray-500">
                  Hatırlatma bulunamadı
                </td>
              </tr>
            ) : (
              filtered.map((reminder) => (
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
                    {getStatusBadge(reminder.status)}
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
