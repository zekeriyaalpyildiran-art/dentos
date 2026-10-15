"use client";

// "İptal et" (spec p9_clinical §7.2): soft delete with a required reason; a stock implant also opens a stock
// correction request for the stock manager (clin_implant_void).

import { useRef, useState } from "react";
import {
  ClinicalError,
  clinImplantVoid,
  toClinicalError,
  type ImplantJson,
  type ImplantVoidResult,
} from "@/lib/clinical/rpc";
import { LIMITS } from "@/lib/clinical/codes";
import { ErrorBox, Field, NoPatientTextHint, SAVING_LABEL, Sheet, clinInput, clinSecondary } from "./ui";

export function voidResultMessage(r: ImplantVoidResult): string {
  if (r.stock_correction) {
    const ref = r.stock_correction.ref_no ? ` (#${r.stock_correction.ref_no})` : "";
    return `İmplant kaydı iptal edildi. Stok düzeltme talebi açıldı${ref}. Stok sorumlusu onaylayınca implant stoğa geri döner.`;
  }
  return "İmplant kaydı iptal edildi.";
}

export function ImplantVoidDialog({
  implant,
  onClose,
  onDone,
}: {
  implant: ImplantJson;
  onClose: () => void;
  onDone: (r: ImplantVoidResult) => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<ClinicalError | null>(null);

  const label = `Diş ${implant.tooth_fdi} · ${[implant.brand_name, implant.model].filter(Boolean).join(" ")}`;

  const submit = async () => {
    if (busyRef.current) return;
    const text = reason.trim();
    if (text.length < LIMITS.reasonMin || text.length > LIMITS.reasonMax) {
      setError(new ClinicalError("İptal nedenini yazın (3–500 karakter).", null, null, null));
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await clinImplantVoid(implant.id, implant.version, text);
      onDone(r);
    } catch (err) {
      setError(toClinicalError(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Sheet
      title="İmplant kaydı iptal edilsin mi?"
      onClose={onClose}
      busy={busy}
      footer={
        <div className="space-y-2">
          <ErrorBox error={error} />
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button type="button" className={clinSecondary} onClick={onClose} disabled={busy}>
              Vazgeç
            </button>
            <button
              type="button"
              className="px-4 py-2 min-h-[44px] bg-red-600 text-white rounded hover:bg-red-700 disabled:bg-gray-400"
              onClick={() => void submit()}
              disabled={busy}
            >
              {busy ? SAVING_LABEL : "İptal et"}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <p>
          {label} kaydı listeden kaldırılacak. Klinik sahibi ve yönetici iptal edilen kaydı görebilir; klinik sahibi geri
          alabilir.
        </p>
        {implant.stock_source === "stock" && (
          <p className="p-3 rounded bg-amber-50 border border-amber-200 text-amber-900">
            Stoktan düşülen implant için stok sorumlusuna düzeltme talebi açılır: implant kullanılmadıysa onaylar ve
            implant stoğa döner; kullanıldıysa reddeder.
          </p>
        )}
        <Field label="İptal nedeni" required hint={<NoPatientTextHint />}>
          <textarea
            className={clinInput}
            rows={3}
            maxLength={LIMITS.reasonMax}
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      </div>
    </Sheet>
  );
}
