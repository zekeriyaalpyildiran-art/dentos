// WhatsApp reminder: phone normalisation for wa.me, first-name greeting, message text and link.

import { describe, expect, it } from "vitest";
import { buildReminderMessage, firstName, whatsappPhone, whatsappUrl } from "../whatsapp";

describe("whatsappPhone", () => {
  it.each([
    ["0532 123 45 67", "905321234567"],
    ["05321234567", "905321234567"],
    ["532 123 4567", "905321234567"],
    ["(0532) 123-45-67", "905321234567"],
    ["+90 (532) 123-45-67", "905321234567"],
    ["+905321234567", "905321234567"],
    ["905321234567", "905321234567"],
    ["0090 532 123 45 67", "905321234567"],
    ["00905551234567", "905551234567"],
    ["  0 505 000 00 00  ", "905050000000"],
  ])("Turkish mobile %s -> %s", (input, expected) => {
    expect(whatsappPhone(input)).toBe(expected);
  });

  it.each([
    ["+44 7700 900123", "447700900123"],
    ["0044 7700 900123", "447700900123"],
    ["447700900123", "447700900123"],
    ["+49 151 23456789", "4915123456789"],
  ])("international %s -> %s", (input, expected) => {
    expect(whatsappPhone(input)).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    [""],
    ["   "],
    ["abc"],
    ["12345"],
    // Turkish landlines have no WhatsApp in practice.
    ["0212 555 00 11"],
    ["212 555 00 11"],
    ["+90 212 555 00 11"],
    // Too short / too long / malformed.
    ["0532 123 45"],
    ["90532123456"],
    ["+0532 123 45 67"],
    ["0532 123 45 67 / 0533 111 22 33"],
    ["+1234567"],
    ["+1234567890123456"],
  ])("unusable %s -> null", (input) => {
    expect(whatsappPhone(input as string | null | undefined)).toBeNull();
  });
});

describe("firstName", () => {
  it("takes the first given name", () => {
    expect(firstName("Ayşe Nur Yılmaz")).toBe("Ayşe");
    expect(firstName("  Mehmet   Demir ")).toBe("Mehmet");
  });

  it("capitalises all-upper or all-lower names the Turkish way", () => {
    expect(firstName("AYŞE YILMAZ")).toBe("Ayşe");
    expect(firstName("İSMAİL KAYA")).toBe("İsmail");
    expect(firstName("IŞIK ÖZ")).toBe("Işık");
    expect(firstName("ismail kaya")).toBe("İsmail");
  });

  it("keeps mixed case as typed", () => {
    expect(firstName("McKenzie Smith")).toBe("McKenzie");
  });

  it("is empty for no name", () => {
    expect(firstName("")).toBe("");
    expect(firstName(null)).toBe("");
  });
});

describe("buildReminderMessage", () => {
  const clinic = {
    name: "Klinik Prime Maltepe",
    phone: "0216 000 00 00",
    address: "Örnek Mah. Deneme Cad. No: 1\nMaltepe / İstanbul",
  };

  it("contains greeting, clinic, date with weekday, time, doctor, address and phone", () => {
    const text = buildReminderMessage({
      patientName: "AYŞE YILMAZ",
      startTime: "2026-10-16T11:30:00Z",
      doctorName: "Dt. Mehmet Demir",
      clinic,
    });
    expect(text).toBe(
      [
        "Merhaba Ayşe,",
        "Klinik Prime Maltepe olarak randevunuzu hatırlatmak isteriz.",
        "",
        "Tarih: 16.10.2026 Cuma",
        "Saat: 14:30",
        "Hekim: Dt. Mehmet Demir",
        "Adres: Örnek Mah. Deneme Cad. No: 1, Maltepe / İstanbul",
        "Telefon: 0216 000 00 00",
        "",
        "Randevunuza gelemeyecekseniz lütfen bize önceden haber verin. Sağlıklı günler dileriz.",
      ].join("\n")
    );
  });

  it("uses the Istanbul day near midnight", () => {
    const text = buildReminderMessage({ patientName: "Ali", startTime: "2026-10-15T21:15:00Z", clinic });
    expect(text).toContain("Tarih: 16.10.2026 Cuma");
    expect(text).toContain("Saat: 00:15");
  });

  it("leaves out lines without a value", () => {
    const text = buildReminderMessage({
      patientName: "",
      startTime: "2026-10-16T11:30:00Z",
      doctorName: null,
      clinic: null,
    });
    expect(text.startsWith("Merhaba,\nRandevunuzu hatırlatmak isteriz.")).toBe(true);
    expect(text).not.toContain("Hekim:");
    expect(text).not.toContain("Adres:");
    expect(text).not.toContain("Telefon:");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("null");
  });

  it("carries no price or treatment detail", () => {
    const text = buildReminderMessage({
      patientName: "Ali Veli",
      startTime: "2026-10-16T11:30:00Z",
      doctorName: "Dt. Mehmet Demir",
      clinic,
    });
    expect(text).not.toMatch(/₺|TL|TRY|EUR|USD|fiyat|ücret|tutar|tedavi|implant|işlem/i);
  });
});

describe("whatsappUrl", () => {
  it("builds a wa.me link with the encoded text", () => {
    expect(whatsappUrl("905321234567", "Merhaba Ayşe,\nSaat: 14:30 & yarın?")).toBe(
      "https://wa.me/905321234567?text=Merhaba%20Ay%C5%9Fe%2C%0ASaat%3A%2014%3A30%20%26%20yar%C4%B1n%3F"
    );
  });
});
