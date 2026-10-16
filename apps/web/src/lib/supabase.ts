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
 * Security trade-off: with the implicit flow the session tokens travel in the URL fragment (never sent to a server,
 * but readable by the page and possibly kept in the browser history until /reset-password removes them), and anyone
 * holding the e-mailed link can use it, where a PKCE link was useless without this browser's verifier. The e-mail
 * itself is still the proof of identity, as for invites; the link is single use and short lived (the project's
 * e-mail OTP expiry), and /reset-password accepts only invite / recovery tokens issued for an e-mail link, asks the
 * person to confirm the account before applying them, and clears the fragment at once.
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
