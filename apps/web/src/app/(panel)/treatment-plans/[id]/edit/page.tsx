"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";
import { centsToInput } from "@/lib/finance";
import {
  CURRENCY_SYMBOLS,
  amountToCents,
  asCurrency,
  centsToAmount,
  formatMoney,
  microToInput,
  microToText,
  parseMoney,
  ppPlanAccount,
  rateMicro,
  serverErrorText,
  type Currency,
} from "@/lib/payments";
import { QuoteCurrencyFields } from "../../_components/QuoteCurrencyFields";
import { useFxRates, useRateField } from "../../_components/payment-ui";

type TreatmentStatus = "draft" | "proposed" | "approved" | "in_progress" | "completed" | "cancelled";

const STATUS_OPTIONS: { value: TreatmentStatus; label: string }[] = [
  { value: "draft", label: "Taslak" },
  { value: "proposed", label: "Önerilen" },
  { value: "approved", label: "Onaylı" },
  { value: "in_progress", label: "Devam Ediyor" },
  { value: "completed", label: "Tamamlandı" },
  { value: "cancelled", label: "İptal" },
];

// Postgres rejects non-uuid ids, so such routes are treated as not found.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const roundMoney = (value: number) => Math.round(value * 100) / 100;

export default function EditTreatmentPlanPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const { user } = useAuthStore();
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [found, setFound] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [patientName, setPatientName] = useState("");
  const [doctorName, setDoctorName] = useState("");
  const [title, setTitle] = useState("");
  const [totalCost, setTotalCost] = useState("");
  // Sum of the plan's items, or null when it has none and the total is entered by hand.
  const [itemsTotal, setItemsTotal] = useState<number | null>(null);
  // total_cost as stored (cents): with items it is written only when the item sum differs from it.
  const [storedTotalCents, setStoredTotalCents] = useState<number | null>(null);
  const [status, setStatus] = useState<TreatmentStatus>("draft");
  const [completedAt, setCompletedAt] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  // Quote currency and rate as stored, to send them only when the user changes them (the trigger re-resolves them).
  const [currency, setCurrency] = useState<Currency>("TRY");
  const [stored, setStored] = useState<{ currency: Currency; rate: bigint | null } | null>(null);
  const [rateChecked, setRateChecked] = useState(false);
  // From pp_plan_account: payments that count lock the currency; the total may not drop below the applied sum.
  const [paymentInfo, setPaymentInfo] = useState<{ locked: boolean; applied: number } | null>(null);
  const foreign = currency !== "TRY";
  const rates = useFxRates(null, foreign);
  const rateField = useRateField(foreign ? rates.of(currency) : null);
  const setRateText = rateField.setText;

  useEffect(() => {
    if (!user?.clinic_id || !id) return;

    const fetchPlan = async () => {
      try {
        if (!UUID_RE.test(id)) return;

        const { data, error } = await supabase
          .from("treatment_plans")
          .select(
            "title, description, total_cost, currency, quote_fx_rate, status, completed_at, patients(full_name), doctors(users(full_name)), treatment_items(total_price)"
          )
          .eq("id", id)
          .eq("clinic_id", user.clinic_id)
          .maybeSingle();

        if (error) throw error;
        if (!data) return;
        const embeds = data as unknown as {
          patients: { full_name: string } | null;
          doctors: { users: { full_name: string } | null } | null;
          treatment_items: { total_price: number }[] | null;
          currency?: unknown;
          quote_fx_rate?: number | string | null;
        };
        const items = embeds.treatment_items || [];

        setFound(true);
        setPatientName(embeds.patients?.full_name || "-");
        setDoctorName(embeds.doctors?.users?.full_name || "-");
        setTitle(data.title);
        setTotalCost(centsToInput(amountToCents(data.total_cost)));
        setStoredTotalCents(amountToCents(data.total_cost));
        const cur = asCurrency(embeds.currency);
        const rate = cur === "TRY" ? null : rateMicro(embeds.quote_fx_rate ?? null);
        setCurrency(cur);
        setStored({ currency: cur, rate });
        if (rate !== null) setRateText(microToInput(rate));
        setItemsTotal(
          items.length > 0
            ? roundMoney(items.reduce((sum, item) => sum + Number(item.total_price), 0))
            : null
        );
        setStatus(data.status);
        setCompletedAt(data.completed_at);
        setNotes(data.description || "");
      } catch (err) {
        console.error("Error fetching plan:", err);
        setLoadError("Plan yüklenemedi, lütfen tekrar deneyin.");
      } finally {
        setLoading(false);
      }
    };

    fetchPlan();
    if (UUID_RE.test(id)) {
      ppPlanAccount(id)
        .then((acc) =>
          setPaymentInfo({
            locked: acc.totals.by_currency.some((c) => c.count > 0) || acc.payments.some((p) => p.counts),
            applied: acc.totals.applied_cents,
          })
        )
        .catch((err) => console.error("Error fetching plan payments:", err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.clinic_id, id]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveError("");
    if (!user?.clinic_id) return;

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setSaveError("Plan başlığı boş olamaz.");
      return;
    }

    const values: Record<string, unknown> = {
      title: trimmedTitle,
      description: notes.trim() || null,
      status,
      completed_at: status === "completed" ? completedAt ?? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    };

    // With items, total_cost follows their sum (as the detail page keeps it), so only a plan without items takes a typed total.
    if (itemsTotal === null) {
      const cost = parseMoney(totalCost, currency, { allowZero: true });
      if (!cost.ok) {
        setSaveError(cost.error);
        return;
      }
      if (paymentInfo && cost.cents < paymentInfo.applied) {
        setSaveError(
          `Plan toplamı, plana yansıyan tahsilatın (${formatMoney(paymentInfo.applied, currency)}) altına inemez.`
        );
        return;
      }
      values.total_cost = centsToAmount(cost.cents);
    }

    // Quote currency / rate: sent only when changed, so an untouched plan keeps its stored quote.
    if (stored) {
      const currencyChanged = currency !== stored.currency;
      if (foreign) {
        if (!rateField.parsed.ok) {
          setSaveError(rateField.parsed.error);
          return;
        }
        const rateChanged = rateField.parsed.micro !== stored.rate;
        if (currencyChanged || rateChanged) {
          if (rateField.farOff && !rateChecked) {
            setSaveError("Önerilenden farklı teklif kurunu kontrol edip onaylayın.");
            return;
          }
          values.currency = currency;
          values.quote_fx_rate = Number(microToText(rateField.parsed.micro));
          values.quote_fx_rate_id = rateField.suggestion?.id ?? null;
          // A new rate is dated by the trigger (the suggested rate's day, else today).
          values.quote_fx_on = null;
        }
      } else if (currencyChanged) {
        values.currency = "TRY";
      }
    }

    setSaving(true);
    try {
      if (itemsTotal !== null) {
        // Save the current item sum shown above, which also repairs a total left stale by a failed recalculation.
        const { data: rows, error: itemsError } = await supabase
          .from("treatment_items")
          .select("total_price")
          .eq("treatment_plan_id", id)
          .eq("clinic_id", user.clinic_id);

        if (itemsError) throw itemsError;
        const sumCents = (rows || []).reduce((sum, row) => sum + amountToCents(row.total_price), 0);
        // Written only when it differs, and never below what payments credited to the plan (the guard would refuse
        // the whole update, so an unrelated edit such as the status would be blocked by a stale total).
        if (sumCents !== storedTotalCents && !(paymentInfo && sumCents < paymentInfo.applied)) {
          values.total_cost = centsToAmount(sumCents);
        }
      }

      const { data, error } = await supabase
        .from("treatment_plans")
        .update(values)
        .eq("id", id)
        .eq("clinic_id", user.clinic_id)
        .select("id");

      if (error) throw error;
      // RLS silently skips rows the user may not update.
      if (!data || data.length === 0) {
        setSaveError("Plan güncellenemedi. Bu planı değiştirme yetkiniz olmayabilir.");
        return;
      }

      router.replace(`/treatment-plans/${id}`);
    } catch (err) {
      console.error("Error saving plan:", err);
      setSaveError(serverErrorText(err) ?? "Plan kaydedilemedi, lütfen tekrar deneyin.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="p-8">Yükleniyor...</div>;
  }

  if (!found) {
    return <div className="p-8">{loadError || "Plan bulunamadı"}</div>;
  }

  return (
    <div className="p-8">
      <button
        onClick={() => router.push(`/treatment-plans/${id}`)}
        className="mb-6 px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
      >
        ← Geri Dön
      </button>

      <h1 className="text-3xl font-bold mb-8">Tedavi Planını Düzenle</h1>

      <div className="max-w-2xl bg-white rounded-lg shadow p-6 text-gray-900">
        <form onSubmit={handleSave} className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-gray-500 text-sm">Hasta</div>
              <div className="text-lg font-semibold">{patientName}</div>
            </div>
            <div>
              <div className="text-gray-500 text-sm">Hekim</div>
              <div className="text-lg font-semibold">{doctorName}</div>
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2">Plan Başlığı</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-4 py-2 border rounded"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2">Toplam Tutar ({CURRENCY_SYMBOLS[currency]})</label>
            {itemsTotal === null ? (
              <input
                type="text"
                inputMode="decimal"
                value={totalCost}
                onChange={(e) => setTotalCost(e.target.value)}
                className="w-full px-4 py-2 border rounded"
                placeholder="0,00"
                autoComplete="off"
                required
              />
            ) : (
              <>
                <div className="text-lg font-semibold">{formatMoney(amountToCents(itemsTotal), currency)}</div>
                <p className="mt-1 text-xs text-gray-500">
                  Toplam tutar plandaki işlemlerden hesaplanır. Değiştirmek için plan detayından işlem ekleyin veya kaldırın.
                </p>
              </>
            )}
          </div>

          {paymentInfo && paymentInfo.applied > 0 && (
            <p className="text-xs text-gray-500 -mt-4">
              Plana yansıyan tahsilat: {formatMoney(paymentInfo.applied, currency)}. Toplam bunun altına inemez.
            </p>
          )}

          <QuoteCurrencyFields
            currency={currency}
            onCurrency={(c) => {
              setCurrency(c);
              setRateChecked(false);
              if (stored && c === stored.currency && stored.rate !== null) setRateText(microToInput(stored.rate));
              else rateField.reset();
            }}
            field={rateField}
            ratesLoading={rates.loading}
            ratesError={rates.error?.message ?? null}
            today={rates.data?.today ?? ""}
            totalCents={
              itemsTotal !== null
                ? amountToCents(itemsTotal)
                : (() => {
                    const p = parseMoney(totalCost, currency, { allowZero: true });
                    return p.ok ? p.cents : null;
                  })()
            }
            currencyLocked={!!paymentInfo?.locked || itemsTotal !== null}
            lockReason={
              paymentInfo?.locked
                ? "Ödeme alınmış planın para birimi değiştirilemez."
                : "Kalemi olan planın para birimi değiştirilemez; kalem fiyatları bu para biriminde girildi."
            }
            totalReinterpreted={
              !!stored && currency !== stored.currency && itemsTotal === null && (storedTotalCents ?? 0) > 0
            }
            rateChecked={rateChecked}
            onRateChecked={setRateChecked}
            disabled={saving}
          />

          <div>
            <label className="block text-sm font-semibold mb-2">Durum</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as TreatmentStatus)}
              className="w-full px-4 py-2 border rounded"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2">Notlar</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              className="w-full px-4 py-2 border rounded"
            />
          </div>

          {saveError && <p className="text-red-600 text-sm">{saveError}</p>}

          <button
            type="submit"
            disabled={saving}
            className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-500"
          >
            {saving ? "Kaydediliyor..." : "Kaydet"}
          </button>
        </form>
      </div>
    </div>
  );
}
