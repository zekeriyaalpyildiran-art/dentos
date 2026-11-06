"use client";

// Yönetim (idari işler müdürü, owner's workflow 2026-11-06): what needs attention now (alert tiles from the pages'
// own read RPCs), the day's routine checklist (0040 mgmt_checklist_board / _mark) and, for everyone here, how the
// routine went over the last 14 days. Owner and admins only (layout + mgmt__require).

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAuthStore } from "@/lib/store";
import { crmWorkList, staffTaskList, type CrmError } from "@/lib/crm";
import { stockItemLevels, stockWorkCounts } from "@/lib/stock/rpc";
import { canManageStock } from "@/lib/stock/permissions";
import {
  AREA_LABELS,
  AREA_STYLES,
  FREQUENCY_LABELS,
  addDays,
  completionRate,
  dayLabel,
  dueState,
  formatDay,
  groupBoard,
  labReadyCount,
  mgmtBoard,
  mgmtMark,
  scheduleLabel,
  type Board,
  type BoardItem,
} from "@/lib/mgmt";
import { toCrmError } from "@/lib/crm";
import {
  Badge,
  Card,
  CrmErrorBox,
  CrmModal,
  EmptyState,
  Loading,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from "@/components/crm/ui";
import { ChecklistItemsEditor } from "@/components/mgmt/ChecklistItemsEditor";

interface Alert {
  key: string;
  label: string;
  value: number | null;
  href: string;
  tone: "red" | "amber" | "blue";
}

const TONES: Record<Alert["tone"], string> = {
  red: "border-red-200 bg-red-50 text-red-800",
  amber: "border-amber-200 bg-amber-50 text-amber-900",
  blue: "border-blue-200 bg-blue-50 text-blue-900",
};

function settledValue<T>(r: PromiseSettledResult<T>, pick: (v: T) => number | undefined): number | null {
  if (r.status !== "fulfilled" || r.value == null) return null;
  const n = pick(r.value);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

async function loadAlerts(stockManager: boolean): Promise<Alert[]> {
  const [work, tasks, critical, rooms, lab] = await Promise.allSettled([
    crmWorkList({ p_filter: "all", p_user_id: null, p_page: { offset: 0, limit: 1 } }),
    staffTaskList({ p_scope: "all", p_page: { offset: 0, limit: 1 } }),
    stockItemLevels({ status: "critical" }, { offset: 0, limit: 1 }),
    stockManager ? stockWorkCounts() : Promise.resolve(null),
    labReadyCount(),
  ]);
  const alerts: Alert[] = [
    { key: "crm_overdue", label: "Geciken CRM işi", value: settledValue(work, (w) => w.counts?.overdue), href: "/crm/today", tone: "red" },
    { key: "crm_today", label: "Bugünkü CRM işi", value: settledValue(work, (w) => w.counts?.today), href: "/crm/today", tone: "blue" },
    { key: "tasks_overdue", label: "Gecikmiş görev", value: settledValue(tasks, (t) => t.counts?.overdue), href: "/tasks", tone: "red" },
    { key: "tasks_open", label: "Açık görev", value: settledValue(tasks, (t) => t.counts?.open), href: "/tasks", tone: "blue" },
    { key: "stock_critical", label: "Kritik stok kartı", value: settledValue(critical, (s) => s.total), href: "/inventory/items?status=critical", tone: "amber" },
    {
      key: "room_requests",
      label: "Bekleyen oda talebi",
      value: settledValue(rooms, (r) => (r && r.can_manage !== false ? (r.room_requests?.pending ?? 0) + (r.room_requests?.approved ?? 0) : undefined)),
      href: "/inventory/requests",
      tone: "amber",
    },
    { key: "lab_ready", label: "Lab'dan gelen iş", value: settledValue(lab, (n) => n), href: "/lab", tone: "blue" },
  ];
  return alerts.filter((a) => a.value !== null);
}

const STATE_STYLES = {
  done: "bg-green-100 text-green-800",
  late: "bg-red-100 text-red-800",
  today: "bg-amber-100 text-amber-900",
  upcoming: "bg-gray-100 text-gray-700",
} as const;

function stateLabel(item: BoardItem, date: string): string {
  const s = dueState(item, date);
  if (s === "done") return "Yapıldı";
  if (s === "late") return `Gecikti (${formatDay(item.due_date)})`;
  if (s === "today") return item.frequency === "daily" ? "Bugün" : "Bugün son gün";
  return `Son gün ${formatDay(item.due_date)}`;
}

function timeOf(ts: string | null): string {
  if (!ts) return "";
  return new Intl.DateTimeFormat("tr-TR", {
    timeZone: "Europe/Istanbul",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));
}

export default function YonetimPage() {
  const user = useAuthStore((s) => s.user);
  const me = user?.user_id ?? "";
  const isOwner = user?.role === "owner";
  const stockManager = canManageStock(user);
  const [date, setDate] = useState<string | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState<CrmError | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<BoardItem | null>(null);
  const [noteText, setNoteText] = useState("");
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      setBoard(await mgmtBoard(date));
      setError(null);
    } catch (err) {
      setError(toCrmError(err));
    }
  }, [date]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let alive = true;
    loadAlerts(stockManager)
      .then((a) => alive && setAlerts(a))
      .catch(() => alive && setAlerts([]));
    return () => {
      alive = false;
    };
  }, [stockManager]);

  const toggle = async (item: BoardItem, done: boolean, note = item.note) => {
    if (!board) return;
    setBusyId(item.id);
    try {
      await mgmtMark(item.id, board.date, done, note);
      await load();
    } catch (err) {
      setError(toCrmError(err));
    } finally {
      setBusyId(null);
    }
  };

  const saveNote = async () => {
    if (!noteFor) return;
    const item = noteFor;
    setNoteFor(null);
    await toggle(item, true, noteText);
  };

  if (!board && !error) return <div className="p-8"><Loading /></div>;

  const today = board?.today ?? "";
  const viewDate = board?.date ?? "";
  const canGoBack = board ? viewDate > addDays(today, -7) : false;
  const groups = board ? groupBoard(board.items) : [];
  const dayDone = board ? board.items.filter((i) => i.done).length : 0;
  const rate = board ? completionRate(board.summary.done, board.summary.expected) : null;

  return (
    <div className="p-4 sm:p-8 text-gray-900 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Yönetim</h1>
          <p className="text-sm text-gray-600 mt-1">
            İdari işlerin günlük, haftalık ve aylık rutini. Yapılan her madde kimin, ne zaman yaptığıyla kaydedilir.
          </p>
        </div>
        <button type="button" className={buttonSecondary} onClick={() => setEditing(true)}>
          Maddeleri düzenle
        </button>
      </div>

      <CrmErrorBox error={error} />

      {/* Alerts */}
      <section aria-label="Dikkat bekleyenler">
        <h2 className="text-lg font-semibold mb-2">Dikkat bekleyenler</h2>
        {alerts === null ? (
          <Loading />
        ) : alerts.length === 0 ? (
          <p className="text-sm text-gray-500">Uyarı bilgisi alınamadı.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
            {alerts.map((a) => (
              <Link
                key={a.key}
                href={a.href}
                className={`rounded-lg border p-3 hover:shadow ${a.value ? TONES[a.tone] : "border-gray-200 bg-white text-gray-500"}`}
              >
                <div className="text-2xl font-bold">{a.value}</div>
                <div className="text-xs mt-1">{a.label}</div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {board && (
        <>
          {/* Checklist */}
          <Card
            title={
              <span>
                Kontrol listesi · {dayLabel(viewDate)}
                <span className="ml-2 text-sm font-normal text-gray-500">
                  {dayDone}/{board.items.length} yapıldı
                </span>
              </span>
            }
            actions={
              <>
                <button
                  type="button"
                  className={buttonSecondary}
                  disabled={!canGoBack}
                  onClick={() => setDate(addDays(viewDate, -1))}
                >
                  ← Önceki gün
                </button>
                <button
                  type="button"
                  className={buttonSecondary}
                  disabled={viewDate >= today}
                  onClick={() => setDate(viewDate >= addDays(today, -1) ? null : addDays(viewDate, 1))}
                >
                  Sonraki gün →
                </button>
              </>
            }
          >
            {viewDate !== today && (
              <p className="mb-3 text-sm text-amber-800">
                Geçmiş bir günü görüyorsunuz. Geç işaretlenen maddelerde işaretleme saati ayrıca görünür.
              </p>
            )}
            {groups.length === 0 ? (
              <EmptyState>Bu gün için madde yok.</EmptyState>
            ) : (
              <div className="space-y-5">
                {groups.map((g) => (
                  <div key={g.key}>
                    <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-2">{g.title}</h3>
                    <ul className="divide-y border rounded">
                      {g.rows.map((item) => {
                        const st = dueState(item, viewDate);
                        const canUnmark = item.done && (item.done_by === me || isOwner);
                        return (
                          <li key={item.id} className="p-3 flex flex-wrap items-start gap-3">
                            <input
                              type="checkbox"
                              className="mt-1 h-5 w-5"
                              aria-label={item.title}
                              checked={item.done}
                              disabled={busyId === item.id || (item.done && !canUnmark)}
                              onChange={(e) => toggle(item, e.target.checked)}
                            />
                            <div className="flex-1 min-w-[14rem]">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className={`font-medium ${item.done ? "line-through text-gray-500" : ""}`}>
                                  {item.title}
                                </span>
                                <Badge className={AREA_STYLES[item.area]}>{AREA_LABELS[item.area]}</Badge>
                                <Badge className={STATE_STYLES[st]}>{stateLabel(item, viewDate)}</Badge>
                              </div>
                              {item.detail && <p className="text-sm text-gray-600 mt-0.5">{item.detail}</p>}
                              {item.done && (
                                <p className="text-xs text-gray-500 mt-1">
                                  {item.done_by_name ?? "—"} · {timeOf(item.done_at)}
                                  {item.note && <span className="text-gray-700"> · Not: {item.note}</span>}
                                </p>
                              )}
                            </div>
                            <div className="flex gap-2">
                              {item.link_href && (
                                <Link href={item.link_href} className="text-sm text-blue-700 hover:underline">
                                  Aç →
                                </Link>
                              )}
                              {(!item.done || canUnmark) && (
                                <button
                                  type="button"
                                  className="text-sm text-gray-600 hover:underline"
                                  onClick={() => {
                                    setNoteFor(item);
                                    setNoteText(item.note);
                                  }}
                                >
                                  {item.done ? "Notu düzenle" : "Notla işaretle"}
                                </button>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Summary */}
          <Card title={`Son 14 gün (${formatDay(board.summary.from)} – ${formatDay(board.summary.to)})`}>
            {board.summary.expected === 0 ? (
              <EmptyState>Henüz değerlendirilecek gün yok; maddeler eklendiği günden itibaren sayılır.</EmptyState>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-end gap-6">
                  <div>
                    <div className="text-3xl font-bold">%{rate}</div>
                    <div className="text-xs text-gray-500">zamanında / geç işaretlenen</div>
                  </div>
                  <div className="text-sm text-gray-700">
                    {board.summary.done} / {board.summary.expected} madde yapıldı ·{" "}
                    <span className={board.summary.missed.length ? "text-red-700 font-medium" : ""}>
                      {board.summary.expected - board.summary.done} yapılmadı
                    </span>
                  </div>
                </div>
                {board.summary.missed.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold mb-1">Yapılmayanlar</h3>
                    <ul className="text-sm divide-y border rounded">
                      {board.summary.missed.map((m) => (
                        <li key={`${m.item_id}:${m.period_start}`} className="px-3 py-2 flex flex-wrap gap-2 items-center">
                          <span className="text-gray-500 w-36 shrink-0">{dayLabel(m.due_date)}</span>
                          <span className="flex-1 min-w-[12rem]">{m.title}</span>
                          <Badge className="bg-gray-100 text-gray-700">{FREQUENCY_LABELS[m.frequency]}</Badge>
                          <Badge className={AREA_STYLES[m.area]}>{AREA_LABELS[m.area]}</Badge>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </Card>
        </>
      )}

      {noteFor && board && (
        <CrmModal title={noteFor.title} description={`${scheduleLabel(noteFor)} · ${dayLabel(board.date)}`} onClose={() => setNoteFor(null)}>
          <textarea
            className={`${inputClass} h-28`}
            maxLength={1000}
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="Örn. kasa farkı 150 TL, nedeni…"
            autoFocus
          />
          <div className="flex justify-end gap-2 mt-3">
            <button type="button" className={buttonSecondary} onClick={() => setNoteFor(null)}>
              Vazgeç
            </button>
            <button type="button" className={buttonPrimary} onClick={saveNote}>
              {noteFor.done ? "Notu kaydet" : "Yapıldı olarak kaydet"}
            </button>
          </div>
        </CrmModal>
      )}

      {editing && (
        <ChecklistItemsEditor
          onClose={() => {
            setEditing(false);
            load();
          }}
        />
      )}
    </div>
  );
}
