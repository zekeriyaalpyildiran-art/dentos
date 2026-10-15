"use client";

// Stock settings (spec p7_rules_ui §20.12, contract §4.13-4.14): locations and suppliers. Managers only.

import Link from "next/link";
import { useRef, useState } from "react";
import { LOCATION_KINDS, LOCATION_KIND_LABELS, SUGGESTED_LOCATIONS, type LocationKind } from "@/lib/stock/codes";
import {
  newKey,
  stockSaveLocation,
  stockSaveSupplier,
  toStockError,
  type LocationJson,
  type StockError,
  type SupplierJson,
} from "@/lib/stock/rpc";
import { useStock } from "@/components/stock/StockContext";
import { StockShell } from "@/components/stock/StockShell";
import { useStockChairs, useStockLocations, useStockSuppliers } from "@/components/stock/useStockRefs";
import {
  Badge,
  Card,
  EmptyState,
  Field,
  Loading,
  Notice,
  StockErrorBox,
  StockModal,
  bigPrimary,
  buttonPrimary,
  buttonSecondary,
  stockInput,
} from "@/components/stock/ui";

/** Locale-aware key, close to the database's Turkish-folded name_key. */
const nameKey = (s: string) => s.trim().toLocaleLowerCase("tr-TR");

export default function StockSettingsPage() {
  const { gates, notifyChanged } = useStock();
  const loc = useStockLocations();
  const sup = useStockSuppliers();
  const chairs = useStockChairs(gates.mgr);
  const [editLocation, setEditLocation] = useState<LocationJson | "new" | null>(null);
  const [editSupplier, setEditSupplier] = useState<SupplierJson | "new" | null>(null);
  const [error, setError] = useState<StockError | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toggleKey = useRef<Record<string, string>>({});

  if (!gates.mgr) {
    return (
      <StockShell title="Stok ayarları">
        <Notice tone="warn">Bu işlem için stok yönetim yetkisi gerekir.</Notice>
      </StockShell>
    );
  }

  const locations = loc.locations;
  const existing = new Set((locations || []).map((l) => nameKey(l.name)));
  const missing = SUGGESTED_LOCATIONS.filter((s) => !existing.has(nameKey(s.name)));

  const keyFor = (id: string) => (toggleKey.current[id] ??= newKey());

  async function quickSaveLocation(l: LocationJson, patch: Partial<LocationJson>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await stockSaveLocation({ p_operation_key: keyFor(l.id), p_id: l.id, p_version: l.version, p_location: patch });
      delete toggleKey.current[l.id];
      loc.reload();
      notifyChanged();
    } catch (e) {
      const err = toStockError(e);
      delete toggleKey.current[l.id];
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function addSuggested() {
    setBusy(true);
    setError(null);
    setMessage(null);
    let added = 0;
    try {
      const maxSort = Math.max(0, ...(locations || []).map((l) => l.sort_order));
      for (const [i, s] of missing.entries()) {
        await stockSaveLocation({
          p_operation_key: newKey(),
          p_id: newKey(),
          p_version: null,
          p_location: { name: s.name, kind: s.kind, sort_order: Math.min(9999, maxSort + 10 * (i + 1)) },
        });
        added++;
      }
      setMessage(`${added} konum eklendi.`);
    } catch (e) {
      setError(toStockError(e));
      if (added) setMessage(`${added} konum eklendi; kalanlar eklenemedi.`);
    } finally {
      setBusy(false);
      loc.reload();
      notifyChanged();
    }
  }

  async function toggleSupplier(s: SupplierJson) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await stockSaveSupplier({
        p_operation_key: keyFor(s.id),
        p_id: s.id,
        p_version: s.version,
        p_supplier: { is_active: !s.is_active },
      });
      delete toggleKey.current[s.id];
      sup.reload();
    } catch (e) {
      delete toggleKey.current[s.id];
      setError(toStockError(e));
    } finally {
      setBusy(false);
    }
  }

  const sorted = [...(locations || [])].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "tr"));

  async function move(l: LocationJson, dir: -1 | 1) {
    const i = sorted.findIndex((x) => x.id === l.id);
    const other = sorted[i + dir];
    if (!other) return;
    // One write: place this row just past its neighbour (names break remaining ties).
    const target = other.sort_order + dir;
    await quickSaveLocation(l, { sort_order: Math.max(0, Math.min(9999, target)) });
  }

  return (
    <StockShell title="Stok ayarları" subtitle="Konumlar ve tedarikçiler.">
      <div className="space-y-6">
        {message && <Notice tone="success">{message}</Notice>}
        <StockErrorBox
          error={error}
          onReload={() => {
            setError(null);
            loc.reload();
            sup.reload();
          }}
        />

        <Card
          title="Konumlar"
          actions={
            <button type="button" className={`${buttonPrimary} min-h-[44px]`} onClick={() => setEditLocation("new")}>
              Yeni konum
            </button>
          }
        >
          {locations === null ? (
            <Loading />
          ) : (
            <>
              {missing.length > 0 && (
                <button
                  type="button"
                  className={`${buttonSecondary} mb-4 min-h-[44px]`}
                  disabled={busy}
                  onClick={() => void addSuggested()}
                >
                  Önerilen konumları ekle (Oda 1–6, Sterilizasyon)
                </button>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b text-left text-gray-700">
                    <tr>
                      <th className="px-3 py-2">Sıra</th>
                      <th className="px-3 py-2">Ad</th>
                      <th className="px-3 py-2">Tür</th>
                      <th className="px-3 py-2">Koltuk</th>
                      <th className="px-3 py-2">Durum</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((l, i) => (
                      <tr key={l.id} className="border-b">
                        <td className="px-3 py-2 whitespace-nowrap">
                          <button
                            type="button"
                            aria-label="Yukarı taşı"
                            className="px-2 min-h-[36px] disabled:opacity-30"
                            disabled={busy || i === 0}
                            onClick={() => void move(l, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            aria-label="Aşağı taşı"
                            className="px-2 min-h-[36px] disabled:opacity-30"
                            disabled={busy || i === sorted.length - 1}
                            onClick={() => void move(l, 1)}
                          >
                            ↓
                          </button>
                        </td>
                        <td className="px-3 py-2">
                          {l.name}
                          {l.is_default_warehouse && <Badge className="ml-2 bg-blue-100 text-blue-800">★ Ana depo</Badge>}
                        </td>
                        <td className="px-3 py-2">{LOCATION_KIND_LABELS[l.kind] ?? l.kind}</td>
                        <td className="px-3 py-2">{(chairs || []).find((c) => c.id === l.chair_id)?.name ?? "—"}</td>
                        <td className="px-3 py-2">
                          {l.is_active ? (
                            <Badge className="bg-green-100 text-green-800">Aktif</Badge>
                          ) : (
                            <Badge className="bg-gray-200 text-gray-700">Pasif</Badge>
                          )}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <button type="button" className="text-blue-700 hover:underline mr-3" onClick={() => setEditLocation(l)}>
                            Düzenle
                          </button>
                          {!l.is_default_warehouse && (
                            <button
                              type="button"
                              className="text-blue-700 hover:underline disabled:text-gray-400"
                              disabled={busy}
                              onClick={() => void quickSaveLocation(l, { is_active: !l.is_active })}
                            >
                              {l.is_active ? "Pasif yap" : "Etkinleştir"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>

        <Card
          title="Tedarikçiler"
          actions={
            <button type="button" className={`${buttonPrimary} min-h-[44px]`} onClick={() => setEditSupplier("new")}>
              Yeni tedarikçi
            </button>
          }
        >
          {sup.suppliers === null ? (
            <Loading />
          ) : sup.suppliers.length === 0 ? (
            <EmptyState>Henüz tedarikçi yok.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b text-left text-gray-700">
                  <tr>
                    <th className="px-3 py-2">Ad</th>
                    <th className="px-3 py-2">Telefon</th>
                    <th className="px-3 py-2">E-posta</th>
                    <th className="px-3 py-2">Vergi no</th>
                    <th className="px-3 py-2">Durum</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {sup.suppliers.map((s) => (
                    <tr key={s.id} className="border-b">
                      <td className="px-3 py-2">
                        {s.name}
                        {s.note && <div className="text-xs text-gray-500">{s.note}</div>}
                      </td>
                      <td className="px-3 py-2">{s.phone || "—"}</td>
                      <td className="px-3 py-2">{s.email || "—"}</td>
                      <td className="px-3 py-2">{s.tax_no || "—"}</td>
                      <td className="px-3 py-2">
                        {s.is_active ? (
                          <Badge className="bg-green-100 text-green-800">Aktif</Badge>
                        ) : (
                          <Badge className="bg-gray-200 text-gray-700">Pasif</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <button type="button" className="text-blue-700 hover:underline mr-3" onClick={() => setEditSupplier(s)}>
                          Düzenle
                        </button>
                        <button
                          type="button"
                          className="text-blue-700 hover:underline disabled:text-gray-400"
                          disabled={busy}
                          onClick={() => void toggleSupplier(s)}
                        >
                          {s.is_active ? "Pasif yap" : "Etkinleştir"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Yetkiler">
          <ul className="text-sm space-y-1 list-disc pl-5">
            <li>Stok hareketi (mal kabul, kullanım, transfer, fire): sahip, yönetici, hekim, asistan ve &quot;Stok yönetimi&quot; yetkisi olanlar.</li>
            <li>Resepsiyon listeleri görür, hareket kaydedemez.</li>
            <li>Kart, konum, tedarikçi, sayım, düzeltme onayı ve kullanım iadesi: sahip veya &quot;Stok yönetimi&quot; yetkisi olanlar.</li>
            <li>Maliyet ve stok değeri: sahip, &quot;Stok maliyetlerini görme&quot; veya &quot;Finans&quot; yetkisi olanlar.</li>
            <li>
              &quot;Stok yönetimi&quot; yetkisini yalnızca klinik sahibi, &quot;Stok maliyetlerini görme&quot; yetkisini sahip veya
              Finans yetkilisi verebilir.
            </li>
          </ul>
          <Link href="/settings" className="inline-block mt-3 text-blue-700 hover:underline">
            Yetkileri ayarlardan verin →
          </Link>
        </Card>
      </div>

      {editLocation && (
        <LocationDialog
          location={editLocation === "new" ? null : editLocation}
          chairs={chairs}
          nextSort={Math.min(9999, Math.max(0, ...(locations || []).map((l) => l.sort_order)) + 10)}
          onClose={() => setEditLocation(null)}
          onSaved={() => {
            setEditLocation(null);
            loc.reload();
            notifyChanged();
          }}
        />
      )}
      {editSupplier && (
        <SupplierDialog
          supplier={editSupplier === "new" ? null : editSupplier}
          onClose={() => setEditSupplier(null)}
          onSaved={() => {
            setEditSupplier(null);
            sup.reload();
          }}
        />
      )}
    </StockShell>
  );
}

function LocationDialog({
  location,
  chairs,
  nextSort,
  onClose,
  onSaved,
}: {
  location: LocationJson | null;
  chairs: { id: string; name: string }[] | null;
  nextSort: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(location?.name ?? "");
  const [kind, setKind] = useState<LocationKind>(location?.kind ?? "room");
  const [chairId, setChairId] = useState(location?.chair_id ?? "");
  const [isDefault, setIsDefault] = useState(location?.is_default_warehouse ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StockError | null>(null);
  const opKey = useRef(newKey());
  const id = useRef(location?.id ?? newKey());

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const patch: Parameters<typeof stockSaveLocation>[0]["p_location"] = {
        name: name.trim(),
        kind,
        chair_id: chairId || null,
      };
      if (!location) patch.sort_order = nextSort;
      if (!location?.is_default_warehouse && isDefault) patch.is_default_warehouse = true;
      await stockSaveLocation({
        p_operation_key: opKey.current,
        p_id: id.current,
        p_version: location?.version ?? null,
        p_location: patch,
      });
      onSaved();
    } catch (e) {
      const err = toStockError(e);
      if (err.key === "E_OP_KEY") opKey.current = newKey();
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <StockModal
      title={location ? "Konumu düzenle" : "Yeni konum"}
      onClose={onClose}
      busy={busy}
      footer={
        <button type="button" className={bigPrimary} disabled={busy || !name.trim()} onClick={() => void submit()}>
          {busy ? "Kaydediliyor..." : "Kaydet"}
        </button>
      }
    >
      <div className="space-y-3">
        <Field label="Ad *">
          <input className={stockInput} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Tür">
          <select
            className={stockInput}
            value={kind}
            disabled={location?.is_default_warehouse}
            onChange={(e) => setKind(e.target.value as LocationKind)}
          >
            {LOCATION_KINDS.map((k) => (
              <option key={k} value={k}>
                {LOCATION_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Bağlı koltuk (isteğe bağlı)">
          <select className={stockInput} value={chairId} onChange={(e) => setChairId(e.target.value)}>
            <option value="">—</option>
            {(chairs || []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        {location?.is_default_warehouse ? (
          <p className="text-sm text-gray-600">
            Bu konum ana depodur. Ana depo pasif yapılamaz; önce başka bir depoyu ana depo yapın.
          </p>
        ) : (
          kind === "warehouse" &&
          (location ? location.is_active : true) && (
            <label className="flex items-center gap-2 text-sm min-h-[44px]">
              <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
              Ana depo yap (mal kabulde varsayılan konum)
            </label>
          )
        )}
        <StockErrorBox error={error} />
      </div>
    </StockModal>
  );
}

function SupplierDialog({
  supplier,
  onClose,
  onSaved,
}: {
  supplier: SupplierJson | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(supplier?.name ?? "");
  const [phone, setPhone] = useState(supplier?.phone ?? "");
  const [email, setEmail] = useState(supplier?.email ?? "");
  const [taxNo, setTaxNo] = useState(supplier?.tax_no ?? "");
  const [note, setNote] = useState(supplier?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StockError | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const opKey = useRef(newKey());
  const id = useRef(supplier?.id ?? newKey());

  async function submit() {
    setLocalError(null);
    if (email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      setLocalError("Telefon, e-posta, vergi no ve not alanlarını kontrol edin.");
      return;
    }
    if (!/^[0-9]{0,11}$/.test(taxNo.trim())) {
      setLocalError("Vergi numarası en fazla 11 rakam olabilir.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await stockSaveSupplier({
        p_operation_key: opKey.current,
        p_id: id.current,
        p_version: supplier?.version ?? null,
        p_supplier: {
          name: name.trim(),
          phone: phone.trim(),
          email: email.trim(),
          tax_no: taxNo.trim(),
          note: note.trim(),
        },
      });
      onSaved();
    } catch (e) {
      const err = toStockError(e);
      if (err.key === "E_OP_KEY") opKey.current = newKey();
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <StockModal
      title={supplier ? "Tedarikçiyi düzenle" : "Yeni tedarikçi"}
      onClose={onClose}
      busy={busy}
      footer={
        <button type="button" className={bigPrimary} disabled={busy || !name.trim()} onClick={() => void submit()}>
          {busy ? "Kaydediliyor..." : "Kaydet"}
        </button>
      }
    >
      <div className="space-y-3">
        <Field label="Ad *">
          <input className={stockInput} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Telefon">
            <input className={stockInput} value={phone} maxLength={40} inputMode="tel" onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <Field label="E-posta">
            <input className={stockInput} value={email} maxLength={200} inputMode="email" onChange={(e) => setEmail(e.target.value)} />
          </Field>
        </div>
        <Field label="Vergi no">
          <input className={stockInput} value={taxNo} maxLength={11} inputMode="numeric" onChange={(e) => setTaxNo(e.target.value)} />
        </Field>
        <Field label="Not">
          <textarea className={stockInput} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {localError && (
          <div role="alert" className="p-3 rounded bg-red-50 text-red-700 text-sm">
            {localError}
          </div>
        )}
        <StockErrorBox error={error} />
      </div>
    </StockModal>
  );
}
