/* =========================================================
   Ortak: kayıt, ayarlar, hesaplar (editör ve hasta dosyası kullanır)
   ========================================================= */

const STORE_KEY = 'kp_sunum_v1';
const DEFAULT_SETTINGS = {
  clinicName: 'Klinik Prime Maltepe', tagline: 'Ağız ve Diş Sağlığı Polikliniği', doctor: '', phone: '', address: '', web: '',
  logo: 'img/logo.png', accent: '#6c54a3', currency: '₺', cashDiscount: 20, cardDiscount: 10, installments: '3,6,9,12', showPrices: true, animSpeed: 1, prices: {}
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }) : '';

let DB = window.__EMBED__ || load();
const UI = { mode: 'find', tool: 'curuk', bridgeSel: new Set(), after: false };

/* ---------- Kayıt ---------- */
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY));
    if (d && d.patients) {
      const legacy = !d.settings || d.settings.cardDiscount === undefined;
      d.settings = { ...DEFAULT_SETTINGS, ...d.settings };
      if (legacy) { d.settings.cardDiscount = 10; d.settings.cashDiscount = 20; }
      if (!d.settings.logo) d.settings.logo = DEFAULT_SETTINGS.logo;
      if (d.settings.accent === '#14a39b') d.settings.accent = DEFAULT_SETTINGS.accent;
      return d;
    }
  } catch (e) { /* boş başla */ }
  return { settings: { ...DEFAULT_SETTINGS }, patients: [], currentId: null };
}
let saveT;
function save() {
  if (window.__EMBED__) return;
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(DB)); }
    catch (e) { alert('Kayıt alanı doldu. Lütfen eski hastaları yedekleyip silin veya daha küçük görseller kullanın.'); }
  }, 250);
}

const S = () => DB.settings;
const priceOf = tx => S().prices[tx] ?? TX[tx].price;
const money = (n, c = 'TRY') => Math.round(n).toLocaleString('tr-TR') + ' ' + (c === 'EUR' ? '€' : S().currency);
/* Çoklu para birimi toplamları: {TRY, EUR} */
const T0 = () => ({ TRY: 0, EUR: 0 });
const tAdd = (t, c, v) => { t[c === 'EUR' ? 'EUR' : 'TRY'] += v; return t; };
const tMul = (t, k) => ({ TRY: t.TRY * k, EUR: t.EUR * k });
const tZero = t => !Math.round(t.TRY) && !Math.round(t.EUR);
const mt = t => {
  const parts = [];
  if (Math.round(t.EUR)) parts.push(money(t.EUR, 'EUR'));
  if (Math.round(t.TRY) || !parts.length) parts.push(money(t.TRY, 'TRY'));
  return parts.join(' + ');
};
const itemName = it => it.label || TX[it.tx].name;
const itemLine = it => it.free ? (itemTotal(it) ? `<s>${money(itemTotal(it), it.cur)}</s> Ücretsiz` : 'Ücretsiz') : money(itemTotal(it), it.cur);
const cur = () => DB.patients.find(p => p.id === DB.currentId);
const opt = () => { const p = cur(); return p.options[p.activeOption] || p.options[0]; };

function newOption(name) { return { id: uid(), name, items: [], discount: 0, recommended: false, subtitle: '', desc: '', pros: [] }; }
function newPatient() {
  return { id: uid(), name: 'Yeni Hasta', age: '', phone: '', date: today(), doctor: S().doctor, complaint: '', goal: '', info: '', notes: '',
    findings: {}, photo: null, xray: null, options: [newOption('Seçenek A')], activeOption: 0, created: Date.now() };
}

/* ---------- Hesaplar ---------- */
function itemQty(it) { const sc = TX[it.tx].scope; return sc === 'tooth' || sc === 'multi' ? (it.teeth || []).length : 1; }
function itemTotal(it) { return itemQty(it) * (+it.price || 0); }
function optionTotals(o) {
  const sub = T0(), saved = T0();
  o.items.forEach(it => tAdd(it.free ? saved : sub, it.cur, itemTotal(it)));
  const k = 1 - (+o.discount || 0) / 100;
  const total = tMul(sub, k);
  return {
    sub, saved, total, disc: tMul(sub, 1 - k),
    cash: tMul(total, 1 - (+S().cashDiscount || 0) / 100),
    card: tMul(total, 1 - (+S().cardDiscount || 0) / 100)
  };
}
function itemWhere(it) {
  const sc = TX[it.tx].scope;
  if (sc === 'mouth') return 'Tüm ağız';
  if (sc === 'arch') return it.arch === 'upper' ? 'Üst çene' : 'Alt çene';
  return (it.teeth || []).join(', ');
}
function sortedItems(o) {
  return [...o.items].sort((a, b) => (a.phase - b.phase) || (TX_ORDER.indexOf(a.tx) - TX_ORDER.indexOf(b.tx)));
}
function sortTeeth(arr) { return [...arr].sort((a, b) => ALL_TEETH.indexOf(a) - ALL_TEETH.indexOf(b)); }

