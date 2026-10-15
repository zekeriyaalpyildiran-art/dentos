// Appointment write errors: database guard keys and exclusion constraints map to Turkish texts.

import { describe, expect, it } from "vitest";
import { appointmentWriteErrorText, SLOT_ERROR_TEXTS } from "../errors";

const FALLBACK = "Randevu oluşturulurken hata oluştu";

describe("appointmentWriteErrorText", () => {
  it("maps the trigger's HINT keys", () => {
    expect(
      appointmentWriteErrorText(
        { code: "PT409", hint: "E_SLOT_DOCTOR", message: "Seçilen hekimin bu saatte başka bir randevusu var." },
        FALLBACK
      )
    ).toBe(SLOT_ERROR_TEXTS.E_SLOT_DOCTOR);
    expect(appointmentWriteErrorText({ code: "PT409", hint: "E_SLOT_CHAIR", message: "x" }, FALLBACK)).toBe(
      SLOT_ERROR_TEXTS.E_SLOT_CHAIR
    );
    expect(appointmentWriteErrorText({ code: "P0001", hint: "E_SLOT_ORDER", message: "x" }, FALLBACK)).toBe(
      SLOT_ERROR_TEXTS.E_SLOT_ORDER
    );
  });

  it("maps exclusion violations by constraint name", () => {
    const err = (name: string) => ({
      code: "23P01",
      message: `conflicting key value violates exclusion constraint "${name}"`,
      hint: null,
    });
    expect(appointmentWriteErrorText(err("appointments_no_double_doctor"), FALLBACK)).toBe(
      SLOT_ERROR_TEXTS.E_SLOT_DOCTOR
    );
    expect(appointmentWriteErrorText(err("appointments_no_double_chair"), FALLBACK)).toBe(
      SLOT_ERROR_TEXTS.E_SLOT_CHAIR
    );
    expect(appointmentWriteErrorText(err("something_else"), FALLBACK)).toBe("Bu saatte çakışan başka bir randevu var.");
  });

  it("passes other keyed server errors through (they are Turkish by contract)", () => {
    expect(
      appointmentWriteErrorText(
        { code: "P0001", hint: "E_APPT_REFS", message: "Randevunun hastası, hekimi ve koltuğu bu kliniğe ait olmalı." },
        FALLBACK
      )
    ).toBe("Randevunun hastası, hekimi ve koltuğu bu kliniğe ait olmalı.");
  });

  it("never shows raw database or network texts", () => {
    expect(appointmentWriteErrorText({ code: "42501", message: "permission denied for table appointments" }, FALLBACK)).toBe(
      FALLBACK
    );
    expect(appointmentWriteErrorText({ message: "TypeError: Failed to fetch", code: "" }, FALLBACK)).toBe(FALLBACK);
    expect(appointmentWriteErrorText(new Error("boom"), FALLBACK)).toBe(FALLBACK);
    expect(appointmentWriteErrorText(null, FALLBACK)).toBe(FALLBACK);
    expect(appointmentWriteErrorText("x", FALLBACK)).toBe(FALLBACK);
  });
});
