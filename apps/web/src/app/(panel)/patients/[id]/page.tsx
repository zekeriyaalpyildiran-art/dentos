"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";
import { useParams } from "next/navigation";
import { toFinanceError, type FinanceError } from "@/lib/finance";
import {
  amountToCents,
  asCurrency,
  formatMoney,
  ppPatientAccount,
  type Currency,
  type PatientAccountJson,
} from "@/lib/payments";
import { PatientAccountTab } from "../_components/PatientAccountTab";

const GENDER_LABELS: Record<string, string> = {
  male: "Erkek",
  female: "Kadın",
  other: "Diğer",
};

const APPOINTMENT_STATUS_LABELS: Record<string, string> = {
  scheduled: "Planlı",
  completed: "Tamamlandı",
  cancelled: "İptal",
  no_show: "Gelmedi",
};

const APPOINTMENT_STATUS_STYLES: Record<string, string> = {
  scheduled: "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
  no_show: "bg-yellow-100 text-yellow-800",
};

const PLAN_STATUS_LABELS: Record<string, string> = {
  draft: "Taslak",
  proposed: "Önerilen",
  approved: "Onaylı",
  in_progress: "Devam Ediyor",
  completed: "Tamamlandı",
  cancelled: "İptal",
};

const PLAN_STATUS_STYLES: Record<string, string> = {
  draft: "bg-gray-100 text-gray-800",
  proposed: "bg-blue-100 text-blue-800",
  approved: "bg-green-100 text-green-800",
  in_progress: "bg-yellow-100 text-yellow-800",
  completed: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
};

const CHANNEL_LABELS: Record<string, string> = {
  sms: "SMS",
  email: "E-posta",
  in_app: "Uygulama İçi",
};

const MESSAGE_STATUS_LABELS: Record<string, string> = {
  pending: "Bekleniyor",
  sent: "Gönderildi",
  failed: "Başarısız",
};

const MESSAGE_STATUS_STYLES: Record<string, string> = {
  pending: "bg-blue-100 text-blue-800",
  sent: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

const TABS = [
  { key: "overview", label: "Özet" },
  { key: "appointments", label: "Randevular" },
  { key: "treatment-plan", label: "Tedavi Planları" },
  { key: "account", label: "Hesap" },
  { key: "messages", label: "Mesajlar" },
] as const;

type Tab = (typeof TABS)[number]["key"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isTab = (value: string | null): value is Tab => TABS.some((t) => t.key === value);

interface Patient {
  id: string;
  full_name: string;
  phone: string;
  email?: string;
  gender?: string;
  birth_date?: string;
  address?: string;
  kvkk_consent: boolean;
  notes?: string;
  created_at: string;
}

interface Appointment {
  id: string;
  start_time: string;
  end_time: string;
  status: string;
  notes?: string | null;
  doctors: { specialty: string | null; users: { full_name: string } | null } | null;
  procedures_catalog: { name: string } | null;
}

interface TreatmentPlan {
  id: string;
  title: string;
  status: string;
  total_cost: number;
  currency: Currency;
  created_at: string;
}

interface Message {
  id: string;
  created_at: string;
  notification_type: string;
  recipient: string;
  message: string | null;
  status: string;
}

export default function Page() {
  const params = useParams();
  const patientId = params.id as string;
  const { user } = useAuthStore();

  const [patient, setPatient] = useState<Patient | null>(null);
  const [patientError, setPatientError] = useState(false);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [plans, setPlans] = useState<TreatmentPlan[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadErrors, setLoadErrors] = useState({ appointments: false, plans: false, messages: false });
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [loading, setLoading] = useState(true);
  // Payment figures come only from pp_patient_account (loaded when the plans or Hesap tab is first opened).
  const [account, setAccount] = useState<PatientAccountJson | null>(null);
  const [accountError, setAccountError] = useState<FinanceError | null>(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const [includeVoided, setIncludeVoided] = useState(false);
  const [accountWanted, setAccountWanted] = useState(false);
  const accountReq = useRef(0);

  // ?tab=account (link from Finans > Teklifler ve tahsilat); read directly so no Suspense boundary is needed.
  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get("tab");
    if (isTab(tab)) setActiveTab(tab);
  }, []);

  useEffect(() => {
    if (activeTab === "account" || activeTab === "treatment-plan") setAccountWanted(true);
  }, [activeTab]);

  const loadAccount = useCallback(async () => {
    if (!patientId || !UUID_RE.test(patientId)) return;
    const req = ++accountReq.current;
    setAccountLoading(true);
    try {
      const acc = await ppPatientAccount(patientId, includeVoided);
      if (req !== accountReq.current) return;
      setAccount(acc);
      setAccountError(null);
    } catch (err) {
      if (req === accountReq.current) setAccountError(toFinanceError(err));
    } finally {
      if (req === accountReq.current) setAccountLoading(false);
    }
  }, [patientId, includeVoided]);

  useEffect(() => {
    if (accountWanted && user?.clinic_id) void loadAccount();
  }, [accountWanted, loadAccount, user?.clinic_id]);

  useEffect(() => {
    const clinicId = user?.clinic_id;
    if (!clinicId || !patientId) return;

    // Non-uuid ids would be rejected by Postgres; treat them as a missing patient.
    if (!UUID_RE.test(patientId)) {
      setLoading(false);
      return;
    }

    const supabase = createClient();
    const fetchData = async () => {
      setLoading(true);
      try {
        const [ptRes, aptRes, planRes, msgRes] = await Promise.all([
          supabase.from("patients").select("*").eq("id", patientId).eq("clinic_id", clinicId).maybeSingle(),
          supabase
            .from("appointments")
            .select("id,start_time,end_time,status,notes,doctors(specialty,users(full_name)),procedures_catalog(name)")
            .eq("patient_id", patientId)
            .eq("clinic_id", clinicId)
            .order("start_time", { ascending: false }),
          supabase
            .from("treatment_plans")
            .select("id,title,status,total_cost,currency,created_at")
            .eq("patient_id", patientId)
            .eq("clinic_id", clinicId)
            .order("created_at", { ascending: false }),
          supabase
            .from("notifications")
            .select("id,created_at,notification_type,recipient,message,status")
            .eq("patient_id", patientId)
            .eq("clinic_id", clinicId)
            .order("created_at", { ascending: false })
            .limit(100),
        ]);

        if (ptRes.error) console.error("Error fetching patient:", ptRes.error);
        if (aptRes.error) console.error("Error fetching appointments:", aptRes.error);
        if (planRes.error) console.error("Error fetching treatment plans:", planRes.error);
        if (msgRes.error) console.error("Error fetching messages:", msgRes.error);

        setPatientError(!!ptRes.error);
        setPatient(ptRes.data);
        // doctors/procedures_catalog are many-to-one, so each arrives as one object that the inferred type does not reflect.
        setAppointments((aptRes.data || []) as unknown as Appointment[]);

        setPlans(
          (planRes.data || []).map((p) => ({
            id: p.id,
            title: p.title,
            status: p.status,
            total_cost: Number(p.total_cost),
            currency: asCurrency((p as { currency?: unknown }).currency),
            created_at: p.created_at,
          }))
        );
        setMessages(msgRes.data || []);

        setLoadErrors({
          appointments: !!aptRes.error,
          plans: !!planRes.error,
          messages: !!msgRes.error,
        });
      } catch (err) {
        console.error("Error loading patient file:", err);
        setPatientError(true);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [user?.clinic_id, patientId]);

  if (loading) return <div className="p-8">Yükleniyor...</div>;
  if (!patient) {
    return (
      <div className="p-8">
        <p className={patientError ? "text-red-600" : "text-gray-700"}>
          {patientError ? "Hasta bilgileri yüklenemedi. Lütfen sayfayı yenileyin." : "Hasta bulunamadı"}
        </p>
        <Link href="/patients" className="inline-block mt-4 text-blue-600 hover:underline">
          ← Hasta listesine dön
        </Link>
      </div>
    );
  }

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex justify-between items-start mb-8">
        <div>
          <h1 className="text-3xl font-bold">{patient.full_name}</h1>
          <p className="text-gray-600">{patient.phone}</p>
        </div>
        <Link
          href={`/patients/${patient.id}/edit`}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Düzenle
        </Link>
      </div>

      {/* Patient Info Card */}
      <div className="grid grid-cols-2 gap-4 mb-8 bg-gray-50 p-4 rounded">
        <div>
          <div className="text-sm text-gray-600">E-posta</div>
          <div className="font-semibold">{patient.email || "-"}</div>
        </div>
        <div>
          <div className="text-sm text-gray-600">Cinsiyet</div>
          <div className="font-semibold">{(patient.gender && GENDER_LABELS[patient.gender]) || "-"}</div>
        </div>
        <div>
          <div className="text-sm text-gray-600">Doğum Tarihi</div>
          <div className="font-semibold">{patient.birth_date || "-"}</div>
        </div>
        <div>
          <div className="text-sm text-gray-600">KVKK Rızası</div>
          <div className={`font-semibold ${patient.kvkk_consent ? "text-green-700" : "text-red-600"}`}>
            {patient.kvkk_consent ? "✓ Var" : "✗ Yok"}
          </div>
        </div>
        <div className="col-span-2">
          <div className="text-sm text-gray-600">Adres</div>
          <div className="font-semibold">{patient.address || "-"}</div>
        </div>
        <div className="col-span-2">
          <div className="text-sm text-gray-600">Notlar</div>
          <div className="font-semibold">{patient.notes || "-"}</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b mb-6">
        <div className="flex gap-4">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 border-b-2 ${
                activeTab === tab.key ? "border-blue-600 text-blue-600 font-semibold" : "border-transparent text-gray-600"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === "overview" && (
        <div>
          <h2 className="text-xl font-semibold mb-4">Hızlı Özet</h2>
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-blue-50 p-4 rounded">
              <div className="text-sm text-gray-600">Toplam Randevu</div>
              <div className="text-2xl font-bold">{appointments.length}</div>
            </div>
            <div className="bg-green-50 p-4 rounded">
              <div className="text-sm text-gray-600">Tamamlanan</div>
              <div className="text-2xl font-bold">{appointments.filter((a) => a.status === "completed").length}</div>
            </div>
            <div className="bg-yellow-50 p-4 rounded">
              <div className="text-sm text-gray-600">Planlı</div>
              <div className="text-2xl font-bold">{appointments.filter((a) => a.status === "scheduled").length}</div>
            </div>
          </div>
        </div>
      )}

      {activeTab === "appointments" && (
        <div>
          <h2 className="text-xl font-semibold mb-4">Randevu Geçmişi</h2>
          {loadErrors.appointments ? (
            <p className="text-red-600">Randevular yüklenemedi. Lütfen sayfayı yenileyin.</p>
          ) : appointments.length === 0 ? (
            <p className="text-gray-500">Randevu bulunamadı</p>
          ) : (
            <div className="space-y-3">
              {appointments.map((apt) => (
                <div key={apt.id} className="p-4 border rounded hover:bg-gray-50">
                  <div className="flex justify-between">
                    <div>
                      <div className="font-semibold">{new Date(apt.start_time).toLocaleString("tr-TR")}</div>
                      <div className="text-sm text-gray-600">
                        Hekim: {apt.doctors?.users?.full_name || apt.doctors?.specialty || "-"} · Tedavi:{" "}
                        {apt.procedures_catalog?.name || "-"}
                      </div>
                      {apt.notes && <div className="text-sm text-gray-500">{apt.notes}</div>}
                    </div>
                    <span
                      className={`px-3 py-1 rounded text-sm self-start ${
                        APPOINTMENT_STATUS_STYLES[apt.status] ?? "bg-gray-100 text-gray-800"
                      }`}
                    >
                      {APPOINTMENT_STATUS_LABELS[apt.status] ?? apt.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "treatment-plan" && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold">Tedavi Planları</h2>
            <Link
              href={`/treatment-plans/new?patient_id=${patientId}`}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              + Yeni Tedavi Planı
            </Link>
          </div>
          <div className="bg-white rounded-lg shadow overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-100 border-b">
                <tr>
                  {["Plan", "Durum", "Tutar", "Tahsil edilen", "Oluşturulma", ""].map((h, i) => (
                    <th key={i} className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loadErrors.plans || plans.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className={`px-6 py-8 text-center ${loadErrors.plans ? "text-red-600" : "text-gray-500"}`}
                    >
                      {loadErrors.plans
                        ? "Tedavi planları yüklenemedi. Lütfen sayfayı yenileyin."
                        : "Tedavi planı bulunamadı"}
                    </td>
                  </tr>
                ) : (
                  plans.map((plan) => (
                    <tr key={plan.id} className="border-b hover:bg-gray-50">
                      <td className="px-6 py-4 text-sm text-gray-800 font-semibold">
                        <Link href={`/treatment-plans/${plan.id}`} className="hover:underline">
                          {plan.title}
                        </Link>
                      </td>
                      <td className="px-6 py-4 text-sm">
                        <span
                          className={`px-3 py-1 rounded text-sm font-semibold ${
                            PLAN_STATUS_STYLES[plan.status] ?? PLAN_STATUS_STYLES.draft
                          }`}
                        >
                          {PLAN_STATUS_LABELS[plan.status] ?? plan.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-800 font-semibold">
                        {formatMoney(amountToCents(plan.total_cost), plan.currency)}
                      </td>
                      <td className="px-6 py-4 text-sm text-green-700 font-semibold">
                        {(() => {
                          const applied = account?.plans.find((a) => a.id === plan.id)?.applied_cents;
                          if (applied !== undefined) return formatMoney(applied, plan.currency);
                          return accountLoading ? "…" : "—";
                        })()}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-600">
                        {new Date(plan.created_at).toLocaleDateString("tr-TR")}
                      </td>
                      <td className="px-6 py-4 text-sm">
                        <Link href={`/treatment-plans/${plan.id}`} className="text-blue-600 hover:underline">
                          Detay
                        </Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === "account" && (
        <PatientAccountTab
          account={account}
          loading={accountLoading}
          error={accountError}
          includeVoided={includeVoided}
          onIncludeVoided={setIncludeVoided}
          onReload={() => void loadAccount()}
        />
      )}

      {activeTab === "messages" && (
        <div>
          <h2 className="text-xl font-semibold mb-4">Mesajlar</h2>
          <div className="bg-white rounded-lg shadow overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-100 border-b">
                <tr>
                  {["Tarih", "Kanal", "Alıcı", "Mesaj", "Durum"].map((h) => (
                    <th key={h} className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loadErrors.messages || messages.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className={`px-6 py-8 text-center ${loadErrors.messages ? "text-red-600" : "text-gray-500"}`}
                    >
                      {loadErrors.messages ? "Mesajlar yüklenemedi. Lütfen sayfayı yenileyin." : "Mesaj bulunamadı"}
                    </td>
                  </tr>
                ) : (
                  messages.map((m) => (
                    <tr key={m.id} className="border-b hover:bg-gray-50">
                      <td className="px-6 py-4 text-sm text-gray-600 whitespace-nowrap">
                        {new Date(m.created_at).toLocaleString("tr-TR")}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-600">
                        {CHANNEL_LABELS[m.notification_type] ?? m.notification_type}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-600">{m.recipient}</td>
                      <td className="px-6 py-4 text-sm text-gray-600 whitespace-pre-wrap">{m.message || "-"}</td>
                      <td className="px-6 py-4 text-sm">
                        <span
                          className={`px-3 py-1 rounded text-sm font-semibold ${
                            MESSAGE_STATUS_STYLES[m.status] ?? "bg-gray-100 text-gray-800"
                          }`}
                        >
                          {MESSAGE_STATUS_LABELS[m.status] ?? m.status}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
