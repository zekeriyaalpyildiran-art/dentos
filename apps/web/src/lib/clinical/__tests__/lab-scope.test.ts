// Doctor scope of the Lab (owner's decision 2026-10-20): the UI rule and its agreement with migration
// 0036_doctor_scope.sql (the server enforces it; the UI only hides the doctor choice). Synthetic users only.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LAB_NO_DOCTOR_TEXT, labOwnOnly, ownDoctor } from "../permissions";

const MIGRATIONS = join(__dirname, "..", "..", "..", "..", "..", "..", "packages", "db", "migrations");
const sql = readFileSync(join(MIGRATIONS, "0036_doctor_scope.sql"), "utf8");
const sql0026 = readFileSync(join(MIGRATIONS, "0026_clinical_implants_lab.sql"), "utf8");
const rpcSource = readFileSync(join(__dirname, "..", "rpc.ts"), "utf8");

const user = (role: string, permissions: string[] = []) => ({ role, permissions });

describe("labOwnOnly (who sees only their own lab jobs)", () => {
  it("is true for a doctor without finance access only", () => {
    expect(labOwnOnly(user("doctor"))).toBe(true);
    expect(labOwnOnly(user("doctor", ["stock_cost_view", "clinical", "crm_manage", "hakedis_prepare"]))).toBe(true);
    expect(labOwnOnly(user("doctor", ["finance"]))).toBe(false);
    expect(labOwnOnly(user("doctor", ["finance_readonly"]))).toBe(false);
    for (const role of ["owner", "admin", "assistant", "reception"]) expect(labOwnOnly(user(role)), role).toBe(false);
    expect(labOwnOnly(null)).toBe(false);
  });

  it("follows the server's flag once a response is in", () => {
    expect(labOwnOnly(user("doctor"), { lab_own_only: false })).toBe(false);
    expect(labOwnOnly(user("owner"), { lab_own_only: true })).toBe(true);
    // A response from before 0036 (or after its rollback) has no such flag: the server does not scope.
    expect(labOwnOnly(user("doctor"), {})).toBe(false);
    expect(labOwnOnly(user("doctor"), null)).toBe(true);
    expect(labOwnOnly(user("doctor"), undefined)).toBe(true);
    expect(labOwnOnly(user("assistant"), null)).toBe(false);
  });
});

describe("ownDoctor", () => {
  const doctors = [
    { id: "d1", user_id: "u1", name: "Hekim Bir" },
    { id: "d2", user_id: "u2", name: "Hekim İki" },
    { id: "d3", user_id: null, name: "Hekim Üç" },
  ];

  it("finds the signed-in user's own doctor record by users.id", () => {
    expect(ownDoctor(doctors, { user_id: "u2" })?.id).toBe("d2");
    expect(ownDoctor(doctors, { user_id: "u9" })).toBeNull();
    expect(ownDoctor(doctors, { user_id: null })).toBeNull();
    expect(ownDoctor(doctors, null)).toBeNull();
    expect(ownDoctor([], { user_id: "u1" })).toBeNull();
  });
});

/** "CREATE OR REPLACE FUNCTION public.<name>(<arguments>)" of a file, whitespace collapsed. */
function signatures(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /CREATE OR REPLACE FUNCTION public\.(\w+)\(([\s\S]*?)\)\s*RETURNS/g;
  for (const m of text.matchAll(re)) out.set(m[1], m[2].replace(/\s+/g, " ").trim());
  return out;
}

/** The text of one function definition, up to its closing "$$;". */
function body(text: string, name: string): string {
  const start = text.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const end = text.indexOf("\n$$;", start);
  expect(end, name).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("migration 0036 (server side of the doctor scope)", () => {
  const mine = signatures(sql);
  const old = signatures(sql0026);
  const REPLACED = [
    "clin__raise",
    "clin__flags",
    "clin__lab_json",
    "clin_lab_order_save",
    "clin_lab_order_set_status",
    "clin_lab_order_delete_draft",
    "clin_lab_order_set_cost",
    "clin_lab_cost_post",
    "clin_lab_order_list",
    "clin_lab_order_detail",
  ];

  it("replaces exactly the lab functions, each with its 0026 signature (no overload), plus three new helpers", () => {
    expect([...mine.keys()].sort()).toEqual(
      [...REPLACED, "clin_can_view_all_lab_orders", "clin_my_doctor_id", "clin__lab_order_visible"].sort()
    );
    for (const name of REPLACED) expect(mine.get(name), name).toBe(old.get(name));
    for (const name of ["clin_can_view_all_lab_orders", "clin_my_doctor_id", "clin__lab_order_visible"]) {
      expect(old.has(name), name).toBe(false);
    }
  });

  it("covers every lab job RPC the web app calls", () => {
    const called = new Set([...rpcSource.matchAll(/rpc(?:<[^>]*>)?\("(clin_lab_(?:order|cost)_\w+)"/g)].map((m) => m[1]));
    expect(called.size).toBeGreaterThanOrEqual(7);
    for (const name of called) expect(REPLACED, name).toContain(name);
  });

  it("finds and locks a lab job only when the caller may see it", () => {
    const locks = [...sql.matchAll(/SELECT \* INTO v_\w+ FROM public\.lab_orders o\s+WHERE ([^;]*?)FOR UPDATE;/g)];
    expect(locks.length).toBe(5);
    for (const m of locks) expect(m[1]).toContain("public.clin__lab_order_visible(o.doctor_id)");
    expect(body(sql, "clin_lab_order_detail")).toMatch(/clin__lab_order_visible\(o\.doctor_id\)\) THEN\s+PERFORM public\.clin__raise\('CL_NOT_FOUND'\)/);
    expect(body(sql, "clin_lab_order_list")).toContain("WHERE v_all OR r.doctor_id = v_own");
    expect(body(sql, "clin__lab_json")).toContain("public.clin__lab_order_visible(o.doctor_id)");
  });

  it("lets a doctor save only under their own doctor record", () => {
    const save = body(sql, "clin_lab_order_save");
    const check = save.indexOf("IF NOT public.clin_can_view_all_lab_orders() THEN");
    expect(check).toBeGreaterThan(save.indexOf("PERFORM public.clin__raise('CL_LAB_ORDER_FIELDS');"));
    expect(check).toBeLessThan(save.indexOf("IF p_version IS NULL THEN"));
    expect(save).toContain("IF p_doctor_id IS DISTINCT FROM public.clin_my_doctor_id() THEN");
  });

  it("scopes the one SELECT policy of each lab table under its 0026 name", () => {
    for (const [table, policy] of [
      ["lab_orders", "lab_orders_clinic_isolation"],
      ["lab_order_items", "lab_order_items_clinic_isolation"],
      ["lab_order_events", "lab_order_events_select"],
      ["lab_order_costs", "lab_order_costs_select"],
    ]) {
      expect(sql0026).toContain(`('${table}', '${policy}'`);
      expect(sql).toContain(`DROP POLICY IF EXISTS ${policy} ON public.${table};`);
      const start = sql.indexOf(`CREATE POLICY ${policy} ON public.${table}`);
      expect(start, policy).toBeGreaterThan(-1);
      const text = sql.slice(start, sql.indexOf(");\n", start));
      expect(text).toContain("FOR SELECT TO authenticated");
      expect(text).toContain("clinic_id = (SELECT public.current_clinic_id())");
      expect(text).toContain("(SELECT public.clin_can_view_all_lab_orders())");
      expect(text).toContain("(SELECT public.clin_my_doctor_id())");
    }
    expect(sql).toMatch(/CREATE POLICY lab_order_costs_select[\s\S]*?\(SELECT public\.clin_can_view_lab_costs\(\)\)/);
  });

  it("exempts nobody but non-doctors and finance holders, and fails closed", () => {
    const all = body(sql, "clin_can_view_all_lab_orders");
    expect(all).toContain("coalesce(public.current_app_role() <> 'doctor', false)");
    expect(all).toContain("coalesce(public.has_permission('finance'), false)");
    expect(all).toContain("coalesce(public.has_permission('finance_readonly'), false)");
    expect(all).not.toMatch(/stock_cost_view|'clinical'/);
    expect(body(sql, "clin__lab_order_visible")).toContain("coalesce(public.clin_can_view_all_lab_orders() OR");
  });

  it("raises the texts the web app shows, and sends the flags the lab pages read", () => {
    expect(sql).toContain(`WHEN 'CL_LAB_NO_DOCTOR' THEN v_msg := '${LAB_NO_DOCTOR_TEXT}'; v_code := '42501';`);
    expect(sql).toMatch(/WHEN 'CL_LAB_OWN_DOCTOR' THEN v_msg := '[^']+'; v_code := '42501';/);
    const flags = body(sql, "clin__flags");
    expect(flags).toContain("'lab_own_only', NOT public.clin_can_view_all_lab_orders()");
    expect(flags).toContain("'my_doctor_id', public.clin_my_doctor_id()");
    expect(rpcSource).toMatch(/lab_own_only\?: boolean;/);
  });

  it("is one transaction that hardens the privileges, replays in a rolled-back clinic and reloads the API", () => {
    expect(sql.indexOf("\nBEGIN;\n")).toBeGreaterThan(-1);
    expect(sql).toContain("SELECT public.clin__harden_privileges();");
    expect(sql).toContain("RAISE EXCEPTION USING ERRCODE = 'PT999', MESSAGE = 'p36_selfcheck_rollback';");
    // The replay writes its orders directly: no lab order number is used up in production.
    const replay = sql.slice(sql.indexOf("-- 8.2 Replay"));
    expect(replay.length).toBeGreaterThan(1000);
    expect(replay).not.toMatch(/nextval\(/);
    expect(sql.trimEnd().endsWith("NOTIFY pgrst, 'reload schema';\n\nCOMMIT;")).toBe(true);
  });
});
