// E-mail links on /reset-password (lib/auth-link.ts) and the "Şifremi unuttum" request. Synthetic tokens only.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// Runtime checks against the installed supabase-js: fetch is stubbed, nothing leaves the test.
const SUPABASE_URL = "https://project.supabase.test";
const ANON_KEY = "anon-test-key";

interface Call {
  url: string;
  init: RequestInit;
}

function stubFetch(responses: Array<{ status: number; body?: unknown }>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      const next = responses.shift() ?? { status: 200, body: {} };
      const body = next.status === 204 ? null : JSON.stringify(next.body ?? {});
      return new Response(body, { status: next.status, headers: { "Content-Type": "application/json" } });
    })
  );
  return calls;
}

const header = (call: Call, name: string) => new Headers(call.init.headers).get(name);

describe("supabase.ts at runtime", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON_KEY);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("asks for the 'Şifremi unuttum' e-mail without a PKCE challenge (implicit flow, any browser)", async () => {
    const calls = stubFetch([{ status: 200, body: {} }]);
    const { requestPasswordResetEmail } = await import("../supabase");
    const { error } = await requestPasswordResetEmail("a@example.com", "https://x.test/reset-password");
    expect(error).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${SUPABASE_URL}/auth/v1/recover?redirect_to=https%3A%2F%2Fx.test%2Freset-password`);
    expect(calls[0].init.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.email).toBe("a@example.com");
    expect(body.code_challenge).toBeNull();
    expect(body.code_challenge_method).toBeNull();
    expect(header(calls[0], "apikey")).toBe(ANON_KEY);
  });

  it("revokes a link's session with its own access token (that session only)", async () => {
    const calls = stubFetch([{ status: 204 }]);
    const { revokeLinkSession } = await import("../supabase");
    await expect(revokeLinkSession({ accessToken: "acc", refreshToken: "ref" })).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${SUPABASE_URL}/auth/v1/logout?scope=local`);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.keepalive).toBe(false);
    expect(header(calls[0], "authorization")).toBe("Bearer acc");
    expect(header(calls[0], "apikey")).toBe(ANON_KEY);
  });

  it("can send the revocation as a keepalive request (pagehide)", async () => {
    const calls = stubFetch([{ status: 204 }]);
    const { revokeLinkSession } = await import("../supabase");
    await revokeLinkSession({ accessToken: "acc", refreshToken: "ref" }, { keepalive: true });
    expect(calls[0].init.keepalive).toBe(true);
  });

  it("uses the refresh token once when the access token has expired, then ends that session", async () => {
    const calls = stubFetch([{ status: 401, body: { code: 401 } }, { status: 200, body: { access_token: "fresh" } }, { status: 204 }]);
    const { revokeLinkSession } = await import("../supabase");
    await expect(revokeLinkSession({ accessToken: "old", refreshToken: "ref" })).resolves.toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      `${SUPABASE_URL}/auth/v1/logout?scope=local`,
      `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
      `${SUPABASE_URL}/auth/v1/logout?scope=local`,
    ]);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ refresh_token: "ref" });
    expect(header(calls[2], "authorization")).toBe("Bearer fresh");
  });

  it("reports false, never throws, when nothing could be revoked", async () => {
    const { revokeLinkSession } = await import("../supabase");
    stubFetch([{ status: 403 }, { status: 400, body: { error: "invalid_grant" } }]);
    await expect(revokeLinkSession({ accessToken: "a", refreshToken: "r" })).resolves.toBe(false);
    stubFetch([{ status: 500 }]);
    await expect(revokeLinkSession({ accessToken: "a", refreshToken: "r" })).resolves.toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(revokeLinkSession({ accessToken: "a", refreshToken: "r" })).resolves.toBe(false);
  });
});

describe("/reset-password token hygiene", () => {
  const page = source("app/reset-password/page.tsx");

  it("rotates the link's refresh token right after applying it", () => {
    const accept = page.slice(page.indexOf("const acceptLink"), page.indexOf("const discardLink"));
    expect(accept.indexOf("auth.setSession(")).toBeGreaterThan(-1);
    expect(accept.indexOf("auth.refreshSession()")).toBeGreaterThan(accept.indexOf("auth.setSession("));
  });

  it("revokes the link's session on 'Vazgeç' and when the page is left with the link pending", () => {
    const discard = page.slice(page.indexOf("const discardLink"), page.indexOf("const handleSubmit"));
    expect(discard).toContain("revokeLinkSession(link)");
    expect(discard.indexOf("revokeLinkSession(link)")).toBeLessThan(discard.indexOf('router.push("/login")'));
    expect(page).toContain('onClick={() => void discardLink()}');
    expect(page).toMatch(/addEventListener\("pagehide"[\s\S]*?\)/);
    expect(page).toContain("revokeLinkSession(link, { keepalive: true })");
  });
});
