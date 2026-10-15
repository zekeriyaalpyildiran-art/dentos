"use client";

// İmplant takibi (spec p9_clinical §7.3): tiles, filters kept in the URL query, list with add / edit / void / restore.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import {
  NO_FLAGS,
  clinImplantList,
  listBrands,
  listDoctors,
  toClinicalError,
  type BrandRow,
  type ClinicalError,
  type ClinicalFlags,
  type DoctorRef,
  type ImplantCounts,
  type ImplantFilters,
  type ImplantJson,
} from "@/lib/clinical/rpc";
import { IMPLANT_STATUSES, IMPLANT_STATUS_LABELS, isImplantStatus, type ImplantStatus } from "@/lib/clinical/codes";
import { istanbulToday } from "@/lib/clinical/dates";
import { ImplantTable } from "@/components/clinical/ImplantTable";
import { useImplantDialogs } from "@/components/clinical/useImplantDialogs";
import {
  ClinicalNotice,
  EmptyState,
  ErrorBox,
  Loading,
  MoreButton,
  StatTile,
  clinInput,
  clinPrimary,
  clinSecondary,
} from "@/components/clinical/ui";

const PAGE_SIZE = 50;

interface UrlState {
  q: string;
  status: ImplantStatus[];
  control: boolean;
  month: boolean;
  doctor: string;
  brand: string;
  source: "" | "stock" | "external";
  deleted: "active" | "deleted" | "all";
}

const EMPTY_STATE: UrlState = {
  q: "",
  status: [],
  control: false,
  month: false,
  doctor: "",
  brand: "",
  source: "",
  deleted: "active",
};

function readUrl(): UrlState {
  if (typeof window === "undefined") return EMPTY_STATE;
  const p = new URLSearchParams(window.location.search);
  const source = p.get("source");
  const deleted = p.get("deleted");
  return {
    q: (p.get("q") ?? "").slice(0, 100),
    status: (p.get("status") ?? "").split(",").filter(isImplantStatus),
    control: p.get("control") === "1",
    month: p.get("month") === "1",
    doctor: p.get("doctor") ?? "",
    brand: p.get("brand") ?? "",
    source: source === "stock" || source === "external" ? source : "",
    deleted: deleted === "deleted" || deleted === "all" ? deleted : "active",
  };
}

function toQuery(s: UrlState): string {
  const p = new URLSearchParams();
  if (s.q) p.set("q", s.q);
  if (s.status.length) p.set("status", s.status.join(","));
  if (s.control) p.set("control", "1");
  if (s.month) p.set("month", "1");
  if (s.doctor) p.set("doctor", s.doctor);
  if (s.brand) p.set("brand", s.brand);
  if (s.source) p.set("source", s.source);
  if (s.deleted !== "active") p.set("deleted", s.deleted);
  const q = p.toString();
  return q ? `?${q}` : "";
}

function isFiltered(s: UrlState): boolean {
  return toQuery(s) !== "";
}

export default function ImplantsPage() {
  const router = useRouter();
  const user = useAuthStore((st) => st.user);
  const [state, setState] = useState<UrlState>(EMPTY_STATE);
  const [ready, setReady] = useState(false);
  const [search, setSearch] = useState("");

  const [rows, setRows] = useState<ImplantJson[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<ImplantCounts | null>(null);
  const [flags, setFlags] = useState<ClinicalFlags | null>(null);
  const [today, setToday] = useState(istanbulToday());
  const [loading, setLoading] = useState(true);
  const [moreBusy, setMoreBusy] = useState(false);
  const [error, setError] = useState<ClinicalError | null>(null);
  const req = useRef(0);

  const [doctors, setDoctors] = useState<DoctorRef[]>([]);
  const [brands, setBrands] = useState<BrandRow[]>([]);

  useEffect(() => {
    const s = readUrl();
    setState(s);
    setSearch(s.q);
    setReady(true);
    Promise.all([listDoctors(), listBrands()])
      .then(([d, b]) => {
        setDoctors(d);
        setBrands(b);
      })
      .catch(() => {
        // Filter options only; the list still works.
      });
  }, []);

  const update = useCallback(
    (patch: Partial<UrlState>) => {
      const next = { ...state, ...patch };
      setState(next);
      router.replace(`/clinical/implants${toQuery(next)}`, { scroll: false });
    },
    [router, state]
  );

  // Debounced search box → URL state.
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => {
      if (search.trim() !== state.q) update({ q: search.trim().slice(0, 100) });
    }, 300);
    return () => clearTimeout(t);
  }, [search, ready, state.q, update]);

  const filters = useMemo<ImplantFilters>(() => {
    const f: ImplantFilters = {};
    if (state.q) f.q = state.q;
    if (state.status.length) f.status = state.status;
    if (state.control) f.control_due = true;
    if (state.doctor) f.doctor_id = state.doctor;
    if (state.brand) f.brand_id = state.brand;
    if (state.source) f.stock_source = state.source;
    if (state.deleted !== "active") f.deleted = state.deleted;
    if (state.month) {
      f.placed_from = `${today.slice(0, 8)}01`;
      f.placed_to = today;
    }
    return f;
  }, [state, today]);

  const load = useCallback(async () => {
    const r = ++req.current;
    setLoading(true);
    try {
      const res = await clinImplantList(filters, { offset: 0, limit: PAGE_SIZE });
      if (r !== req.current) return;
      setRows(res.rows || []);
      setTotal(res.total ?? 0);
      setCounts(res.counts ?? null);
      setFlags(res.flags ?? NO_FLAGS);
      if (res.today) setToday(res.today);
      setError(null);
    } catch (err) {
      if (r === req.current) setError(toClinicalError(err));
    } finally {
      if (r === req.current) setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    if (ready && user?.clinic_id) void load();
  }, [ready, load, user?.clinic_id]);

  const loadMore = async () => {
    setMoreBusy(true);
    try {
      const res = await clinImplantList(filters, { offset: rows.length, limit: PAGE_SIZE });
      setRows((prev) => [...prev, ...(res.rows || [])]);
      setTotal(res.total ?? total);
    } catch (err) {
      setError(toClinicalError(err));
    } finally {
      setMoreBusy(false);
    }
  };

  // Write controls wait for the server's flags (they also carry can_operate_stock for the form).
  const effectiveFlags: ClinicalFlags = flags ?? NO_FLAGS;
  const dialogs = useImplantDialogs({ flags: effectiveFlags, today, onChanged: () => void load() });

  const tile = (patch: Partial<UrlState>) => {
    setSearch("");
    update({ ...EMPTY_STATE, deleted: state.deleted, ...patch });
  };
  const toggleStatus = (s: ImplantStatus) =>
    update({ status: state.status.includes(s) ? state.status.filter((x) => x !== s) : [...state.status, s] });

  const filtered = isFiltered(state);
  const onlyControl = state.control && !state.month && state.status.length === 0 && !state.source && !state.q;
  const onlyStatus = (s: ImplantStatus) =>
    state.status.length === 1 && state.status[0] === s && !state.control && !state.month && !state.source && !state.q;
  const onlyMonth = state.month && !state.control && state.status.length === 0 && !state.source && !state.q;
  const onlyExternal = state.source === "external" && !state.control && !state.month && state.status.length === 0 && !state.q;

  return (
    <div className="p-4 md:p-8 space-y-6 text-gray-900">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">İmplant takibi</h1>
          <p className="text-gray-600 text-sm mt-1">Hastalara uygulanan implantlar, lot / seri bilgisi ve kontrol tarihleri.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/clinical/brands" className={`${clinSecondary} inline-flex items-center`}>
            Markalar
          </Link>
          {flags?.can_write && (
            <button type="button" className={clinPrimary} onClick={() => dialogs.open({})}>
              İmplant ekle
            </button>
          )}
        </div>
      </div>

      <ClinicalNotice error={error} />
      <ErrorBox error={dialogs.error} />

      {counts && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <StatTile
            label="Kontrol tarihi gelen"
            value={counts.control_due}
            tone={counts.control_due > 0 ? "amber" : undefined}
            active={onlyControl}
            onClick={() => tile({ control: true })}
          />
          <StatTile label="İyileşme döneminde" value={counts.healing} active={onlyStatus("healing")} onClick={() => tile({ status: ["healing"] })} />
          <StatTile
            label="Protez aşamasında"
            value={counts.prosthetic}
            active={onlyStatus("prosthetic")}
            onClick={() => tile({ status: ["prosthetic"] })}
          />
          <StatTile label="Bu ay takılan" value={counts.placed_this_month} active={onlyMonth} onClick={() => tile({ month: true })} />
          {counts.external > 0 && (
            <StatTile
              label="Stok dışı kayıtlar"
              value={counts.external}
              active={onlyExternal}
              onClick={() => tile({ source: "external" })}
            />
          )}
        </div>
      )}

      <div className="bg-white rounded-lg shadow p-4 space-y-3">
        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
          <input
            className={clinInput}
            placeholder="Hasta, marka, model, lot veya diş ara"
            aria-label="Ara"
            value={search}
            maxLength={100}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label className="inline-flex items-center gap-2 min-h-[44px] text-sm">
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={state.control}
              onChange={(e) => update({ control: e.target.checked })}
            />
            Kontrol tarihi gelenler
          </label>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Durum">
          {IMPLANT_STATUSES.map((s) => {
            const on = state.status.includes(s);
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                onClick={() => toggleStatus(s)}
                className={`px-3 min-h-[44px] rounded border text-sm ${on ? "bg-blue-600 text-white border-blue-700" : "bg-white text-gray-800"}`}
              >
                {IMPLANT_STATUS_LABELS[s]}
              </button>
            );
          })}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <select className={clinInput} aria-label="Hekim" value={state.doctor} onChange={(e) => update({ doctor: e.target.value })}>
            <option value="">Tüm hekimler</option>
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <select className={clinInput} aria-label="Marka" value={state.brand} onChange={(e) => update({ brand: e.target.value })}>
            <option value="">Tüm markalar</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
                {b.is_active ? "" : " (pasif)"}
              </option>
            ))}
          </select>
          <select
            className={clinInput}
            aria-label="Stok kaynağı"
            value={state.source}
            onChange={(e) => update({ source: e.target.value as UrlState["source"] })}
          >
            <option value="">Tüm kaynaklar</option>
            <option value="stock">Stoktan düşülen</option>
            <option value="external">Stok dışı</option>
          </select>
          {effectiveFlags.can_view_deleted && (
            <select
              className={clinInput}
              aria-label="Kayıtlar"
              value={state.deleted}
              onChange={(e) => update({ deleted: e.target.value as UrlState["deleted"] })}
            >
              <option value="active">Kayıtlar: Etkin</option>
              <option value="deleted">Kayıtlar: İptal edilenler</option>
              <option value="all">Kayıtlar: Tümü</option>
            </select>
          )}
        </div>
        {filtered && (
          <button
            type="button"
            className="text-sm text-blue-700 hover:underline min-h-[44px]"
            onClick={() => {
              setSearch("");
              update(EMPTY_STATE);
            }}
          >
            Filtreleri temizle
          </button>
        )}
      </div>

      {loading && rows.length === 0 ? (
        <Loading />
      ) : rows.length === 0 && !error ? (
        filtered ? (
          <EmptyState title="Eşleşen kayıt bulunamadı">Aramayı veya filtreyi değiştirin.</EmptyState>
        ) : (
          <EmptyState title="Henüz implant kaydı yok">
            {flags?.can_write && (
              <button type="button" className={clinPrimary} onClick={() => dialogs.open({})}>
                İlk kaydı ekle
              </button>
            )}
          </EmptyState>
        )
      ) : (
        <>
          <ImplantTable rows={rows} flags={effectiveFlags} actions={dialogs.actions} />
          <MoreButton shown={rows.length} total={total} busy={moreBusy} onMore={() => void loadMore()} />
        </>
      )}

      {dialogs.element}
    </div>
  );
}
