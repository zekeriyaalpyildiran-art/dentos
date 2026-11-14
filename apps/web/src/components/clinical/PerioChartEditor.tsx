"use client";

// Perio chart editor: two jaw tables (6 sites per tooth) with a pocket graph per surface, and the summary tiles.
// Controlled: the parent holds PerioData and saves it (PatientPerioTab).

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import {
  LOWER,
  MOLARS,
  UPPER,
  calOf,
  computeSummary,
  fmt1,
  furcationName,
  num,
  siteName,
  surfaceName,
  type Furcation,
  type PerioData,
  type PerioTooth,
  type Surface,
} from "@/lib/clinical/perio";

const CW = 22;
const LABW = 112;
const MINMM = -4;
const MAXMM = 12;
const K = 6;
const PAD = 7;
const GH = (MAXMM - MINMM) * K + PAD * 2;
const W = 48 * CW;

const C = {
  gum: "#c94f7a",
  pocket: "#c4302d",
  pocketFill: "rgba(196,48,45,0.16)",
  grid: "#eef2f4",
  grid3: "#d6dfe3",
  sep: "#d6dfe3",
  mid: "#97a9b1",
  cej: "#3b4a52",
  hatch: "#eef1f3",
  text: "#6b7c85",
};

type Jaw = "u" | "l";
const JAW_TEETH: Record<Jaw, readonly number[]> = { u: UPPER, l: LOWER };

const yFor = (j: Jaw, mm: number) => {
  const v = Math.max(MINMM, Math.min(MAXMM, mm));
  return j === "u" ? PAD + (MAXMM - v) * K : PAD + (v - MINMM) * K;
};

const pdClass = (v: string) => {
  const n = num(v);
  if (n === null) return "";
  return n >= 6 ? "bg-red-100 text-red-700 font-bold" : n >= 4 ? "bg-amber-100 text-amber-800 font-semibold" : "";
};
const recClass = (v: string) => ((num(v) ?? 0) < 0 ? "text-pink-700" : "");
const mobClass = (v: string) => {
  const n = num(v) ?? 0;
  return n >= 2 ? "bg-red-100 text-red-700 font-bold" : n >= 1 ? "bg-amber-100 text-amber-800 font-semibold" : "";
};
const calClass = (c: number | null) =>
  c === null ? "text-gray-400" : c >= 5 ? "text-red-700 font-bold" : c >= 3 ? "text-amber-700 font-semibold" : "text-gray-500";

const nextFurc = (v: Furcation): Furcation => (["", "I", "II", "III"] as Furcation[])[(["", "I", "II", "III"].indexOf(v) + 1) % 4];

function clean(k: "pd" | "rec" | "mob", raw: string): string {
  let v = raw.replace(/[^\d-]/g, "");
  v = k === "rec" ? v.replace(/(?!^)-/g, "") : v.replace(/-/g, "");
  v = v.slice(0, v.startsWith("-") ? 3 : 2);
  if (k === "mob" && (num(v) ?? 0) > 3) v = "3";
  return v;
}

function JawGraph({ jaw, s, data }: { jaw: Jaw; s: Surface; data: PerioData }) {
  const teeth = JAW_TEETH[jaw];
  const lines = [];
  for (let mm = MINMM; mm <= MAXMM; mm++) {
    const y = yFor(jaw, mm);
    lines.push(
      <line key={`h${mm}`} x1={0} x2={W} y1={y} y2={y} stroke={mm === 0 ? C.cej : mm % 3 === 0 ? C.grid3 : C.grid}
        strokeWidth={mm === 0 ? 1.2 : 1} opacity={mm === 0 ? 0.6 : 1} />,
    );
  }
  type P = { x: number; gm: number; bot: number; pd: number | null };
  const runs: P[][] = [];
  let cur: P[] = [];
  teeth.forEach((t, idx) => {
    const T = data.teeth[String(t)];
    for (let i = 0; i < 3; i++) {
      const pd = num(T[s].pd[i]);
      const rec = num(T[s].rec[i]);
      if (T.missing || (pd === null && rec === null)) {
        if (cur.length) runs.push(cur);
        cur = [];
        continue;
      }
      const gm = rec ?? 0;
      cur.push({ x: (idx * 3 + i + 0.5) * CW, gm, bot: gm + (pd ?? 0), pd });
    }
  });
  if (cur.length) runs.push(cur);
  const pt = (p: P, key: "gm" | "bot") => `${p.x.toFixed(1)},${yFor(jaw, p[key]).toFixed(1)}`;

  return (
    <svg width={W} height={GH} viewBox={`0 0 ${W} ${GH}`} className="block" role="img"
      aria-label={`${jaw === "u" ? "Üst" : "Alt"} çene ${s === "b" ? "vestibül" : jaw === "u" ? "palatinal" : "lingual"} cep grafiği`}>
      {teeth.map((t, idx) =>
        data.teeth[String(t)].missing ? <rect key={`m${t}`} x={idx * 3 * CW} y={0} width={3 * CW} height={GH} fill={C.hatch} /> : null,
      )}
      {lines}
      {teeth.map((t, idx) =>
        idx > 0 ? (
          <line key={`v${t}`} x1={idx * 3 * CW} x2={idx * 3 * CW} y1={0} y2={GH} stroke={idx === 8 ? C.mid : C.sep} strokeWidth={idx === 8 ? 2 : 1} />
        ) : null,
      )}
      {runs.map((run, ri) =>
        run.length > 1 ? (
          <g key={`r${ri}`}>
            <polygon points={`${run.map((p) => pt(p, "gm")).join(" ")} ${run.slice().reverse().map((p) => pt(p, "bot")).join(" ")}`} fill={C.pocketFill} />
            <polyline points={run.map((p) => pt(p, "gm")).join(" ")} fill="none" stroke={C.gum} strokeWidth={2} strokeLinejoin="round" />
            <polyline points={run.map((p) => pt(p, "bot")).join(" ")} fill="none" stroke={C.pocket} strokeWidth={2} strokeLinejoin="round" />
          </g>
        ) : (
          <g key={`r${ri}`}>
            <line x1={run[0].x} x2={run[0].x} y1={yFor(jaw, run[0].gm)} y2={yFor(jaw, run[0].bot)} stroke={C.pocket} strokeWidth={2} />
            <circle cx={run[0].x} cy={yFor(jaw, run[0].gm)} r={2.5} fill={C.gum} />
          </g>
        ),
      )}
      {runs.flat().map((p, i) =>
        p.pd !== null && p.pd >= 4 ? <circle key={`d${i}`} cx={p.x} cy={yFor(jaw, p.bot)} r={p.pd >= 6 ? 3.2 : 2.4} fill={C.pocket} /> : null,
      )}
    </svg>
  );
}

function Scale({ jaw }: { jaw: Jaw }) {
  return (
    <svg width={LABW} height={GH} aria-hidden="true" className="block">
      {[0, 3, 6, 9, 12].map((mm) => (
        <text key={mm} x={LABW - 8} y={yFor(jaw, mm) + 3.5} textAnchor="end" fontSize={10}
          fontFamily="ui-monospace, Menlo, monospace" fill={mm === 0 ? C.cej : C.text} fontWeight={mm === 0 ? 600 : 400}>
          {mm === 0 ? "MSB 0" : mm}
        </text>
      ))}
    </svg>
  );
}

export function PerioSummaryTiles({ data }: { data: PerioData }) {
  const st = computeSummary(data);
  const chip = (cls: string, text: string) => <span className={`inline-block w-fit rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{text}</span>;
  const bopChip = !st.total ? null : st.bop_pct < 10 ? chip("bg-green-100 text-green-800", "%10 altı")
    : st.bop_pct <= 30 ? chip("bg-amber-100 text-amber-800", "lokalize, %10–30") : chip("bg-red-100 text-red-700", "yaygın, %30 üstü");
  const plChip = !st.total ? null : st.pl_pct < 20 ? chip("bg-green-100 text-green-800", "%20 altı") : chip("bg-amber-100 text-amber-800", "%20 ve üstü");
  const tile = (k: string, n: ReactNode, sub?: ReactNode) => (
    <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 flex flex-col gap-0.5 min-w-0">
      <span className="text-[11px] uppercase tracking-wide text-gray-500 font-semibold">{k}</span>
      <span className="font-mono text-xl font-semibold tabular-nums text-gray-900">{n}</span>
      {sub && <span className="text-xs text-gray-500">{sub}</span>}
    </div>
  );
  const u = (s: string) => <small className="text-sm text-gray-500 font-medium">{s}</small>;
  return (
    <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
      {tile("Mevcut diş", st.teeth, `${32 - st.teeth} eksik`)}
      {tile("Ölçülen bölge", <>{st.sites}{u(` / ${st.total}`)}</>, "cep derinliği girilen")}
      {tile("Ort. cep derinliği", <>{fmt1(st.mean_pd)}{st.mean_pd !== null && u(" mm")}</>)}
      {tile("Ort. CAL", <>{fmt1(st.mean_cal)}{st.mean_cal !== null && u(" mm")}</>)}
      {tile("Kanama (BOP)", `%${st.bop_pct}`, bopChip)}
      {tile("Plak skoru", `%${st.pl_pct}`, plChip)}
      {tile("Cep 4–5 mm", <>{st.pd45}{u(" bölge")}</>)}
      {tile("Cep ≥ 6 mm", <>{st.pd6}{u(" bölge")}</>)}
      {tile("En yüksek interdental CAL", <>{st.max_cal ?? "–"}{st.max_cal !== null && u(" mm")}</>, st.max_cal_at)}
    </div>
  );
}

export function PerioChartEditor({
  data,
  onChange,
  readOnly,
  autoAdvance,
}: {
  data: PerioData;
  onChange: (next: PerioData) => void;
  readOnly: boolean;
  autoAdvance: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);

  const setTooth = (t: number, fn: (tooth: PerioTooth) => PerioTooth) => {
    onChange({ ...data, teeth: { ...data.teeth, [String(t)]: fn(data.teeth[String(t)]) } });
  };

  const move = (el: HTMLInputElement, d: number) => {
    const all = Array.from(root.current?.querySelectorAll<HTMLInputElement>("input[data-perio]") ?? []);
    const n = all[all.indexOf(el) + d];
    if (n) {
      n.focus();
      n.select();
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    if (e.key === "Enter" || e.key === "ArrowRight") {
      e.preventDefault();
      move(el, 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      move(el, -1);
    } else if (e.key === "Backspace" && el.value === "") {
      e.preventDefault();
      move(el, -1);
    }
  };

  const valueInput = (t: number, s: Surface | null, k: "pd" | "rec" | "mob", i: number) => {
    const T = data.teeth[String(t)];
    const v = k === "mob" ? T.mob : T[s as Surface][k][i];
    const cls = k === "pd" ? pdClass(v) : k === "rec" ? recClass(v) : mobClass(v);
    const label = k === "mob" ? `${t} mobilite` : `${t} ${surfaceName(t, s as Surface)} ${siteName(t, i)} ${k === "pd" ? "cep derinliği" : "çekilme"}`;
    return (
      <input
        data-perio=""
        value={v}
        readOnly={readOnly}
        inputMode={k === "rec" ? "text" : "numeric"}
        maxLength={3}
        autoComplete="off"
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={onKey}
        onChange={(e) => {
          if (readOnly) return;
          const nv = clean(k, e.target.value);
          const el = e.currentTarget;
          setTooth(t, (tooth) =>
            k === "mob"
              ? { ...tooth, mob: nv }
              : { ...tooth, [s as Surface]: { ...tooth[s as Surface], [k]: tooth[s as Surface][k].map((x, j) => (j === i ? nv : x)) } },
          );
          const native = e.nativeEvent as InputEvent;
          if (autoAdvance && /^-?\d$/.test(nv) && native.inputType?.startsWith("insert")) setTimeout(() => move(el, 1), 0);
        }}
        className={`w-full h-[25px] border-0 bg-transparent text-center font-mono text-[13px] p-0 tabular-nums focus:outline focus:outline-2 focus:-outline-offset-2 focus:outline-blue-600 focus:bg-blue-50 ${cls}`}
      />
    );
  };

  const dot = (t: number, s: Surface, k: "bop" | "pl", i: number) => {
    const on = data.teeth[String(t)][s][k][i];
    const onCls = k === "bop" ? "bg-red-600 border-red-600" : "bg-yellow-500 border-yellow-500";
    return (
      <button
        type="button"
        disabled={readOnly}
        aria-pressed={on}
        aria-label={`${t} ${surfaceName(t, s)} ${siteName(t, i)} ${k === "bop" ? "kanama" : "plak"}`}
        onClick={() => setTooth(t, (tooth) => ({ ...tooth, [s]: { ...tooth[s], [k]: tooth[s][k].map((x, j) => (j === i ? !x : x)) } }))}
        className={`inline-block align-middle w-3.5 h-3.5 rounded-full border-[1.5px] ${on ? onCls : "border-gray-400 hover:border-gray-700"} disabled:cursor-default`}
      />
    );
  };

  const furcButton = (t: number, k: "fb" | "fo", i: number) => {
    const T = data.teeth[String(t)];
    const v = k === "fb" ? T.fb : T.fo[i];
    const name = `${t} ${furcationName(t, k, i)} furkasyon`;
    return (
      <button
        key={`${k}${i}`}
        type="button"
        disabled={readOnly}
        title={name}
        aria-label={`${name} ${v || "yok"}`}
        onClick={() =>
          setTooth(t, (tooth) => (k === "fb" ? { ...tooth, fb: nextFurc(tooth.fb) } : { ...tooth, fo: tooth.fo.map((x, j) => (j === i ? nextFurc(x) : x)) }))
        }
        className={`min-w-[26px] h-[22px] rounded font-mono text-xs border border-transparent hover:border-gray-400 disabled:cursor-default ${
          v === "III" ? "bg-red-100 text-red-700 font-bold" : v ? "bg-amber-100 text-amber-800 font-bold" : "text-gray-400"
        }`}
      >
        {v || "·"}
      </button>
    );
  };

  const jawTable = (j: Jaw) => {
    const teeth = JAW_TEETH[j];
    const sep = (idx: number) => (idx === 8 ? "shadow-[inset_2px_0_0_#97a9b1]" : "shadow-[inset_1px_0_0_#d6dfe3]");
    const gone = (t: number) => data.teeth[String(t)].missing;
    const hatch = "bg-[repeating-linear-gradient(135deg,#eef1f3_0_4px,transparent_4px_8px)]";
    const th = "sticky left-0 z-[2] bg-white text-left pl-3 pr-2 font-medium text-[12.5px] text-gray-500 whitespace-nowrap border-r border-gray-200";
    const tdBase = "p-0 h-[26px] text-center align-middle border-b border-gray-100";

    const per = (key: string, label: string, fn: (t: number) => ReactNode, rowCls = "") => (
      <tr key={key} className={rowCls}>
        <th scope="row" className={`${th} border-b border-gray-100`}>{label}</th>
        {teeth.map((t, idx) => (
          <td key={t} colSpan={3} className={`${tdBase} ${sep(idx)} ${gone(t) ? hatch : ""}`}>{gone(t) ? null : fn(t)}</td>
        ))}
      </tr>
    );
    const sites = (key: string, label: string, fn: (t: number, i: number) => ReactNode, rowCls = "", thCls = "") => (
      <tr key={key} className={rowCls}>
        <th scope="row" className={`${th} border-b border-gray-100 ${thCls}`}>{label}</th>
        {teeth.flatMap((t, idx) =>
          [0, 1, 2].map((i) => (
            <td key={`${t}-${i}`} className={`${tdBase} ${i === 0 ? sep(idx) : ""} ${gone(t) ? hatch : ""}`}>{gone(t) ? null : fn(t, i)}</td>
          )),
        )}
      </tr>
    );
    const sec = (label: string) => (
      <tr key={`sec-${label}`}>
        <th scope="row" className="sticky left-0 z-[2] bg-blue-50 text-blue-800 text-[11px] uppercase tracking-wider font-bold h-[22px] text-left pl-3">{label}</th>
        <th colSpan={48} className="bg-blue-50" />
      </tr>
    );
    const graph = (s: Surface) => (
      <tr key={`g-${s}`}>
        <th scope="row" className="sticky left-0 z-[2] bg-white p-0 align-top border-r border-gray-200"><Scale jaw={j} /></th>
        <td colSpan={48} className="p-0"><JawGraph jaw={j} s={s} data={data} /></td>
      </tr>
    );
    const furcCell = (s: Surface, t: number) => {
      if (!MOLARS.has(t) || data.teeth[String(t)].implant) return null;
      if (s === "b") return furcButton(t, "fb", 0);
      return <div className="flex justify-around">{data.teeth[String(t)].fo.map((_, i) => furcButton(t, "fo", i))}</div>;
    };
    const pdRow = "bg-blue-50/40";
    const rows = (s: Surface) => ({
      furc: per(`furc-${s}`, "Furkasyon", (t) => furcCell(s, t)),
      bop: sites(`bop-${s}`, "Kanama", (t, i) => dot(t, s, "bop", i)),
      pl: sites(`pl-${s}`, "Plak", (t, i) => dot(t, s, "pl", i)),
      rec: sites(`rec-${s}`, "Çekilme (mm)", (t, i) => valueInput(t, s, "rec", i)),
      pd: sites(`pd-${s}`, "Cep derinliği", (t, i) => valueInput(t, s, "pd", i), pdRow, "!text-gray-900 !font-semibold"),
      cal: sites(`cal-${s}`, "CAL", (t, i) => {
        const c = calOf(data.teeth[String(t)], s, i);
        return <span className={`font-mono text-xs ${calClass(c)}`}>{c ?? ""}</span>;
      }),
      graph: graph(s),
    });
    const b = rows("b");
    const o = rows("o");

    return (
      <table className="border-separate border-spacing-0 table-fixed" style={{ width: LABW + W }}>
        <colgroup>
          <col style={{ width: LABW }} />
          {Array.from({ length: 48 }, (_, i) => <col key={i} style={{ width: CW }} />)}
        </colgroup>
        <tbody>
          <tr>
            <th scope="row" className={`${th} border-b border-gray-100`}>Diş</th>
            {teeth.map((t, idx) => (
              <td key={t} colSpan={3} className={`${tdBase} ${sep(idx)} ${gone(t) ? hatch : ""}`}>
                <button
                  type="button"
                  disabled={readOnly}
                  aria-pressed={gone(t)}
                  title={readOnly ? undefined : gone(t) ? "Eksik işaretini kaldır" : "Eksik diş olarak işaretle"}
                  onClick={() => setTooth(t, (tooth) => ({ ...tooth, missing: !tooth.missing }))}
                  className={`w-full h-[26px] font-mono font-semibold text-[13px] hover:bg-blue-50 disabled:hover:bg-transparent disabled:cursor-default ${
                    gone(t) ? "text-gray-400 line-through" : "text-gray-900"
                  }`}
                >
                  {t}
                </button>
              </td>
            ))}
          </tr>
          {per("imp", "İmplant", (t) => (
            <button
              type="button"
              disabled={readOnly}
              aria-pressed={data.teeth[String(t)].implant}
              aria-label={`${t} implant`}
              onClick={() => setTooth(t, (tooth) => ({ ...tooth, implant: !tooth.implant }))}
              className={`w-full h-6 text-[11px] disabled:cursor-default ${data.teeth[String(t)].implant ? "text-blue-700 font-bold" : "text-gray-400"}`}
            >
              {data.teeth[String(t)].implant ? "İmplant" : "–"}
            </button>
          ))}
          {per("mob", "Mobilite", (t) => valueInput(t, null, "mob", 0))}
          {sec("Vestibül")}
          {b.furc}{b.bop}{b.pl}{b.rec}{b.pd}{b.cal}{b.graph}
          {sec(j === "u" ? "Palatinal" : "Lingual")}
          {o.graph}{o.pd}{o.rec}{o.cal}{o.bop}{o.pl}{o.furc}
        </tbody>
      </table>
    );
  };

  return (
    <div ref={root} className="space-y-4">
      {(["u", "l"] as Jaw[]).map((j) => (
        <section key={j} className="bg-white rounded-lg shadow pt-3 pb-1">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 pb-2">
            <h3 className="font-semibold text-gray-900">{j === "u" ? "Üst çene" : "Alt çene"}</h3>
            <span className="text-xs text-gray-500">
              {j === "u"
                ? readOnly ? "Hastanın sağı solda." : "Diş numarasına tıklayınca diş eksik olarak işaretlenir."
                : "Bölgeler distal · orta · mezial sırasıyla, orta hatta doğru."}
            </span>
          </div>
          <div className="overflow-x-auto">{jawTable(j)}</div>
        </section>
      ))}
      <div className="bg-white rounded-lg shadow px-4 py-3 flex flex-wrap gap-x-5 gap-y-2 text-[12.5px] text-gray-600">
        <span className="inline-flex items-center gap-1.5"><i className="inline-block w-[18px] h-[3px] rounded" style={{ background: C.gum }} /> Diş eti kenarı</span>
        <span className="inline-flex items-center gap-1.5"><i className="inline-block w-[18px] h-[3px] rounded" style={{ background: C.pocket }} /> Cep tabanı</span>
        <span className="inline-flex items-center gap-1.5"><i className="inline-block w-[18px] h-[2px] opacity-60" style={{ background: C.cej }} /> MSB (mine-sement birleşimi, 0 mm)</span>
        <span className="inline-flex items-center gap-1.5"><i className="inline-block w-[11px] h-[11px] rounded-full bg-red-600" /> Sondalamada kanama</span>
        <span className="inline-flex items-center gap-1.5"><i className="inline-block w-[11px] h-[11px] rounded-full bg-yellow-500" /> Plak</span>
        <p className="basis-full m-0">
          <b>Çekilme:</b> diş eti kenarı MSB&apos;nin apikalindeyse pozitif (2), koronalindeyse eksi (-2) yazın. <b>CAL</b> = cep derinliği + çekilme, kendiliğinden hesaplanır.
          Furkasyon kutusuna tıkladıkça I → II → III → boş olarak değişir. Ok tuşları ve Enter ile kutular arasında gezebilirsiniz.
        </p>
      </div>
    </div>
  );
}
