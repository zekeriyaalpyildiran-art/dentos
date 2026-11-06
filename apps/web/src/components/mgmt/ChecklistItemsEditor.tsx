"use client";

// The Yönetim routine's items (0040 mgmt_checklist_items_list / _save_item): add, edit, set passive / active again.
// Items are never deleted, so the marks and the 14-day summary keep their history.

import { useCallback, useEffect, useState } from "react";
import { toCrmError, type CrmError } from "@/lib/crm";
import {
  AREA_LABELS,
  FREQUENCY_LABELS,
  WEEKDAY_LABELS,
  WEEKDAY_SHORT,
  itemPayload,
  mgmtItems,
  mgmtSaveItem,
  scheduleLabel,
  type Area,
  type ChecklistItem,
  type Frequency,
  type ItemInput,
} from "@/lib/mgmt";
import { CrmErrorBox, CrmModal, Field, Loading, buttonPrimary, buttonSecondary, inputClass } from "@/components/crm/ui";

const EMPTY: ItemInput = {
  id: null,
  title: "",
  detail: "",
  area: "genel",
  frequency: "daily",
  weekdays: [1, 2, 3, 4, 5, 6],
  weekday: 1,
  month_day: 1,
  link_href: null,
  sort_order: 500,
};

/** Pages an item may link to (the Aç → button). */
const LINKS: { href: string; label: string }[] = [
  { href: "/appointments", label: "Ajanda" },
  { href: "/crm/today", label: "CRM · Bugün" },
  { href: "/tasks", label: "Görevler" },
  { href: "/inventory", label: "Stok" },
  { href: "/lab", label: "Lab" },
  { href: "/finance", label: "Finans" },
  { href: "/hakedis", label: "Hakediş ve maaş" },
  { href: "/reports", label: "Raporlar" },
  { href: "/team", label: "Ekip" },
];

function toInput(item: ChecklistItem): ItemInput {
  return {
    id: item.id,
    title: item.title,
    detail: item.detail,
    area: item.area,
    frequency: item.frequency,
    weekdays: item.weekdays,
    weekday: item.weekday ?? 1,
    month_day: item.month_day ?? 1,
    link_href: item.link_href,
    sort_order: item.sort_order,
    is_active: item.is_active,
  };
}

export function ChecklistItemsEditor({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<ChecklistItem[] | null>(null);
  const [form, setForm] = useState<ItemInput | null>(null);
  const [error, setError] = useState<CrmError | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await mgmtItems());
    } catch (err) {
      setError(toCrmError(err));
      setItems([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (input: ItemInput) => {
    setBusy(true);
    try {
      await mgmtSaveItem(itemPayload(input));
      setForm(null);
      setError(null);
      await load();
    } catch (err) {
      setError(toCrmError(err));
    } finally {
      setBusy(false);
    }
  };

  const set = <K extends keyof ItemInput>(key: K, value: ItemInput[K]) => setForm((f) => (f ? { ...f, [key]: value } : f));

  return (
    <CrmModal title="Kontrol listesi maddeleri" description="Pasife alınan madde listeden kalkar, geçmişi saklanır." onClose={onClose} busy={busy} wide>
      <div className="space-y-4">
        <CrmErrorBox error={error} />
        {form ? (
          <div className="space-y-3">
            <Field label="Madde">
              <input className={inputClass} value={form.title} maxLength={160} onChange={(e) => set("title", e.target.value)} />
            </Field>
            <Field label="Açıklama (isteğe bağlı)">
              <textarea className={`${inputClass} h-20`} value={form.detail} maxLength={1000} onChange={(e) => set("detail", e.target.value)} />
            </Field>
            <div className="grid sm:grid-cols-3 gap-3">
              <Field label="Alan">
                <select className={inputClass} value={form.area} onChange={(e) => set("area", e.target.value as Area)}>
                  {(Object.keys(AREA_LABELS) as Area[]).map((a) => (
                    <option key={a} value={a}>
                      {AREA_LABELS[a]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Sıklık">
                <select className={inputClass} value={form.frequency} onChange={(e) => set("frequency", e.target.value as Frequency)}>
                  {(Object.keys(FREQUENCY_LABELS) as Frequency[]).map((f) => (
                    <option key={f} value={f}>
                      {FREQUENCY_LABELS[f]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Bağlantı">
                <select className={inputClass} value={form.link_href ?? ""} onChange={(e) => set("link_href", e.target.value || null)}>
                  <option value="">Yok</option>
                  {LINKS.map((l) => (
                    <option key={l.href} value={l.href}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {form.frequency === "daily" && (
              <Field label="Hangi günler">
                <div className="flex flex-wrap gap-3">
                  {WEEKDAY_SHORT.map((d, i) => (
                    <label key={d} className="flex items-center gap-1 text-sm">
                      <input
                        type="checkbox"
                        checked={form.weekdays.includes(i + 1)}
                        onChange={(e) =>
                          set(
                            "weekdays",
                            e.target.checked
                              ? [...form.weekdays, i + 1].sort((a, b) => a - b)
                              : form.weekdays.filter((x) => x !== i + 1)
                          )
                        }
                      />
                      {d}
                    </label>
                  ))}
                </div>
              </Field>
            )}
            {form.frequency === "weekly" && (
              <Field label="Son gün">
                <select className={inputClass} value={form.weekday ?? 1} onChange={(e) => set("weekday", Number(e.target.value))}>
                  {WEEKDAY_LABELS.map((d, i) => (
                    <option key={d} value={i + 1}>
                      {d}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {form.frequency === "monthly" && (
              <Field label="Ayın kaçında" hint="Ay kısaysa ayın son günü sayılır.">
                <input
                  type="number"
                  min={1}
                  max={31}
                  className={inputClass}
                  value={form.month_day ?? 1}
                  onChange={(e) => set("month_day", Math.min(31, Math.max(1, Number(e.target.value) || 1)))}
                />
              </Field>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className={buttonSecondary} onClick={() => setForm(null)} disabled={busy}>
                Vazgeç
              </button>
              <button
                type="button"
                className={buttonPrimary}
                disabled={busy || form.title.trim().length < 3 || (form.frequency === "daily" && form.weekdays.length === 0)}
                onClick={() => save(form)}
              >
                Kaydet
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex justify-end">
              <button type="button" className={buttonPrimary} onClick={() => setForm({ ...EMPTY })}>
                + Yeni madde
              </button>
            </div>
            {items === null ? (
              <Loading />
            ) : (
              <ul className="divide-y border rounded text-sm">
                {items.map((item) => (
                  <li key={item.id} className={`p-3 flex flex-wrap items-center gap-3 ${item.is_active ? "" : "bg-gray-50 text-gray-500"}`}>
                    <div className="flex-1 min-w-[14rem]">
                      <div className="font-medium">{item.title}</div>
                      <div className="text-xs text-gray-500">
                        {FREQUENCY_LABELS[item.frequency]} · {scheduleLabel(item)} · {AREA_LABELS[item.area]}
                        {!item.is_active && " · Pasif"}
                      </div>
                    </div>
                    <button type="button" className="text-blue-700 hover:underline" onClick={() => setForm(toInput(item))}>
                      Düzenle
                    </button>
                    <button
                      type="button"
                      className="text-gray-600 hover:underline"
                      disabled={busy}
                      onClick={() => save({ ...toInput(item), is_active: !item.is_active })}
                    >
                      {item.is_active ? "Pasife al" : "Aktif et"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </CrmModal>
  );
}
