// Yönetim panel (idari işler müdürü, owner's workflow 2026-11-06): the recurring checklist (0040 mgmt_checklist_*
// RPCs, owner and admins only) and the pure helpers the page uses. The alert boxes reuse the read RPCs of the pages
// they point to (CRM · Bugün, Görevler, Stok, Lab); nothing here is a security boundary.

import { createClient } from "./supabase";
import { toCrmError } from "./crm";

export type Frequency = "daily" | "weekly" | "monthly";
export type Area = "stok" | "finans" | "personel" | "hasta" | "genel";

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  daily: "Günlük",
  weekly: "Haftalık",
  monthly: "Aylık",
};

export const AREA_LABELS: Record<Area, string> = {
  stok: "Stok",
  finans: "Finans",
  personel: "Personel",
  hasta: "Hasta akışı",
  genel: "Genel",
};

export const AREA_STYLES: Record<Area, string> = {
  stok: "bg-amber-100 text-amber-800",
  finans: "bg-emerald-100 text-emerald-800",
  personel: "bg-sky-100 text-sky-800",
  hasta: "bg-violet-100 text-violet-800",
  genel: "bg-gray-100 text-gray-700",
};

/** ISO weekday 1 = Pazartesi … 7 = Pazar. */
export const WEEKDAY_LABELS = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"] as const;
export const WEEKDAY_SHORT = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"] as const;

export interface ChecklistItem {
  id: string;
  title: string;
  detail: string;
  area: Area;
  frequency: Frequency;
  weekdays: number[];
  weekday: number | null;
  month_day: number | null;
  link_href: string | null;
  sort_order: number;
  is_active: boolean;
  active_from: string;
}

export interface BoardItem extends ChecklistItem {
  period_start: string;
  due_date: string;
  done: boolean;
  done_at: string | null;
  done_by: string | null;
  done_by_name: string | null;
  note: string;
}

export interface MissedItem {
  item_id: string;
  title: string;
  area: Area;
  frequency: Frequency;
  period_start: string;
  due_date: string;
  link_href: string | null;
}

export interface Board {
  today: string;
  date: string;
  role: string;
  items: BoardItem[];
  summary: { from: string; to: string; expected: number; done: number; missed: MissedItem[] };
}

export interface ItemInput {
  id?: string | null;
  title: string;
  detail: string;
  area: Area;
  frequency: Frequency;
  weekdays: number[];
  weekday: number | null;
  month_day: number | null;
  link_href: string | null;
  sort_order: number;
  is_active?: boolean;
}

let client: ReturnType<typeof createClient> | null = null;
function sb() {
  if (!client) client = createClient();
  return client;
}

async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  let result: { data: unknown; error: unknown };
  try {
    result = args ? await sb().rpc(name, args) : await sb().rpc(name);
  } catch (err) {
    throw toCrmError(err);
  }
  if (result.error) throw toCrmError(result.error);
  return result.data as T;
}

export const mgmtBoard = (date: string | null) => rpc<Board>("mgmt_checklist_board", { p_date: date });
export const mgmtItems = () => rpc<ChecklistItem[]>("mgmt_checklist_items_list");
export const mgmtMark = (itemId: string, date: string, done: boolean, note: string) =>
  rpc<{ item_id: string; period_start: string; done: boolean }>("mgmt_checklist_mark", {
    p_item_id: itemId,
    p_date: date,
    p_done: done,
    p_note: note,
  });
export const mgmtSaveItem = (item: ItemInput) => rpc<ChecklistItem>("mgmt_checklist_save_item", { p_item: item });

/** Lab jobs that came back from the lab ('ready'), read under the lab_orders RLS (head count only). */
export async function labReadyCount(): Promise<number> {
  const { count, error } = await sb().from("lab_orders").select("id", { count: "exact", head: true }).eq("status", "ready");
  if (error) throw toCrmError(error);
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The payload the RPC expects: only the schedule fields of the chosen frequency. */
export function itemPayload(form: ItemInput): ItemInput {
  return {
    ...form,
    title: form.title.trim(),
    detail: form.detail.trim(),
    weekdays: form.frequency === "daily" ? form.weekdays : [],
    weekday: form.frequency === "weekly" ? form.weekday : null,
    month_day: form.frequency === "monthly" ? form.month_day : null,
  };
}


/** "2026-11-06" + n days (calendar arithmetic in UTC, no time-zone drift). */
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** ISO weekday of a "YYYY-MM-DD" date (1 = Monday … 7 = Sunday). */
export function isoWeekday(iso: string): number {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

export function dayLabel(iso: string): string {
  return `${formatDay(iso)} ${WEEKDAY_LABELS[isoWeekday(iso) - 1]}`;
}

/** When an item is due, in words ("Her gün (Pzt–Cmt)", "Her Pazartesi", "Her ayın 5'i"). */
export function scheduleLabel(item: Pick<ChecklistItem, "frequency" | "weekdays" | "weekday" | "month_day">): string {
  if (item.frequency === "weekly") return `Her ${WEEKDAY_LABELS[(item.weekday ?? 1) - 1]}`;
  if (item.frequency === "monthly") return `Her ayın ${item.month_day}. günü`;
  const days = [...item.weekdays].sort((a, b) => a - b);
  if (days.length === 7) return "Her gün";
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  if (contiguous && days.length > 2) {
    return `Her gün (${WEEKDAY_SHORT[days[0] - 1]}–${WEEKDAY_SHORT[days[days.length - 1] - 1]})`;
  }
  return days.map((d) => WEEKDAY_SHORT[d - 1]).join(", ");
}

export type DueState = "done" | "late" | "today" | "upcoming";

/** State of a board row on `date`: done, past its due day, due on `date`, or due later in its period. */
export function dueState(item: Pick<BoardItem, "done" | "due_date">, date: string): DueState {
  if (item.done) return "done";
  if (item.due_date < date) return "late";
  if (item.due_date === date) return "today";
  return "upcoming";
}

/** Percentage (0–100, rounded) of done over expected; null when nothing was expected. */
export function completionRate(done: number, expected: number): number | null {
  if (expected <= 0) return null;
  return Math.round((done / expected) * 100);
}

/** Groups the board rows: daily, then weekly and monthly ("Bu hafta", "Bu ay"). */
export function groupBoard(items: BoardItem[]): { key: Frequency; title: string; rows: BoardItem[] }[] {
  const titles: Record<Frequency, string> = { daily: "Bugün", weekly: "Bu hafta", monthly: "Bu ay" };
  return (["daily", "weekly", "monthly"] as Frequency[])
    .map((key) => ({ key, title: titles[key], rows: items.filter((i) => i.frequency === key) }))
    .filter((g) => g.rows.length > 0);
}
