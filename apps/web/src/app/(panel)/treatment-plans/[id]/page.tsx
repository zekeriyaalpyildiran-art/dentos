"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";

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
}

interface TreatmentPlan {
  id: string;
  patient_id: string;
  patient_name: string;
  doctor_name: string;
  title: string;
  description: string;
  total_cost: number;
  status: string;
  items: TreatmentItem[];
  created_at: string;
}

interface Payment {
  id: string;
  amount: number;
  status: string;
  paid_at: string;
}

type PaymentMethod = "cash" | "card" | "transfer";

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

export default function TreatmentPlanPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuthStore();
  const supabase = createClient();

  const [plan, setPlan] = useState<TreatmentPlan | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [processingPayment, setProcessingPayment] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  const [successMessage, setSuccessMessage] = useState("");
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
    fetchPayments();
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
        patient_name: embeds.patients?.full_name || "Unknown",
        doctor_name: embeds.doctors?.users?.full_name || "Unknown",
        title: data.title,
        description: data.description,
        total_cost: data.total_cost,
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

  const fetchPayments = async () => {
    try {
      const { data, error } = await supabase
        .from("payments")
        .select("*")
        .eq("treatment_plan_id", params.id)
        .eq("clinic_id", user?.clinic_id)
        .order("created_at", { ascending: false });

      if (error) throw error;
      setPayments(data || []);
    } catch (error) {
      console.error("Error fetching payments:", error);
    }
  };

  const fetchProcedures = async () => {
    const { data, error } = await supabase
      .from("procedures_catalog")
      .select("id,name")
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

  const syncPlanTotal = async () => {
    const { data: rows, error } = await supabase
      .from("treatment_items")
      .select("total_price")
      .eq("treatment_plan_id", params.id)
      .eq("clinic_id", user?.clinic_id);

    if (error) throw error;
    const total = roundMoney(
      (rows || []).reduce((sum, row) => sum + Number(row.total_price), 0)
    );

    const { data: updated, error: updateError } = await supabase
      .from("treatment_plans")
      .update({ total_cost: total, updated_at: new Date().toISOString() })
      .eq("id", params.id)
      .eq("clinic_id", user?.clinic_id)
      .select("id");

    if (updateError) throw updateError;
    if (!updated || updated.length === 0) {
      throw new Error("Treatment plan total was not updated");
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
    let inserted = false;
    try {
      const { error } = await supabase.from("treatment_items").insert([
        {
          clinic_id: user.clinic_id,
          treatment_plan_id: params.id,
          procedure_id: procedure.id,
          procedure_name: procedure.name,
          quantity,
          unit_price: unitPrice,
          total_price: roundMoney(quantity * unitPrice),
        },
      ]);

      if (error) throw error;
      inserted = true;
      setItemProcedureId("");
      setItemQuantity("1");
      setItemUnitPrice("");
      await syncPlanTotal();
    } catch (error) {
      console.error("Error adding treatment item:", error);
      setItemError(
        inserted
          ? "İşlem eklendi ancak plan toplamı güncellenemedi."
          : "İşlem eklenirken hata oluştu."
      );
    } finally {
      if (inserted) await fetchPlan();
      setAddingItem(false);
    }
  };

  const handleRemoveItem = async (itemId: string) => {
    if (!user?.clinic_id) return;
    if (!confirm("Bu işlem plandan kaldırılsın mı?")) return;
    setItemError("");
    setRemovingItemId(itemId);

    let removed = false;
    try {
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
      await syncPlanTotal();
    } catch (error) {
      console.error("Error removing treatment item:", error);
      setItemError(
        removed
          ? "İşlem kaldırıldı ancak plan toplamı güncellenemedi."
          : "İşlem kaldırılırken hata oluştu."
      );
    } finally {
      if (removed) await fetchPlan();
      setRemovingItemId(null);
    }
  };

  const handleProcessPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    setProcessingPayment(true);
    setSuccessMessage("");

    try {
      const amount = parseFloat(paymentAmount);
      if (amount <= 0) {
        alert("Geçerli bir tutar girin");
        return;
      }

      const { error } = await supabase.from("payments").insert([
        {
          clinic_id: user?.clinic_id,
          treatment_plan_id: params.id,
          patient_id: plan?.patient_id,
          amount,
          status: "paid",
          payment_method: paymentMethod,
          notes: "Manuel kayıt",
          paid_at: new Date().toISOString(),
        },
      ]);

      if (error) throw error;

      setSuccessMessage("Ödeme başarıyla kaydedildi.");
      setPaymentAmount("");
      await fetchPayments();
    } catch (error) {
      alert("Ödeme işlenirken hata oluştu");
      console.error("Payment error:", error);
    } finally {
      setProcessingPayment(false);
    }
  };

  const totalPaid = payments
    .filter((p) => p.status === "paid")
    .reduce((sum, p) => sum + p.amount, 0);

  const remaining = plan ? plan.total_cost - totalPaid : 0;

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
            <h2 className="text-2xl font-bold mb-2">{plan.title}</h2>
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div>
                <div className="text-gray-500 text-sm">Hasta</div>
                <div className="text-lg font-semibold">{plan.patient_name}</div>
              </div>
              <div>
                <div className="text-gray-500 text-sm">Hekim</div>
                <div className="text-lg font-semibold">{plan.doctor_name}</div>
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
                        ₺{Number(item.unit_price).toLocaleString("tr-TR")}
                      </td>
                      <td className="px-6 py-4 text-sm text-right font-semibold">
                        ₺{Number(item.total_price).toLocaleString("tr-TR")}
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
                    onChange={(e) => setItemProcedureId(e.target.value)}
                    className="w-full px-4 py-2 border rounded"
                    required
                  >
                    <option value="">İşlem seçin</option>
                    {procedures.map((procedure) => (
                      <option key={procedure.id} value={procedure.id}>
                        {procedure.name}
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
                    Birim Fiyat
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
                    ₺{draftLineTotal.toLocaleString("tr-TR")}
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

        {/* Payment Summary */}
        <div>
          <div className="bg-white rounded-lg shadow p-6 mb-6">
            <h3 className="text-xl font-bold mb-4">Ödeme Özeti</h3>

            <div className="mb-4 pb-4 border-b">
              <div className="flex justify-between mb-2">
                <span className="text-gray-600">Toplam Tutar:</span>
                <span className="font-semibold">
                  ₺{plan.total_cost.toLocaleString("tr-TR")}
                </span>
              </div>
              <div className="flex justify-between mb-2">
                <span className="text-gray-600">Ödenen:</span>
                <span className="font-semibold text-green-700">
                  ₺{totalPaid.toLocaleString("tr-TR")}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Kalan:</span>
                <span className="text-lg font-bold text-red-600">
                  ₺{remaining.toLocaleString("tr-TR")}
                </span>
              </div>
            </div>

            {successMessage && (
              <p className="mb-4 text-sm text-green-700">{successMessage}</p>
            )}

            {remaining > 0 && (
              <form onSubmit={handleProcessPayment}>
                <div className="mb-4">
                  <label className="block text-sm font-semibold mb-2">
                    Ödeme Tutarı
                  </label>
                  <input
                    type="number"
                    min="0"
                    max={remaining}
                    step="0.01"
                    value={paymentAmount}
                    onChange={(e) => setPaymentAmount(e.target.value)}
                    className="w-full px-4 py-2 border rounded"
                    placeholder="0.00"
                    required
                  />
                </div>

                <div className="mb-6">
                  <label className="block text-sm font-semibold mb-2">
                    Ödeme Yöntemi
                  </label>
                  <select
                    value={paymentMethod}
                    onChange={(e) =>
                      setPaymentMethod(e.target.value as PaymentMethod)
                    }
                    className="w-full px-4 py-2 border rounded"
                  >
                    <option value="cash">Nakit</option>
                    <option value="card">Kart (POS)</option>
                    <option value="transfer">Havale</option>
                  </select>
                  {paymentMethod === "card" && (
                    <p className="mt-2 text-xs text-gray-500">
                      Kart ödemesi POS cihazında alındıktan sonra kaydedilir.
                    </p>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={processingPayment}
                  className="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-500"
                >
                  {processingPayment ? "İşleniyor..." : "Ödeme Yap"}
                </button>
              </form>
            )}
          </div>

          {/* Payment History */}
          {payments.length > 0 && (
            <div className="bg-white rounded-lg shadow p-6">
              <h3 className="text-lg font-bold mb-4">Ödeme Geçmişi</h3>
              <div className="space-y-3">
                {payments.map((payment) => (
                  <div
                    key={payment.id}
                    className="flex justify-between items-center pb-3 border-b"
                  >
                    <div>
                      <div className="font-semibold">
                        ₺{payment.amount.toLocaleString("tr-TR")}
                      </div>
                      <div className="text-xs text-gray-500">
                        {new Date(payment.paid_at).toLocaleDateString("tr-TR")}
                      </div>
                    </div>
                    <span className="px-2 py-1 bg-green-100 text-green-800 text-xs rounded">
                      Ödendi
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
