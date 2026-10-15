"use client";

import { useMemo, useState } from "react";
import { useCanWriteFinance } from "@/components/finance/FinanceShell";
import { useReferenceData } from "@/components/finance/useReferenceData";
import {
  Card,
  ErrorBox,
  Field,
  Loading,
  Modal,
  SuccessBox,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from "@/components/finance/ui";
import {
  BUCKET_LABELS,
  DIRECTION_LABELS,
  SUBCATEGORY_LABELS,
  finSaveClassificationRule,
  newId,
  pickable,
  sortByOrder,
  subcategoryOptions,
  toFinanceError,
  type ClassificationRuleJson,
  type Direction,
  type FinanceError,
  type ReferenceData,
  type RuleMatchKind,
  type RuleScope,
  type Subcategory,
} from "@/lib/finance";
import { classify, regexSafetyProblem, workbookFirstPass } from "@/lib/finance-import/classify";
import { compileSetupRules, orderedRules } from "./rules";
import { useImportSetup } from "./useImportSetup";

const SCOPE_LABELS: Record<RuleScope, string> = {
  any: "Tüm satırlar",
  bank: "Yalnızca banka satırları",
  clinic: "Yalnızca klinik Excel gider satırları",
};

const MATCH_LABELS: Record<RuleMatchKind, string> = {
  contains: "Açıklama içerir",
  starts_with: "Açıklama bu adla başlar",
  exact: "Açıklama tam olarak",
  regex: "Düzenli ifade (gelişmiş)",
  always: "Her zaman (yedek kural)",
};

/** /finance/import/rules: ordered keyword rules that pick the default category of imported rows. */
export function RulesEditor() {
  const canWrite = useCanWriteFinance();
  const setup = useImportSetup();
  const ref = useReferenceData();
  const [editing, setEditing] = useState<ClassificationRuleJson | "new" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  if (!setup.data || !ref.data) {
    return setup.loading || ref.loading ? <Loading /> : <ErrorBox error={setup.error ?? ref.error} />;
  }
  const rules = orderedRules(setup.data.rules).filter((r) => showInactive || r.is_active);

  const saved = async (text: string) => {
    setEditing(null);
    setMessage(text);
    await setup.reload();
  };

  return (
    <div className="space-y-6">
      <SuccessBox text={message} />
      <ErrorBox error={setup.error ?? ref.error} />
      <Card
        title="Sınıflandırma kuralları"
        actions={
          canWrite ? (
            <button type="button" className={buttonPrimary} onClick={() => setEditing("new")}>
              Yeni kural
            </button>
          ) : undefined
        }
      >
        <p className="text-sm text-gray-600 mb-3">
          Dosyadan okunan her satıra, yönüne (giriş / çıkış) uyan ilk etkin kural uygulanır; küçük sıra numarası önce
          denenir. Kurallar yalnızca önerilen kategoriyi ve ilk seçimi belirler, kaynak anahtarlarını değiştirmez. Hekim,
          tedarikçi ve laboratuvar adlarını burada kural olarak ekleyin (hekim kuralları için sıra 60 önerilir). Banka
          girişleri hiçbir kuralla otomatik seçilmez.
        </p>
        <label className="flex items-center gap-2 text-sm mb-3">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Pasif kuralları da göster
        </label>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-100 border-b">
              <tr className="text-left text-gray-800">
                <th className="px-3 py-2 font-semibold">Sıra</th>
                <th className="px-3 py-2 font-semibold">Koşul</th>
                <th className="px-3 py-2 font-semibold">Kapsam</th>
                <th className="px-3 py-2 font-semibold">Kategori</th>
                <th className="px-3 py-2 font-semibold">Seçili</th>
                <th className="px-3 py-2 font-semibold">Uyarı</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className={`border-b align-top ${r.is_active ? "" : "text-gray-400"}`}>
                  <td className="px-3 py-2 tabular-nums">{r.priority}</td>
                  <td className="px-3 py-2">
                    <div>{MATCH_LABELS[r.match_kind]}</div>
                    {r.pattern && <code className="text-xs bg-gray-100 px-1 rounded break-all">{r.pattern}</code>}
                    {r.is_seed && <div className="text-xs text-gray-500">varsayılan kural</div>}
                  </td>
                  <td className="px-3 py-2">{SCOPE_LABELS[r.scope]}</td>
                  <td className="px-3 py-2">
                    {r.category_name}
                    <div className="text-xs text-gray-500">
                      {DIRECTION_LABELS[r.direction]}
                      {r.subcategory && ` · ${SUBCATEGORY_LABELS[r.subcategory]}`}
                      {r.counterparty_name && ` · ${r.counterparty_name}`}
                      {r.requires_entitlement_month && " · hakediş ayı gerekli"}
                    </div>
                  </td>
                  <td className="px-3 py-2">{r.auto_select ? "Evet" : "Hayır"}</td>
                  <td className="px-3 py-2 text-xs text-gray-600 max-w-xs">{r.warning || "—"}</td>
                  <td className="px-3 py-2 text-right">
                    {canWrite && (
                      <button type="button" className="text-blue-600 hover:underline" onClick={() => setEditing(r)}>
                        Düzenle
                      </button>
                    )}
                    {!r.is_active && <div className="text-xs">pasif</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <RuleTester rules={setup.data.rules} />

      {editing && (
        <RuleDialog
          refData={ref.data}
          rule={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={saved}
          onReload={() => setup.reload()}
        />
      )}
    </div>
  );
}

function RuleTester({ rules }: { rules: ClassificationRuleJson[] }) {
  const [text, setText] = useState("");
  const [direction, setDirection] = useState<Direction>("out");
  const [scope, setScope] = useState<"bank" | "clinic">("bank");
  const compiled = useMemo(() => compileSetupRules(rules), [rules]);
  const result = useMemo(() => {
    if (!text.trim()) return null;
    const hit = classify(compiled, text, direction === "in" ? 1 : -1, scope, {
      firstPass: scope === "clinic" ? workbookFirstPass : undefined,
    });
    return { rule: hit ? rules.find((r) => r.id === hit.ruleId) ?? null : null, invalid: compiled.invalid };
  }, [compiled, rules, text, direction, scope]);
  return (
    <Card title="Kural denemesi">
      <div className="grid gap-4 md:grid-cols-4 items-end">
        <Field label="Örnek açıklama" className="md:col-span-2">
          <input className={inputClass} value={text} maxLength={900} onChange={(e) => setText(e.target.value)} />
        </Field>
        <Field label="Yön">
          <select className={inputClass} value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
            <option value="out">Çıkış</option>
            <option value="in">Giriş</option>
          </select>
        </Field>
        <Field label="Satır türü">
          <select className={inputClass} value={scope} onChange={(e) => setScope(e.target.value as "bank" | "clinic")}>
            <option value="bank">Banka satırı</option>
            <option value="clinic">Klinik Excel gider satırı</option>
          </select>
        </Field>
      </div>
      {result && (
        <p className="text-sm mt-3">
          {result.rule ? (
            <>
              Eşleşen kural: sıra {result.rule.priority} · <b>{result.rule.category_name}</b> (
              {BUCKET_LABELS[result.rule.report_bucket]}){result.rule.auto_select ? " · seçili gelir" : " · seçimsiz gelir"}
              {result.rule.warning && <span className="block text-xs text-gray-600">{result.rule.warning}</span>}
            </>
          ) : (
            "Hiçbir kural eşleşmedi; satır kategorisiz ve seçimsiz gelir."
          )}
          {result.invalid.length > 0 && (
            <span className="block text-xs text-red-600">
              Geçersiz desenli kurallar atlandı:{" "}
              {result.invalid.map((i) => rules.find((r) => r.id === i.id)?.priority ?? "?").join(", ")}
            </span>
          )}
        </p>
      )}
    </Card>
  );
}

function RuleDialog({
  refData,
  rule,
  onClose,
  onSaved,
  onReload,
}: {
  refData: ReferenceData;
  rule: ClassificationRuleJson | null;
  onClose: () => void;
  onSaved: (text: string) => Promise<void>;
  onReload: () => void;
}) {
  const [id] = useState(() => rule?.id ?? newId());
  const [priority, setPriority] = useState(String(rule?.priority ?? 60));
  const [scope, setScope] = useState<RuleScope>(rule?.scope ?? "any");
  const [matchKind, setMatchKind] = useState<RuleMatchKind>(rule?.match_kind ?? "contains");
  const [pattern, setPattern] = useState(rule?.pattern ?? "");
  const [categoryId, setCategoryId] = useState(rule?.category_id ?? "");
  const [subcategory, setSubcategory] = useState<Subcategory | "">(rule?.subcategory ?? "");
  const [counterpartyId, setCounterpartyId] = useState(rule?.counterparty_id ?? "");
  const [needsMonth, setNeedsMonth] = useState(rule?.requires_entitlement_month ?? false);
  const [autoSelect, setAutoSelect] = useState(rule?.auto_select ?? false);
  const [warning, setWarning] = useState(rule?.warning ?? "");
  const [active, setActive] = useState(rule?.is_active ?? true);
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);

  const categories = sortByOrder(pickable(refData.categories, categoryId));
  const category = refData.categories.find((c) => c.id === categoryId);
  const subOptions = subcategoryOptions(category?.report_bucket);
  const counterparties = pickable(refData.counterparties, counterpartyId).sort((a, b) => a.name.localeCompare(b.name, "tr-TR"));

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    const p = Number(priority);
    if (!Number.isInteger(p) || p < 0 || p > 10000) return setFormError("Sıra 0 ile 10000 arasında bir tam sayı olmalı.");
    if (!category) return setFormError("Kategori seçin.");
    const pat = pattern.trim();
    if (matchKind !== "always" && (pat.length < 1 || pat.length > 300)) {
      return setFormError('Kural deseni 1-300 karakter olmalı; "her zaman" kuralında desen olmaz.');
    }
    if (matchKind === "regex") {
      try {
        new RegExp(pat, "u");
      } catch {
        return setFormError("Düzenli ifade geçersiz.");
      }
      const unsafe = regexSafetyProblem(pat);
      if (unsafe) return setFormError(unsafe);
    }
    const entitlement = category.report_bucket === "doctor" && needsMonth;
    if (counterpartyId && !entitlement) {
      return setFormError("Kişi / kurum yalnızca hakediş ayı gerekli hekim kurallarında seçilebilir; diğer satırlarda açıklama kullanılır.");
    }
    if (warning.length > 300) return setFormError("Uyarı metni en fazla 300 karakter olabilir.");
    const sub = subOptions.some((o) => o.value === subcategory) && subcategory ? subcategory : null;
    setBusy(true);
    try {
      const res = await finSaveClassificationRule({
        p_id: id,
        p_version: rule?.version ?? 0,
        p_priority: p,
        p_scope: scope,
        p_match_kind: matchKind,
        p_pattern: matchKind === "always" ? null : pat,
        p_category_id: category.id,
        p_subcategory: sub,
        p_counterparty_id: entitlement ? counterpartyId || null : null,
        p_requires_entitlement_month: entitlement,
        p_auto_select: autoSelect,
        p_warning: warning.trim(),
        p_is_active: active,
      });
      await onSaved(res.already_saved ? "Kural zaten bu değerlerle kayıtlı." : "Kural kaydedildi.");
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={rule ? "Kuralı düzenle" : "Yeni kural"} onClose={onClose} busy={busy} wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 md:grid-cols-3">
          <Field
            label="Sıra"
            hint="Küçük olan önce denenir. Eski sıraya uygun aralıklar: hekim adları 51-69, laboratuvar / tedarikçi adları 81-99. Hakediş ve “yalnızca klinik Excel” kuralları Excel satırlarında her zaman önce denenir."
          >
            <input className={inputClass} inputMode="numeric" value={priority} onChange={(e) => setPriority(e.target.value)} />
          </Field>
          <Field label="Kapsam">
            <select className={inputClass} value={scope} onChange={(e) => setScope(e.target.value as RuleScope)}>
              {(Object.keys(SCOPE_LABELS) as RuleScope[]).map((s) => (
                <option key={s} value={s}>
                  {SCOPE_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Koşul">
            <select className={inputClass} value={matchKind} onChange={(e) => setMatchKind(e.target.value as RuleMatchKind)}>
              {(Object.keys(MATCH_LABELS) as RuleMatchKind[]).map((k) => (
                <option key={k} value={k}>
                  {MATCH_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {matchKind !== "always" && (
          <Field
            label="Desen"
            hint={
              matchKind === "regex"
                ? "Küçük harfle yazın; açıklama Türkçe küçük harfe çevrilip boşlukları sadeleştirilerek denenir."
                : "Büyük / küçük harf ve fazla boşluklar dikkate alınmaz."
            }
          >
            <input className={inputClass} value={pattern} maxLength={300} onChange={(e) => setPattern(e.target.value)} />
          </Field>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Kategori" hint="Kuralın yönü kategorinin yönüdür.">
            <select className={inputClass} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
              <option value="">Seçin</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({DIRECTION_LABELS[c.direction]})
                </option>
              ))}
            </select>
          </Field>
          {subOptions.length > 0 && (
            <Field label="Alt tür">
              <select className={inputClass} value={subcategory} onChange={(e) => setSubcategory(e.target.value as Subcategory | "")}>
                <option value="">—</option>
                {subOptions
                  .filter((o) => o.value)
                  .map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          <Field
            label="Kişi / kurum (isteğe bağlı)"
            hint="Yalnızca hakediş ayı gerekli hekim kurallarında: eşleşen satır bu kayda bağlanır. Diğer satırlarda kişi / kurum, satır açıklamasıdır."
          >
            <select
              className={inputClass}
              value={counterpartyId}
              disabled={!(category?.report_bucket === "doctor" && needsMonth) && !counterpartyId}
              onChange={(e) => setCounterpartyId(e.target.value)}
            >
              <option value="">—</option>
              {counterparties.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {category?.report_bucket === "doctor" && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={needsMonth} onChange={(e) => setNeedsMonth(e.target.checked)} />
            Hakediş ayı gerekli (eşleşen satır seçimsiz gelir; kaydetmeden önce hakediş ayı seçilmelidir).
          </label>
        )}
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={autoSelect} onChange={(e) => setAutoSelect(e.target.checked)} />
          Eşleşen banka satırı seçili gelsin. (Klinik Excel gider satırlarında yalnızca “Yalnızca klinik Excel” kapsamlı
          kurallar seçimi değiştirir; banka girişleri hiçbir zaman seçili gelmez.)
        </label>
        <Field label="Uyarı metni (isteğe bağlı)">
          <input className={inputClass} value={warning} maxLength={300} onChange={(e) => setWarning(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Etkin
        </label>
        {formError && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{formError}</div>}
        <ErrorBox error={error} onReload={onReload} />
        <div className="flex gap-2">
          <button type="submit" className={buttonPrimary} disabled={busy}>
            {busy ? "Kaydediliyor..." : "Kaydet"}
          </button>
          <button type="button" className={buttonSecondary} onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
        </div>
      </form>
    </Modal>
  );
}
