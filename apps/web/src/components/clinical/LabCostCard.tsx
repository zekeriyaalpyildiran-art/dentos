"use client";

// Lab cost (spec p9_clinical §7.8, D2, D3): only rendered when the server sent the `cost` key (cost / finance
// viewers). The payable is created only by a `finance` holder and only when the clinic setting is on.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ClinicalError,
  clinLabCostPost,
  clinLabOrderSetCost,
  toClinicalError,
  type ClinicalFlags,
  type LabOrderJson,
} from "@/lib/clinical/rpc";
import { LIMITS } from "@/lib/clinical/codes";
import { centsToTlInput, formatTl, parseTlToCents } from "@/lib/clinical/numbers";
import { formatDay, istanbulDayOf } from "@/lib/clinical/dates";
import { ErrorBox, Field, NoPatientTextHint, SAVING_LABEL, clinDanger, clinInput, clinPrimary, clinSecondary } from "./ui";

const POSTED_TEXT = "Bu maliyet finansa borç olarak işlendi; değişikliği finans yetkilisi yapabilir.";

export function LabCostCard({
  order,
  flags,
  onChanged,
}: {
  order: LabOrderJson;
  flags: ClinicalFlags;
  onChanged: () => void;
}) {
  const cost = order.cost ?? null;
  const [amount, setAmount] = useState(centsToTlInput(cost?.amount_cents));
  const [note, setNote] = useState(cost?.note ?? "");
  const [busy, setBusy] = useState<"save" | "remove" | "post" | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState<ClinicalError | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    setAmount(centsToTlInput(cost?.amount_cents));
    setNote(cost?.note ?? "");
  }, [cost?.amount_cents, cost?.note, cost?.version]);

  if (!("cost" in order)) return null;

  const posted = cost?.payable_state === "posted";
  const canEdit = flags.can_edit_lab_costs && (!posted || flags.can_finance);

  const run = async (kind: "save" | "remove" | "post", fn: () => Promise<unknown>, okText: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(kind);
    setError(null);
    setSaved(null);
    try {
      await fn();
      setSaved(okText);
      onChanged();
    } catch (err) {
      setError(toClinicalError(err));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const save = () => {
    const cents = parseTlToCents(amount);
    if (cents === null || cents > LIMITS.costMaxCents) {
      setError(new ClinicalError("Geçerli bir tutar girin (0,01 – 10.000.000 TL).", null, null, null));
      return;
    }
    if (note.trim().length > LIMITS.costNote) {
      setError(new ClinicalError("Açıklama en fazla 500 karakter olabilir; iptal için 3–500 karakter yazın.", null, null, null));
      return;
    }
    void run(
      "save",
      () =>
        clinLabOrderSetCost({
          p_lab_order_id: order.id,
          p_cost_version: cost ? cost.version : null,
          p_amount_cents: cents,
          p_note: note.trim(),
        }),
      "Maliyet kaydedildi."
    );
  };

  const remove = () => {
    if (!cost) return;
    if (!confirm("Lab maliyeti kaldırılsın mı?")) return;
    void run(
      "remove",
      () =>
        clinLabOrderSetCost({
          p_lab_order_id: order.id,
          p_cost_version: cost.version,
          p_amount_cents: null,
          p_note: "",
        }),
      "Maliyet kaldırıldı."
    );
  };

  const post = () => {
    if (!cost) return;
    void run("post", () => clinLabCostPost(order.id, cost.version), "Maliyet finansa borç olarak işlendi.");
  };

  return (
    <section className="bg-white rounded-lg shadow p-4 md:p-6 space-y-4 text-gray-900">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Maliyet</h2>
        {cost && <span className="text-lg font-semibold tabular-nums">{formatTl(cost.amount_cents)}</span>}
      </div>

      {flags.can_edit_lab_costs ? (
        <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
          <Field label="Tutar (TL)" hint={posted && !flags.can_finance ? POSTED_TEXT : undefined}>
            <input
              className={clinInput}
              inputMode="decimal"
              placeholder="1.500,00"
              value={amount}
              disabled={!canEdit || !!busy}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field label="Açıklama (örn. fatura no.)" hint={<NoPatientTextHint />}>
            <input
              className={clinInput}
              maxLength={LIMITS.costNote}
              value={note}
              disabled={!canEdit || !!busy}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        </div>
      ) : (
        <div className="text-sm text-gray-700">
          {cost ? (
            <>
              Tutar: <span className="font-semibold">{formatTl(cost.amount_cents)}</span>
              {cost.note && <span> · {cost.note}</span>}
            </>
          ) : (
            "Maliyet girilmemiş."
          )}
        </div>
      )}

      <div className="text-sm">
        {!cost || cost.payable_state === "off" ? (
          <p className="text-gray-600">Finans borcu oluşturulmaz (ayar kapalı).</p>
        ) : cost.payable_state === "awaiting_finance" && order.status === "draft" ? (
          <p className="text-gray-600">Taslak iş: laboratuvara gönderildikten sonra finansa borç olarak işlenebilir.</p>
        ) : cost.payable_state === "awaiting_finance" ? (
          <p className="text-amber-800">Finans yetkilisinin onayı bekleniyor.</p>
        ) : (
          <p className="text-green-800">
            Finansa borç olarak işlendi · {formatDay(istanbulDayOf(cost.posted_at))}
            {flags.can_finance && (
              <>
                {" "}
                ·{" "}
                <Link href="/finance" className="text-blue-700 hover:underline">
                  Finansa git
                </Link>
              </>
            )}
          </p>
        )}
      </div>

      <ErrorBox error={error} onReload={onChanged} />
      {saved && !error && <p className="text-sm text-green-800">{saved}</p>}

      <div className="flex flex-wrap gap-2">
        {canEdit && (
          <button type="button" className={clinPrimary} onClick={save} disabled={!!busy}>
            {busy === "save" ? SAVING_LABEL : "Kaydet"}
          </button>
        )}
        {canEdit && cost && (
          <button type="button" className={clinDanger} onClick={remove} disabled={!!busy}>
            {busy === "remove" ? SAVING_LABEL : "Maliyeti kaldır"}
          </button>
        )}
        {cost?.payable_state === "awaiting_finance" && flags.can_finance && order.status !== "draft" && (
          <button type="button" className={clinSecondary} onClick={post} disabled={!!busy}>
            {busy === "post" ? SAVING_LABEL : "Finansa borç olarak işle"}
          </button>
        )}
      </div>
    </section>
  );
}
