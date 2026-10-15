"use client";

// Password reset and first-time password setup (spec p10_platform §4.2-4.3). Invite e-mails land here with
// `type=invite` ("Şifrenizi belirleyin"); recovery e-mails (also "Daveti yeniden gönder") with `type=recovery`.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { PASSWORD_TEXTS, newPasswordError, passwordUpdateErrorMessage } from "@/lib/password";

const inputClass =
  "w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500";

type Mode = "setup" | "reset";

const EXPIRED_TEXT =
  "Bağlantının süresi dolmuş veya bağlantı daha önce kullanılmış. Klinik yöneticinizden daveti yeniden göndermesini isteyin ya da giriş sayfasındaki “Şifremi unuttum” bağlantısını kullanın.";

/** Sign-in methods an invite / recovery e-mail link produces (GoTrue `amr`). A password login's tokens are refused. */
const LINK_AMR = new Set(["invite", "recovery", "otp", "magiclink"]);

/** Tokens from an e-mail link, held until the person confirms the account (never applied silently). */
interface PendingLink {
  accessToken: string;
  refreshToken: string;
  email: string;
  currentEmail: string | null;
}

/** Reads (does not verify) the access token's payload; the server verifies it when the session is set. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isLinkSession(payload: Record<string, unknown>): boolean {
  const amr = payload.amr;
  if (!Array.isArray(amr)) return false;
  return amr.some((m) => {
    const method = typeof m === "string" ? m : m && typeof m === "object" ? (m as { method?: unknown }).method : null;
    return typeof method === "string" && LINK_AMR.has(method);
  });
}

export default function ResetPasswordPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("reset");
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [linkError, setLinkError] = useState(false);
  const [noLink, setNoLink] = useState(false);
  const [pending, setPending] = useState<PendingLink | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    // The form opens only after a link: a validated and confirmed implicit link, a successful PKCE code exchange, or
    // a PASSWORD_RECOVERY event (the client exchanged this browser's own "Şifremi unuttum" code). A standing session
    // alone never opens it, and a plain SIGNED_IN event does not either.
    let resolveRecovery: () => void = () => {};
    const recovery = new Promise<void>((resolve) => {
      resolveRecovery = resolve;
    });
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" && session) {
        resolveRecovery();
        if (!cancelled) {
          setEmail(session.user.email ?? null);
          setLinkError(false);
          setNoLink(false);
          setReady(true);
          setChecking(false);
        }
      }
    });

    const init = async () => {
      const hash = new URLSearchParams(window.location.hash.slice(1));
      const query = new URLSearchParams(window.location.search);
      const type = hash.get("type") ?? query.get("type");
      if (type === "invite") setMode("setup");

      const accessToken = hash.get("access_token");
      const refreshToken = hash.get("refresh_token");
      const code = query.get("code");
      const hashError = hash.get("error_code") || hash.get("error") || query.get("error_code") || query.get("error");

      if (hashError) {
        // Expired or already used link (e-mail scanners sometimes open links first). No session is set.
        window.history.replaceState(null, "", window.location.pathname);
        if (!cancelled) {
          setLinkError(true);
          setChecking(false);
        }
        return;
      }

      if (accessToken && refreshToken) {
        // Invite and recovery e-mails use the implicit flow. The tokens are NOT applied yet: a link carrying someone
        // else's tokens would otherwise silently replace this browser's session (login CSRF).
        window.history.replaceState(null, "", window.location.pathname);
        const payload = type === "invite" || type === "recovery" ? decodeJwtPayload(accessToken) : null;
        const linkEmail = payload && typeof payload.email === "string" ? payload.email : "";
        if (!payload || !linkEmail || !isLinkSession(payload)) {
          if (!cancelled) {
            setLinkError(true);
            setChecking(false);
          }
          return;
        }
        const { data: cur } = await supabase.auth.getSession();
        if (!cancelled) {
          setPending({
            accessToken,
            refreshToken,
            email: linkEmail,
            currentEmail: cur.session?.user.email ?? null,
          });
          setChecking(false);
        }
        return;
      }

      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        window.history.replaceState(null, "", window.location.pathname);
        let ok = !error;
        if (!ok) {
          // The client may already have exchanged this browser's own recovery code itself; then PASSWORD_RECOVERY
          // follows right away. Wait briefly for it instead of showing "invalid link".
          ok = await Promise.race([
            recovery.then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
          ]);
        }
        if (ok) {
          const { data } = await supabase.auth.getUser();
          if (!cancelled) {
            setEmail(data.user?.email ?? null);
            setReady(true);
          }
        } else if (!cancelled) {
          setLinkError(true);
        }
        if (!cancelled) setChecking(false);
        return;
      }

      // Opened without a link: never offer a password change for whatever session this browser holds.
      if (!cancelled) {
        setNoLink(true);
        setChecking(false);
      }
    };

    init();

    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
    };
  }, []);

  const acceptLink = async () => {
    if (!pending || confirming) return;
    setConfirming(true);
    try {
      const supabase = createClient();
      const { error: sessionError } = await supabase.auth.setSession({
        access_token: pending.accessToken,
        refresh_token: pending.refreshToken,
      });
      if (sessionError) {
        setPending(null);
        setLinkError(true);
        return;
      }
      const { data } = await supabase.auth.getUser();
      setEmail(data.user?.email ?? pending.email);
      setPending(null);
      setReady(true);
    } finally {
      setConfirming(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const invalid = newPasswordError(password, confirm);
    if (invalid) {
      setError(invalid);
      return;
    }

    setSaving(true);
    try {
      const supabase = createClient();
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      router.push("/dashboard");
    } catch (err) {
      console.error("Error updating password:", err);
      setError(passwordUpdateErrorMessage(err));
      setSaving(false);
    }
  };

  const setup = mode === "setup";
  const showForm = !checking && ready && !linkError && !pending;
  const showConfirm = !checking && !ready && !linkError && !!pending;
  const showInvalid = !checking && !ready && !pending && (linkError || !noLink);
  const otherSession =
    !!pending?.currentEmail && pending.currentEmail.trim().toLowerCase() !== pending.email.trim().toLowerCase();

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-blue-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl p-8 space-y-6">
        <div className="text-center space-y-2">
          <span className="text-5xl">🦷</span>
          <h1 className="text-2xl font-bold text-gray-900">
            {/* An expired / used link redirects with #error=… and no type, so the title must not guess the mode. */}
            {linkError ? "Bağlantı geçersiz" : setup ? "Şifrenizi belirleyin" : "Yeni Şifre Belirle"}
          </h1>
          {showForm && (
            <p className="text-sm text-gray-600">
              {setup
                ? "DentOS'a hoş geldiniz. Giriş yaparken kullanacağınız şifreyi belirleyin."
                : "İlk kez giriş yapıyorsanız burada belirlediğiniz şifreyle giriş yapacaksınız."}
            </p>
          )}
        </div>

        {checking && <p className="text-center text-gray-600">Bağlantı kontrol ediliyor...</p>}

        {showConfirm && pending && (
          <div className="space-y-4">
            <div className="text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-2">
              <p>
                Bu bağlantı <span className="font-semibold break-all">{pending.email}</span> hesabı içindir.
              </p>
              {otherSession && (
                <p className="text-amber-800">
                  Bu tarayıcıda <span className="font-semibold break-all">{pending.currentEmail}</span> ile oturum
                  açık; devam ederseniz bu oturum kapanır.
                </p>
              )}
              <p className="text-xs text-gray-500">Bu adres sizin değilse “Vazgeç”e basın.</p>
            </div>
            <div className="flex flex-col-reverse sm:flex-row gap-2">
              <button
                type="button"
                onClick={() => router.push("/login")}
                disabled={confirming}
                className="w-full py-3 border border-gray-300 text-gray-800 rounded-lg font-semibold hover:bg-gray-50"
              >
                Vazgeç
              </button>
              <button
                type="button"
                onClick={() => void acceptLink()}
                disabled={confirming}
                className="w-full py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 disabled:bg-gray-500"
              >
                {confirming ? "Kontrol ediliyor..." : "Devam et"}
              </button>
            </div>
          </div>
        )}

        {!checking && !ready && !pending && noLink && !linkError && (
          <div className="space-y-4 text-center">
            <p className="text-gray-700 bg-gray-50 border border-gray-200 rounded-lg p-4">
              Bu sayfa yalnız e-postadaki bağlantıyla açılabilir. Şifrenizi unuttuysanız giriş sayfasındaki “Şifremi
              unuttum” bağlantısıyla yeni bir bağlantı isteyin.
            </p>
            <Link href="/login" className="text-blue-600 hover:underline">
              Giriş sayfasına dön
            </Link>
          </div>
        )}

        {showInvalid && (
          <div className="space-y-4 text-center">
            <p className="text-red-700 bg-red-50 border border-red-200 rounded-lg p-4">
              {linkError
                ? EXPIRED_TEXT
                : setup
                  ? "Bu davet bağlantısı geçersiz veya süresi dolmuş. Klinik yöneticinizden daveti yeniden göndermesini isteyin."
                  : "Bu bağlantı geçersiz veya süresi dolmuş. Lütfen yeni bir şifre sıfırlama bağlantısı isteyin."}
            </p>
            <Link href="/login" className="text-blue-600 hover:underline">
              Giriş sayfasına dön
            </Link>
          </div>
        )}

        {showForm && (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700">{error}</div>}

            {email && (
              <div className="text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-lg p-3">
                <p>
                  Giriş e-postanız: <span className="font-semibold break-all">{email}</span>
                </p>
                <p className="text-xs text-gray-500 mt-1">Bu adres sizin değilse şifre belirlemeden sayfayı kapatın.</p>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{setup ? "Şifre" : "Yeni şifre"}</label>
              <input
                type="password"
                className={inputClass}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
              <p className="text-xs text-gray-500 mt-1">{PASSWORD_TEXTS.hint}</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {setup ? "Şifre (tekrar)" : "Yeni şifre (tekrar)"}
              </label>
              <input
                type="password"
                className={inputClass}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </div>

            <button
              type="submit"
              disabled={saving}
              className="w-full py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 disabled:bg-gray-500"
            >
              {saving ? "Kaydediliyor..." : setup ? "Şifremi kaydet ve giriş yap" : "Şifreyi Kaydet"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
