"use client";

// Macro yükleme of the Hakediş pages (finance and prep modes, HakedisParts; 0033): the two Macro reports (treatments
// "işlem bazlı" and payments "tedavi ödeme bazlı") are read in the browser (hakedis-macro.ts), the day range is chosen,
// unmapped Macro doctors are mapped and operation names attached to procedure groups, then the server checks the
// import without writing (fin_hk_import_macro p_dry_run) and "Yükle" writes it, replacing the earlier import of the
// same days. 'finance' or 'hakedis_prepare' holders write; the summary carries no ledger data. 0034 (v2.1): outside
// doctors' pieces are stored as "Hakediş yok", every chosen performing doctor is carried to the new rows, and pieces a
// user had voided that come back are listed so that the preparer chooses again. 0035 (v2.3): transfers are sent per
// payment day (paid_on) for the Burgan matching of the hakediş calculation; the page says so and asks for ranges
// imported before it to be imported again.

import Link from "next/link";
import { useMemo, useState } from "react";
import { HK_BASE, HakedisTabs, useHkReference, type HkMode } from "./HakedisParts";
import { ExtDoctorDialog, ProcGroupDialog, extDoctorModeText, moveOperation } from "./HakedisMacroParts";
import { Card, ErrorBox, Field, Loading, Modal, SuccessBox, buttonPrimary, buttonSecondary, inputClass } from "./ui";
import { formatDay, formatTL, formatTimestamp, newId, searchKey, toFinanceError, type FinanceError } from "@/lib/finance";
import {
  EXT_DOCTOR_MODE_LABELS,
  FINANCING_IMPORT_HINT,
  METHOD_LABELS,
  extDoctorOf,
  finHkImportMacro,
  hkCanPrepare,
  importRefusalOf,
  normalizePatientRef,
  procGroupOfOperation,
  type HkExtDoctorJson,
  type HkImportMacroArgs,
  type HkImportSummaryJson,
  type HkProcGroupJson,
  type HkReturnedVoidedJson,
  type HkReferenceJson,
} from "@/lib/hakedis";
import {
  MACRO_LINE_METHODS,
  MACRO_MAX_ROWS,
  MACRO_REPORT_LABELS,
  buildMacroImport,
  macroBasisOf,
  macroDayRange,
  macroDefaultRange,
  macroDoctorsInRange,
  macroExtDoctors,
  macroMethodTotals,
  macroNameKey,
  macroRowOfError,
  monthEndOf,
  readMacroFile,
  validateMacroRange,
  type MacroImport,
  type MacroParseResult,
} from "@/lib/hakedis-macro";
import { formatMoney } from "@/lib/payments";

type TreatmentsFile = Extract<MacroParseResult, { kind: "treatments" }>;
type PaymentsFile = Extract<MacroParseResult, { kind: "payments" }>;

type ImportDialog =
  | { kind: "ext"; record: HkExtDoctorJson | null; extName?: string }
  | { kind: "group"; record: HkProcGroupJson | null; prefillOps?: string[] }
  | { kind: "confirm" };

/** A successful server check of exactly this payload (the reference data it was built against included). */
interface Check {
  built: MacroImport;
  refData: HkReferenceJson;
  batchId: string;
  summary: HkImportSummaryJson;
}

const ISSUES_SHOWN = 20;
const UNMATCHED_SHOWN = 50;
const NEW_GROUP = "__new__";

/** The Macro import page. */
export function HakedisImportView({ mode }: { mode: HkMode }) {
  const ref = useHkReference();
  const [treat, setTreat] = useState<TreatmentsFile | null>(null);
  const [pays, setPays] = useState<PaymentsFile | null>(null);
  const [reading, setReading] = useState(false);
  const [readErrors, setReadErrors] = useState<string[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [batchId, setBatchId] = useState(newId);
  const [check, setCheck] = useState<Check | null>(null);
  const [result, setResult] = useState<HkImportSummaryJson | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  // A failed group attach of the operation table (shown there).
  const [opError, setOpError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState<"check" | "import" | "group" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ImportDialog | null>(null);

  const refData = ref.data;
  const mapping = refData?.ext_doctors ?? [];
  const rangeError = refData && treat ? validateMacroRange(from, to, refData.today, refData.months) : null;
  const rangeOk = !!refData && !!treat && !rangeError;
  const basis = refData && rangeOk ? macroBasisOf({ rules: refData.rules, mapping, from, to }) : null;
  const orthoKey = basis ? Array.from(basis.ortho).sort().join("\n") : "";
  const ignoreKey = mapping
    .filter((m) => m.mode === "ignore")
    .map((m) => macroNameKey(m.ext_name))
    .sort()
    .join("\n");

  const built = useMemo<{ value: MacroImport | null; error: string | null }>(() => {
    if (!treat || !pays || !rangeOk) return { value: null, error: null };
    try {
      const value = buildMacroImport({
        treatments: treat.rows,
        payments: pays.rows,
        from,
        to,
        orthoExtDoctors: new Set(orthoKey ? orthoKey.split("\n") : []),
        ignoreExtDoctors: new Set(ignoreKey ? ignoreKey.split("\n") : []),
      });
      return { value, error: null };
    } catch (err) {
      return { value: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [treat, pays, rangeOk, from, to, orthoKey, ignoreKey]);

  if (!refData) return ref.loading ? <Loading /> : <ErrorBox error={ref.error} onReload={ref.reload} />;

  const canWrite = hkCanPrepare(refData);
  const enabled = refData.proc_groups !== undefined;
  const groups = refData.proc_groups ?? [];
  const base = HK_BASE[mode];

  const fileDoctors = treat ? macroExtDoctors(treat.rows, pays?.rows ?? []) : [];
  const rangeDoctors = treat && rangeOk ? macroDoctorsInRange(treat.rows, pays?.rows ?? [], from, to) : null;
  const unmapped = fileDoctors.filter((d) => rangeDoctors?.has(d.key) && !extDoctorOf(mapping, d.name));
  const imp = built.value;
  const tooMany = !!imp && (imp.lines.length > MACRO_MAX_ROWS || imp.pieces.length > MACRO_MAX_ROWS);
  const emptyRange = !!imp && !!treat && !treat.rows.some((r) => r.day >= from && r.day <= to);
  const issues = (treat?.issues.length ?? 0) + (pays?.issues.length ?? 0);

  const blockers: string[] = [];
  if (!canWrite) blockers.push("Macro yüklemesi için Finans ya da hakediş hazırlama yetkisi gerekir.");
  if (!treat) blockers.push("İşlem raporunu (işlem bazlı) seçin.");
  if (!pays) blockers.push("Ödeme raporunu (tedavi ödeme bazlı) seçin; işlemlerin ödenen kısmı bu rapordan gelir.");
  if (issues > 0) blockers.push("Okunamayan satırlar var; Macro'dan raporu yeniden alın ya da satırları düzeltin.");
  if (rangeError) blockers.push(rangeError);
  if (unmapped.length > 0) blockers.push("Eşleştirilmemiş Macro hekimleri var (aşağıda).");
  if (basis && basis.mixed.length > 0) {
    blockers.push(
      `${basis.mixed.join(", ")}: ortodonti kuralı aralığın yalnız bazı aylarında geçerli; bu aralığı ay ay yükleyin.`
    );
  }
  if (built.error) blockers.push(built.error);
  if (tooMany) blockers.push(`Bir yüklemede en fazla ${MACRO_MAX_ROWS} satır ve ${MACRO_MAX_ROWS} işlem olabilir; aralığı küçültün.`);
  if (emptyRange) blockers.push("Seçilen aralıkta işlem raporunda satır yok.");
  const blocked = blockers.length > 0 || !imp;
  const checked = !!check && !!imp && check.built === imp && check.refData === refData && check.batchId === batchId;

  const resetResult = () => {
    setMessage(null);
    setResult(null);
    setError(null);
  };

  const readFiles = async (files: File[]) => {
    resetResult();
    setReading(true);
    const errors: string[] = [];
    for (const f of files) {
      try {
        const res = await readMacroFile(await f.arrayBuffer(), f.name);
        if (res.kind === "treatments") {
          setTreat(res);
          const range = macroDefaultRange(res.rows, refData.today, refData.months);
          setFrom(range?.from ?? "");
          setTo(range?.to ?? "");
        } else {
          setPays(res);
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    setReadErrors(errors);
    setReading(false);
  };

  const payload = (dry: boolean): HkImportMacroArgs => ({
    p_batch_id: batchId,
    p_from: from,
    p_to: to,
    p_lines: imp!.lines,
    p_pieces: imp!.pieces,
    p_files: [treat!.file, pays!.file].map((f) => f.slice(0, 200)).filter(Boolean),
    p_dry_run: dry,
  });

  const runCheck = async () => {
    if (blocked || !imp) return;
    resetResult();
    setBusy("check");
    try {
      const summary = await finHkImportMacro(payload(true));
      if (summary.already_saved) {
        // This batch id was written by an earlier attempt: show it and start a new one.
        setResult(summary);
        setBatchId(newId());
        setMessage("Bu yükleme daha önce kaydedilmiş; özet aşağıda. Yeniden kontrol edin.");
      } else {
        setCheck({ built: imp, refData, batchId, summary });
      }
    } catch (err) {
      setCheck(null);
      setError(toFinanceError(err));
    } finally {
      setBusy(null);
    }
  };

  const runImport = async () => {
    if (blocked || !checked || !imp) return;
    setError(null);
    setBusy("import");
    try {
      const summary = await finHkImportMacro(payload(false));
      setDialog(null);
      setResult(summary);
      setCheck(null);
      setTreat(null);
      setPays(null);
      setFrom("");
      setTo("");
      setBatchId(newId());
      setMessage(
        summary.already_saved
          ? "Bu yükleme zaten kaydedilmişti; özet aşağıda."
          : `Macro yüklemesi kaydedildi: ${summary.lines} satır, ${summary.pieces} işlem.`
      );
      await ref.reload();
    } catch (err) {
      setDialog(null);
      setError(toFinanceError(err));
    } finally {
      setBusy(null);
    }
  };

  const attach = async (operation: string, target: string) => {
    if (target === NEW_GROUP) {
      setDialog({ kind: "group", record: null, prefillOps: [operation] });
      return;
    }
    resetResult();
    setOpError(null);
    setBusy("group");
    try {
      await moveOperation(groups, operation, target || null);
      await ref.reload();
      setMessage(target ? `“${operation}” işlemi gruba bağlandı.` : `“${operation}” işlemi gruptan çıkarıldı.`);
    } catch (err) {
      setOpError(toFinanceError(err));
      await ref.reload();
    } finally {
      setBusy(null);
    }
  };

  const refusal = importRefusalOf(error);
  // A row error names only the row's position and day; the patient comes from the payload sent.
  const errorRow = macroRowOfError(error?.message, imp);
  const paySpan = pays ? macroDayRange(pays.rows.map((p) => ({ day: p.pay_day }))) : null;
  const payNeededTo = rangeOk ? [monthEndOf(to), refData.today].sort()[0] : null;
  const payShort = !!paySpan && !!payNeededTo && paySpan.to < payNeededTo;

  return (
    <div className="space-y-4">
      <HakedisTabs mode={mode} />
      <SuccessBox text={message} />
      {!enabled && (
        <div className="p-4 rounded bg-amber-50 text-amber-800 text-sm">
          Macro yükleme veritabanında henüz etkin değil (0033 uygulanmalı).
        </div>
      )}

      <div className="p-4 rounded bg-blue-50 text-blue-900 text-sm space-y-1">
        <p>
          Macro&apos;dan iki rapor Excel olarak alınır: <strong>{MACRO_REPORT_LABELS.treatments}</strong> ve{" "}
          <strong>{MACRO_REPORT_LABELS.payments}</strong>. Dosyalar tarayıcıda okunur; yalnızca satırlar kaydedilir.
        </p>
        <p>
          Hekimin ayı, ay içinde yaptığı işlemlerden hesaplanır: işlemin ay sonuna kadar ödenen kısmı ödeme şekliyle,
          ödenmeyen kısmı “{METHOD_LABELS.unpaid}” olarak (kuralın ay sonu kesintisiyle) cirosuna girer. Sonradan gelen
          ödemeler geçmiş ayı değiştirmez. Ortodonti kuralı olan hekimin satırları ödeme raporundan, ödeme gününe göre
          gelir.
        </p>
        <p>
          Ödeme raporunu işlem raporunun ilk gününden önceki avansları ve son ayın sonuna kadarki ödemeleri içerecek
          şekilde alın. Aynı günler yeniden yüklenirse önceki yükleme iptal edilip yenisi yazılır; kapatılmış aylara
          yükleme yapılamaz.
        </p>
        <p>{FINANCING_IMPORT_HINT}</p>
      </div>

      <Card title="1. Raporlar">
        <input
          type="file"
          multiple
          accept=".xls,.xlsx"
          disabled={reading || !canWrite || !!busy}
          className="text-sm"
          aria-label="Macro raporlarını seçin"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length) void readFiles(files);
          }}
        />
        <p className="text-xs text-gray-500 mt-1">İki raporu birlikte ya da ayrı ayrı seçebilirsiniz; türleri başlıklarından tanınır.</p>
        {reading && <p className="text-sm text-gray-500 mt-2">Okunuyor...</p>}
        {readErrors.map((e) => (
          <p key={e} className="text-sm text-red-600 mt-2">
            {e}
          </p>
        ))}
        <div className="grid gap-3 md:grid-cols-2 mt-3">
          <FileSlot
            label={MACRO_REPORT_LABELS.treatments}
            file={treat}
            span={treat ? macroDayRange(treat.rows) : null}
            onRemove={() => {
              resetResult();
              setTreat(null);
            }}
          />
          <FileSlot
            label={MACRO_REPORT_LABELS.payments}
            file={pays}
            span={paySpan}
            spanLabel="Ödeme günleri"
            onRemove={() => {
              resetResult();
              setPays(null);
            }}
          />
        </div>
      </Card>

      {treat && (
        <Card title="2. Tarih aralığı">
          <div className="flex flex-wrap items-end gap-4">
            <Field label="Başlangıç">
              <input type="date" className={inputClass} value={from} max={refData.today} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="Bitiş">
              <input type="date" className={inputClass} value={to} max={refData.today} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Varsayılan: işlem raporunun kapsadığı ayların tamamı (bugüne kadar). Raporları Macro&apos;dan aynı tarih
            aralığıyla alın ve burada da o aralığı seçin. Aralık açık aylarda kalmalı, bugünden sonraya ve 366 günden uzun
            olamaz. Yükleme bu aralıktaki günlerin önceki Macro satırlarının yerine geçer.
          </p>
          {rangeError && <p className="text-sm text-red-600 mt-2">{rangeError}</p>}
          {payShort && (
            <p className="text-sm text-amber-700 mt-2">
              Ödeme raporundaki son ödeme günü {formatDay(paySpan!.to)}; {formatDay(payNeededTo)} tarihine kadar yapılan
              ödemeler eksikse o kısım ödenmemiş sayılır.
            </p>
          )}
        </Card>
      )}

      {treat && rangeOk && (
        <DoctorsCard
          refData={refData}
          imp={imp}
          fileDoctors={fileDoctors}
          rangeDoctors={rangeDoctors}
          mixed={basis?.mixed ?? []}
          canWrite={canWrite && !busy}
          onMap={(name, record) => setDialog({ kind: "ext", record, extName: name })}
        />
      )}

      {imp && (
        <OperationsCard
          imp={imp}
          groups={groups}
          canWrite={canWrite && enabled && !busy}
          busy={busy === "group"}
          error={opError}
          onAttach={attach}
          onNewGroup={() => setDialog({ kind: "group", record: null })}
        />
      )}

      {imp && <ChecksCard imp={imp} />}

      {treat && (
        <Card title="3. Kontrol ve yükleme">
          {blockers.length > 0 && (
            <ul className="list-disc pl-5 text-sm text-red-700 space-y-1 mb-3">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonSecondary} disabled={blocked || !!busy || !enabled} onClick={runCheck}>
              {busy === "check" ? "Kontrol ediliyor..." : "Sunucuda kontrol et"}
            </button>
            <button
              type="button"
              className={buttonPrimary}
              disabled={blocked || !checked || !!busy || !enabled}
              onClick={() => setDialog({ kind: "confirm" })}
            >
              Yükle
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Kontrol hiçbir şey kaydetmez; eşleştirmeleri, kurları ve kapalı ayları sunucuda denetler ve aşağıdaki özeti
            gösterir. “Yükle” yalnızca son kontrolden sonra dosya, aralık ve eşleştirmeler değişmediyse açılır.
          </p>
          <div className="mt-3">
            <ErrorBox error={error} onReload={ref.reload} />
          </div>
          {errorRow && <p className="mt-2 text-sm text-gray-700">Hatalı kayıt: {errorRow}</p>}
          {refusal?.unmapped_ext_doctors && refusal.unmapped_ext_doctors.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {refusal.unmapped_ext_doctors.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={buttonSecondary}
                  disabled={!canWrite}
                  onClick={() => setDialog({ kind: "ext", record: null, extName: name })}
                >
                  {name}: eşleştir
                </button>
              ))}
            </div>
          )}
          {refusal?.missing_fx && refusal.missing_fx.length > 0 && (
            <p className="mt-3 text-sm text-gray-700">
              Kur eksik: {refusal.missing_fx.map((m) => `${m.currency} (${formatDay(m.day)})`).join(", ")}.{" "}
              {mode === "finance" ? (
                <Link href="/finance/settings" className="text-blue-600 hover:underline">
                  Finans ayarları
                </Link>
              ) : (
                "Kuru klinik sahibi veya finans yetkilisi Finans ayarlarından girer."
              )}
            </p>
          )}
          {checked && check && (
            <div className="mt-4">
              <ImportSummary summary={check.summary} title="Kontrol sonucu (kaydedilmedi)" />
            </div>
          )}
        </Card>
      )}

      {result && (
        <Card title={result.dry_run && !result.already_saved ? "Kontrol sonucu" : "Yükleme sonucu"}>
          <ImportSummary summary={result} />
          <div className="flex flex-wrap gap-2 mt-3">
            <Link href={`${base}/lines?month=${result.from.slice(0, 7)}`} className={buttonSecondary}>
              Satırları aç
            </Link>
            {(result.unassigned_pieces > 0 || (result.returned_voided_count ?? 0) > 0) && (
              <Link href={`${base}/lines?month=${result.from.slice(0, 7)}&tab=pieces`} className={buttonSecondary}>
                {result.unassigned_pieces > 0 ? "Atanmamış işlemleri aç" : "İmplant ve işlemleri aç"}
              </Link>
            )}
          </div>
        </Card>
      )}

      <BatchesCard refData={refData} />

      {dialog?.kind === "ext" && (
        <ExtDoctorDialog
          key={dialog.record?.id ?? `new:${dialog.extName ?? ""}`}
          refData={refData}
          record={dialog.record}
          extName={dialog.extName}
          onClose={() => setDialog(null)}
          onReload={async () => {
            setDialog(null);
            await ref.reload();
          }}
          onOpenExisting={(m) => setDialog({ kind: "ext", record: m })}
          onSaved={async (record, already) => {
            setDialog(null);
            setMessage(
              already
                ? "Değişiklik yok; eşleştirme aynı kaldı."
                : `${record.display_name}: ${extDoctorModeText(record)} olarak eşleştirildi.`
            );
            await ref.reload();
          }}
        />
      )}
      {dialog?.kind === "group" && (
        <ProcGroupDialog
          key={dialog.record?.id ?? `new:${(dialog.prefillOps ?? []).join("|")}`}
          refData={refData}
          record={dialog.record}
          prefillOps={dialog.prefillOps}
          onClose={() => setDialog(null)}
          onReload={async () => {
            setDialog(null);
            await ref.reload();
          }}
          onSaved={async (_record, already) => {
            setDialog(null);
            setMessage(already ? "Değişiklik yok; grup aynı kaldı." : "İşlem grubu kaydedildi.");
            await ref.reload();
          }}
        />
      )}
      {dialog?.kind === "confirm" && check && (
        <Modal title="Macro yüklemesini kaydet" onClose={() => setDialog(null)} busy={busy === "import"}>
          <div className="space-y-4 text-sm text-gray-800">
            <p>
              {formatDay(from)} – {formatDay(to)} aralığına {check.summary.lines} satır ve {check.summary.pieces} işlem
              yüklenecek.
              {(check.summary.replaced_lines ?? 0) + (check.summary.replaced_pieces ?? 0) > 0 &&
                ` Bu günlerde daha önce yüklenen ${check.summary.replaced_lines ?? 0} satır ve ${check.summary.replaced_pieces ?? 0} işlem “Yeniden yüklendi” gerekçesiyle iptal edilecek.`}
            </p>
            {check.summary.unassigned_pieces > 0 && (
              <p>
                Klinik adına gelen {check.summary.unassigned_pieces} işlem için işlemi yapan hekimi sonra Satırlar ve
                hastalar → İmplant ve işlemler sekmesinden seçin.
              </p>
            )}
            {(check.summary.returned_voided_count ?? 0) > 0 && (
              <p className="text-amber-800">
                Daha önce elle iptal edilmiş {check.summary.returned_voided_count} işlem yeniden gelecek ve iptal
                edilmeden kaydedilecek; yükledikten sonra hekimini İmplant ve işlemler sekmesinden yeniden seçin.
              </p>
            )}
            <ErrorBox error={error} />
            <div className="flex gap-2">
              <button type="button" className={buttonPrimary} disabled={busy === "import"} onClick={runImport}>
                {busy === "import" ? "Yükleniyor..." : "Yükle"}
              </button>
              <button type="button" className={buttonSecondary} disabled={busy === "import"} onClick={() => setDialog(null)}>
                Vazgeç
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function FileSlot({
  label,
  file,
  span,
  spanLabel = "Günler",
  onRemove,
}: {
  label: string;
  file: MacroParseResult | null;
  span: { from: string; to: string } | null;
  spanLabel?: string;
  onRemove: () => void;
}) {
  return (
    <div className="rounded border p-3 text-sm">
      <div className="font-semibold text-gray-800">{label}</div>
      {!file ? (
        <p className="text-gray-500 mt-1">Seçilmedi.</p>
      ) : (
        <div className="mt-1 space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="break-all">{file.file}</span>
            <button type="button" className="text-red-600 hover:underline text-xs" onClick={onRemove}>
              Kaldır
            </button>
          </div>
          <div className="text-gray-600">
            {file.rows.length} satır
            {span ? ` · ${spanLabel}: ${formatDay(span.from)} – ${formatDay(span.to)}` : ""}
          </div>
          {file.issues.length > 0 && (
            <div className="text-red-700">
              <div>{file.issues.length} satır okunamadı:</div>
              <ul className="list-disc pl-5 text-xs">
                {file.issues.slice(0, ISSUES_SHOWN).map((i) => (
                  <li key={i.row}>
                    {i.row}. satır: {i.reason}
                  </li>
                ))}
              </ul>
              {file.issues.length > ISSUES_SHOWN && <div className="text-xs">… ve {file.issues.length - ISSUES_SHOWN} satır daha.</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const NUM = "py-2 pr-3 text-right tabular-nums whitespace-nowrap";
const dash = (cents: number) => (cents ? formatTL(cents) : "—");

/** The Macro doctors of the reports: mapping, basis and the preview figures of the range (in report currency). */
function DoctorsCard({
  refData,
  imp,
  fileDoctors,
  rangeDoctors,
  mixed,
  canWrite,
  onMap,
}: {
  refData: HkReferenceJson;
  imp: MacroImport | null;
  fileDoctors: { key: string; name: string }[];
  rangeDoctors: Set<string> | null;
  mixed: string[];
  canWrite: boolean;
  onMap: (name: string, record: HkExtDoctorJson | null) => void;
}) {
  const mapping = refData.ext_doctors ?? [];
  const groups = refData.proc_groups ?? [];
  const stats = new Map((imp?.stats.doctors ?? []).map((d) => [d.key, d]));
  // Rows the server keeps as pieces: operations of an active group (doctor / clinic / outside doctors; outside ones as
  // "Hakediş yok"). Only an ignored Macro name stores none.
  const grouped = new Map<string, number>();
  for (const p of imp?.pieces ?? []) {
    if (!procGroupOfOperation(groups, p.procedure)) continue;
    const key = macroNameKey(p.ext_doctor);
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }
  const mixedKeys = new Set(mixed.map(normalizePatientRef));
  return (
    <Card title="Macro hekimleri">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-700 border-b">
              <th className="py-2 pr-3 font-semibold">Macro&apos;daki ad</th>
              <th className="py-2 pr-3 font-semibold">Eşleştirme</th>
              <th className="py-2 pr-3 font-semibold">Hesap</th>
              <th className="py-2 pr-3 font-semibold text-right">İşlem satırı</th>
              <th className="py-2 pr-3 font-semibold text-right">Satır</th>
              <th className="py-2 pr-3 font-semibold text-right">Gruplu işlem</th>
              {MACRO_LINE_METHODS.map((m) => (
                <th key={m} className="py-2 pr-3 font-semibold text-right whitespace-nowrap">
                  {METHOD_LABELS[m]}
                </th>
              ))}
              <th className="py-2 pr-3 font-semibold">Döviz</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {fileDoctors.map((d) => {
              const m = extDoctorOf(mapping, d.name);
              const s = stats.get(d.key);
              const inRange = !!rangeDoctors?.has(d.key);
              const tl = s ? macroMethodTotals(s, "TRY") : null;
              const foreign = (s?.totals ?? []).filter((t) => t.currency !== "TRY");
              return (
                <tr key={d.key} className={`border-b last:border-b-0 align-top ${inRange ? "" : "text-gray-400"}`}>
                  <td className="py-2 pr-3 font-medium">{d.name}</td>
                  <td className="py-2 pr-3">
                    {m ? (
                      <>
                        <div>{extDoctorModeText(m)}</div>
                        {m.mode === "doctor" && <div className="text-xs text-gray-500">{EXT_DOCTOR_MODE_LABELS.doctor}</div>}
                      </>
                    ) : inRange ? (
                      <span className="text-amber-700 font-medium">Eşleştirilmedi</span>
                    ) : (
                      <span>Eşleştirilmedi (aralıkta satırı yok)</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {!m ? (
                      "—"
                    ) : m.mode === "ignore" ? (
                      "Yüklenmez"
                    ) : mixedKeys.has(normalizePatientRef(m.display_name || m.ext_name)) ? (
                      <span className="text-red-600">Ay ay yükleyin</span>
                    ) : s?.basis === "payment" ? (
                      "Ödeme (ortodonti)"
                    ) : (
                      "İşlem (üretim)"
                    )}
                  </td>
                  <td className={NUM}>
                    {s ? s.treatments : "—"}
                    {s && s.zero_price > 0 && <div className="text-xs text-gray-500">{s.zero_price} adet 0 TL</div>}
                  </td>
                  <td className={NUM}>{s ? s.lines : "—"}</td>
                  <td className={NUM}>
                    {m && m.mode !== "ignore" ? grouped.get(d.key) ?? 0 : "—"}
                    {m?.mode === "outside" && (grouped.get(d.key) ?? 0) > 0 && (
                      <div className="text-xs text-gray-500">“Hakediş yok”</div>
                    )}
                  </td>
                  {MACRO_LINE_METHODS.map((method) => (
                    <td key={method} className={NUM}>
                      {tl ? dash(tl[method]) : "—"}
                    </td>
                  ))}
                  <td className="py-2 pr-3 text-xs whitespace-nowrap">
                    {foreign.length ? foreign.map((t) => formatMoney(t.gross_cents, t.currency)).join(" · ") : "—"}
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {canWrite && (
                      <button type="button" className="text-blue-600 hover:underline" onClick={() => onMap(d.name, m ?? null)}>
                        {m ? "Değiştir" : "Eşleştir"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500 mt-3">
        Tutarlar rapordaki para birimindedir (TL sütunları); dövizli satırlar sunucuda kayıtlı kurla TL&apos;ye çevrilir.
        Satır: hakedişe giden tahsilat / üretim satırları (0 TL işlemler satır üretmez). Gruplu işlem: işlem adı aktif bir
        gruba bağlı satırlar; yalnız bunlar işlem (adet) olarak kaydedilir. Dışarıdan hekimin işlemleri “Hakediş yok”
        olarak kaydedilir; işlemi bir DentOS hekimi yaptıysa sonra İmplant ve işlemler sekmesinden seçilir.
      </p>
    </Card>
  );
}

/** Distinct operation names of the range with their group; attaching a name to a group is saved at once. */
function OperationsCard({
  imp,
  groups,
  canWrite,
  busy,
  error,
  onAttach,
  onNewGroup,
}: {
  imp: MacroImport;
  groups: readonly HkProcGroupJson[];
  canWrite: boolean;
  busy: boolean;
  error: FinanceError | null;
  onAttach: (operation: string, target: string) => void;
  onNewGroup: () => void;
}) {
  const [query, setQuery] = useState("");
  const [onlyUngrouped, setOnlyUngrouped] = useState(false);
  const q = searchKey(query);
  const holderOf = (name: string) => {
    const op = normalizePatientRef(name);
    return groups.find((g) => g.op_names.some((x) => normalizePatientRef(x) === op));
  };
  const rows = imp.stats.operations.filter((op) => {
    if (q && !searchKey(op.name).includes(q)) return false;
    if (onlyUngrouped && procGroupOfOperation(groups, op.name)) return false;
    return true;
  });
  const groupedCount = imp.stats.operations.filter((op) => procGroupOfOperation(groups, op.name)).length;
  return (
    <Card
      title={`İşlemler (${imp.stats.operations.length} farklı ad, ${groupedCount} tanesi gruplu)`}
      actions={
        canWrite ? (
          <button type="button" className={buttonSecondary} onClick={onNewGroup}>
            Yeni grup
          </button>
        ) : undefined
      }
    >
      <div className="flex flex-wrap items-end gap-4 mb-3">
        <Field label="Ara" className="min-w-[14rem]">
          <input className={inputClass} placeholder="İşlem adı" maxLength={100} value={query} onChange={(e) => setQuery(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-gray-800 pb-2">
          <input type="checkbox" checked={onlyUngrouped} onChange={(e) => setOnlyUngrouped(e.target.checked)} />
          Yalnız gruba bağlı olmayanlar
        </label>
        {busy && <span className="text-sm text-gray-500 pb-2">Kaydediliyor...</span>}
      </div>
      {error && (
        <div className="mb-3">
          <ErrorBox error={error} />
        </div>
      )}
      <div className="overflow-x-auto max-h-[32rem] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white">
            <tr className="text-left text-gray-700 border-b">
              <th className="py-2 pr-3 font-semibold">Macro işlem adı</th>
              <th className="py-2 pr-3 font-semibold text-right">Satır</th>
              <th className="py-2 pr-3 font-semibold">Hekimler</th>
              <th className="py-2 pr-3 font-semibold">Grup</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-6 text-center text-gray-500">
                  İşlem yok.
                </td>
              </tr>
            ) : (
              rows.map((op) => {
                const holder = holderOf(op.name);
                const active = groups.filter((g) => g.is_active || g.id === holder?.id);
                return (
                  <tr key={op.key} className="border-b last:border-b-0 align-top">
                    <td className="py-2 pr-3">{op.name}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{op.rows}</td>
                    <td className="py-2 pr-3 text-xs text-gray-600">{op.ext_doctors.join(", ")}</td>
                    <td className="py-2 pr-3 min-w-[12rem]">
                      {canWrite ? (
                        <select
                          className={inputClass}
                          value={holder?.id ?? ""}
                          aria-label={`${op.name} grubu`}
                          onChange={(e) => onAttach(op.name, e.target.value)}
                        >
                          <option value="">Grup yok (normal tedavi)</option>
                          {active.map((g) => (
                            <option key={g.id} value={g.id}>
                              {g.name}
                              {g.is_implant ? " (implant)" : ""}
                              {g.is_active ? "" : " (pasif)"}
                            </option>
                          ))}
                          {/* A grouped name leaves its group first ("Grup yok"): a name is in one group only. */}
                          {!holder && <option value={NEW_GROUP}>+ Yeni grup…</option>}
                        </select>
                      ) : holder ? (
                        `${holder.name}${holder.is_active ? "" : " (pasif)"}`
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500 mt-3">
        Gruba bağlanan işlem adı hemen kaydedilir ve sonraki yüklemelerde de kullanılır. İmplant grubundaki işlemlerin
        tutarı hekimin cirosuna girmez. Bir işlem adı tek bir grupta olabilir: gruplu bir adı yeni bir gruba almak için
        önce “Grup yok” seçin.
      </p>
    </Card>
  );
}

/** What the reports say beyond the lines: payments without their treatment, overpayments, corrections, currencies. */
function ChecksCard({ imp }: { imp: MacroImport }) {
  const s = imp.stats;
  const notes = s.unmatched_payments.length > 0 || s.overpaid.length > 0 || s.negative_rows > 0 || s.currencies.length > 0;
  if (!notes) return null;
  return (
    <Card title="Raporların kontrolü">
      <ul className="list-disc pl-5 text-sm text-gray-800 space-y-1">
        {s.currencies.length > 0 && (
          <li>Dövizli satırlar: {s.currencies.join(", ")}. Sunucuda satırın günündeki (veya önceki) kayıtlı kurla TL&apos;ye çevrilir.</li>
        )}
        {s.negative_rows > 0 && <li>{s.negative_rows} işlem satırı eksi tutarlı; düzeltme satırı olarak yüklenir.</li>}
        {s.overpaid.length > 0 && (
          <li className="text-amber-700">
            İşlem tutarını aşan ödemeler hesaba katılmadı: {s.overpaid.map((o) => formatMoney(o.cents, o.currency)).join(", ")}.
          </li>
        )}
        {s.unmatched_payments.length > 0 && (
          <li className="text-amber-700">
            {s.unmatched_payments.length} ödeme satırı işlem raporunda karşılığını bulamadı (aynı işlem günü, hasta, işlem,
            diş ve para birimi); hesaba katılmadı. İki raporun aynı hekimleri ve günleri kapsadığını kontrol edin.
          </li>
        )}
      </ul>
      {s.unmatched_payments.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-blue-600">Karşılığı bulunamayan ödemeler</summary>
          <div className="overflow-x-auto mt-2">
            <table className="w-full text-xs md:text-sm">
              <thead>
                <tr className="text-left text-gray-700 border-b">
                  <th className="py-1 pr-3 font-medium">Ödeme</th>
                  <th className="py-1 pr-3 font-medium">İşlem günü</th>
                  <th className="py-1 pr-3 font-medium">Hekim</th>
                  <th className="py-1 pr-3 font-medium">Hasta</th>
                  <th className="py-1 pr-3 font-medium">İşlem</th>
                  <th className="py-1 pr-3 font-medium">Diş</th>
                  <th className="py-1 font-medium text-right">Tutar</th>
                </tr>
              </thead>
              <tbody>
                {s.unmatched_payments.slice(0, UNMATCHED_SHOWN).map((p) => (
                  <tr key={p.row} className="border-b last:border-b-0">
                    <td className="py-1 pr-3 whitespace-nowrap">{formatDay(p.pay_day)}</td>
                    <td className="py-1 pr-3 whitespace-nowrap">{formatDay(p.treatment_day)}</td>
                    <td className="py-1 pr-3">{p.ext_doctor}</td>
                    <td className="py-1 pr-3">{p.patient_name}</td>
                    <td className="py-1 pr-3">{p.procedure}</td>
                    <td className="py-1 pr-3">{p.tooth ?? "—"}</td>
                    <td className="py-1 text-right tabular-nums whitespace-nowrap">{formatMoney(p.amount_cents, p.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {s.unmatched_payments.length > UNMATCHED_SHOWN && (
              <p className="text-xs text-gray-500 mt-1">… ve {s.unmatched_payments.length - UNMATCHED_SHOWN} satır daha.</p>
            )}
          </div>
        </details>
      )}
    </Card>
  );
}

/** The server's import summary (dry run or written): totals, per Macro doctor in TL, rates used. */
function ImportSummary({ summary, title }: { summary: HkImportSummaryJson; title?: string }) {
  // An already saved batch found by a check describes a write that happened (past tense).
  const dry = !!summary.dry_run && !summary.already_saved;
  const tiles: [string, string][] = [
    ["Aralık", `${formatDay(summary.from)} – ${formatDay(summary.to)}`],
    ["Satır", String(summary.lines)],
    ["İşlem (kaydedilen)", String(summary.pieces)],
    ["Toplam (TL)", formatTL(summary.try_total_cents)],
    ["İmplant payı", formatTL(summary.implant_total_cents)],
    ["Atanmamış işlem", String(summary.unassigned_pieces)],
  ];
  if (summary.replaced_lines !== undefined) {
    tiles.push([dry ? "İptal edilecek" : "İptal edilen", `${summary.replaced_lines} satır · ${summary.replaced_pieces ?? 0} işlem`]);
  }
  return (
    <div className="space-y-3">
      {title && <h3 className="font-semibold text-gray-900">{title}</h3>}
      {summary.already_saved && (
        <p className="text-sm text-amber-700">Bu yükleme daha önce kaydedilmişti; yeni bir şey yazılmadı.</p>
      )}
      <div className="grid gap-2 grid-cols-2 md:grid-cols-4 text-sm">
        {tiles.map(([label, value]) => (
          <div key={label} className="rounded border px-3 py-2">
            <div className="text-xs text-gray-500">{label}</div>
            <div className="font-semibold tabular-nums">{value}</div>
          </div>
        ))}
      </div>
      <ul className="text-xs text-gray-600 space-y-0.5">
        {summary.carried_assignments > 0 && (
          <li>
            Önceki yüklemede elle seçilen {summary.carried_assignments} işlem hekimi / “Hakediş yok” seçimi yeni
            satırlara {dry ? "taşınacak" : "taşındı"}.
          </li>
        )}
        {(summary.outside_pieces ?? 0) > 0 && (
          <li>
            Dışarıdan hekimlerin {summary.outside_pieces} işlemi “Hakediş yok” olarak {dry ? "kaydedilecek" : "kaydedildi"};
            gerekirse “İmplant ve işlemler” sekmesinden değiştirilebilir.
          </li>
        )}
        {summary.skipped_lines > 0 && <li>Yok sayılan hekimlerin {summary.skipped_lines} satırı yüklenmez.</li>}
        {summary.skipped_pieces > 0 && (
          <li>
            {summary.outside_pieces === undefined ? "Dışarıdan / yok sayılan" : "Yok sayılan"} hekimlerin{" "}
            {summary.skipped_pieces} işlemi sayılmaz.
          </li>
        )}
        {summary.ungrouped_pieces > 0 && (
          <li>Gruba bağlı olmayan {summary.ungrouped_pieces} işlem satırı normal tedavidir (işlem adedi olarak kaydedilmez).</li>
        )}
        {(summary.replaced_batches ?? 0) > 0 && (
          <li>
            Bu aralıktaki {summary.replaced_batches} eski yüklemenin yerine {dry ? "geçilecek" : "geçildi"}.
          </li>
        )}
      </ul>
      <ReturnedVoided rows={summary.returned_voided ?? []} count={summary.returned_voided_count} dry={dry} />
      {summary.doctors.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs md:text-sm">
            <thead>
              <tr className="text-left text-gray-700 border-b">
                <th className="py-2 pr-3 font-semibold">Macro hekimi</th>
                <th className="py-2 pr-3 font-semibold">Eşleştirme</th>
                <th className="py-2 pr-3 font-semibold text-right">Satır</th>
                {MACRO_LINE_METHODS.map((m) => (
                  <th key={m} className="py-2 pr-3 font-semibold text-right whitespace-nowrap">
                    {METHOD_LABELS[m]}
                  </th>
                ))}
                <th className="py-2 pr-3 font-semibold text-right">Toplam</th>
                <th className="py-2 pr-3 font-semibold text-right whitespace-nowrap">İmplant payı</th>
                <th className="py-2 pr-3 font-semibold">İşlemler</th>
              </tr>
            </thead>
            <tbody>
              {summary.doctors.map((d) => (
                <tr key={d.ext_name} className="border-b last:border-b-0 align-top">
                  <td className="py-2 pr-3 font-medium">{d.ext_doctor}</td>
                  <td className="py-2 pr-3">{d.mode === "doctor" ? d.doctor_name ?? "—" : EXT_DOCTOR_MODE_LABELS[d.mode]}</td>
                  <td className={NUM}>
                    {d.lines}
                    {d.payment_lines > 0 && <div className="text-xs text-gray-500">{d.payment_lines} ödeme</div>}
                    {d.skipped_lines > 0 && <div className="text-xs text-gray-500">{d.skipped_lines} yok sayıldı</div>}
                  </td>
                  {MACRO_LINE_METHODS.map((m) => (
                    <td key={m} className={NUM}>
                      {dash(d.gross_by_method?.[m] ?? 0)}
                    </td>
                  ))}
                  <td className={`${NUM} font-medium`}>{formatTL(d.gross_cents)}</td>
                  <td className={NUM}>{dash(d.implant_cents)}</td>
                  <td className="py-2 pr-3 text-xs">
                    {d.pieces_by_group.length > 0
                      ? d.pieces_by_group.map((g) => `${g.name} ${g.count}`).join(", ")
                      : d.pieces_qty
                        ? String(d.pieces_qty)
                        : "—"}
                    {d.unassigned_pieces > 0 && <div className="text-amber-700">{d.unassigned_pieces} atanmamış</div>}
                    {(d.outside_pieces ?? 0) > 0 && (
                      <div className="text-gray-500">{d.outside_pieces} “Hakediş yok” (dışarıdan hekim)</div>
                    )}
                    {(d.carried_assignments ?? 0) > 0 && (
                      <div className="text-gray-500">{d.carried_assignments} elle seçim taşındı</div>
                    )}
                    {(d.returned_voided ?? 0) > 0 && (
                      <div className="text-amber-700">{d.returned_voided} iptal edilmiş işlem geri geldi</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {summary.fx.length > 0 && (
        <div className="text-xs text-gray-700">
          Kullanılan kurlar:{" "}
          {summary.fx
            .map(
              (f) =>
                `${f.currency} ${String(f.rate).replace(".", ",")} (${formatDay(f.rate_day)}, ${f.lines} satır)`
            )
            .join(" · ")}
        </div>
      )}
      {summary.fx_warnings.length > 0 && (
        <div className="p-3 rounded bg-amber-50 text-amber-800 text-xs">
          7 günden eski kur kullanılan günler:{" "}
          {summary.fx_warnings
            .map((w) => `${w.currency} ${formatDay(w.day)} (kur ${formatDay(w.rate_day)}, ${w.age_days} gün önce)`)
            .join(" · ")}
          . Gerekirse kuru girip yeniden yükleyin.
        </div>
      )}
    </div>
  );
}

/**
 * Pieces a user had voided that the import brings back live (0034, v2.1 decision 5): no automatic void; the preparer
 * chooses the doctor again (or "Hakediş yok") in the pieces tab.
 */
function ReturnedVoided({ rows, count, dry }: { rows: HkReturnedVoidedJson[]; count?: number; dry: boolean }) {
  const n = count ?? rows.length;
  if (n === 0) return null;
  const shown = rows.slice(0, 50);
  return (
    <div className="p-3 rounded bg-amber-50 text-amber-900 text-sm space-y-2">
      <p className="font-semibold">Daha önce elle iptal edilmiş {n} işlem yeniden geldi</p>
      <p className="text-xs">
        Bu işlemler iptal edilmeden {dry ? "kaydedilecek" : "kaydedildi"}. İşlemi başka bir hekim yaptıysa ya da hakediş
        verilmeyecekse “İmplant ve işlemler” sekmesinden “Hekimi değiştir” ile hekimi ya da “Hakediş yok”u seçin;
        gerekiyorsa işlemi yeniden iptal edin.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left border-b border-amber-200">
              <th className="py-1 pr-3 font-semibold">Tarih</th>
              <th className="py-1 pr-3 font-semibold">Hasta</th>
              <th className="py-1 pr-3 font-semibold">İşlem</th>
              <th className="py-1 pr-3 font-semibold">Diş</th>
              <th className="py-1 pr-3 font-semibold">Macro hekimi</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.n} className="border-b border-amber-100 last:border-b-0 align-top">
                <td className="py-1 pr-3 whitespace-nowrap">{formatDay(r.day)}</td>
                <td className="py-1 pr-3">
                  {r.patient_name}
                  {r.patient_no ? <span className="text-amber-700"> · dosya no {r.patient_no}</span> : null}
                </td>
                <td className="py-1 pr-3">
                  {r.procedure}
                  {r.proc_group_name ? <span className="text-amber-700"> ({r.proc_group_name})</span> : null}
                  {r.qty !== 1 ? ` × ${r.qty}` : ""}
                </td>
                <td className="py-1 pr-3">{r.tooth || "—"}</td>
                <td className="py-1 pr-3">{r.ext_doctor}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown.length && <p className="text-xs">İlk {shown.length} işlem gösteriliyor.</p>}
    </div>
  );
}

/** The last Macro imports of the clinic (fin_hk_reference().import_batches). */
function BatchesCard({ refData }: { refData: HkReferenceJson }) {
  const batches = refData.import_batches ?? [];
  if (batches.length === 0) return null;
  return (
    <Card title="Son yüklemeler">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-700 border-b">
              <th className="py-2 pr-3 font-semibold">Aralık</th>
              <th className="py-2 pr-3 font-semibold">Dosyalar</th>
              <th className="py-2 pr-3 font-semibold text-right">Satır</th>
              <th className="py-2 pr-3 font-semibold text-right">İşlem</th>
              <th className="py-2 pr-3 font-semibold">Yükleyen</th>
              <th className="py-2 font-semibold">Durum</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id} className={`border-b last:border-b-0 align-top ${b.replaced_by_batch ? "text-gray-400" : ""}`}>
                <td className="py-2 pr-3 whitespace-nowrap">
                  {formatDay(b.from_day)} – {formatDay(b.to_day)}
                </td>
                <td className="py-2 pr-3 text-xs break-all">{b.file_names.join(", ") || "—"}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{b.lines ?? "—"}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{b.pieces ?? "—"}</td>
                <td className="py-2 pr-3 text-xs whitespace-nowrap">
                  {b.created_by_name ?? "—"} · {formatTimestamp(b.created_at)}
                </td>
                <td className="py-2 whitespace-nowrap">{b.replaced_by_batch ? "Yerine yenisi yüklendi" : "Geçerli"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500 mt-3">
        Bir aralık yeniden yüklenince o günlerin önceki Macro satırları iptal edilir; kapsadığı eski yüklemeler “yerine
        yenisi yüklendi” olarak görünür.
      </p>
    </Card>
  );
}

