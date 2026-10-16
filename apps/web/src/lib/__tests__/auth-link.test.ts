// E-mail links on /reset-password (lib/auth-link.ts) and the "Şifremi unuttum" request. Synthetic tokens only.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACCEPTED_LINK_TYPES,
  decodeJwtPayload,
  isAuthCallbackHash,
  isLinkSession,
  linkMode,
  linkTokenEmail,
  parseAuthLink,
  resetPasswordRedirectUrl,
} from "../auth-link";

const SRC_DIR = fileURLToPath(new URL("../..", import.meta.url));
const source = (path: string) => readFileSync(`${SRC_DIR}/${path}`, "utf8");

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An unsigned look-alike JWT: the page only reads the payload, the server verifies the signature. */
function jwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.signature`;
}

const recoveryToken = jwt({ email: "ayse@example.com", amr: [{ method: "recovery", timestamp: 1 }] });

function implicitHash(type: string | null, access = recoveryToken): string {
  const p = new URLSearchParams({
    access_token: access,
    expires_at: "1792170000",
    expires_in: "3600",
    refresh_token: "r3fr3sh",
    token_type: "bearer",
  });
  if (type) p.set("type", type);
  return "#" + p.toString();
}

describe("parseAuthLink", () => {
  it("reads an implicit recovery link (tokens and type in the fragment)", () => {
    expect(parseAuthLink(implicitHash("recovery"), "")).toEqual({
      kind: "tokens",
      type: "recovery",
      accessToken: recoveryToken,
      refreshToken: "r3fr3sh",
    });
  });

  it("reads an invite link the same way", () => {
    const link = parseAuthLink(implicitHash("invite"), "");
    expect(link.kind).toBe("tokens");
    expect(link.type).toBe("invite");
  });

  it("never takes the type of fragment tokens from the query", () => {
    const link = parseAuthLink(implicitHash(null), "?type=recovery");
    expect(link).toMatchObject({ kind: "tokens", type: null });
    expect(linkTokenEmail(link)).toBeNull();
  });

  it("needs both tokens", () => {
    expect(parseAuthLink("#access_token=abc&type=recovery", "").kind).toBe("none");
    expect(parseAuthLink("#refresh_token=abc&type=recovery", "").kind).toBe("none");
  });

  it("reads an error from the fragment or the query, before anything else", () => {
    expect(parseAuthLink("#error=access_denied&error_code=otp_expired&error_description=x", "").kind).toBe("error");
    expect(parseAuthLink("", "?error=server_error&error_code=bad_code_verifier").kind).toBe("error");
    expect(parseAuthLink(implicitHash("recovery") + "&error_code=otp_expired", "").kind).toBe("error");
  });

  it("reads a legacy PKCE code from the query", () => {
    expect(parseAuthLink("", "?code=c0de")).toEqual({ kind: "code", type: null, code: "c0de" });
    expect(parseAuthLink("", "?code=c0de&sb_flow_id=x&type=recovery")).toMatchObject({ kind: "code", code: "c0de" });
  });

  it("prefers fragment tokens over a code", () => {
    expect(parseAuthLink(implicitHash("recovery"), "?code=c0de").kind).toBe("tokens");
  });

  it("is 'none' without a link, with or without the leading # and ?", () => {
    expect(parseAuthLink("", "")).toEqual({ kind: "none", type: null });
    expect(parseAuthLink("#", "?")).toEqual({ kind: "none", type: null });
    expect(parseAuthLink(implicitHash("recovery").slice(1), "").kind).toBe("tokens");
  });
});

describe("linkTokenEmail", () => {
  it("accepts invite and recovery tokens issued for an e-mail link", () => {
    expect(ACCEPTED_LINK_TYPES).toEqual(["invite", "recovery"]);
    expect(linkTokenEmail(parseAuthLink(implicitHash("recovery"), ""))).toBe("ayse@example.com");
    const invite = jwt({ email: "yeni@example.com", amr: [{ method: "invite", timestamp: 1 }] });
    expect(linkTokenEmail(parseAuthLink(implicitHash("invite", invite), ""))).toBe("yeni@example.com");
    // Older GoTrue versions name the method as a plain string, or as otp / magiclink.
    const otp = jwt({ email: "a@example.com", amr: ["otp"] });
    expect(linkTokenEmail(parseAuthLink(implicitHash("recovery", otp), ""))).toBe("a@example.com");
  });

  it("refuses other link types", () => {
    for (const type of ["magiclink", "signup", "email_change", "RECOVERY", ""]) {
      expect(linkTokenEmail(parseAuthLink(implicitHash(type), "")), type).toBeNull();
    }
  });

  it("refuses a password login's tokens, tokens without an e-mail and unreadable tokens", () => {
    const password = jwt({ email: "a@example.com", amr: [{ method: "password", timestamp: 1 }] });
    expect(linkTokenEmail(parseAuthLink(implicitHash("recovery", password), ""))).toBeNull();
    const noEmail = jwt({ amr: [{ method: "recovery" }] });
    expect(linkTokenEmail(parseAuthLink(implicitHash("recovery", noEmail), ""))).toBeNull();
    const blankEmail = jwt({ email: "  ", amr: [{ method: "recovery" }] });
    expect(linkTokenEmail(parseAuthLink(implicitHash("recovery", blankEmail), ""))).toBeNull();
    expect(linkTokenEmail(parseAuthLink(implicitHash("recovery", "not-a-jwt"), ""))).toBeNull();
    expect(linkTokenEmail(parseAuthLink(implicitHash("recovery", "a.%%%.c"), ""))).toBeNull();
  });

  it("gives nothing for codes, errors and plain visits", () => {
    expect(linkTokenEmail(parseAuthLink("", "?code=c0de&type=recovery"))).toBeNull();
    expect(linkTokenEmail(parseAuthLink("#error=x&type=recovery", ""))).toBeNull();
    expect(linkTokenEmail(parseAuthLink("", ""))).toBeNull();
  });
});

describe("JWT payload helpers", () => {
  it("decodes UTF-8 payloads and refuses non-objects", () => {
    expect(decodeJwtPayload(jwt({ email: "şule@example.com" }))).toEqual({ email: "şule@example.com" });
    expect(decodeJwtPayload(`x.${b64url([1, 2])}.y`)).toBeNull();
    expect(decodeJwtPayload(`x.${b64url("text")}.y`)).toBeNull();
    expect(decodeJwtPayload("only-one-part")).toBeNull();
  });

  it("recognises e-mail link sign-ins only", () => {
    expect(isLinkSession({ amr: [{ method: "recovery" }] })).toBe(true);
    expect(isLinkSession({ amr: ["magiclink"] })).toBe(true);
    expect(isLinkSession({ amr: [{ method: "password" }, { method: "totp" }] })).toBe(false);
    expect(isLinkSession({ amr: "recovery" })).toBe(false);
    expect(isLinkSession({})).toBe(false);
  });
});

describe("link helpers", () => {
  it("opens the first-password wording only for invites", () => {
    expect(linkMode("invite")).toBe("setup");
    expect(linkMode("recovery")).toBe("reset");
    expect(linkMode(null)).toBe("reset");
  });

  it("recognises auth fragments the site root passes on", () => {
    expect(isAuthCallbackHash(implicitHash("recovery"))).toBe(true);
    expect(isAuthCallbackHash("#error=access_denied&error_code=otp_expired")).toBe(true);
    expect(isAuthCallbackHash("#a=1&error_code=x")).toBe(true);
    expect(isAuthCallbackHash("")).toBe(false);
    expect(isAuthCallbackHash("#section")).toBe(false);
    expect(isAuthCallbackHash("#my_access_token=1")).toBe(false);
  });

  it("sends recovery links back to the origin in use", () => {
    expect(resetPasswordRedirectUrl("https://dentos.klinikprimemaltepe.com")).toBe(
      "https://dentos.klinikprimemaltepe.com/reset-password"
    );
    expect(resetPasswordRedirectUrl("https://dentos-eight.vercel.app/")).toBe("https://dentos-eight.vercel.app/reset-password");
  });
});

describe("'Şifremi unuttum' request", () => {
  it("goes through the implicit-flow client that keeps no session", () => {
    const lib = source("lib/supabase.ts");
    expect(lib).toMatch(/flowType:\s*"implicit"/);
    expect(lib).toMatch(/persistSession:\s*false/);
    expect(lib).toMatch(/autoRefreshToken:\s*false/);
    expect(lib).toMatch(/detectSessionInUrl:\s*false/);
    expect(lib).toMatch(/storageKey:\s*"dentos-recovery-request"/);
  });

  it("is sent from the login page with that client and this origin's /reset-password", () => {
    const login = source("app/(auth)/login/page.tsx");
    expect(login).toContain("requestPasswordResetEmail(");
    expect(login).toContain("resetPasswordRedirectUrl(window.location.origin)");
    expect(login).not.toMatch(/createClient\(\)\.auth\.resetPasswordForEmail/);
  });
});
