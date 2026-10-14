"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FinanceShell, useCanWriteFinance } from "@/components/finance/FinanceShell";
import { EntryTable } from "@/components/finance/EntryTable";
import { useReferenceData } from "@/components/finance/useReferenceData";
import {
  ErrorBox,
  Field,
  ListTotalsBox,
  Loading,
  Pager,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from "@/components/finance/ui";
import {
  UUID_RE,
  dropDrillText,
  finList,
  isDay,
  sortByOrder,
  toFinanceError,
  type Direction,
  type FinanceError,
  type ListFilters,
  type ListResult,
  type StatusFilter,
  readDrillText,
} from "@/lib/finance";

const PAGE_SIZE = 50;

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "Tüm kayıtlar" },
  { value: "open", label: "Açık kayıtlar" },
  { value: "completed", label: "Tamamlananlar" },
  { value: "cancelled", label: "İptaller" },
];

export default function FinanceEntriesPage() {
  return (
    <FinanceShell title="Ödeme ve tahsilatlar">
      <Suspense fallback={<Loading />}>
        <EntriesList />
      </Suspense>
    </FinanceShell>
  );
}

/**
 * Filters that may appear in the URL. Free text (the search box and a Cariler free-text drill-down) never does:
 * names of patients, physicians and suppliers would land in the browser history and in Vercel's request logs.
 * The search lives in component state; a free-text drill-down arrives as ?cp_ref=<uuid> (lib/finance stashDrillText).
 */
type UrlFilters = Omit<ListFilters, "query" | "counterparty_text">;

/** Reads the drill-down filters (dashboard groups, Cariler, category report) from the URL. */
function filtersFromParams(params: URLSearchParams): UrlFilters {
  const f: UrlFilters = {};
  const status = params.get("status");
  if (status && STATUS_OPTIONS.some((o) => o.value === status)) f.status = status as StatusFilter;
  const category = params.get("category_id");
  if (category && UUID_RE.test(category)) f.category_id = category;
  const direction = params.get("direction");
  if (direction === "in" || direction === "out") f.direction = direction;
  const cp = params.get("counterparty_id");
  if (cp && UUID_RE.test(cp)) f.counterparty_id = cp;
  const group = params.get("report_group");
  if (group && (group === "other" || UUID_RE.test(group))) f.report_group = group;
  const from = params.get("date_from");
  if (from && isDay(from)) f.date_from = from;
  const to = params.get("date_to");
  if (to && isDay(to)) f.date_to = to;
  if (params.get("overdue") === "true") f.overdue = true;
  return f;
}

const URL_KEYS: (keyof UrlFilters)[] = [
  "status",
  "category_id",
  "direction",
  "counterparty_id",
  "report_group",
  "date_from",
  "date_to",
  "overdue",
];

function paramsFromFilters(f: ListFilters, cpRef: string | null): string {
  const p = new URLSearchParams();
  for (const k of URL_KEYS) {
    const v = f[k];
    if (v === undefined || v === null || v === "" || v === false) continue;
    if (k === "status" && v === "all") continue;
    p.set(k, String(v));
  }
  if (cpRef) p.set("cp_ref", cpRef);
  const s = p.toString();
  return s ? `?${s}` : "";
}

function EntriesList() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const canWrite = useCanWriteFinance();
  const ref = useReferenceData();

  const urlFilters = useMemo(() => filtersFromParams(new URLSearchParams(searchParams.toString())), [searchParams]);
  const cpRefParam = searchParams.get("cp_ref");
  const cpRef = cpRefParam && UUID_RE.test(cpRefParam) ? cpRefParam : null;
  // The Cariler free-text drill-down, resolved from its reference (null when the reference is unknown here).
  const counterpartyText = useMemo(() => (cpRef ? readDrillText(cpRef)?.slice(0, 200) ?? null : null), [cpRef]);
  const [query, setQuery] = useState("");
  const filters: ListFilters = useMemo(
    () => ({ ...urlFilters, query: query || undefined, counterparty_text: counterpartyText ?? undefined }),
    [urlFilters, query, counterpartyText]
  );
  const [queryInput, setQueryInput] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<ListResult | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [loading, setLoading] = useState(true);

  const rangeError =
    filters.date_from && filters.date_to && filters.date_from > filters.date_to
      ? "Başlangıç tarihi bitiş tarihinden sonra olamaz."
      : null;

  // A reference that cannot be resolved (other tab, storage cleared) is dropped instead of filtering silently.
  const staleRef = cpRef !== null && counterpartyText === null;

  const setFilters = useCallback(
    (next: ListFilters) => {
      setOffset(0);
      let ref = cpRef;
      if (ref && (!next.counterparty_text || staleRef)) {
        dropDrillText(ref);
        ref = null;
      }
      router.replace(`/finance/entries${paramsFromFilters(next, ref)}`);
    },
    [router, cpRef, staleRef]
  );

  useEffect(() => {
    if (staleRef) setFilters(urlFilters);
  }, [staleRef, urlFilters, setFilters]);

  const update = (patch: Partial<ListFilters>) => setFilters({ ...filters, ...patch });

  // Search is sent after a short pause; the server matches with Turkish case folding. Kept out of the URL.
  useEffect(() => {
    const trimmed = queryInput.trim();
    if (trimmed === query) return;
    const t = setTimeout(() => {
      setOffset(0);
      setQuery(trimmed);
    }, 350);
    return () => clearTimeout(t);
  }, [queryInput, query]);

  const load = useCallback(async () => {
    if (rangeError || staleRef) return;
    setLoading(true);
    try {
      const query = filters.query ? filters.query.toLocaleLowerCase("tr-TR") : undefined;
      setData(await finList({ ...filters, query }, { offset, limit: PAGE_SIZE }));
      setError(null);
    } catch (err) {
      setError(toFinanceError(err));
    } finally {
      setLoading(false);
    }
  }, [filters, offset, rangeError, staleRef]);

  useEffect(() => {
    load();
  }, [load]);

  const categories = ref.data ? sortByOrder(ref.data.categories) : [];
  const counterpartyName = filters.counterparty_id
    ? ref.data?.counterparties.find((c) => c.id === filters.counterparty_id)?.name ?? "Seçili kişi / kurum"
    : null;
  const groupName =
    filters.report_group === "other"
      ? "Diğer borçlar"
      : filters.report_group
        ? ref.data?.report_groups.find((g) => g.id === filters.report_group)?.name ?? "Seçili grup"
        : null;

  const hasFilters = paramsFromFilters(filters, cpRef) !== "" || query !== "";

  return (
    <div className="space-y-4">
      <div className="bg-white p-4 rounded-lg shadow">
        <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
          <Field label="Durum">
            <select
              className={inputClass}
              value={filters.status ?? "all"}
              onChange={(e) => update({ status: e.target.value as StatusFilter })}
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Kategori">
            <select
              className={inputClass}
              value={filters.category_id ?? ""}
              onChange={(e) => update({ category_id: e.target.value || undefined })}
            >
              <option value="">Tümü</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.is_active ? "" : " (pasif)"}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Yön">
            <select
              className={inputClass}
              value={filters.direction ?? ""}
              onChange={(e) => update({ direction: (e.target.value || undefined) as Direction | undefined })}
            >
              <option value="">Tümü</option>
              <option value="in">Kliniğe giriş</option>
              <option value="out">Klinikten çıkış</option>
            </select>
          </Field>
          <Field label="Ara" className="xl:col-span-3">
            <input
              className={inputClass}
              placeholder="Kişi / kurum veya açıklama"
              value={queryInput}
              maxLength={100}
              onChange={(e) => setQueryInput(e.target.value)}
            />
          </Field>
          <Field label="Başlangıç (vade)">
            <input
              type="date"
              className={inputClass}
              value={filters.date_from ?? ""}
              onChange={(e) => update({ date_from: e.target.value || undefined })}
            />
          </Field>
          <Field label="Bitiş (vade)">
            <input
              type="date"
              className={inputClass}
              value={filters.date_to ?? ""}
              onChange={(e) => update({ date_to: e.target.value || undefined })}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-gray-800 md:mt-6">
            <input
              type="checkbox"
              checked={!!filters.overdue}
              onChange={(e) => update({ overdue: e.target.checked || undefined })}
            />
            Yalnızca vadesi geçenler
          </label>
          <div className="flex items-end gap-2 xl:col-span-3">
            {(filters.date_from || filters.date_to) && (
              <button
                type="button"
                className={buttonSecondary}
                onClick={() => update({ date_from: undefined, date_to: undefined })}
              >
                Tarihleri temizle
              </button>
            )}
            {hasFilters && (
              <button
                type="button"
                className={buttonSecondary}
                onClick={() => {
                  setQueryInput("");
                  setQuery("");
                  setFilters({});
                }}
              >
                Filtreleri temizle
              </button>
            )}
            {canWrite && (
              <Link href="/finance/entries/new" className={`${buttonPrimary} ml-auto`}>
                Ödeme / tahsilat ekle
              </Link>
            )}
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-2">Tarih filtresi vade / işlem tarihine uygulanır; başlangıç ve bitiş günleri dahildir.</p>
        {(counterpartyName || filters.counterparty_text || groupName) && (
          <div className="flex flex-wrap gap-2 mt-3">
            {counterpartyName && (
              <Chip label={`Kişi / kurum: ${counterpartyName}`} onClear={() => update({ counterparty_id: undefined })} />
            )}
            {filters.counterparty_text && (
              <Chip
                label={`Kişi / kurum: ${filters.counterparty_text}`}
                onClear={() => update({ counterparty_text: undefined })}
              />
            )}
            {groupName && (
              <Chip label={`Açık borç grubu: ${groupName}`} onClear={() => update({ report_group: undefined })} />
            )}
          </div>
        )}
      </div>

      {rangeError && <div className="p-4 rounded bg-red-50 text-red-700 text-sm">{rangeError}</div>}
      <ErrorBox error={error} onReload={load} />

      {!data && loading ? (
        <Loading />
      ) : data ? (
        <>
          {loading && <p className="text-sm text-gray-500">Güncelleniyor...</p>}
          <EntryTable rows={data.rows} emptyText="Bu filtrelere uyan kayıt yok." />
          <Pager offset={data.offset} limit={data.limit} total={data.total_count} onChange={setOffset} disabled={loading} />
          <ListTotalsBox totals={data.totals} />
        </>
      ) : null}
    </div>
  );
}

function Chip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-50 text-blue-800 text-sm">
      {label}
      <button type="button" onClick={onClear} className="hover:text-blue-950" aria-label="Filtreyi kaldır">
        ✕
      </button>
    </span>
  );
}
