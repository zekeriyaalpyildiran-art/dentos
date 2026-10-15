"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { FinanceShell, useCanWriteFinance } from "@/components/finance/FinanceShell";
import { AuditChanges } from "@/components/finance/AuditChanges";
import { EntryFields, buildEntryInput, type EntryFormState } from "@/components/finance/EntryFields";
import { useReferenceData } from "@/components/finance/useReferenceData";
import {
  Card,
  ErrorBox,
  Field,
  Loading,
  Modal,
  StatusBadge,
  SuccessBox,
  buttonDanger,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from "@/components/finance/ui";
import {
  ACCOUNT_KIND_LABELS,
  AUDIT_ACTION_LABELS,
  AUDIT_ENTITY_LABELS,
  BUCKET_LABELS,
  DIRECTION_LABELS,
  SUBCATEGORY_LABELS,
  UUID_RE,
  centsToInput,
  finCancelEntry,
  finCorrectPayment,
  finEditEntry,
  finEntryDetail,
  finRecordPayment,
  finSetExclusion,
  finVoidPayment,
  formatDay,
  formatMonth,
  formatTL,
  formatTimestamp,
  isDay,
  newId,
  parseTL,
  pickable,
  sortByOrder,
  toFinanceError,
  FinanceError,
  type DetailPaymentJson,
  type EntryDetail,
  type ReferenceData,
} from "@/lib/finance";

export default function FinanceEntryDetailPage() {
  return (
    <FinanceShell title="Kayıt ayrıntısı">
      <Suspense fallback={<Loading />}>
        <EntryDetailView />
      </Suspense>
    </FinanceShell>
  );
}

type Dialog =
  | { kind: "pay" }
  | { kind: "correct"; payment: DetailPaymentJson }
  | { kind: "void"; payment: DetailPaymentJson }
  | { kind: "cancel" }
  | { kind: "exclude" }
  | { kind: "include" }
  | { kind: "edit" };

const SAVED_HINT = "Kaydedildi. Banka ve kasa bakiyelerini ayrıca güncellemeyi unutmayın.";

function EntryDetailView() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const entryId = params.id;
  const canWrite = useCanWriteFinance();
  const ref = useReferenceData();

  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [message, setMessage] = useState<string | null>(searchParams.get("saved") ? SAVED_HINT : null);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    if (!UUID_RE.test(entryId)) {
      setError(new FinanceError("Kayıt bulunamadı.", "PT404", null));
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setDetail(await finEntryDetail(entryId));
      setError(null);
    } catch (err) {
      setError(toFinanceError(err));
    } finally {
      setLoading(false);
    }
  }, [entryId]);

  useEffect(() => {
    load();
  }, [load]);

  /** Every dialog reports success here: close, refresh the record, show the result. */
  const done = async (text: string) => {
    setDialog(null);
    setMessage(text);
    await load();
  };

  if (!detail) {
    return loading ? <Loading /> : <ErrorBox error={error} backHref="/finance/entries" onReload={load} />;
  }

  const e = detail.entry;
  const payments = detail.payments;
  const cancelled = e.status === "cancelled";
  const payLabel = e.direction === "in" ? "Tahsilat kaydet" : "Ödeme kaydet";
  // 0022: financing fee entries change only through /finance/financing (the database refuses every other write);
  // receipt-reconciliation exclusions are controlled by the clinic Excel reconciliation.
  const locked = !!e.is_locked;
  const reconciled = e.exclusion_source === "receipt_reconciliation";
  const canEdit = canWrite && !locked;

  return (
    <div className="space-y-6">
      <Link href="/finance/entries" className="inline-block px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300">
        ← Listeye dön
      </Link>

      <SuccessBox text={message} />
      <ErrorBox error={error} onReload={load} backHref="/finance/entries" />

      <Card
        title={
          <span className="flex flex-wrap items-center gap-3">
            {e.counterparty_name}
            <StatusBadge status={e.status} overdue={e.is_overdue} />
          </span>
        }
        actions={
          canWrite && locked ? (
            <Link href="/finance/financing" className={buttonSecondary}>
              Hasta finansmanında düzelt
            </Link>
          ) : canWrite ? (
            <>
              {!cancelled && e.outstanding_cents > 0 && (
                <button type="button" className={buttonPrimary} onClick={() => setDialog({ kind: "pay" })}>
                  {payLabel}
                </button>
              )}
              {!cancelled && (
                <button type="button" className={buttonSecondary} onClick={() => setDialog({ kind: "edit" })} disabled={!ref.data}>
                  Düzenle
                </button>
              )}
              {!cancelled && e.outstanding_cents > 0 && (
                <button type="button" className={buttonDanger} onClick={() => setDialog({ kind: "cancel" })}>
                  Kalan planı iptal et
                </button>
              )}
              {e.excluded_from_totals ? (
                <button
                  type="button"
                  className={buttonSecondary}
                  onClick={() => setDialog({ kind: "include" })}
                  disabled={reconciled}
                  title={reconciled ? "Klinik Excel tahsilat mutabakatı bu kaydı yönetir." : undefined}
                >
                  Toplamlara geri al
                </button>
              ) : (
                <button type="button" className={buttonSecondary} onClick={() => setDialog({ kind: "exclude" })}>
                  Toplamlardan çıkar
                </button>
              )}
            </>
          ) : undefined
        }
      >
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 text-sm">
          <Info label="Kategori" value={e.category_name} sub={BUCKET_LABELS[e.report_bucket]} />
          <Info label="Yön" value={DIRECTION_LABELS[e.direction]} />
          <Info label="Alt tür" value={e.subcategory ? SUBCATEGORY_LABELS[e.subcategory] : "—"} />
          <Info label="Hakediş ayı" value={e.entitlement_month ? formatMonth(e.entitlement_month) : "—"} />
          <Info label="Vade / tarih" value={formatDay(e.due_date)} sub={e.is_overdue ? "Vadesi geçti" : undefined} />
          <Info label="Tutar" value={formatTL(e.amount_cents)} />
          <Info label="Gerçekleşen" value={formatTL(e.paid_cents)} />
          <Info label="Kalan" value={formatTL(e.outstanding_cents)} />
          <Info
            label="Kişi / kurum kaydı"
            value={e.counterparty_id ? "Kayıtlı" : "Serbest metin"}
            sub={e.report_group_name ?? (e.direction === "out" ? "Diğer borçlar" : undefined)}
          />
          <Info label="Oluşturan" value={e.created_by_name ?? "—"} sub={formatTimestamp(e.created_at)} />
          <Info label="Son değişiklik" value={e.updated_by_name ?? "—"} sub={formatTimestamp(e.updated_at)} />
          <Info label="Sürüm" value={String(e.version)} />
          <div className="sm:col-span-2 lg:col-span-4">
            <dt className="text-gray-500">Açıklama</dt>
            <dd className="text-gray-900 whitespace-pre-wrap">{e.description || "—"}</dd>
          </div>
        </dl>

        {e.is_entitlement && (
          <p className="mt-4 text-sm text-indigo-700">
            Hekim hakedişi kaydı. Sonraki ödemeleri bu kayda ekleyin; hekim, ay ve kategori değiştirilemez.
          </p>
        )}
        {locked && (
          <p className="mt-4 text-sm text-indigo-700">
            Hasta finansmanı kesinti kaydı{e.financing ? ` (${e.financing.reference})` : ""}. Tutar, ödeme ve iptal
            yalnızca{" "}
            <Link href="/finance/financing" className="text-blue-600 hover:underline">
              Hasta finansmanı
            </Link>{" "}
            bölümünden düzeltilir.
          </p>
        )}
        {reconciled && (
          <p className="mt-4 text-sm text-orange-800">
            Bu tahsilat klinik Excel günlük toplamlarıyla eşleştiği için otomatik olarak toplam dışında
            {e.reconciled_month ? ` (${formatMonth(e.reconciled_month)})` : ""}. Klinik Excel aktarımı değişirse
            kendiliğinden güncellenir; elle geri alınamaz.
          </p>
        )}
        {cancelled && (
          <div className="mt-4 p-3 rounded bg-gray-100 text-gray-800 text-sm">
            Kalan plan iptal edildi ({formatTimestamp(e.cancelled_at)}
            {e.cancelled_by_name ? `, ${e.cancelled_by_name}` : ""}). Gerekçe: {e.cancel_reason}. Gerçekleşen
            ödemeler korundu.
          </div>
        )}
        {e.excluded_from_totals && (
          <div className="mt-4 p-3 rounded bg-orange-50 text-orange-800 text-sm">
            Toplamların dışında ({formatTimestamp(e.excluded_at)}
            {e.excluded_by_name ? `, ${e.excluded_by_name}` : ""}). Gerekçe: {e.exclusion_reason}. Ödemeleri
            gerçekleşen toplamlara katılmaz; kalan tutarı planda ve carilerde görünmeye devam eder.
          </div>
        )}
      </Card>

      <Card title="Gerçekleşen hareketler">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-100 border-b">
              <tr className="text-left text-gray-800">
                <th className="px-3 py-2 font-semibold">Tarih</th>
                <th className="px-3 py-2 font-semibold">Hesap</th>
                <th className="px-3 py-2 font-semibold text-right">Tutar</th>
                {e.report_bucket === "doctor" && <th className="px-3 py-2 font-semibold">Dönem</th>}
                <th className="px-3 py-2 font-semibold">Kaydeden</th>
                <th className="px-3 py-2 font-semibold">Durum</th>
                {canEdit && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {payments.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-gray-500">
                    Henüz gerçekleşen hareket yok.
                  </td>
                </tr>
              ) : (
                payments.map((p) => (
                  <tr key={p.id} className={`border-b align-top ${p.is_voided ? "text-gray-400" : "text-gray-900"}`}>
                    <td className="px-3 py-2 whitespace-nowrap">{formatDay(p.paid_on)}</td>
                    <td className="px-3 py-2">
                      {p.account_name}
                      <span className="text-xs text-gray-500"> · {ACCOUNT_KIND_LABELS[p.account_kind]}</span>
                      {!p.account_is_active && <span className="text-xs text-gray-500"> (pasif)</span>}
                      {p.bank_source && (
                        <div className="text-xs text-gray-500">
                          Ekstre: {p.bank_source.file ?? p.bank_source.key}
                          {p.bank_source.description ? ` · ${p.bank_source.description}` : ""}
                        </div>
                      )}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${p.is_voided ? "line-through" : ""}`}>
                      {formatTL(p.amount_cents)}
                    </td>
                    {e.report_bucket === "doctor" && (
                      <td className="px-3 py-2">
                        {p.physician_split === "past" ? "Geçmiş dönem" : p.physician_split === "current" ? "Cari dönem" : "—"}
                      </td>
                    )}
                    <td className="px-3 py-2 text-xs">
                      {p.recorded_by_name ?? "—"}
                      <div className="text-gray-500">{formatTimestamp(p.recorded_at)}</div>
                      {p.updated_at !== p.recorded_at && p.updated_by_name && (
                        <div className="text-gray-500">
                          Düzelten: {p.updated_by_name} · {formatTimestamp(p.updated_at)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {p.is_voided ? (
                        <span className="text-red-600">
                          İptal edildi ({formatTimestamp(p.voided_at)}
                          {p.voided_by_name ? `, ${p.voided_by_name}` : ""}): {p.void_reason}
                        </span>
                      ) : (
                        "Geçerli"
                      )}
                    </td>
                    {canEdit && (
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {!p.is_voided && (
                          <>
                            <button
                              type="button"
                              className="text-blue-600 hover:underline mr-3"
                              onClick={() => setDialog({ kind: "correct", payment: p })}
                              disabled={!ref.data}
                            >
                              Düzelt
                            </button>
                            <button
                              type="button"
                              className="text-red-600 hover:underline"
                              onClick={() => setDialog({ kind: "void", payment: p })}
                            >
                              İptal et
                            </button>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          Yanlış ödemeler silinmez; gerekçeyle iptal edilir ve iptal kaydı burada kalır.
        </p>
      </Card>

      <Card
        title="Değişiklik geçmişi"
        actions={
          <button type="button" className={buttonSecondary} onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? "Gizle" : `Göster (${detail.history.length})`}
          </button>
        }
      >
        {showHistory ? (
          detail.history.length === 0 ? (
            <p className="text-sm text-gray-500">Kayıt yok.</p>
          ) : (
            <ul className="divide-y">
              {detail.history.map((h) => (
                <li key={h.id} className="py-2 text-sm">
                  <div className="text-gray-900">
                    {formatTimestamp(h.at)} · {h.user_name ?? "Sistem"} · {AUDIT_ENTITY_LABELS[h.entity_type] ?? h.entity_type}{" "}
                    {(AUDIT_ACTION_LABELS[h.action] ?? h.action).toLocaleLowerCase("tr-TR")}
                  </div>
                  <AuditChanges action={h.action} changes={h.changes} before={h.before_data} after={h.after_data} />
                </li>
              ))}
            </ul>
          )
        ) : (
          <p className="text-sm text-gray-500">Kayıt ve ödemelerinin tüm değişiklikleri (en yeni 200).</p>
        )}
      </Card>

      {dialog && (dialog.kind === "pay" || dialog.kind === "correct") && ref.data && (
        <PaymentDialog
          refData={ref.data}
          detail={detail}
          payment={dialog.kind === "correct" ? dialog.payment : null}
          onClose={() => setDialog(null)}
          onReload={load}
          onDone={done}
        />
      )}
      {dialog && (dialog.kind === "void" || dialog.kind === "cancel" || dialog.kind === "exclude" || dialog.kind === "include") && (
        <ReasonDialog
          detail={detail}
          kind={dialog.kind}
          payment={dialog.kind === "void" ? dialog.payment : null}
          onClose={() => setDialog(null)}
          onReload={load}
          onDone={done}
        />
      )}
      {dialog?.kind === "edit" && ref.data && (
        <EditDialog refData={ref.data} detail={detail} onClose={() => setDialog(null)} onReload={load} onDone={done} />
      )}
    </div>
  );
}

function Info({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <dt className="text-gray-500">{label}</dt>
      <dd className="font-semibold text-gray-900">{value}</dd>
      {sub && <dd className="text-xs text-gray-500">{sub}</dd>}
    </div>
  );
}

interface DialogProps {
  detail: EntryDetail;
  onClose: () => void;
  onReload: () => Promise<void>;
  onDone: (message: string) => Promise<void>;
}

/** 'Tahsilat / ödeme kaydet' and 'Düzelt' (legacy pay / correctPayment, RT:130-135). */
function PaymentDialog({
  refData,
  detail,
  payment,
  onClose,
  onReload,
  onDone,
}: DialogProps & { refData: ReferenceData; payment: DetailPaymentJson | null }) {
  const e = detail.entry;
  const isCorrect = !!payment;
  // New payment id per opened dialog; retries reuse it (idempotent pay, RT:119).
  const [paymentId] = useState(() => payment?.id ?? newId());
  const defaultAccount =
    payment?.account_id ?? sortByOrder(refData.accounts.filter((a) => a.is_active))[0]?.id ?? "";
  const [paidOn, setPaidOn] = useState(payment?.paid_on ?? detail.today);
  const [amount, setAmount] = useState(centsToInput(payment ? payment.amount_cents : detail.max_payment_cents));
  const [accountId, setAccountId] = useState(defaultAccount);
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);

  const max = payment ? payment.max_correction_cents : detail.max_payment_cents;
  const accounts = sortByOrder(pickable(refData.accounts, payment?.account_id));

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    const parsed = parseTL(amount);
    if (!parsed.ok) return setFormError(parsed.error);
    if (!isDay(paidOn) || paidOn > detail.today) {
      return setFormError(isCorrect ? "Düzeltme tarihi veya tutarı geçersiz." : "Ödeme tarihi ve kalan tutarı kontrol edin.");
    }
    if (parsed.cents > max) {
      return setFormError(`Tutar en fazla ${formatTL(max)} olabilir.`);
    }
    if (!accountId) return setFormError("Hesap seçin.");
    setBusy(true);
    try {
      const args = {
        p_entry_id: e.id,
        p_version: detail.entry.version,
        p_payment_id: paymentId,
        p_paid_on: paidOn,
        p_amount_cents: parsed.cents,
        p_account_id: accountId,
      };
      const res = isCorrect ? await finCorrectPayment(args) : await finRecordPayment(args);
      await onDone(res.already_saved ? "Bu işlem zaten kaydedilmişti." : SAVED_HINT);
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isCorrect ? "Ödemeyi düzelt" : e.direction === "in" ? "Tahsilat kaydet" : "Ödeme kaydet"}
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-gray-600">
          {e.counterparty_name} · {isCorrect ? "Düzeltmede en fazla" : "Kalan"} {formatTL(max)}
        </p>
        <Field label="Gerçekleşme tarihi">
          <input type="date" className={inputClass} value={paidOn} max={detail.today} onChange={(ev) => setPaidOn(ev.target.value)} required />
        </Field>
        <Field label="Gerçekleşen tutar (TL)">
          <input className={inputClass} inputMode="decimal" value={amount} onChange={(ev) => setAmount(ev.target.value)} required />
        </Field>
        <Field label="Hesap">
          <select className={inputClass} value={accountId} onChange={(ev) => setAccountId(ev.target.value)} required>
            <option value="">Seçin</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id} disabled={!a.is_active && a.id !== payment?.account_id}>
                {a.name} ({ACCOUNT_KIND_LABELS[a.kind]}){a.is_active ? "" : " (pasif)"}
              </option>
            ))}
          </select>
        </Field>
        {isCorrect && (
          <p className="text-xs text-gray-500">Ödemeyi tamamen kaldırmak için düzeltme yerine “İptal et” kullanın.</p>
        )}
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

/** Void a payment, cancel the remaining plan, or exclude / include the entry in totals. */
function ReasonDialog({
  detail,
  kind,
  payment,
  onClose,
  onReload,
  onDone,
}: DialogProps & { kind: "void" | "cancel" | "exclude" | "include"; payment: DetailPaymentJson | null }) {
  const e = detail.entry;
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);
  const needsReason = kind !== "include";

  const text = {
    void: {
      title: "Ödemeyi iptal et",
      body: `${formatDay(payment?.paid_on)} tarihli ${formatTL(payment?.amount_cents)} tutarındaki hareket iptal edilecek. Kayıt silinmez; iptal gerekçesiyle birlikte geçmişte kalır.`,
      button: "Ödemeyi iptal et",
      done: "Ödeme iptal edildi.",
    },
    cancel: {
      title: "Kalan planı iptal et",
      body: `${e.counterparty_name} için kalan ${formatTL(e.outstanding_cents)} kapatılacak. Gerçekleşen ödemeler korunur ve aylık rakamlarda kalır. Bu işlem geri alınamaz.`,
      button: "Kalan planı iptal et",
      done: "Kalan plan iptal edildi.",
    },
    exclude: {
      title: "Toplamlardan çıkar",
      body: "Bu kaydın ödemeleri aylık rakamlara, raporlara ve liste toplamlarına katılmaz (örneğin başka bir kayıtta zaten sayılmış bir tahsilat). Kalan tutarı planda ve carilerde görünmeye devam eder.",
      button: "Toplamlardan çıkar",
      done: "Kayıt toplamların dışına alındı.",
    },
    include: {
      title: "Toplamlara geri al",
      body: "Bu kaydın ödemeleri yeniden tüm toplamlara katılacak.",
      button: "Toplamlara geri al",
      done: "Kayıt yeniden toplamlara dahil.",
    },
  }[kind];

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    const trimmed = reason.trim();
    if (needsReason && (trimmed.length < 3 || trimmed.length > 500)) {
      return setFormError("Gerekçe en az 3, en fazla 500 karakter olmalı.");
    }
    setBusy(true);
    try {
      const version = detail.entry.version;
      let res;
      if (kind === "void" && payment) {
        res = await finVoidPayment({ p_entry_id: e.id, p_version: version, p_payment_id: payment.id, p_reason: trimmed });
      } else if (kind === "cancel") {
        res = await finCancelEntry({ p_id: e.id, p_version: version, p_reason: trimmed });
      } else {
        res = await finSetExclusion({
          p_id: e.id,
          p_version: version,
          p_excluded: kind === "exclude",
          p_reason: kind === "exclude" ? trimmed : null,
        });
      }
      await onDone(res.already_saved ? "Bu işlem zaten yapılmıştı." : text.done);
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={text.title} onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-gray-700">{text.body}</p>
        {needsReason && (
          <Field label="Gerekçe" hint="En az 3, en fazla 500 karakter.">
            <textarea className={inputClass} rows={3} maxLength={500} value={reason} onChange={(ev) => setReason(ev.target.value)} required />
          </Field>
        )}
        {formError && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{formError}</div>}
        <ErrorBox error={error} onReload={onReload} />
        <div className="flex gap-2">
          <button type="submit" className={kind === "include" || kind === "exclude" ? buttonPrimary : buttonDanger} disabled={busy}>
            {busy ? "Kaydediliyor..." : text.button}
          </button>
          <button type="button" className={buttonSecondary} onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** 'Ayrıntı / düzenle' (legacy edit, RT:126-129). */
function EditDialog({ refData, detail, onClose, onReload, onDone }: DialogProps & { refData: ReferenceData }) {
  const e = detail.entry;
  const [state, setState] = useState<EntryFormState>({
    category_id: e.category_id,
    subcategory: e.subcategory ?? "",
    counterparty: e.counterparty_name,
    description: e.description,
    due_date: e.due_date,
    amount: centsToInput(e.amount_cents),
    entitlement_month: e.entitlement_month ?? "",
    realized: false,
    account_id: "",
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    const built = buildEntryInput(refData, state, {
      counterparty_id: e.counterparty_id,
      counterparty_name: e.counterparty_name,
    });
    if (!built.ok) return setFormError(built.error);
    if (e.paid_cents > 0 && built.input.p_amount_cents < e.paid_cents) {
      return setFormError(`Tutar gerçekleşen ödemelerden (${formatTL(e.paid_cents)}) düşük olamaz.`);
    }
    setBusy(true);
    try {
      const res = await finEditEntry({ p_id: e.id, p_version: detail.entry.version, ...built.input });
      await onDone(res.already_saved ? "Değişiklik yok; kayıt aynı kaldı." : "Kayıt güncellendi.");
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Kaydı düzenle" onClose={onClose} busy={busy} wide>
      <form onSubmit={submit} className="space-y-4">
        <EntryFields
          refData={refData}
          state={state}
          onChange={setState}
          today={detail.today}
          lockCategory={e.paid_cents > 0 || e.is_entitlement}
          lockCounterparty={e.is_entitlement}
          lockMonth={e.is_entitlement}
          originalCategoryId={e.category_id}
          disabled={busy}
        />
        {e.paid_cents > 0 && (
          <p className="text-xs text-gray-500">
            Gerçekleşen ödemesi olan kaydın kategorisi değiştirilemez; tutar ödenenden düşük olamaz. Ödeme tarih
            ve tutarlarını “Düzelt” ile değiştirin.
          </p>
        )}
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
