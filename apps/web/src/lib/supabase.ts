import { createBrowserClient } from "@supabase/ssr";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";

export const createClient = () =>
  createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

let recoveryClient: SupabaseClient | null = null;

/**
 * A separate client used ONLY to ask for a "Şifremi unuttum" e-mail (supabase.auth.resetPasswordForEmail).
 *
 * The app's own client (createClient above) uses PKCE, the @supabase/ssr default. A PKCE recovery link carries a
 * ?code= that can only be exchanged with the code verifier kept in the browser that asked, so a request made from the
 * iPhone home-screen app and opened from Mail in Safari (separate storage), or on another device, always failed. This
 * client uses the implicit flow instead, as the invite and "Daveti yeniden gönder" e-mails already do (Edge Function
 * invite-staff): the e-mailed link is verified by Supabase and lands on /reset-password#access_token=…&type=recovery,
 * which works in any browser. The e-mail template is unchanged ({{ .ConfirmationURL }} serves both flows).
 *
 * Security trade-off: with the implicit flow the link's session tokens travel in the URL fragment. The fragment is
 * never sent to a server, but the page can read it, and the browser may keep the visited address, fragment included,
 * in its global history (history.replaceState on /reset-password only rewrites the tab's own entry). Anyone holding
 * the e-mailed link, or able to read that history on a shared PC, holds those tokens, where a PKCE link was useless
 * without this browser's code verifier. The e-mail is still the proof of identity, as for invites (which have always
 * worked this way). The e-mailed verification link is single use and short lived (the project's e-mail OTP expiry),
 * but the refresh token it lands with does not expire on its own, so /reset-password
 *  - accepts only invite / recovery tokens issued for an e-mail link and asks the person to confirm the account
 *    before applying them (never silently);
 *  - rotates the refresh token right after applying it (refreshSession): the copy in the history is refused once
 *    GoTrue's reuse interval (about 10 s) has passed, and a later reuse revokes that session altogether;
 *  - revokes the link's session when the person declines it ("Vazgeç") or leaves the page without confirming
 *    (revokeLinkSession below).
 * The access token itself stays valid until it expires (the project's JWT expiry, 1 h by default); nothing in the
 * browser can shorten that.
 *
 * This client keeps nothing: no session is persisted (memory only, own storage key, so it never touches or warns
 * about the app's session cookies), no token refresh, no URL detection.
 */
function createRecoveryRequestClient(): SupabaseClient {
  if (!recoveryClient) {
    recoveryClient = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: {
          flowType: "implicit",
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
          storageKey: "dentos-recovery-request",
        },
      }
    );
  }
  return recoveryClient;
}

/** Sends the "Şifremi unuttum" e-mail; its link opens `redirectTo` (this origin's /reset-password) in any browser. */
export function requestPasswordResetEmail(email: string, redirectTo: string) {
  return createRecoveryRequestClient().auth.resetPasswordForEmail(email, { redirectTo });
}

/** The session tokens an e-mail link landed with (implicit flow). */
export interface LinkTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Ends the session an e-mail link brought (GoTrue `POST /logout?scope=local`: that session only, never the account's
 * other sessions), so the link's tokens left in the browser history are useless afterwards. /reset-password calls it
 * when the person declines the link or leaves the page without confirming it. If the access token has expired by then
 * (the page was left open), the refresh token is used once to get a fresh one, and that session is ended.
 *
 * `keepalive` lets the request outlive the page (on `pagehide`); that is best effort, a browser may drop it. Never
 * throws; true when the session was ended.
 */
export async function revokeLinkSession(
  tokens: LinkTokens,
  { keepalive = false }: { keepalive?: boolean } = {}
): Promise<boolean> {
  try {
    const auth = `${(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "")}/auth/v1`;
    const apikey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
    const logout = (accessToken: string) =>
      fetch(`${auth}/logout?scope=local`, {
        method: "POST",
        keepalive,
        headers: { apikey, Authorization: `Bearer ${accessToken}` },
      });
    const res = await logout(tokens.accessToken);
    if (res.ok) return true;
    // 401 / 403: the access token expired (or its session is already gone; then the refresh below fails too).
    if (res.status !== 401 && res.status !== 403) return false;
    const refreshed = await fetch(`${auth}/token?grant_type=refresh_token`, {
      method: "POST",
      keepalive,
      headers: { apikey, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: tokens.refreshToken }),
    });
    if (!refreshed.ok) return false;
    const body: unknown = await refreshed.json();
    const accessToken = (body as { access_token?: unknown } | null)?.access_token;
    if (typeof accessToken !== "string" || !accessToken) return false;
    return (await logout(accessToken)).ok;
  } catch {
    return false;
  }
}
