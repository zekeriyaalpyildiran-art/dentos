"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";
import {
  CURRENCY_LABELS,
  CURRENCY_SYMBOLS,
  amountToCents,
  asCurrency,
  centsToAmount,
  formatMoney,
  serverErrorText,
  type Currency,
  type PlanAccountJson,
} from "@/lib/payments";
import { PlanPaymentPanel } from "../_components/PlanPaymentPanel";

interface TreatmentItem {
  id: string;
  procedure_name: string;
  quantity: number;
  unit_price: number;
  total_price: number;
  created_at: string;
}

interface Procedure {
  id: string;
  name: string;
  default_price: number | null;
}

interface TreatmentPlan {
  id: string;
  patient_id: string;
  patient_name: string;
  doctor_name: string;
  title: string;
  description: string;
  total_cost: number;
  currency: Currency;
  status: string;
  items: TreatmentItem[];
  created_at: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const roundMoney = (value: number) => Math.round(value * 100) / 100;

const parseQuantity = (value: string) => {
  if (!/^\d+$/.test(value.trim())) return null;
  const quantity = parseInt(value, 10);
  return quantity >= 1 ? quantity : null;
};

const parseUnitPrice = (value: string) => {
  if (value.trim() === "") return null;
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : null;
};

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  draft: { label: "Taslak", className: "bg-gray-100 text-gray-800" },
  proposed: { label: "Önerilen", className: "bg-blue-100 text-blue-800" },
  approved: { label: "Onaylı", className: "bg-green-100 text-green-800" },
  in_progress: { label: "Devam Ediyor", className: "bg-yellow-100 text-yellow-800" },
  completed: { label: "Tamamlandı", className: "bg-green-100 text-green-800" },
  cancelled: { label: "İptal", className: "bg-red-100 text-red-800" },
};

export default function TreatmentPlanPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuthStore();
  const supabase = createClient();

  const [plan, setPlan] = useState<TreatmentPlan | null>(null);
  const [loading, setLoading] = useState(true);
  // Payment figures come only from pp_plan_account (reception cannot read the payments table).
  const [account, setAccount] = useState<PlanAccountJson | null>(null);
  const [panelRefresh, setPanelRefresh] = useState(0);
  const onAccount = useCallback((acc: PlanAccountJson | null) => setAccount(acc), []);
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [itemProcedureId, setItemProcedureId] = useState("");
  const [itemQuantity, setItemQuantity] = useState("1");
  const [itemUnitPrice, setItemUnitPrice] = useState("");
  const [addingItem, setAddingItem] = useState(false);
  const [removingItemId, setRemovingItemId] = useState<string | null>(null);
  const [itemError, setItemError] = useState("");

  useEffect(() => {
    if (!user?.clinic_id || !params.id) return;
    fetchPlan();
    fetchProcedures();
  }, [user?.clinic_id, params.id]);

  const fetchPlan = async () => {
    try {
      // Skip non-uuid ids such as the "new" route, which Postgres would reject.
      if (!UUID_RE.test(params.id)) {
        setLoading(false);
        return;
      }

      const { data, error } = await supabase
        .from("treatment_plans")
        .select(
          `
          id,
          patient_id,
          title,
          description,
          total_cost,
          currency,
          status,
          created_at,
          patients(full_name),
          doctors(users(full_name)),
          treatment_items(*)
        `
        )
        .eq("id", params.id)
        .eq("clinic_id", user?.clinic_id)
        .maybeSingle();

      if (error) throw error;
      if (!data) return;
      const embeds = data as unknown as {
        patients: { full_name: string } | null;
        doctors: { users: { full_name: string } | null } | null;
      };

      setPlan({
        id: data.id,
        patient_id: data.patient_id,
        patient_name: embeds.patients?.full_name || "-",
        doctor_name: embeds.doctors?.users?.full_name || "-",
        title: data.title,
        description: data.description,
        total_cost: Number(data.total_cost),
        currency: asCurrency((data as { currency?: unknown }).currency),
        status: data.status,
        items: ((data.treatment_items || []) as TreatmentItem[])
          .slice()
          .sort((a, b) => a.created_at.localeCompare(b.created_at)),
        created_at: data.created_at,
      });
    } catch (error) {
      console.error("Error fetching plan:", error);
    } finally {
      setLoading(false);
    }
  };

  const fetchProcedures = async () => {
    const { data, error } = await supabase
      .from("procedures_catalog")
      .select("id,name,default_price")
      .eq("clinic_id", user?.clinic_id)
      .eq("is_active", true)
      .order("name");

    if (error) {
      console.error("Error fetching procedures:", error);
      setItemError("İşlem listesi yüklenemedi.");
      return;
    }
    setProcedures(data || []);
  };

  // The plan's items as stored now (id + line total in cents), read right before a change.
  const readItems = async () => {
    const { data: rows, error } = await supabase
      .from("treatment_items")
      .select("id,total_price")
      .eq("treatment_plan_id", params.id)
      .eq("clinic_id", user?.clinic_id);

    if (error) throw error;
    return ((rows || []) as { id: string; total_price: number | string }[]).map((row) => ({
      id: row.id,
      cents: amountToCents(row.total_price),
    }));
  };

  // The database guard (pp_plan_money) refuses a total below what payments credited to the plan, so the total is
  // written BEFORE the item change: a refusal then leaves items and total untouched.
  const updatePlanTotal = async (cents: number) => {
    const { data: updated, error: updateError } = await supabase
      .from("treatment_plans")
      .update({ total_cost: centsToAmount(cents), updated_at: new Date().toISOString() })
      .eq("id", params.id)
      .eq("clinic_id", user?.clinic_id)
      .select("id");

    if (updateError) throw updateError;
    if (!updated || updated.length === 0) {
      throw new Error("Treatment plan total was not updated");
    }
  };

  const sumCents = (rows: { cents: number }[]) => rows.reduce((sum, row) => sum + row.cents, 0);

  // Re-align the total with the stored items after an item write failed (best effort; the error shown is the first one).
  const resyncPlanTotal = async () => {
    try {
      await updatePlanTotal(sumCents(await readItems()));
    } catch (err) {
      console.error("Error re-syncing plan total:", err);
    }
  };

  // Prefill the catalog's default price unless the user has typed a price of their own.
  const handleProcedureChange = (procedureId: string) => {
    const previous = procedures.find((p) => p.id === itemProcedureId);
    const next = procedures.find((p) => p.id === procedureId);
    const currentPrice = parseUnitPrice(itemUnitPrice);
    const untouched =
      itemUnitPrice.trim() === "" ||
      (previous?.default_price != null && currentPrice === Number(previous.default_price));

    setItemProcedureId(procedureId);
    // Catalog prices are TL; a plan in another currency is priced by hand (the option shows the TL price as a hint).
    if (plan && plan.currency !== "TRY") return;
    if (untouched) {
      setItemUnitPrice(next?.default_price != null ? String(next.default_price) : "");
    }
  };

  const handleAddItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.clinic_id) return;
    setItemError("");

    const procedure = procedures.find((p) => p.id === itemProcedureId);
    const quantity = parseQuantity(itemQuantity);
    const unitPrice = parseUnitPrice(itemUnitPrice);

    if (!procedure) {
      setItemError("Lütfen bir işlem seçin.");
      return;
    }
    if (quantity === null) {
      setItemError("Miktar en az 1 olan bir tam sayı olmalı.");
      return;
    }
    if (unitPrice === null) {
      setItemError("Geçerli bir birim fiyat girin.");
      return;
    }

    setAddingItem(true);
    const lineTotal = roundMoney(quantity * unitPrice);
    let totalWritten = false;
    let inserted = false;
    try {
      // New total = stored items + the new line. It can be lower than a hand-typed total of a plan without items;
      // the guard refuses that when payments already cover more, before anything is inserted.
      const after = sumCents(await readItems()) + amountToCents(lineTotal);
      if (account && after < account.totals.applied_cents) {
        setItemError("Plan toplamı, plana yansıyan tahsilatın altına inemez.");
        return;
      }
      await updatePlanTotal(after);
      totalWritten = true;

      const { error } = await supabase.from("treatment_items").insert([
        {
          clinic_id: user.clinic_id,
          treatment_plan_id: params.id,
          procedure_id: procedure.id,
          procedure_name: procedure.name,
          quantity,
          unit_price: unitPrice,
          total_price: lineTotal,
        },
      ]);

      if (error) throw error;
      inserted = true;
      setItemProcedureId("");
      setItemQuantity("1");
      setItemUnitPrice("");
    } catch (error) {
      console.error("Error adding treatment item:", error);
      if (totalWritten && !inserted) await resyncPlanTotal();
      setItemError(serverErrorText(error) ?? "İşlem eklenirken hata oluştu.");
    } finally {
      if (totalWritten) {
        await fetchPlan();
        setPanelRefresh((k) => k + 1);
      }
      setAddingItem(false);
    }
  };

  const handleRemoveItem = async (itemId: string) => {
    if (!user?.clinic_id || !plan) return;
    setItemError("");
    // The plan total may not fall below what payments already credited to it (quick check on the loaded figures;
    // the database guard refuses it as well, before the item is touched, see updatePlanTotal).
    const item = plan.items.find((i) => i.id === itemId);
    if (item && account) {
      const after = amountToCents(plan.total_cost) - amountToCents(item.total_price);
      if (after < account.totals.applied_cents) {
        setItemError("Plan toplamı, plana yansıyan tahsilatın altına inemez.");
        return;
      }
    }
    if (!confirm("Bu işlem plandan kaldırılsın mı?")) return;
    setRemovingItemId(itemId);

    let totalWritten = false;
    let removed = false;
    try {
      const rows = await readItems();
      if (!rows.some((row) => row.id === itemId)) throw new Error("Treatment item not found");
      // Lower the total first: if payments recorded meanwhile cover more, the guard refuses and nothing is lost.
      await updatePlanTotal(sumCents(rows.filter((row) => row.id !== itemId)));
      totalWritten = true;

      const { data, error } = await supabase
        .from("treatment_items")
        .delete()
        .eq("id", itemId)
        .eq("clinic_id", user.clinic_id)
        .select("id");

      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error("Treatment item was not deleted");
      }
      removed = true;
    } catch (error) {
      console.error("Error removing treatment item:", error);
      if (totalWritten && !removed) await resyncPlanTotal();
      setItemError(serverErrorText(error) ?? "İşlem kaldırılırken hata oluştu.");
    } finally {
      if (totalWritten) {
        await fetchPlan();
        setPanelRefresh((k) => k + 1);
      }
      setRemovingItemId(null);
    }
  };

  const itemBusy = addingItem || removingItemId !== null;
  const draftQuantity = parseQuantity(itemQuantity);
  const draftUnitPrice = parseUnitPrice(itemUnitPrice);
  const draftLineTotal =
    draftQuantity !== null && draftUnitPrice !== null
      ? roundMoney(draftQuantity * draftUnitPrice)
      : 0;

  if (loading) {
    return <div className="p-8">Yükleniyor...</div>;
  }

  if (!plan) {
    return <div className="p-8">Plan bulunamadı</div>;
  }

  return (
    <div className="p-8">
      <button
        onClick={() => router.back()}
        className="mb-6 px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
      >
        ← Geri Dön
      </button>

      <div className="grid grid-cols-3 gap-8">
        {/* Plan Information */}
        <div className="col-span-2">
          <div className="bg-white rounded-lg shadow p-6 mb-6">
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <h2 className="text-2xl font-bold">{plan.title}</h2>
              <span
                className={`px-3 py-1 rounded text-sm font-semibold ${
                  (STATUS_LABELS[plan.status] ?? STATUS_LABELS.draft).className
                }`}
              >
                {STATUS_LABELS[plan.status]?.label ?? plan.status}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div>
                <div className="text-gray-500 text-sm">Hasta</div>
                <div className="text-lg font-semibold">{plan.patient_name}</div>
              </div>
              <div>
                <div className="text-gray-500 text-sm">Hekim</div>
                <div className="text-lg font-semibold">{plan.doctor_name}</div>
              </div>
              <div>
                <div className="text-gray-500 text-sm">Para birimi</div>
                <div className="text-lg font-semibold">{CURRENCY_LABELS[plan.currency]}</div>
              </div>
              <div className="flex items-end justify-end">
                <Link href={`/treatment-plans/${plan.id}/edit`} className="text-sm text-blue-600 hover:underline">
                  Planı düzenle
                </Link>
              </div>
            </div>

            {plan.description && (
              <div className="mb-6">
                <div className="text-gray-500 text-sm mb-2">Açıklama</div>
                <div className="text-gray-700">{plan.description}</div>
              </div>
            )}
          </div>

          {/* Treatment Items */}
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-100 border-b">
                <tr>
                  <th className="px-6 py-4 text-left text-sm font-semibold">
                    İşlem
                  </th>
                  <th className="px-6 py-4 text-left text-sm font-semibold">
                    Miktar
                  </th>
                  <th className="px-6 py-4 text-right text-sm font-semibold">
                    Birim Fiyat
                  </th>
                  <th className="px-6 py-4 text-right text-sm font-semibold">
                    Toplam
                  </th>
                  <th className="px-6 py-4" />
                </tr>
              </thead>
              <tbody>
                {plan.items.length === 0 ? (
                  <tr className="border-b">
                    <td
                      colSpan={5}
                      className="px-6 py-8 text-center text-sm text-gray-500"
                    >
                      Bu plana işlem eklenmemiş
                    </td>
                  </tr>
                ) : (
                  plan.items.map((item) => (
                    <tr key={item.id} className="border-b">
                      <td className="px-6 py-4 text-sm">{item.procedure_name}</td>
                      <td className="px-6 py-4 text-sm">{item.quantity}</td>
                      <td className="px-6 py-4 text-sm text-right">
                        {formatMoney(amountToCents(item.unit_price), plan.currency)}
                      </td>
                      <td className="px-6 py-4 text-sm text-right font-semibold">
                        {formatMoney(amountToCents(item.total_price), plan.currency)}
                      </td>
                      <td className="px-6 py-4 text-sm text-right">
                        <button
                          type="button"
                          onClick={() => handleRemoveItem(item.id)}
                          disabled={itemBusy}
                          className="text-red-600 hover:underline disabled:opacity-50"
                        >
                          {removingItemId === item.id ? "Kaldırılıyor..." : "Kaldır"}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>

            <form onSubmit={handleAddItem} className="p-6">
              <div className="grid grid-cols-4 gap-4">
                <div className="col-span-2">
                  <label className="block text-sm font-semibold mb-2">
                    İşlem
                  </label>
                  <select
                    value={itemProcedureId}
                    onChange={(e) => handleProcedureChange(e.target.value)}
                    className="w-full px-4 py-2 border rounded"
                    required
                  >
                    <option value="">İşlem seçin</option>
                    {procedures.map((procedure) => (
                      <option key={procedure.id} value={procedure.id}>
                        {procedure.default_price != null
                          ? plan.currency === "TRY"
                            ? `${procedure.name} (₺${Number(procedure.default_price).toLocaleString("tr-TR")})`
                            : `${procedure.name} (katalog ₺${Number(procedure.default_price).toLocaleString("tr-TR")})`
                          : procedure.name}
                      </option>
                    ))}
                  </select>
                  {procedures.length === 0 && (
                    <p className="mt-2 text-xs text-gray-500">
                      Katalogda aktif işlem bulunamadı.
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-semibold mb-2">
                    Miktar
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={itemQuantity}
                    onChange={(e) => setItemQuantity(e.target.value)}
                    className="w-full px-4 py-2 border rounded"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold mb-2">
                    Birim Fiyat ({CURRENCY_SYMBOLS[plan.currency]})
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={itemUnitPrice}
                    onChange={(e) => setItemUnitPrice(e.target.value)}
                    className="w-full px-4 py-2 border rounded"
                    placeholder="0.00"
                    required
                  />
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between">
                <div className="text-sm text-gray-600">
                  Satır Toplamı:{" "}
                  <span className="font-semibold text-gray-900">
                    {formatMoney(amountToCents(draftLineTotal), plan.currency)}
                  </span>
                </div>
                <button
                  type="submit"
                  disabled={itemBusy}
                  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-500"
                >
                  {addingItem ? "Ekleniyor..." : "İşlem Ekle"}
                </button>
              </div>

              {itemError && (
                <p className="mt-4 text-sm text-red-600">{itemError}</p>
              )}
            </form>
          </div>
        </div>

        {/* Payments (pp_plan_account) */}
        <div>
          <PlanPaymentPanel planId={plan.id} onAccount={onAccount} refreshKey={panelRefresh} />
        </div>
      </div>
    </div>
  );
}
