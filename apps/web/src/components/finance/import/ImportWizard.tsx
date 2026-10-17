"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReferenceData } from "@/components/finance/useReferenceData";
import { Card, ErrorBox, Loading, SuccessBox, buttonPrimary, buttonSecondary } from "@/components/finance/ui";
import { useAuthStore } from "@/lib/store";
import {
  finImportCheck,
  finImportRows,
  formatDay,
  formatMonth,
  formatTL,
  importErrorMessage,
  importErrorRow,
  isMonth,
  newId,
  toFinanceError,
  type FinanceError,
  type ImportCheckJson,
  type ImportCheckRowJson,
  type ImportLayoutJson,
  type ImportRowPayload,
  type ImportSetupJson,
  type ImportWarningCode,
  type ReferenceData,
} from "@/lib/finance";
import { mergeSessionBalances, type TableBalanceResult } from "@/lib/finance-import/balances";
import { intakePdf, intakeSpreadsheet, type SavedWorkbookLayout, type SpreadsheetOutcome } from "@/lib/finance-import/detect";
import { validateWorkbookLayout } from "@/lib/finance-import/layout";
import { matchTargetsError } from "@/lib/finance-import/matching";
import {
  FileReadError,
  GENERAL_ACCEPT,
  MAX_FILE_BYTES,
  fileTooLarge,
  isPdfName,
  readPdfFile,
  readSpreadsheetFile,
} from "@/lib/finance-import/read-file";
import { maskFileName } from "@/lib/finance-import/primitives";
import {
  FINAL_CONFIRM_TEXT,
  OVERRIDE_TEXT,
  appendToReview,
  checkableRow,
  flagsFromCheck,
  saveProblems,
  selectedReceiptsCents,
  sortReview,
  toCheckPayload,
  toImportRowPayload,
  type RowCheck,
} from "@/lib/finance-import/review";
import type { BalanceSource, ParsedRow } from "@/lib/finance-import/types";
import type { WorkbookFxRates } from "@/lib/finance-import/workbook";
import { BalancePreviewCard } from "./BalancePreviewCard";
import { BankMapperCard, type AcceptedBankRows, type CardState } from "./BankMapperCard";
import { FxRatesCard, mergeFxRates, saveWorkbookFxRates, type PendingFxRate } from "./FxRatesCard";
import { ReviewTable, type ReviewItem, type RowPatch } from "./ReviewTable";
import { compileSetupRules } from "./rules";
import { resolveAccount, rowCategory, rowWarnings, toRowCategory, wizardBlockers, type WizardRow } from "./review";
import { useImportSetup } from "./useImportSetup";

const MAX_LIST = 2000;
/** Legacy receipts counterparty (IP:54) when no workbook layout gives one. */
const LEGACY_RECEIPTS_TEXT = "Günlük toplam";

type Extra = Pick<WizardRow, "accountId" | "layoutId" | "match">;

/** /finance/import: month, files, cards, balances, review list and the atomic save (fin_import_rows). */
export function ImportWizard() {
  const setup = useImportSetup();
  const ref = useReferenceData();
  const clinicId = useAuthStore((s) => s.user?.clinic_id ?? null);

  const reloadAll = useCallback(async () => {
    await Promise.all([setup.reload(), ref.reload()]);
  }, [setup, ref]);

  if (!setup.data || !ref.data || !clinicId) {
    if (setup.loading || ref.loading) return <Loading />;
    return <ErrorBox error={setup.error ?? ref.error} />;
  }
  return <Wizard setup={setup.data} refData={ref.data} clinicId={clinicId} reloadAll={reloadAll} />;
}

function Wizard({
  setup,
  refData,
  clinicId,
  reloadAll,
}: {
  setup: ImportSetupJson;
  refData: ReferenceData;
  clinicId: string;
  reloadAll: () => Promise<void>;
}) {
  const today = setup.today;
  const [month, setMonth] = useState(setup.current_month);
  const [rows, setRows] = useState<WizardRow[]>([]);
  const [cards, setCards] = useState<CardState[]>([]);
  const [balances, setBalances] = useState<BalanceSource[]>([]);
  // Closing balances of column-mapped bank cards, by card id: sent once the card's mapping is confirmed (its two
  // boxes), kept after the card is closed like a ready reader's balance (cleared with the list). Adding a sheet's rows
  // moves its balance to `balances`, so the next sheet of the same file can be mapped.
  const [tableBalances, setTableBalances] = useState<Record<string, TableBalanceResult & { file: string }>>({});
  const [notes, setNotes] = useState<string[]>([]);
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [check, setCheck] = useState<ImportCheckJson | null>(null);
  const [checkError, setCheckError] = useState<FinanceError | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [override, setOverride] = useState<string[] | null>(null);
  const [preFlags, setPreFlags] = useState<Record<string, ImportWarningCode[]>>({});
  const [batchId, setBatchId] = useState<{ id: string; signature: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<FinanceError | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  // Workbook 'GÜNCEL DÖVİZ' rates, saved as clinic fx_rates with the import (spec p5 §7); never part of the rows.
  const [fxRates, setFxRates] = useState<PendingFxRate[]>([]);
  const [fxSaving, setFxSaving] = useState(false);
  const [fxStatus, setFxStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const busy = progress !== null || saving || fxSaving;
  // Latest list for async readers (several files are appended inside one handler).
  const rowsRef = useRef<WizardRow[]>(rows);
  rowsRef.current = rows;

  const rules = useMemo(() => compileSetupRules(setup.rules), [setup.rules]);
  const layoutsById = useMemo(() => new Map(setup.layouts.map((l) => [l.id, l])), [setup.layouts]);
  const { workbookLayouts, invalidLayouts } = useMemo(() => {
    const out: (SavedWorkbookLayout & { row: ImportLayoutJson })[] = [];
    const invalid: { name: string; error: string }[] = [];
    for (const l of setup.layouts) {
      if (l.kind !== "clinic_workbook" || !l.is_active) continue;
      const v = validateWorkbookLayout(l.config);
      if (v.ok) out.push({ id: l.id, layout: v.layout, row: l });
      else invalid.push({ name: l.name, error: v.errors[0] ?? "geçersiz" });
    }
    out.sort((a, b) => Number(b.row.is_default) - Number(a.row.is_default) || a.row.sort_order - b.row.sort_order);
    return { workbookLayouts: out, invalidLayouts: invalid };
  }, [setup.layouts]);

  const receiptsTextFor = useCallback(
    (row: Pick<WizardRow, "layoutId">): string => {
      const l = (row.layoutId && workbookLayouts.find((w) => w.id === row.layoutId)) || workbookLayouts[0];
      return l?.layout.receipt_text.counterparty ?? LEGACY_RECEIPTS_TEXT;
    },
    [workbookLayouts]
  );

  const counterpartyOf = useCallback(
    (id: string | null) => {
      const c = id ? refData.counterparties.find((x) => x.id === id) : undefined;
      return c ? { id: c.id, name: c.name } : null;
    },
    [refData.counterparties]
  );

  // --- server check (§4.5) -------------------------------------------------------------------------

  /**
   * Preflight of the given rows. Only rows inside the chosen month are ever sent; the narration goes only with rows
   * the user has selected (toCheckPayload). Row numbers follow the given order, so the pre-save check over the
   * chosen rows reports exactly the warnings fin_import_rows will enforce.
   */
  const runCheck = useCallback(
    async (list: Pick<WizardRow, keyof ParsedRow | "layoutId">[]): Promise<ImportCheckJson | null> => {
      const sendable = list.filter((row) => checkableRow(row, month)).slice(0, MAX_LIST);
      if (!sendable.length) return null;
      const payload = await Promise.all(
        sendable.map((row, i) =>
          toCheckPayload(row, {
            rowNo: i + 1,
            clinicId,
            category: toRowCategory(rowCategory(refData, row)),
            counterparty: counterpartyOf(row.counterpartyId),
            receiptsCounterpartyText: receiptsTextFor(row),
            withDescription: row.selected,
          })
        )
      );
      return finImportCheck(month, payload);
    },
    [clinicId, refData, counterpartyOf, receiptsTextFor, month]
  );

  /** Keeps month-level answers from the latest check and per-row answers for every key checked so far. */
  const mergeCheck = useCallback((res: ImportCheckJson) => {
    setCheck((old) => {
      if (!old) return res;
      const fresh = new Set(res.rows.map((r) => r.key));
      return { ...res, rows: [...old.rows.filter((r) => !fresh.has(r.key)), ...res.rows] };
    });
  }, []);

  const checkByKey = useMemo(() => {
    const m = new Map<string, ImportCheckRowJson>();
    for (const r of check?.rows ?? []) m.set(r.key, r);
    return m;
  }, [check]);

  // Re-check after edits (debounced), only the rows that changed (or every row after a save / on "Yenile"); the
  // answer refreshes saved / duplicate flags but never the selection.
  const editTick = useRef(0);
  const dirty = useRef<Set<string> | "all">(new Set());
  const [editVersion, setEditVersion] = useState(0);
  const recheck = useCallback((keys: string[] | "all") => {
    if (keys === "all") dirty.current = "all";
    else if (dirty.current !== "all") for (const k of keys) dirty.current.add(k);
    setEditVersion((v) => v + 1);
  }, []);
  useEffect(() => {
    if (!editVersion || !rows.length) return;
    const tick = ++editTick.current;
    const t = setTimeout(async () => {
      const keys = dirty.current;
      dirty.current = new Set();
      try {
        const list = keys === "all" ? rows : rows.filter((r) => keys.has(r.key));
        const res = await runCheck(list);
        if (tick !== editTick.current || !res) return;
        const map = new Map(res.rows.map((r) => [r.key, r as RowCheck]));
        setRows((old) => withChecks(old, map));
        mergeCheck(res);
        setCheckError(null);
      } catch (err) {
        if (tick === editTick.current) setCheckError(toFinanceError(err));
      }
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editVersion]);

  // --- appending rows ------------------------------------------------------------------------------

  const appendRows = useCallback(
    async (incoming: ParsedRow[], source: "workbook" | "bank", extraOf: (r: ParsedRow) => Extra) => {
      const current = rowsRef.current;
      const known = new Set(current.map((r) => r.key));
      const fresh: ParsedRow[] = [];
      for (const r of incoming) {
        if (known.has(r.key)) continue;
        known.add(r.key);
        fresh.push(r);
      }
      if (current.length + fresh.length > MAX_LIST) {
        throw new Error(`Kontrol listesinde en fazla ${MAX_LIST} satır olabilir. Önce mevcut listeyi kaydedin veya temizleyin.`);
      }
      const extras = new Map(fresh.map((r) => [r.key, extraOf(r)]));
      // Only the new rows are checked; rows already in the list keep their answers.
      const res = await runCheck(fresh.map((r) => ({ ...r, ...(extras.get(r.key) as Extra) })));
      const map = new Map((res?.rows ?? []).map((r) => [r.key, r as RowCheck]));
      setRows((old) => {
        const appended = appendToReview(old, fresh, source, (k) => map.get(k));
        const byKey = new Map(old.map((r) => [r.key, r]));
        const merged: WizardRow[] = appended.map((r) => {
          const prev = byKey.get(r.key);
          if (prev) {
            const c = map.get(r.key);
            return c ? { ...prev, flags: { ...flagsFromCheck(c), listDuplicate: prev.flags.listDuplicate } } : prev;
          }
          const extra = extras.get(r.key) ?? { accountId: null, layoutId: null, match: null };
          return { ...r, ...extra };
        });
        const next = sortReview(merged) as WizardRow[];
        rowsRef.current = next;
        return next;
      });
      if (res) mergeCheck(res);
      setCheckError(null);
      setConfirmed(false);
      return fresh.length;
    },
    [runCheck, mergeCheck]
  );

  // --- reading files (§3) --------------------------------------------------------------------------

  const readFiles = async (files: File[]) => {
    if (!files.length) return;
    if (!isMonth(month)) return setLocalError("Aktarım ayını seçin.");
    setLocalError(null);
    setMessage(null);
    setSaveError(null);
    setFileErrors([]);
    const failures: string[] = [];
    const newNotes: string[] = [];
    let newBalances: BalanceSource[] = [];
    const newFx: WorkbookFxRates[] = [];
    let added = 0;
    try {
      for (const [index, file] of files.entries()) {
        // The masked name is what the rows, balances and history carry (account numbers in file names).
        const fileName = maskFileName(file.name);
        setProgress(`${index + 1}/${files.length} · ${fileName} okunuyor…`);
        await new Promise((r) => setTimeout(r, 20));
        if (file.size > MAX_FILE_BYTES) {
          failures.push(fileTooLarge(fileName));
          continue;
        }
        try {
          const data = await file.arrayBuffer();
          if (isPdfName(file.name)) {
            const pdf = await readPdfFile(data, {
              onPage: (p, total) => setProgress(`${fileName} · ${p}/${total} sayfa okunuyor…`),
            });
            const out = intakePdf(pdf.pages, { file: fileName, rules });
            setCards((old) => [...old, { ...out.card, id: newId() }]);
            if (out.balance) newBalances = mergeSessionBalances(newBalances, [out.balance]);
            newNotes.push(...out.notes);
          } else {
            const book = await readSpreadsheetFile(data, file.name, "general");
            const out: SpreadsheetOutcome = intakeSpreadsheet(book, {
              file: fileName,
              month,
              layouts: workbookLayouts,
              rules,
            });
            if (out.kind === "financing_refused") {
              failures.push(`${fileName}: ${out.message}`);
              continue;
            }
            if (out.kind === "workbook") {
              const layout = layoutsById.get(out.layoutId) ?? null;
              const n = await appendRows(out.result.rows, "workbook", (r) => ({
                accountId: resolveAccount(r, setup, layout, null),
                layoutId: out.layoutId,
                match: null,
              }));
              added += n;
              if (out.cash.source) newBalances = mergeSessionBalances(newBalances, [out.cash.source]);
              if (out.rates) newFx.push(out.rates);
              newNotes.push(...out.notes, ...out.result.notes);
              for (const issue of out.result.issues) newNotes.push(`${fileName}${issue.sheet ? ` · ${issue.sheet}` : ""}: ${issue.reason}`);
            } else {
              setCards((old) => [...old, { ...out.card, id: newId() }]);
              if (out.balance) newBalances = mergeSessionBalances(newBalances, [out.balance]);
              newNotes.push(...out.notes);
            }
          }
        } catch (err) {
          const text =
            err instanceof Error && (err.name === "ImportParseError" || err instanceof FileReadError || /[ğüşıöçİĞÜŞÖÇ]/.test(err.message))
              ? err.message
              : "Dosya okunamadı. Dosyanın bozuk veya parolalı olmadığını kontrol edin.";
          failures.push(`${fileName}: ${text}`);
        }
      }
    } finally {
      setBalances((old) => mergeSessionBalances(old, newBalances));
      if (newFx.length) {
        setFxRates((old) => newFx.reduce(mergeFxRates, old));
        setFxStatus(null);
      }
      setNotes((old) => [...old, ...newNotes]);
      setFileErrors(failures);
      setProgress(null);
    }
    setMessage(
      added
        ? `${added} işlem satırı okundu. Henüz kaydedilmedi; aşağıdaki listeyi kontrol edin.`
        : "Dosya okundu. Banka dosyaları için aşağıdaki kartı tamamlayın; okunamayan dosyalar varsa uyarılarını kontrol edin."
    );
  };

  const acceptBank = async (accepted: AcceptedBankRows) => {
    setProgress("Satırlar kontrol ediliyor…");
    // The confirmed mapping's balance moves from the card's live entry (cleared as the card resets its boxes) to the
    // session list in the same render, so the balances card keeps its state.
    const balance = accepted.balance;
    if (balance) setBalances((old) => mergeSessionBalances(old, [balance]));
    try {
      const n = await appendRows(accepted.rows, "bank", () => ({
        accountId: accepted.accountId,
        layoutId: accepted.layoutId,
        match: null,
      }));
      setNotes((old) => [...old, ...accepted.notes]);
      setMessage(
        `${n} banka satırı kontrol listesine eklendi. Henüz kaydedilmedi. Başka sayfa varsa onu da seçip ekleyebilirsiniz.`
      );
    } catch (err) {
      setSaveError(toFinanceError(err));
    } finally {
      setProgress(null);
    }
  };

  // --- edits -----------------------------------------------------------------------------------------

  const change = useCallback(
    (key: string, patch: RowPatch) => {
      setRows((old) => old.map((r) => (r.key === key ? { ...r, ...patch } : r)));
      setConfirmed(false);
      // Ticking a row sends its narration for the first time (financing-line check); deselecting needs no check.
      if (patch.selected !== false || Object.keys(patch).length > 1) recheck([key]);
    },
    [recheck]
  );

  const clearAll = () => {
    setRows([]);
    setCards([]);
    setBalances([]);
    setTableBalances({});
    setNotes([]);
    setFileErrors([]);
    setCheck(null);
    setConfirmed(false);
    setOverride(null);
    setPreFlags({});
    setBatchId(null);
    setMessage(null);
    setSaveError(null);
    setHighlight(null);
    setFxRates([]);
    setFxStatus(null);
    dirty.current = new Set();
  };

  /** Saves the file's rates as clinic fx_rates. Independent of the ledger rows: a failure is only reported. */
  const saveFxRates = async (): Promise<{ ok: boolean; text: string } | null> => {
    if (!fxRates.length) return null;
    setFxSaving(true);
    try {
      const res = await saveWorkbookFxRates(fxRates);
      setFxStatus(res);
      return res;
    } finally {
      setFxSaving(false);
    }
  };

  // --- derived ---------------------------------------------------------------------------------------

  const ctx = { month, today, ref: refData };
  const tableBalanceList = Object.values(tableBalances);
  const balanceCandidates = mergeSessionBalances(
    balances,
    tableBalanceList.flatMap((b) => (b.source ? [b.source] : []))
  );
  const balanceNotes = tableBalanceList.flatMap((b) => (b.note ? [`${b.file}: ${b.note}`] : []));
  const reportTableBalance = (cardId: string, file: string, b: TableBalanceResult) =>
    setTableBalances((old) => {
      if (!b.source && !b.note) {
        if (!(cardId in old)) return old;
        const rest = { ...old };
        delete rest[cardId];
        return rest;
      }
      const next = { ...b, file };
      return JSON.stringify(old[cardId]) === JSON.stringify(next) ? old : { ...old, [cardId]: next };
    });
  const items: ReviewItem[] = rows.map((row) => {
    const blockers = wizardBlockers(row, ctx);
    const warnings = Array.from(new Set([...rowWarnings(row), ...(preFlags[row.key] ?? [])]));
    return { row, blockers, warnings, check: checkByKey.get(row.key) };
  });
  const chosenItems = items.filter((i) => i.row.selected && i.blockers.length === 0);
  const chosen = chosenItems.map((i) => i.row);
  const flaggedKeys = chosenItems.filter((i) => i.warnings.length > 0).map((i) => i.row.key);
  const overrideOk = flaggedKeys.length === 0 || (!!override && flaggedKeys.every((k) => override.includes(k)));
  const problems = [...saveProblems(chosen)];
  const matchError = matchTargetsError(chosen.map((r) => r.match?.entry_id));
  if (matchError) problems.push(matchError);
  const changedSaved = rows.filter((r) => r.flags.saved && r.key.startsWith("clinic:") && r.flags.savedAmount !== null && r.flags.savedAmount !== r.amount);
  const receiptsCents = selectedReceiptsCents(chosen);
  const feeNote = setup.settings.physician_fee_note;
  const feePct = feeNote ? Number(feeNote.match(/%\s*(\d+(?:[.,]\d+)?)/)?.[1]?.replace(",", ".")) : NaN;
  const hasWorkbookReceipts = rows.some((r) => r.kind === "workbook_receipts" && !r.flags.saved);

  // --- save (§4.7) -----------------------------------------------------------------------------------

  const save = async () => {
    setSaveError(null);
    setLocalError(null);
    setMessage(null);
    setHighlight(null);
    if (problems.length) return setLocalError(problems.join(" "));
    setSaving(true);
    try {
      // Pre-save check over exactly the rows that will be sent, in the same order: the warnings it reports are the
      // ones the database will enforce (C9).
      const pre = await runCheck(chosen);
      const preMap = new Map((pre?.rows ?? []).map((r) => [r.key, r]));
      const nowBlocked = chosen.filter((r) => {
        const c = preMap.get(r.key);
        return !c || c.errors.length > 0 || ["saved_same", "saved_changed", "matched_same", "matched_changed", "id_taken"].includes(c.status);
      });
      if (nowBlocked.length) {
        recheck(nowBlocked.map((r) => r.key));
        setSaving(false);
        return setLocalError(`${nowBlocked.length} satır artık aktarılamaz (kaydedilmiş veya geçersiz). Liste yenileniyor; kontrol edip tekrar deneyin.`);
      }
      const codes: Record<string, ImportWarningCode[]> = {};
      for (const r of chosen) {
        const w = (preMap.get(r.key)?.warnings ?? []).map((x) => x.code);
        if (w.length) codes[r.key] = w;
      }
      const flaggedNow = Object.keys(codes);
      if (flaggedNow.length && !(override && flaggedNow.every((k) => override.includes(k)))) {
        setPreFlags(codes);
        setOverride(null);
        setSaving(false);
        return setLocalError(`${flaggedNow.length} seçili satırda tekrar uyarısı var. Uyarıları kontrol edip bilerek aktarmayı onaylayın.`);
      }
      // A batch id is reused only to retry exactly the same selection (a lost response); any change starts a new batch.
      const signature = chosen.map((r) => `${r.key}|${r.match?.entry_id ?? ""}`).join("\n");
      const id = batchId && batchId.signature === signature ? batchId.id : newId();
      setBatchId({ id, signature });
      const payload: ImportRowPayload[] = await Promise.all(
        chosen.map(async (row, i) => {
          const category = toRowCategory(rowCategory(refData, row));
          if (!row.accountId || (!category && !row.match)) throw new Error("Satır bilgisi eksik.");
          return (await toImportRowPayload(row, {
            rowNo: i + 1,
            clinicId,
            accountId: row.accountId,
            category: category ?? { id: "", bucket: "other_expense", name: "", is_system: true },
            counterparty: counterpartyOf(row.counterpartyId),
            receiptsCounterpartyText: receiptsTextFor(row),
            match: row.match ? { entry_id: row.match.entry_id, version: row.match.version, payment_id: row.match.payment_id } : null,
            acknowledged: codes[row.key] ?? [],
          })) as ImportRowPayload;
        })
      );
      const fileNames = Array.from(new Set(chosen.map((r) => r.file.slice(0, 200) || "Dosya"))).slice(0, 50);
      const layoutIds = Array.from(new Set(chosen.map((r) => r.layoutId).filter((x): x is string => !!x))).slice(0, 50);
      const res = await finImportRows(payload, { id, month, file_names: fileNames, layout_ids: layoutIds });
      setBatchId(null);
      setConfirmed(false);
      setOverride(null);
      setPreFlags({});
      const parts = [
        `${res.inserted} kayıt eklendi; ${res.matched} banka ödemesi mevcut borca işlendi; ${res.skipped} tekrar atlandı.`,
      ];
      if (res.already_saved) parts.unshift("Bu aktarım daha önce kaydedilmişti.");
      // Deselect exactly the rows the server reports for this batch (a replayed batch may differ from the screen).
      const savedKeys = new Set(res.rows.map((r) => r.key));
      if (res.acknowledged) parts.push(`${res.acknowledged} satır uyarı onaylanarak kaydedildi.`);
      if (res.reconciliation?.equivalent) {
        parts.push(
          `Elle girilen ${res.reconciliation.excluded_count} tahsilat Excel günlük toplamlarıyla eşleşti (${formatDay(res.reconciliation.through)} tarihine kadar) ve toplam dışına alındı.`
        );
      }
      parts.push("Hareket aktarımı bakiyeyi değiştirmez; dosyalardan okunan bakiyeleri ayrıca onaylayıp güncelleyin.");
      // After the rows are saved: the rates go to fx_rates (suggestions for patient payments); a failure only adds a note.
      const fx = await saveFxRates();
      if (fx?.text) parts.push(fx.text);
      setMessage(parts.join(" "));
      setRows((old) => old.map((r) => (savedKeys.has(r.key) ? { ...r, selected: false, match: null } : r)));
      recheck(Array.from(savedKeys));
    } catch (err) {
      const fe = toFinanceError(err);
      setSaveError(fe);
      const at = importErrorRow(fe);
      const target = at.key ?? (at.row_no ? chosen[at.row_no - 1]?.key : null);
      if (target) {
        setHighlight(target);
        const row = rows.find((r) => r.key === target);
        if (row) document.getElementById(`import-row-${row.seq}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    } finally {
      setSaving(false);
    }
  };

  // --- render ----------------------------------------------------------------------------------------

  const noWorkbookLayout = workbookLayouts.length === 0;

  return (
    <div className="space-y-6">
      <Card title="Dosyadan finans aktarımı">
        <p className="text-sm text-gray-600 mb-4">
          Dosyalar tarayıcıda okunur ve sunucuya yüklenmez; yalnızca seçip onayladığınız işlem satırları kaydedilir. Klinik
          Excel’i ile banka Excel, CSV ve PDF dökümlerini yükleyin. Ay dışındaki satırlar kaydedilmez; kayıt öncesi tekrar
          kontrolü yapılır. Hasta finansmanı dökümleri{" "}
          <Link href="/finance/financing" className="text-blue-600 hover:underline">
            Hasta finansmanı
          </Link>{" "}
          bölümünden yüklenir.
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <label className="block">
            <span className="block text-sm font-semibold mb-1 text-gray-800">Aktarım ayı</span>
            <input
              type="month"
              className="px-3 py-2 border rounded bg-white text-gray-900 disabled:bg-gray-100"
              value={month}
              max={setup.current_month}
              disabled={busy || rows.length > 0 || cards.length > 0}
              onChange={(e) => isMonth(e.target.value) && setMonth(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="block text-sm font-semibold mb-1 text-gray-800">Klinik Excel’i / banka dökümleri</span>
            <input
              type="file"
              multiple
              accept={GENERAL_ACCEPT}
              disabled={busy || !isMonth(month)}
              onChange={(e) => {
                const files = Array.from(e.currentTarget.files ?? []);
                e.currentTarget.value = "";
                void readFiles(files);
              }}
              className="text-sm"
            />
          </label>
          <button type="button" className={buttonSecondary} disabled={busy} onClick={clearAll}>
            Listeyi temizle
          </button>
        </div>
        {invalidLayouts.length > 0 && (
          <p role="alert" className="text-sm text-red-700 mt-3">
            Kayıtlı klinik Excel düzeni bu ekranda kullanılamıyor:{" "}
            {invalidLayouts.map((l) => `${l.name} (${l.error})`).join("; ")}.{" "}
            <Link href="/finance/import/layouts" className="text-blue-600 hover:underline">
              Düzeni düzeltin
            </Link>
            .
          </p>
        )}
        {noWorkbookLayout && (
          <p className="text-sm text-amber-700 mt-3">
            Klinik Excel düzeni tanımlı değil; klinik Excel’i banka dosyası gibi açılır.{" "}
            <Link href="/finance/import/layouts" className="text-blue-600 hover:underline">
              Düzen oluşturun
            </Link>
            .
          </p>
        )}
        {progress && (
          <div role="status" aria-live="polite" className="mt-4 p-3 rounded bg-blue-50 text-blue-900 text-sm">
            <b>{progress}</b>
            <p>Dosya okunuyor. Bittiğinde işlem listesi aşağıda açılacak; henüz finans kaydı yapılmıyor.</p>
          </div>
        )}
        {fileErrors.length > 0 && (
          <div role="alert" className="mt-4 p-3 rounded bg-red-50 text-red-700 text-sm">
            <b>Okunamayan dosyalar</b>
            <ul className="list-disc pl-5">
              {fileErrors.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <SuccessBox text={message} />
      {localError && <div className="p-4 rounded bg-red-50 text-red-700 text-sm">{localError}</div>}
      {saveError && (
        <div className="p-4 rounded bg-red-50 text-red-700 text-sm">{importErrorMessage(saveError)}</div>
      )}

      {cards.map((c) => (
        <BankMapperCard
          key={c.id}
          card={c}
          setup={setup}
          refData={refData}
          rules={rules}
          disabled={busy}
          onAdd={(accepted) => void acceptBank(accepted)}
          onBalance={(b) => reportTableBalance(c.id, c.file, b)}
          onClose={() => setCards((old) => old.filter((x) => x.id !== c.id))}
          onSetupChanged={reloadAll}
        />
      ))}

      <BalancePreviewCard
        key={JSON.stringify(balanceCandidates.map((b) => [b.importKey, b.day, b.amountCents]))}
        candidates={balanceCandidates}
        notes={balanceNotes}
        setup={setup}
        refData={refData}
        today={today}
        disabled={busy}
        onSetupChanged={reloadAll}
      />

      <FxRatesCard rates={fxRates} disabled={busy} saving={fxSaving} status={fxStatus} onSaveOnly={() => void saveFxRates()} />

      {notes.length > 0 && (
        <details open={!rows.length} className="text-sm text-gray-700">
          <summary className="cursor-pointer">Dosya okuma notları ({notes.length})</summary>
          <ul className="list-disc pl-5 mt-2 space-y-1">
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </details>
      )}

      {rows.length > 0 && (
        <Card title={`Kontrol listesi · ${formatMonth(month)}`}>
          {checkError && <ErrorBox error={checkError} onReload={() => recheck("all")} />}
          {changedSaved.length > 0 && (
            <p role="alert" className="p-3 mb-3 rounded bg-red-50 text-red-700 text-sm">
              <b>Dikkat: Önceden aktarılan günlük toplamlar değişmiş.</b> Aşağıda eski ve yeni tutarları gösteriyoruz. Bu
              satırlar otomatik olarak güncellenmez; mevcut kayıtları finans listesinden düzeltin.
            </p>
          )}
          {hasWorkbookReceipts && check && check.manual_receipts.count > 0 && (
            <div className="p-3 mb-3 rounded bg-amber-50 text-amber-900 text-sm">
              Bu ay elle girilmiş {check.manual_receipts.count} hasta tahsilatı var (toplam{" "}
              {formatTL(check.manual_receipts.total_cents)}). Excel aynı tahsilatları içeriyorsa birlikte sayılmamalı. Tam
              dönem toplamları eşleşirse (fark ≤ 1 TL) elle girilenler kayıttan sonra otomatik olarak toplam dışına alınır;
              kısmi aktarımla devam etmeyin.
              {check.reconciliation.equivalent && check.reconciliation.through && (
                <> Şu an {formatDay(check.reconciliation.through)} tarihine kadar eşleşme var.</>
              )}
            </div>
          )}
          <p className="text-sm mb-3">
            <b>{chosen.length} kayıt seçili</b> · Seçili tahsilat: {formatTL(receiptsCents)}
            {feeNote && Number.isFinite(feePct) && (
              <>
                {" "}
                · Bu tahsilatın %{String(feePct).replace(".", ",")}’ü: {formatTL(Math.round((receiptsCents * feePct) / 100))} (bilgi amaçlı;
                hakedişe ayrıca eklenmez)
              </>
            )}
            {feeNote && !Number.isFinite(feePct) && <> · Hekim hakedişi notu: {feeNote}</>}
          </p>
          <ReviewTable items={items} refData={refData} disabled={busy} highlightKey={highlight} onChange={change} />
          <p className="text-xs text-gray-600 mt-3">
            Banka girişleri ve belirsiz işlemler başlangıçta seçili değildir. Bankadaki POS yatışını Excel tahsilatına
            tekrar eklemeyin. Hareket aktarımı bakiyeyi değiştirmez; yukarıdaki bakiye önizlemesini ayrıca onaylayıp
            güncelleyin.
          </p>
          {flaggedKeys.length > 0 && (
            <label className="flex items-start gap-2 text-sm mt-3 text-amber-900">
              <input
                type="checkbox"
                className="mt-1"
                checked={overrideOk}
                disabled={busy}
                onChange={(e) => setOverride(e.target.checked ? flaggedKeys : null)}
              />
              {OVERRIDE_TEXT(flaggedKeys.length)}
            </label>
          )}
          <label className="flex items-start gap-2 text-sm mt-3">
            <input type="checkbox" className="mt-1" checked={confirmed} disabled={busy} onChange={(e) => setConfirmed(e.target.checked)} />
            {FINAL_CONFIRM_TEXT}
          </label>
          {problems.length > 0 && chosen.length > 0 && <p className="text-sm text-amber-700 mt-2">{problems.join(" ")}</p>}
          <div className="mt-3">
            <button
              type="button"
              className={buttonPrimary}
              disabled={busy || !confirmed || !overrideOk || chosen.length === 0 || problems.length > 0}
              onClick={save}
            >
              {saving ? "Kayıtlar kaydediliyor…" : `Seçilen ${chosen.length} kaydı aktar`}
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}

/** Takes the refreshed server flags for the rows the check covered; keeps everything else. */
function withChecks(old: WizardRow[], map: Map<string, RowCheck>): WizardRow[] {
  return old.map((r) => {
    const c = map.get(r.key);
    return c ? { ...r, flags: { ...flagsFromCheck(c), listDuplicate: r.flags.listDuplicate } } : r;
  });
}
