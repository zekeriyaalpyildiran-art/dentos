"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";
import { patientSearchFilter } from "@/lib/patients/search";
import { InlineMessage } from "@/components/staff/Modal";
import { PatientArchiveDialog } from "./_components/PatientArchiveDialog";

interface Patient {
  id: string;
  full_name: string;
  phone: string;
  email?: string;
  kvkk_consent: boolean;
  created_at: string;
}

type View = "active" | "archive";

interface Message {
  type: "success" | "error";
  text: string;
}

// Search and paging run on the server: PostgREST answers at most 1000 rows, so a browser-side filter over "all"
// patients silently missed everyone beyond the first 1000.
const PAGE_SIZE = 50;

export default function Page() {
  const { user } = useAuthStore();
  const [patients, setPatients] = useState<Patient[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [view, setView] = useState<View>("active");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [dialog, setDialog] = useState<{ patient: Patient; mode: "archive" | "restore" } | null>(null);
  const supabase = useMemo(() => createClient(), []);
  const requestId = useRef(0);

  // The search box is applied 300 ms after the last keystroke, from the first page.
  useEffect(() => {
    const t = setTimeout(() => {
      setTerm(search);
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!user?.clinic_id) return;
    const clinicId = user.clinic_id;
    const req = ++requestId.current;

    const fetchPatients = async () => {
      setLoading(true);
      setLoadFailed(false);
      try {
        let query = supabase
          .from("patients")
          .select("id,full_name,phone,email,kvkk_consent,created_at", { count: "exact" })
          .eq("clinic_id", clinicId);
        // NULL counts as active (spec p10 §1.4).
        query = view === "archive" ? query.eq("is_active", false) : query.not("is_active", "is", false);
        const filter = patientSearchFilter(term);
        if (filter) query = query.or(filter);
        const from = page * PAGE_SIZE;
        const { data, error, count } = await query
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        if (req !== requestId.current) return;
        setPatients((data || []) as Patient[]);
        setTotal(count ?? 0);
      } catch (err) {
        console.error("Error fetching patients:", err);
        if (req === requestId.current) {
          setPatients([]);
          setTotal(0);
          setLoadFailed(true);
        }
      } finally {
        if (req === requestId.current) setLoading(false);
      }
    };

    fetchPatients();
  }, [supabase, user?.clinic_id, view, term, page]);

  const canArchive = user?.role === "owner" || user?.role === "admin";
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstShown = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const lastShown = page * PAGE_SIZE + patients.length;

  const tabClass = (v: View) =>
    `px-4 py-2 min-h-[44px] text-sm font-medium ${
      view === v ? "bg-blue-600 text-white" : "bg-white text-gray-700 hover:bg-gray-50"
    }`;

  const switchView = (v: View) => {
    setMessage(null);
    setView(v);
    setPage(0);
  };

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
          onClick={() => switchView("active")}
        >
          Aktif hastalar
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "archive"}
          className={`${tabClass("archive")} border-l border-gray-300`}
          onClick={() => switchView("archive")}
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
        aria-label="Hasta ara"
      />

      {loading && patients.length === 0 ? (
        <div className="py-4">Yükleniyor...</div>
      ) : loadFailed ? (
        <div className="bg-white rounded-lg shadow p-6 text-red-600">
          Hastalar yüklenemedi. Lütfen sayfayı yenileyin.
        </div>
      ) : (
        <>
          <div className={`overflow-x-auto ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
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
                {patients.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                      {view === "archive" ? "Arşivde hasta yok" : "Hasta bulunamadı"}
                    </td>
                  </tr>
                ) : (
                  patients.map((p) => (
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

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-gray-600">
            <span>
              Toplam: {total} hasta{view === "archive" ? " (arşiv)" : ""}
              {total > 0 && ` · ${firstShown}–${lastShown} arası gösteriliyor`}
            </span>
            {pageCount > 1 && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0 || loading}
                  className="px-3 py-2 min-h-[44px] rounded bg-gray-200 text-gray-800 hover:bg-gray-300 disabled:opacity-50"
                >
                  ← Önceki
                </button>
                <span>
                  Sayfa {page + 1} / {pageCount}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={page >= pageCount - 1 || loading}
                  className="px-3 py-2 min-h-[44px] rounded bg-gray-200 text-gray-800 hover:bg-gray-300 disabled:opacity-50"
                >
                  Sonraki →
                </button>
              </div>
            )}
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
            setTotal((prev) => Math.max(0, prev - 1));
            setMessage({ type: "success", text });
          }}
        />
      )}
    </div>
  );
}
