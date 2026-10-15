"use client";

// Lab job detail (spec p9_clinical §7.8): dates, items, status history, cost card (cost viewers only).

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import {
  UUID_RE,
  clinLabOrderDeleteDraft,
  clinLabOrderDetail,
  listLabs,
  toClinicalError,
  type ClinicalError,
  type LabOrderDetail,
} from "@/lib/clinical/rpc";
import { LAB_ITEM_TYPE_LABELS, LAB_MATERIAL_LABELS, LAB_STATUS_LABELS } from "@/lib/clinical/codes";
import { formatDay, formatDateTime, istanbulToday } from "@/lib/clinical/dates";
import { LabStatusDialog, statusWarningText } from "@/components/clinical/LabStatusDialog";
import { LabCostCard } from "@/components/clinical/LabCostCard";
import { LabStatusBadge } from "@/components/clinical/LabBadges";
import { ClinicalNotice, ErrorBox, Loading, Toast, clinDanger, clinPrimary, clinSecondary } from "@/components/clinical/ui";

const LOCKED = ["ready", "delivered", "cancelled"];

function Info({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-2 lg:col-span-3" : ""}>
      <div className="text-sm text-gray-600">{label}</div>
      <div className="font-semibold text-gray-900">{children}</div>
    </div>
  );
}

export default function LabOrderDetailPage() {
  const params = useParams<{ id: string }>();
  const orderId = params.id;
  const router = useRouter();
  const user = useAuthStore((s) => s.user);

  const [detail, setDetail] = useState<LabOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClinicalError | null>(null);
  const [actionError, setActionError] = useState<ClinicalError | null>(null);
  const [labPhone, setLabPhone] = useState<string>("");
  const [statusOpen, setStatusOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const req = useRef(0);

  const load = useCallback(async () => {
    if (!orderId || !UUID_RE.test(orderId)) {
      setLoading(false);
      return;
    }
    const r = ++req.current;
    try {
      const d = await clinLabOrderDetail(orderId);
      if (r !== req.current) return;
      setDetail(d);
      setError(null);
    } catch (err) {
      if (r === req.current) setError(toClinicalError(err));
    } finally {
      if (r === req.current) setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    if (user?.clinic_id) void load();
  }, [load, user?.clinic_id]);

  const labId = detail?.order.lab_id ?? null;
  useEffect(() => {
    if (!labId) return;
    listLabs()
      .then((labs) => setLabPhone(labs.find((l) => l.id === labId)?.phone ?? ""))
      .catch(() => setLabPhone(""));
  }, [labId]);

  const deleteDraft = async () => {
    if (!detail) return;
    const o = detail.order;
    if (!confirm(`${o.order_number} numaralı taslak sipariş ve kalemleri silinsin mi? Bu işlem geri alınamaz.`)) return;
    setDeleting(true);
    setActionError(null);
    try {
      await clinLabOrderDeleteDraft(o.id, o.version);
      router.push("/lab");
    } catch (err) {
      setActionError(toClinicalError(err));
      setDeleting(false);
    }
  };

  if (loading) return <div className="p-8"><Loading /></div>;

  if (!detail) {
    return (
      <div className="p-8 space-y-4">
        <Link href="/lab" className="text-blue-600 hover:underline text-sm">
          ← Laboratuvar işleri
        </Link>
        {error && !error.isNotFound ? <ClinicalNotice error={error} /> : <p className="text-gray-600">Lab siparişi bulunamadı</p>}
      </div>
    );
  }

  const { order, items, events, flags } = detail;
  const today = detail.today ?? istanbulToday();
  const locked = LOCKED.includes(order.status);

  return (
    <div className="p-4 md:p-8 space-y-6 text-gray-900">
      <Link href="/lab" className="text-blue-600 hover:underline text-sm">
        ← Laboratuvar işleri
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl md:text-3xl font-bold">Sipariş {order.order_number}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <LabStatusBadge order={order} />
            {order.is_late && order.days_late ? (
              <span className="text-sm text-red-700">Gecikti · {order.days_late} gün</span>
            ) : null}
          </div>
        </div>
        {flags.can_write && (
          <div className="flex flex-wrap gap-2">
            {order.allowed_next.length > 0 && (
              <button type="button" className={clinPrimary} onClick={() => setStatusOpen(true)} disabled={deleting}>
                Durum değiştir
              </button>
            )}
            <Link href={`/lab/${order.id}/edit`} className={`${clinSecondary} inline-flex items-center`}>
              {locked ? "Notu düzenle" : "Düzenle"}
            </Link>
            {order.status === "draft" && (
              <button type="button" className={clinDanger} onClick={() => void deleteDraft()} disabled={deleting}>
                {deleting ? "Siliniyor..." : "Taslağı sil"}
              </button>
            )}
          </div>
        )}
      </div>

      <ClinicalNotice error={error} />
      <ErrorBox error={actionError} onReload={() => void load()} />

      <div className="bg-white rounded-lg shadow p-4 md:p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <Info label="Hasta">
          <Link href={`/patients/${order.patient_id}`} className="text-blue-700 hover:underline">
            {order.patient_name}
          </Link>
        </Info>
        <Info label="Hekim">{order.doctor_name || "—"}</Info>
        <Info label="Laboratuvar">
          {order.lab_name || "—"}
          {order.lab_active === false && <span className="font-normal text-gray-500"> (pasif)</span>}
          {labPhone && (
            <a href={`tel:${labPhone.replace(/[^0-9+]/g, "")}`} className="block text-sm font-normal text-blue-700 hover:underline">
              {labPhone}
            </a>
          )}
        </Info>
        <Info label="Gönderim">{formatDay(order.sent_on)}</Info>
        <Info label="Beklenen dönüş">
          <span className={order.is_late ? "text-red-700" : ""}>{formatDay(order.due_date)}</span>
        </Info>
        <Info label="Son prova">{formatDay(order.last_try_in_on)}</Info>
        <Info label="Kliniğe geliş">{formatDay(order.received_on)}</Info>
        <Info label="Hastaya teslim">{formatDay(order.delivery_date)}</Info>
        <Info label="Revizyon sayısı">{order.revision_count}</Info>
        {order.status === "cancelled" && order.cancel_reason && <Info label="İptal nedeni" wide>{order.cancel_reason}</Info>}
        <Info label="Notlar" wide>
          <span className="font-normal whitespace-pre-wrap">{order.notes || "—"}</span>
        </Info>
      </div>

      <section className="space-y-3">
        <h2 className="text-xl font-bold">Sipariş kalemleri</h2>
        <div className="bg-white rounded-lg shadow overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-100 border-b text-left text-gray-800">
              <tr>
                <th className="px-4 py-3 font-semibold">Tür</th>
                <th className="px-4 py-3 font-semibold">Diş No</th>
                <th className="px-4 py-3 font-semibold">Malzeme</th>
                <th className="px-4 py-3 font-semibold">Renk</th>
                <th className="px-4 py-3 font-semibold">Adet</th>
                <th className="px-4 py-3 font-semibold">Açıklama</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-gray-500">
                    Bu siparişte kalem yok
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr key={item.id} className="border-b">
                    <td className="px-4 py-3">{LAB_ITEM_TYPE_LABELS[item.item_type] ?? item.item_type}</td>
                    <td className="px-4 py-3">{item.tooth_number || "—"}</td>
                    <td className="px-4 py-3">{item.material ? LAB_MATERIAL_LABELS[item.material] ?? item.material : "—"}</td>
                    <td className="px-4 py-3">{item.color_code || "—"}</td>
                    <td className="px-4 py-3">{item.quantity ?? 1}</td>
                    <td className="px-4 py-3">{item.description || "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-bold">Durum geçmişi</h2>
        {events.length === 0 ? (
          <p className="text-gray-500 text-sm">Kayıtlı durum değişikliği yok.</p>
        ) : (
          <ol className="bg-white rounded-lg shadow divide-y">
            {events.map((e, i) => (
              <li key={`${e.created_at}-${i}`} className="px-4 py-3 text-sm">
                <span className="font-medium tabular-nums">{formatDay(e.on_date)}</span>
                {" · "}
                {e.from_status ? `${LAB_STATUS_LABELS[e.from_status] ?? e.from_status} → ` : ""}
                {LAB_STATUS_LABELS[e.to_status] ?? e.to_status}
                {e.actor_name ? ` · ${e.actor_name}` : ""}
                {e.note ? <span className="text-gray-600"> · {e.note}</span> : null}
                <span className="block text-xs text-gray-400">Kayıt: {formatDateTime(e.created_at)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {"cost" in order && <LabCostCard order={order} flags={flags} onChanged={() => void load()} />}

      {statusOpen && (
        <LabStatusDialog
          order={order}
          today={today}
          onClose={() => setStatusOpen(false)}
          onDone={(_o, warnings) => {
            setStatusOpen(false);
            setToast(statusWarningText(warnings) ?? "Durum güncellendi.");
            void load();
          }}
        />
      )}
      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}
