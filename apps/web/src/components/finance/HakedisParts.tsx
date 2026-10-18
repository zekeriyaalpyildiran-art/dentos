"use client";

// Shared pieces of the Hakediş pages, in two modes (0031): 'finance' under Finans → Hakediş (/finance/hakedis/…) and
// 'prep' in the 'Hakediş ve maaş' section (/hakedis/…) of the 'hakedis_prepare' holders. Reference data, the month in
// the address (?month=YYYY-MM, kept when switching between the pages), the month payload, the sub-tabs, the month
// picker, the void dialog of lines / pieces / lab costs / adjustments and the component breakdown (0032: the lab costs
// taken off a ciro_share base and the minimum top-up).

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ADJUSTMENT_KIND_LABELS,
  HK_METHODS,
  LAB_LABELS,
  METHOD_LABELS,
  addMonths,
  componentTitle,
  finHkMarks,
  finHkMonth,
  finHkReference,
  formatBp,
  monthKey,
  pickDefaultMonth,
  type HkMarkJson,
  type HkMonthPayload,
  type HkMonthStatus,
  type HkMyComponentJson,
  type HkReferenceJson,
} from "@/lib/hakedis";
import { formatMonth, formatTL, isMonth, toFinanceError, type FinanceError } from "@/lib/finance";
import { ErrorBox, Field, Modal, buttonDanger, buttonPrimary, buttonSecondary, inputClass } from "./ui";

/**
 * 'finance': Finans → Hakediş (FinanceShell; month close, rules editor for 'finance'). 'prep': the 'Hakediş ve maaş'
 * section for 'hakedis_prepare' holders (and finance holders): data entry in open months, everything else read-only,
 * no ledger data unless the server says ledger_visible.
 */
export type HkMode = "finance" | "prep";

/** Address of the month page of each mode; the other pages are below it. */
export const HK_BASE: Record<HkMode, string> = {
  finance: "/finance/hakedis",
  prep: "/hakedis",
};

/** Loads fin_hk_reference (doctors, payees, rules, month rows, lab names). */
export function useHkReference() {
  const [data, setData] = useState<HkReferenceJson | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await finHkReference();
      setData(next);
      setError(null);
      return next;
    } catch (err) {
      setError(toFinanceError(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, loading, reload };
}

/**
 * The month of the page ('YYYY-MM'): ?month= when valid, else the §2 default (the previous month while it is open,
 * else the current one). null until the reference data is loaded. Needs a Suspense boundary (useSearchParams).
 */
export function useHkMonth(ref: HkReferenceJson | null): [string | null, (month: string) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const raw = searchParams.get("month");
  const fallback = ref ? pickDefaultMonth(ref.current_month, ref.months) : null;
  const month = raw && isMonth(raw) ? raw : fallback;

  const setMonth = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("month", monthKey(next));
      router.replace(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams]
  );
  return [month, setMonth];
}

/** fin_hk_marks (every patient mark); `marks` is null until loaded. */
export function useHkMarks() {
  const [marks, setMarks] = useState<HkMarkJson[] | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);

  const reload = useCallback(async () => {
    try {
      setMarks(await finHkMarks());
      setError(null);
    } catch (err) {
      setError(toFinanceError(err));
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { marks, error, reload };
}

/**
 * fin_hk_month of `month` ('YYYY-MM'; nothing while null). `data` is null while it belongs to another month (a stale
 * answer never shows under the newly chosen month).
 */
export function useHkMonthData(month: string | null) {
  const [data, setData] = useState<HkMonthPayload | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (!month) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const next = await finHkMonth(month);
      if (mine !== seq.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (mine === seq.current) setError(toFinanceError(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    reload();
  }, [reload]);

  const current = data && month && monthKey(data.month) === month ? data : null;
  return { data: current, error, loading, reload, setData };
}

/**
 * Why records of `month` cannot be written in the month's state, or null: a closed month, a month before a later
 * closed month (it would change the closed month's ortho walk; the server refuses both), a month after the current one.
 */
export function hkMonthLock(
  ref: Pick<HkReferenceJson, "months" | "current_month">,
  status: HkMonthStatus | undefined,
  month: string
): string | null {
  if (status === "closed") return HK_CLOSED_TEXT;
  if (ref.months.some((m) => m.status === "closed" && monthKey(m.month) > monthKey(month))) return HK_LATER_CLOSED_TEXT;
  if (monthKey(month) > monthKey(ref.current_month)) return "Gelecek aylara kayıt girilemez.";
  return null;
}

export const HK_CLOSED_TEXT = "Bu ay kapatıldı. Düzeltmeyi açık bir aya düzeltme satırı olarak girin.";
export const HK_LATER_CLOSED_TEXT =
  "Bu aydan sonraki bir ay kapatıldı. Düzeltmeyi son kapatılan aydan sonraki bir aya düzeltme satırı olarak girin.";

const SUB_TABS = [
  { path: "", label: "Ay özeti", keepMonth: true },
  { path: "/lines", label: "Satırlar ve hastalar", keepMonth: true },
  { path: "/lab", label: LAB_LABELS.tab, keepMonth: true },
  { path: "/payroll", label: "Maaş ve prim", keepMonth: true },
  { path: "/rules", label: "Kurallar", keepMonth: false },
];

/**
 * Ay özeti / Satırlar ve hastalar / Lab özeti (0032) / Maaş ve prim / Kurallar of the mode; the chosen month travels
 * along.
 */
export function HakedisTabs({ mode, month }: { mode: HkMode; month?: string | null }) {
  const pathname = usePathname();
  return (
    <div className="flex flex-wrap gap-2" role="navigation" aria-label="Hakediş sayfaları">
      {SUB_TABS.map((tab) => {
        const path = HK_BASE[mode] + tab.path;
        const active = pathname === path;
        const href = tab.keepMonth && month ? `${path}?month=${monthKey(month)}` : path;
        return (
          <Link
            key={path}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`px-3 py-1.5 rounded border text-sm ${
              active ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-800 border-gray-300 hover:bg-gray-50"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}

/** ← month → with a native month input; never after `max` (the current month). */
export function MonthPicker({
  month,
  max,
  onChange,
  disabled,
}: {
  month: string;
  max?: string;
  onChange: (month: string) => void;
  disabled?: boolean;
}) {
  const maxKey = max ? monthKey(max) : undefined;
  const nextMonth = addMonths(month, 1);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="px-3 py-2 border border-gray-300 text-gray-800 rounded hover:bg-gray-50 disabled:opacity-40"
        onClick={() => onChange(addMonths(month, -1))}
        disabled={disabled}
        aria-label="Önceki ay"
      >
        ←
      </button>
      <label className="flex items-center gap-2">
        <span className="sr-only">Ay</span>
        <input
          type="month"
          className="px-3 py-2 border rounded bg-white text-gray-900"
          value={monthKey(month)}
          max={maxKey}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value;
            if (isMonth(v) && (!maxKey || v <= maxKey)) onChange(v);
          }}
        />
      </label>
      <button
        type="button"
        className="px-3 py-2 border border-gray-300 text-gray-800 rounded hover:bg-gray-50 disabled:opacity-40"
        onClick={() => onChange(nextMonth)}
        disabled={disabled || (!!maxKey && nextMonth > maxKey)}
        aria-label="Sonraki ay"
      >
        →
      </button>
      <span className="text-sm text-gray-600 capitalize">{formatMonth(monthKey(month))}</span>
    </div>
  );
}

/** Kaydet / Vazgeç of the Hakediş dialogs. */
export function DialogButtons({ busy, onClose }: { busy: boolean; onClose: () => void }) {
  return (
    <div className="flex gap-2">
      <button type="submit" className={buttonPrimary} disabled={busy}>
        {busy ? "Kaydediliyor..." : "Kaydet"}
      </button>
      <button type="button" className={buttonSecondary} onClick={onClose} disabled={busy}>
        Vazgeç
      </button>
    </div>
  );
}

/** Page frame of the 'Hakediş ve maaş' section (prep mode); the finance pages use FinanceShell. */
export function HakedisPrepFrame({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="p-4 md:p-8 space-y-6 text-gray-900">
      <h1 className="text-2xl md:text-3xl font-bold">{title}</h1>
      {children}
    </div>
  );
}

export function MonthStatusBadge({ status }: { status: HkMonthStatus }) {
  return status === "closed" ? (
    <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">Kapatıldı</span>
  ) : (
    <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800">Açık</span>
  );
}

/**
 * 'İptal et' for a line, a piece, a lab cost or a bonus / other row: a reason of 3..500 characters; the row stays,
 * struck through.
 */
export function HkVoidDialog({
  title,
  body,
  onVoid,
  onDone,
  onClose,
  onReload,
}: {
  title: string;
  body: string;
  onVoid: (reason: string) => Promise<{ already_saved: boolean }>;
  onDone: (message: string) => void | Promise<void>;
  onClose: () => void;
  onReload: () => void;
}) {
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    const trimmed = reason.trim();
    if (trimmed.length < 3 || trimmed.length > 500) return setFormError("Gerekçe en az 3, en fazla 500 karakter olmalı.");
    setBusy(true);
    try {
      const res = await onVoid(trimmed);
      await onDone(res.already_saved ? "Kayıt zaten iptal edilmişti." : "Kayıt iptal edildi.");
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-gray-700">{body}</p>
        <Field label="Gerekçe" hint="En az 3, en fazla 500 karakter.">
          <textarea className={inputClass} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} required />
        </Field>
        {formError && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{formError}</div>}
        <ErrorBox error={error} onReload={onReload} />
        <div className="flex gap-2">
          <button type="submit" className={buttonDanger} disabled={busy}>
            {busy ? "Kaydediliyor..." : "İptal et"}
          </button>
          <button type="button" className={buttonSecondary} onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * How one component of a payee was computed: per payment method gross → implant part → lab part → deduction → net,
 * then matrah × rate; implants qty × amount; management share on the clinic's gross ciro; ortho lab totals per patient;
 * the fixed monthly salary and the month's bonus / other rows (0031). Used by the month pages and by Hakedişim (where
 * the management component carries base and amount only).
 */
export function ComponentBreakdown({ c }: { c: HkMyComponentJson }) {
  const methods = c.by_method ? HK_METHODS.filter((m) => c.by_method && (c.by_method[m].gross !== 0 || c.by_method[m].lab !== 0)) : [];
  return (
    <div className="rounded border bg-gray-50 p-3 text-sm text-gray-900 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-semibold">{componentTitle(c)}</span>
        <span className="font-semibold tabular-nums">{formatTL(c.amount_cents)}</span>
      </div>
      {c.by_method && (
        <>
          {methods.length === 0 ? (
            <p className="text-gray-500">Bu ay bu kurala giren tahsilat yok.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs md:text-sm">
                <thead>
                  <tr className="text-left text-gray-600 border-b">
                    <th className="py-1 pr-3 font-medium">Ödeme şekli</th>
                    <th className="py-1 pr-3 font-medium text-right">Brüt</th>
                    <th className="py-1 pr-3 font-medium text-right">İmplant payı</th>
                    <th className="py-1 pr-3 font-medium text-right">Lab</th>
                    <th className="py-1 pr-3 font-medium text-right">Hesaba giren</th>
                    <th className="py-1 pr-3 font-medium text-right">Kesinti</th>
                    <th className="py-1 font-medium text-right">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {methods.map((m) => {
                    const b = c.by_method![m];
                    return (
                      <tr key={m} className="border-b last:border-b-0">
                        <td className="py-1 pr-3 whitespace-nowrap">{METHOD_LABELS[m]}</td>
                        <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap">{formatTL(b.gross)}</td>
                        <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap">{b.implant ? formatTL(-b.implant) : "—"}</td>
                        <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap">{b.lab ? formatTL(-b.lab) : "—"}</td>
                        <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap">{formatTL(b.eligible)}</td>
                        <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap">
                          {b.deduction ? `${formatTL(-b.deduction)} (${formatBp(b.deduct_bp)})` : formatBp(b.deduct_bp)}
                        </td>
                        <td className="py-1 text-right tabular-nums whitespace-nowrap">{formatTL(b.eligible - b.deduction)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {typeof c.lab_cents === "number" && <CiroLabLine c={c} />}
          <p className="text-gray-700">
            Matrah {formatTL(c.base_cents ?? 0)} × {formatBp(c.share_bp)} = <strong>{formatTL(c.amount_cents)}</strong>
            {typeof c.lines_count === "number" ? ` · ${c.lines_count} satır` : ""}
          </p>
        </>
      )}
      {c.kind === "minimum_topup" && (
        <p className="text-gray-700">
          Ayın toplamı taban tutarın altında kaldı; aradaki fark <strong>{formatTL(c.amount_cents)}</strong> tamamlandı.
        </p>
      )}
      {c.kind === "implant_piece" && (
        <p className="text-gray-700">
          {c.qty ?? 0} implant × {formatTL(c.piece_cents)} = <strong>{formatTL(c.amount_cents)}</strong>
        </p>
      )}
      {c.kind === "clinic_ciro_share" && (
        <p className="text-gray-700">
          Klinik cirosu (brüt, tüm hekimler) {formatTL(c.base_cents ?? 0)} × {formatBp(c.share_bp)} ={" "}
          <strong>{formatTL(c.amount_cents)}</strong>
        </p>
      )}
      {c.kind === "fixed_monthly" && (
        <p className="text-gray-700">
          Aylık net maaş <strong>{formatTL(c.amount_cents)}</strong>
        </p>
      )}
      {c.kind === "adjustments" && (
        <ul className="space-y-1">
          {(c.items ?? []).map((item) => (
            <li key={item.id} className="flex justify-between gap-3">
              <span className="min-w-0">
                <span className="font-medium">{ADJUSTMENT_KIND_LABELS[item.kind] ?? item.kind}</span>
                {item.description ? <span className="text-gray-600"> · {item.description}</span> : null}
              </span>
              <span className={`tabular-nums whitespace-nowrap ${item.amount_cents < 0 ? "text-red-600" : ""}`}>
                {formatTL(item.amount_cents)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {c.kind === "ortho_lab_first" && c.lab_patients && c.lab_patients.length > 0 && <LabPatientsTable rows={c.lab_patients} />}
    </div>
  );
}

/**
 * 0032, ciro_share with lab costs of the month: ciro after the method deductions − the deducted lab costs = matrah,
 * and the part of the lab costs left with the clinic when they exceed the ciro (LAB_OVER_CIRO).
 */
function CiroLabLine({ c }: { c: Pick<HkMyComponentJson, "base_cents" | "lab_cents" | "lab_excess_cents"> }) {
  const lab = c.lab_cents ?? 0;
  const excess = c.lab_excess_cents ?? 0;
  const base = c.base_cents ?? 0;
  return (
    <p className="text-gray-700">
      Kesintiler sonrası ciro {formatTL(base + lab)} − ayın lab gideri {formatTL(lab)} = matrah {formatTL(base)}
      {excess > 0 && (
        <span className="block text-amber-700">
          Ayın lab gideri {formatTL(lab + excess)}; ciroyu aşan {formatTL(excess)} hakedişten düşülmedi, klinikte kalır.
        </span>
      )}
    </p>
  );
}

/** Ortho lab-first: per patient, lab costs to date, recovered from payments so far, still to recover. */
export function LabPatientsTable({
  rows,
}: {
  rows: readonly { patient_ref: string; patient_name: string; lab_total_cents: number; recovered_cents: number; remaining_cents: number }[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs md:text-sm">
        <thead>
          <tr className="text-left text-gray-600 border-b">
            <th className="py-1 pr-3 font-medium">Hasta</th>
            <th className="py-1 pr-3 font-medium text-right">Toplam lab</th>
            <th className="py-1 pr-3 font-medium text-right">Karşılanan</th>
            <th className="py-1 font-medium text-right">Kalan</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.patient_ref} className="border-b last:border-b-0">
              <td className="py-1 pr-3">{r.patient_name}</td>
              <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap">{formatTL(r.lab_total_cents)}</td>
              <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap">{formatTL(r.recovered_cents)}</td>
              <td className={`py-1 text-right tabular-nums whitespace-nowrap ${r.remaining_cents > 0 ? "text-amber-700 font-medium" : ""}`}>
                {formatTL(r.remaining_cents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
