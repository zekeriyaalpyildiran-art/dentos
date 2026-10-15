"use client";

// Laboratuvar işleri (spec p9_clinical §7.6): tiles, filters, late detection from the server, status dialog.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAuthStore } from "@/lib/store";
import {
  NO_FLAGS,
  clinLabOrderList,
  listDoctors,
  listLabs,
  toClinicalError,
  type ClinicalError,
  type ClinicalFlags,
  type DoctorRef,
  type LabOrderCounts,
  type LabOrderFilters,
  type LabOrderJson,
  type LabRow,
} from "@/lib/clinical/rpc";
import { LAB_STATUSES, LAB_STATUS_LABELS, isLabStatus, type LabStatus } from "@/lib/clinical/codes";
import { formatDayShort, istanbulToday } from "@/lib/clinical/dates";
import { formatTl } from "@/lib/clinical/numbers";
import { canWriteClinical } from "@/lib/clinical/permissions";
import { LabStatusDialog, statusWarningText } from "@/components/clinical/LabStatusDialog";
import { LabStatusBadge, PayableChip } from "@/components/clinical/LabBadges";
import {
  ClinicalNotice,
  EmptyState,
  Loading,
  MoreButton,
  StatTile,
  Toast,
  clinInput,
  clinPrimary,
  clinSecondary,
} from "@/components/clinical/ui";

const PAGE_SIZE = 50;

type Tile = "draft" | "at_lab" | "late" | "try_in" | "revision" | "arrived" | "payable_pending" | null;

interface ListState {
  status: LabStatus[];
  late: boolean;
  payablePending: boolean;
  labId: string;
  doctorId: string;
}

const EMPTY: ListState = { status: [], late: false, payablePending: false, labId: "", doctorId: "" };

function tileState(tile: Exclude<Tile, null>): Partial<ListState> {
  switch (tile) {
    case "draft":
      return { status: ["draft"] };
    case "at_lab":
      return { status: ["submitted", "in_progress"] };
    case "late":
      return { late: true };
    case "try_in":
      return { status: ["try_in"] };
    case "revision":
      return { status: ["revision"] };
    case "arrived":
      return { status: ["ready"] };
    case "payable_pending":
      return { payablePending: true };
  }
}

function sameStatus(a: LabStatus[], b: LabStatus[] | undefined): boolean {
  const x = [...a].sort().join(",");
  return x === [...(b ?? [])].sort().join(",");
}

export default function LabPage() {
  const user = useAuthStore((s) => s.user);
  const [state, setState] = useState<ListState>(EMPTY);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");

  const [rows, setRows] = useState<LabOrderJson[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<LabOrderCounts | null>(null);
  const [flags, setFlags] = useState<ClinicalFlags | null>(null);
  const [today, setToday] = useState(istanbulToday());
  const [loading, setLoading] = useState(true);
  const [moreBusy, setMoreBusy] = useState(false);
  const [error, setError] = useState<ClinicalError | null>(null);
  const req = useRef(0);

  const [labs, setLabs] = useState<LabRow[]>([]);
  const [doctors, setDoctors] = useState<DoctorRef[]>([]);
  const [statusFor, setStatusFor] = useState<LabOrderJson | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // ?late=1 / ?status=try_in deep links; read directly so no Suspense boundary is needed.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const status = (p.get("status") ?? "").split(",").filter(isLabStatus);
    if (status.length || p.get("late") === "1") setState({ ...EMPTY, status, late: p.get("late") === "1" });
    Promise.all([listLabs(), listDoctors()])
      .then(([l, d]) => {
        setLabs(l);
        setDoctors(d);
      })
      .catch(() => {
        // Filter options only.
      });
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim().slice(0, 100)), 300);
    return () => clearTimeout(t);
  }, [search]);

  const filters = useMemo<LabOrderFilters>(() => {
    const f: LabOrderFilters = {};
    if (q) f.q = q;
    if (state.status.length) f.status = state.status;
    if (state.late) f.late = true;
    if (state.payablePending) f.payable_pending = true;
    if (state.labId) f.lab_id = state.labId;
    if (state.doctorId) f.doctor_id = state.doctorId;
    return f;
  }, [q, state]);

  const load = useCallback(async () => {
    const r = ++req.current;
    setLoading(true);
    try {
      const res = await clinLabOrderList(filters, { offset: 0, limit: PAGE_SIZE });
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
    if (user?.clinic_id) void load();
  }, [load, user?.clinic_id]);

  const loadMore = async () => {
    setMoreBusy(true);
    try {
      const res = await clinLabOrderList(filters, { offset: rows.length, limit: PAGE_SIZE });
      setRows((prev) => [...prev, ...(res.rows || [])]);
      setTotal(res.total ?? total);
    } catch (err) {
      setError(toClinicalError(err));
    } finally {
      setMoreBusy(false);
    }
  };

  const f: ClinicalFlags = flags ?? { ...NO_FLAGS, can_write: canWriteClinical(user) };
  const filtered = !!q || state.status.length > 0 || state.late || state.payablePending || !!state.labId || !!state.doctorId;

  const activeTile = (tile: Exclude<Tile, null>) => {
    const t = tileState(tile);
    return (
      sameStatus(state.status, t.status) &&
      state.late === !!t.late &&
      state.payablePending === !!t.payablePending &&
      !state.labId &&
      !state.doctorId &&
      !q
    );
  };
  const pickTile = (tile: Exclude<Tile, null>) => {
    setSearch("");
    setQ("");
    setState({ ...EMPTY, ...tileState(tile) });
  };
  const toggleStatus = (s: LabStatus) =>
    setState((prev) => ({
      ...prev,
      payablePending: false,
      status: prev.status.includes(s) ? prev.status.filter((x) => x !== s) : [...prev.status, s],
    }));

  return (
    <div className="p-4 md:p-8 space-y-6 text-gray-900">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h1 className="text-2xl md:text-3xl font-bold">Laboratuvar işleri</h1>
        <div className="flex flex-wrap gap-2">
          <Link href="/lab/labs" className={`${clinSecondary} inline-flex items-center`}>
            Laboratuvarlar
          </Link>
          {f.can_write && (
            <Link href="/lab/new" className={`${clinPrimary} inline-flex items-center`}>
              + Yeni lab işi
            </Link>
          )}
        </div>
      </div>

      <ClinicalNotice error={error} />

      {counts && (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-7 gap-3">
          <StatTile label="Taslak" value={counts.draft} active={activeTile("draft")} onClick={() => pickTile("draft")} />
          <StatTile label="Laboratuvarda" value={counts.at_lab} active={activeTile("at_lab")} onClick={() => pickTile("at_lab")} />
          <StatTile
            label="Geciken işler"
            value={counts.late}
            tone={counts.late > 0 ? "red" : undefined}
            active={activeTile("late")}
            onClick={() => pickTile("late")}
          />
          <StatTile label="Provada" value={counts.try_in} active={activeTile("try_in")} onClick={() => pickTile("try_in")} />
          <StatTile label="Revizyonda" value={counts.revision} active={activeTile("revision")} onClick={() => pickTile("revision")} />
          <StatTile label="Kliniğe gelen" value={counts.arrived} active={activeTile("arrived")} onClick={() => pickTile("arrived")} />
          {f.can_finance && counts.payable_pending !== undefined && (
            <StatTile
              label="Finans bekleyen"
              value={counts.payable_pending}
              tone={counts.payable_pending > 0 ? "amber" : undefined}
              active={activeTile("payable_pending")}
              onClick={() => pickTile("payable_pending")}
            />
          )}
        </div>
      )}

      <div className="bg-white rounded-lg shadow p-4 space-y-3">
        <input
          className={clinInput}
          placeholder="Sipariş no, hasta, laboratuvar veya iş türü ara"
          aria-label="Ara"
          value={search}
          maxLength={100}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex flex-wrap gap-2" role="group" aria-label="Durum">
          <button
            type="button"
            aria-pressed={state.status.length === 0 && !state.late && !state.payablePending}
            onClick={() => setState((prev) => ({ ...prev, status: [], late: false, payablePending: false }))}
            className={`px-3 min-h-[44px] rounded border text-sm ${
              state.status.length === 0 && !state.late && !state.payablePending ? "bg-blue-600 text-white border-blue-700" : "bg-white"
            }`}
          >
            Tümü
          </button>
          {LAB_STATUSES.map((s) => {
            const on = state.status.includes(s);
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                onClick={() => toggleStatus(s)}
                className={`px-3 min-h-[44px] rounded border text-sm ${on ? "bg-blue-600 text-white border-blue-700" : "bg-white"}`}
              >
                {LAB_STATUS_LABELS[s]}
              </button>
            );
          })}
          <label className="inline-flex items-center gap-2 px-2 min-h-[44px] text-sm">
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={state.late}
              onChange={(e) => setState((prev) => ({ ...prev, late: e.target.checked }))}
            />
            Gecikenler
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <select className={clinInput} aria-label="Laboratuvar" value={state.labId} onChange={(e) => setState((p) => ({ ...p, labId: e.target.value }))}>
            <option value="">Tüm laboratuvarlar</option>
            {labs.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {l.is_active ? "" : " (pasif)"}
              </option>
            ))}
          </select>
          <select className={clinInput} aria-label="Hekim" value={state.doctorId} onChange={(e) => setState((p) => ({ ...p, doctorId: e.target.value }))}>
            <option value="">Tüm hekimler</option>
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading && rows.length === 0 ? (
        <Loading />
      ) : rows.length === 0 && !error ? (
        <EmptyState title={filtered ? "Eşleşen iş bulunamadı" : "Henüz laboratuvar işi yok"}>
          {filtered ? "Aramayı veya filtreyi değiştirin." : null}
        </EmptyState>
      ) : (
        <>
          <div className="hidden md:block bg-white rounded-lg shadow overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-100 border-b text-left text-gray-800">
                <tr>
                  <th className="px-4 py-3 font-semibold">Hasta / iş</th>
                  <th className="px-4 py-3 font-semibold">Laboratuvar</th>
                  <th className="px-4 py-3 font-semibold">Gönderim / dönüş</th>
                  <th className="px-4 py-3 font-semibold">Durum</th>
                  {f.can_view_lab_costs && <th className="px-4 py-3 font-semibold text-right">Maliyet</th>}
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id} className="border-b align-top">
                    <td className="px-4 py-3">
                      <Link href={`/patients/${o.patient_id}`} className="font-semibold text-blue-700 hover:underline">
                        {o.patient_name}
                      </Link>
                      <div>
                        <Link href={`/lab/${o.id}`} className="text-xs text-blue-700 hover:underline">
                          {o.order_number}
                        </Link>
                        <span className="text-xs text-gray-600"> · {o.items_summary || "—"}</span>
                      </div>
                      {o.notes && (
                        <div className="text-xs text-gray-500 truncate max-w-[18rem]" title={o.notes}>
                          {o.notes}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">{o.lab_name || "—"}</td>
                    <td className="px-4 py-3 text-xs space-y-0.5 whitespace-nowrap">
                      <div>Gönderim {formatDayShort(o.sent_on)}</div>
                      <div className={o.is_late ? "text-red-700 font-medium" : ""}>
                        Beklenen {formatDayShort(o.due_date)}
                        {o.is_late && o.days_late ? ` · ${o.days_late} gün` : ""}
                      </div>
                      {o.received_on && <div>Geldi {formatDayShort(o.received_on)}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <LabStatusBadge order={o} />
                    </td>
                    {f.can_view_lab_costs && (
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {o.cost ? <div className="tabular-nums">{formatTl(o.cost.amount_cents)}</div> : <span className="text-gray-400">—</span>}
                        <PayableChip order={o} />
                      </td>
                    )}
                    <td className="px-4 py-3 text-right">
                      {f.can_write && o.allowed_next.length > 0 && (
                        <button type="button" className={clinSecondary} onClick={() => setStatusFor(o)}>
                          Durum
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="md:hidden space-y-3">
            {rows.map((o) => (
              <li key={o.id} className="bg-white rounded-lg shadow p-4 space-y-2 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link href={`/patients/${o.patient_id}`} className="font-semibold text-blue-700 hover:underline">
                      {o.patient_name}
                    </Link>
                    <div>
                      <Link href={`/lab/${o.id}`} className="text-xs text-blue-700 hover:underline">
                        {o.order_number}
                      </Link>
                    </div>
                  </div>
                  <LabStatusBadge order={o} />
                </div>
                <div className="text-xs text-gray-600">{o.items_summary || "—"}</div>
                <div className="text-xs text-gray-700">{o.lab_name || "Laboratuvar yok"}</div>
                <div className="text-xs">
                  Gönderim {formatDayShort(o.sent_on)} ·{" "}
                  <span className={o.is_late ? "text-red-700 font-medium" : ""}>Beklenen {formatDayShort(o.due_date)}</span>
                  {o.received_on && ` · Geldi ${formatDayShort(o.received_on)}`}
                </div>
                {f.can_view_lab_costs && o.cost && (
                  <div className="text-xs">
                    {formatTl(o.cost.amount_cents)} <PayableChip order={o} />
                  </div>
                )}
                {f.can_write && o.allowed_next.length > 0 && (
                  <button type="button" className={`${clinSecondary} w-full`} onClick={() => setStatusFor(o)}>
                    Durum
                  </button>
                )}
              </li>
            ))}
          </ul>
          <MoreButton shown={rows.length} total={total} busy={moreBusy} onMore={() => void loadMore()} />
        </>
      )}

      {statusFor && (
        <LabStatusDialog
          order={statusFor}
          today={today}
          onClose={() => setStatusFor(null)}
          onDone={(_order, warnings) => {
            setStatusFor(null);
            setToast(statusWarningText(warnings) ?? "Durum güncellendi.");
            void load();
          }}
        />
      )}
      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}
