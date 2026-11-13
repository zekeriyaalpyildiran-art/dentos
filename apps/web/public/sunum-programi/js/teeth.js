/* =========================================================
   Diş şeması: durum hesaplama + SVG çizimi
   ========================================================= */

const TEETH = (() => {

  function toothType(n) {
    const p = n % 10;
    return p <= 2 ? 'inc' : p === 3 ? 'can' : p <= 5 ? 'pre' : 'mol';
  }

  function shapes(type, w) {
    const c = w / 2, k = w / 2 - 2;
    const f = v => +v.toFixed(1);
    let crown, roots, canals, tips;
    if (type === 'inc' || type === 'can' || type === 'pre') {
      const rk = type === 'pre' ? k - 3 : k - 3.5;
      const tipY = type === 'can' ? 2 : 7;
      roots = [`M${f(c - rk)},56 C${f(c - rk + 1)},30 ${f(c - 4)},${tipY + 2} ${f(c)},${tipY} C${f(c + 4)},${tipY + 2} ${f(c + rk - 1)},30 ${f(c + rk)},56 Z`];
      canals = [`M${f(c)},54 L${f(c)},${tipY + 7}`];
      tips = [[c, tipY + 2]];
    }
    if (type === 'inc') {
      crown = `M${f(c - k + 2)},54 L${f(c - k)},88 Q${f(c - k)},94 ${f(c - k + 5)},94 L${f(c + k - 5)},94 Q${f(c + k)},94 ${f(c + k)},88 L${f(c + k - 2)},54 Z`;
    } else if (type === 'can') {
      crown = `M${f(c - k + 2)},54 L${f(c - k)},80 Q${f(c - k + 2)},86 ${f(c - 5)},91 L${f(c)},96 L${f(c + 5)},91 Q${f(c + k - 2)},86 ${f(c + k)},80 L${f(c + k - 2)},54 Z`;
    } else if (type === 'pre') {
      crown = `M${f(c - k + 2)},54 C${f(c - k - 1)},66 ${f(c - k)},84 ${f(c - k + 3)},90 L${f(c - 4)},94 L${f(c)},90 L${f(c + 4)},94 L${f(c + k - 3)},90 C${f(c + k)},84 ${f(c + k + 1)},66 ${f(c + k - 2)},54 Z`;
    } else {
      crown = `M${f(c - k + 3)},54 C${f(c - k - 1)},66 ${f(c - k)},82 ${f(c - k + 2)},90 L${f(c - k * .5)},94 L${f(c)},90 L${f(c + k * .5)},94 L${f(c + k - 2)},90 C${f(c + k)},82 ${f(c + k + 1)},66 ${f(c + k - 3)},54 Z`;
      roots = [
        `M${f(c - k + 3)},56 C${f(c - k + 1)},36 ${f(c - k + 5)},14 ${f(c - k + 9)},10 C${f(c - k + 13)},14 ${f(c - 4)},36 ${f(c - 3)},56 Z`,
        `M${f(c + 3)},56 C${f(c + 4)},36 ${f(c + k - 13)},14 ${f(c + k - 9)},10 C${f(c + k - 5)},14 ${f(c + k - 1)},36 ${f(c + k - 3)},56 Z`
      ];
      canals = [`M${f(c - k + 8)},54 L${f(c - k + 9)},16`, `M${f(c + k - 8)},54 L${f(c + k - 9)},16`];
      tips = [[c - k + 9, 12], [c + k - 9, 12]];
    }
    return { crown, roots, canals, tips, c, k };
  }

  /* ---------- Durum hesaplama ---------- */
  function emptyState() {
    return { missing: false, hidden: false, implant: false, pontic: false, prosthesis: false, crown: 'natural',
      caries: false, broken: false, abscess: false, mobile: false, impacted: false, canalFilled: false,
      filling: false, newFilling: false, white: false, bridgeL: false, bridgeR: false };
  }

  function beforeState(n, patient) {
    const f = new Set((patient.findings || {})[n] || []);
    const s = emptyState();
    s.missing = f.has('eksik');
    s.implant = f.has('implant');
    if (s.implant) { s.missing = false; s.crown = 'metal'; }
    if (f.has('kron')) s.crown = 'metal';
    s.caries = f.has('curuk');
    s.broken = f.has('kirik');
    s.abscess = f.has('iltihap');
    s.mobile = f.has('sallanan');
    s.impacted = f.has('gomulu');
    s.canalFilled = f.has('kanalli');
    s.filling = f.has('dolgu');
    return s;
  }

  const ORDER = ['cekim', 'dolgu', 'kanal', 'implant', 'implantustu', 'kron', 'lamina'];

  /* Tüm dişlerin "tedavi sonrası" durumu */
  function afterStates(patient, option) {
    const res = {};
    ALL_TEETH.forEach(n => res[n] = beforeState(n, patient));
    const items = (option && option.items) || [];
    const touched = new Set();

    const clearProblems = s => { s.caries = false; s.broken = false; s.abscess = false; s.mobile = false; };

    ORDER.forEach(code => {
      items.filter(it => txBase(it.tx) === code && !it.optional).forEach(it => (it.teeth || []).forEach(n => {
        const s = res[n]; if (!s) return; touched.add(n);
        switch (code) {
          case 'cekim': Object.assign(s, emptyState(), { missing: true }); break;
          case 'dolgu': s.caries = false; s.newFilling = true; break;
          case 'kanal': s.canalFilled = true; s.abscess = false; s.caries = false; break;
          case 'implant': case 'implantustu':
            Object.assign(s, emptyState(), { implant: true, crown: 'zirconia' }); break;
          case 'kron': s.crown = 'zirconia'; clearProblems(s); s.filling = false; s.newFilling = false; break;
          case 'lamina': s.crown = 'veneer'; clearProblems(s); s.filling = false; s.newFilling = false; break;
        }
        clearProblems(s);
      }));
    });

    // Adeziv (Maryland) köprü: eksik dişin yerine gövde (pontik)
    items.filter(it => TX[it.tx].after === 'pontic' && !it.optional).forEach(it => (it.teeth || []).forEach(n => {
      const s = res[n]; if (!s) return; touched.add(n);
      Object.assign(s, emptyState(), { pontic: true, crown: 'zirconia' });
    }));

    // Köprüler
    items.filter(it => MULTI_CROWN[it.tx] && !it.optional).forEach(it => {
      const teeth = it.teeth || [], crown = MULTI_CROWN[it.tx];
      teeth.forEach(n => {
        const s = res[n]; touched.add(n);
        if (s.missing) Object.assign(s, emptyState(), { pontic: true, crown });
        else { s.crown = crown; clearProblems(s); s.impacted = false; s.filling = false; s.canalFilled = s.implant ? false : s.canalFilled; }
      });
      teeth.forEach(n => {
        const row = isUpper(n) ? UPPER : LOWER, i = row.indexOf(n);
        if (teeth.includes(row[i - 1])) res[n].bridgeL = true;
        if (teeth.includes(row[i + 1])) res[n].bridgeR = true;
      });
    });

    // Çene bazlı
    items.filter(it => ['fixedArch', 'removableArch'].includes(TX[it.tx].after) && it.arch && !it.optional).forEach(it => {
      const fixed = TX[it.tx].after === 'fixedArch';
      archTeeth(it.arch).forEach(n => {
        const p = n % 10; const s = res[n];
        Object.assign(s, emptyState());
        if (fixed) {
          if (p >= 7) s.hidden = true;
          else { s.prosthesis = true; s.crown = 'prosthesis'; if (p === 2 || p === 5) s.implantHidden = true; }
        } else {
          if (p === 8) s.hidden = true; else { s.prosthesis = true; s.crown = 'prosthesis'; }
        }
        const row = archTeeth(it.arch), i = row.indexOf(n);
        const nb = row[i - 1], na = row[i + 1];
        s.bridgeL = !!nb && nb % 10 < (fixed ? 7 : 8);
        s.bridgeR = !!na && na % 10 < (fixed ? 7 : 8);
      });
    });

    // Hassas tutuculu protez: yalnızca o çenedeki eksik (veya çekilecek) dişleri tamamlar, kalan dişler yerinde kalır
    items.filter(it => TX[it.tx].after === 'partial' && it.arch && !it.optional).forEach(it => {
      const row = archTeeth(it.arch);
      const set = new Set(row.filter(n => n % 10 !== 8 && res[n].missing));
      set.forEach(n => {
        Object.assign(res[n], emptyState(), { prosthesis: true, crown: 'prosthesis' });
        const i = row.indexOf(n);
        res[n].bridgeL = set.has(row[i - 1]); res[n].bridgeR = set.has(row[i + 1]);
      });
    });

    // Beyazlatma çene başına; eski (çenesiz) kayıtlar tüm ağız
    items.filter(it => it.tx === 'beyazlatma' && !it.optional).forEach(it => {
      (it.arch ? archTeeth(it.arch) : ALL_TEETH).forEach(n => { if (res[n].crown === 'natural') res[n].white = true; });
    });
    return res;
  }

  /* ---------- SVG çizimi ---------- */
  const CROWN_STYLE = {
    natural: { fill: '#f6edd3', stroke: '#c4b28a' },
    white: { fill: '#fffefa', stroke: '#c9bfa6' },
    zirconia: { fill: '#ffffff', stroke: '#3aa0e0' },
    pfm: { fill: '#fffaf0', stroke: '#c0844a' },
    veneer: { fill: '#ffffff', stroke: '#b46ef0' },
    metal: { fill: '#e7ebee', stroke: '#8a9aa6' },
    prosthesis: { fill: '#ffffff', stroke: '#c9bfa6' }
  };

  function toothSVG(n, s) {
    const type = toothType(n), w = TOOTH_W[n % 10];
    const sh = shapes(type, w);
    const upper = isUpper(n);
    let g = '';
    const gumColor = s.prosthesis ? '#ec8fa2' : '#f4b4c0';
    g += `<rect x="-1" y="43" width="${w + 2}" height="${s.prosthesis ? 20 : 15}" fill="${gumColor}" opacity="${s.prosthesis ? 0.95 : 0.55}"/>`;

    if (s.hidden) return wrap(g);

    if (s.missing && !s.pontic) {
      const ghost = `fill="none" stroke="#b5c0ca" stroke-width="1.2" stroke-dasharray="3 3"`;
      g += sh.roots.map(r => `<path d="${r}" ${ghost}/>`).join('');
      g += `<path d="${sh.crown}" ${ghost}/>`;
      return wrap(g);
    }

    let body = '';
    // Kök / implant
    if (s.implant || s.implantHidden) {
      const c = sh.c;
      body += `<path d="M${c - 5},58 L${c + 5},58 L${c + 4},14 Q${c},7 ${c - 4},14 Z" fill="#a3afbb" stroke="#6b7785" stroke-width=".8"/>`;
      for (let y = 52; y > 16; y -= 6) body += `<line x1="${c - 5}" y1="${y}" x2="${c + 5}" y2="${y - 3}" stroke="#6b7785" stroke-width=".9"/>`;
      body += `<rect x="${c - 3.5}" y="50" width="7" height="8" fill="#c3ccd4"/>`;
    } else if (!s.pontic && !s.prosthesis) {
      body += sh.roots.map(r => `<path d="${r}" fill="#f1e3c4" stroke="#cdb88f" stroke-width="1"/>`).join('');
      if (s.canalFilled) body += sh.canals.map(cn => `<path d="${cn}" stroke="#f08a3c" stroke-width="2.6" stroke-linecap="round"/>`).join('');
      if (s.abscess) body += sh.tips.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="6.5" fill="#e53935" fill-opacity=".35" stroke="#e53935" stroke-width="1"/>`).join('');
    }

    // Kron
    const cs = s.white && s.crown === 'natural' ? CROWN_STYLE.white : CROWN_STYLE[s.crown] || CROWN_STYLE.natural;
    const k = sh.k, c = sh.c;
    if (s.bridgeL) body += `<rect x="-1" y="64" width="${c - k + 4}" height="14" fill="${cs.fill}" stroke="${cs.stroke}" stroke-width="1"/>`;
    if (s.bridgeR) body += `<rect x="${c + k - 3}" y="64" width="${w - (c + k) + 4}" height="14" fill="${cs.fill}" stroke="${cs.stroke}" stroke-width="1"/>`;
    body += `<path d="${sh.crown}" fill="${cs.fill}" stroke="${cs.stroke}" stroke-width="${s.crown === 'natural' || s.crown === 'prosthesis' ? 1 : 1.8}"/>`;
    if (s.crown === 'zirconia' || s.crown === 'pfm' || s.crown === 'veneer' || s.white) {
      body += `<path d="M${c - k * .45},62 Q${c - k * .55},74 ${c - k * .35},84" stroke="#fff" stroke-width="2.4" fill="none" opacity=".9" stroke-linecap="round"/>`;
    }

    if (s.filling && !s.newFilling) body += `<rect x="${c - w * .16}" y="80" width="${w * .32}" height="7" rx="2" fill="#8f9ca8"/>`;
    if (s.newFilling) body += `<rect x="${c - w * .16}" y="80" width="${w * .32}" height="7" rx="2" fill="#fff8e6" stroke="#4f8ef7" stroke-width=".9" stroke-dasharray="2 1.5"/>`;
    if (s.caries) body += `<ellipse cx="${c + k * .25}" cy="76" rx="${w * .15}" ry="5.5" fill="#5d4037"/><ellipse cx="${c + k * .25}" cy="76" rx="${w * .08}" ry="3" fill="#3e2723"/>`;
    if (s.broken) body += `<path d="M${c + k * .1},97 L${c + k + 3},97 L${c + k + 3},74 Z" class="bg-fill"/><path d="M${c + k * .1},95 L${c + k * .45},88 L${c + k * .6},83 L${c + k},75" stroke="#ef6c00" stroke-width="1.6" fill="none"/>`;
    if (s.mobile) body += `<path d="M${c - k - 1},68 l-3,4 l3,4 M${c + k + 1},68 l3,4 l-3,4" stroke="#f9a825" stroke-width="1.6" fill="none"/>`;

    if (s.impacted) body = `<g transform="rotate(${upper ? 24 : 24} ${c} 50) translate(0,-16)" opacity=".85">${body}</g>`;
    g += body;
    return wrap(g);

    function wrap(inner) {
      const t = upper ? '' : `transform="translate(0,100) scale(1,-1)"`;
      return `<svg viewBox="-1 0 ${w + 2} 100" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><g ${t}>${inner}</g></svg>`;
    }
  }

  /* ---------- Şema ---------- */
  /*  opts: { states, marks:{n:[{abbr,color}]}, selected:Set, clickable, compare: afterStates } */
  function chartHTML(opts) {
    const row = (teeth, cls) => {
      const half = (list) => list.map((n, i) => {
        const w = TOOTH_W[n % 10];
        const sel = opts.selected && opts.selected.has(n) ? ' sel' : '';
        const marks = (opts.marks && opts.marks[n] || []).map(m => `<i style="background:${m.color}" title="${m.title || ''}">${m.abbr}</i>`).join('');
        const after = opts.compare ? `<div class="tw after">${toothSVG(n, opts.compare[n])}</div>` : '';
        const idx = ALL_TEETH.indexOf(n);
        return `<button class="tooth${sel}" data-n="${n}" style="flex:${w} 1 0;--i:${idx}" ${opts.clickable ? '' : 'tabindex="-1"'} title="${toothName(n)}">
          <span class="num">${n}</span>
          <div class="tstack"><div class="tw before">${toothSVG(n, opts.states[n])}</div>${after}</div>
          <span class="marks">${marks}</span>
        </button>`;
      }).join('');
      return `<div class="arch ${cls}"><div class="half">${half(teeth.slice(0, 8))}</div><div class="mid"></div><div class="half">${half(teeth.slice(8))}</div></div>`;
    };
    return `<div class="chart-inner${opts.compare ? ' has-compare' : ''}">
      <div class="side-label l">SAĞ</div><div class="side-label r">SOL</div>
      ${row(UPPER, 'upper')}<div class="occlusal"></div>${row(LOWER, 'lower')}</div>`;
  }

  function beforeStates(patient) {
    const res = {}; ALL_TEETH.forEach(n => res[n] = beforeState(n, patient)); return res;
  }

  return { toothSVG, chartHTML, beforeStates, afterStates, toothType };
})();
