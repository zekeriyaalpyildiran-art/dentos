// What an e-mail link brought to /reset-password (invite, "Daveti yeniden gönder", "Şifremi unuttum"). Pure helpers
// without a Supabase import, so they are unit-tested. Nothing here verifies a token: the server does that when the
// session is set; these only decide which links the page may offer to apply at all.
//
// Invite and recovery e-mails use the implicit flow: GoTrue verifies the e-mailed token and redirects to
// /reset-password#access_token=…&refresh_token=…&type=invite|recovery. A recovery asked for before 2026-10-16 from
// the login page used PKCE and lands with ?code=… instead; that code only works in the browser that asked.

/** Link types the page accepts tokens for. Anything else (magic link, signup, e-mail change…) is refused. */
export const ACCEPTED_LINK_TYPES = ["invite", "recovery"] as const;
export type AcceptedLinkType = (typeof ACCEPTED_LINK_TYPES)[number];

/** Sign-in methods an invite / recovery e-mail link produces (GoTrue `amr`). A password login's tokens are refused. */
const LINK_AMR = new Set(["invite", "recovery", "otp", "magiclink"]);

export type AuthLink =
  /** GoTrue sent an error (expired or already used link; e-mail scanners sometimes open links first). */
  | { kind: "error"; type: string | null }
  /** Implicit flow: tokens in the fragment, with the fragment's own `type`. */
  | { kind: "tokens"; type: string | null; accessToken: string; refreshToken: string }
  /** PKCE flow: a one-time code in the query (works only where its code verifier is stored). */
  | { kind: "code"; type: string | null; code: string }
  /** Opened without a link. */
  | { kind: "none"; type: string | null };

function params(part: string, lead: string): URLSearchParams {
  return new URLSearchParams(part.startsWith(lead) ? part.slice(1) : part);
}

/**
 * Reads `location.hash` and `location.search`. An error wins over everything else; tokens are taken from the fragment
 * only, together with the fragment's `type` (a `?type=` in the query never vouches for fragment tokens).
 */
export function parseAuthLink(hash: string, search: string): AuthLink {
  const h = params(hash ?? "", "#");
  const q = params(search ?? "", "?");
  const type = h.get("type") ?? q.get("type");

  if (h.get("error_code") || h.get("error") || q.get("error_code") || q.get("error")) {
    return { kind: "error", type };
  }
  const accessToken = h.get("access_token");
  const refreshToken = h.get("refresh_token");
  if (accessToken && refreshToken) {
    return { kind: "tokens", type: h.get("type"), accessToken, refreshToken };
  }
  const code = q.get("code");
  if (code) return { kind: "code", type, code };
  return { kind: "none", type };
}

/** True when the fragment carries auth tokens or an auth error (the site root passes such a link on). */
export function isAuthCallbackHash(hash: string): boolean {
  return /(^#|&)(access_token|error_code|error)=/.test(hash ?? "");
}

/** "setup" (first password, invite) or "reset" (everything else, including links whose type is unknown). */
export function linkMode(type: string | null | undefined): "setup" | "reset" {
  return type === "invite" ? "setup" : "reset";
}

export function isAcceptedLinkType(type: string | null | undefined): type is AcceptedLinkType {
  return (ACCEPTED_LINK_TYPES as readonly string[]).includes(type ?? "");
}

/** Reads (does not verify) a JWT's payload; null when it is not a JWT with a JSON object payload. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
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

/** True when the token's `amr` names an e-mail link sign-in (never a password login). */
export function isLinkSession(payload: Record<string, unknown>): boolean {
  const amr = payload.amr;
  if (!Array.isArray(amr)) return false;
  return amr.some((m) => {
    const method = typeof m === "string" ? m : m && typeof m === "object" ? (m as { method?: unknown }).method : null;
    return typeof method === "string" && LINK_AMR.has(method);
  });
}

/**
 * The e-mail address implicit-flow tokens are for, or null when the page must refuse them: the fragment's type is not
 * invite / recovery, the access token is not a readable JWT with an e-mail, or it was not issued for an e-mail link.
 * The page then shows "Bağlantı geçersiz" and never applies the tokens.
 */
export function linkTokenEmail(link: AuthLink): string | null {
  if (link.kind !== "tokens" || !isAcceptedLinkType(link.type)) return null;
  const payload = decodeJwtPayload(link.accessToken);
  if (!payload || !isLinkSession(payload)) return null;
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  return email || null;
}

/** Where invite and recovery e-mails land. Both production domains have it in the Supabase redirect allow-list. */
export const RESET_PASSWORD_PATH = "/reset-password";

/** `redirectTo` for a "Şifremi unuttum" request: the page's own origin, so the link returns to the domain in use. */
export function resetPasswordRedirectUrl(origin: string): string {
  return origin.replace(/\/+$/, "") + RESET_PASSWORD_PATH;
}
