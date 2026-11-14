// Perio chart (0042_perio_charts.sql): chart data shape, figures, summary text and the perio_chart_* RPC wrappers.
// The chart is stored as one jsonb document per examination. Sites are kept in screen order (left to right on the
// chart): for teeth in quadrants 1 and 4 that is distal, middle, mesial; for quadrants 2 and 3 mesial, middle,
// distal. Interdental sites are indices 0 and 2.

import { clinicalDb, toClinicalError } from "./rpc";

export const UPPER = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28] as const;
export const LOWER = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38] as const;
export const ALL_TEETH: readonly number[] = [...UPPER, ...LOWER];
export const MOLARS = new Set([18, 17, 16, 26, 27, 28, 48, 47, 46, 36, 37, 38]);

export type Surface = "b" | "o";
export type Furcation = "" | "I" | "II" | "III";

export interface PerioSurface {
  pd: string[];
  rec: string[];
  bop: boolean[];
  pl: boolean[];
}

export interface PerioTooth {
  missing: boolean;
  implant: boolean;
  mob: string;
  fb: Furcation;
  fo: Furcation[];
  b: PerioSurface;
  o: PerioSurface;
}

export interface PerioData {
  v: 1;
  teeth: Record<string, PerioTooth>;
}

export interface PerioSummary {
  teeth: number;
  total: number;
  sites: number;
  mean_pd: number | null;
  mean_cal: number | null;
  bop_pct: number;
  pl_pct: number;
  pd45: number;
  pd6: number;
  max_cal: number | null;
  max_cal_at: string;
}

export const quadrant = (t: number) => Math.floor(t / 10);
export const isRightSide = (t: number) => quadrant(t) === 1 || quadrant(t) === 4;
export const siteName = (t: number, i: number) =>
  (isRightSide(t) ? ["distal", "orta", "mezial"] : ["mezial", "orta", "distal"])[i];
export const surfaceName = (t: number, s: Surface) => (s === "b" ? "vestibül" : quadrant(t) <= 2 ? "palatinal" : "lingual");
export const furcationName = (t: number, k: "fb" | "fo", i: number) => {
  if (k === "fb") return "vestibül";
  if (quadrant(t) >= 3) return "lingual";
  return (isRightSide(t) ? ["distopalatinal", "meziopalatinal"] : ["meziopalatinal", "distopalatinal"])[i];
};

export function num(v: string | undefined | null): number | null {
  if (v === "" || v == null || v === "-") return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

const blankSurface = (): PerioSurface => ({ pd: ["", "", ""], rec: ["", "", ""], bop: [false, false, false], pl: [false, false, false] });

export function blankTooth(t: number): PerioTooth {
  return {
    missing: false,
    implant: false,
    mob: "",
    fb: "",
    fo: MOLARS.has(t) && quadrant(t) <= 2 ? ["", ""] : [""],
    b: blankSurface(),
    o: blankSurface(),
  };
}

/** New chart. Missing teeth and implants are carried from the previous chart; implants also from the implant records. */
export function blankData(previous?: PerioData | null, implantTeeth: number[] = []): PerioData {
  const teeth: Record<string, PerioTooth> = {};
  for (const t of ALL_TEETH) {
    const tooth = blankTooth(t);
    const prev = previous?.teeth?.[String(t)];
    if (prev) {
      tooth.missing = !!prev.missing;
      tooth.implant = !!prev.implant;
    }
    if (implantTeeth.includes(t)) {
      tooth.implant = true;
      tooth.missing = false;
    }
    teeth[String(t)] = tooth;
  }
  return { v: 1, teeth };
}

/** Fills any tooth or field an older document lacks, so the editor never meets undefined. */
export function normalizeData(raw: unknown): PerioData {
  const src = (raw && typeof raw === "object" ? (raw as { teeth?: Record<string, Partial<PerioTooth>> }).teeth : null) || {};
  const teeth: Record<string, PerioTooth> = {};
  for (const t of ALL_TEETH) {
    const base = blankTooth(t);
    const s = src[String(t)] || {};
    const surf = (x: Partial<PerioSurface> | undefined, b: PerioSurface): PerioSurface => ({
      pd: [0, 1, 2].map((i) => String(x?.pd?.[i] ?? b.pd[i])),
      rec: [0, 1, 2].map((i) => String(x?.rec?.[i] ?? b.rec[i])),
      bop: [0, 1, 2].map((i) => !!x?.bop?.[i]),
      pl: [0, 1, 2].map((i) => !!x?.pl?.[i]),
    });
    teeth[String(t)] = {
      missing: !!s.missing,
      implant: !!s.implant,
      mob: typeof s.mob === "string" ? s.mob : "",
      fb: (s.fb as Furcation) || "",
      fo: base.fo.map((_, i) => ((s.fo?.[i] as Furcation) || "") as Furcation),
      b: surf(s.b, base.b),
      o: surf(s.o, base.o),
    };
  }
  return { v: 1, teeth };
}

export function calOf(tooth: PerioTooth, s: Surface, i: number): number | null {
  const pd = num(tooth[s].pd[i]);
  if (pd === null) return null;
  return pd + (num(tooth[s].rec[i]) ?? 0);
}

export function computeSummary(data: PerioData): PerioSummary {
  let teeth = 0, total = 0, sites = 0, pdSum = 0, calSum = 0, pd45 = 0, pd6 = 0, bop = 0, pl = 0;
  let maxCal: number | null = null, maxCalAt = "";
  for (const t of ALL_TEETH) {
    const T = data.teeth[String(t)];
    if (!T || T.missing) continue;
    teeth++;
    total += 6;
    for (const s of ["b", "o"] as Surface[]) {
      for (let i = 0; i < 3; i++) {
        if (T[s].bop[i]) bop++;
        if (T[s].pl[i]) pl++;
        const pd = num(T[s].pd[i]);
        if (pd === null) continue;
        sites++;
        pdSum += pd;
        if (pd >= 6) pd6++;
        else if (pd >= 4) pd45++;
        const cal = pd + (num(T[s].rec[i]) ?? 0);
        calSum += cal;
        if (i !== 1 && (maxCal === null || cal > maxCal)) {
          maxCal = cal;
          maxCalAt = `${t} ${surfaceName(t, s)} ${siteName(t, i)}`;
        }
      }
    }
  }
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return {
    teeth,
    total,
    sites,
    mean_pd: sites ? r1(pdSum / sites) : null,
    mean_cal: sites ? r1(calSum / sites) : null,
    bop_pct: total ? Math.round((bop / total) * 100) : 0,
    pl_pct: total ? Math.round((pl / total) * 100) : 0,
    pd45,
    pd6,
    max_cal: maxCal,
    max_cal_at: maxCalAt,
  };
}

export const fmt1 = (n: number | null | undefined) =>
  n == null ? "–" : n.toLocaleString("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const trDate = (s: string | null | undefined) => {
  if (!s) return "";
  const p = s.slice(0, 10).split("-");
  return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : s;
};

/** Plain-text summary for the patient file (copied to the clipboard). */
export function summaryText(data: PerioData, meta: { patient: string; date: string; by: string; note: string }): string {
  const st = computeSummary(data);
  const L: string[] = [];
  L.push("PERİODONTAL KAYIT");
  L.push(`Hasta: ${meta.patient || "-"}   Tarih: ${trDate(meta.date) || "-"}   Kaydeden: ${meta.by || "-"}`);
  if (meta.note) L.push(`Not: ${meta.note}`);
  L.push("");
  L.push(`Mevcut diş: ${st.teeth}   Ölçülen bölge: ${st.sites}/${st.total}`);
  if (st.sites) L.push(`Ort. cep derinliği: ${fmt1(st.mean_pd)} mm   Ort. CAL: ${fmt1(st.mean_cal)} mm`);
  L.push(`Kanama (BOP): %${st.bop_pct}   Plak: %${st.pl_pct}`);
  L.push(`Cep 4-5 mm: ${st.pd45} bölge   Cep >=6 mm: ${st.pd6} bölge`);
  if (st.max_cal !== null) L.push(`En yüksek interdental CAL: ${st.max_cal} mm (${st.max_cal_at})`);
  const present = ALL_TEETH.filter((t) => !data.teeth[String(t)].missing);
  const miss = ALL_TEETH.filter((t) => data.teeth[String(t)].missing);
  const imp = present.filter((t) => data.teeth[String(t)].implant);
  const mob = present.filter((t) => (num(data.teeth[String(t)].mob) ?? 0) > 0).map((t) => `${t} (${data.teeth[String(t)].mob})`);
  const fur: string[] = [];
  for (const t of present) {
    const T = data.teeth[String(t)];
    if (T.implant || !MOLARS.has(t)) continue;
    if (T.fb) fur.push(`${t} vestibül ${T.fb}`);
    T.fo.forEach((v, i) => v && fur.push(`${t} ${furcationName(t, "fo", i)} ${v}`));
  }
  if (miss.length) L.push(`Eksik dişler: ${miss.join(", ")}`);
  if (imp.length) L.push(`İmplant: ${imp.join(", ")}`);
  if (mob.length) L.push(`Mobilite: ${mob.join(", ")}`);
  if (fur.length) L.push(`Furkasyon: ${fur.join(", ")}`);
  L.push("");
  L.push("Diş bazında (distal-orta-mezial; * = kanama; parantez içi = çekilme)");
  const row = (t: number, s: Surface) => {
    const S = data.teeth[String(t)][s];
    const idx = isRightSide(t) ? [0, 1, 2] : [2, 1, 0];
    return idx
      .map((i) => {
        const rec = num(S.rec[i]);
        return (S.pd[i] === "" ? "-" : S.pd[i]) + (S.bop[i] ? "*" : "") + (rec ? `(${rec})` : "");
      })
      .join(" ");
  };
  for (const t of present) {
    const T = data.teeth[String(t)];
    const has = (["b", "o"] as Surface[]).some((s) => T[s].pd.some((v) => v !== "") || T[s].rec.some((v) => v !== ""));
    if (!has) continue;
    L.push(`${t}${T.implant ? " (İmp)" : ""}   V: ${row(t, "b")}   ${quadrant(t) <= 2 ? "P" : "L"}: ${row(t, "o")}`);
  }
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// RPCs
// ---------------------------------------------------------------------------

export interface PerioChartRow {
  id: string;
  patient_id: string;
  exam_date: string;
  note: string;
  summary: Partial<PerioSummary>;
  version: number;
  created_by_name: string | null;
  updated_by_name: string | null;
  created_at: string;
  updated_at: string;
  data?: unknown;
}

export interface PerioListResponse {
  can_write: boolean;
  today: string;
  rows: PerioChartRow[];
  implant_teeth: number[];
}

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  let result: { data: unknown; error: unknown };
  try {
    result = await clinicalDb().rpc(name, args);
  } catch (err) {
    throw toClinicalError(err);
  }
  if (result.error) throw toClinicalError(result.error);
  return result.data as T;
}

export const perioList = (patientId: string) => call<PerioListResponse>("perio_chart_list", { p_patient_id: patientId });
export const perioGet = (id: string) => call<PerioChartRow>("perio_chart_get", { p_id: id });
export const perioSave = (args: {
  id: string;
  patientId: string;
  version: number;
  examDate: string;
  note: string;
  data: PerioData;
}) =>
  call<PerioChartRow>("perio_chart_save", {
    p_id: args.id,
    p_patient_id: args.patientId,
    p_version: args.version,
    p_exam_date: args.examDate,
    p_note: args.note,
    p_data: args.data,
    p_summary: computeSummary(args.data),
  });
export const perioDelete = (id: string, version: number) =>
  call<{ id: string; deleted: boolean }>("perio_chart_delete", { p_id: id, p_version: version });
