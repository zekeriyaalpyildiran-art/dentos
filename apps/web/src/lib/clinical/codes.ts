// Phase 9 clinical codes (spec p9_clinical §1.4). ASCII codes in the database, Turkish labels in the UI.

export const IMPLANT_STATUSES = ["healing", "prosthetic", "completed", "follow_up", "failed"] as const;
export type ImplantStatus = (typeof IMPLANT_STATUSES)[number];

/** Legacy labels (CR:7). */
export const IMPLANT_STATUS_LABELS: Record<ImplantStatus, string> = {
  healing: "İyileşme döneminde",
  prosthetic: "Protez aşamasında",
  completed: "Tamamlandı",
  follow_up: "Takipte",
  failed: "Başarısız / çıkarıldı",
};

export const IMPLANT_STATUS_STYLES: Record<ImplantStatus, string> = {
  healing: "bg-amber-100 text-amber-800",
  prosthetic: "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
  follow_up: "bg-purple-100 text-purple-800",
  failed: "bg-gray-200 text-gray-700",
};

/** Statuses that count for "Kontrol tarihi gelen" (§1.5, CW:33). */
export const CONTROL_DUE_STATUSES: readonly ImplantStatus[] = ["healing", "prosthetic", "follow_up"];

export function isImplantStatus(value: unknown): value is ImplantStatus {
  return typeof value === "string" && (IMPLANT_STATUSES as readonly string[]).includes(value);
}

export const STOCK_SOURCES = ["stock", "external"] as const;
export type StockSource = (typeof STOCK_SOURCES)[number];

export const STOCK_SOURCE_LABELS: Record<StockSource, string> = {
  stock: "Stoktan düşüldü",
  external: "Stok dışı",
};

export type ImplantStockState = "issued" | "correction_pending" | "corrected" | "returned";

export const STOCK_STATE_LABELS: Record<ImplantStockState, string> = {
  issued: "Stoktan düşüldü",
  correction_pending: "Düzeltme bekliyor",
  corrected: "Stok düzeltildi",
  returned: "Stoğa iade",
};

export const LAB_STATUSES = [
  "draft",
  "submitted",
  "in_progress",
  "try_in",
  "revision",
  "ready",
  "delivered",
  "cancelled",
] as const;
export type LabStatus = (typeof LAB_STATUSES)[number];

/** Labels match legacy where it has the status (CR:6). */
export const LAB_STATUS_LABELS: Record<LabStatus, string> = {
  draft: "Taslak",
  submitted: "Gönderildi",
  in_progress: "Laboratuvarda",
  try_in: "Provada",
  revision: "Revizyonda",
  ready: "Kliniğe geldi",
  delivered: "Hastaya teslim",
  cancelled: "İptal",
};

export const LAB_STATUS_STYLES: Record<LabStatus, string> = {
  draft: "bg-gray-100 text-gray-800",
  submitted: "bg-blue-100 text-blue-800",
  in_progress: "bg-indigo-100 text-indigo-800",
  try_in: "bg-purple-100 text-purple-800",
  revision: "bg-amber-100 text-amber-800",
  ready: "bg-teal-100 text-teal-800",
  delivered: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
};

export function isLabStatus(value: unknown): value is LabStatus {
  return typeof value === "string" && (LAB_STATUSES as readonly string[]).includes(value);
}

export const LAB_ITEM_TYPES = [
  { value: "crown", label: "Kron" },
  { value: "bridge", label: "Köprü" },
  { value: "denture", label: "Protez" },
  { value: "implant_crown", label: "İmplant Kronu" },
  { value: "other", label: "Diğer" },
] as const;
export type LabItemType = (typeof LAB_ITEM_TYPES)[number]["value"];

export const LAB_ITEM_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  LAB_ITEM_TYPES.map((t) => [t.value, t.label])
);

export const LAB_MATERIALS = [
  { value: "zirconium", label: "Zirkonyum" },
  { value: "ceramic", label: "Seramik" },
  { value: "composite", label: "Kompozit" },
  { value: "metal", label: "Metal" },
] as const;

export const LAB_MATERIAL_LABELS: Record<string, string> = Object.fromEntries(
  LAB_MATERIALS.map((m) => [m.value, m.label])
);

export type LabPayableState = "off" | "awaiting_finance" | "posted";

/** Helper shown under every free-text field (SA:1860 wording; KVKK). */
export const NO_PATIENT_TEXT_HINT = "Hasta adı veya T.C. kimlik numarası yazmayın.";

/** Field limits mirrored from the server (CR:15, §3). */
export const LIMITS = {
  model: 150,
  notes: 4000,
  lotText: 60,
  sourceNoteMin: 3,
  sourceNoteMax: 200,
  reasonMin: 3,
  reasonMax: 500,
  brandName: 80,
  labName: 120,
  labPhone: 30,
  labEmail: 120,
  labNote: 500,
  labItemDescription: 500,
  labItemTooth: 60,
  labItemColor: 20,
  labItemsMax: 30,
  labEventNote: 500,
  costNote: 500,
  /** 10.000.000 TL in cents. */
  costMaxCents: 1_000_000_000,
} as const;
