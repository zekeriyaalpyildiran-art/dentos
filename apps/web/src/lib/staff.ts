// Phase 10 staff management (spec p10_platform §2.4, §4.1, §5.1-5.2, §6.1).
// Every write goes through the SECURITY DEFINER RPC plt_staff_save; invitations go through the Edge Function
// `invite-staff`. The list flags (can_edit, can_invite, …) come from plt_staff_list and are never re-derived here.

import type { createClient } from "./supabase";
import type { UserRole } from "./auth";

export type Db = ReturnType<typeof createClient>;

export const STAFF_ROLES: readonly UserRole[] = ["owner", "admin", "doctor", "assistant", "reception"];

export function isStaffRole(value: string): value is UserRole {
  return (STAFF_ROLES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Shapes (§2.4.1)
// ---------------------------------------------------------------------------

export type LoginStatus = "none" | "missing" | "invited" | "active";

/** For status 'active' only last_sign_in_at is filled; the other timestamps are null (0027 review fix). */
export interface LoginInfo {
  status: LoginStatus;
  invited_at: string | null;
  last_sign_in_at: string | null;
  email_confirmed_at: string | null;
  /** Last recovery e-mail ("Daveti yeniden gönder" or "Şifremi unuttum"); 0027 review addition. */
  recovery_sent_at?: string | null;
  /** greatest(invited_at, recovery_sent_at), computed by 0027. */
  link_sent_at?: string | null;
}

export interface StaffItem {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  role: UserRole;
  is_active: boolean;
  updated_at: string;
  is_me: boolean;
  email_placeholder: boolean;
  doctor: { id: string; specialty: string | null } | null;
  login: LoginInfo;
  can_edit: boolean;
  can_change_role_active: boolean;
  /**
   * The row holds finance / finance_readonly and the caller is neither the owner nor a 'finance' holder: no invite
   * (PLT_INVITE_FINANCE) and no e-mail change (PLT_EMAIL_FINANCE). Optional for builds older than this 0027.
   */
  finance_locked?: boolean;
  can_invite: boolean;
  can_resend: boolean;
}

export interface StaffListResponse {
  ok: true;
  me: { user_id: string; role: UserRole };
  can_assign_owner: boolean;
  staff: StaffItem[];
}

export interface StaffSaveInput {
  id: string;
  /** NULL for a create; the row's updated_at for an edit (optimistic check). */
  expectedUpdatedAt: string | null;
  full_name: string;
  email: string;
  phone: string;
  role: string;
  is_active: boolean;
  specialty: string;
}

export interface StaffSaveResult {
  ok: true;
  already_saved: boolean;
  changed: boolean;
  user: StaffItem;
}

// ---------------------------------------------------------------------------
// Shared predicates (§1.4; SQL twins in 0027, vectors in §6.3)
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^[0-9 +()-]+$/;
const PLACEHOLDER_DOMAINS = ["local", "localhost", "test", "invalid", "example"];

export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

export function isValidEmail(email: string | null | undefined): boolean {
  const e = normalizeEmail(email);
  return e.length > 0 && e.length <= 254 && EMAIL_RE.test(e);
}

/** D3: domain local / localhost / test / invalid / example, or a subdomain of one. `example.com` is real. */
export function isPlaceholderEmail(email: string | null | undefined): boolean {
  const e = normalizeEmail(email);
  const at = e.lastIndexOf("@");
  if (at < 0) return false;
  const domain = e.slice(at + 1);
  return PLACEHOLDER_DOMAINS.some((d) => domain === d || domain.endsWith("." + d));
}

// ---------------------------------------------------------------------------
// Texts (§1.2; the server is authoritative, these mirror it for instant feedback)
// ---------------------------------------------------------------------------

export const STAFF_TEXTS = {
  name: "Ad soyad 2–120 karakter olmalı.",
  email: "Geçerli bir e-posta adresi girin.",
  phone: "Telefon en fazla 30 karakter olmalı; yalnız rakam, boşluk, +, (, ) ve - kullanılabilir.",
  role: "Geçerli bir rol seçin.",
  specialty: "Uzmanlık en fazla 120 karakter olabilir.",
} as const;

/**
 * `stored` (edit only): the saved e-mail / phone. Like plt_staff_save, an unchanged value is not re-validated, so a
 * row saved before Phase 10 with a legacy phone or e-mail can still be edited (e.g. deactivated).
 */
export function validateStaffForm(
  form: {
    full_name: string;
    email: string;
    phone: string;
    role: string;
    specialty: string;
  },
  stored?: { email: string | null; phone: string | null }
): string | null {
  const name = form.full_name.trim();
  if (name.length < 2 || name.length > 120) return STAFF_TEXTS.name;
  const emailUnchanged = !!stored && normalizeEmail(stored.email) === normalizeEmail(form.email);
  if (!emailUnchanged && !isValidEmail(form.email)) return STAFF_TEXTS.email;
  const phone = form.phone.trim();
  const phoneUnchanged = !!stored && (stored.phone ?? "").trim() === phone;
  if (!phoneUnchanged && phone !== "" && (phone.length > 30 || !PHONE_RE.test(phone))) return STAFF_TEXTS.phone;
  if (!isStaffRole(form.role)) return STAFF_TEXTS.role;
  if (form.specialty.trim().length > 120) return STAFF_TEXTS.specialty;
  return null;
}

// ---------------------------------------------------------------------------
// Time and login status (§4.1)
// ---------------------------------------------------------------------------

const ISTANBUL_FMT = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** 'dd.MM.yyyy HH:mm' in Istanbul time; empty / unparsable → "—". */
export function formatIstanbulDateTime(ts: string | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const parts: Record<string, string> = {};
  for (const p of ISTANBUL_FMT.formatToParts(d)) parts[p.type] = p.value;
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.day}.${parts.month}.${parts.year} ${hour}:${parts.minute}`;
}

export type StatusTone = "gray" | "amber" | "green" | "red";

export const INVITE_STALE_MS = 24 * 60 * 60 * 1000;

function timeOf(ts: string | null | undefined): number {
  if (!ts) return NaN;
  const t = new Date(ts).getTime();
  return Number.isNaN(t) ? NaN : t;
}

export function loginStatusLabel(
  login: LoginInfo | null | undefined,
  now: Date = new Date()
): { text: string; tone: StatusTone; hint: string | null } {
  switch (login?.status) {
    case "active":
      return {
        text: login.last_sign_in_at
          ? `Aktif · son giriş ${formatIstanbulDateTime(login.last_sign_in_at)}`
          : "Aktif",
        tone: "green",
        hint: null,
      };
    case "invited": {
      // "Daveti yeniden gönder" uses the recovery flow (recovery_sent_at), so the newest link decides the age.
      const invitedAt = timeOf(login.invited_at);
      const recoveryAt = timeOf(login.recovery_sent_at);
      const resent = Number.isFinite(recoveryAt) && (!Number.isFinite(invitedAt) || recoveryAt > invitedAt);
      const at = resent ? recoveryAt : invitedAt;
      const stale = Number.isFinite(at) && now.getTime() - at > INVITE_STALE_MS;
      const text = resent
        ? `Bağlantı yeniden gönderildi · ${formatIstanbulDateTime(login.recovery_sent_at)}`
        : login.invited_at
          ? `Davet gönderildi · ${formatIstanbulDateTime(login.invited_at)}`
          : "Davet gönderildi";
      return {
        text,
        tone: stale ? "amber" : "gray",
        hint: stale ? "süresi dolmuş olabilir" : null,
      };
    }
    case "missing":
      return { text: "Hesap bulunamadı", tone: "red", hint: null };
    default:
      return { text: "Yok", tone: "gray", hint: null };
  }
}

// ---------------------------------------------------------------------------
// RPC wrappers
// ---------------------------------------------------------------------------

export class StaffError extends Error {
  code: string | null;
  /** HINT key such as 'PLT_VERSION'; null for users_guard texts and transport errors. */
  key: string | null;

  constructor(message: string, code: string | null, key: string | null) {
    super(message);
    this.name = "StaffError";
    this.code = code;
    this.key = key;
  }
}

export const STAFF_NETWORK_MESSAGE = "İşlem tamamlanamadı. Bağlantınızı kontrol edip tekrar deneyin.";
export const STAFF_MODULE_MISSING_MESSAGE =
  "Personel yönetimi güncelleniyor. Birkaç dakika sonra sayfayı yenileyin.";

const MISSING_CODES = new Set(["PGRST202", "42883"]);

export function toStaffError(err: unknown): StaffError {
  if (err instanceof StaffError) return err;
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; code?: unknown; hint?: unknown };
    const message = typeof e.message === "string" ? e.message : "";
    const code = typeof e.code === "string" && e.code ? e.code : null;
    const key = typeof e.hint === "string" && e.hint ? e.hint : null;
    if (code && MISSING_CODES.has(code)) return new StaffError(STAFF_MODULE_MISSING_MESSAGE, code, key);
    if (!code && (!message || /fetch|network|timeout|load failed/i.test(message))) {
      return new StaffError(STAFF_NETWORK_MESSAGE, null, null);
    }
    return new StaffError(message || STAFF_NETWORK_MESSAGE, code, key);
  }
  return new StaffError(STAFF_NETWORK_MESSAGE, null, null);
}

export function isStaffModuleMissing(err: StaffError | null | undefined): boolean {
  return !!err && !!err.code && MISSING_CODES.has(err.code);
}

async function callRpc<T>(db: Db, name: string, args?: Record<string, unknown>): Promise<T> {
  let result: { data: unknown; error: unknown };
  try {
    result = args ? await db.rpc(name, args) : await db.rpc(name);
  } catch (err) {
    throw toStaffError(err);
  }
  if (result.error) throw toStaffError(result.error);
  return result.data as T;
}

export function listStaff(db: Db): Promise<StaffListResponse> {
  return callRpc<StaffListResponse>(db, "plt_staff_list");
}

export function saveStaff(db: Db, input: StaffSaveInput): Promise<StaffSaveResult> {
  return callRpc<StaffSaveResult>(db, "plt_staff_save", {
    p_id: input.id,
    p_expected_updated_at: input.expectedUpdatedAt,
    p_full_name: input.full_name,
    p_email: input.email,
    p_phone: input.phone,
    p_role: input.role,
    p_is_active: input.is_active,
    p_specialty: input.specialty,
  });
}

/** Fresh client id for a create; reused for every retry of the same dialog. */
export function newStaffId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Invitations (§3, §6.1)
// ---------------------------------------------------------------------------

export type InviteAction = "invite" | "resend";

export interface InviteData {
  ok: true;
  action: InviteAction;
  user_id: string;
  email: string;
  login_status: "invited";
  invited_at?: string | null;
}

export type InviteResult =
  | { ok: true; data: InviteData }
  | { ok: false; message: string; code?: string };

export const INVITE_TEXTS = {
  notDeployed: "Davet servisi bulunamadı. Edge Function kurulumunu kontrol edin (docs/edge-functions.md).",
  // In a browser a missing function (404) or a gateway JWT refusal (401) carries no CORS headers, so it surfaces as
  // a fetch error; this text therefore names both causes.
  unreachable:
    "Davet servisine ulaşılamadı. İnternet bağlantınızı kontrol edin; sorun sürerse davet servisinin (Edge Function invite-staff) kurulu olduğunu kontrol edin.",
  failed: "Davet gönderilemedi. Lütfen tekrar deneyin.",
  sessionExpired: "Oturum bulunamadı veya süresi dolmuş. Lütfen yeniden giriş yapın.",
} as const;

interface ErrorBody {
  ok?: unknown;
  code?: unknown;
  message?: unknown;
}

async function readErrorBody(context: unknown): Promise<{ status: number | null; body: ErrorBody | null }> {
  if (!context || typeof context !== "object") return { status: null, body: null };
  const res = context as { status?: unknown; json?: unknown };
  const status = typeof res.status === "number" ? res.status : null;
  if (typeof res.json !== "function") return { status, body: null };
  try {
    const body = (await (res.json as () => Promise<unknown>).call(res)) as unknown;
    return { status, body: body && typeof body === "object" ? (body as ErrorBody) : null };
  } catch {
    return { status, body: null };
  }
}

/**
 * Calls the `invite-staff` Edge Function. Errors are identified by name rather than `instanceof`, so a second copy
 * of functions-js (the SSR client bundles its own) still maps correctly.
 */
export async function inviteStaff(db: Db, userId: string, action: InviteAction): Promise<InviteResult> {
  let result: { data: unknown; error: unknown };
  try {
    result = await db.functions.invoke("invite-staff", { body: { action, user_id: userId } });
  } catch {
    return { ok: false, message: INVITE_TEXTS.unreachable };
  }

  const { data, error } = result;
  if (!error) {
    const d = data as Partial<InviteData> | null;
    if (d && d.ok === true) return { ok: true, data: d as InviteData };
    return { ok: false, message: INVITE_TEXTS.failed };
  }

  const name = (error as { name?: unknown }).name;
  if (name === "FunctionsHttpError") {
    const { status, body } = await readErrorBody((error as { context?: unknown }).context);
    if (body && body.ok === false && typeof body.message === "string" && body.message) {
      return {
        ok: false,
        message: body.message,
        code: typeof body.code === "string" ? body.code : undefined,
      };
    }
    if (status === 404) return { ok: false, message: INVITE_TEXTS.notDeployed, code: "FN_NOT_FOUND" };
    if (status === 401) return { ok: false, message: INVITE_TEXTS.sessionExpired, code: "FN_AUTH" };
    return { ok: false, message: INVITE_TEXTS.failed };
  }
  if (name === "FunctionsRelayError" || name === "FunctionsFetchError") {
    return { ok: false, message: INVITE_TEXTS.unreachable };
  }
  return { ok: false, message: INVITE_TEXTS.failed };
}
