"use client";

// İmplant markaları (spec p9_clinical §7.4): directory; brands are deactivated, never deleted.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuthStore } from "@/lib/store";
import {
  ClinicalError,
  NO_FLAGS,
  clinSaveImplantBrand,
  clinSettings,
  countImplantsByBrand,
  listBrands,
  newKey,
  toClinicalError,
  type BrandRow,
  type ClinicalFlags,
} from "@/lib/clinical/rpc";
import { LIMITS } from "@/lib/clinical/codes";
import {
  ClinicalNotice,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  SAVING_LABEL,
  Sheet,
  Toast,
  clinInput,
  clinPrimary,
  clinSecondary,
} from "@/components/clinical/ui";

function BrandDialog({ brand, onClose, onSaved }: { brand: BrandRow | null; onClose: () => void; onSaved: (b: BrandRow) => void }) {
  const [name, setName] = useState(brand?.name ?? "");
  const [active, setActive] = useState(brand?.is_active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClinicalError | null>(null);
  const key = useRef(brand?.id ?? newKey());

  const submit = async () => {
    const n = name.trim();
    if (n.length < 1 || n.length > LIMITS.brandName) {
      setError(new ClinicalError("Marka adı 1–80 karakter olmalı.", null, null, null));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await clinSaveImplantBrand({
        p_id: key.current,
        p_version: brand ? brand.version : null,
        p_name: n,
        p_is_active: active,
      });
      onSaved(r.brand);
    } catch (err) {
      setError(toClinicalError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={brand ? "Markayı düzenle" : "Marka ekle"}
      onClose={onClose}
      busy={busy}
      footer={
        <div className="space-y-2">
          <ErrorBox error={error} />
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button type="button" className={clinSecondary} onClick={onClose} disabled={busy}>
              Vazgeç
            </button>
            <button type="button" className={clinPrimary} onClick={() => void submit()} disabled={busy}>
              {busy ? SAVING_LABEL : "Kaydet"}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Marka adı" required>
          <input className={clinInput} value={name} maxLength={LIMITS.brandName} disabled={busy} onChange={(e) => setName(e.target.value)} />
        </Field>
        <label className="inline-flex items-center gap-2 min-h-[44px]">
          <input type="checkbox" className="h-5 w-5" checked={active} disabled={busy} onChange={(e) => setActive(e.target.checked)} />
          Etkin (yeni kayıtlarda seçilebilir)
        </label>
      </div>
    </Sheet>
  );
}

export default function BrandsPage() {
  const user = useAuthStore((s) => s.user);
  const [brands, setBrands] = useState<BrandRow[]>([]);
  const [counts, setCounts] = useState<Map<string, number> | null>(null);
  const [flags, setFlags] = useState<ClinicalFlags>(NO_FLAGS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClinicalError | null>(null);
  const [rowError, setRowError] = useState<ClinicalError | null>(null);
  const [editing, setEditing] = useState<BrandRow | "new" | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [settings, list] = await Promise.all([clinSettings(), listBrands()]);
      setFlags(settings.flags ?? NO_FLAGS);
      setBrands(list);
      setError(null);
      countImplantsByBrand()
        .then(setCounts)
        .catch(() => setCounts(null));
    } catch (err) {
      setError(toClinicalError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user?.clinic_id) void load();
  }, [load, user?.clinic_id]);

  const toggle = async (b: BrandRow) => {
    setTogglingId(b.id);
    setRowError(null);
    try {
      const r = await clinSaveImplantBrand({ p_id: b.id, p_version: b.version, p_name: b.name, p_is_active: !b.is_active });
      setBrands((prev) => prev.map((x) => (x.id === b.id ? { ...x, ...r.brand } : x)));
    } catch (err) {
      setRowError(toClinicalError(err));
    } finally {
      setTogglingId(null);
    }
  };

  return (
    <div className="p-4 md:p-8 space-y-6 text-gray-900 max-w-4xl">
      <Link href="/clinical/implants" className="text-blue-700 hover:underline text-sm">
        ← İmplant takibi
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">İmplant markaları</h1>
          <p className="text-sm text-gray-600 mt-1">
            Kayıtlarda kullanılan marka silinmez, pasif yapılır. Pasif marka yeni kayıtta seçilemez.
          </p>
        </div>
        {flags.can_write && (
          <button type="button" className={clinPrimary} onClick={() => setEditing("new")}>
            Marka ekle
          </button>
        )}
      </div>

      <ClinicalNotice error={error} />
      <ErrorBox error={rowError} onReload={() => void load()} />

      {loading ? (
        <Loading />
      ) : brands.length === 0 && !error ? (
        <EmptyState title="Henüz implant markası yok">
          {flags.can_write ? "“Marka ekle” ile ilk markayı tanımlayın." : null}
        </EmptyState>
      ) : (
        <ul className="bg-white rounded-lg shadow divide-y">
          {brands.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="flex-1 min-w-[10rem]">
                <div className={`font-semibold ${b.is_active ? "" : "text-gray-500"}`}>
                  {b.name}
                  {!b.is_active && <span className="font-normal"> (pasif)</span>}
                </div>
                {counts && <div className="text-xs text-gray-600">{counts.get(b.id) ?? 0} implant</div>}
              </div>
              {flags.can_write ? (
                <>
                  <label className="inline-flex items-center gap-2 min-h-[44px] text-sm">
                    <input
                      type="checkbox"
                      className="h-5 w-5"
                      checked={b.is_active}
                      disabled={togglingId === b.id}
                      onChange={() => void toggle(b)}
                    />
                    Etkin
                  </label>
                  <button type="button" className={clinSecondary} onClick={() => setEditing(b)}>
                    Düzenle
                  </button>
                </>
              ) : (
                <span className="text-sm text-gray-600">{b.is_active ? "Etkin" : "Pasif"}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <BrandDialog
          brand={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(b) => {
            setEditing(null);
            setToast("Marka kaydedildi.");
            setBrands((prev) =>
              [...prev.filter((x) => x.id !== b.id), b].sort((x, y) => x.name.localeCompare(y.name, "tr"))
            );
          }}
        />
      )}
      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}
