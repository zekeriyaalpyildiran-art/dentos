"use client";

import { useState } from "react";
import { Card, SuccessBox, buttonPrimary, buttonSecondary, inputClass } from "@/components/finance/ui";
import { useAuthStore } from "@/lib/store";
import {
  finFinancingImport,
  finFinancingList,
  formatDay,
  formatTL,
  importErrorMessage,
  newId,
  toFinanceError,
  type FinanceError,
  type FinancingJson,
  type ImportSetupJson,
} from "@/lib/finance";
import {
  FINANCING_CONFIRM_TEXT,
  FINANCING_MAX_ITEMS,
  FINANCING_TOO_MANY,
  financingFee,
  financingNet,
  loanKey,
  parseFinancing,
  proposedRelease,
  toFinancingPayload,
  validateFinancingItem,
  type FinancingItem,
} from "@/lib/finance-import/financing";
import { maskFileName } from "@/lib/finance-import/primitives";
import { FINANCING_ACCEPT, MAX_FILE_BYTES, readSpreadsheetFile } from "@/lib/finance-import/read-file";
import { CorrectDialog, type CorrectionPreset } from "./FinancingDialogs";

type Mode = "" | "available" | "blocked";
type Item = FinancingItem & { expectedRelease: string };

const UUID_IN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Patient-financing statement upload (legacy BG): one file at a time, ≤ 40 loans, a block mode per file, the
 * explicit confirmation that the gross amounts are already in the clinic workbook. Only the fees are booked.
 */
export function FinancingUpload({ setup, onSaved }: { setup: ImportSetupJson; onSaved: (text: string) => void }) {
  const clinicId = useAuthStore((s) => s.user?.clinic_id ?? null);
  const blockDays = setup.settings.default_block_days;
  const [file, setFile] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [mode, setMode] = useState<Mode>("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [correction, setCorrection] = useState<{ row: FinancingJson; preset: CorrectionPreset } | null>(null);

  const reset = () => {
    setItems([]);
    setWarnings([]);
    setMode("");
    setConfirmed(false);
    setBatchId(null);
    setError(null);
    setFile(null);
  };

  const read = async (f: File) => {
    reset();
    setReadError(null);
    setMessage(null);
    setBusy(true);
    try {
      if (f.size > MAX_FILE_BYTES) throw new Error("En fazla 15 MB dosya yükleyin.");
      // The masked name is what the financing rows and history carry (account numbers in file names).
      const fileName = maskFileName(f.name);
      const book = await readSpreadsheetFile(await f.arrayBuffer(), f.name, "financing");
      const parsed = parseFinancing(book, fileName);
      setItems(parsed.items.map((i) => ({ ...i, expectedRelease: "" })));
      setWarnings(parsed.warnings);
      setFile(fileName);
    } catch (err) {
      setReadError(err instanceof Error && err.message ? err.message : "Dosya okunamadı.");
    } finally {
      setBusy(false);
    }
  };

  const selectMode = (m: Mode) => {
    setMode(m);
    setConfirmed(false);
    setBatchId(null);
    setItems((old) => old.map((i) => ({ ...i, expectedRelease: m === "blocked" ? proposedRelease(i.date, blockDays) : "" })));
  };

  const blocked = mode === "blocked";
  const problems = items
    .map((i) => validateFinancingItem({ ...i, blocked, expectedRelease: blocked ? i.expectedRelease || null : null }))
    .filter((p): p is string => !!p);
  const tooMany = items.length > FINANCING_MAX_ITEMS;
  const future = items.some((i) => i.date > setup.today);
  const totals = items.reduce(
    (t, i) => ({ gross: t.gross + i.gross, fee: t.fee + financingFee(i), net: t.net + financingNet(i) }),
    { gross: 0, fee: 0, net: 0 }
  );

  const save = async () => {
    if (!clinicId) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    const id = batchId ?? newId();
    setBatchId(id);
    try {
      const payload = await Promise.all(
        items.map((i) => toFinancingPayload(i, { clinicId, blocked, expectedRelease: blocked ? i.expectedRelease : null }))
      );
      const res = await finFinancingImport(id, payload, true);
      const text = `${res.added} finansman kaydedildi; ${res.skipped} tekrar atlandı. Brüt tahsilata yeni giriş eklenmedi.${
        res.already_saved ? " (Bu aktarım daha önce kaydedilmişti.)" : ""
      }`;
      reset();
      setMessage(text);
      onSaved(text);
    } catch (err) {
      setError(toFinanceError(err));
    } finally {
      setBusy(false);
    }
  };

  // E_FIN_CHANGED: DETAIL is the stored financing id. Offer the correction path with the statement's amounts (C7).
  const changedId = error?.isConflict && error.details ? error.details.match(UUID_IN)?.[0] ?? null : null;
  const openCorrection = async () => {
    if (!changedId) return;
    setBusy(true);
    try {
      for (const item of items) {
        const list = await finFinancingList({ query: loanKey(item.reference), status: "all" }, { offset: 0, limit: 50 });
        const row = list.rows.find((r) => r.id === changedId);
        if (row) {
          setCorrection({
            row,
            preset: {
              gross_cents: item.gross,
              commission_cents: item.commission,
              kkdf_cents: item.kkdf,
              bsmv_cents: item.bsmv,
              blocked,
              expected_release: blocked ? item.expectedRelease : null,
            },
          });
          return;
        }
      }
      setError(toFinanceError({ message: "Düzeltilecek finansman bulunamadı. Listeden düzeltin." }));
    } catch (err) {
      setError(toFinanceError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Finansman dökümü yükle">
      <p className="text-sm text-gray-600 mb-3">
        Brüt tahsilatın kaynağı klinik Excel’idir. Burada yalnızca banka kesintileri (komisyon, KKDF, BSMV) ve bloke takibi
        kaydedilir. Hasta kredisi kliniğin kredi borcu değildir. Dosya tarayıcıda okunur, sunucuya yüklenmez.
      </p>
      {!setup.financing_ready && (
        <p className="text-sm text-amber-700 mb-3">Kaydetmeden önce aşağıdaki hasta finansmanı ayarlarını tamamlayın.</p>
      )}
      <input
        type="file"
        accept={FINANCING_ACCEPT}
        disabled={busy}
        className="text-sm"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void read(f);
        }}
      />
      {busy && <p className="text-sm text-gray-500 mt-2">İşlem sürüyor…</p>}
      {readError && <p className="text-sm text-red-600 mt-2">{readError}</p>}
      <div className="mt-3">
        <SuccessBox text={message} />
      </div>

      {items.length > 0 && (
        <div className="space-y-4 mt-4">
          <p className="text-sm">
            <b>{file}</b>: {items.length} finansman · Brüt {formatTL(totals.gross)} · Kesinti {formatTL(totals.fee)} · Net{" "}
            {formatTL(totals.net)}
          </p>
          {tooMany && <p className="text-sm text-red-600">{FINANCING_TOO_MANY}</p>}
          {future && <p className="text-sm text-red-600">İşlem tarihi gelecekte olamaz.</p>}
          <label className="block max-w-sm">
            <span className="block text-sm font-semibold mb-1 text-gray-800">Bu dökümün hesabı</span>
            <select className={inputClass} value={mode} disabled={busy} onChange={(e) => selectMode(e.target.value as Mode)}>
              <option value="">Seçiniz</option>
              <option value="available">Blokesiz / doğrudan kullanılabilir</option>
              <option value="blocked">{blockDays} gün blokeli</option>
            </select>
          </label>
          <p className="text-xs text-gray-500">
            Aynı dökümde farklı bloke türleri varsa ayrı dosyalar yükleyin. Tarihler {blockDays} takvim günü üzerinden
            tahmindir; tarih dolunca bloke otomatik çözülmüş sayılmaz.
          </p>
          <div className="overflow-x-auto border rounded">
            <table className="w-full text-sm">
              <thead className="bg-gray-100">
                <tr className="text-left">
                  {["Hasta / tarih", "Brüt", "Komisyon", "KKDF", "BSMV", "Net", "Tahmini çözülme"].map((h) => (
                    <th key={h} className="px-3 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((i, idx) => (
                  <tr key={i.reference + ":" + i.date} className="border-t align-top">
                    <td className="px-3 py-2">
                      {i.name}
                      <div className="text-xs text-gray-500">
                        {formatDay(i.date)} · {i.reference}
                      </div>
                    </td>
                    <td className="px-3 py-2 tabular-nums">{formatTL(i.gross)}</td>
                    <td className="px-3 py-2 tabular-nums">{formatTL(i.commission)}</td>
                    <td className="px-3 py-2 tabular-nums">{formatTL(i.kkdf)}</td>
                    <td className="px-3 py-2 tabular-nums">{formatTL(i.bsmv)}</td>
                    <td className="px-3 py-2 tabular-nums">{formatTL(financingNet(i))}</td>
                    <td className="px-3 py-2">
                      {blocked ? (
                        <input
                          type="date"
                          aria-label="Tahmini bloke çözülme tarihi"
                          className="px-2 py-1 border rounded text-sm"
                          min={i.date}
                          value={i.expectedRelease}
                          disabled={busy}
                          onChange={(e) => {
                            setConfirmed(false);
                            setBatchId(null);
                            const v = e.target.value;
                            setItems((old) => old.map((x, j) => (j === idx ? { ...x, expectedRelease: v } : x)));
                          }}
                        />
                      ) : mode ? (
                        "Blokesiz"
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {warnings.map((w, i) => (
            <p key={i} className="text-xs text-gray-600">
              {w}
            </p>
          ))}
          {mode && problems.length > 0 && <p className="text-sm text-red-600">{Array.from(new Set(problems)).join(" ")}</p>}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={confirmed} disabled={busy} onChange={(e) => setConfirmed(e.target.checked)} />
            {FINANCING_CONFIRM_TEXT}
          </label>
          {error && (
            <div className="p-3 rounded bg-red-50 text-red-700 text-sm space-y-2">
              <div>{importErrorMessage(error)}</div>
              {changedId && (
                <button type="button" className={buttonSecondary} disabled={busy} onClick={openCorrection}>
                  Mevcut finansmanı düzelt
                </button>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonPrimary}
              disabled={busy || !mode || !confirmed || problems.length > 0 || tooMany || future || !setup.financing_ready}
              onClick={save}
            >
              Kesintileri ve bloke takibini kaydet
            </button>
            <button type="button" className={buttonSecondary} disabled={busy} onClick={reset}>
              Vazgeç
            </button>
          </div>
        </div>
      )}
      {correction && (
        <CorrectDialog
          row={correction.row}
          preset={correction.preset}
          today={setup.today}
          onClose={() => setCorrection(null)}
          onReload={() => setCorrection(null)}
          onDone={(text) => {
            setCorrection(null);
            setError(null);
            setMessage(text + " Dosyayı yeniden kaydederek kalan satırları aktarabilirsiniz.");
            onSaved(text);
          }}
        />
      )}
    </Card>
  );
}
