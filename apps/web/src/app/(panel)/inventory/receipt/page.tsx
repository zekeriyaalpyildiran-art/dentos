"use client";

// Bulk receipt (spec p7_rules_ui §20.7, contract §4.6): up to 20 lines collected with the quick movement sheet in
// cart mode, saved all-or-nothing by stock_bulk_receive. The cart and its operation key live in the tab's
// sessionStorage (lines can carry unit costs; cleared on sign-out), so a retry after a reload reuses the key.
// After an unanswered submit the cart is locked: only a retry with the same key, or a ledger check showing the key
// was never used, unlocks it, so an edited cart can never be saved a second time under a new key.

import { useCallback, useEffect, useState } from "react";
import { useAuthStore } from "@/lib/store";
import { BULK_MAX_LINES, bulkErrorRow, isCartState, toBulkLine, type CartLine, type CartState } from "@/lib/stock/cart";
import { movementOperationSaved, newKey, stockBulkReceive, toStockError, type StockError } from "@/lib/stock/rpc";
import { STORAGE_KEYS, readSessionJson, removeSessionKey, writeSessionJson } from "@/lib/stock/storage";
import { conversionLine, formatQty } from "@/lib/stock/units";
import { formatDay, formatTL } from "@/lib/finance";
import { useStock } from "@/components/stock/StockContext";
import { StockShell } from "@/components/stock/StockShell";
import {
  Card,
  EmptyState,
  LevelBadge,
  Notice,
  StockErrorBox,
  bigPrimary,
  buttonDanger,
  buttonSecondary,
} from "@/components/stock/ui";

const EMPTY: CartState = { operationKey: null, lines: [] };

export default function BulkReceiptPage() {
  const user = useAuthStore((state) => state.user);
  const { gates, openSheet, notifyChanged } = useStock();
  const [cart, setCart] = useState<CartState>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StockError | null>(null);
  const [errorRow, setErrorRow] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (!user || loaded) return;
    const saved = readSessionJson<unknown>(STORAGE_KEYS.cart(user.user_id));
    if (isCartState(saved)) {
      setCart({
        operationKey: saved.operationKey,
        lines: saved.lines.slice(0, BULK_MAX_LINES),
        pending: Boolean(saved.pending && saved.operationKey),
      });
    }
    setLoaded(true);
  }, [user, loaded]);

  useEffect(() => {
    if (!user || !loaded) return;
    if (cart.lines.length) writeSessionJson(STORAGE_KEYS.cart(user.user_id), cart);
    else removeSessionKey(STORAGE_KEYS.cart(user.user_id));
  }, [user, loaded, cart]);

  useEffect(() => {
    if (!cart.lines.length) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [cart.lines.length]);

  // Any change to the lines makes a new submission: the stored key is only reused for an unchanged cart. A cart
  // whose last submit is unresolved (pending) cannot change at all.
  const addLine = useCallback((line: CartLine) => {
    setCart((c) =>
      c.pending || c.lines.length >= BULK_MAX_LINES ? c : { operationKey: null, lines: [...c.lines, line] }
    );
    setMessage(null);
    setError(null);
    setErrorRow(null);
  }, []);

  const removeLine = (key: string) => {
    setCart((c) => (c.pending ? c : { operationKey: null, lines: c.lines.filter((l) => l.key !== key) }));
    setError(null);
    setErrorRow(null);
  };

  async function checkPending() {
    const key = cart.operationKey;
    if (!key) return;
    setBusy(true);
    setError(null);
    try {
      if (await movementOperationSaved(key)) {
        const n = cart.lines.length;
        setCart(EMPTY);
        setMessage(`Önceki deneme kaydedilmiş: ${n} satır stokta. Liste temizlendi.`);
        notifyChanged();
      } else {
        // Nothing was written under this key: the cart may be edited again (a later submit uses a new key).
        setCart((c) => ({ ...c, operationKey: null, pending: false }));
        setMessage("Önceki deneme kaydedilmemiş. Listeyi düzenleyip yeniden kaydedebilirsiniz.");
      }
    } catch (e) {
      setError(toStockError(e));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!cart.lines.length) return;
    const key = cart.operationKey ?? newKey();
    setCart((c) => ({ ...c, operationKey: key }));
    if (user) writeSessionJson(STORAGE_KEYS.cart(user.user_id), { ...cart, operationKey: key });
    setBusy(true);
    setError(null);
    setErrorRow(null);
    setMessage(null);
    try {
      const result = await stockBulkReceive({ p_operation_key: key, p_lines: cart.lines.map(toBulkLine) });
      const n = cart.lines.length;
      setCart(EMPTY);
      setMessage(`${result.already_saved ? "Bu liste daha önce kaydedilmişti. " : ""}${n} satır stoğa kaydedildi.`);
      notifyChanged();
    } catch (e) {
      const err = toStockError(e);
      if (err.network) {
        // No definitive answer: keep the key and lock the cart until a retry or a ledger check settles it.
        setCart((c) => ({ ...c, operationKey: key, pending: true }));
      } else if (err.key === "E_OP_KEY") {
        // The key was used before with other content: never mint a new key silently, check what was saved.
        let saved = false;
        try {
          saved = await movementOperationSaved(key);
        } catch {
          saved = false;
        }
        if (saved) {
          const n = cart.lines.length;
          setCart(EMPTY);
          setMessage(`Önceki deneme kaydedilmiş: ${n} satır stokta. Liste temizlendi; stok hareketlerini kontrol edin.`);
          notifyChanged();
          return;
        }
        setCart((c) => ({ ...c, operationKey: null, pending: false }));
      } else {
        // A definitive refusal ends the key's life (nothing was written under it).
        setCart((c) => ({ ...c, operationKey: null, pending: false }));
      }
      setError(err);
      setErrorRow(bulkErrorRow(err.message, err.detail));
    } finally {
      setBusy(false);
    }
  }

  if (!gates.op) {
    return (
      <StockShell title="Toplu mal kabul">
        <Notice tone="warn">Bu hesap stok kaydı oluşturamaz.</Notice>
      </StockShell>
    );
  }

  const full = cart.lines.length >= BULK_MAX_LINES;
  const locked = Boolean(cart.pending);

  return (
    <StockShell title="Toplu mal kabul" subtitle="Gelen ürünleri listeye ekleyin, kontrol edip tek seferde stoğa kaydedin.">
      <div className="space-y-4">
        {message && <Notice tone="success">{message}</Notice>}
        {locked && (
          <Notice tone="warn">
            <p>
              Son kayıt denemesi yanıt alamadı; liste kaydedilmiş olabilir. Liste kilitlendi: aynı listeyle tekrar
              deneyin veya kaydedilip kaydedilmediğini kontrol edin.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className={`${buttonSecondary} min-h-[44px]`} disabled={busy} onClick={() => void checkPending()}>
                Kaydedildi mi kontrol et
              </button>
            </div>
          </Notice>
        )}
        <section className="bg-white rounded-lg shadow border-2 border-blue-200 p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <h2 className="text-lg font-semibold">Mal kabul listesi · Henüz kaydedilmedi</h2>
            <span className={`text-sm tabular-nums ${full ? "text-red-700" : "text-gray-600"}`}>
              {cart.lines.length}/{BULK_MAX_LINES}
            </span>
          </div>
          {cart.lines.length === 0 ? (
            <EmptyState>Liste boş. Ürün okutarak veya listeden seçerek ekleyin.</EmptyState>
          ) : (
            <ol className="divide-y">
              {cart.lines.map((l, i) => (
                <li
                  key={l.key}
                  className={`py-3 flex flex-wrap items-start justify-between gap-3 ${errorRow === i + 1 ? "bg-red-50 -mx-2 px-2 rounded" : ""}`}
                >
                  <div className="min-w-0 text-sm space-y-0.5">
                    <p className="font-medium">
                      {i + 1}. {l.item_name} <LevelBadge level={l.tracking_level} />
                    </p>
                    <p>
                      {l.quantity_unit === "purchase"
                        ? conversionLine(l.quantity, l.purchase_unit, l.usage_unit, l.units_per_purchase)
                        : `${formatQty(l.quantity)} ${l.usage_unit}`}{" "}
                      → {l.to_location_name}
                    </p>
                    <p className="text-xs text-gray-600">
                      Lot {l.lot_number || "GENEL"}
                      {l.expiry_date ? ` · SKT ${formatDay(l.expiry_date)}` : ""}
                      {l.serial_number ? ` · Seri ${l.serial_number}` : ""}
                      {l.document_no ? ` · Belge ${l.document_no}` : ""}
                    </p>
                    {gates.cost && l.unit_cost_cents !== undefined && l.unit_cost_cents !== null && (
                      <p className="text-xs text-gray-600">
                        Birim maliyet {formatTL(l.unit_cost_cents)} / {l.cost_unit === "purchase" ? l.purchase_unit : l.usage_unit}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    className={`${buttonDanger} min-h-[44px]`}
                    disabled={busy || locked}
                    onClick={() => removeLine(l.key)}
                  >
                    Çıkar
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div className="mt-4 space-y-3">
            <StockErrorBox error={error} />
            {error?.key === "E_UNIT_CHANGED" && errorRow !== null && (
              <p className="text-sm text-red-700">
                İşaretli satırı çıkarıp ürünü yeniden ekleyin; kartın kutu / adet dönüşümü değişti.
              </p>
            )}
            <div className="flex flex-col sm:flex-row gap-2">
              <button
                type="button"
                className={`${buttonSecondary} h-12`}
                disabled={busy || full || locked}
                onClick={() => openSheet({ type: "receive", onAddToCart: addLine })}
              >
                Başka ürün okut / ekle
              </button>
              <button type="button" className={bigPrimary} disabled={busy || !cart.lines.length} onClick={() => void submit()}>
                {busy ? "Kaydediliyor..." : locked ? "Aynı listeyle tekrar dene" : "Listeyi onayla ve stoğa kaydet"}
              </button>
            </div>
            {cart.lines.length > 0 &&
              !locked &&
              (confirmClear ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span>Liste silinsin mi? Stok değişmez.</span>
                  <button
                    type="button"
                    className={`${buttonDanger} min-h-[44px]`}
                    onClick={() => {
                      setCart(EMPTY);
                      setConfirmClear(false);
                      setError(null);
                    }}
                  >
                    Evet, temizle
                  </button>
                  <button type="button" className={`${buttonSecondary} min-h-[44px]`} onClick={() => setConfirmClear(false)}>
                    Vazgeç
                  </button>
                </div>
              ) : (
                <button type="button" className="text-sm text-red-700 hover:underline min-h-[44px]" onClick={() => setConfirmClear(true)}>
                  Listeyi temizle
                </button>
              ))}
          </div>
        </section>
        <Card>
          <p className="text-sm text-gray-700">
            Listedeki satırların hepsi birlikte kaydedilir; bir satır hatalıysa hiçbiri kaydedilmez ve hatalı satır işaretlenir.
            Liste bu sekmede saklanır; sekme kapanınca veya çıkış yapınca silinir.
          </p>
          <p className="text-sm text-gray-500 mt-2">Siparişe bağlı teslimatlar ileride sipariş ekranından kabul edilecek.</p>
        </Card>
      </div>
    </StockShell>
  );
}
