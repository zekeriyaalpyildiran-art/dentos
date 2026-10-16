"use client";

// "Son kutu açıldı / azaldı": the assistant who opens the last box / tube of a product in a room reports it in a few
// taps (room remembered on this device, barcode or list, prefilled quantity and note), and the app opens a room
// request (oda talebi) for that room from the main warehouse. The stock managers see it in the app only: the amber
// menu count, the notice on the stock home and the requests list. No e-mail, no push.
//
// LastBoxSheetView is the screen itself and reads / writes only through the `api` it is given (the live RPCs, or a
// mock in a preview); LastBoxSheet wires it to the stock area (locations, the remembered room, change counter).

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuthStore } from "@/lib/store";
import { newId } from "@/lib/finance";
import { LOCATION_KIND_LABELS, type LocationKind } from "@/lib/stock/codes";
import { BARCODE_MATCH_MESSAGES } from "@/lib/stock/barcode-match";
import { MAX_BARCODE_LENGTH, parseGs1, type Gs1Scan } from "@/lib/stock/gs1";
import {
  LAST_BOX_ACTION_LABEL,
  LAST_BOX_NOTE,
  findOpenRoomRequest,
  hasPurchasePack,
  lastBoxDefaultQuantity,
  lastBoxDuplicateText,
  lastBoxItemProblem,
  lastBoxRoomKey,
  lastBoxSuccessText,
  packFactor,
  pickStartRoom,
  requestRooms,
  roomRequestsHref,
  type RoomLike,
} from "@/lib/stock/last-box";
import { ROOM_REQUEST_STATUS_LABELS, qtyLabel } from "@/lib/stock/purchasing";
import {
  RELOAD_KEYS,
  newKey,
  stockItemDetail,
  stockItemLevels,
  stockRequestProduct,
  stockRoomRequestCreate,
  stockRoomRequestList,
  stockScanLookup,
  toStockError,
  type LevelFilters,
  type LevelList,
  type LevelRow,
  type PageArg,
  type ProductRequestJson,
  type RoomRequestJson,
  type ScanLookup,
  type StockError,
} from "@/lib/stock/rpc";
import { STORAGE_KEYS, readString, writeString } from "@/lib/stock/storage";
import {
  AMBIGUOUS_QTY_MESSAGE,
  conversionLine,
  isAmbiguousThousands,
  isWholeNumber,
  parseQty,
  quantityInStockUnits,
  type QuantityUnit,
} from "@/lib/stock/units";
import { refreshMenuBadges } from "@/components/useMenuBadges";
import { BarcodeScanner, ItemPicker } from "./ItemPicker";
import { ItemForm } from "./ItemForm";
import { useStock } from "./StockContext";
import { useStockLocations } from "./useStockRefs";
import { Field, LevelBadge, Notice, StockErrorBox, StockModal, bigPrimary, formatTimestamp, stockInput } from "./ui";

const NOTE_MAX = 500;
/** Secondary buttons of this sheet: 48px high for gloved fingers on a phone. */
const touchSecondary =
  "inline-flex items-center justify-center min-h-[48px] px-4 border border-gray-300 text-gray-800 rounded-lg hover:bg-gray-50 disabled:opacity-40";
const textButton = "inline-flex items-center min-h-[48px] text-sm text-blue-700 hover:underline";
/** The duplicate check gets this long; then the form opens anyway (the submit checks again before saving). */
const CHECK_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Data access (live RPCs by default; the preview passes a mock)
// ---------------------------------------------------------------------------

export type CreateRoomRequestArgs = Parameters<typeof stockRoomRequestCreate>[0];
export type RequestProductArgs = Parameters<typeof stockRequestProduct>[0];

export interface LastBoxApi {
  /** Item search of the picker (stock_item_levels). */
  listItems: (filters: LevelFilters, page: PageArg) => Promise<LevelList>;
  lookupBarcode: (scan: Gs1Scan) => Promise<ScanLookup>;
  loadItem: (id: string) => Promise<LevelRow>;
  /** Open (pending / approved) request of this room for this card, or null. */
  findOpenRequest: (locationId: string, stockItemId: string) => Promise<RoomRequestJson | null>;
  createRequest: (args: CreateRoomRequestArgs) => Promise<{ already_saved?: boolean; request: RoomRequestJson }>;
  requestProduct: (
    args: RequestProductArgs
  ) => Promise<{ already_saved?: boolean; already_pending: boolean; request: ProductRequestJson }>;
}

export const liveLastBoxApi: LastBoxApi = {
  listItems: stockItemLevels,
  lookupBarcode: (scan) => stockScanLookup({ gtin: scan.gtin, lot: scan.lot, serial: scan.serial, expiry: scan.expiry }),
  loadItem: async (id) => (await stockItemDetail(id)).item,
  findOpenRequest: async (locationId, stockItemId) => {
    const r = await stockRoomRequestList(
      { status: "open", location_id: locationId, stock_item_id: stockItemId },
      { offset: 0, limit: 5 }
    );
    return findOpenRoomRequest(r.rows, locationId, stockItemId);
  },
  createRequest: stockRoomRequestCreate,
  requestProduct: stockRequestProduct,
};

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

/** How the product step starts once the room is known: the camera at once, or the list's search box. */
export type LastBoxStart = "scan" | "list";

interface UnknownScan {
  scan: Gs1Scan;
  pending: ProductRequestJson | null;
}

export interface LastBoxSheetViewProps {
  api: LastBoxApi;
  /** Rooms a request may point to (requestRooms); null while loading. */
  rooms: RoomLike[] | null;
  /** Preselected room (this device's last room, the shift room, or a deep link); '' for none. */
  defaultRoomId: string;
  /** Opened from a card page: start with this card. */
  initialItemId?: string | null;
  /**
   * 'scan': open the camera as soon as the room is known (tap, scan, tap 'Oda talebini aç'); closing the camera
   * leaves the list below. 'list': focus the list's search box instead. Default: focus the scan button.
   */
  start?: LastBoxStart;
  /** Stock managers may define an unknown barcode on the spot (renderDefineItem). */
  canManage: boolean;
  onClose: () => void;
  /** The user picked a room (remember it on this device). */
  onRoomChosen?: (locationId: string) => void;
  /** A request was created (or found saved after a lost answer). */
  onCreated?: (request: RoomRequestJson) => void;
  /** A product definition request was left for an unknown barcode. */
  onProductRequested?: () => void;
  /** Managers: the "define this product" dialog; calls onSaved with the new card. */
  renderDefineItem?: (args: { gtin: string; onSaved: (item: LevelRow) => void; onCancel: () => void }) => ReactNode;
}

export function LastBoxSheetView({
  api,
  rooms,
  defaultRoomId,
  initialItemId,
  start,
  canManage,
  onClose,
  onRoomChosen,
  onCreated,
  onProductRequested,
  renderDefineItem,
}: LastBoxSheetViewProps) {
  const [roomId, setRoomId] = useState(defaultRoomId);
  const [roomPicking, setRoomPicking] = useState(false);
  const roomTouched = useRef(false);

  const [item, setItem] = useState<LevelRow | null>(null);
  const [itemLoading, setItemLoading] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [wedgeOpen, setWedgeOpen] = useState(false);
  const [wedge, setWedge] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);
  const [unknown, setUnknown] = useState<UnknownScan | null>(null);

  const [qtyText, setQtyText] = useState("1");
  const [unit, setUnit] = useState<QuantityUnit>("usage");
  const [note, setNote] = useState(LAST_BOX_NOTE);

  /** undefined: not checked yet for this room + card. */
  const [existing, setExisting] = useState<RoomRequestJson | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  /** The last submit got no answer: the form stays locked so a retry sends the same data under the same key. */
  const [pendingRetry, setPendingRetry] = useState(false);
  const [error, setError] = useState<StockError | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [result, setResult] = useState<{ request: RoomRequestJson; alreadySaved: boolean } | null>(null);
  /** The card was reloaded after it changed on the server (E_UNIT_CHANGED); says why the quantity was reset. */
  const [reloaded, setReloaded] = useState<string | null>(null);

  const [reqName, setReqName] = useState("");
  const [reqNote, setReqNote] = useState("");
  const [reqBusy, setReqBusy] = useState(false);
  const [reqError, setReqError] = useState<StockError | null>(null);
  const [reqResult, setReqResult] = useState<string | null>(null);
  const [defineGtin, setDefineGtin] = useState<string | null>(null);

  const opKey = useRef(newKey());
  const requestId = useRef(newId());
  const reqKey = useRef(newKey());
  const reqId = useRef(newId());

  const scanButtonRef = useRef<HTMLButtonElement>(null);
  const firstRoomRef = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  /** The requested start, used once (a later room change only moves the focus). */
  const autoStart = useRef<LastBoxStart | undefined>(start);

  const room = rooms?.find((r) => r.id === roomId) ?? null;
  const showRooms = roomPicking || !room;

  // The preselected room arrives with the locations; never override a room the user chose.
  useEffect(() => {
    if (!roomTouched.current && defaultRoomId) setRoomId(defaultRoomId);
  }, [defaultRoomId]);

  const chooseItem = useCallback((row: LevelRow) => {
    const d = lastBoxDefaultQuantity(row);
    setItem(row);
    setQtyText(d.qtyText);
    setUnit(d.unit);
    setUnknown(null);
    setScanError(null);
    setLocalError(null);
    setError(null);
    setReloaded(null);
  }, []);

  /** Takes the card unless it is passive or a draft (the RPC would refuse it); then says so like a scan does. */
  const chooseIfUsable = useCallback(
    (row: LevelRow): boolean => {
      const problem = lastBoxItemProblem(row);
      if (problem) {
        setItem(null);
        setUnknown(null);
        setError(null);
        setScanError(problem);
        return false;
      }
      chooseItem(row);
      return true;
    },
    [chooseItem]
  );

  // Opened from a card page or a deep link with a card.
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current || !initialItemId) return;
    initialized.current = true;
    setItemLoading(true);
    api
      .loadItem(initialItemId)
      .then(chooseIfUsable)
      .catch((e) => setError(toStockError(e)))
      .finally(() => setItemLoading(false));
  }, [api, initialItemId, chooseIfUsable]);

  const focusPicker = () => pickerRef.current?.querySelector<HTMLInputElement>("input")?.focus();

  /** The room is known and no card yet: open the camera, focus the list, or focus the scan button. */
  const startProductStep = () => {
    const how = autoStart.current;
    autoStart.current = undefined;
    if (how === "scan") setScannerOpen(true);
    else if (how === "list") focusPicker();
    else scanButtonRef.current?.focus();
  };

  // First focus: the room buttons when no room is known yet, else the product step (camera, list or scan button).
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || rooms === null || initialItemId) return;
    focused.current = true;
    // The preselected room may arrive in this same render (its state is set by the effect above).
    const known = !!room || (!!defaultRoomId && rooms.some((r) => r.id === defaultRoomId));
    if (known) startProductStep();
    else firstRoomRef.current?.focus();
    // startProductStep reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms, room, defaultRoomId, initialItemId]);

  // Duplicate check as soon as the room and the card are known (the submit checks again). Until it answers the form
  // says so and the submit waits; a check that hangs or fails opens the form (the submit's own check still runs).
  useEffect(() => {
    setExisting(undefined);
    if (!roomId || !item || result) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!cancelled) setExisting((e) => (e === undefined ? null : e));
    }, CHECK_TIMEOUT_MS);
    api
      .findOpenRequest(roomId, item.id)
      .then((found) => {
        if (!cancelled) setExisting(found && found.id !== requestId.current ? found : null);
      })
      .catch(() => {
        if (!cancelled) setExisting(null);
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, roomId, item, result]);

  useEffect(() => {
    if (result) resultRef.current?.focus();
  }, [result]);

  function pickRoom(id: string) {
    roomTouched.current = true;
    setRoomId(id);
    setRoomPicking(false);
    setLocalError(null);
    onRoomChosen?.(id);
    if (!item) window.setTimeout(startProductStep, 0);
  }

  async function lookup(scan: Gs1Scan) {
    setScanError(null);
    setUnknown(null);
    setReqResult(null);
    setItemLoading(true);
    try {
      const look = await api.lookupBarcode(scan);
      if (look.match === "known" && look.item) {
        chooseIfUsable(look.item);
      } else if (look.match === "draft") {
        setScanError("Bu ürünün kartı henüz tamamlanmadı. Stok sorumlusuna bildirin.");
      } else if (look.match === "inactive") {
        setScanError("Bu ürün kartı pasif. Stok sorumlusuna bildirin.");
      } else {
        setUnknown({ scan, pending: look.pending_request });
        setReqNote(room ? `${LAST_BOX_NOTE} · ${room.name}` : LAST_BOX_NOTE);
      }
    } catch (e) {
      setScanError(toStockError(e).message);
    } finally {
      setItemLoading(false);
    }
  }

  function handleRaw(raw: string) {
    if (!raw.trim() || raw.length > MAX_BARCODE_LENGTH) {
      setScanError(BARCODE_MATCH_MESSAGES.unreadable);
      return;
    }
    let scan: Gs1Scan;
    try {
      scan = parseGs1(raw);
    } catch (e) {
      setScanError(e instanceof Error ? e.message : BARCODE_MATCH_MESSAGES.unreadable);
      return;
    }
    if (!scan.gtin) {
      setScanError(BARCODE_MATCH_MESSAGES.noGtin);
      return;
    }
    void lookup(scan);
  }

  function clearItem() {
    setItem(null);
    setExisting(undefined);
    setLocalError(null);
    setError(null);
    setReloaded(null);
    window.setTimeout(() => scanButtonRef.current?.focus(), 0);
  }

  const factor = item ? packFactor(item) : 1;
  const pack = !!item && hasPurchasePack(item);
  const qty = parseQty(qtyText);
  const usageQty = item ? quantityInStockUnits(qty, unit, factor) : NaN;
  const qtySummary = item && Number.isFinite(usageQty) ? qtyLabel(usageQty, item.usage_unit, item.purchase_unit, factor) : null;

  function validate(): string | null {
    if (!room) return "Malzemenin bittiği odayı seçin.";
    if (!item) return "Ürünü seçin veya barkodu okutun.";
    if (isAmbiguousThousands(qtyText)) return AMBIGUOUS_QTY_MESSAGE;
    if (!(qty > 0) || !Number.isFinite(usageQty)) return "Miktar sıfırdan büyük olmalıdır.";
    if (item.tracking_level === "A" && !isWholeNumber(usageQty)) return "Bu üründe tam adet girin.";
    if (note.trim().length > NOTE_MAX) return "Not en fazla 500 karakter olabilir.";
    return null;
  }

  function finish(request: RoomRequestJson, alreadySaved: boolean) {
    setResult({ request, alreadySaved });
    setPendingRetry(false);
    setExisting(undefined);
    opKey.current = newKey();
    requestId.current = newId();
    onCreated?.(request);
  }

  /** The card changed on the server (pack factor): load it again, so the quantity and unit follow the new pack. */
  function reloadItem(current: LevelRow, err: StockError) {
    opKey.current = newKey();
    setItemLoading(true);
    api
      .loadItem(current.id)
      .then((row) => {
        if (chooseIfUsable(row)) {
          setReloaded(
            "Ürün kartının kutu / adet bilgisi değişmiş; miktar yeni pakete göre yeniden ayarlandı. Kontrol edip tekrar gönderin."
          );
        }
      })
      .catch(() => setError(err))
      .finally(() => setItemLoading(false));
  }

  async function submit() {
    setError(null);
    setReloaded(null);
    const problem = validate();
    setLocalError(problem);
    if (problem || !room || !item) return;
    setBusy(true);
    try {
      // Never a second request for the same room and card: checked again right before saving. Our own earlier
      // attempt (saved, answer lost) counts as done.
      const open = await api.findOpenRequest(room.id, item.id);
      if (open && open.id === requestId.current) {
        finish(open, true);
        return;
      }
      if (open) {
        setExisting(open);
        setPendingRetry(false);
        return;
      }
      const r = await api.createRequest({
        p_operation_key: opKey.current,
        p_request_id: requestId.current,
        p_stock_item_id: item.id,
        p_location_id: room.id,
        p_quantity: qty,
        p_quantity_unit: unit,
        p_units_per_purchase: unit === "purchase" ? factor : null,
        p_note: note.trim() || null,
      });
      finish(r.request, !!r.already_saved);
    } catch (e) {
      const err = toStockError(e);
      if (err.network) {
        setPendingRetry(true);
      } else {
        setPendingRetry(false);
        if (err.key === "E_OP_KEY") opKey.current = newKey();
        if (err.key === "E_ID_TAKEN") {
          requestId.current = newId();
          opKey.current = newKey();
        }
      }
      setError(err);
      if (!err.network && err.key && RELOAD_KEYS.has(err.key)) reloadItem(item, err);
    } finally {
      setBusy(false);
    }
  }

  async function sendProductRequest() {
    if (!unknown) return;
    setReqError(null);
    setReqBusy(true);
    try {
      const r = await api.requestProduct({
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
      reqId.current = newId();
      setReqResult(
        r.already_pending
          ? "Bu barkod için tanımlama talebi zaten stok sorumlusunda bekliyor."
          : "Tanımlama talebi stok sorumlusuna iletildi. Ürün tanımlanınca oda talebini buradan açabilirsiniz."
      );
      setUnknown({ ...unknown, pending: r.request });
      onProductRequested?.();
    } catch (e) {
      const err = toStockError(e);
      if (err.key === "E_OP_KEY") reqKey.current = newKey();
      setReqError(err);
    } finally {
      setReqBusy(false);
    }
  }

  function nextReport() {
    setResult(null);
    setItem(null);
    setNote(LAST_BOX_NOTE);
    setQtyText("1");
    setUnit("usage");
    setError(null);
    setLocalError(null);
    setReloaded(null);
    window.setTimeout(() => scanButtonRef.current?.focus(), 0);
  }

  // ------------------------------------------------------------------ render

  /** Room and card are chosen and the duplicate check has not answered yet. */
  const checking = !!room && !!item && existing === undefined && !result;

  const footer = result ? undefined : (
    <button
      type="button"
      className={bigPrimary}
      disabled={busy || itemLoading || !room || !item || !!existing || checking}
      onClick={() => void submit()}
    >
      {busy
        ? "Gönderiliyor..."
        : existing
          ? "Bu oda için açık talep var"
          : checking
            ? "Kontrol ediliyor..."
            : pendingRetry
              ? "Aynı bilgilerle tekrar dene"
              : "📣 Oda talebini aç"}
    </button>
  );

  return (
    <StockModal
      side
      title={`📣 ${LAST_BOX_ACTION_LABEL}`}
      description="Odada son kutuyu açtıysanız bildirin; ana depodan yenisi için oda talebi açılır."
      onClose={onClose}
      busy={busy}
      footer={footer}
    >
      {result ? (
        <div className="space-y-4">
          <div
            ref={resultRef}
            tabIndex={-1}
            role="status"
            className="p-4 rounded-lg border border-green-200 bg-green-50 text-green-800 outline-none"
          >
            <p className="text-lg font-semibold">✅ {lastBoxSuccessText(result.request.ref_no, result.alreadySaved)}</p>
            <p className="text-sm mt-1">
              {result.request.location_name} · {result.request.item_name} ·{" "}
              {qtyLabel(
                Number(result.request.quantity),
                result.request.usage_unit,
                result.request.purchase_unit,
                packFactor(result.request)
              )}
            </p>
          </div>
          <button type="button" className={bigPrimary} onClick={nextReport}>
            Başka ürün bildir
          </button>
          <div className="flex flex-wrap gap-2">
            <Link href={roomRequestsHref(result.request.location_id)} onClick={onClose} className={touchSecondary}>
              Talebi listede gör
            </Link>
            <button type="button" className={touchSecondary} onClick={onClose}>
              Kapat
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          {pendingRetry && (
            <Notice tone="warn">
              Son deneme yanıt alamadı; talep açılmış olabilir. Form kilitlendi: aynı bilgilerle tekrar deneyin (ikinci
              talep açılmaz).
            </Notice>
          )}
          <fieldset disabled={pendingRetry || busy} className="space-y-5 min-w-0">
            {/* 1: room */}
            <section aria-labelledby="lastbox-room-title" className="space-y-2">
              <h3 id="lastbox-room-title" className="text-sm font-semibold text-gray-800">
                1. Hangi odada?
              </h3>
              {rooms === null ? (
                <p className="text-sm text-gray-500">Odalar yükleniyor...</p>
              ) : rooms.length === 0 ? (
                <Notice tone="warn">
                  Henüz oda tanımlı değil. Stok sorumlusu Stok › Ayarlar › Konumlar bölümünden oda ekleyebilir.
                </Notice>
              ) : showRooms ? (
                <div className="grid grid-cols-2 gap-2" role="group" aria-label="Oda seçin">
                  {rooms.map((r, i) => (
                    <button
                      key={r.id}
                      ref={i === 0 ? firstRoomRef : undefined}
                      type="button"
                      aria-pressed={r.id === roomId}
                      onClick={() => pickRoom(r.id)}
                      className={`min-h-[48px] px-3 py-2 rounded-lg border text-left ${
                        r.id === roomId
                          ? "border-blue-600 bg-blue-50 text-blue-900 font-semibold"
                          : "border-gray-300 hover:bg-gray-50"
                      }`}
                    >
                      <span className="block">{r.name}</span>
                      {r.kind !== "room" &&
                        !r.name.toLocaleLowerCase("tr-TR").includes(
                          (LOCATION_KIND_LABELS[r.kind as LocationKind] ?? r.kind).toLocaleLowerCase("tr-TR")
                        ) && (
                          <span className="block text-xs text-gray-600">
                            {LOCATION_KIND_LABELS[r.kind as LocationKind] ?? r.kind}
                          </span>
                        )}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3 p-3 rounded-lg border bg-gray-50">
                  <p className="min-w-0">
                    <span aria-hidden="true">📍 </span>
                    <span className="font-semibold">{room.name}</span>
                  </p>
                  <button
                    type="button"
                    className={textButton}
                    onClick={() => setRoomPicking(true)}
                    aria-label={`Odayı değiştir (şu an ${room.name})`}
                  >
                    Değiştir
                  </button>
                </div>
              )}
            </section>

            {/* 2: product */}
            <section aria-labelledby="lastbox-item-title" className="space-y-3">
              <h3 id="lastbox-item-title" className="text-sm font-semibold text-gray-800">
                2. Hangi ürün?
              </h3>
              {item ? (
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
                  <button type="button" className={textButton} onClick={clearItem}>
                    Başka ürün seç
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <button ref={scanButtonRef} type="button" className={bigPrimary} onClick={() => setScannerOpen(true)}>
                    📷 Barkodu kamerayla okut
                  </button>
                  <div className="border rounded-lg">
                    <button
                      type="button"
                      className="w-full text-left px-3 text-sm min-h-[48px]"
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
                        <button type="submit" className={touchSecondary}>
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
                    <UnknownBox
                      unknown={unknown}
                      canDefine={canManage && !!renderDefineItem}
                      reqName={reqName}
                      setReqName={setReqName}
                      reqNote={reqNote}
                      setReqNote={setReqNote}
                      reqBusy={reqBusy}
                      reqError={reqError}
                      reqResult={reqResult}
                      onDefine={() => setDefineGtin(unknown.scan.gtin)}
                      onSend={() => void sendProductRequest()}
                      onPickFromList={() => {
                        setUnknown(null);
                        setReqResult(null);
                      }}
                    />
                  )}
                  {itemLoading ? (
                    <p className="text-sm text-gray-500" role="status">
                      Ürün yükleniyor...
                    </p>
                  ) : (
                    !unknown && (
                      <div ref={pickerRef}>
                        <p className="text-sm font-semibold text-gray-800 mb-2">Barkod yoksa listeden seçin</p>
                        <ItemPicker loader={api.listItems} onPick={(row) => void chooseIfUsable(row)} />
                      </div>
                    )
                  )}
                </div>
              )}
            </section>

            {/* duplicate */}
            {item && room && existing && (
              <div role="alert" className="p-3 rounded border border-amber-300 bg-amber-50 text-amber-900 text-sm space-y-1">
                <p className="font-semibold">{lastBoxDuplicateText(existing.ref_no)}</p>
                <p>
                  {ROOM_REQUEST_STATUS_LABELS[existing.status] ?? existing.status} ·{" "}
                  {qtyLabel(Number(existing.quantity), existing.usage_unit, existing.purchase_unit, packFactor(existing))}
                  {existing.requested_by_name ? ` · ${existing.requested_by_name}` : ""} ·{" "}
                  {formatTimestamp(existing.created_at)}
                </p>
                <p>Yeni talep açılmaz; stok sorumlusu mevcut talebi görüyor.</p>
                <Link href={roomRequestsHref(room.id)} onClick={onClose} className={textButton}>
                  Açık talebi gör
                </Link>
              </div>
            )}

            {reloaded && (
              <div role="status">
                <Notice tone="warn">{reloaded}</Notice>
              </div>
            )}

            {checking && (
              <p role="status" className="text-sm text-gray-600">
                Açık talep kontrol ediliyor...
              </p>
            )}

            {/* 3: quantity and note */}
            {item && !existing && !checking && (
              <section aria-labelledby="lastbox-qty-title" className="space-y-3">
                <h3 id="lastbox-qty-title" className="text-sm font-semibold text-gray-800">
                  3. Ne kadar istensin?
                </h3>
                <div className="flex gap-2 items-stretch">
                  <input
                    className={`${stockInput} h-12`}
                    inputMode="decimal"
                    value={qtyText}
                    onChange={(e) => setQtyText(e.target.value)}
                    aria-label="Miktar"
                    aria-describedby="lastbox-qty-summary"
                  />
                  {pack ? (
                    <div className="flex rounded-lg border overflow-hidden shrink-0" role="group" aria-label="Birim">
                      {(["purchase", "usage"] as QuantityUnit[]).map((u) => (
                        <button
                          key={u}
                          type="button"
                          aria-pressed={unit === u}
                          onClick={() => setUnit(u)}
                          className={`px-3 min-w-[64px] min-h-[48px] ${unit === u ? "bg-blue-600 text-white" : "bg-white text-gray-800"}`}
                        >
                          {u === "purchase" ? item.purchase_unit : item.usage_unit}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span className="self-center px-3 py-2 rounded bg-gray-100 text-sm">{item.usage_unit}</span>
                  )}
                </div>
                <p id="lastbox-qty-summary" className="text-sm text-gray-700">
                  {qtySummary ? (
                    <>
                      Talep: <strong>{qtySummary}</strong>
                      {unit === "purchase" && qty > 0 && !Number.isInteger(qty)
                        ? ` (${conversionLine(qty, item.purchase_unit, item.usage_unit, factor)})`
                        : ""}
                    </>
                  ) : (
                    "Geçerli bir miktar girin."
                  )}
                </p>
                <Field label="Not" hint={`${note.trim().length} / ${NOTE_MAX}`}>
                  <textarea
                    className={stockInput}
                    rows={2}
                    maxLength={NOTE_MAX + 50}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </Field>
                <p className="text-xs text-gray-500">
                  Talep açılınca stok değişmez; stok sorumlusu malzemeyi ana depodan odaya teslim ettiğinde aktarılır.
                </p>
              </section>
            )}

            {localError && (
              <div role="alert" className="p-3 rounded bg-red-50 text-red-700 text-sm">
                {localError}
              </div>
            )}
          </fieldset>
          <StockErrorBox error={error} />
        </div>
      )}

      {scannerOpen && (
        <BarcodeScanner
          purpose="movement"
          onClose={() => {
            setScannerOpen(false);
            // Back on the sheet (no camera, or closed without a code): the scan button, with the list right below.
            window.setTimeout(() => scanButtonRef.current?.focus(), 0);
          }}
          onScan={(raw) => handleRaw(raw)}
        />
      )}
      {defineGtin !== null &&
        renderDefineItem?.({
          gtin: defineGtin,
          onCancel: () => setDefineGtin(null),
          onSaved: (saved) => {
            setDefineGtin(null);
            chooseIfUsable(saved);
          },
        })}
    </StockModal>
  );
}

function UnknownBox({
  unknown,
  canDefine,
  reqName,
  setReqName,
  reqNote,
  setReqNote,
  reqBusy,
  reqError,
  reqResult,
  onDefine,
  onSend,
  onPickFromList,
}: {
  unknown: UnknownScan;
  canDefine: boolean;
  reqName: string;
  setReqName: (v: string) => void;
  reqNote: string;
  setReqNote: (v: string) => void;
  reqBusy: boolean;
  reqError: StockError | null;
  reqResult: string | null;
  onDefine: () => void;
  onSend: () => void;
  /** Leave the barcode and choose the card from the list instead. */
  onPickFromList: () => void;
}) {
  const s = unknown.scan;
  return (
    <div className="p-3 rounded-lg border border-amber-300 bg-amber-50 space-y-3">
      <p className="font-semibold text-amber-900">Bu ürün henüz tanımlı değil</p>
      <p className="text-sm text-amber-900">
        Barkod: <span className="font-mono">{s.gtin}</span>
        {s.lot && ` · Lot ${s.lot}`}
        {s.serial && ` · Seri ${s.serial}`}
        {s.expiry && ` · SKT ${s.expiry}`}
      </p>
      {canDefine ? (
        <button type="button" className={bigPrimary} onClick={onDefine}>
          Yeni ürünü tanımla ve devam et
        </button>
      ) : unknown.pending && unknown.pending.status === "pending" ? (
        <div className="space-y-2" role="status">
          <p className="text-sm">{reqResult ?? "Bu barkod için tanımlama talebi stok sorumlusunda bekliyor."}</p>
          <Link href="/inventory/requests?tab=products" className={textButton}>
            Tanımlama talebini gör
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-amber-900">
            Kart olmadan oda talebi açılamaz. Ürünün adını yazıp tanımlama talebi bırakın; stok sorumlusu tanımlayınca
            oda talebini açabilirsiniz.
          </p>
          <Field label="Ambalajdaki ürün adı *">
            <input className={stockInput} value={reqName} maxLength={160} onChange={(e) => setReqName(e.target.value)} />
          </Field>
          <Field label="Not">
            <input className={stockInput} value={reqNote} maxLength={500} onChange={(e) => setReqNote(e.target.value)} />
          </Field>
          <StockErrorBox error={reqError} />
          <button type="button" className={bigPrimary} disabled={reqBusy || !reqName.trim()} onClick={onSend}>
            {reqBusy ? "Gönderiliyor..." : "Tanımlama talebi bırak"}
          </button>
        </div>
      )}
      <button type="button" className={textButton} onClick={onPickFromList}>
        Ürün listede varsa listeden seçin
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wired to the stock area
// ---------------------------------------------------------------------------

export interface LastBoxOpenOptions {
  /** Start with this card (card page, quick movement sheet). */
  itemId?: string;
  /** Start in this room (deep link, the room the usage was taken from). */
  locationId?: string;
  /** Product step once the room is known: camera at once ('scan') or the list's search box ('list'). */
  start?: LastBoxStart;
}

/**
 * The stock home's 'Son kutu' card: two big buttons, so the report is tap, scan, tap ('📷 Barkod okut' opens the
 * camera as soon as the room is known) or tap, pick, tap ('📋 Listeden seç' opens with the search box focused).
 */
export function LastBoxActionCard({ onStart }: { onStart: (start: LastBoxStart) => void }) {
  const button =
    "flex min-h-[64px] flex-col items-center justify-center gap-0.5 rounded-lg px-2 py-2 text-base font-semibold";
  return (
    <section
      aria-labelledby="lastbox-card-title"
      className="rounded-lg border-2 border-amber-400 bg-amber-50 p-4 text-amber-900 sm:flex sm:items-center sm:gap-4"
    >
      <div className="flex min-w-0 items-center gap-4 sm:flex-1">
        <span className="text-3xl" aria-hidden="true">
          📣
        </span>
        <div className="min-w-0">
          <h2 id="lastbox-card-title" className="text-lg font-semibold">
            {LAST_BOX_ACTION_LABEL}
          </h2>
          <p className="text-sm">Odada son kutuyu açtıysanız bildirin; ana depodan yenisi için talep açılır.</p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:mt-0 sm:w-80 sm:shrink-0">
        <button
          type="button"
          onClick={() => onStart("scan")}
          className={`${button} bg-amber-700 text-white hover:bg-amber-800`}
        >
          <span aria-hidden="true" className="text-xl leading-none">
            📷
          </span>
          <span>
            Barkod okut<span className="sr-only"> (son kutu bildir)</span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => onStart("list")}
          className={`${button} border-2 border-amber-600 bg-white text-amber-900 hover:bg-amber-100`}
        >
          <span aria-hidden="true" className="text-xl leading-none">
            📋
          </span>
          <span>
            Listeden seç<span className="sr-only"> (son kutu bildir)</span>
          </span>
        </button>
      </div>
    </section>
  );
}

export function LastBoxSheet({ options, onClose }: { options: LastBoxOpenOptions; onClose: () => void }) {
  const user = useAuthStore((state) => state.user);
  const { gates, notifyChanged } = useStock();
  const { locations, active } = useStockLocations();
  const rooms = useMemo(() => (locations === null ? null : requestRooms(active)), [locations, active]);
  const clinicId = user?.clinic_id ?? "";

  const defaultRoomId = useMemo(() => {
    if (!rooms) return "";
    const remembered = clinicId ? readString(lastBoxRoomKey(clinicId)) : "";
    const shift = user ? readString(STORAGE_KEYS.shiftRoom(user.user_id)) : "";
    return pickStartRoom(rooms, options.locationId || remembered, shift);
  }, [rooms, clinicId, user, options.locationId]);

  const renderDefineItem = useCallback(
    ({ gtin, onSaved, onCancel }: { gtin: string; onSaved: (item: LevelRow) => void; onCancel: () => void }) => (
      <StockModal title="Ürünü bir kez tanımlayın" onClose={onCancel} wide>
        <ItemForm
          initialGtin={gtin}
          canViewCosts={gates.cost}
          submitLabel="Ürünü oluştur ve talebe geç"
          onCancel={onCancel}
          onSaved={(saved) => {
            notifyChanged();
            onSaved(saved);
          }}
        />
      </StockModal>
    ),
    [gates.cost, notifyChanged]
  );

  return (
    <LastBoxSheetView
      api={liveLastBoxApi}
      rooms={rooms}
      defaultRoomId={defaultRoomId}
      initialItemId={options.itemId ?? null}
      start={options.itemId ? undefined : options.start}
      canManage={gates.mgr}
      onClose={onClose}
      onRoomChosen={(id) => {
        if (clinicId) writeString(lastBoxRoomKey(clinicId), id);
      }}
      onCreated={(request) => {
        // The room that was actually reported becomes this device's room, even when it came from the shift room.
        if (clinicId) writeString(lastBoxRoomKey(clinicId), request.location_id);
        notifyChanged();
        refreshMenuBadges();
      }}
      onProductRequested={notifyChanged}
      renderDefineItem={gates.mgr ? renderDefineItem : undefined}
    />
  );
}
