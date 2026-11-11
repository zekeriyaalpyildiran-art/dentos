/* =========================================================
   Tedavi animasyonları (SVG + Web Animations API)
   ANIM.mount(container, key, {speed}) -> {replay, destroy}
   ========================================================= */

const ANIM = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const CANCEL = { cancel: true };
  let uidc = 0;

  /* ---------- Ortak şekiller (yerel koordinat: x -200..200, y 0..300) ---------- */
  const ROOT = 'M-76,150 C-74,175 -70,200 -62,240 C-58,262 -50,280 -40,282 C-30,280 -26,262 -24,240 L-16,200 C-8,196 8,196 16,200 L24,240 C26,262 30,280 40,282 C50,280 58,262 62,240 C70,200 74,175 76,150 Z';
  const ENAMEL = 'M-80,160 C-88,130 -85,95 -72,78 C-62,66 -50,72 -40,80 C-30,70 -15,66 0,74 C15,66 30,70 40,80 C50,72 62,66 72,78 C85,95 88,130 80,160 Z';
  const DENTIN = 'M-70,158 C-74,130 -70,105 -60,94 C-50,88 -30,92 0,94 C30,92 50,88 60,94 C70,105 74,130 70,158 Z';
  const PULP = 'M-35,140 C-35,120 -25,112 0,112 C25,112 35,120 35,140 L32,160 C26,170 -26,170 -32,160 Z';
  const CANAL_L = 'M-28,158 C-32,190 -40,230 -42,272';
  const CANAL_R = 'M28,158 C32,190 40,230 42,272';
  const STUMP = 'M-62,160 C-64,135 -60,112 -50,104 C-30,97 30,97 50,104 C60,112 64,135 62,160 Z';
  const CROWN_IMP = 'M-70,165 C-86,135 -85,95 -72,78 C-62,66 -50,72 -40,80 C-30,70 -15,66 0,74 C15,66 30,70 40,80 C50,72 62,66 72,78 C85,95 86,135 70,165 Q0,176 -70,165 Z';
  const GUM_GAP = 'M-200,150 C-150,146 -110,150 -80,156 C-50,150 -20,146 0,146 C20,146 50,150 80,156 C110,150 150,146 200,150 L200,200 L-200,200 Z';
  const GUM_L = 'M-200,148 C-150,144 -110,146 -80,152 C-77,170 -76,186 -75,200 L-200,200 Z';
  const GUM_R = 'M200,148 C150,144 110,146 80,152 C77,170 76,186 75,200 L200,200 Z';
  const BONE_D = 'M-200,186 C-120,180 -60,184 0,182 C60,180 120,184 200,186 L200,300 L-200,300 Z';
  const STAR = 'M0,-11 L2.6,-2.6 L11,0 L2.6,2.6 L0,11 L-2.6,2.6 L-11,0 L-2.6,-2.6 Z';

  const DEFS = `<defs>
    <linearGradient id="bg§" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f9fc"/><stop offset="1" stop-color="#e2eef6"/></linearGradient>
    <linearGradient id="bone§" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4dfc6"/><stop offset="1" stop-color="#e0bc94"/></linearGradient>
    <pattern id="trab§" width="22" height="18" patternUnits="userSpaceOnUse"><circle cx="5" cy="6" r="2.4" fill="#d3a97e" opacity=".5"/><circle cx="15" cy="13" r="1.7" fill="#d3a97e" opacity=".45"/><circle cx="18" cy="3" r="1.1" fill="#d3a97e" opacity=".4"/></pattern>
    <linearGradient id="gum§" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f5a9b7"/><stop offset="1" stop-color="#e8839a"/></linearGradient>
    <linearGradient id="en§" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#ebe2cc"/></linearGradient>
    <linearGradient id="zr§" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".6" stop-color="#f6f9fc"/><stop offset="1" stop-color="#dbe7f2"/></linearGradient>
    <linearGradient id="ti§" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7a8693"/><stop offset=".45" stop-color="#eef2f5"/><stop offset="1" stop-color="#626e7b"/></linearGradient>
    <radialGradient id="glow§"><stop offset="0" stop-color="#ff4d4d" stop-opacity=".85"/><stop offset="1" stop-color="#ff4d4d" stop-opacity="0"/></radialGradient>
    <radialGradient id="blue§"><stop offset="0" stop-color="#4fc3f7" stop-opacity=".75"/><stop offset="1" stop-color="#4fc3f7" stop-opacity="0"/></radialGradient>
    <filter id="sh§" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="#0b2540" flood-opacity=".2"/></filter>
  </defs>`;

  const BG = `<rect x="-200" y="0" width="400" height="300" fill="url(#bg§)"/>`;
  const BONE = `<path d="${BONE_D}" fill="url(#bone§)"/><path d="${BONE_D}" fill="url(#trab§)"/>`;
  const GUMS = (p = 'gum', fill = 'url(#gum§)') => `<path data-p="${p}L" d="${GUM_L}" fill="${fill}"/><path data-p="${p}R" d="${GUM_R}" fill="${fill}"/>`;
  const SCAN = `<g data-p="scan" opacity="0"><rect x="-110" y="56" width="220" height="4" rx="2" fill="#29b6f6"/><rect x="-110" y="40" width="220" height="16" fill="#29b6f6" opacity=".16"/></g>`;
  const at = (x, s, inner) => `<g transform="translate(${x},160) scale(${s}) translate(0,-160)">${inner}</g>`;

  function molar(p = '', enamelFill = 'url(#en§)') {
    return `<g data-p="${p}tooth">
      <path data-p="${p}root" d="${ROOT}" fill="#f1e2c2" stroke="#cdb68b" stroke-width="2"/>
      <path data-p="${p}canalL" d="${CANAL_L}" stroke="#e57f88" stroke-width="7" stroke-linecap="round" fill="none"/>
      <path data-p="${p}canalR" d="${CANAL_R}" stroke="#e57f88" stroke-width="7" stroke-linecap="round" fill="none"/>
      <path data-p="${p}enamel" d="${ENAMEL}" fill="${enamelFill}" stroke="#cfc3a8" stroke-width="2"/>
      <path data-p="${p}dentin" d="${DENTIN}" fill="#f5e8cc"/>
      <path data-p="${p}pulp" d="${PULP}" fill="#e7838c"/>
    </g>`;
  }

  function implantShape(p, style = '') {
    let th = '';
    for (let y = 190; y <= 256; y += 9) {
      const hw = 16 - (y - 178) * 2 / 80;
      th += `<path d="M${-hw},${y} L${hw},${y + 5}" stroke="#56616d" stroke-width="2.2"/>`;
    }
    return `<g data-p="${p}" opacity="0" style="${style}">
      <path d="M-16,178 L16,178 L14,258 Q0,284 -14,258 Z" fill="url(#ti§)" stroke="#5e6a76" stroke-width="1.5"/>${th}
      <rect x="-12" y="172" width="24" height="8" rx="2" fill="#c7d0d8" stroke="#5e6a76"/></g>`;
  }

  function rng(seed) {
    return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }

  /* Ön görünüm dişleri */
  const FRONT = [
    { x: -124, w: 44, h: 100, t: 'c' }, { x: -80, w: 42, h: 92, t: 'l' }, { x: -28, w: 52, h: 108, t: 'i' },
    { x: 28, w: 52, h: 108, t: 'i' }, { x: 80, w: 42, h: 92, t: 'l' }, { x: 124, w: 44, h: 100, t: 'c' }
  ];
  function frontTooth(cx, w, h, t, top = 96) {
    const l = cx - w / 2, r = cx + w / 2, b = top + h;
    if (t === 'c') return `M${l},${top} C${l - 2},${top + h * .5} ${l + 2},${b - 18} ${l + 10},${b - 8} L${cx},${b + 4} L${r - 10},${b - 8} C${r - 2},${b - 18} ${r + 2},${top + h * .5} ${r},${top} Z`;
    return `M${l},${top} C${l - 2},${top + h * .5} ${l + 1},${b - 6} ${l + 7},${b} L${r - 7},${b} C${r - 1},${b - 6} ${r + 2},${top + h * .5} ${r},${top} Z`;
  }
  const GUM_FRONT = 'M-200,0 L200,0 L200,112 L146,114 Q124,90 101.5,120 Q80,92 56.5,120 Q28,88 0,122 Q-28,88 -56.5,120 Q-80,92 -101.5,120 Q-124,90 -146,114 L-200,112 Z';
  const MOUTH = `<path d="M-196,60 Q0,10 196,60 Q186,262 0,280 Q-186,262 -196,60 Z" fill="#4b1e2a"/>`;
  function lowerRow(top = 214, fill = '#eadfc4') {
    const xs = [-112, -74, -38, 0, 38, 74, 112].slice(0, 7);
    return xs.map((x, i) => {
      const w = i === 0 || i === 6 ? 36 : 34;
      return `<path d="M${x - w / 2},${top + 70} L${x - w / 2},${top + 6} Q${x - w / 2},${top} ${x - w / 2 + 6},${top} L${x + w / 2 - 6},${top} Q${x + w / 2},${top} ${x + w / 2},${top + 6} L${x + w / 2},${top + 70} Z" fill="${fill}" stroke="#bfae88" stroke-width="1.5"/>`;
    }).join('') + `<path d="M-200,262 Q0,246 200,262 L200,300 L-200,300 Z" fill="url(#gum§)"/>`;
  }

  /* ---------- Oynatıcı ---------- */
  function mount(container, key, opts = {}) {
    const speed = opts.speed || 1;
    container.innerHTML = `<div class="anim">
      <div class="anim-stage"><svg class="anim-svg" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid meet"></svg></div>
      <div class="anim-cap"><span class="anim-no">1</span><span class="anim-text"></span>
      <button class="anim-replay" title="Tekrar oynat">↻ Tekrar</button></div></div>`;
    const svg = container.querySelector('svg');
    const no = container.querySelector('.anim-no');
    const txt = container.querySelector('.anim-text');
    container.querySelector('.anim-replay').onclick = () => start();
    let run = 0;

    function start() {
      const my = ++run;
      svg.getAnimations && svg.getAnimations({ subtree: true }).forEach(a => a.cancel());
      const uid = 'a' + (++uidc);
      svg.innerHTML = DEFS.replaceAll('§', uid);
      let stepNo = 0;
      const alive = () => my === run && svg.isConnected;
      const resolve = t => typeof t === 'string' ? [...svg.querySelectorAll(`[data-p="${t}"]`)] : Array.isArray(t) ? t.flatMap(resolve) : [t];
      const timing = (dur, o = {}) => ({ duration: dur / speed, fill: 'forwards', easing: 'cubic-bezier(.45,.05,.3,1)', ...o, delay: (o.delay || 0) / speed });
      const ctx = {
        draw(html) {
          const g = document.createElementNS(NS, 'g');
          g.setAttribute('transform', 'translate(200,0)');
          g.innerHTML = html.replaceAll('§', uid);
          svg.appendChild(g); return g;
        },
        q: p => svg.querySelector(`[data-p="${p}"]`),
        A(t, frames, dur, o) {
          if (!alive()) return Promise.reject(CANCEL);
          const anims = resolve(t).filter(Boolean).map(e => e.animate(frames, timing(dur, o)));
          return Promise.all(anims.map(a => a.finished)).then(() => { if (!alive()) throw CANCEL; }, () => { throw CANCEL; });
        },
        F(t, frames, dur, o) {
          const anims = resolve(t).filter(Boolean).map(e => e.animate(frames, timing(dur, o)));
          return { cancel: () => anims.forEach(a => a.cancel()) };
        },
        wait: ms => new Promise((res, rej) => setTimeout(() => alive() ? res() : rej(CANCEL), ms / speed)),
        step(text) {
          if (!alive()) throw CANCEL;
          stepNo++; no.textContent = stepNo; txt.textContent = text;
          txt.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 400, fill: 'both' });
        },
        show: (t, d = 600, o) => ctx.A(t, [{ opacity: 0 }, { opacity: 1 }], d, o),
        hide: (t, d = 600, o) => ctx.A(t, [{ opacity: 1 }, { opacity: 0 }], d, o),
        pulse: (t, n = 2, d = 500) => ctx.A(t, [{ opacity: 1 }, { opacity: .25 }, { opacity: 1 }], d, { iterations: n }),
        async sparkle(pts) {
          const g = ctx.draw(pts.map(([x, y]) => `<g transform="translate(${x},${y})"><path class="tb" d="${STAR}" fill="#fff" stroke="#f5b82e" stroke-width="1.4" style="transform:scale(0)"/></g>`).join(''));
          const ps = [...g.querySelectorAll('path')];
          await Promise.all(ps.map((p, i) => ctx.A(p, [{ transform: 'scale(0) rotate(0deg)' }, { transform: 'scale(1.3) rotate(90deg)', offset: .5 }, { transform: 'scale(0) rotate(180deg)' }], 1100, { delay: i * 160 })));
        },
        rng
      };
      const scene = SCENES[key] || SCENES.generic;
      scene(ctx).then(() => { if (alive()) container.classList.add('anim-done'); })
        .catch(e => { if (e !== CANCEL) console.error(e); });
      container.classList.remove('anim-done');
    }

    start();
    return { replay: start, destroy() { run++; container.innerHTML = ''; } };
  }

  /* =========================================================
     SAHNELER
     ========================================================= */
  const SCENES = {};

  /* ---------- İMPLANT ---------- */
  SCENES.implant = async c => {
    let cells = ''; const r = rng(7);
    for (let i = 0; i < 26; i++) {
      const side = i % 2 ? 1 : -1, x = side * (20 + r() * 22), y = 190 + r() * 84;
      cells += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(2.5 + r() * 2.5).toFixed(1)}" fill="#ffb74d" stroke="#f57c00" stroke-width=".8"/>`;
    }
    let flutes = '';
    for (let y = 26; y < 246; y += 12) flutes += `<path d="M-6,${y} L6,${y + 6}" stroke="#56616d" stroke-width="2"/>`;
    c.draw(`${BG}${BONE}${at(-215, 1, molar('L'))}${at(215, 1, molar('R'))}
      <path d="${GUM_GAP}" fill="url(#gum§)"/>
      <ellipse data-p="focus" cx="0" cy="205" rx="66" ry="84" fill="none" stroke="#6c54a3" stroke-width="3" stroke-dasharray="9 7" opacity="0"/>
      <ellipse data-p="numb" cx="0" cy="168" rx="95" ry="34" fill="url(#blue§)" opacity="0"/>
      <rect data-p="socket" x="-17" y="165" width="34" height="112" rx="14" fill="#9c6b55" opacity=".55" style="transform-origin:50% 0%;transform:scaleY(0)"/>
      <g data-p="cells" opacity="0">${cells}</g>
      ${implantShape('implant', 'transform:translateY(-190px)')}
      <path data-p="abut" d="M-10,178 L10,178 L7,136 Q0,131 -7,136 Z" fill="url(#ti§)" stroke="#5e6a76" stroke-width="1.5" opacity="0"/>
      <path data-p="crown" d="${CROWN_IMP}" fill="url(#zr§)" stroke="#a9c1d6" stroke-width="2" opacity="0" filter="url(#sh§)"/>
      <g data-p="drill" opacity="0">
        <rect x="-24" y="-70" width="48" height="80" rx="14" fill="#47596b"/><rect x="-16" y="4" width="32" height="10" rx="3" fill="#32424f"/>
        <rect x="-6" y="14" width="12" height="236" fill="url(#ti§)"/><g data-p="flutes">${flutes}</g><path d="M-6,250 L0,268 L6,250 Z" fill="#8e99a5"/></g>
      <text data-p="cnt" x="0" y="34" text-anchor="middle" font-size="20" font-weight="700" fill="#0f3a5a" opacity="0">1. hafta</text>`);

    c.step('Eksik diş bölgesi ve çene kemiği değerlendirilir');
    await c.A('focus', [{ opacity: 0, transform: 'scale(.8)' }, { opacity: 1, transform: 'scale(1)' }], 700);
    await c.pulse('focus', 2, 600);
    c.F('focus', [{ opacity: 1 }, { opacity: 0 }], 400);
    c.step('Bölge lokal anestezi ile uyuşturulur — işlem ağrısızdır');
    await c.A('numb', [{ opacity: 0 }, { opacity: .95 }, { opacity: 0 }], 1800);
    c.step('Kemikte implant için hassas bir yuva hazırlanır');
    await c.A('drill', [{ opacity: 0, transform: 'translateY(-230px)' }, { opacity: 1, transform: 'translateY(-110px)' }], 700);
    const spin = c.F('flutes', [{ transform: 'translateY(0px)' }, { transform: 'translateY(12px)' }], 200, { iterations: Infinity, easing: 'linear' });
    await Promise.all([
      c.A('drill', [{ transform: 'translateY(-110px)' }, { transform: 'translateY(0px)' }], 1900, { easing: 'ease-in-out' }),
      c.A('socket', [{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], 1900, { easing: 'ease-in-out' })
    ]);
    await c.A('drill', [{ transform: 'translateY(0px)', opacity: 1 }, { transform: 'translateY(-230px)', opacity: 0 }], 900);
    spin.cancel();
    c.step('Titanyum implant kemiğe yerleştirilir');
    await c.A('implant', [{ opacity: 0, transform: 'translateY(-190px)' }, { opacity: 1, transform: 'translateY(-95px)', offset: .35 }, { opacity: 1, transform: 'translateY(0px)' }], 2300);
    c.F('socket', [{ opacity: .55 }, { opacity: 0 }], 600);
    c.step('Kemik implantla kaynaşır (osseointegrasyon) — yaklaşık 2–4 ay');
    c.F('cells', [{ opacity: 0 }, { opacity: 1 }], 500);
    c.F('cells', [{ transform: 'scale(1)' }, { transform: 'scale(.92)' }], 500, { iterations: 6, direction: 'alternate' });
    await c.show('cnt', 300);
    for (const w of [1, 2, 4, 6, 8, 10, 12]) { c.q('cnt').textContent = `${w}. hafta`; await c.wait(380); }
    await c.A('cells', [{ opacity: 1 }, { opacity: 0 }], 700);
    c.F('cnt', [{ opacity: 1 }, { opacity: 0 }], 400);
    c.step('Bağlantı parçası (abutment) implanta takılır');
    await c.A('abut', [{ opacity: 0, transform: 'translateY(-80px)' }, { opacity: 1, transform: 'translateY(0px)' }], 1000);
    c.step('Kişiye özel zirkonyum diş yerleştirilir');
    await c.A('crown', [{ opacity: 0, transform: 'translateY(-120px)' }, { opacity: 1, transform: 'translateY(0px)' }], 1400, { easing: 'cubic-bezier(.2,.8,.2,1)' });
    c.step('Sonuç: doğal görünümlü, sağlam ve sabit yeni diş');
    await c.sparkle([[-45, 92], [30, 76], [58, 122]]);
  };

  /* ---------- KRON ---------- */
  SCENES.kron = async c => {
    c.draw(`${BG}${BONE}${molar()}
      <path data-p="damage" d="M18,78 C34,70 56,72 66,86 C72,102 62,114 48,112 C33,110 21,97 18,78 Z" fill="#6d4c41"/>
      <path data-p="crack" d="M-22,70 L-14,92 L-25,112 L-18,132" stroke="#5d4037" stroke-width="3" fill="none"/>
      <path data-p="stump" d="${STUMP}" fill="#f1ddba" stroke="#cdb68b" stroke-width="2" opacity="0"/>
      <path data-p="pulp2" d="${PULP}" fill="#e7838c" opacity="0"/>
      <path data-p="newcrown" d="${ENAMEL}" fill="url(#zr§)" stroke="#a9c1d6" stroke-width="2" opacity="0" filter="url(#sh§)"/>
      ${GUMS()}${SCAN}`);
    c.step('Dişte geniş çürük ve çatlak: diş zayıflamış durumda');
    await c.pulse(['damage', 'crack'], 2, 600);
    c.step('Diş, kronun oturacağı şekilde hassasça inceltilir');
    await Promise.all([c.hide(['enamel', 'dentin', 'damage', 'crack'], 1400), c.show(['stump', 'pulp2'], 1400)]);
    c.step('Ağız içi dijital tarayıcı ile hassas ölçü alınır');
    c.F('scan', [{ opacity: 0 }, { opacity: 1 }], 300);
    await c.A('scan', [{ transform: 'translateY(0px)' }, { transform: 'translateY(110px)' }], 1100, { iterations: 2, direction: 'alternate', easing: 'ease-in-out' });
    await c.hide('scan', 300);
    c.step('Kişiye özel zirkonyum kron tasarlanır ve üretilir');
    await c.A('newcrown', [{ opacity: 0, transform: 'translateY(-95px) scale(.8)' }, { opacity: 1, transform: 'translateY(-95px) scale(1)' }], 900);
    c.step('Kron dişe kalıcı olarak yapıştırılır');
    await c.A('newcrown', [{ transform: 'translateY(-95px)' }, { transform: 'translateY(0px)' }], 1300, { easing: 'cubic-bezier(.2,.8,.2,1)' });
    c.step('Sonuç: güçlü, estetik ve uzun ömürlü diş');
    await c.sparkle([[-50, 90], [40, 78], [62, 128]]);
  };

  /* ---------- KANAL ---------- */
  SCENES.kanal = async c => {
    const file = (p, x1, y1, x2, y2) => `<g data-p="${p}" opacity="0"><rect x="${x1 - 7}" y="${y1 - 30}" width="14" height="30" rx="4" fill="#ef5350"/><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#90a4ae" stroke-width="3" stroke-linecap="round"/></g>`;
    c.draw(`${BG}${BONE}
      <circle data-p="abs" cx="-42" cy="278" r="24" fill="url(#glow§)"/><circle data-p="abs" cx="42" cy="278" r="24" fill="url(#glow§)"/>
      ${molar()}
      <path data-p="caries" d="M4,72 C20,66 40,70 46,84 C50,100 40,118 28,122 C14,118 4,100 4,72 Z" fill="#5d4037"/>
      <path data-p="access" d="M-14,72 L14,72 L20,118 L-20,118 Z" fill="#7a4a3a" opacity="0"/>
      <path data-p="gpC" d="${PULP}" fill="#f08a3c" opacity="0"/>
      <path data-p="gpL" d="${CANAL_L}" stroke="#f08a3c" stroke-width="7" stroke-linecap="round" fill="none" opacity="0"/>
      <path data-p="gpR" d="${CANAL_R}" stroke="#f08a3c" stroke-width="7" stroke-linecap="round" fill="none" opacity="0"/>
      <path data-p="seal" d="M-14,72 L14,72 L20,118 L-20,118 Z" fill="#f7f0de" stroke="#4f8ef7" stroke-width="1.5" stroke-dasharray="4 3" opacity="0"/>
      ${GUMS()}${file('fileL', -14, 40, -38, 262)}${file('fileR', 14, 40, 38, 262)}`);
    c.step('Derin çürük sinire ulaşmış; kök ucunda iltihap oluşmuş');
    const throb = c.F(['pulp', 'canalL', 'canalR'], [{ fill: '#e7838c', stroke: '#e57f88' }, { fill: '#c62828', stroke: '#c62828' }], 550, { iterations: Infinity, direction: 'alternate' });
    await c.A('abs', [{ transform: 'scale(.8)' }, { transform: 'scale(1.15)' }], 700, { iterations: 4, direction: 'alternate' });
    c.step('Dişin üst yüzeyinden küçük bir giriş açılır');
    await Promise.all([c.hide('caries', 900), c.show('access', 900)]);
    c.step('Kanallar özel eğelerle tüm uzunluğu boyunca temizlenir');
    for (const f of ['fileL', 'fileR']) {
      await c.A(f, [{ opacity: 0, transform: 'translate(4px,-40px)' }, { opacity: 1, transform: 'translate(0px,0px)' }], 500);
      await c.A(f, [{ transform: 'translate(0px,0px)' }, { transform: `translate(${f === 'fileL' ? -1.5 : 1.5}px,14px)` }], 260, { iterations: 6, direction: 'alternate', easing: 'ease-in-out' });
      await c.A(f, [{ opacity: 1, transform: 'translate(0px,0px)' }, { opacity: 0, transform: 'translate(4px,-50px)' }], 450);
    }
    c.step('İltihaplı doku temizlenir, kanallar dezenfekte edilir');
    throb.cancel();
    await Promise.all([
      c.A(['pulp', 'canalL', 'canalR'], [{ fill: '#c62828', stroke: '#c62828' }, { fill: '#fde9df', stroke: '#fde9df' }], 1200),
      c.A('abs', [{ opacity: 1 }, { opacity: .35 }], 1200)
    ]);
    c.step('Kanallar kalıcı dolgu maddesiyle (gutta-percha) doldurulur');
    ['gpL', 'gpR'].forEach(p => { const e = c.q(p), L = e.getTotalLength(); e.style.strokeDasharray = L; e.style.strokeDashoffset = L; e.setAttribute('opacity', 1); });
    await Promise.all(['gpL', 'gpR'].map(p => { const L = c.q(p).getTotalLength(); return c.A(p, [{ strokeDashoffset: L }, { strokeDashoffset: 0 }], 1600, { easing: 'ease-in-out' }); }));
    await c.show('gpC', 600);
    c.step('Giriş kavitesi dolgu ile kapatılır');
    await Promise.all([c.hide('access', 700), c.show('seal', 700)]);
    c.step('Sonuç: ağrı ve enfeksiyon biter, doğal diş korunur');
    await Promise.all([c.hide('abs', 900), c.sparkle([[-50, 92], [44, 80], [0, 200]])]);
  };

  /* ---------- DOLGU ---------- */
  SCENES.dolgu = async c => {
    const CAV = 'M-30,76 C-20,70 10,70 22,76 C26,90 14,102 -4,104 C-22,102 -32,92 -30,76 Z';
    c.draw(`${BG}${BONE}${molar()}
      <path data-p="cavity" d="${CAV}" fill="#c9a37f"/>
      <path data-p="caries" d="${CAV}" fill="#5d4037"/>
      <path data-p="fill" d="${CAV}" fill="#f8f2e2" stroke="#4f8ef7" stroke-width="1.6" opacity="0" style="transform-origin:50% 100%;transform:scaleY(0)"/>
      ${GUMS()}
      <g data-p="bur" opacity="0"><rect x="-14" y="-36" width="28" height="44" rx="8" fill="#47596b"/><rect x="-3" y="8" width="6" height="52" fill="url(#ti§)"/><circle cx="0" cy="64" r="6" fill="#9aa5b1"/></g>
      <g data-p="light" opacity="0"><rect x="-24" y="-24" width="48" height="52" rx="10" fill="#37474f"/><path d="M-18,28 L18,28 L44,96 L-44,96 Z" fill="#40a9ff" opacity=".35"/></g>`);
    c.step('Dişin çiğneme yüzeyinde çürük tespit edilir');
    await c.pulse('caries', 2, 600);
    c.step('Çürük doku nazikçe temizlenir');
    await c.A('bur', [{ opacity: 0, transform: 'translateY(-80px)' }, { opacity: 1, transform: 'translateY(0px)' }], 700);
    const vib = c.F('bur', [{ transform: 'translateX(-2px)' }, { transform: 'translateX(2px)' }], 70, { iterations: Infinity, direction: 'alternate', easing: 'linear' });
    await c.hide('caries', 1600);
    vib.cancel();
    await c.A('bur', [{ opacity: 1, transform: 'translateY(0px)' }, { opacity: 0, transform: 'translateY(-80px)' }], 600);
    c.step('Diş renginde kompozit, katman katman yerleştirilir');
    await c.A('fill', [{ opacity: 1, transform: 'scaleY(0)' }, { opacity: 1, transform: 'scaleY(1)' }], 1500);
    c.step('Mavi ışıkla saniyeler içinde sertleştirilir');
    await c.A('light', [{ opacity: 0, transform: 'translateY(-60px)' }, { opacity: 1, transform: 'translateY(0px)' }], 600);
    await c.A('light', [{ opacity: 1 }, { opacity: .55 }, { opacity: 1 }], 500, { iterations: 3 });
    await c.A('light', [{ opacity: 1, transform: 'translateY(0px)' }, { opacity: 0, transform: 'translateY(-60px)' }], 500);
    c.step('Cilalanır: doğal ve fark edilmeyen sonuç');
    await Promise.all([c.A('fill', [{ strokeOpacity: 1 }, { strokeOpacity: 0 }], 800), c.sparkle([[-20, 80], [18, 92]])]);
  };

  /* ---------- ÇEKİM ---------- */
  SCENES.cekim = async c => {
    c.draw(`${BG}${BONE}
      <path data-p="socket" d="${ROOT}" fill="#a2574f" opacity="0"/>
      <path data-p="boneHeal" d="${ROOT}" fill="url(#bone§)" opacity="0"/>
      <circle data-p="abs" cx="40" cy="276" r="26" fill="url(#glow§)"/>
      <g data-p="ext">${molar()}
        <path d="M-40,80 C-20,72 30,74 50,90 C62,110 50,130 20,134 C-10,132 -36,118 -40,80 Z" fill="#5d4037"/>
        <path d="M10,76 L0,100 L14,124 L4,150" stroke="#3e2723" stroke-width="3" fill="none"/></g>
      ${GUMS()}
      <path data-p="heal" d="${GUM_GAP}" fill="url(#gum§)" opacity="0"/>
      <ellipse data-p="numb" cx="0" cy="168" rx="105" ry="36" fill="url(#blue§)" opacity="0"/>`);
    c.step('Kurtarılamayacak kadar hasarlı diş ve kök ucunda iltihap');
    await c.A('abs', [{ transform: 'scale(.8)' }, { transform: 'scale(1.15)' }], 600, { iterations: 4, direction: 'alternate' });
    c.step('Bölge lokal anestezi ile uyuşturulur');
    await c.A('numb', [{ opacity: 0 }, { opacity: .95 }, { opacity: 0 }], 1800);
    c.step('Diş, çevre dokular korunarak nazikçe gevşetilir');
    c.F('socket', [{ opacity: 0 }, { opacity: .7 }], 1500);
    await c.A('ext', [{ transform: 'rotate(0deg)' }, { transform: 'rotate(-3deg)' }, { transform: 'rotate(3deg)' }, { transform: 'rotate(0deg)' }], 520, { iterations: 3, easing: 'ease-in-out' });
    c.step('Diş çıkarılır');
    await c.A('ext', [{ opacity: 1, transform: 'translateY(0px) rotate(0deg)' }, { opacity: 1, transform: 'translateY(-60px) rotate(-4deg)', offset: .4 }, { opacity: 0, transform: 'translateY(-300px) rotate(-10deg)' }], 1700);
    c.step('İyileşme: yuva yeni kemikle dolar, diş eti kapanır');
    await Promise.all([c.hide('socket', 2000), c.show('boneHeal', 2000), c.show('heal', 2000), c.hide('abs', 1500)]);
    c.step('Bölge implant veya köprü için hazır hale gelir');
    await c.wait(1200);
  };

  /* ---------- KÖPRÜ ---------- */
  SCENES.kopru = async c => {
    const s = .62;
    const stump = p => `<path data-p="${p}" d="${STUMP}" fill="#f1ddba" stroke="#cdb68b" stroke-width="2" opacity="0"/><path data-p="${p}" d="${PULP}" fill="#e7838c" opacity="0"/>`;
    const crown = d => `<path d="${d}" fill="url(#zr§)" stroke="#a9c1d6" stroke-width="2.4"/>`;
    c.draw(`${BG}${BONE}
      ${at(-120, s, molar('A') + stump('As'))}${at(120, s, molar('B') + stump('Bs'))}
      <path d="${GUM_GAP}" fill="url(#gum§)"/>
      ${at(0, s, `<path data-p="ghost" d="${ENAMEL}" fill="none" stroke="#6c54a3" stroke-width="4" stroke-dasharray="10 8" opacity="0"/>`)}
      <g data-p="bridge" opacity="0" filter="url(#sh§)">
        <rect x="-78" y="110" width="40" height="24" rx="8" fill="#f6f9fc" stroke="#a9c1d6" stroke-width="1.5"/>
        <rect x="38" y="110" width="40" height="24" rx="8" fill="#f6f9fc" stroke="#a9c1d6" stroke-width="1.5"/>
        ${at(-120, s, crown(ENAMEL))}${at(0, s, crown(CROWN_IMP))}${at(120, s, crown(ENAMEL))}
      </g>${SCAN}`);
    c.step('Eksik diş: komşu dişler zamanla boşluğa doğru kayabilir');
    await c.show('ghost', 500); await c.pulse('ghost', 2, 600);
    c.step('Destek olacak komşu dişler hassasça şekillendirilir');
    await Promise.all([c.hide(['Aenamel', 'Adentin', 'Benamel', 'Bdentin', 'ghost'], 1300), c.show(['As', 'Bs'], 1300)]);
    c.step('Dijital ölçü alınır, köprü kişiye özel üretilir');
    c.F('scan', [{ opacity: 0 }, { opacity: 1 }], 300);
    await c.A('scan', [{ transform: 'translateY(30px)' }, { transform: 'translateY(110px)' }], 1000, { iterations: 2, direction: 'alternate' });
    await c.hide('scan', 300);
    c.step('Tek parça zirkonyum köprü yapıştırılır');
    await c.A('bridge', [{ opacity: 0, transform: 'translateY(-110px)' }, { opacity: 1, transform: 'translateY(-110px)', offset: .3 }, { opacity: 1, transform: 'translateY(0px)' }], 1800, { easing: 'cubic-bezier(.2,.8,.2,1)' });
    c.step('Sonuç: eksik diş sabit ve estetik şekilde tamamlanır');
    await c.sparkle([[-140, 110], [0, 100], [130, 118]]);
  };

  /* ---------- KEMİK GREFTİ ---------- */
  SCENES.greft = async c => {
    const DEF = 'M-72,186 C-52,190 -42,250 0,252 C42,250 52,190 72,186 Z';
    const r = rng(11); let parts = '';
    for (let i = 0; i < 70; i++) {
      const x = (r() * 2 - 1) * 62, ymax = 250 - Math.pow(Math.abs(x) / 72, 2) * 60, y = 190 + r() * Math.max(4, ymax - 194);
      parts += `<circle data-p="pt" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(3 + r() * 3).toFixed(1)}" fill="#f8e7c6" stroke="#cfae84" stroke-width=".8" opacity="0"/>`;
    }
    c.draw(`${BG}${BONE}${at(-215, 1, molar('L'))}${at(215, 1, molar('R'))}
      <path data-p="defect" d="${DEF}" fill="#e6edf3"/>
      <path data-p="defLine" d="${DEF}" fill="none" stroke="#e53935" stroke-width="2.5" stroke-dasharray="7 5" opacity="0"/>
      <g data-p="newbone" opacity="0"><path d="${DEF}" fill="url(#bone§)"/><path d="${DEF}" fill="url(#trab§)"/></g>
      ${parts}
      <path data-p="mem" d="M-82,186 C-40,176 40,176 82,186" stroke="#6fa8d6" stroke-width="5" fill="none" stroke-linecap="round" opacity="0"/>
      <path data-p="gum" d="${GUM_GAP}" fill="url(#gum§)"/>
      <g data-p="ghostImp" opacity="0"><path d="M-16,178 L16,178 L14,258 Q0,284 -14,258 Z" fill="none" stroke="#6c54a3" stroke-width="2.5" stroke-dasharray="7 5"/></g>
      <text data-p="cnt" x="0" y="34" text-anchor="middle" font-size="20" font-weight="700" fill="#0f3a5a" opacity="0">1. ay</text>`);
    c.step('Diş kaybı sonrası çene kemiğinde erime oluşmuş');
    await c.show('defLine', 500); await c.pulse('defLine', 2, 600);
    c.step('Diş eti nazikçe açılır');
    await c.A('gum', [{ opacity: 1 }, { opacity: .25 }], 900);
    c.step('Kemik grefti (kemik tozu) bölgeye yerleştirilir');
    await c.A('pt', [{ opacity: 0, transform: 'translateY(-70px)' }, { opacity: 1, transform: 'translateY(0px)' }], 700, { easing: 'cubic-bezier(.3,1.3,.5,1)' });
    c.F('defLine', [{ opacity: 1 }, { opacity: 0 }], 400);
    c.step('Koruyucu zar (membran) ile örtülür');
    await c.show('mem', 800);
    c.step('Diş eti kapatılır; 4–6 ay içinde yeni kemik oluşur');
    await c.A('gum', [{ opacity: .25 }, { opacity: 1 }], 800);
    await c.show('cnt', 300);
    c.F('newbone', [{ opacity: 0 }, { opacity: 1 }], 2400);
    c.F(['pt', 'defect'], [{ opacity: 1 }, { opacity: 0 }], 2400);
    for (const m of [1, 2, 3, 4, 5, 6]) { c.q('cnt').textContent = `${m}. ay`; await c.wait(420); }
    await c.hide(['cnt', 'mem'], 500);
    c.step('Sonuç: implant için yeterli ve sağlıklı kemik hacmi');
    await c.show('ghostImp', 700);
    await c.sparkle([[-40, 220], [30, 240]]);
  };

  /* ---------- SİNÜS LİFTİNG ---------- */
  SCENES.sinus = async c => {
    const FLOOR = 'M-200,120 C-120,124 -70,168 0,170 C70,168 120,124 200,120';
    const SPACE = 'M-92,140 C-62,96 62,96 92,140 C70,160 40,170 0,170 C-40,170 -70,160 -92,140 Z';
    const r = rng(5); let parts = '';
    for (let i = 0; i < 60; i++) {
      const x = (r() * 2 - 1) * 74, ymin = 108 + Math.pow(x / 80, 2) * 30, ymax = 166 - Math.pow(x / 92, 2) * 26;
      const y = ymin + r() * Math.max(2, ymax - ymin);
      parts += `<circle data-p="pt" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(3 + r() * 2.6).toFixed(1)}" fill="#f8e7c6" stroke="#cfae84" stroke-width=".8" opacity="0"/>`;
    }
    let th = '';
    for (let y = 226; y >= 160; y -= 9) { const hw = 15 - (236 - y) * 2 / 86; th += `<path d="M${-hw},${y} L${hw},${y - 5}" stroke="#56616d" stroke-width="2.2"/>`; }
    const BONE_S = `M-200,120 C-120,124 -70,168 0,170 C70,168 120,124 200,120 L200,232 C120,228 60,230 0,230 C-60,230 -120,228 -200,232 Z`;
    c.draw(`${BG}
      <path d="M-200,0 L200,0 L200,122 C120,126 70,170 0,172 C-70,170 -120,126 -200,122 Z" fill="#d6e9f6"/>
      <text x="0" y="60" text-anchor="middle" font-size="15" fill="#5b8fb3" font-weight="600" letter-spacing="1">SİNÜS BOŞLUĞU</text>
      <path d="${BONE_S}" fill="url(#bone§)"/><path d="${BONE_S}" fill="url(#trab§)"/>
      <path data-p="space" d="${SPACE}" fill="#fff3f5" opacity="0"/>
      ${parts}
      <g data-p="newbone" opacity="0"><path d="${SPACE}" fill="url(#bone§)"/><path d="${SPACE}" fill="url(#trab§)"/></g>
      <path data-p="mem" d="${FLOOR}" stroke="#e57390" stroke-width="4" fill="none"/>
      <path data-p="mem2" d="M-200,120 C-150,122 -112,126 -92,140 C-62,96 62,96 92,140 C112,126 150,122 200,120" stroke="#e57390" stroke-width="4" fill="none" opacity="0"/>
      <path d="M-200,226 C-120,222 -60,226 0,228 C60,226 120,222 200,226 L200,258 C120,254 60,256 0,256 C-60,256 -120,254 -200,258 Z" fill="url(#gum§)"/>
      <g data-p="imp" opacity="0"><path d="M-15,236 L15,236 L13,150 Q0,126 -13,150 Z" fill="url(#ti§)" stroke="#5e6a76" stroke-width="1.5"/>${th}</g>
      <path data-p="crown" d="M-58,246 Q0,236 58,246 C68,262 66,284 56,294 L30,298 L0,292 L-30,298 L-56,294 C-66,284 -68,262 -58,246 Z" fill="url(#zr§)" stroke="#a9c1d6" stroke-width="2" opacity="0" filter="url(#sh§)"/>
      <g data-p="meas" opacity="0"><line x1="104" y1="150" x2="104" y2="228" stroke="#0f3a5a" stroke-width="2.5"/><line x1="96" y1="150" x2="112" y2="150" stroke="#0f3a5a" stroke-width="2.5"/><line x1="96" y1="228" x2="112" y2="228" stroke="#0f3a5a" stroke-width="2.5"/>
        <text x="118" y="194" font-size="15" font-weight="700" fill="#0f3a5a">yetersiz</text></g>
      <g data-p="meas2" opacity="0"><line x1="104" y1="104" x2="104" y2="228" stroke="#6c54a3" stroke-width="2.5"/><line x1="96" y1="104" x2="112" y2="104" stroke="#6c54a3" stroke-width="2.5"/><line x1="96" y1="228" x2="112" y2="228" stroke="#6c54a3" stroke-width="2.5"/>
        <text x="118" y="170" font-size="15" font-weight="700" fill="#6c54a3">yeterli</text></g>`);
    c.step('Üst çene arka bölgede sinüs nedeniyle kemik yüksekliği yetersiz');
    await c.show('meas', 600); await c.pulse('meas', 2, 600);
    c.step('Sinüs zarı nazikçe yukarı kaldırılır');
    c.F('meas', [{ opacity: 1 }, { opacity: 0 }], 400);
    await Promise.all([c.hide('mem', 1300), c.show(['mem2', 'space'], 1300)]);
    c.step('Açılan alana kemik grefti yerleştirilir');
    await c.A('pt', [{ opacity: 0, transform: 'translateY(40px)' }, { opacity: 1, transform: 'translateY(0px)' }], 900, { easing: 'cubic-bezier(.3,1.3,.5,1)' });
    c.step('İyileşme sürecinde (4–6 ay) yeni kemik oluşur');
    await Promise.all([c.hide(['pt', 'space'], 2000), c.show('newbone', 2000)]);
    await c.show('meas2', 600);
    c.step('İmplant artık güçlü kemiğe yerleştirilebilir');
    c.F('meas2', [{ opacity: 1 }, { opacity: 0 }], 500);
    await c.A('imp', [{ opacity: 0, transform: 'translateY(140px)' }, { opacity: 1, transform: 'translateY(60px)', offset: .3 }, { opacity: 1, transform: 'translateY(0px)' }], 2000);
    c.step('Üzerine kalıcı zirkonyum diş yapılır');
    await c.A('crown', [{ opacity: 0, transform: 'translateY(60px)' }, { opacity: 1, transform: 'translateY(0px)' }], 1200);
    await c.sparkle([[-40, 270], [44, 262]]);
  };

  /* ---------- ÖN GÖRÜNÜM SAHNELERİ ---------- */
  function frontScene(c, { toothFill = '#e8d6a4', chips = false, crooked = null, extra = '' } = {}) {
    const teeth = FRONT.map((t, i) => {
      const d = frontTooth(t.x, t.w, t.h, t.t);
      const st = crooked ? `style="transform:translate(${crooked[i][0]}px,${crooked[i][1]}px) rotate(${crooked[i][2]}deg)"` : '';
      return `<g data-p="tw${i}" ${st}><path data-p="t${i}" class="ft" d="${d}" fill="${toothFill}" stroke="#bfae88" stroke-width="1.8"/></g>`;
    }).join('');
    const chipMarks = chips ? `<g data-p="chips">
      <path d="M-40,204 L-30,196 L-26,204 Z" fill="#4b1e2a"/><path d="M38,204 L44,198 L50,204 Z" fill="#4b1e2a"/>
      <path d="M-34,140 Q-28,150 -32,166" stroke="#b58b45" stroke-width="5" opacity=".5" fill="none"/><path d="M84,130 Q90,146 86,158" stroke="#b58b45" stroke-width="5" opacity=".5" fill="none"/></g>` : '';
    c.draw(`${BG}${MOUTH}${lowerRow()}${teeth}${chipMarks}<path d="${GUM_FRONT}" fill="url(#gum§)"/>${extra}`);
  }

  SCENES.lamina = async c => {
    const veneers = FRONT.map((t, i) => {
      const x = t.t === 'i' ? Math.sign(t.x) * 27 : t.x;
      return `<path data-p="v${i}" d="${frontTooth(x, t.w + (t.t === 'i' ? 2 : 1), t.h + 2, t.t, 95)}" fill="url(#zr§)" stroke="#d9e3ec" stroke-width="1.6" opacity="0" filter="url(#sh§)"/>`;
    }).join('');
    const outlines = FRONT.map((t, i) => `<path data-p="o" d="${frontTooth(t.t === 'i' ? Math.sign(t.x) * 27 : t.x, t.w + 2, t.h + 2, t.t, 95)}" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="6 5" opacity="0"/>`).join('');
    frontScene(c, { chips: true, extra: '' });
    c.draw(`${veneers}<path d="${GUM_FRONT}" fill="url(#gum§)"/>${outlines}
      <g data-p="prep" opacity="0">${FRONT.map(t => `<path d="${frontTooth(t.x, t.w - 3, t.h - 3, t.t, 98)}" fill="none" stroke="#6c54a3" stroke-width="2"/>`).join('')}</g>`);
    c.step('Renk değişikliği, aşınma, kırık ve aralıklar');
    await c.pulse('chips', 2, 600);
    c.step('Dijital gülüş tasarımı ile ideal form belirlenir');
    await c.show('o', 700); await c.pulse('o', 1, 900);
    c.step('Diş yüzeyi çok ince (yaklaşık 0,3–0,5 mm) hazırlanır');
    c.F('o', [{ opacity: 1 }, { opacity: 0 }], 500);
    await c.show('prep', 600);
    await c.A(['t0', 't1', 't2', 't3', 't4', 't5'], [{ fill: '#e8d6a4' }, { fill: '#efe2bd' }], 800);
    await c.hide('prep', 500);
    c.step('Kişiye özel porselen laminalar tek tek yapıştırılır');
    for (const i of [2, 3, 1, 4, 0, 5]) {
      await c.A(`v${i}`, [{ opacity: 0, transform: 'translateY(20px) scale(1.18)' }, { opacity: 1, transform: 'translateY(0px) scale(1)' }], 650, { easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
    c.F('chips', [{ opacity: 1 }, { opacity: 0 }], 300);
    c.step('Sonuç: doğal, parlak ve uyumlu bir gülüş');
    await c.sparkle([[-90, 150], [-20, 130], [40, 170], [110, 140]]);
  };

  SCENES.beyazlatma = async c => {
    frontScene(c, {
      extra: `<path data-p="barrier" d="M146,114 Q124,90 101.5,120 Q80,92 56.5,120 Q28,88 0,122 Q-28,88 -56.5,120 Q-80,92 -101.5,120 Q-124,90 -146,114" stroke="#1e88e5" stroke-width="7" fill="none" stroke-linecap="round" opacity="0"/>
      <g data-p="gel" opacity="0">${FRONT.map(t => `<path d="${frontTooth(t.x, t.w, t.h, t.t)}" fill="#7fd3ff" opacity=".45"/>`).join('')}</g>
      <ellipse data-p="glow" cx="0" cy="160" rx="190" ry="80" fill="url(#blue§)" opacity="0"/>
      <g data-p="shade" opacity="0"><rect x="-70" y="14" width="140" height="34" rx="17" fill="#0f3a5a"/><text data-p="shadeT" x="0" y="37" text-anchor="middle" font-size="17" font-weight="700" fill="#fff">Renk: A3</text></g>`
    });
    c.step('Mevcut diş rengi ölçülür');
    await c.show('shade', 600); await c.wait(700);
    c.step('Diş etleri koruyucu bariyerle izole edilir');
    await c.show('barrier', 800);
    c.step('Beyazlatıcı jel dişlere uygulanır');
    await c.show('gel', 900);
    c.step('Özel ışıkla aktive edilir — renk birkaç ton açılır');
    c.F('glow', [{ opacity: 0 }, { opacity: 1 }], 700, { iterations: 6, direction: 'alternate' });
    c.F(['t0', 't1', 't2', 't3', 't4', 't5'], [{ fill: '#e8d6a4' }, { fill: '#fdfcf6' }], 3600, { easing: 'ease-in-out' });
    for (const s of ['A3', 'A2', 'A1', 'B1']) { c.q('shadeT').textContent = `Renk: ${s}`; await c.wait(900); }
    c.step('Jel ve bariyer temizlenir: daha beyaz ve parlak bir gülüş');
    await c.hide(['gel', 'barrier', 'glow'], 800);
    await c.sparkle([[-90, 150], [-20, 130], [40, 170], [110, 140]]);
    c.q('shadeT').textContent = 'Örnek sonuç: B1';
  };

  SCENES.ortodonti = async c => {
    const crook = [[6, 6, -9], [5, -8, 12], [-6, 8, 7], [7, 4, -10], [-9, -6, 13], [-5, 7, -7]];
    frontScene(c, {
      toothFill: '#f3ead2', crooked: crook,
      extra: `<g data-p="ideal" opacity="0">${FRONT.map(t => `<path d="${frontTooth(t.x, t.w, t.h, t.t)}" fill="none" stroke="#6c54a3" stroke-width="2" stroke-dasharray="6 5"/>`).join('')}</g>
      <path data-p="aligner" d="M-158,104 Q0,84 158,104 L160,206 Q0,230 -160,206 Z" fill="#bfe9ff" stroke="#8fd3ff" stroke-width="2" opacity="0"/>
      <g data-p="ctr" opacity="0"><rect x="-70" y="14" width="140" height="34" rx="17" fill="#0f3a5a"/><text data-p="ctrT" x="0" y="37" text-anchor="middle" font-size="17" font-weight="700" fill="#fff">Plak 1 / 20</text></g>`
    });
    c.step('Çapraşık ve dönük dişler');
    await c.pulse(['tw0', 'tw1', 'tw2', 'tw3', 'tw4', 'tw5'], 2, 600);
    c.step('Dijital planlama: her dişin hareketi önceden hesaplanır');
    await c.show('ideal', 800); await c.wait(700);
    c.step('Kişiye özel şeffaf plaklar sırayla kullanılır');
    await c.A('aligner', [{ opacity: 0, transform: 'translateY(30px)' }, { opacity: .45, transform: 'translateY(0px)' }], 900);
    await c.show('ctr', 400);
    const moves = crook.map((m, i) => c.A(`tw${i}`, [{ transform: `translate(${m[0]}px,${m[1]}px) rotate(${m[2]}deg)` }, { transform: 'translate(0px,0px) rotate(0deg)' }], 4200, { easing: 'ease-in-out' }));
    for (let k = 1; k <= 20; k++) { c.q('ctrT').textContent = `Plak ${k} / 20`; await c.wait(205); }
    await Promise.all(moves);
    c.step('Sonuç: düzgün, temizlemesi kolay ve sağlıklı diş dizilimi');
    await c.hide(['aligner', 'ideal', 'ctr'], 700);
    await c.sparkle([[-90, 150], [-20, 130], [40, 170], [110, 140]]);
  };

  SCENES.gecePlagi = async c => {
    const up = FRONT.map((t, i) => `<path d="${frontTooth(t.x, t.w, t.h - 14, t.t)}" fill="#f3ead2" stroke="#bfae88" stroke-width="1.8"/>`).join('');
    const lowXs = [-112, -74, -38, 0, 38, 74, 112];
    const low = lowXs.map(x => `<path d="M${x - 17},270 L${x - 17},${206} Q${x - 17},200 ${x - 11},200 L${x + 11},200 Q${x + 17},200 ${x + 17},206 L${x + 17},270 Z" fill="#f3ead2" stroke="#bfae88" stroke-width="1.6"/>`).join('');
    c.draw(`${BG}${MOUTH}<g data-p="lower">${low}</g><path d="M-200,262 Q0,246 200,262 L200,300 L-200,300 Z" fill="url(#gum§)"/>${up}
      <g data-p="wear" opacity="0"><path d="M-50,190 L-6,192 M8,192 L52,190 M-96,176 L-62,178 M62,178 L96,176" stroke="#e53935" stroke-width="4" stroke-linecap="round"/></g>
      <path d="${GUM_FRONT}" fill="url(#gum§)"/>
      <path data-p="guard" d="M-160,100 Q0,80 160,100 L162,198 Q0,214 -162,198 Z" fill="#cfefff" stroke="#9adcff" stroke-width="2" opacity="0"/>`);
    c.step('Gece diş sıkma ve gıcırdatma dişleri aşındırır');
    c.F('wear', [{ opacity: 0 }, { opacity: 1 }], 350, { iterations: 6, direction: 'alternate' });
    await c.A('lower', [{ transform: 'translateX(0px)' }, { transform: 'translateX(-12px)' }, { transform: 'translateX(12px)' }, { transform: 'translateX(0px)' }], 700, { iterations: 3 });
    c.step('Ağız ölçüsüne göre kişiye özel şeffaf plak hazırlanır');
    await c.A('guard', [{ opacity: 0, transform: 'translateY(90px) scale(.9)' }, { opacity: .45, transform: 'translateY(90px) scale(1)' }], 900);
    c.step('Plak gece yatarken üst dişlere takılır');
    await c.A('guard', [{ opacity: .45, transform: 'translateY(90px)' }, { opacity: .5, transform: 'translateY(0px)' }], 1000);
    c.step('Dişler ve kaplamalar aşınmaya karşı korunur');
    await c.A('lower', [{ transform: 'translateX(0px)' }, { transform: 'translateX(-12px)' }, { transform: 'translateX(12px)' }, { transform: 'translateX(0px)' }], 700, { iterations: 2 });
    await c.sparkle([[-80, 150], [60, 140]]);
  };

  /* ---------- DİŞ TAŞI / KÜRETAJ ---------- */
  async function cleaning(c, deep) {
    const blobs = [[-81, 150, 9], [-79, 166, 7], [-84, 138, 6], [81, 148, 9], [80, 164, 7], [85, 136, 6]];
    const deepB = [[-74, 200, 6], [-70, 222, 5], [74, 204, 6], [70, 226, 5]];
    c.draw(`${BG}${BONE}${molar()}
      ${deep ? deepB.map(([x, y, r], i) => `<ellipse data-p="db${i}" cx="${x}" cy="${y}" rx="${r}" ry="${r * 1.4}" fill="#5b4636"/>`).join('') : ''}
      ${blobs.map(([x, y, r], i) => `<ellipse data-p="b${i}" cx="${x}" cy="${y}" rx="${r}" ry="${r * 1.2}" fill="#c9a14a" stroke="#a07d2c"/>`).join('')}
      ${GUMS('gum', '#d94a64')}
      ${deep ? `<path data-p="pocket" d="M-80,152 L-72,218 L-92,198 Z" fill="#7b2c3b"/><path data-p="pocket" d="M80,152 L72,218 L92,198 Z" fill="#7b2c3b"/>` : ''}
      <g data-p="tool" opacity="0"><rect x="-6" y="-90" width="12" height="74" rx="5" fill="#90a4ae"/><path d="M0,-16 Q3,16 -6,40" stroke="#b0bec5" stroke-width="4" fill="none" stroke-linecap="round"/></g>`);
    c.step(deep ? 'Diş eti cebinde derin birikinti ve iltihap' : 'Diş taşı birikimi diş etini tahriş ediyor');
    await c.A(['gumL', 'gumR'], [{ transform: 'scale(1)' }, { transform: 'scale(1.03)' }], 500, { iterations: 4, direction: 'alternate' });
    c.step('Ultrasonik uçla diş taşları nazikçe temizlenir');
    const tgt = [...blobs.map((b, i) => ['b' + i, b]), ...(deep ? deepB.map((b, i) => ['db' + i, b]) : [])];
    await c.show('tool', 300);
    let cur = 'translate(0px,0px)';
    for (const [p, [x, y]] of tgt) {
      if (p === 'db0') c.step('Diş eti cebindeki derin birikintiler kök yüzeyinden temizlenir');
      const to = `translate(${x + 6}px,${y - 40}px)`;
      await c.A('tool', [{ transform: cur }, { transform: to }], 380);
      cur = to;
      c.F('tool', [{ transform: to }, { transform: `translate(${x + 8}px,${y - 41}px)` }], 50, { iterations: 8, direction: 'alternate', composite: 'replace' });
      await c.A(p, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.2)' }], 450);
    }
    await c.A('tool', [{ opacity: 1, transform: cur }, { opacity: 0, transform: 'translate(0px,-80px)' }], 500);
    c.step('Yüzeyler cilalanarak pürüzsüz hale getirilir');
    await c.sparkle([[-70, 120], [74, 118], [0, 80]]);
    c.step(deep ? 'Diş eti cebi küçülür, diş eti dişe yeniden tutunur' : 'Diş eti iyileşir ve sağlıklı rengine döner');
    await Promise.all([
      c.A(['gumL', 'gumR'], [{ fill: '#d94a64' }, { fill: '#ef93a6' }], 1800),
      deep ? c.hide('pocket', 1800) : Promise.resolve()
    ]);
  }
  SCENES.detartraj = c => cleaning(c, false);
  SCENES.kuretaj = c => cleaning(c, true);

  /* ---------- ALL-ON-4 / PROTEZ ---------- */
  function archScene(c, withImplants, o = {}) {
    const IMP4 = [[-128, -28], [-46, 0], [46, 0], [128, 28]];
    const implList = o.imps || (withImplants ? IMP4 : []);
    const ws = [30, 30, 25, 25, 23, 21, 21, 21, 21, 23, 25, 25, 30, 30];
    const gapAfter = o.segments ? [3, 6, 9] : [];
    const total = ws.reduce((a, b) => a + b, 0); let x = -total / 2;
    const teeth = ws.map((w, i) => {
      const mid = Math.abs(i - 6.5), top = 70 + mid * 2.2 + (w >= 30 ? 10 : 0), bot = o.segments ? 162 - mid * 1.4 : 136 - mid * .4;
      const d = `M${x + 1},${bot} L${x + 1},${top + 7} Q${x + 1},${top} ${x + 7},${top} L${x + w - 7},${top} Q${x + w - 1},${top} ${x + w - 1},${top + 7} L${x + w - 1},${bot} Z`;
      x += w; const gap = gapAfter.includes(i);
      const dd = gap ? d.replace(/L(-?[\d.]+),(-?[\d.]+) Z$/, (m0, a, b) => `L${+a - 2},${b} Z`) : d;
      return `<path d="${dd}" fill="${o.pfm ? '#fffaf0' : 'url(#zr§)'}" stroke="${o.pfm ? '#d2a77a' : '#d3cbb8'}" stroke-width="1.3"/>`;
    }).join('');
    const imps = implList.map(([ix, a], k) => {
      let th = ''; for (let y = 10; y < 80; y += 9) th += `<path d="M-10,${y} L10,${y + 4}" stroke="#56616d" stroke-width="2"/>`;
      return `<g transform="translate(${ix},176) rotate(${a})"><g data-p="i${k}" opacity="0"><path d="M-11,0 L11,0 L9,80 Q0,96 -9,80 Z" fill="url(#ti§)" stroke="#5e6a76" stroke-width="1.4"/>${th}<rect x="-8" y="-12" width="16" height="12" fill="#c7d0d8" stroke="#5e6a76"/></g></g>`;
    }).join('');
    const stubs = [-120, -60, 10, 70, 130].map(sx => `<path d="M${sx - 12},170 L${sx - 10},146 Q${sx},138 ${sx + 10},146 L${sx + 12},170 Z" fill="#c7ad7c" stroke="#7a5b33" stroke-width="1.5"/>`).join('');
    const BONE_A = 'M-196,168 Q0,190 196,168 L196,292 Q0,300 -196,292 Z';
    c.draw(`${BG}<path d="${BONE_A}" fill="url(#bone§)"/><path d="${BONE_A}" fill="url(#trab§)"/>
      <g data-p="stubs" ${implList.length ? '' : 'opacity="0"'}>${stubs}</g>
      <path d="M-196,150 Q0,172 196,150 L196,186 Q0,206 -196,186 Z" fill="url(#gum§)"/>
      ${imps}
      <g data-p="bar" opacity="0"><path d="M-150,144 Q0,166 150,144 L150,158 Q0,180 -150,158 Z" fill="url(#ti§)" stroke="#5e6a76" stroke-width="1.5"/>${implList.map(([ix]) => `<circle cx="${ix}" cy="${151 + 11 * (1 - Math.pow(ix / 150, 2))}" r="4" fill="#5e6a76"/>`).join('')}</g>
      <g data-p="pros" opacity="0" filter="url(#sh§)">${o.segments ? '' : '<path d="M-178,124 Q0,150 178,124 L180,166 Q0,192 -180,166 Z" fill="#ef8fa3"/>'}${teeth}</g>
      ${SCAN}`);
  }
  SCENES.allon4 = async c => {
    archScene(c, true);
    c.step('Dişlerin çoğu kaybedilmiş veya kurtarılamaz durumda');
    await c.pulse('stubs', 2, 600);
    c.step('Kurtarılamayan dişler çekilir');
    await c.A('stubs', [{ opacity: 1, transform: 'translateY(0px)' }, { opacity: 0, transform: 'translateY(-60px)' }], 1000);
    c.step('4 implant, kemiği en verimli kullanacak açılarla yerleştirilir');
    for (const k of [1, 2, 0, 3]) await c.A(`i${k}`, [{ opacity: 0, transform: 'translateY(-110px)' }, { opacity: 1, transform: 'translateY(0px)' }], 900);
    c.step('Uygun vakalarda aynı gün geçici sabit dişler takılabilir');
    await c.A('pros', [{ opacity: 0, transform: 'translateY(-140px)' }, { opacity: .6, transform: 'translateY(-60px)', offset: .4 }, { opacity: 1, transform: 'translateY(0px)' }], 1800, { easing: 'cubic-bezier(.2,.8,.2,1)' });
    c.step('İyileşme sonrası kalıcı sabit protez implantlara vidalanır');
    await c.sparkle([[-120, 100], [-30, 86], [60, 92], [140, 104]]);
  };
  SCENES.protez = async c => {
    archScene(c, false);
    c.step('Dişsiz çene: çiğneme, konuşma ve yüz desteği zayıflar');
    await c.wait(1300);
    c.step('Çene ölçüleri ve kapanış kaydı alınır');
    c.F('scan', [{ opacity: 0 }, { opacity: 1 }], 300);
    await c.A('scan', [{ transform: 'translateY(60px)' }, { transform: 'translateY(130px)' }], 1000, { iterations: 2, direction: 'alternate' });
    await c.hide('scan', 300);
    c.step('Prova seanslarında diş dizilimi kişiye göre ayarlanır');
    await c.A('pros', [{ opacity: 0, transform: 'translateY(-120px)' }, { opacity: .55, transform: 'translateY(-90px)' }], 1000);
    await c.wait(600);
    c.step('Protez teslim edilir ve uyumu kontrol edilir');
    await c.A('pros', [{ opacity: .55, transform: 'translateY(-90px)' }, { opacity: 1, transform: 'translateY(0px)' }], 1300, { easing: 'cubic-bezier(.2,.8,.2,1)' });
    await c.sparkle([[-120, 100], [-30, 86], [60, 92], [140, 104]]);
  };

  const IMP6 = [[-140, 0], [-84, 0], [-28, 0], [28, 0], [84, 0], [140, 0]];
  async function placeImplants(c, n) {
    const order = n === 6 ? [2, 3, 1, 4, 0, 5] : [1, 2, 0, 3];
    for (const k of order) await c.A(`i${k}`, [{ opacity: 0, transform: 'translateY(-110px)' }, { opacity: 1, transform: 'translateY(0px)' }], 750);
  }
  SCENES.fullArch = async c => {
    archScene(c, true, { imps: IMP6, segments: true });
    c.step('Kurtarılamayan dişler çekilir');
    await c.pulse('stubs', 1, 600);
    await c.A('stubs', [{ opacity: 1, transform: 'translateY(0px)' }, { opacity: 0, transform: 'translateY(-60px)' }], 900);
    c.step('Her çeneye 6 implant planlanan konumlara yerleştirilir');
    await placeImplants(c, 6);
    c.step('İyileşme döneminde implantlar kemikle bütünleşir');
    await c.A(['i0', 'i1', 'i2', 'i3', 'i4', 'i5'], [{ filter: 'brightness(1)' }, { filter: 'brightness(1.25)' }, { filter: 'brightness(1)' }], 900, { iterations: 2 });
    c.step('Dijital ölçü alınır, dişler yüz yapısına göre tasarlanır');
    c.F('scan', [{ opacity: 0 }, { opacity: 1 }], 300);
    await c.A('scan', [{ transform: 'translateY(40px)' }, { transform: 'translateY(110px)' }], 900, { iterations: 2, direction: 'alternate' });
    await c.hide('scan', 300);
    c.step('Sabit köprüler implantlara yerleştirilir');
    await c.A('pros', [{ opacity: 0, transform: 'translateY(-130px)' }, { opacity: 1, transform: 'translateY(0px)' }], 1600, { easing: 'cubic-bezier(.2,.8,.2,1)' });
    c.step('Sonuç: sabit, estetik ve fonksiyonel dişler');
    await c.sparkle([[-120, 100], [-30, 86], [60, 92], [140, 104]]);
  };
  SCENES.bar = async c => {
    archScene(c, true);
    c.step('Kurtarılamayan dişler çekilir');
    await c.pulse('stubs', 1, 600);
    await c.A('stubs', [{ opacity: 1, transform: 'translateY(0px)' }, { opacity: 0, transform: 'translateY(-60px)' }], 900);
    c.step('Her çeneye 4 implant yerleştirilir');
    await placeImplants(c, 4);
    c.step('Kişiye özel titanyum bar, implantları birbirine bağlar');
    await c.A('bar', [{ opacity: 0, transform: 'translateY(-90px)' }, { opacity: 1, transform: 'translateY(0px)' }], 1300);
    c.step('Tam ark protez bara vidalanır — günlük kullanımda çıkarılmaz');
    await c.A('pros', [{ opacity: 0, transform: 'translateY(-130px)' }, { opacity: 1, transform: 'translateY(0px)' }], 1600, { easing: 'cubic-bezier(.2,.8,.2,1)' });
    c.step('Bakım için yalnızca hekim tarafından sökülebilir');
    await c.sparkle([[-120, 100], [-30, 86], [60, 92], [140, 104]]);
  };
  SCENES.geciciSabit = async c => {
    archScene(c, true, { imps: IMP6 });
    c.step('Her çeneye 6 implant yerleştirilir');
    c.F('stubs', [{ opacity: 1 }, { opacity: 0 }], 10);
    await placeImplants(c, 6);
    c.step('İmplantların ilk sağlamlığı (primer stabilite) kontrol edilir');
    await c.A(['i0', 'i1', 'i2', 'i3', 'i4', 'i5'], [{ filter: 'brightness(1)' }, { filter: 'brightness(1.3)' }, { filter: 'brightness(1)' }], 700, { iterations: 2 });
    c.step('Koşullar uygunsa PMMA geçici sabit dişler implantlara sabitlenir');
    await c.A('pros', [{ opacity: 0, transform: 'translateY(-130px)' }, { opacity: .9, transform: 'translateY(0px)' }], 1500);
    c.step('İyileşme süresince sabit diş konforu');
    await c.sparkle([[-90, 96], [80, 96]]);
  };

  SCENES.generic = async c => {
    c.draw(`${BG}${BONE}${molar()}${GUMS()}`);
    c.step('Tedavi uygulanır');
    await c.sparkle([[-40, 90], [40, 90]]);
  };

  return { mount, has: k => !!SCENES[k] };
})();
