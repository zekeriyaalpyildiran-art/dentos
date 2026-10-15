"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";
import { InlineMessage } from "@/components/staff/Modal";
import { PatientArchiveDialog } from "./_components/PatientArchiveDialog";

interface Patient {
  id: string;
  full_name: string;
  phone: string;
  email?: string;
  gender?: string;
  kvkk_consent: boolean;
  created_at: string;
}

type View = "active" | "archive";

interface Message {
  type: "success" | "error";
  text: string;
}

export default function Page() {
  const { user } = useAuthStore();
  const [patients, setPatients] = useState<Patient[]>([]);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<View>("active");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [dialog, setDialog] = useState<{ patient: Patient; mode: "archive" | "restore" } | null>(null);
  const supabase = useMemo(() => createClient(), []);

  useEffect(() => {
    if (!user?.clinic_id) return;
    const clinicId = user.clinic_id;
    let cancelled = false;

    const fetchPatients = async () => {
      setLoading(true);
      setLoadFailed(false);
      try {
        let query = supabase.from("patients").select("*").eq("clinic_id", clinicId);
        // NULL counts as active (spec p10 §1.4).
        query = view === "archive" ? query.eq("is_active", false) : query.or("is_active.is.null,is_active.eq.true");
        const { data, error } = await query.order("created_at", { ascending: false });
        if (error) throw error;
        if (!cancelled) setPatients(data || []);
      } catch (err) {
        console.error("Error fetching patients:", err);
        if (!cancelled) {
          setPatients([]);
          setLoadFailed(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchPatients();
    return () => {
      cancelled = true;
    };
  }, [supabase, user?.clinic_id, view]);

  const canArchive = user?.role === "owner" || user?.role === "admin";

  const searchTerm = search.toLocaleLowerCase("tr-TR");
  const filtered = patients.filter(
    (p) => (p.full_name ?? "").toLocaleLowerCase("tr-TR").includes(searchTerm) || (p.phone ?? "").includes(search)
  );

  const tabClass = (v: View) =>
    `px-4 py-2 min-h-[44px] text-sm font-medium ${
      view === v ? "bg-blue-600 text-white" : "bg-white text-gray-700 hover:bg-gray-50"
    }`;

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Hastalar</h1>
        <Link href="/patients/new" className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
          + Yeni Hasta
        </Link>
      </div>

      <div className="inline-flex rounded border border-gray-300 overflow-hidden mb-4" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={view === "active"}
          className={tabClass("active")}
          onClick={() => {
            setMessage(null);
            setView("active");
          }}
        >
          Aktif hastalar
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "archive"}
          className={`${tabClass("archive")} border-l border-gray-300`}
          onClick={() => {
            setMessage(null);
            setView("archive");
          }}
        >
          Arşiv
        </button>
      </div>

      {message && (
        <div className="mb-4">
          <InlineMessage tone={message.type} onClose={() => setMessage(null)}>
            {message.text}
          </InlineMessage>
        </div>
      )}

      <input
        placeholder="Ad, telefon ara..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full px-4 py-2 border rounded mb-6"
      />

      {loading ? (
        <div className="py-4">Yükleniyor...</div>
      ) : loadFailed ? (
        <div className="bg-white rounded-lg shadow p-6 text-red-600">
          Hastalar yüklenemedi. Lütfen sayfayı yenileyin.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-100">
                <tr>
                  <th className="px-4 py-2 text-left">Ad Soyad</th>
                  <th className="px-4 py-2 text-left">Telefon</th>
                  <th className="px-4 py-2 text-left">E-posta</th>
                  <th className="px-4 py-2 text-left">KVKK</th>
                  <th className="px-4 py-2 text-left">İşlemler</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                      {view === "archive" ? "Arşivde hasta yok" : "Hasta bulunamadı"}
                    </td>
                  </tr>
                ) : (
                  filtered.map((p) => (
                    <tr key={p.id} className="border-b hover:bg-gray-50">
                      <td className="px-4 py-2">
                        <Link href={`/patients/${p.id}`} className="text-blue-600 hover:underline">
                          {p.full_name}
                        </Link>
                      </td>
                      <td className="px-4 py-2">{p.phone}</td>
                      <td className="px-4 py-2">{p.email || "-"}</td>
                      <td className="px-4 py-2">
                        <span className={p.kvkk_consent ? "text-green-600" : "text-red-600"}>
                          {p.kvkk_consent ? "✓" : "✗"}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        {view === "active" && (
                          <Link href={`/patients/${p.id}/edit`} className="text-blue-600 hover:underline mr-3">
                            Düzenle
                          </Link>
                        )}
                        {canArchive && view === "active" && (
                          <button
                            type="button"
                            onClick={() => {
                              setMessage(null);
                              setDialog({ patient: p, mode: "archive" });
                            }}
                            className="text-red-600 hover:underline"
                          >
                            Arşivle
                          </button>
                        )}
                        {canArchive && view === "archive" && (
                          <button
                            type="button"
                            onClick={() => {
                              setMessage(null);
                              setDialog({ patient: p, mode: "restore" });
                            }}
                            className="text-blue-600 hover:underline"
                          >
                            Arşivden çıkar
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-4 text-sm text-gray-600">
            Toplam: {filtered.length} hasta{view === "archive" ? " (arşiv)" : ""}
          </div>
        </>
      )}

      {dialog && (
        <PatientArchiveDialog
          patient={dialog.patient}
          mode={dialog.mode}
          onClose={() => setDialog(null)}
          onDone={(text) => {
            const id = dialog.patient.id;
            setDialog(null);
            setPatients((prev) => prev.filter((x) => x.id !== id));
            setMessage({ type: "success", text });
          }}
        />
      )}
    </div>
  );
}
