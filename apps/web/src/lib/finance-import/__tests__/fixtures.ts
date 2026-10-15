// Synthetic test fixtures. No sample-file content and no personal data here.

import type { ReportBucket } from "../../finance";
import { compileRules, type ClassificationRule } from "../classify";
import { WORKBOOK_LAYOUT_TEMPLATE, type WorkbookLayout } from "../layout";

const IN_BUCKETS: ReportBucket[] = ["patient_receipts", "other_income", "capital"];
const dir = (b: ReportBucket) => (IN_BUCKETS.includes(b) ? "in" : "out");

let n = 0;
export function rule(
  priority: number,
  scope: ClassificationRule["scope"],
  match_kind: ClassificationRule["match_kind"],
  pattern: string | null,
  bucket: ReportBucket,
  extra: Partial<ClassificationRule> = {},
): ClassificationRule {
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    priority,
    scope,
    match_kind,
    pattern,
    category_id: `cat-${bucket}`,
    bucket,
    direction: dir(bucket),
    subcategory: null,
    counterparty_id: null,
    requires_entitlement_month: false,
    auto_select: false,
    warning: "",
    is_active: true,
    created_at: "2026-10-01T00:00:00Z",
    ...extra,
  };
}

/** The generic seed rules of p2i_db_contract §4.13 (no names). */
export const SEED_RULES: ClassificationRule[] = [
  rule(5, "clinic", "regex", "döviz bozdur", "other_expense", { warning: "Döviz bozdurma; faaliyet gideri değildir." }),
  rule(10, "bank", "always", null, "patient_receipts", {
    warning: "Banka girişi: klinik Excel’indeki tahsilatı tekrar saymayın. POS / virman girişleri seçili değildir.",
  }),
  rule(20, "any", "contains", "teftiş defteri", "other_expense", {
    subcategory: "official_fee",
    auto_select: true,
    warning: "Resmi harç: vergi/SGK yerine diğer faaliyet giderinde izlenir.",
  }),
  rule(30, "any", "regex", "pos kullanım ücreti|fiziki pos.*hizmet bedeli|ö?kc hizmet bedeli", "fees", { auto_select: true }),
  rule(40, "any", "regex", "komisyon|bsmv|kom\\.|masraf|kesinti|bakım|bkm|donanım|eft ücret|havale ücret|fast ücret", "fees", {
    auto_select: true,
  }),
  rule(50, "any", "regex", "hesaplararası|hesaplar arası", "other_expense", { warning: "Hesaplar arası transfer; gider değildir." }),
  rule(70, "any", "regex", "k.kartı ödeme|kredi|taksitli tahsilat", "principal", {
    warning: "Kredi / kart ödemesi: anapara, faiz ve harcama ayrımı gerekli.",
  }),
  rule(80, "any", "contains", "kira", "rent", { auto_select: true }),
  rule(90, "any", "contains", "laboratuvar", "lab", { auto_select: true }),
  rule(100, "any", "regex", "maaş|yemek|mesai", "personnel", { auto_select: true }),
  rule(110, "any", "regex", "vergi|sgk", "tax", { auto_select: true }),
  rule(10000, "any", "always", null, "other_expense", { warning: "Kategorisini kontrol edip seçin." }),
];

export const seedRules = () => compileRules(SEED_RULES);

/** Synthetic physician rules (as an owner would add them, priority band 60). No counterparty: only entitlement
 *  rules carry one (legacy IP:54; fin__trg_rule_guard refuses it elsewhere). */
export const physicianRule = (name: string) =>
  rule(60, "any", "starts_with", name, "doctor", {
    warning: "Hekim ödemesi: hakediş dönemini ve tekrar kaydı kontrol edin.",
  });
export const entitlementRule = (pattern: string) =>
  rule(60, "clinic", "regex", pattern, "doctor", {
    counterparty_id: "cp-owner",
    requires_entitlement_month: true,
  });

export const LAYOUT: WorkbookLayout = JSON.parse(JSON.stringify(WORKBOOK_LAYOUT_TEMPLATE));
