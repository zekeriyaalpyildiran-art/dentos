// "Kaydet ve aynı hastaya implant ekle" vectors I1-I3 (spec p9_clinical §8.3; legacy IE:1-4, CW:35).

import { describe, expect, it } from "vitest";
import { CARRIED_KEYS, CLEARED_KEYS, nextImplantForm, sameImplantPatientForm } from "../implant-entry";

const FULL = {
  patientId: "p",
  placedOn: "2026-10-15",
  doctorId: "d",
  brandId: "b",
  model: "GM",
  nextControlOn: "2027-01-15",
  status: "healing",
  appointmentId: "a",
  stockSource: "stock",
  fromLocationId: "l",
  sourceNote: "",
  tooth: "36",
  diameter: "4",
  length: "10",
  torque: "35",
  batchId: "x",
  stockItemId: "y",
  lotText: "L",
  serialText: "S",
  notes: "n",
};

describe("nextImplantForm", () => {
  it("I1: keeps the 11 shared keys and clears the implant's own fields", () => {
    const next = nextImplantForm(FULL);
    expect(CARRIED_KEYS).toHaveLength(11);
    for (const k of CARRIED_KEYS) expect(next[k]).toBe(FULL[k]);
    for (const k of CLEARED_KEYS) expect(next[k]).toBe("");
    expect(Object.keys(next).sort()).toEqual(Object.keys(FULL).sort());
  });

  it("I2: an empty form gives '' everywhere, never undefined", () => {
    const next = nextImplantForm({});
    for (const k of [...CARRIED_KEYS, ...CLEARED_KEYS]) expect(next[k]).toBe("");
  });
});

describe("sameImplantPatientForm", () => {
  it("I3: today, healing, no control date, no tooth", () => {
    const next = sameImplantPatientForm({ ...FULL, status: "completed", nextControlOn: "2027-01-01", tooth: "36" }, "2026-10-15");
    expect(next.placedOn).toBe("2026-10-15");
    expect(next.status).toBe("healing");
    expect(next.nextControlOn).toBe("");
    expect(next.tooth).toBe("");
    expect(next.patientId).toBe("p");
    expect(next.brandId).toBe("b");
  });
});
