// Automatic nightly backup status (migration 0029). The nightly GitHub Actions job of the private repository
// 'dentos-yedek' calls public.backup_heartbeat after every verified, encrypted backup; the owner reads the newest run
// through the SECURITY DEFINER RPC public.backup_status() (owner only, one DB-wide backup, no clinic scoping).

import type { createClient } from "./supabase";
import { formatIstanbulDateTime } from "./staff";

export type Db = ReturnType<typeof createClient>;

export interface BackupLastRun {
  ran_at: string;
  size_bytes: number;
  toc_entries: number;
}

export interface BackupStatusResponse {
  ok: true;
  last: BackupLastRun | null;
  /** Server clock at the time of the call; ages are computed against it, so a wrong PC clock does not matter. */
  now: string;
}

export type BackupStatusResult =
  | { kind: "ok"; data: BackupStatusResponse }
  /** backup_status does not exist yet (0029 not applied). */
  | { kind: "missing" }
  /** 42501: not the clinic owner (the page is owner-only, so this is unexpected). */
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

/** "Older than 36 hours" turns the box amber (the job runs every night at 02:30 Istanbul time). */
export const BACKUP_STALE_HOURS = 36;
const HOUR_MS = 60 * 60 * 1000;

export const BACKUP_TEXTS = {
  none: "Henüz otomatik yedek alınmadı",
  noneDetail:
    "Gece yedeği kurulduğunda (dentos-yedek deposu, KURULUM.md) burada son yedeğin zamanı görünür. O zamana kadar aşağıdaki JSON yedeğini düzenli indirin.",
  staleDetail:
    "Son 36 saatte otomatik yedek alınmadı. GitHub'da dentos-yedek → Actions → Gece yedeği sayfasındaki son çalıştırmaya bakın (kırmızıysa hata e-postası da gelmiş olmalı).",
  freshDetail: "Her gece 02:30'da alınır, şifrelenir ve 30 gün saklanır; her ayın ilk yedeği 12 ay saklanır.",
  missing: "Otomatik yedek durumu henüz görüntülenemiyor: veritabanı güncellemesi (0029) uygulanmamış.",
  error: "Otomatik yedek durumu alınamadı.",
  network: "Bağlantınızı kontrol edip sayfayı yenileyin.",
} as const;

const MISSING_CODES = new Set(["PGRST202", "42883"]);

function isLastRun(v: unknown): v is BackupLastRun {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.ran_at === "string" && typeof r.size_bytes === "number" && typeof r.toc_entries === "number";
}

export function isBackupStatusResponse(v: unknown): v is BackupStatusResponse {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return r.ok === true && typeof r.now === "string" && (r.last === null || isLastRun(r.last));
}

export async function fetchBackupStatus(db: Db): Promise<BackupStatusResult> {
  let result: { data: unknown; error: unknown };
  try {
    result = await db.rpc("backup_status");
  } catch {
    return { kind: "error", message: BACKUP_TEXTS.network };
  }
  if (result.error) {
    const e = result.error as { code?: unknown; message?: unknown };
    const code = typeof e.code === "string" ? e.code : "";
    if (MISSING_CODES.has(code)) return { kind: "missing" };
    if (code === "42501") return { kind: "forbidden" };
    const message = typeof e.message === "string" && e.message ? e.message : BACKUP_TEXTS.network;
    return { kind: "error", message: code ? message : BACKUP_TEXTS.network };
  }
  if (!isBackupStatusResponse(result.data)) return { kind: "error", message: "Beklenmeyen yanıt." };
  return { kind: "ok", data: result.data };
}

const SIZE_FMT = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });

/** Decimal units like the Finder / GitHub show them: 950 B, 12,3 MB, 1,2 GB. */
export function formatBackupSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${SIZE_FMT.format(value)} ${units[unit]}`;
}

/** "az önce", "12 dakika önce", "5 saat önce" (up to 47 hours), then "3 gün önce". */
export function formatBackupAge(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 60_000) return "az önce";
  if (safe < HOUR_MS) return `${Math.floor(safe / 60_000)} dakika önce`;
  if (safe < 48 * HOUR_MS) return `${Math.floor(safe / HOUR_MS)} saat önce`;
  return `${Math.floor(safe / (24 * HOUR_MS))} gün önce`;
}

export type BackupTone = "green" | "amber" | "gray";

export interface BackupStatusView {
  tone: BackupTone;
  title: string;
  detail: string | null;
}

/** What the export page shows; null = show nothing (a non-owner never reaches the page). */
export function describeBackupStatus(result: BackupStatusResult, clientNow: Date = new Date()): BackupStatusView | null {
  switch (result.kind) {
    case "forbidden":
      return null;
    case "missing":
      return { tone: "gray", title: BACKUP_TEXTS.missing, detail: null };
    case "error":
      return { tone: "gray", title: BACKUP_TEXTS.error, detail: result.message };
    case "ok": {
      const last = result.data.last;
      if (!last) return { tone: "amber", title: BACKUP_TEXTS.none, detail: BACKUP_TEXTS.noneDetail };
      const ranAt = new Date(last.ran_at).getTime();
      const serverNow = new Date(result.data.now).getTime();
      const now = Number.isFinite(serverNow) ? serverNow : clientNow.getTime();
      if (!Number.isFinite(ranAt)) return { tone: "gray", title: BACKUP_TEXTS.error, detail: "Beklenmeyen yanıt." };
      const age = now - ranAt;
      const stale = age > BACKUP_STALE_HOURS * HOUR_MS;
      const title = `Otomatik yedek: son yedek ${formatBackupAge(age)} (${formatBackupSize(last.size_bytes)})`;
      const when = `${formatIstanbulDateTime(last.ran_at)} (İstanbul)`;
      return stale
        ? { tone: "amber", title, detail: `${when}. ${BACKUP_TEXTS.staleDetail}` }
        : { tone: "green", title, detail: `${when}. ${BACKUP_TEXTS.freshDetail}` };
    }
  }
}
