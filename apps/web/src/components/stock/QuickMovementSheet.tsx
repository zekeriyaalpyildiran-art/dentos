"use client";

// Quick movement sheet (spec p7_rules_ui §20.5): receive, issue, transfer, waste and usage return in one
// mobile-first panel, with barcode scan (camera, wedge scanner or typed code) and the unknown-GTIN flow.
// Every rule is enforced by the RPCs; the checks here only give earlier, friendlier messages.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuthStore } from "@/lib/store";
import { formatTL, parseTL } from "@/lib/finance";
import { MOVEMENT_LABELS } from "@/lib/stock/codes";
import { BARCODE_MATCH_MESSAGES, batchMatchesScan, hasScannedBatch, type ScanLike } from "@/lib/stock/barcode-match";
import { MAX_BARCODE_LENGTH, parseGs1, type Gs1Scan } from "@/lib/stock/gs1";
import { daysLeft } from "@/lib/stock/expiry";
import {
  istanbulToday,
  movementOperationSaved,
  newKey,
  stockDb,
  stockIssue,
  stockItemDetail,
  stockReceive,
  stockRequestProduct,
  stockReturn,
  stockReturnCandidates,
  stockScanLookup,
  stockTransfer,
  stockWaste,
  toStockError,
  type BalanceRow,
  type ItemDetailJson,
  type LevelRow,
  type MoveResult,
  type ProductRequestJson,
  type ReturnCandidate,
  type StockError,
} from "@/lib/stock/rpc";
import { STORAGE_KEYS, readString } from "@/lib/stock/storage";
import {
  AMBIGUOUS_QTY_MESSAGE,
  chooseUnit,
  conversionLine,
  formatQty,
  isAmbiguousThousands,
  isWholeNumber,
  parseQty,
  quantityInStockUnits,
  type QuantityUnit,
} from "@/lib/stock/units";
import type { CartLine } from "@/lib/stock/cart";
import { BarcodeScanner, ItemPicker } from "./ItemPicker";
import { ItemForm } from "./ItemForm";
import { PatientPicker, type PatientRef } from "./PatientPicker";
import { useStock, type SheetOpenOptions, type SheetType } from "./StockContext";
import { useStockDoctors, useStockLocations, useStockSuppliers } from "./useStockRefs";
import {
  ExpiryBadge,
  Field,
  LevelBadge,
  Notice,
  StockErrorBox,
  StockModal,
  Toast,
  bigPrimary,
  buttonSecondary,
  stockInput,
} from "./ui";

const TITLES: Record<SheetType, string> = {
  receive: "Malzeme geldi",
  issue: "Malzeme kullandım",
  transfer: "Odaya malzeme götürdüm",
  waste: "Hasarlı / süresi geçmiş malzeme",
  return: "Kullanılmamış malzemeyi iade et",
};

const INSTRUCTIONS: Record<SheetType, string> = {
  receive: "Ambalajdaki barkodu okutun, miktarı ve lot bilgilerini kontrol edin.",
  issue: "Kullandığınız malzemeyi ve nereden aldığınızı seçin.",
  transfer: "Nereden nereye taşıdığınızı seçin; toplam stok değişmez.",
  waste: "Kullanılamayacak malzemeyi stoktan ayırın.",
  return: "Kullanılmamış malzemeyi kaydın lotuna ve konumuna geri alın.",
};

type Item = ItemDetailJson["item"];

interface UnknownState {
  scan: Gs1Scan;
  pending: ProductRequestJson | null;
}

function lotOptionLabel(b: BalanceRow, unit: string): string {
  return [
    b.lot_number,
    b.serial_number ? `seri ${b.serial_number}` : null,
    b.expiry_date ? `SKT ${b.expiry_date.split("-").reverse().join(".")}` : null,
    `${formatQty(b.quantity)} ${unit}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function summarize(result: MoveResult, type: SheetType, unit: string): string {
  const prefix = result.already_saved ? "Bu işlem daha önce kaydedilmişti. " : "";
  const moves = result.movements || [];
  if (moves.length > 1 && type !== "receive") {
    return `${prefix}${moves.length} lottan düşüldü: ${moves.map((m) => `${m.lot_number} ${formatQty(m.quantity)}`).join(", ")}`;
  }
  const m = moves[0];
  if (!m) return `${prefix}Kaydedildi.`;
  return `${prefix}${MOVEMENT_LABELS[m.movement_type] ?? "Hareket"} kaydedildi: ${formatQty(m.quantity)} ${unit} · Lot ${m.lot_number}`;
}

export function QuickMovementSheet({ options, onClose }: { options: SheetOpenOptions; onClose: () => void }) {
  const { gates, today: serverToday, notifyChanged } = useStock();
  const user = useAuthStore((state) => state.user);
  const today = serverToday ?? istanbulToday();
  const cartMode = !!options.onAddToCart;
  const { active: locations, defaultWarehouse, locations: allLocations } = useStockLocations();
  const { active: suppliers } = useStockSuppliers();

  const [type, setType] = useState<SheetType | null>(cartMode ? "receive" : options.type ?? null);
  const [showMore, setShowMore] = useState(false);
  const [detail, setDetail] = useState<ItemDetailJson | null>(null);
  const [itemLoading, setItemLoading] = useState(false);
  const [scan, setScan] = useState<ScanLike | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [unknown, setUnknown] = useState<UnknownState | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [wedgeOpen, setWedgeOpen] = useState(false);
  const [wedge, setWedge] = useState("");

  const [qtyText, setQtyText] = useState("");
  const [unit, setUnit] = useState<QuantityUnit>("usage");
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [lot, setLot] = useState("");
  const [expiry, setExpiry] = useState("");
  const [serial, setSerial] = useState("");
  const [showPackage, setShowPackage] = useState(false);
  const [batchId, setBatchId] = useState(options.batchId ?? "");
  const [showLots, setShowLots] = useState(!!options.batchId);
  const [patient, setPatient] = useState<PatientRef | null>(null);
  const [doctorId, setDoctorId] = useState("");
  const [appointmentId, setAppointmentId] = useState("");
  const [appointments, setAppointments] = useState<{ id: string; start_time: string }[]>([]);
  const [reason, setReason] = useState("");
  const [showExtra, setShowExtra] = useState(false);
  const [costText, setCostText] = useState("");
  const [costIsBox, setCostIsBox] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const [documentNo, setDocumentNo] = useState("");

  const [candidates, setCandidates] = useState<ReturnCandidate[] | null>(null);
  const [sourceId, setSourceId] = useState(options.sourceMovementId ?? "");
  const [unused, setUnused] = useState(false);

  const [reqName, setReqName] = useState("");
  const [reqNote, setReqNote] = useState("");
  const [reqResult, setReqResult] = useState<string | null>(null);
  const [reqBusy, setReqBusy] = useState(false);
  const [reqError, setReqError] = useState<StockError | null>(null);
  const [defineOpen, setDefineOpen] = useState(false);

  const opKey = useRef(newKey());
  /** The receive target follows the item's preferred location until the user picks one. */
  const toTouched = useRef(false);
  const reqKey = useRef(newKey());
  const reqId = useRef(newKey());
  const [busy, setBusy] = useState(false);
  /**
   * The last submit got no definitive answer: it may already be saved. The form is locked (no field may change, so
   * a retry sends exactly the same data under the same key) until a retry answers or the ledger check settles it.
   */
  const [pendingRetry, setPendingRetry] = useState(false);
  const [error, setError] = useState<StockError | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const clearToast = useCallback(() => setToast(null), []);

  const item: Item | null = detail?.item ?? null;
  const doctors = useStockDoctors(type === "issue");
  const shiftRoom = user ? readString(STORAGE_KEYS.shiftRoom(user.user_id)) : "";
  const locationsReady = allLocations !== null;
  const isActiveLocation = useCallback((id: string) => locations.some((l) => l.id === id), [locations]);

  // ------------------------------------------------------------------ item loading and scan

  const loadItem = useCallback(async (id: string) => {
    setItemLoading(true);
    setError(null);
    try {
      const d = await stockItemDetail(id);
      setDetail(d);
      setBatchId((b) => (d.balances.some((x) => x.batch_id === b) ? b : ""));
    } catch (e) {
      setDetail(null);
      setError(toStockError(e));
    } finally {
      setItemLoading(false);
    }
  }, []);

  const prefillPackage = useCallback((s: Partial<Gs1Scan>) => {
    if (s.lot) setLot(s.lot);
    if (s.serial) {
      setSerial(s.serial);
      setQtyText("1");
    }
    if (s.expiry) setExpiry(s.expiry);
    if (s.lot || s.serial || s.expiry) setShowPackage(true);
  }, []);

  const lookup = useCallback(
    async (p: Gs1Scan, currentType: SheetType | null) => {
      setScanError(null);
      setUnknown(null);
      setReqResult(null);
      try {
        const look = await stockScanLookup({
          gtin: p.gtin,
          lot: p.lot,
          serial: p.serial,
          expiry: p.expiry,
        });
        if (look.match === "known" && look.item) {
          setScan({ ...p, itemId: look.item.id });
          if (currentType === "receive") prefillPackage(p);
          await loadItem(look.item.id);
          setToast("Ürün bulundu. Miktarı ve konumu kontrol edin.");
        } else if (look.match === "draft") {
          setScanError("Bu ürünün kartı henüz tamamlanmadı. Stok sorumlusuna bildirin.");
        } else if (look.match === "inactive") {
          setScanError("Bu ürün kartı pasif. Stok sorumlusuna bildirin.");
        } else if (currentType === "receive") {
          setUnknown({ scan: p, pending: look.pending_request });
        } else {
          setScanError("Bu ürün henüz tanımlı değil. Kullanım kaydı için stok sorumlusuna bildirin.");
        }
      } catch (e) {
        setScanError(toStockError(e).message);
      }
    },
    [loadItem, prefillPackage]
  );

  const handleRaw = useCallback(
    (raw: string) => {
      if (!raw.trim() || raw.length > MAX_BARCODE_LENGTH) {
        setScanError(BARCODE_MATCH_MESSAGES.unreadable);
        return;
      }
      let p: Gs1Scan;
      try {
        p = parseGs1(raw);
      } catch (e) {
        setScanError(e instanceof Error ? e.message : BARCODE_MATCH_MESSAGES.unreadable);
        return;
      }
      if (!p.gtin) {
        setScanError(BARCODE_MATCH_MESSAGES.noGtin);
        return;
      }
      void lookup(p, type);
    },
    [lookup, type]
  );

  // Opening options: a preselected item and/or scanned label parts.
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const s = options.scan;
    if (options.itemId) {
      if (s && (s.lot || s.serial || s.expiry)) {
        setScan({ gtin: s.gtin ?? "", lot: s.lot ?? "", serial: s.serial ?? "", expiry: s.expiry ?? "", itemId: options.itemId });
        if ((cartMode ? "receive" : options.type) === "receive") prefillPackage(s);
      }
      void loadItem(options.itemId);
    } else if (s?.gtin && /^\d{14}$/.test(s.gtin)) {
      void lookup(
        { gtin: s.gtin, lot: s.lot ?? "", serial: s.serial ?? "", expiry: s.expiry ?? "" },
        cartMode ? "receive" : options.type ?? null
      );
    }
  }, [options, cartMode, loadItem, lookup, prefillPackage]);

  // ------------------------------------------------------------------ defaults

  useEffect(() => {
    if (!locationsReady || !type) return;
    const def = defaultWarehouse?.id ?? "";
    const room = shiftRoom && isActiveLocation(shiftRoom) ? shiftRoom : "";
    const preferred = options.fromLocationId && isActiveLocation(options.fromLocationId) ? options.fromLocationId : "";
    if (type === "receive") {
      const pref = item?.preferred_location_id && isActiveLocation(item.preferred_location_id) ? item.preferred_location_id : "";
      setToId((t) => (toTouched.current ? t || pref || def : pref || def));
    } else if (type === "issue") {
      setFromId((f) => f || preferred || room || def);
    } else if (type === "transfer") {
      const from = preferred || def;
      setFromId((f) => f || from);
      setToId((t) => t || (room && room !== from ? room : ""));
    } else if (type === "waste") {
      setFromId((f) => f || preferred || def);
    }
  }, [locationsReady, type, defaultWarehouse, shiftRoom, isActiveLocation, item?.preferred_location_id, options.fromLocationId]);

  useEffect(() => {
    if (item && type) setUnit(chooseUnit(item, type, serial));
  }, [item, type, serial]);

  useEffect(() => {
    if (type !== "issue" || !doctors || doctorId || !user) return;
    const mine = doctors.find((d) => d.user_id === user.user_id);
    if (mine) setDoctorId(mine.id);
  }, [type, doctors, doctorId, user]);

  // Today's appointments of the chosen patient (optional link).
  useEffect(() => {
    setAppointmentId("");
    setAppointments([]);
    if (!patient || !user?.clinic_id) return;
    let cancelled = false;
    const day = today;
    const next = new Date(Date.parse(day + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10);
    stockDb()
      .from("appointments")
      .select("id,start_time")
      .eq("clinic_id", user.clinic_id)
      .eq("patient_id", patient.id)
      .gte("start_time", `${day}T00:00:00+03:00`)
      .lt("start_time", `${next}T00:00:00+03:00`)
      .order("start_time")
      .then(({ data }) => {
        if (!cancelled) setAppointments((data || []) as { id: string; start_time: string }[]);
      });
    return () => {
      cancelled = true;
    };
  }, [patient, user?.clinic_id, today]);

  // Return candidates (managers only).
  useEffect(() => {
    if (type !== "return" || !item) return;
    let cancelled = false;
    setCandidates(null);
    stockReturnCandidates(item.id, { offset: 0, limit: 100 })
      .then((r) => {
        if (!cancelled) setCandidates(r.rows || []);
      })
      .catch((e) => {
        if (!cancelled) {
          setCandidates([]);
          setError(toStockError(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [type, item]);

  // ------------------------------------------------------------------ derived values

  const outbound = type === "issue" || type === "transfer" || type === "waste";
  const batchesHere = useMemo(
    () =>
      (detail?.balances || []).filter(
        (b) => b.location_id === fromId && b.quantity > 0 && (type === "waste" || b.usable)
      ),
    [detail, fromId, type]
  );
  const scanRestricted = outbound && !!item && hasScannedBatch(scan) && scan?.itemId === item.id;
  const lotOptions = useMemo(
    () =>
      scanRestricted && scan && item
        ? batchesHere.filter((b) =>
            batchMatchesScan(
              { stockItemId: item.id, lotNumber: b.lot_number, serialNumber: b.serial_number, expiryDate: b.expiry_date },
              scan
            )
          )
        : batchesHere,
    [scanRestricted, scan, item, batchesHere]
  );

  useEffect(() => {
    if (scanRestricted && lotOptions.length === 1) setBatchId(lotOptions[0].batch_id);
  }, [scanRestricted, lotOptions]);

  useEffect(() => {
    // A batch chosen at another location is no longer valid (only judged once the source is known).
    if (batchId && outbound && detail && fromId && !batchesHere.some((b) => b.batch_id === batchId)) setBatchId("");
  }, [batchId, outbound, detail, fromId, batchesHere]);

  const available = batchesHere.reduce((s, b) => s + Number(b.quantity), 0);
  const selectedBatch = batchesHere.find((b) => b.batch_id === batchId) ?? null;
  const serialLocked = (type === "receive" && !!serial.trim()) || (outbound && !!selectedBatch?.serial_number);
  const levelA = item?.tracking_level === "A";
  const batchRequired = outbound && (levelA || scanRestricted);
  const factor = Number(item?.units_per_purchase ?? 1);
  const qty = serialLocked ? 1 : parseQty(qtyText);
  const usageQty = item ? quantityInStockUnits(qty, serialLocked ? "usage" : unit, factor) : NaN;
  const candidate = candidates?.find((c) => c.movement_id === sourceId) ?? null;

  useEffect(() => {
    if (serialLocked) setQtyText("1");
  }, [serialLocked]);

  // ------------------------------------------------------------------ actions

  function chooseType(t: SheetType) {
    setType(t);
    setFromId("");
    setToId("");
    toTouched.current = false;
    setBatchId(options.batchId ?? "");
    setError(null);
    setLocalError(null);
    setUnknown(null);
    setScanError(null);
    opKey.current = newKey();
  }

  function resetForNext() {
    setDetail(null);
    setScan(null);
    setUnknown(null);
    setScanError(null);
    setQtyText("");
    setLot("");
    setExpiry("");
    setSerial("");
    setShowPackage(false);
    setBatchId("");
    setShowLots(false);
    setPatient(null);
    setReason("");
    setCostText("");
    setCostIsBox(false);
    setDocumentNo("");
    setSourceId("");
    setUnused(false);
    setCandidates(null);
    setLocalError(null);
    setError(null);
    setPendingRetry(false);
    opKey.current = newKey();
  }

  /** After an unanswered submit: was it saved under the current key? */
  async function checkPending() {
    setBusy(true);
    setError(null);
    try {
      if (await movementOperationSaved(opKey.current)) {
        setToast("Önceki deneme kaydedilmiş. Stok hareketleri listesinden kontrol edebilirsiniz.");
        notifyChanged();
        resetForNext();
      } else {
        // Nothing was written: the form may be edited again; the next submit uses a new key.
        setPendingRetry(false);
        opKey.current = newKey();
        setToast("Önceki deneme kaydedilmemiş. Bilgileri kontrol edip yeniden kaydedin.");
      }
    } catch (e) {
      setError(toStockError(e));
    } finally {
      setBusy(false);
    }
  }

  function clearItem() {
    setDetail(null);
    setScan(null);
    setBatchId("");
    setLocalError(null);
    setError(null);
  }

  function validate(): string | null {
    if (!type) return "İşlem türünü seçin.";
    if (!item) return "Ürünü seçin veya barkodu okutun.";
    if (!serialLocked && isAmbiguousThousands(qtyText)) return AMBIGUOUS_QTY_MESSAGE;
    if (type === "return") {
      if (!candidate) return "Bu ürüne ait kullanım kaydını seçin.";
      if (!(qty > 0)) return "Miktar sıfırdan büyük olmalıdır.";
      if (levelA && !isWholeNumber(qty)) return "Bu üründe tam adet girin.";
      if (qty > Number(candidate.remaining)) return "İade miktarı, bu kullanım kaydından iade edilebilecek miktarı aşıyor.";
      if (!unused) return "Yalnızca kullanılmamış ve kliniğin tekrar stoğa kabul ettiği malzeme iade edilebilir.";
      if (!reason.trim()) return "Bu işlem için kısa bir açıklama yazın.";
      return null;
    }
    if (!(qty > 0) || Number.isNaN(usageQty)) return "Miktar sıfırdan büyük olmalıdır.";
    if (levelA && !isWholeNumber(usageQty)) return "Bu üründe tam adet girin.";
    if (type === "receive") {
      if (!toId) return "Malzemeyi koyduğunuz konumu seçin.";
      const l = lot.trim();
      if ((item.tracking_level === "A" || item.tracking_level === "B") && (!l || l.toUpperCase() === "GENEL")) {
        return "Bu üründe ambalajdaki lot / parti numarasını girin.";
      }
      if (item.tracking_level === "B" && !expiry) return "Bu üründe son kullanma tarihini girin.";
      if (expiry && daysLeft(expiry, today) < 0) return "Süresi geçmiş ürün yeni stok olarak kabul edilemez.";
      if (serial.trim() && usageQty !== 1) return "Seri numaralı ürünleri tek tek, 1 adet olarak girin.";
      return null;
    }
    if (!fromId) return "Malzemeyi aldığınız konumu seçin.";
    if (type === "transfer") {
      if (!toId) return "Malzemeyi götürdüğünüz konumu seçin.";
      if (toId === fromId) return "Malzemenin bulunduğu yer ile götürüleceği yer farklı olmalıdır.";
    }
    if (scanRestricted && lotOptions.length === 0) {
      return "Okutulan lot bu yerde uygun stokta yok. Konumu ve ambalajı kontrol edin.";
    }
    if (batchRequired && !batchId) {
      return scanRestricted
        ? "Okutulan lot seçilen konumda yok. Konumu ve etiketi kontrol edin."
        : "Bu üründe elinizdeki ambalajın lot / seri kaydını seçin.";
    }
    if (type === "waste" && !reason.trim()) return "Bu işlem için kısa bir açıklama yazın.";
    if (type === "issue" && levelA && (!patient || !doctorId)) return "Bu ürünün kullanımında hasta ve uygulayan hekim zorunlu.";
    return null;
  }

  function costArgs(): { cents: number | null; unit: QuantityUnit } | string {
    if (!gates.cost || !costText.trim()) return { cents: null, unit: "usage" };
    const parsed = parseTL(costText, { allowZero: true });
    if (!parsed.ok) return parsed.error;
    return { cents: parsed.cents, unit: costIsBox && factor !== 1 ? "purchase" : "usage" };
  }

  async function save() {
    setError(null);
    const problem = validate();
    setLocalError(problem);
    if (problem || !item || !type) return;
    const cost = type === "receive" ? costArgs() : { cents: null, unit: "usage" as QuantityUnit };
    if (typeof cost === "string") {
      setLocalError(cost);
      return;
    }
    const enteredUnit: QuantityUnit = serialLocked ? "usage" : unit;
    // The factor the user saw is sent whenever the purchase unit was used (quantity or a cost per box), so a card
    // factor changed meanwhile is refused (E_UNIT_CHANGED) instead of being applied silently (D4).
    const factorArg = enteredUnit === "purchase" || (type === "receive" && cost.cents !== null && cost.unit === "purchase")
      ? { p_units_per_purchase: factor }
      : {};

    if (cartMode && options.onAddToCart) {
      const target = locations.find((l) => l.id === toId);
      const line: CartLine = {
        key: newKey(),
        stock_item_id: item.id,
        item_name: item.item_name,
        tracking_level: item.tracking_level,
        usage_unit: item.usage_unit,
        purchase_unit: item.purchase_unit,
        units_per_purchase: factor,
        to_location_id: toId,
        to_location_name: target?.name ?? "",
        quantity: qty,
        quantity_unit: enteredUnit,
        lot_number: lot.trim(),
        serial_number: serial.trim(),
        expiry_date: expiry,
        supplier_id: supplierId,
        document_no: documentNo.trim(),
        reason: reason.trim(),
      };
      if (gates.cost && cost.cents !== null) {
        line.unit_cost_cents = cost.cents;
        line.cost_unit = cost.unit;
      }
      options.onAddToCart(line);
      setToast(`Listeye eklendi: ${item.item_name}`);
      resetForNext();
      return;
    }

    setBusy(true);
    try {
      let result: MoveResult;
      const common = {
        p_operation_key: opKey.current,
        p_stock_item_id: item.id,
        p_quantity: qty,
        p_quantity_unit: enteredUnit,
        ...factorArg,
      };
      if (type === "receive") {
        result = await stockReceive({
          ...common,
          p_to_location_id: toId,
          p_lot_number: lot.trim() || null,
          p_serial_number: serial.trim() || null,
          p_expiry_date: expiry || null,
          p_unit_cost_cents: cost.cents,
          p_cost_unit: cost.unit,
          p_supplier_id: supplierId || null,
          p_document_no: documentNo.trim() || null,
          p_reason: reason.trim() || null,
        });
      } else if (type === "issue") {
        result = await stockIssue({
          ...common,
          p_from_location_id: fromId,
          p_batch_id: batchId || null,
          p_patient_id: patient?.id ?? null,
          p_appointment_id: appointmentId || null,
          p_doctor_id: doctorId || null,
          p_reason: reason.trim() || null,
        });
      } else if (type === "transfer") {
        result = await stockTransfer({
          ...common,
          p_from_location_id: fromId,
          p_to_location_id: toId,
          p_batch_id: batchId || null,
          p_reason: reason.trim() || null,
        });
      } else if (type === "waste") {
        result = await stockWaste({
          ...common,
          p_from_location_id: fromId,
          p_batch_id: batchId || null,
          p_reason: reason.trim(),
        });
      } else {
        result = await stockReturn({
          p_operation_key: opKey.current,
          p_source_movement_id: sourceId,
          p_quantity: qty,
          p_unused_confirmed: unused,
          p_reason: reason.trim(),
        });
      }
      setToast(summarize(result, type, item.usage_unit));
      notifyChanged();
      resetForNext();
    } catch (e) {
      const err = toStockError(e);
      if (err.network) {
        // Keep the key and lock the form until the retry or the ledger check answers.
        setPendingRetry(true);
      } else if (err.key === "E_OP_KEY") {
        // Never mint a new key silently: an earlier attempt with this key may have been saved.
        let saved = false;
        try {
          saved = await movementOperationSaved(opKey.current);
        } catch {
          saved = false;
        }
        if (saved) {
          setToast("Önceki deneme kaydedilmiş. Aynı hareket ikinci kez kaydedilmedi.");
          notifyChanged();
          resetForNext();
          return;
        }
        opKey.current = newKey();
        setPendingRetry(false);
      } else {
        setPendingRetry(false);
      }
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function sendProductRequest() {
    if (!unknown) return;
    setReqError(null);
    setReqBusy(true);
    try {
      const r = await stockRequestProduct({
        p_operation_key: reqKey.current,
        p_request_id: reqId.current,
        p_gtin: unknown.scan.gtin,
        p_name: reqName.trim(),
        p_note: reqNote.trim() || null,
        p_lot_number: unknown.scan.lot || null,
        p_serial_number: unknown.scan.serial || null,
        p_expiry_date: unknown.scan.expiry || null,
      });
      reqKey.current = newKey();
      reqId.current = newKey();
      setReqResult(
        r.already_pending
          ? "Tanımlama talebi stok sorumlusunda bekliyor."
          : "Tanımlama talebi stok sorumlusuna iletildi. Stok değişmedi."
      );
      setUnknown({ ...unknown, pending: r.request });
      notifyChanged();
    } catch (e) {
      const err = toStockError(e);
      if (err.key === "E_OP_KEY") reqKey.current = newKey();
      setReqError(err);
    } finally {
      setReqBusy(false);
    }
  }

  // ------------------------------------------------------------------ render

  const title = type ? TITLES[type] : "Ne yaptınız?";
  const canSave = !!type && !!item && !itemLoading;
  const fromName = locations.find((l) => l.id === fromId)?.name;
  const toName = locations.find((l) => l.id === toId)?.name;

  const footer = type ? (
    <button type="button" className={bigPrimary} disabled={!canSave || busy} onClick={() => void save()}>
      {busy
        ? "Kaydediliyor..."
        : cartMode
          ? "Mal kabul listesine ekle"
          : pendingRetry
            ? "Aynı bilgilerle tekrar dene"
            : "Hareketi kaydet"}
    </button>
  ) : undefined;

  return (
    <StockModal
      side
      title={title}
      description={type ? INSTRUCTIONS[type] : "İşlemi seçin, barkodu okutun, miktarı kaydedin."}
      onClose={onClose}
      busy={busy}
      footer={footer}
    >
      {!type ? (
        <div className="space-y-3">
          {!gates.op ? (
            <Notice tone="warn">Bu hesap stok kaydı oluşturamaz. Stok sorumlusuyla kontrol edin.</Notice>
          ) : (
            <>
              {(["receive", "issue", "transfer"] as SheetType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => chooseType(t)}
                  className="w-full min-h-[64px] text-left px-4 py-3 rounded-lg border border-gray-300 hover:bg-blue-50 hover:border-blue-400"
                >
                  <span className="block font-semibold">{TITLES[t]}</span>
                  <span className="block text-sm text-gray-600">{INSTRUCTIONS[t]}</span>
                </button>
              ))}
              <button
                type="button"
                className="text-sm text-blue-700 hover:underline min-h-[44px]"
                aria-expanded={showMore}
                onClick={() => setShowMore((v) => !v)}
              >
                Diğer işlemler: fire, sayım, iade ve talepler {showMore ? "▲" : "▼"}
              </button>
              {showMore && (
                <div className="space-y-2">
                  <button type="button" className={`${buttonSecondary} w-full min-h-[48px] text-left`} onClick={() => chooseType("waste")}>
                    Hasarlı / süresi geçmiş malzeme (fire)
                  </button>
                  {gates.mgr && (
                    <button type="button" className={`${buttonSecondary} w-full min-h-[48px] text-left`} onClick={() => chooseType("return")}>
                      Kullanılmamış malzemeyi iade et
                    </button>
                  )}
                  {gates.mgr && (
                    <Link href="/inventory/counts" onClick={onClose} className={`${buttonSecondary} block w-full min-h-[48px] text-left py-3`}>
                      Raftaki malzemeyi saydım
                    </Link>
                  )}
                  <Link href="/inventory/movements?mine=1" onClick={onClose} className={`${buttonSecondary} block w-full min-h-[48px] text-left py-3`}>
                    Düzeltme iste (kendi hareketlerim)
                  </Link>
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {pendingRetry && (
            <Notice tone="warn">
              <p>
                Son kayıt denemesi yanıt alamadı; hareket kaydedilmiş olabilir. Form kilitlendi: aynı bilgilerle tekrar
                deneyin veya kaydedilip kaydedilmediğini kontrol edin.
              </p>
              <button
                type="button"
                className={`${buttonSecondary} mt-2 min-h-[44px]`}
                disabled={busy}
                onClick={() => void checkPending()}
              >
                Kaydedildi mi kontrol et
              </button>
            </Notice>
          )}
          <fieldset disabled={pendingRetry || busy} className="space-y-4 min-w-0">
          {!cartMode && (
            <button type="button" className="text-sm text-blue-700 hover:underline" onClick={() => setType(null)}>
              ← İşlem türünü değiştir
            </button>
          )}

          {/* 1-3: scan or pick */}
          {!item && (
            <div className="space-y-3">
              <button type="button" className={bigPrimary} onClick={() => setScannerOpen(true)}>
                Barkodu kamerayla okut
              </button>
              <div className="border rounded">
                <button
                  type="button"
                  className="w-full text-left px-3 py-2 text-sm min-h-[44px]"
                  aria-expanded={wedgeOpen}
                  onClick={() => setWedgeOpen((v) => !v)}
                >
                  El tipi okuyucu / kodu elle yaz {wedgeOpen ? "▲" : "▼"}
                </button>
                {wedgeOpen && (
                  <form
                    className="px-3 pb-3 flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleRaw(wedge);
                      setWedge("");
                    }}
                  >
                    <input
                      className={stockInput}
                      autoFocus
                      value={wedge}
                      onChange={(e) => setWedge(e.target.value)}
                      placeholder="Okutun veya yazıp Enter'a basın"
                      maxLength={MAX_BARCODE_LENGTH}
                      aria-label="Barkod"
                    />
                    <button type="submit" className={`${buttonSecondary} min-h-[44px]`}>
                      Bul
                    </button>
                  </form>
                )}
              </div>
              {scanError && (
                <div role="alert" className="p-3 rounded bg-amber-50 border border-amber-200 text-amber-900 text-sm">
                  {scanError}
                </div>
              )}

              {unknown && (
                <div className="p-3 rounded-lg border border-amber-300 bg-amber-50 space-y-3">
                  <p className="font-semibold text-amber-900">Bu ürün henüz tanımlı değil</p>
                  <p className="text-sm text-amber-900">
                    Barkod: <span className="font-mono">{unknown.scan.gtin}</span>
                    {unknown.scan.lot && ` · Lot ${unknown.scan.lot}`}
                    {unknown.scan.serial && ` · Seri ${unknown.scan.serial}`}
                    {unknown.scan.expiry && ` · SKT ${unknown.scan.expiry}`}
                  </p>
                  {gates.mgr ? (
                    <button type="button" className={bigPrimary} onClick={() => setDefineOpen(true)}>
                      Yeni ürünü tanımla ve devam et
                    </button>
                  ) : unknown.pending && unknown.pending.status === "pending" ? (
                    <div className="space-y-2">
                      <p className="text-sm">{reqResult ?? "Tanımlama talebi stok sorumlusunda bekliyor."}</p>
                      <Link href="/inventory/requests" onClick={onClose} className="text-sm text-blue-700 hover:underline">
                        Talebin durumunu gör
                      </Link>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Field label="Ambalajdaki ürün adı">
                        <input className={stockInput} value={reqName} maxLength={160} onChange={(e) => setReqName(e.target.value)} />
                      </Field>
                      <Field label="Not (marka, ölçü, renk)">
                        <input className={stockInput} value={reqNote} maxLength={500} onChange={(e) => setReqNote(e.target.value)} />
                      </Field>
                      <StockErrorBox error={reqError} />
                      <button
                        type="button"
                        className={bigPrimary}
                        disabled={reqBusy || !reqName.trim()}
                        onClick={() => void sendProductRequest()}
                      >
                        {reqBusy ? "Gönderiliyor..." : "Tanımlama talebi bırak"}
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    className="text-sm text-blue-700 hover:underline min-h-[44px]"
                    onClick={() => void lookup(unknown.scan, type)}
                  >
                    Listeyi yenile
                  </button>
                </div>
              )}

              {!unknown && (
                <div>
                  <p className="text-sm font-semibold text-gray-800 mb-2">Barkod yoksa listeden seçin</p>
                  {type === "return" ? (
                    <ItemPicker onPick={(row: LevelRow) => void loadItem(row.id)} />
                  ) : (
                    <ItemPicker
                      onPick={(row: LevelRow) => {
                        setScan(null);
                        void loadItem(row.id);
                      }}
                    />
                  )}
                </div>
              )}
              {itemLoading && <p className="text-sm text-gray-500">Ürün yükleniyor...</p>}
            </div>
          )}

          {/* 4: confirmation card */}
          {item && (
            <div className="p-3 rounded-lg border border-blue-200 bg-blue-50 space-y-1">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900">{item.item_name}</p>
                  <p className="text-xs text-gray-600">
                    {[item.brand, item.model, item.item_code].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <LevelBadge level={item.tracking_level} />
              </div>
              {scan && hasScannedBatch(scan) && (
                <p className="text-xs text-blue-900">
                  Okutulan: {scan.lot ? `Lot ${scan.lot}` : ""}
                  {scan.serial ? ` · Seri ${scan.serial}` : ""}
                  {scan.expiry ? ` · SKT ${scan.expiry}` : ""}
                </p>
              )}
              <p className="text-xs text-gray-700">
                Kullanılabilir toplam: {formatQty(item.usable_qty)} {item.usage_unit}
              </p>
              {/TRANSFER/i.test(item.notes || "") && (
                <p className="text-xs text-blue-900">
                  Bu malzemeyi depodan odaya götürürken &apos;Transfer&apos; seçin. Klinik toplam stoku değişmez. Gerçek
                  tüketimi ayrıca kullanım olarak kaydedin.
                </p>
              )}
              <button type="button" className="text-sm text-blue-700 hover:underline min-h-[40px]" onClick={clearItem}>
                Başka ürün seç
              </button>
            </div>
          )}

          {item && type === "return" && (
            <div className="space-y-3">
              <Field label="Hangi kullanım kaydı?">
                <select className={stockInput} value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                  <option value="">{candidates === null ? "Yükleniyor..." : candidates.length ? "Seçin" : "İade edilebilir kullanım yok"}</option>
                  {(candidates || []).map((c) => (
                    <option key={c.movement_id} value={c.movement_id}>
                      #{c.ref_no} · {c.lot_number} · {c.location_name} · iade edilebilir {formatQty(c.remaining)}
                      {c.patient_name ? ` · ${c.patient_name}` : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={`Miktar (${item.usage_unit})`}>
                <input
                  className={`${stockInput} h-12`}
                  inputMode="decimal"
                  value={qtyText}
                  onChange={(e) => setQtyText(e.target.value)}
                />
              </Field>
              <label className="flex items-start gap-2 text-sm min-h-[44px]">
                <input type="checkbox" className="mt-1" checked={unused} onChange={(e) => setUnused(e.target.checked)} />
                Malzeme kullanılmadı ve klinik tarafından tekrar stoğa kabul edildi.
              </label>
              <Field label="Neden? *">
                <textarea className={stockInput} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
            </div>
          )}

          {item && type !== "return" && (
            <div className="space-y-4">
              {/* 6: quantity */}
              <div>
                <Field label="Miktar">
                  <div className="flex gap-2 items-stretch">
                    <input
                      className={`${stockInput} h-12`}
                      inputMode="decimal"
                      value={serialLocked ? "1" : qtyText}
                      disabled={serialLocked}
                      onChange={(e) => setQtyText(e.target.value)}
                      aria-label="Miktar"
                    />
                    {factor !== 1 && !serialLocked ? (
                      <div className="flex rounded border overflow-hidden shrink-0" role="group" aria-label="Birim">
                        {(["purchase", "usage"] as QuantityUnit[]).map((u) => (
                          <button
                            key={u}
                            type="button"
                            aria-pressed={unit === u}
                            onClick={() => setUnit(u)}
                            className={`px-3 min-w-[64px] ${unit === u ? "bg-blue-600 text-white" : "bg-white text-gray-800"}`}
                          >
                            {u === "purchase" ? item.purchase_unit : item.usage_unit}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <span className="self-center px-3 py-2 rounded bg-gray-100 text-sm">{item.usage_unit}</span>
                    )}
                  </div>
                </Field>
                {unit === "purchase" && qty > 0 && !serialLocked && (
                  <p className="text-sm text-gray-700 mt-1">{conversionLine(qty, item.purchase_unit, item.usage_unit, factor)}</p>
                )}
                {serialLocked && <p className="text-xs text-gray-600 mt-1">Seri numaralı ürün tek adet işlenir.</p>}
              </div>

              {/* 7: source */}
              {outbound && (
                <Field
                  label="Malzemeyi nereden aldınız?"
                  hint={
                    fromId
                      ? type === "waste"
                        ? `Bu konumda toplam (süresi geçmiş dahil): ${formatQty(available)} ${item.usage_unit}`
                        : `Bu konumda kullanılabilir: ${formatQty(available)} ${item.usage_unit}`
                      : undefined
                  }
                >
                  <select className={stockInput} value={fromId} onChange={(e) => setFromId(e.target.value)}>
                    <option value="">Seçin</option>
                    {locations.map((l) => {
                      const here = (detail?.by_location || []).find((b) => b.location_id === l.id);
                      return (
                        <option key={l.id} value={l.id}>
                          {l.name}
                          {here ? ` (${formatQty(type === "waste" ? here.total_qty : here.usable_qty)})` : ""}
                        </option>
                      );
                    })}
                  </select>
                </Field>
              )}

              {/* 8: target */}
              {(type === "receive" || type === "transfer") && (
                <Field label={type === "receive" ? "Nereye koydunuz?" : "Nereye götürdünüz?"}>
                  <select
                    className={stockInput}
                    value={toId}
                    onChange={(e) => {
                      toTouched.current = true;
                      setToId(e.target.value);
                    }}
                  >
                    <option value="">Seçin</option>
                    {locations
                      .filter((l) => type !== "transfer" || l.id !== fromId)
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                  </select>
                </Field>
              )}

              {/* 9: package details on receive */}
              {type === "receive" && (
                <div className="border rounded-lg">
                  {item.tracking_level === "C" && !showPackage ? (
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm min-h-[44px]"
                      onClick={() => setShowPackage(true)}
                    >
                      Ambalaj bilgileri (lot, SKT, seri) · isteğe bağlı ▼
                    </button>
                  ) : (
                    <div className="p-3 space-y-3">
                      <p className="text-sm font-semibold">Ambalaj bilgilerini kontrol edin</p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label={`Lot / parti${item.tracking_level !== "C" ? " *" : ""}`}>
                          <input
                            className={stockInput}
                            value={lot}
                            maxLength={40}
                            placeholder={item.tracking_level === "C" ? "GENEL" : ""}
                            onChange={(e) => setLot(e.target.value)}
                          />
                        </Field>
                        <Field label={`Son kullanma tarihi${item.tracking_level === "B" ? " *" : ""}`}>
                          <input
                            type="date"
                            className={stockInput}
                            value={expiry}
                            min={today}
                            onChange={(e) => setExpiry(e.target.value)}
                          />
                        </Field>
                        <Field label="Seri numarası" className="sm:col-span-2">
                          <input className={stockInput} value={serial} maxLength={40} onChange={(e) => setSerial(e.target.value)} />
                        </Field>
                      </div>
                      <p className="text-xs text-gray-500">Bugün son kullanma tarihi geçmiş ürün kabul edilmez.</p>
                      {expiry && daysLeft(expiry, today) < 0 && (
                        <p role="alert" className="text-sm text-red-700">
                          Süresi geçmiş ürün yeni stok olarak kabul edilemez.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* 10: lot picker on outbound */}
              {outbound && (
                <div>
                  {batchRequired || showLots ? (
                    <Field label={scanRestricted ? "Okutulan lot / seriyi seçin" : batchRequired ? "Lot / seri seçin *" : "Lot seçimi"}>
                      <select className={stockInput} value={batchId} onChange={(e) => setBatchId(e.target.value)}>
                        <option value="">
                          {batchRequired ? "Seçin" : "Otomatik · Tarihi en yakın uygun lot"}
                        </option>
                        {lotOptions.map((b) => (
                          <option key={b.batch_id} value={b.batch_id}>
                            {lotOptionLabel(b, item.usage_unit)}
                            {!b.usable ? " · SÜRESİ GEÇMİŞ" : ""}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ) : (
                    <button type="button" className="text-sm text-blue-700 hover:underline min-h-[44px]" onClick={() => setShowLots(true)}>
                      Lot seçimi: otomatik · Gerekirse değiştir
                    </button>
                  )}
                  {scanRestricted && lotOptions.length === 0 && (
                    <p role="alert" className="text-sm text-red-700 mt-1">
                      Okutulan lot bu yerde uygun stokta yok. Konumu ve ambalajı kontrol edin.
                    </p>
                  )}
                  {selectedBatch?.expiry_date && <div className="text-xs mt-1"><ExpiryBadge expiry={selectedBatch.expiry_date} today={today} /></div>}
                </div>
              )}

              {/* 11: patient block on issue */}
              {type === "issue" && levelA && (
                <PatientBlock
                  required
                  patient={patient}
                  setPatient={setPatient}
                  doctors={doctors}
                  doctorId={doctorId}
                  setDoctorId={setDoctorId}
                  appointments={appointments}
                  appointmentId={appointmentId}
                  setAppointmentId={setAppointmentId}
                />
              )}

              {/* 13: reason */}
              {type === "waste" ? (
                <Field label="Neden? *">
                  <textarea className={stockInput} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
              ) : (
                <div className="border rounded-lg">
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm min-h-[44px]"
                    aria-expanded={showExtra}
                    onClick={() => setShowExtra((v) => !v)}
                  >
                    Not ve ek bilgiler {showExtra ? "▲" : "▼"}
                  </button>
                  {showExtra && (
                    <div className="p-3 pt-0 space-y-3">
                      {type === "issue" && !levelA && (
                        <PatientBlock
                          patient={patient}
                          setPatient={setPatient}
                          doctors={doctors}
                          doctorId={doctorId}
                          setDoctorId={setDoctorId}
                          appointments={appointments}
                          appointmentId={appointmentId}
                          setAppointmentId={setAppointmentId}
                        />
                      )}
                      {type === "receive" && (
                        <>
                          <Field label="Tedarikçi">
                            <select className={stockInput} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                              <option value="">—</option>
                              {suppliers.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name}
                                </option>
                              ))}
                            </select>
                          </Field>
                          <Field label="İrsaliye / fatura no">
                            <input className={stockInput} maxLength={60} value={documentNo} onChange={(e) => setDocumentNo(e.target.value)} />
                          </Field>
                          {gates.cost && (
                            <Field
                              label="Birim maliyet (TL)"
                              hint={
                                item.last_unit_cost_cents !== undefined && item.last_unit_cost_cents !== null
                                  ? `Boş bırakılırsa son maliyet kullanılır: ${formatTL(item.last_unit_cost_cents)} / ${item.usage_unit}`
                                  : "Boş bırakılırsa fiyat girilmemiş sayılır."
                              }
                            >
                              <input className={stockInput} inputMode="decimal" value={costText} onChange={(e) => setCostText(e.target.value)} />
                              {factor !== 1 && (
                                <label className="flex items-center gap-2 mt-2 text-sm">
                                  <input type="checkbox" checked={costIsBox} onChange={(e) => setCostIsBox(e.target.checked)} />
                                  Kutu fiyatı girdim ({item.purchase_unit} başına)
                                </label>
                              )}
                            </Field>
                          )}
                        </>
                      )}
                      <Field label="Not">
                        <textarea className={stockInput} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
                      </Field>
                    </div>
                  )}
                </div>
              )}

              {/* 14: summary */}
              {qty > 0 && (
                <div className="p-3 rounded bg-gray-50 border text-sm space-y-1">
                  <p className="font-semibold">Kaydetmeden önce kontrol edin</p>
                  <p>{item.item_name}</p>
                  <p>
                    {formatQty(Number.isFinite(usageQty) ? usageQty : qty)} {item.usage_unit}
                    {unit === "purchase" && !serialLocked ? ` (${conversionLine(qty, item.purchase_unit, item.usage_unit, factor)})` : ""}
                  </p>
                  <p>
                    {type === "receive"
                      ? `Stok girişi → ${toName ?? "—"}`
                      : type === "transfer"
                        ? `${fromName ?? "—"} → ${toName ?? "—"}`
                        : `${fromName ?? "—"} → ${type === "waste" ? "Fire / SKT" : "Kullanım"}`}
                  </p>
                  <p>
                    {type === "receive"
                      ? `Lot: ${lot.trim() || "GENEL"}${expiry ? ` · SKT ${expiry}` : ""}${serial.trim() ? ` · Seri ${serial.trim()}` : ""}`
                      : selectedBatch
                        ? `Lot: ${lotOptionLabel(selectedBatch, item.usage_unit)}`
                        : "Lot: otomatik (önce tarihi en yakın)"}
                  </p>
                </div>
              )}
            </div>
          )}

          {localError && (
            <div role="alert" className="p-3 rounded bg-red-50 text-red-700 text-sm">
              {localError}
            </div>
          )}
          </fieldset>
          <StockErrorBox error={error} onReload={item && !pendingRetry ? () => void loadItem(item.id) : undefined} />
        </div>
      )}

      {scannerOpen && (
        <BarcodeScanner purpose="movement" onClose={() => setScannerOpen(false)} onScan={(raw) => handleRaw(raw)} />
      )}

      {defineOpen && unknown && (
        <StockModal title="Ürünü bir kez tanımlayın" onClose={() => setDefineOpen(false)} wide>
          <ItemForm
            initialGtin={unknown.scan.gtin}
            canViewCosts={gates.cost}
            submitLabel="Ürünü oluştur ve miktara geç"
            onCancel={() => setDefineOpen(false)}
            onSaved={(saved) => {
              setDefineOpen(false);
              const s = unknown.scan;
              setUnknown(null);
              setScan({ ...s, itemId: saved.id });
              prefillPackage(s);
              notifyChanged();
              void loadItem(saved.id);
            }}
          />
        </StockModal>
      )}

      <Toast text={toast} onDone={clearToast} />
    </StockModal>
  );
}

function PatientBlock({
  required,
  patient,
  setPatient,
  doctors,
  doctorId,
  setDoctorId,
  appointments,
  appointmentId,
  setAppointmentId,
}: {
  required?: boolean;
  patient: PatientRef | null;
  setPatient: (p: PatientRef | null) => void;
  doctors: { id: string; name: string }[] | null;
  doctorId: string;
  setDoctorId: (id: string) => void;
  appointments: { id: string; start_time: string }[];
  appointmentId: string;
  setAppointmentId: (id: string) => void;
}) {
  return (
    <div className={`space-y-3 ${required ? "p-3 rounded-lg border border-purple-200 bg-purple-50" : ""}`}>
      {required && <p className="text-xs text-purple-900">Kişisel verileri yalnızca hasta kartından seçin.</p>}
      <Field label={`Hasta${required ? " *" : ""}`}>
        <PatientPicker value={patient} onChange={setPatient} />
      </Field>
      <Field label={`Uygulayan hekim${required ? " *" : ""}`}>
        <select className={stockInput} value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
          <option value="">{doctors === null ? "Yükleniyor..." : "Seçin"}</option>
          {(doctors || []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </Field>
      {patient && appointments.length > 0 && (
        <Field label="Randevu (isteğe bağlı)">
          <select className={stockInput} value={appointmentId} onChange={(e) => setAppointmentId(e.target.value)}>
            <option value="">—</option>
            {appointments.map((a) => (
              <option key={a.id} value={a.id}>
                {new Date(a.start_time).toLocaleTimeString("tr-TR", {
                  timeZone: "Europe/Istanbul",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </option>
            ))}
          </select>
        </Field>
      )}
    </div>
  );
}
