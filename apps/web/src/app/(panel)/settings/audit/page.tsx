"use client";

// Değişiklik geçmişi (spec p10_platform §5.4). Read-only. Rows are read from audit_logs with the caller's own login,
// so RLS decides what is visible (finance, CRM ad spend, stock / lab costs stay gated). No restore from here.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";
import {
  ACTION_LABELS,
  AUDIT_SELECT,
  DEFAULT_PAGE_SIZE,
  ENTITY_GROUPS,
  ENTITY_LABELS,
  MAX_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  clampPageSize,
  istanbulDayRange,
  keysetFilter,
  mergeAuditRows,
  shortId,
  type AuditNameContext,
  type AuditRow,
} from "@/lib/audit";
import { AuditRowView } from "@/components/audit/AuditRowView";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SYSTEM = "system";
const LOOKUP_CHUNK = 200;

const inputClass = "w-full px-3 py-2 min-h-[44px] border rounded bg-white text-base text-gray-900";

interface Filters {
  entity_type: string;
  action: string;
  user_id: string;
  from: string;
  to: string;
  entity_id: string;
  size: number;
}

interface StaffRef {
  id: string;
  full_name: string;
  is_active: boolean | null;
}

function readFilters(params: URLSearchParams): Filters {
  const get = (k: string) => params.get(k) ?? "";
  const user = get("user_id");
  const entityId = get("entity_id");
  return {
    entity_type: /^[a-z_]{1,64}$/.test(get("entity_type")) ? get("entity_type") : "",
    action: /^[a-z_]{1,32}$/.test(get("action")) ? get("action") : "",
    user_id: user === SYSTEM || UUID_RE.test(user) ? user : "",
    from: DAY_RE.test(get("from")) ? get("from") : "",
    to: DAY_RE.test(get("to")) ? get("to") : "",
    entity_id: UUID_RE.test(entityId) ? entityId : "",
    size: params.get("size") ? clampPageSize(params.get("size")) : DEFAULT_PAGE_SIZE,
  };
}

function toQuery(f: Filters): string {
  const q = new URLSearchParams();
  if (f.entity_type) q.set("entity_type", f.entity_type);
  if (f.action) q.set("action", f.action);
  if (f.user_id) q.set("user_id", f.user_id);
  if (f.from) q.set("from", f.from);
  if (f.to) q.set("to", f.to);
  if (f.entity_id) q.set("entity_id", f.entity_id);
  if (f.size !== DEFAULT_PAGE_SIZE) q.set("size", String(f.size));
  return q.toString();
}

function chunks<T>(items: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** Ids inside the rows that need a name: patients and doctors. */
function collectIds(rows: AuditRow[]): { patients: Set<string>; doctors: Set<string> } {
  const patients = new Set<string>();
  const doctors = new Set<string>();
  const scan = (obj: unknown) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
    const o = obj as Record<string, unknown>;
    if (typeof o.patient_id === "string" && UUID_RE.test(o.patient_id)) patients.add(o.patient_id);
    if (typeof o.doctor_id === "string" && UUID_RE.test(o.doctor_id)) doctors.add(o.doctor_id);
  };
  for (const r of rows) {
    if (r.entity_type === "patients") patients.add(r.entity_id);
    if (r.entity_type === "doctors") doctors.add(r.entity_id);
    scan(r.before_data);
    scan(r.after_data);
    scan(r.changes);
  }
  return { patients, doctors };
}

function AuditPage() {
  const user = useAuthStore((s) => s.user);
  const clinicId = user?.clinic_id ?? null;
  const db = useMemo(() => createClient(), []);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const paramString = params.toString();
  const filters = useMemo(() => readFilters(new URLSearchParams(paramString)), [paramString]);

  const [staff, setStaff] = useState<StaffRef[]>([]);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  // Spec §5.4: at most MAX_PAGE_SIZE (1000) rows in total; older rows are reached through the date filter.
  const [capped, setCapped] = useState(false);
  const [failed, setFailed] = useState(false);
  const [patientNames, setPatientNames] = useState<Record<string, string>>({});
  const [doctorNames, setDoctorNames] = useState<Record<string, string>>({});
  const requestRef = useRef(0);
  const knownPatients = useRef(new Set<string>());
  const knownDoctors = useRef(new Set<string>());

  const userNames = useMemo(() => Object.fromEntries(staff.map((s) => [s.id, s.full_name])), [staff]);

  const setFilters = (patch: Partial<Filters>) => {
    const qs = toQuery({ ...filters, ...patch });
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // Clinic users (active and inactive) for the "Kişi" filter and actor names.
  useEffect(() => {
    if (!clinicId) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await db
        .from("users")
        .select("id, full_name, is_active")
        .eq("clinic_id", clinicId);
      if (cancelled) return;
      if (error) {
        console.error("Error fetching users for audit:", error);
        return;
      }
      const list = ((data ?? []) as StaffRef[]).slice();
      list.sort((a, b) => a.full_name.localeCompare(b.full_name, "tr-TR"));
      setStaff(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [db, clinicId]);

  const resolveNames = useCallback(
    async (list: AuditRow[]) => {
      const { patients, doctors } = collectIds(list);
      const newPatients = Array.from(patients).filter((id) => !knownPatients.current.has(id));
      const newDoctors = Array.from(doctors).filter((id) => !knownDoctors.current.has(id));
      newPatients.forEach((id) => knownPatients.current.add(id));
      newDoctors.forEach((id) => knownDoctors.current.add(id));

      for (const part of chunks(newPatients, LOOKUP_CHUNK)) {
        const { data, error } = await db.from("patients").select("id, full_name").in("id", part);
        if (error || !data) continue;
        const map: Record<string, string> = {};
        for (const p of data as { id: string; full_name: string }[]) map[p.id] = p.full_name;
        setPatientNames((prev) => ({ ...prev, ...map }));
      }
      for (const part of chunks(newDoctors, LOOKUP_CHUNK)) {
        const { data, error } = await db.from("doctors").select("id, users(full_name)").in("id", part);
        if (error || !data) continue;
        const map: Record<string, string> = {};
        for (const d of data as unknown as { id: string; users: { full_name: string } | { full_name: string }[] | null }[]) {
          const u = Array.isArray(d.users) ? d.users[0] : d.users;
          if (u?.full_name) map[d.id] = u.full_name;
        }
        setDoctorNames((prev) => ({ ...prev, ...map }));
      }
    },
    [db]
  );

  const fetchPage = useCallback(
    async (cursor: AuditRow | null, limit?: number): Promise<AuditRow[]> => {
      if (!clinicId) return [];
      const size = clampPageSize(limit ?? filters.size);
      let q = db.from("audit_logs").select(AUDIT_SELECT).eq("clinic_id", clinicId);
      if (filters.entity_type) q = q.eq("entity_type", filters.entity_type);
      if (filters.entity_id) q = q.eq("entity_id", filters.entity_id);
      if (filters.action) q = q.eq("action", filters.action);
      if (filters.user_id === SYSTEM) q = q.is("user_id", null);
      else if (filters.user_id) q = q.eq("user_id", filters.user_id);
      const range = istanbulDayRange(filters.from, filters.to);
      if (range.gte) q = q.gte("created_at", range.gte);
      if (range.lt) q = q.lt("created_at", range.lt);
      if (cursor) q = q.or(keysetFilter(cursor));
      const { data, error } = await q
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(size);
      if (error) throw error;
      return (data ?? []) as unknown as AuditRow[];
    },
    [db, clinicId, filters]
  );

  useEffect(() => {
    if (!clinicId) return;
    const req = ++requestRef.current;
    setLoading(true);
    setFailed(false);
    setCapped(false);
    (async () => {
      try {
        const size = clampPageSize(filters.size);
        const page = await fetchPage(null, size);
        if (req !== requestRef.current) return;
        setRows(page);
        setHasMore(page.length === size && page.length < MAX_PAGE_SIZE);
        setCapped(page.length === size && page.length >= MAX_PAGE_SIZE);
        void resolveNames(page);
      } catch (err) {
        console.error("Error fetching audit logs:", err);
        if (req === requestRef.current) {
          setRows([]);
          setHasMore(false);
          setCapped(false);
          setFailed(true);
        }
      } finally {
        if (req === requestRef.current) setLoading(false);
      }
    })();
  }, [clinicId, fetchPage, filters.size, resolveNames]);

  const loadMore = async () => {
    const last = rows[rows.length - 1];
    if (!last || loadingMore) return;
    const room = MAX_PAGE_SIZE - rows.length;
    if (room <= 0) {
      setHasMore(false);
      setCapped(true);
      return;
    }
    const want = Math.min(clampPageSize(filters.size), room);
    const req = requestRef.current;
    setLoadingMore(true);
    try {
      const page = await fetchPage(last, want);
      if (req !== requestRef.current) return;
      const total = mergeAuditRows(rows, page).length;
      setRows((prev) => mergeAuditRows(prev, page));
      const full = page.length === want;
      setHasMore(full && total < MAX_PAGE_SIZE);
      setCapped(full && total >= MAX_PAGE_SIZE);
      void resolveNames(page);
    } catch (err) {
      console.error("Error fetching more audit logs:", err);
      if (req === requestRef.current) setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const ctx: AuditNameContext = { users: userNames, patients: patientNames, doctors: doctorNames };

  const actorName = (id: string | null) =>
    id === null ? "Sistem / otomatik" : userNames[id] ?? (staff.length > 0 ? "Silinmiş kullanıcı" : shortId(id));

  const recordLabel = (type: string, id: string) => {
    const name =
      type === "users" ? userNames[id] : type === "patients" ? patientNames[id] : type === "doctors" ? doctorNames[id] : undefined;
    return name ?? shortId(id);
  };

  const anyFilter =
    !!filters.entity_type || !!filters.action || !!filters.user_id || !!filters.from || !!filters.to || !!filters.entity_id;

  const knownEntity = !filters.entity_type || filters.entity_type in ENTITY_LABELS;
  const knownAction = !filters.action || filters.action in ACTION_LABELS;

  return (
    <div className="p-4 sm:p-8">
      <div className="mb-2 text-sm">
        <Link href="/settings" className="text-blue-700 hover:underline">
          ← Ayarlar
        </Link>
      </div>
      <h1 className="text-3xl font-bold mb-2">Değişiklik geçmişi</h1>
      <p className="text-sm text-gray-600 mb-6 max-w-3xl">
        Kayıtlar yalnız görüntülenir; buradan geri alma yapılmaz. Finans, maliyet ve ödeme kayıtları yalnız ilgili
        yetkiye sahip kişilere görünür.
      </p>

      <div className="bg-white rounded-lg shadow p-4 mb-6 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <label className="block">
            <span className="block text-sm font-semibold mb-1 text-gray-800">Kayıt türü</span>
            <select
              className={inputClass}
              value={filters.entity_type}
              onChange={(e) => setFilters({ entity_type: e.target.value, entity_id: "" })}
            >
              <option value="">Tümü</option>
              {!knownEntity && <option value={filters.entity_type}>{filters.entity_type}</option>}
              {ENTITY_GROUPS.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.types.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="block text-sm font-semibold mb-1 text-gray-800">İşlem</span>
            <select className={inputClass} value={filters.action} onChange={(e) => setFilters({ action: e.target.value })}>
              <option value="">Tümü</option>
              {!knownAction && <option value={filters.action}>{filters.action}</option>}
              {Object.entries(ACTION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="block text-sm font-semibold mb-1 text-gray-800">Kişi</span>
            <select className={inputClass} value={filters.user_id} onChange={(e) => setFilters({ user_id: e.target.value })}>
              <option value="">Tümü</option>
              <option value={SYSTEM}>Sistem / otomatik</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.full_name}
                  {s.is_active === false ? " (pasif)" : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="block text-sm font-semibold mb-1 text-gray-800">Başlangıç</span>
            <input
              type="date"
              className={inputClass}
              value={filters.from}
              max={filters.to || undefined}
              onChange={(e) => setFilters({ from: e.target.value })}
            />
          </label>

          <label className="block">
            <span className="block text-sm font-semibold mb-1 text-gray-800">Bitiş</span>
            <input
              type="date"
              className={inputClass}
              value={filters.to}
              min={filters.from || undefined}
              onChange={(e) => setFilters({ to: e.target.value })}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {filters.entity_id && (
            <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-50 text-blue-900 text-sm">
              Tek kayıt: {recordLabel(filters.entity_type, filters.entity_id)}
              <button
                type="button"
                className="text-blue-700 hover:text-blue-900"
                aria-label="Tek kayıt filtresini kaldır"
                onClick={() => setFilters({ entity_id: "" })}
              >
                ✕
              </button>
            </span>
          )}
          {anyFilter && (
            <button
              type="button"
              className="text-sm text-blue-700 hover:underline"
              onClick={() => router.replace(pathname, { scroll: false })}
            >
              Filtreleri temizle
            </button>
          )}
          <label className="ml-auto inline-flex items-center gap-2 text-sm text-gray-700">
            Sayfa başına
            <select
              className="px-2 py-1 border rounded bg-white"
              value={filters.size}
              onChange={(e) => setFilters({ size: clampPageSize(Number(e.target.value)) })}
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {loading ? (
        <p className="text-gray-500">Yükleniyor...</p>
      ) : failed && rows.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-6 text-red-600">Geçmiş yüklenemedi. Lütfen sayfayı yenileyin.</div>
      ) : rows.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-6 text-gray-600">Bu filtrelerle kayıt bulunamadı.</div>
      ) : (
        <>
          <div className="bg-white rounded-lg shadow overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-100 border-b">
                <tr>
                  <th className="px-3 py-2 text-left text-sm font-semibold text-gray-800">Zaman</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold text-gray-800">Kişi</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold text-gray-800">Kayıt türü</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold text-gray-800">Kayıt</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold text-gray-800">İşlem</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold text-gray-800">Özet</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <AuditRowView
                    key={r.id}
                    row={r}
                    ctx={ctx}
                    actorName={actorName(r.user_id)}
                    recordLabel={recordLabel(r.entity_type, r.entity_id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {failed && (
            <p className="mt-3 text-sm text-red-600">Geçmiş yüklenemedi. Lütfen sayfayı yenileyin.</p>
          )}
          <div className="mt-4 flex items-center gap-4">
            <span className="text-sm text-gray-600">
              {capped
                ? `İlk ${MAX_PAGE_SIZE} kayıt gösteriliyor; daha eski kayıtlar için tarih filtresini kullanın.`
                : `${rows.length} kayıt gösteriliyor`}
            </span>
            {hasMore && (
              <button
                type="button"
                className="px-4 py-2 min-h-[44px] border border-gray-300 text-gray-800 bg-white rounded hover:bg-gray-50 disabled:opacity-40"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? "Yükleniyor..." : "Daha fazla yükle"}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <ProtectedRoute allowedRoles={["owner", "admin"]}>
      <Suspense fallback={<p className="p-8 text-gray-500">Yükleniyor...</p>}>
        <AuditPage />
      </Suspense>
    </ProtectedRoute>
  );
}
