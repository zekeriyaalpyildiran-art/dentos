// Finance import: classification engine over owner-editable rule rows
// (spec p2i_parsers_rules §10, p2i_db_contract §2.6 / §4.13).
//
// The legacy regex list (FI:8-22) and name lists (FC:7-10) are data now: fin_classification_rules.
// Rules are tried in ascending priority (ties: created_at, id); the first rule whose category
// direction equals the row's direction and whose scope covers the row wins. No clinic names here.
// 0038: a rule that needs a hakediş month may suggest one (suggestEntitlementMonth); the parsers fill it in.

import type { Direction, EntitlementMonthDefault, ReportBucket, Subcategory } from "../finance";
import { financeDayOk, normB, normTr } from "./primitives";
import { warningFromText, type RowWarning } from "./types";

export type RuleScope = "any" | "bank" | "clinic";
export type RuleMatchKind = "contains" | "starts_with" | "exact" | "regex" | "always";

/** A fin_classification_rules row joined with its category's bucket and direction. */
export type ClassificationRule = {
  id: string;
  priority: number;
  scope: RuleScope;
  match_kind: RuleMatchKind;
  pattern: string | null;
  category_id: string;
  /** The category's report bucket. */
  bucket: ReportBucket;
  /** The category's direction; a rule is tried only on rows of that direction. */
  direction: Direction;
  subcategory: Subcategory | null;
  counterparty_id: string | null;
  requires_entitlement_month: boolean;
  /** 0038: month suggestion of a requires_entitlement_month rule (absent = 'none') */
  entitlement_month_default?: EntitlementMonthDefault;
  auto_select: boolean;
  warning: string;
  is_active: boolean;
  created_at?: string | null;
};

type Compiled = { rule: ClassificationRule; test: (folded: string) => boolean };

export type CompiledRules = {
  rules: Compiled[];
  /** Rules whose pattern does not compile; they are skipped (shown in the review table). */
  invalid: { id: string; message: string }[];
};

export type Classification = {
  ruleId: string;
  categoryId: string;
  bucket: ReportBucket;
  subcategory: Subcategory | null;
  counterpartyId: string | null;
  requiresEntitlementMonth: boolean;
  /** 0038: 'none' unless the rule requires the month and suggests one */
  entitlementMonthDefault: EntitlementMonthDefault;
  /**
   * 0038: the rule's own text for contains / starts_with / exact (usually the person's name), null for regex / always;
   * the month suggestion ignores it (a name such as 'Kasım' or 'Eylül' is not the month)
   */
  pattern: string | null;
  autoSelect: boolean;
  warning: RowWarning | null;
  scope: RuleScope;
};

/** Longest text a rule is tested against (statement narrations are outsider-controlled). */
export const CLASSIFY_TEXT_MAX = 1000;

/**
 * Patterns are saved by finance editors and run on the main thread against text an outsider controls (EFT
 * narrations, workbook cells), so constructs with catastrophic backtracking are refused: a repeated group that
 * itself contains a repetition ('(a+)+', '(\\w+\\s?)+$'), back-references and look-behind. Mirrored by
 * fin__regex_unsafe in SQL. Returns the problem text, or null when the pattern is acceptable.
 */
export function regexSafetyProblem(pattern: string): string | null {
  if (/\\[1-9]|\\k</.test(pattern)) return "Desende geri başvuru (\\1, \\k<…>) kullanılamaz.";
  if (/\(\?<[=!]/.test(pattern)) return "Desende geriye bakış (?<= / ?<!) kullanılamaz.";
  const NESTED = "Desende iç içe tekrar var (ör. (a+)+); bu desen tarayıcıyı kilitleyebilir.";
  const stack: boolean[] = []; // per open group: does it contain a repetition?
  let afterGroup: boolean | null = null; // the token just closed was a group; did it repeat inside?
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++;
      afterGroup = null;
      continue;
    }
    if (ch === "[") {
      i++;
      if (pattern[i] === "^") i++;
      if (pattern[i] === "]") i++;
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\") i++;
        i++;
      }
      afterGroup = null;
      continue;
    }
    if (ch === "(") {
      stack.push(false);
      afterGroup = null;
      continue;
    }
    if (ch === ")") {
      const inner = stack.pop() ?? false;
      if (inner && stack.length) stack[stack.length - 1] = true;
      afterGroup = inner;
      continue;
    }
    let repeats = false;
    if (ch === "*" || ch === "+") repeats = true;
    else if (ch === "{") {
      const m = pattern.slice(i).match(/^\{(\d+)(,(\d*))?\}/);
      if (m) {
        repeats = m[2] !== undefined && (m[3] === "" || Number(m[3]) > 1);
        if (m[2] === undefined) repeats = Number(m[1]) > 1;
        i += m[0].length - 1;
      }
    }
    if (repeats) {
      if (afterGroup) return NESTED;
      if (stack.length) stack[stack.length - 1] = true;
    }
    afterGroup = null;
  }
  return null;
}

/**
 * Workbook expense rows: legacy decided the currency-exchange test (FI:62) and the entitlement physician (FI:64) on
 * their own, before the generic keyword list, so workbook-only and entitlement rules are tried first there.
 */
export const workbookFirstPass = (rule: ClassificationRule): boolean => rule.scope === "clinic" || rule.requires_entitlement_month;

/** FC:10 legacy physician test: s===n || s starts with n+' ' or n+'('. */
const startsWithName = (s: string, n: string): boolean => s === n || s.startsWith(n + " ") || s.startsWith(n + "(");

function compileOne(rule: ClassificationRule): Compiled {
  const pattern = rule.pattern ?? "";
  switch (rule.match_kind) {
    case "always":
      return { rule, test: () => true };
    case "contains": {
      const n = normTr(pattern);
      return { rule, test: (s) => s.includes(n) };
    }
    case "starts_with": {
      const n = normTr(pattern);
      return { rule, test: (s) => startsWithName(s, n) };
    }
    case "exact": {
      const n = normTr(pattern);
      return { rule, test: (s) => s === n };
    }
    case "regex": {
      // p2i_db_contract §2.6: JavaScript pattern compiled with the `u` flag, no other flags.
      const problem = regexSafetyProblem(pattern);
      if (problem) throw new Error(problem);
      const re = new RegExp(pattern, "u");
      return { rule, test: (s) => re.test(s) };
    }
  }
}

const cmp = (a: ClassificationRule, b: ClassificationRule): number =>
  a.priority - b.priority ||
  String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function compileRules(rules: readonly ClassificationRule[]): CompiledRules {
  const out: Compiled[] = [];
  const invalid: CompiledRules["invalid"] = [];
  for (const rule of [...rules].filter((r) => r.is_active).sort(cmp)) {
    if (rule.match_kind !== "always" && !rule.pattern) {
      invalid.push({ id: rule.id, message: "Kural deseni boş." });
      continue;
    }
    try {
      out.push(compileOne(rule));
    } catch (e) {
      invalid.push({ id: rule.id, message: e instanceof Error ? e.message : "Geçersiz desen." });
    }
  }
  return { rules: out, invalid };
}

/**
 * Classifies one row. `signedCents > 0` is an inflow (legacy `amount > 0`), anything else an
 * outflow. `scope` is 'bank' for statement rows and 'clinic' for workbook expense rows.
 * Returns null when no rule matches: the row stays uncategorised and unselected.
 */
export function classify(
  compiled: CompiledRules,
  text: string,
  signedCents: number,
  scope: Exclude<RuleScope, "any">,
  opts: { firstPass?: (rule: ClassificationRule) => boolean } = {},
): Classification | null {
  const direction: Direction = signedCents > 0 ? "in" : "out";
  const folded = normTr(text.slice(0, CLASSIFY_TEXT_MAX));
  const eligible = compiled.rules.filter(
    ({ rule }) => rule.direction === direction && (rule.scope === "any" || rule.scope === scope),
  );
  // Optional first pass (workbook: legacy decided the currency-exchange and entitlement tests on their own,
  // before the generic list, FI:62-64), then every rule in priority order.
  const ordered = opts.firstPass ? [...eligible.filter(({ rule }) => opts.firstPass!(rule)), ...eligible] : eligible;
  for (const { rule, test } of ordered) {
    if (!test(folded)) continue;
    return {
      ruleId: rule.id,
      categoryId: rule.category_id,
      bucket: rule.bucket,
      subcategory: rule.subcategory,
      counterpartyId: rule.counterparty_id,
      requiresEntitlementMonth: rule.requires_entitlement_month,
      entitlementMonthDefault: rule.requires_entitlement_month ? (rule.entitlement_month_default ?? "none") : "none",
      pattern: rule.match_kind === "regex" || rule.match_kind === "always" ? null : rule.pattern,
      autoSelect: rule.auto_select,
      warning: warningFromText(rule.warning),
      scope: rule.scope,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hakediş month suggestion (0038)
// ---------------------------------------------------------------------------

/** Turkish month names as normB folds them (lower case, no diacritics, ı → i), January first. */
export const TR_MONTH_NAMES: readonly string[] = [
  "ocak",
  "subat",
  "mart",
  "nisan",
  "mayis",
  "haziran",
  "temmuz",
  "agustos",
  "eylul",
  "ekim",
  "kasim",
  "aralik",
];

/**
 * A whole month name ('ekim', 'ekim'in'; not 'ekimde', 'martı'), optionally followed by a 4-digit year ('Ekim 2026',
 * 'EKİM-2026'). A number that goes on as an amount ('ekim 2500,00') is not a year.
 */
const MONTH_IN_TEXT = new RegExp(`(?:^|[^a-z])(${TR_MONTH_NAMES.join("|")})(?![a-z])(?:[\\s'’.,/-]*(\\d{4})(?![\\d.,]?\\d))?`, "g");

/** 'YYYY-MM' shifted by n months. */
export function shiftMonth(month: string, n: number): string {
  const i = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n;
  return `${String(Math.floor(i / 12)).padStart(4, "0")}-${String((i % 12) + 1).padStart(2, "0")}`;
}

/**
 * A Turkish month name in the text ('YYYY-MM'), case- and diacritic-insensitive: the first one with a year next to it
 * (only from two years before to one year after the row date; anything else is read as no year), else the first one,
 * in the most recent such month not after the row date. Every occurrence of `ignore` (the rule's own text: a payee
 * named 'Kasım Demir' or 'Eylül Yılmaz' is not a month) is left out first. null without a month name or a valid row
 * date.
 */
export function monthFromText(text: string, date: string, ignore?: string | null): string | null {
  if (!financeDayOk(date)) return null;
  let folded = normB(text.slice(0, CLASSIFY_TEXT_MAX));
  const skip = ignore ? normB(ignore).trim() : "";
  if (skip) folded = folded.split(skip).join(" ");
  const rowYear = Number(date.slice(0, 4));
  const validYear = (y: number) => y >= rowYear - 2 && y <= rowYear + 1;
  const found = Array.from(folded.matchAll(MONTH_IN_TEXT));
  const m = found.find((x) => x[2] && validYear(Number(x[2]))) ?? found[0];
  if (!m) return null;
  const month = TR_MONTH_NAMES.indexOf(m[1]) + 1;
  let year = m[2] ? Number(m[2]) : NaN;
  if (!validYear(year)) year = month <= Number(date.slice(5, 7)) ? rowYear : rowYear - 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * The hakediş month a rule suggests for a row dated `date` ('YYYY-MM-DD'): 'same' → the row's month, 'previous' → the
 * month before it, 'from_text' → a month named in the row text outside the rule's own text `ignore` (monthFromText),
 * else the previous month. null for 'none' (the reviewer types it) or an invalid date.
 */
export function suggestEntitlementMonth(
  mode: EntitlementMonthDefault | null | undefined,
  text: string,
  date: string,
  ignore?: string | null,
): string | null {
  if (!mode || mode === "none" || !financeDayOk(date)) return null;
  const month = date.slice(0, 7);
  if (mode === "same") return month;
  return (mode === "from_text" ? monthFromText(text, date, ignore) : null) ?? shiftMonth(month, -1);
}
