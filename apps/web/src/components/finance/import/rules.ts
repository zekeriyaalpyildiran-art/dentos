// Adapter: fin_import_setup rule rows → the parser library's classification rules.

import type { ClassificationRuleJson } from "@/lib/finance";
import { compileRules, type ClassificationRule, type CompiledRules } from "@/lib/finance-import/classify";

export function toLibRules(rules: ClassificationRuleJson[]): ClassificationRule[] {
  return rules.map((r) => ({
    id: r.id,
    priority: r.priority,
    scope: r.scope,
    match_kind: r.match_kind,
    pattern: r.pattern,
    category_id: r.category_id,
    bucket: r.report_bucket,
    direction: r.direction,
    subcategory: r.subcategory,
    counterparty_id: r.counterparty_id,
    requires_entitlement_month: r.requires_entitlement_month,
    auto_select: r.auto_select,
    warning: r.warning,
    is_active: r.is_active,
    created_at: r.created_at,
  }));
}

export function compileSetupRules(rules: ClassificationRuleJson[]): CompiledRules {
  return compileRules(toLibRules(rules));
}

/** Display order of the rules table: priority, created_at, id (the evaluation order). */
export function orderedRules(rules: ClassificationRuleJson[]): ClassificationRuleJson[] {
  return [...rules].sort(
    (a, b) =>
      a.priority - b.priority ||
      String(a.created_at).localeCompare(String(b.created_at)) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
