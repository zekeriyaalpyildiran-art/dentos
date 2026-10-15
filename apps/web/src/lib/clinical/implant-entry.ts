// "Kaydet ve aynı hastaya implant ekle" (spec p9_clinical §8.2; legacy IE:1-4, CW:28, CW:35).
// Shared treatment details carry over; individual implant identifiers never do.

export interface ImplantFormValues {
  patientId: string;
  placedOn: string;
  doctorId: string;
  brandId: string;
  model: string;
  nextControlOn: string;
  status: string;
  appointmentId: string;
  stockSource: string;
  fromLocationId: string;
  sourceNote: string;
  tooth: string;
  diameter: string;
  length: string;
  torque: string;
  batchId: string;
  stockItemId: string;
  lotText: string;
  serialText: string;
  notes: string;
}

/** Legacy shared list (IE:3, patientName → patientId) plus the DentOS surgery context. */
export const CARRIED_KEYS = [
  "patientId",
  "placedOn",
  "doctorId",
  "brandId",
  "model",
  "nextControlOn",
  "status",
  "appointmentId",
  "stockSource",
  "fromLocationId",
  "sourceNote",
] as const satisfies readonly (keyof ImplantFormValues)[];

/** Never carried over: tooth, sizes, torque, the chosen lot / serial and notes. */
export const CLEARED_KEYS = [
  "tooth",
  "diameter",
  "length",
  "torque",
  "batchId",
  "stockItemId",
  "lotText",
  "serialText",
  "notes",
] as const satisfies readonly (keyof ImplantFormValues)[];

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Next form for the same patient: carried keys keep their value (`|| ''`, IE:4); every other key is ''. */
export function nextImplantForm(form: Partial<Record<keyof ImplantFormValues, unknown>>): ImplantFormValues {
  const out = {} as ImplantFormValues;
  for (const key of CARRIED_KEYS) out[key] = text(form[key]);
  for (const key of CLEARED_KEYS) out[key] = "";
  return out;
}

/** Row "+" action (CW:35): same patient, placed today, "İyileşme döneminde", no control date. */
export function sameImplantPatientForm(
  row: Partial<Record<keyof ImplantFormValues, unknown>>,
  today: string
): ImplantFormValues {
  return nextImplantForm({ ...row, placedOn: today, status: "healing", nextControlOn: "" });
}

/** New implant defaults (CW:22): placed today, "İyileşme döneminde". */
export function emptyImplantForm(today: string, overrides: Partial<ImplantFormValues> = {}): ImplantFormValues {
  return {
    ...nextImplantForm({}),
    placedOn: today,
    status: "healing",
    stockSource: "stock",
    ...overrides,
  };
}
