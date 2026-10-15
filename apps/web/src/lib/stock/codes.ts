// Phase 7 stock code lists (ASCII in the database, Turkish labels in the UI). Spec p7_db_contract §1.6,
// p7_rules_ui §0.3.

export type TrackingLevel = "A" | "B" | "C";
export const TRACKING_LEVELS: TrackingLevel[] = ["A", "B", "C"];

export const TRACKING_INFO: Record<
  TrackingLevel,
  { label: string; short: string; choice: string; description: string; badge: string }
> = {
  A: {
    label: "Tekil / yüksek değer",
    short: "A Tekil",
    choice: "Hasta + lot / seri",
    description: "Hasta, lot ve gerektiğinde seri numarasıyla izlenir.",
    badge: "bg-purple-100 text-purple-800",
  },
  B: {
    label: "Lot ve SKT",
    short: "B Lot ve SKT",
    choice: "Lot + son kullanma tarihi",
    description: "Parti ve son kullanma tarihi öncelikli izlenir.",
    badge: "bg-sky-100 text-sky-800",
  },
  C: {
    label: "Hızlı sarf",
    short: "C Hızlı sarf",
    choice: "Kutu / adet ile sarf",
    description: "Kutu/paket ve kritik sipariş eşiğiyle izlenir.",
    badge: "bg-gray-100 text-gray-700",
  },
};

export type MovementType =
  | "opening"
  | "receive"
  | "issue"
  | "transfer"
  | "waste"
  | "return"
  | "adjust_in"
  | "adjust_out"
  | "correction_reversal";

export const MOVEMENT_TYPES: MovementType[] = [
  "opening",
  "receive",
  "issue",
  "transfer",
  "waste",
  "return",
  "adjust_in",
  "adjust_out",
  "correction_reversal",
];

export const MOVEMENT_LABELS: Record<MovementType, string> = {
  opening: "Açılış bakiyesi",
  receive: "Mal kabul",
  issue: "Kullanım",
  transfer: "Transfer",
  waste: "Fire / SKT",
  return: "Kullanım iadesi",
  adjust_in: "Sayım artı",
  adjust_out: "Sayım eksi",
  correction_reversal: "Düzeltme geri kaydı",
};

export const MOVEMENT_STYLES: Record<MovementType, string> = {
  opening: "bg-gray-100 text-gray-700",
  receive: "bg-green-100 text-green-800",
  issue: "bg-blue-100 text-blue-800",
  transfer: "bg-indigo-100 text-indigo-800",
  waste: "bg-red-100 text-red-700",
  return: "bg-teal-100 text-teal-800",
  adjust_in: "bg-amber-100 text-amber-800",
  adjust_out: "bg-amber-100 text-amber-800",
  correction_reversal: "bg-gray-200 text-gray-700",
};

export function movementLabel(type: string): string {
  return MOVEMENT_LABELS[type as MovementType] ?? type;
}

/** Types a correction can be requested for (contract §4.8). */
export const CORRECTABLE_TYPES: MovementType[] = ["opening", "receive", "issue", "transfer", "waste"];

/** Source / target labels in history rows (p7_rules_ui §15). */
export function movementSource(type: string, fromName: string | null): string {
  if (fromName) return fromName;
  if (type === "return") return "Önceki kullanım";
  if (type === "opening") return "Açılış";
  if (type === "adjust_in") return "Sayım";
  return "Stok girişi";
}

export function movementTarget(type: string, toName: string | null): string {
  if (toName) return toName;
  if (type === "waste") return "Fire / SKT";
  if (type === "adjust_out") return "Sayım farkı";
  return "Kullanım";
}

export type LocationKind = "warehouse" | "room" | "sterilization";
export const LOCATION_KINDS: LocationKind[] = ["warehouse", "room", "sterilization"];
export const LOCATION_KIND_LABELS: Record<LocationKind, string> = {
  warehouse: "Depo",
  room: "Oda",
  sterilization: "Sterilizasyon",
};

export const ABC_CLASSES = ["", "A", "B", "C"] as const;
export type AbcClass = (typeof ABC_CLASSES)[number];

export const ORDER_POLICIES = ["", "auto_minmax", "weekly", "case"] as const;
export type OrderPolicy = (typeof ORDER_POLICIES)[number];
export const ORDER_POLICY_LABELS: Record<OrderPolicy, string> = {
  "": "–",
  auto_minmax: "Otomatik MIN–MAX",
  weekly: "Haftalık kontrol",
  case: "Vaka bazlı",
};

export type CorrectionStatus = "pending" | "approved" | "rejected";
export const CORRECTION_STATUS_LABELS: Record<CorrectionStatus, string> = {
  pending: "Bekliyor",
  approved: "Onaylandı",
  rejected: "Reddedildi",
};
export const CORRECTION_STATUS_STYLES: Record<CorrectionStatus, string> = {
  pending: "bg-amber-100 text-amber-800",
  approved: "bg-green-100 text-green-800",
  rejected: "bg-gray-200 text-gray-700",
};

export type ProductRequestStatus = "pending" | "resolved" | "rejected";
export const PRODUCT_REQUEST_STATUS_LABELS: Record<ProductRequestStatus, string> = {
  pending: "Tanımlama bekliyor",
  resolved: "Tanımlandı",
  rejected: "Tanımlanmayacak",
};
export const PRODUCT_REQUEST_STATUS_STYLES: Record<ProductRequestStatus, string> = {
  pending: "bg-amber-100 text-amber-800",
  resolved: "bg-green-100 text-green-800",
  rejected: "bg-gray-200 text-gray-700",
};

/** Category codes of the old inventory form; any other text is shown as typed. */
const CATEGORY_LABELS: Record<string, string> = {
  materials: "Materyaller",
  instruments: "Aletler",
  disposables: "Tek Kullanımlı",
  supplies: "Sarf Malzeme",
};
export const DEFAULT_CATEGORIES = ["Materyaller", "Aletler", "Tek Kullanımlı", "Sarf Malzeme"];

export function categoryLabel(category: string | null | undefined): string {
  if (!category) return "—";
  return CATEGORY_LABELS[category] ?? category;
}

/** Suggested locations offered in settings (never seeded automatically). */
export const SUGGESTED_LOCATIONS: { name: string; kind: LocationKind }[] = [
  { name: "Oda 1", kind: "room" },
  { name: "Oda 2", kind: "room" },
  { name: "Oda 3", kind: "room" },
  { name: "Oda 4", kind: "room" },
  { name: "Oda 5", kind: "room" },
  { name: "Oda 6", kind: "room" },
  { name: "Sterilizasyon", kind: "sterilization" },
];
