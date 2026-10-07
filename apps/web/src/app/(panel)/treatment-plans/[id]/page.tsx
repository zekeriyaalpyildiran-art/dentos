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
}

interface TreatmentPlan {
  id: string;
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
  const [installments, setInstallments] = useState(1);

  useEffect(() => {
    if (!user?.clinic_id || !params.id) return;
    fetchPlan();
    fetchPayments();
  }, [user?.clinic_id, params.id]);

  const fetchPlan = async () => {
    try {
      const { data, error } = await supabase
        .from("treatment_plans")
        .select(
          `
          id,
          title,
          description,
          total_cost,
          status,
          created_at,
          patients(full_name),
          doctors(full_name),
          treatment_items(*)
        `
        )
        .eq("id", params.id)
        .eq("clinic_id", user?.clinic_id)
        .single();

      if (error) throw error;

      setPlan({
        id: data.id,
        patient_name: data.patients?.full_name || "Unknown",
        doctor_name: data.doctors?.full_name || "Unknown",
        title: data.title,
        description: data.description,
        total_cost: data.total_cost,
        status: data.status,
        items: data.treatment_items || [],
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

  const handleProcessPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    setProcessingPayment(true);

    try {
      const amount = parseFloat(paymentAmount);
      if (amount <= 0) {
        alert("Geçerli bir tutar girin");
        return;
      }

      // TODO: Integrate with PaymentService
      // const paymentService = createPaymentService(config);
      // const result = await paymentService.processPayment({...});

      console.log(
        `[PAYMENT] Processing ₺${amount} for plan ${params.id} (${installments} installments)`
      );

      // Mock payment creation
      const { error } = await supabase.from("payments").insert([
        {
          clinic_id: user?.clinic_id,
          treatment_plan_id: params.id,
          patient_id: plan?.id,
          amount,
          status: "paid",
          payment_method: "card",
          paid_at: new Date().toISOString(),
        },
      ]);

      if (error) throw error;

      alert("Ödeme başarıyla alındı");
      setPaymentAmount("");
      fetchPayments();
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
                </tr>
              </thead>
              <tbody>
                {plan.items.map((item) => (
                  <tr key={item.id} className="border-b">
                    <td className="px-6 py-4 text-sm">{item.procedure_name}</td>
                    <td className="px-6 py-4 text-sm">{item.quantity}</td>
                    <td className="px-6 py-4 text-sm text-right">
                      ₺{item.unit_price.toLocaleString("tr-TR")}
                    </td>
                    <td className="px-6 py-4 text-sm text-right font-semibold">
                      ₺{item.total_price.toLocaleString("tr-TR")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
                <span className="font-semibold text-green-600">
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
                    Taksit
                  </label>
                  <select
                    value={installments}
                    onChange={(e) => setInstallments(parseInt(e.target.value))}
                    className="w-full px-4 py-2 border rounded"
                  >
                    <option value="1">Tek Ödeme</option>
                    <option value="3">3 Ay</option>
                    <option value="6">6 Ay</option>
                    <option value="12">12 Ay</option>
                  </select>
                </div>

                <button
                  type="submit"
                  disabled={processingPayment}
                  className="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400"
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
