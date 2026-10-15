"use client";

// Lab işini düzenle (spec p9_clinical §7.7); arrived / delivered / cancelled jobs change the notes only.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import {
  UUID_RE,
  clinLabOrderDetail,
  toClinicalError,
  type ClinicalError,
  type LabOrderDetail,
} from "@/lib/clinical/rpc";
import { istanbulToday } from "@/lib/clinical/dates";
import { LabForm } from "@/components/clinical/LabForm";
import { ClinicalNotice, Loading } from "@/components/clinical/ui";

export default function EditLabOrderPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [detail, setDetail] = useState<LabOrderDetail | null>(null);
  const [error, setError] = useState<ClinicalError | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.clinic_id || !id) return;
    if (!UUID_RE.test(id)) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    clinLabOrderDetail(id)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err) => {
        if (!cancelled) setError(toClinicalError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, user?.clinic_id]);

  return (
    <div className="p-4 md:p-8 max-w-4xl space-y-4">
      <Link href={`/lab/${id}`} className="text-blue-600 hover:underline text-sm">
        ← Sipariş detayı
      </Link>
      <h1 className="text-2xl md:text-3xl font-bold text-gray-900">
        {detail ? `Sipariş ${detail.order.order_number} · düzenle` : "Lab işini düzenle"}
      </h1>
      {loading ? (
        <Loading />
      ) : error ? (
        <ClinicalNotice error={error} />
      ) : !detail ? (
        <p className="text-gray-700">Lab siparişi bulunamadı</p>
      ) : !detail.flags.can_write ? (
        <p className="text-gray-700">Bu hesap klinik kayıt oluşturamaz veya değiştiremez.</p>
      ) : (
        <LabForm
          order={detail.order}
          items={detail.items}
          today={detail.today ?? istanbulToday()}
          cancelHref={`/lab/${id}`}
          onSaved={(order) => router.push(`/lab/${order.id}`)}
        />
      )}
    </div>
  );
}
