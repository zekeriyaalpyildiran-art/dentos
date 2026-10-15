// DentOS Edge Function: invite-staff
//
// Personel daveti (action "invite") ve davetin yeniden gönderimi (action "resend").
// Yalnız AKTİF klinik sahibi (owner) veya yönetici (admin) çağırabilir; bütün yetki ve
// hedef kontrolleri migration 0027'deki service-role fonksiyonlarında yapılır
// (plt_svc_invite_context, plt_svc_link_auth_user, plt_svc_log_staff_event).
//
// Tek dosya, Deno. Supabase Dashboard → Edge Functions → Deploy a new function → Via Editor
// ile bu dosyanın tamamı yapıştırılarak kurulur (docs/edge-functions.md).
//
// Ortam değişkenleri (Supabase otomatik sağlar): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. İsteğe bağlı secret'lar: SITE_URL (varsayılan
// https://dentos-eight.vercel.app) ve ALLOW_LOCAL_ORIGIN ("1" ise http://localhost:3002 de CORS
// izni alır; yalnız yerel test sırasında, sonra silinmeli). Davet ve yeniden gönderim
// e-postaları SITE_URL + "/reset-password" adresine yönlenir.
//
// İstek:  POST { "action": "invite" | "resend", "user_id": "<users.id>" }
// Yanıt:  200 { ok: true, ... }  |  4xx/5xx { ok: false, code, message }
//
// Güvenlik kuralları:
// - Yanıtlarda ve loglarda anahtar, JWT, access/refresh token, davet/kurtarma bağlantısı,
//   hashed_token, e-posta OTP, auth kullanıcı nesnesi veya auth kullanıcı id'si yer almaz.
// - Loglarda e-posta adresi, ad soyad ve istek gövdesi yer almaz.
// - "Deneme" (dry run) modu yoktur: yan etkisiz bir deneme, bir e-posta adresinin herhangi bir
//   klinikte giriş hesabı olup olmadığını öğrenmeye yarardı. Kontroller test aracında doğrudan
//   plt_svc_invite_context ile (service role) denenir.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// ---------------------------------------------------------------------------
// Sabitler
// ---------------------------------------------------------------------------

const TAG = "[invite-staff]";
const DEFAULT_SITE_URL = "https://dentos-eight.vercel.app";
const FIXED_ORIGINS = ["https://dentos-eight.vercel.app"];
const LOCAL_ORIGIN = "http://localhost:3002";
const MAX_BODY_BYTES = 4096;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ALLOWED_BODY_KEYS = new Set(["action", "user_id"]);

type Action = "invite" | "resend";

const FN_ERRORS = {
  FN_METHOD: { status: 405, message: "Bu adres yalnız POST isteği kabul eder." },
  FN_ORIGIN: { status: 403, message: "Bu adresten gelen isteklere izin verilmiyor." },
  FN_AUTH: {
    status: 401,
    message: "Oturum bulunamadı veya süresi dolmuş. Lütfen yeniden giriş yapın.",
  },
  FN_BAD_REQUEST: { status: 400, message: "İstek geçersiz." },
  FN_RATE_LIMIT: {
    status: 429,
    message: "Kısa sürede çok fazla e-posta gönderildi. Birkaç dakika sonra tekrar deneyin.",
  },
  FN_SEND_FAILED: {
    status: 502,
    message:
      "E-posta gönderilemedi. Biraz sonra tekrar deneyin; sorun sürerse e-posta (SMTP) ayarlarını kontrol edin.",
  },
  FN_CONFIG: {
    status: 500,
    message: "Davet servisi yapılandırması eksik. Sistem yöneticisine bildirin.",
  },
  FN_INTERNAL: { status: 500, message: "Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin." },
} as const;

type FnErrorCode = keyof typeof FN_ERRORS;

// GoTrue'dan "bu e-posta zaten kayıtlı" cevabı geldiğinde kullanılan metin (§1.2 PLT_EMAIL_IN_USE).
const PLT_EMAIL_IN_USE_TEXT =
  "Bu e-posta adresiyle zaten bir giriş hesabı var. Güvenlik nedeniyle mevcut hesap personele otomatik bağlanmaz; farklı bir e-posta girin veya destekle iletişime geçin.";
// GoTrue adresi geçersiz bulduğunda (§1.2 PLT_EMAIL_INVALID).
const PLT_EMAIL_INVALID_TEXT = "Personelin e-posta adresi geçersiz. Önce personel kaydını düzeltin.";

const EMAIL_EXISTS_CODES = new Set(["email_exists", "user_already_exists"]);
const RATE_LIMIT_CODES = new Set(["over_email_send_rate_limit", "over_request_rate_limit"]);

// ---------------------------------------------------------------------------
// Yapılandırma ve CORS
// ---------------------------------------------------------------------------

interface Config {
  supabaseUrl: string;
  serviceRoleKey: string;
  siteUrl: string;
  redirectTo: string;
}

/** SITE_URL'i doğrular: https, ya da localhost/127.0.0.1 için http. Sondaki "/" kaldırılır. */
function parseSiteUrl(raw: string | undefined): string | null {
  const value = (raw ?? "").trim() || DEFAULT_SITE_URL;
  const stripped = value.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(stripped);
  } catch {
    return null;
  }
  const isLocalHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "https:") return stripped;
  if (url.protocol === "http:" && isLocalHost) return stripped;
  return null;
}

function loadConfig(): Config | null {
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").trim();
  const serviceRoleKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  const siteUrl = parseSiteUrl(Deno.env.get("SITE_URL"));
  if (!supabaseUrl || !serviceRoleKey || siteUrl === null) return null;
  return { supabaseUrl, serviceRoleKey, siteUrl, redirectTo: `${siteUrl}/reset-password` };
}

function allowedOrigins(): Set<string> {
  const origins = new Set<string>(FIXED_ORIGINS);
  // Yerel geliştirme yalnız açıkça istenirse (secret ALLOW_LOCAL_ORIGIN = 1).
  if ((Deno.env.get("ALLOW_LOCAL_ORIGIN") ?? "").trim() === "1") origins.add(LOCAL_ORIGIN);
  const siteUrl = parseSiteUrl(Deno.env.get("SITE_URL"));
  if (siteUrl !== null) {
    try {
      origins.add(new URL(siteUrl).origin);
    } catch {
      // parseSiteUrl zaten doğruladı; buraya düşmez.
    }
  }
  return origins;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
  };
}

/**
 * Bütün JSON yanıtları buradan çıkar: CORS (yalnız izinli Origin için) + no-store.
 * corsOrigin: izinli istek Origin'i ya da null (Origin yok veya izinsiz).
 */
function json(status: number, body: Record<string, unknown>, corsOrigin: string | null): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (corsOrigin !== null) Object.assign(headers, corsHeaders(corsOrigin));
  return new Response(JSON.stringify(body), { status, headers });
}

function fnError(code: FnErrorCode, corsOrigin: string | null): Response {
  const e = FN_ERRORS[code];
  return json(e.status, { ok: false, code, message: e.message }, corsOrigin);
}

// ---------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Yalnız kod/durum loglanır; e-posta, ad, token, gövde asla. */
function logEvent(level: "log" | "error", event: string, fields: Record<string, unknown>): void {
  const line = `${TAG} ${event} ${JSON.stringify(fields)}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

interface PgErrorInfo {
  code: string;
  hint: string;
  message: string;
}

function pgErrorInfo(err: unknown): PgErrorInfo {
  if (!isRecord(err)) return { code: "", hint: "", message: "" };
  return {
    code: str(err.code) ?? "",
    hint: str(err.hint) ?? "",
    message: str(err.message) ?? "",
  };
}

function statusForPgCode(code: string): number {
  if (code === "42501") return 403;
  if (code === "PT404") return 404;
  if (code === "PT409") return 409;
  return 400; // P0001 ve diğerleri
}

/**
 * PostgREST (admin.rpc) hatasını yanıta çevirir (§3.6):
 * - hint "PLT_" ile başlıyorsa: DB'nin Türkçe metni ve anahtarı;
 * - PGRST202 (fonksiyon yok: 0027 uygulanmamış): FN_CONFIG;
 * - diğer her şey: FN_INTERNAL (ham DB metni dışarı verilmez).
 */
function rpcErrorResponse(
  err: unknown,
  step: string,
  meta: { action: Action; user_id: string },
  corsOrigin: string | null,
): Response {
  const info = pgErrorInfo(err);
  if (info.hint.startsWith("PLT_") && info.message) {
    const status = statusForPgCode(info.code);
    logEvent("log", "refused", { step, ...meta, key: info.hint, pg_code: info.code, status });
    return json(status, { ok: false, code: info.hint, message: info.message }, corsOrigin);
  }
  if (info.code === "PGRST202") {
    logEvent("error", "rpc_missing", { step, ...meta, pg_code: info.code });
    return fnError("FN_CONFIG", corsOrigin);
  }
  logEvent("error", "rpc_failed", { step, ...meta, pg_code: info.code || null });
  return fnError("FN_INTERNAL", corsOrigin);
}

interface AuthErrorInfo {
  status: number | null;
  code: string | null;
}

function authErrorInfo(err: unknown): AuthErrorInfo {
  if (!isRecord(err)) return { status: null, code: null };
  return {
    status: typeof err.status === "number" ? err.status : null,
    code: str(err.code),
  };
}

function isRateLimited(info: AuthErrorInfo): boolean {
  return info.status === 429 || (info.code !== null && RATE_LIMIT_CODES.has(info.code));
}

// ---------------------------------------------------------------------------
// İstek gövdesi
// ---------------------------------------------------------------------------

interface ParsedBody {
  action: Action;
  userId: string;
}

async function readBody(req: Request): Promise<ParsedBody | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (!Number.isFinite(n) || n > MAX_BODY_BYTES) return null;
  }
  let text: string;
  try {
    text = await req.text();
  } catch {
    return null;
  }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_BODY_KEYS.has(key)) return null;
  }

  const action = parsed.action;
  if (action !== "invite" && action !== "resend") return null;

  const userId = parsed.user_id;
  if (typeof userId !== "string" || !UUID_RE.test(userId)) return null;

  return { action, userId: userId.toLowerCase() };
}

// ---------------------------------------------------------------------------
// plt_svc_invite_context sonucu
// ---------------------------------------------------------------------------

interface InviteContext {
  callerUserId: string;
  clinicName: string;
  targetEmail: string;
  targetFullName: string;
}

function parseContext(data: unknown): InviteContext | null {
  if (!isRecord(data) || data.ok !== true) return null;
  const target = data.target;
  if (!isRecord(target)) return null;
  const callerUserId = str(data.caller_user_id);
  const targetEmail = str(target.email);
  const targetFullName = str(target.full_name);
  if (!callerUserId || !targetEmail || targetFullName === null) return null;
  return {
    callerUserId,
    clinicName: str(data.clinic_name) ?? "",
    targetEmail,
    targetFullName,
  };
}

// ---------------------------------------------------------------------------
// Sunucu
// ---------------------------------------------------------------------------

const CLIENT_AUTH_OPTIONS = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
};

/** Service-role istemcisi (RLS'i aşar; yalnız bu fonksiyonun içinde kullanılır). */
function makeAdminClient(config: Config) {
  return createClient(config.supabaseUrl, config.serviceRoleKey, { auth: CLIENT_AUTH_OPTIONS });
}

type AdminClient = ReturnType<typeof makeAdminClient>;

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("origin");
  const origins = allowedOrigins();
  const corsOrigin = origin !== null && origins.has(origin) ? origin : null;

  // 1. CORS ön kontrolü, yöntem, Origin
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsOrigin !== null ? corsHeaders(corsOrigin) : {},
    });
  }
  if (req.method !== "POST") return fnError("FN_METHOD", corsOrigin);
  if (origin !== null && corsOrigin === null) return fnError("FN_ORIGIN", null);

  try {
    // 2. Yapılandırma
    const config = loadConfig();
    if (config === null) {
      logEvent("error", "config_missing", {});
      return fnError("FN_CONFIG", corsOrigin);
    }

    const admin = makeAdminClient(config);

    // 3. Çağıranın JWT'si
    const authHeader = req.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authHeader);
    const token = match ? match[1] : "";
    if (!token) return fnError("FN_AUTH", corsOrigin);

    const { data: userData, error: userError } = await admin.auth.getUser(token);
    if (userError) {
      const info = authErrorInfo(userError);
      logEvent("log", "auth_refused", { status: info.status, auth_code: info.code });
      return fnError("FN_AUTH", corsOrigin);
    }
    const callerAuthId = userData?.user?.id;
    if (typeof callerAuthId !== "string" || !callerAuthId) {
      return fnError("FN_AUTH", corsOrigin);
    }

    // 4. Gövde
    const body = await readBody(req);
    if (body === null) return fnError("FN_BAD_REQUEST", corsOrigin);
    const { action, userId } = body;
    const meta = { action, user_id: userId };

    // 5. Bütün PLT_* kontrolleri burada, herhangi bir e-postadan ÖNCE
    const { data: ctxData, error: ctxError } = await admin.rpc("plt_svc_invite_context", {
      p_caller_auth_id: callerAuthId,
      p_user_id: userId,
      p_action: action,
    });
    if (ctxError) return rpcErrorResponse(ctxError, "context", meta, corsOrigin);
    const ctx = parseContext(ctxData);
    if (ctx === null) {
      logEvent("error", "context_shape", meta);
      return fnError("FN_INTERNAL", corsOrigin);
    }

    // 6. İşlem
    if (action === "invite") {
      return await handleInvite(admin, config, ctx, userId, corsOrigin);
    }
    return await handleResend(admin, config, ctx, userId, corsOrigin);
  } catch (e) {
    logEvent("error", "unhandled", { kind: e instanceof Error ? e.name : typeof e });
    return fnError("FN_INTERNAL", corsOrigin);
  }
});

// ---------------------------------------------------------------------------
// invite (§3.5.1)
// ---------------------------------------------------------------------------

async function handleInvite(
  admin: AdminClient,
  config: Config,
  ctx: InviteContext,
  userId: string,
  corsOrigin: string | null,
): Promise<Response> {
  const meta = { action: "invite" as const, user_id: userId };

  // Hesap bu çağrıda mı oluşturuldu? Telafi silmesi yalnız bu andan sonra oluşturulmuş hesaba uygulanır.
  const startedAtMs = Date.now();

  const { data: inviteData, error: inviteError } = await admin.auth.admin.inviteUserByEmail(
    ctx.targetEmail,
    {
      redirectTo: config.redirectTo,
      data: { full_name: ctx.targetFullName, clinic_name: ctx.clinicName },
    },
  );

  if (inviteError) {
    const info = authErrorInfo(inviteError);
    logEvent("error", "invite_failed", { ...meta, status: info.status, auth_code: info.code });
    if (info.code !== null && EMAIL_EXISTS_CODES.has(info.code)) {
      return json(409, { ok: false, code: "PLT_EMAIL_IN_USE", message: PLT_EMAIL_IN_USE_TEXT }, corsOrigin);
    }
    if (isRateLimited(info)) return fnError("FN_RATE_LIMIT", corsOrigin);
    if (info.code === "email_address_invalid") {
      return json(400, { ok: false, code: "PLT_EMAIL_INVALID", message: PLT_EMAIL_INVALID_TEXT }, corsOrigin);
    }
    if (info.status === 422 && info.code === null) {
      // Kodsuz 422: eski GoTrue sürümlerinde "e-posta zaten kayıtlı" cevabı.
      return json(409, { ok: false, code: "PLT_EMAIL_IN_USE", message: PLT_EMAIL_IN_USE_TEXT }, corsOrigin);
    }
    return fnError("FN_SEND_FAILED", corsOrigin);
  }

  const invitedUser = inviteData?.user ?? null;
  const invitedAuthId = invitedUser && typeof invitedUser.id === "string" ? invitedUser.id : "";
  if (!invitedUser || !invitedAuthId) {
    // E-posta gönderilmiş olabilir ama bağlanacak hesap bilgisi yok.
    logEvent("error", "invite_no_user", meta);
    return fnError("FN_INTERNAL", corsOrigin);
  }

  const { data: linkData, error: linkError } = await admin.rpc("plt_svc_link_auth_user", {
    p_actor_user_id: ctx.callerUserId,
    p_user_id: userId,
    p_auth_user_id: invitedAuthId,
  });

  if (linkError) {
    await compensateFailedLink(admin, invitedUser, pgErrorInfo(linkError).hint, startedAtMs, meta);
    return rpcErrorResponse(linkError, "link", meta, corsOrigin);
  }

  const invitedAt =
    (isRecord(linkData) ? str(linkData.invited_at) : null) ??
    (typeof invitedUser.invited_at === "string" ? invitedUser.invited_at : null);

  logEvent("log", "invited", {
    ...meta,
    already_linked: isRecord(linkData) && linkData.already_linked === true,
  });

  return json(
    200,
    {
      ok: true,
      action: "invite",
      user_id: userId,
      email: ctx.targetEmail,
      login_status: "invited",
      invited_at: invitedAt,
    },
    corsOrigin,
  );
}

/** Telafi silmesinde saat farkı payı (GoTrue ile fonksiyon saatleri arasında). */
const COMPENSATE_CLOCK_SKEW_MS = 5000;
/** Yeni oluşturulan hesapta created_at ile invited_at arasındaki en büyük fark (aynı GoTrue isteği). */
const FRESH_INVITE_WINDOW_MS = 2000;

/**
 * Bu bağlama hataları eşzamanlı başka bir çağrıyı (veya kullanılmış bir hesabı) gösterir; hesap bu
 * çağrının olmayabilir, bu yüzden hiç silinmez.
 */
const COMPENSATE_SKIP_KEYS = new Set(["PLT_AUTH_TAKEN", "PLT_LINK_CONFLICT", "PLT_AUTH_MISSING", "PLT_EMAIL_IN_USE"]);

function timeMs(v: unknown): number | null {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

interface InvitedUserInfo {
  id: string;
  created_at?: unknown;
  invited_at?: unknown;
}

/**
 * Bağlama başarısız olduysa, YALNIZ bu çağrının az önce oluşturduğu auth hesabını kaldırır.
 * GoTrue, onaylanmamış mevcut bir hesaba tekrar davet gönderdiğinde hata vermez, o hesabı döndürür;
 * bu yüzden şu koşulların hepsi aranır, biri tutmazsa hiçbir şey silinmez:
 * - bağlama hatası eşzamanlı bir aktörü göstermiyor (COMPENSATE_SKIP_KEYS);
 * - davet yanıtındaki hesap yeni oluşturulmuş: created_at ile invited_at birbirine yakın ve
 *   created_at bu isteğin başlangıcından sonra (saat payıyla);
 * - yeniden okunan hesapta created_at ve invited_at davet yanıtındakiyle aynı (arada başka bir
 *   çağrı aynı hesaba yeniden davet göndermemiş);
 * - davet edilmiş, e-postası onaylanmamış, hiç giriş yapmamış;
 * - hiçbir users satırı ona bağlı değil.
 * Herhangi bir okuma hata verirse hiçbir şey silinmez. Sonuç yanıtı değiştirmez.
 * Kalan risk: iki çağrının aynı hesabı birkaç saniye içinde, ikisinin de bağlama yapmadan önce
 * görmesi; bu durumda en kötü sonuç bir davet e-postasının geçersiz kalmasıdır ("Davet gönder" yeniden denenir).
 */
async function compensateFailedLink(
  admin: AdminClient,
  invitedUser: InvitedUserInfo,
  linkHint: string,
  startedAtMs: number,
  meta: { action: Action; user_id: string },
): Promise<void> {
  const authUserId = invitedUser.id;
  try {
    if (COMPENSATE_SKIP_KEYS.has(linkHint)) {
      logEvent("log", "compensate_skipped", { ...meta, reason: "concurrent", key: linkHint });
      return;
    }

    const invCreatedMs = timeMs(invitedUser.created_at);
    const invInvitedMs = timeMs(invitedUser.invited_at);
    const freshInResponse =
      invCreatedMs !== null &&
      invInvitedMs !== null &&
      Math.abs(invInvitedMs - invCreatedMs) < FRESH_INVITE_WINDOW_MS &&
      invCreatedMs >= startedAtMs - COMPENSATE_CLOCK_SKEW_MS;
    if (!freshInResponse) {
      logEvent("log", "compensate_skipped", { ...meta, reason: "not_created_here" });
      return;
    }

    const { data: fresh, error: getError } = await admin.auth.admin.getUserById(authUserId);
    const u = fresh?.user ?? null;
    if (getError || !u) {
      const info = authErrorInfo(getError);
      logEvent("error", "compensate_read_failed", { ...meta, status: info.status, auth_code: info.code });
      return;
    }
    const sameAccount = timeMs(u.created_at) === invCreatedMs && timeMs(u.invited_at) === invInvitedMs;
    if (!sameAccount) {
      logEvent("log", "compensate_skipped", { ...meta, reason: "reinvited" });
      return;
    }
    const untouched =
      !u.email_confirmed_at && !u.last_sign_in_at && typeof u.invited_at === "string" && !!u.invited_at;
    if (!untouched) {
      logEvent("log", "compensate_skipped", { ...meta, reason: "used" });
      return;
    }

    const { data: rows, error: selError } = await admin
      .from("users")
      .select("id")
      .eq("auth_user_id", authUserId);
    if (selError || !Array.isArray(rows)) {
      logEvent("error", "compensate_check_failed", { ...meta, pg_code: pgErrorInfo(selError).code || null });
      return;
    }
    if (rows.length > 0) {
      logEvent("log", "compensate_skipped", { ...meta, reason: "linked", linked_rows: rows.length });
      return;
    }
    const { error: delError } = await admin.auth.admin.deleteUser(authUserId);
    if (delError) {
      const info = authErrorInfo(delError);
      logEvent("error", "compensate_delete_failed", { ...meta, status: info.status, auth_code: info.code });
      return;
    }
    logEvent("log", "compensate_deleted", meta);
  } catch (e) {
    logEvent("error", "compensate_threw", { ...meta, kind: e instanceof Error ? e.name : typeof e });
  }
}

// ---------------------------------------------------------------------------
// resend (§3.5.3)
// ---------------------------------------------------------------------------

async function handleResend(
  admin: AdminClient,
  config: Config,
  ctx: InviteContext,
  userId: string,
  corsOrigin: string | null,
): Promise<Response> {
  const meta = { action: "resend" as const, user_id: userId };

  // Implicit akış: e-postadaki bağlantı /reset-password#access_token=... ile döner.
  // (PKCE olsaydı kod doğrulayıcı tarayıcıda değil bu sunucuda kalırdı.)
  // Service-role anahtarıyla gönderilir: Auth CAPTCHA koruması açılırsa GoTrue anon çağrılardan
  // captcha token'ı ister, service role için istemez. Anahtar bu fonksiyondan çıkmaz.
  const pub = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { ...CLIENT_AUTH_OPTIONS, flowType: "implicit" },
  });

  const { error: sendError } = await pub.auth.resetPasswordForEmail(ctx.targetEmail, {
    redirectTo: config.redirectTo,
  });
  if (sendError) {
    const info = authErrorInfo(sendError);
    logEvent("error", "resend_failed", { ...meta, status: info.status, auth_code: info.code });
    if (isRateLimited(info)) return fnError("FN_RATE_LIMIT", corsOrigin);
    return fnError("FN_SEND_FAILED", corsOrigin);
  }

  // E-posta yola çıktı; denetim kaydı yazılamazsa yalnız loglanır.
  const { error: logError } = await admin.rpc("plt_svc_log_staff_event", {
    p_actor_user_id: ctx.callerUserId,
    p_user_id: userId,
    p_action: "invite_resend",
  });
  if (logError) {
    const info = pgErrorInfo(logError);
    logEvent("error", "resend_audit_failed", { ...meta, pg_code: info.code || null, key: info.hint || null });
  } else {
    logEvent("log", "resent", meta);
  }

  return json(
    200,
    {
      ok: true,
      action: "resend",
      user_id: userId,
      email: ctx.targetEmail,
      login_status: "invited",
    },
    corsOrigin,
  );
}
