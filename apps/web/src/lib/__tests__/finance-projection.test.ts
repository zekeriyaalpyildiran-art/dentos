import { describe, expect, it } from "vitest";
import {
  addDays,
  buildProjection,
  businessDayOnOrAfter,
  dailyNetEstimate,
  monthDays,
  previousMonth,
  weekday,
} from "../finance-projection";

describe("dates", () => {
  it("adds days across months and years", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("moves weekend days to Monday", () => {
    expect(weekday("2026-11-07")).toBe(6); // Cumartesi
    expect(businessDayOnOrAfter("2026-11-07")).toBe("2026-11-09");
    expect(businessDayOnOrAfter("2026-11-08")).toBe("2026-11-09"); // Pazar
    expect(businessDayOnOrAfter("2026-11-12")).toBe("2026-11-12");
  });
  it("month helpers", () => {
    expect(monthDays("2026-10")).toBe(31);
    expect(monthDays("2026-02")).toBe(28);
    expect(previousMonth("2026-11")).toBe("2026-10");
    expect(previousMonth("2026-01")).toBe("2025-12");
  });
});

describe("dailyNetEstimate", () => {
  const rows = [
    { report_bucket: "patient_receipts" as const, incoming_cents: 290_000_000, outgoing_cents: 0 },
    { report_bucket: "other_income" as const, incoming_cents: 1_000_000, outgoing_cents: 0 },
    { report_bucket: "doctor" as const, incoming_cents: 0, outgoing_cents: 75_000_000 },
    { report_bucket: "fees" as const, incoming_cents: 0, outgoing_cents: 22_000_000 },
    { report_bucket: "rent" as const, incoming_cents: 0, outgoing_cents: 26_500_000 },
    { report_bucket: "tax" as const, incoming_cents: 0, outgoing_cents: 9_000_000 },
    { report_bucket: "distribution" as const, incoming_cents: 0, outgoing_cents: 50_000_000 },
  ];
  it("takes Burgan gross out of receipts and Burgan fees out of outflows; planned buckets are not counted", () => {
    const e = dailyNetEstimate([{ days: 31, rows, financingGrossCents: 97_600_000, financingFeeCents: 19_600_000 }]);
    expect(e.receiptsCents).toBe(290_000_000 + 1_000_000 - 97_600_000);
    expect(e.operatingOutCents).toBe(75_000_000 + 22_000_000 - 19_600_000);
    expect(e.days).toBe(31);
    expect(e.dailyNetCents).toBe(Math.round((e.receiptsCents - e.operatingOutCents) / 31));
  });
  it("adds periods together and never goes below zero per period", () => {
    const e = dailyNetEstimate([
      { days: 31, rows, financingGrossCents: 0, financingFeeCents: 0 },
      { days: 7, rows: [{ report_bucket: "patient_receipts", incoming_cents: 100, outgoing_cents: 0 }], financingGrossCents: 500, financingFeeCents: 0 },
    ]);
    expect(e.days).toBe(38);
    expect(e.receiptsCents).toBe(291_000_000);
  });
  it("is zero without days", () => {
    expect(dailyNetEstimate([]).dailyNetCents).toBe(0);
  });
});

describe("buildProjection", () => {
  // 07.11.2026 (Cumartesi) … 21.11.2026; 15.11 rent is a Sunday debt in the plan list.
  const base = {
    today: "2026-11-07",
    windowEnd: "2026-11-21",
    startCents: 36_499_170,
    plan: [
      { due_date: "2026-11-15", direction: "out" as const, outstanding_cents: 26_500_000 },
      { due_date: "2026-11-17", direction: "out" as const, outstanding_cents: 18_277_744 },
    ],
    releases: [
      { id: "emel", name: "EMEL RAKICI", expected_release: "2026-11-08", net_cents: 7_296_480 },
      { id: "hepgul", name: "HEPGÜL", expected_release: "2026-11-12", net_cents: 10_701_504 },
      { id: "ayfer", name: "AYFER KARASU", expected_release: "2026-11-22", net_cents: 4_053_600 },
      { id: "x", name: "NO DATE", expected_release: null, net_cents: 1 },
    ],
    dailyNetCents: 0,
  };

  it("places releases on business days and leaves out those after the window or without a day", () => {
    const p = buildProjection(base);
    expect(p.releases.map((r) => [r.id, r.day])).toEqual([
      ["emel", "2026-11-09"], // Pazar → Pazartesi
      ["hepgul", "2026-11-12"],
    ]);
    expect(p.days).toHaveLength(15);
    expect(p.days.find((d) => d.day === "2026-11-09")?.burganCents).toBe(7_296_480);
  });

  it("walks the balance with planned items and releases; without an estimate it equals the plan + releases", () => {
    const p = buildProjection(base);
    expect(p.endBalanceCents).toBe(36_499_170 + 7_296_480 + 10_701_504 - 26_500_000 - 18_277_744);
    expect(p.min).toEqual({ day: "2026-11-17", balanceCents: p.endBalanceCents });
  });

  it("adds the daily estimate from tomorrow on, not today", () => {
    const p = buildProjection({ ...base, dailyNetCents: 1_000_000 });
    expect(p.days[0].estimateCents).toBe(0);
    expect(p.days[1].estimateCents).toBe(1_000_000);
    expect(p.endBalanceCents).toBe(buildProjection(base).endBalanceCents + 14 * 1_000_000);
  });

  it("counts overdue entries and overdue releases on today", () => {
    const p = buildProjection({
      ...base,
      today: "2026-11-10",
      plan: [{ due_date: "2026-11-01", direction: "out", outstanding_cents: 500 }],
      releases: [{ id: "old", name: "OLD", expected_release: "2026-11-02", net_cents: 900 }],
    });
    expect(p.days[0]).toMatchObject({ day: "2026-11-10", planOutCents: 500, burganCents: 900 });
    expect(p.releases[0]).toMatchObject({ day: "2026-11-10", overdue: true });
  });

  it("reports the lowest day", () => {
    const p = buildProjection({ ...base, startCents: 0, dailyNetCents: 2_000_000 });
    expect(p.min?.day).toBe("2026-11-17");
    expect(p.min!.balanceCents).toBeLessThan(0);
  });
});

import { bucketCategoryText, expenseRows, outgoingByCategory } from "../finance-report-lines";
import type { DashboardJson } from "../finance";

describe("bucket category split (Hizmet alımı under Diğer faaliyet gideri)", () => {
  const cat = (name: string, bucket: string, out: number) =>
    ({ category_id: name, name, direction: "out", report_bucket: bucket, is_active: true, count: 1, incoming_cents: 0, outgoing_cents: out, open_incoming_cents: 0, open_outgoing_cents: 0, net_cents: -out }) as DashboardJson["category_report"][number];
  const d = {
    category_report: [cat("Diğer faaliyet gideri", "other_expense", 11_400), cat("Hizmet alımı", "other_expense", 7_722_500), cat("Kira", "rent", 0), cat("Laboratuvar", "lab", 500)],
    expenses: { by_bucket: { other_expense: 7_733_900, lab: 500 }, current_doctor_cents: 0, past_doctor_cents: 0, general_cents: 0, operational_cents: 0 },
  } as unknown as DashboardJson;
  it("lists the categories of a bucket, largest first, only when there are several", () => {
    expect(outgoingByCategory(d, "other_expense").map((c) => c.name)).toEqual(["Hizmet alımı", "Diğer faaliyet gideri"]);
    expect(bucketCategoryText(d, "other_expense")).toMatch(/^Hizmet alımı .* · Diğer faaliyet gideri /);
    expect(bucketCategoryText(d, "lab")).toBeUndefined();
  });
  it("adds them as sub rows under the bucket line in the report rows", () => {
    const rows = expenseRows(d);
    const i = rows.findIndex((r) => r.label === "Diğer faaliyet gideri" && r.kind === "main");
    expect(rows[i].cents).toBe(7_733_900);
    expect(rows.slice(i + 1, i + 3)).toEqual([
      { label: "Hizmet alımı", cents: 7_722_500, kind: "sub" },
      { label: "Diğer faaliyet gideri", cents: 11_400, kind: "sub" },
    ]);
    expect(rows.filter((r) => r.label === "Laboratuvar")).toHaveLength(1);
  });
});
