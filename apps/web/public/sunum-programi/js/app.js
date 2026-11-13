/* =========================================================
   Editör arayüzü (ortak kısımlar core.js içinde)
   ========================================================= */

/* ---------- Render ---------- */
function renderAll() {
  applyBrand();
  renderPatientSelect();
  renderPatientForm();
  renderPalette();
  renderChart();
  renderPlan();
}

function applyBrand() {
  const s = S();
  document.documentElement.style.setProperty('--accent', s.accent || '#14a39b');
  $('#brandName').textContent = s.clinicName || 'Klinik';
  const logo = $('#brandLogo');
  if (s.logo) { logo.src = s.logo; logo.hidden = false; $('#brandMark').hidden = true; }
  else { logo.hidden = true; $('#brandMark').hidden = false; $('#brandMark').textContent = (s.clinicName || 'K').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase(); }
}

function renderPatientSelect() {
  const sel = $('#patientSelect');
  const list = [...DB.patients].sort((a, b) => (b.created || 0) - (a.created || 0));
  sel.innerHTML = list.map(p => `<option value="${p.id}" ${p.id === DB.currentId ? 'selected' : ''}>${esc(p.name || 'İsimsiz')} — ${esc(fmtDate(p.date))}</option>`).join('');
}

function renderPatientForm() {
  const p = cur();
  $$('#patientPanel [data-f]').forEach(inp => { inp.value = p[inp.dataset.f] ?? ''; });
  $$('.upload').forEach(u => {
    const k = u.dataset.img;
    u.querySelector('.thumb').innerHTML = p[k] ? `<img src="${p[k]}" alt=""><button class="rm" title="Kaldır">✕</button>` : '<em>+ Yükle</em>';
  });
}

function renderPalette() {
  const pal = $('#palette');
  $$('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === UI.mode));
  $('#afterSwitch').style.visibility = UI.mode === 'plan' ? 'visible' : 'hidden';
  if (UI.mode === 'find') {
    pal.innerHTML = FINDING_ORDER.map(k => `<button class="tool ${UI.tool === k ? 'on' : ''}" data-tool="${k}"><i style="background:${FINDINGS[k].color}">${FINDINGS[k].abbr}</i>${FINDINGS[k].name}</button>`).join('')
      + `<button class="tool ${UI.tool === 'sil' ? 'on' : ''}" data-tool="sil"><i style="background:#cfd8dc;color:#37474f">⌫</i>Temizle</button>`;
  } else {
    const groups = [['tooth', 'Dişe uygulanan'], ['multi', 'Çoklu diş'], ['arch', 'Çene'], ['mouth', 'Tüm ağız']];
    pal.innerHTML = groups.map(([sc, label]) => `<div class="pal-group"><span>${label}</span>${TX_ORDER.filter(k => TX[k].scope === sc).map(k =>
      `<button class="tool ${UI.tool === k ? 'on' : ''}" data-tool="${k}"><i style="background:${TX[k].color}">${TX[k].abbr}</i>${TX[k].name}</button>`).join('')}</div>`).join('')
      + `<div class="pal-group"><span>&nbsp;</span><button class="tool ${UI.tool === 'sil' ? 'on' : ''}" data-tool="sil"><i style="background:#cfd8dc;color:#37474f">⌫</i>Dişten kaldır</button></div>`;
  }
  renderHint();
}

function renderHint() {
  const h = $('#hint');
  if (UI.mode === 'find') {
    h.innerHTML = UI.tool === 'sil' ? 'Bulgularını temizlemek istediğiniz dişlere tıklayın.'
      : `<b>${FINDINGS[UI.tool].name}</b> işaretlemek için dişlere tıklayın. Tekrar tıklamak kaldırır.`;
    return;
  }
  if (UI.tool === 'sil') { h.innerHTML = 'Tıkladığınız dişten tüm tedaviler kaldırılır (köprüler listeden silinir).'; return; }
  const t = TX[UI.tool];
  if (t.scope === 'tooth') h.innerHTML = `<b>${t.name}</b> eklemek için dişlere tıklayın. Tekrar tıklamak kaldırır.`;
  if (t.scope === 'arch') h.innerHTML = `<b>${t.name}</b>: üst veya alt çeneden herhangi bir dişe tıklayın.`;
  if (t.scope === 'mouth') h.innerHTML = `<b>${t.name}</b> tüm ağza uygulanır. <button class="btn small primary" id="btnAddMouth">Plana ekle</button>`;
  if (t.scope === 'multi') {
    const sel = sortTeeth(UI.bridgeSel);
    h.innerHTML = `<b>${t.name}</b>: dahil olacak dişleri seçin (destek dişler + eksik dişler). ` +
      (sel.length ? `Seçili: <b>${sel.join(', ')}</b> <button class="btn small primary" id="btnMakeBridge" ${sel.length < 2 ? 'disabled' : ''}>Oluştur (${sel.length} üye)</button> <button class="btn small ghost" id="btnClearSel">Temizle</button>` : '');
  }
}

function chartMarks() {
  const marks = {};
  const push = (n, m) => (marks[n] = marks[n] || []).push(m);
  if (UI.mode === 'find') {
    const f = cur().findings || {};
    Object.entries(f).forEach(([n, list]) => list.forEach(k => push(n, { abbr: FINDINGS[k].abbr, color: FINDINGS[k].color, title: FINDINGS[k].name })));
  } else {
    opt().items.forEach(it => {
      const t = TX[it.tx];
      if (t.scope === 'tooth' || t.scope === 'multi') it.teeth.forEach(n => push(n, { abbr: t.abbr, color: t.color, title: t.name }));
    });
  }
  return marks;
}

function renderChart() {
  const p = cur();
  const before = TEETH.beforeStates(p);
  const showAfter = UI.mode === 'plan' && UI.after;
  const states = showAfter ? TEETH.afterStates(p, opt()) : before;
  $('#chart').innerHTML = TEETH.chartHTML({ states, marks: chartMarks(), selected: UI.bridgeSel, clickable: true });
  $('#chart').classList.toggle('dim', UI.mode === 'plan' && !showAfter);

  // Çene / tüm ağız bandı
  const b = $('#banner');
  if (UI.mode === 'plan') {
    const wide = opt().items.filter(it => ['arch', 'mouth'].includes(TX[it.tx].scope));
    b.innerHTML = wide.map(it => `<span class="chip" style="--c:${TX[it.tx].color}">${TX[it.tx].name} · ${itemWhere(it)}</span>`).join('');
  } else b.innerHTML = '';

  // Lejant
  $('#legend').innerHTML = UI.mode === 'find'
    ? 'Hastanın sağı ekranın solundadır (FDI numaralama).'
    : `<span><i class="lg z"></i>Zirkonyum</span><span><i class="lg v"></i>Lamina</span><span><i class="lg imp"></i>İmplant</span><span><i class="lg c"></i>Kanal dolgusu</span><span><i class="lg g"></i>Eksik</span>`;
}

function renderPlan() {
  const p = cur(), o = opt();
  $('#optTabs').innerHTML = p.options.map((op, i) =>
    `<button class="opt-tab ${i === p.activeOption ? 'on' : ''}" data-i="${i}">${op.recommended ? '★ ' : ''}${esc(op.name)}<small>${mt(optionTotals(op).total)}</small></button>`).join('')
    + `<button class="opt-tab add" id="btnAddOpt" title="Mevcut seçeneği kopyalayarak yeni seçenek oluştur">+ Seçenek</button>`;
  $('#btnRecommend').classList.toggle('on', !!o.recommended);
  $('#btnDelOpt').disabled = p.options.length < 2;

  const items = sortedItems(o);
  if (!items.length) {
    $('#items').innerHTML = `<div class="empty">Henüz tedavi eklenmedi.<br>Ortadaki <b>2 · Tedavi Planı</b> sekmesinden bir tedavi seçip dişlere tıklayın.</div>`;
  } else {
    let lastPhase = 0;
    $('#items').innerHTML = items.map(it => {
      const t = TX[it.tx];
      const head = it.phase !== lastPhase ? `<div class="phase-h" style="--c:${PHASES[it.phase].color}">Faz ${it.phase} · ${PHASES[it.phase].name}</div>` : '';
      lastPhase = it.phase;
      return `${head}<div class="item" data-id="${it.id}">
        <div class="it-top"><span class="dot" style="background:${t.color}"></span><b>${esc(itemName(it))}</b>
          <button class="ic play" title="Animasyonu izle">▶</button><button class="ic del" title="Sil">✕</button></div>
        <div class="it-where">${esc(itemWhere(it))}</div>
        <div class="it-row">
          <select class="it-phase" title="Faz">${[1, 2, 3, 4].map(f => `<option value="${f}" ${f == it.phase ? 'selected' : ''}>Faz ${f}</option>`).join('')}</select>
          <input class="it-price" type="number" min="0" step="any" value="${it.price}" title="Birim fiyat">
          <select class="it-cur" title="Para birimi"><option value="TRY">₺</option><option value="EUR" ${it.cur === 'EUR' ? 'selected' : ''}>€</option></select>
          <span class="qty">× ${itemQty(it)}</span>
          <b class="line">${itemLine(it)}</b>
        </div>
        <div class="it-opts"><label><input type="checkbox" class="it-free" ${it.free ? 'checked' : ''}> Hastaya ücretsiz</label>
          <button class="it-rename" title="Sunumda görünecek adı değiştir">Adını değiştir</button></div></div>`;
    }).join('');
  }
  renderTotals();
}

function renderTotals() {
  const o = opt(), t = optionTotals(o);
  const inst = String(S().installments || '').split(',').map(x => +x.trim()).filter(Boolean);
  $('#totals').innerHTML = `
    <div class="t-row"><span>Ara toplam</span><b>${mt(t.sub)}</b></div>
    <div class="t-row"><span>İndirim <input id="optDiscount" type="number" min="0" max="100" value="${o.discount || 0}">%</span><b>− ${mt(t.disc)}</b></div>
    <div class="t-row total"><span>Toplam</span><b>${mt(t.total)}</b></div>
    ${tZero(t.saved) ? '' : `<div class="t-row gift"><span>Hastaya özel avantaj</span><b>${mt(t.saved)}</b></div>`}
    <div class="t-row soft"><span>Nakit (%${S().cashDiscount} indirim)</span><b>${mt(t.cash)}</b></div>
    <div class="t-row soft"><span>Kartla tek çekim (%${S().cardDiscount} indirim)</span><b>${mt(t.card)}</b></div>
    ${inst.length ? `<div class="t-inst">${inst.map(n => `<span>${n} taksit<b>${mt(tMul(t.total, 1 / n))}</b></span>`).join('')}</div>` : ''}`;
}

/* ---------- Etkileşim: şema ---------- */
function onToothClick(n) {
  const p = cur();
  if (UI.mode === 'find') {
    const f = p.findings || (p.findings = {});
    let list = new Set(f[n] || []);
    if (UI.tool === 'sil') list.clear();
    else if (list.has(UI.tool)) list.delete(UI.tool);
    else {
      if (UI.tool === 'eksik') list.clear();
      else list.delete('eksik');
      if (UI.tool === 'implant') { list.delete('kanalli'); list.delete('curuk'); }
      list.add(UI.tool);
    }
    if (list.size) f[n] = [...list]; else delete f[n];
    save(); renderChart(); return;
  }

  const o = opt();
  if (UI.tool === 'sil') {
    o.items.forEach(it => { if (TX[it.tx].scope === 'tooth') it.teeth = it.teeth.filter(x => x !== n); });
    o.items = o.items.filter(it => !(TX[it.tx].scope === 'tooth' && !it.teeth.length));
    save(); renderChart(); renderPlan(); return;
  }
  const t = TX[UI.tool];
  if (t.scope === 'tooth') {
    let it = o.items.find(x => x.tx === UI.tool);
    if (!it) { it = { id: uid(), tx: UI.tool, teeth: [], price: priceOf(UI.tool), cur: TX[UI.tool].cur || 'TRY', phase: t.phase }; o.items.push(it); }
    it.teeth = it.teeth.includes(n) ? it.teeth.filter(x => x !== n) : sortTeeth([...it.teeth, n]);
    if (!it.teeth.length) o.items = o.items.filter(x => x !== it);
  } else if (t.scope === 'multi') {
    UI.bridgeSel.has(n) ? UI.bridgeSel.delete(n) : UI.bridgeSel.add(n);
    renderHint(); renderChart(); return;
  } else if (t.scope === 'arch') {
    const arch = isUpper(n) ? 'upper' : 'lower';
    const ex = o.items.find(x => x.tx === UI.tool && x.arch === arch);
    if (ex) o.items = o.items.filter(x => x !== ex);
    else o.items.push({ id: uid(), tx: UI.tool, arch, teeth: archTeeth(arch).slice(), price: priceOf(UI.tool), cur: TX[UI.tool].cur || 'TRY', phase: t.phase });
  } else {
    flash('Bu tedavi tüm ağza uygulanır — "Plana ekle" butonunu kullanın.'); return;
  }
  save(); renderChart(); renderPlan();
}

function addMouthItem() {
  const o = opt();
  if (o.items.some(x => x.tx === UI.tool)) { flash('Bu tedavi zaten planda.'); return; }
  o.items.push({ id: uid(), tx: UI.tool, teeth: [], price: priceOf(UI.tool), cur: TX[UI.tool].cur || 'TRY', phase: TX[UI.tool].phase });
  save(); renderChart(); renderPlan();
}

function makeBridge() {
  const sel = sortTeeth(UI.bridgeSel);
  if (sel.length < 2) return;
  if (new Set(sel.map(isUpper)).size > 1) { flash('Köprü dişleri aynı çenede olmalı.'); return; }
  opt().items.push({ id: uid(), tx: UI.tool, teeth: sel, price: priceOf(UI.tool), cur: TX[UI.tool].cur || 'TRY', phase: TX[UI.tool].phase });
  UI.bridgeSel.clear();
  save(); renderHint(); renderChart(); renderPlan();
}

function flash(msg) {
  const d = document.createElement('div'); d.className = 'toast'; d.textContent = msg; document.body.appendChild(d);
  setTimeout(() => d.classList.add('out'), 2200); setTimeout(() => d.remove(), 2700);
}

/* ---------- Modal ---------- */
let modalCleanup = null;
function openModal(title, html, onMount, wide) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  $('#modal').classList.toggle('wide', !!wide);
  $('#modal').classList.remove('hidden');
  modalCleanup = onMount ? onMount($('#modalBody')) : null;
}
function closeModal() {
  if (typeof modalCleanup === 'function') modalCleanup();
  modalCleanup = null;
  $('#modal').classList.add('hidden'); $('#modalBody').innerHTML = '';
}

function previewAnim(tx) {
  const t = TX[tx];
  openModal(t.name, `<div class="prev-wrap"><div class="anim-host"></div><div class="prev-info"><p>${t.desc}</p><ul>${t.benefits.map(b => `<li>${b}</li>`).join('')}</ul><p class="meta">${t.sessions} · ${t.duration}</p></div></div>`,
    body => { const a = ANIM.mount($('.anim-host', body), t.anim, { speed: S().animSpeed }); return () => a.destroy(); }, true);
}

/* ---------- Seçenek açıklaması ---------- */
function editOptionDesc() {
  const o = opt();
  openModal(`${o.name} — sunum metni`, `<div class="settings one">
      <label>Alt başlık<input id="oSub" value="${esc(o.subtitle || '')}" placeholder="ör. Doğal görünüm ve estetiğin ön planda olduğu sabit rehabilitasyon"></label>
      <label>Açıklama<textarea id="oDesc" rows="5">${esc(o.desc || '')}</textarea></label>
      <label>Avantajlar (her satıra bir madde)<textarea id="oPros" rows="6">${esc((o.pros || []).join('\n'))}</textarea></label>
    </div><div class="modal-foot"><button class="btn primary" id="oSave">Kaydet</button></div>`, body => {
    $('#oSave', body).onclick = () => {
      o.subtitle = $('#oSub', body).value.trim(); o.desc = $('#oDesc', body).value.trim();
      o.pros = $('#oPros', body).value.split('\n').map(x => x.trim()).filter(Boolean);
      save(); closeModal(); flash('Seçenek metni kaydedildi');
    };
  });
}

/* ---------- Ayarlar ---------- */
function openSettings() {
  const s = S();
  const rows = TX_ORDER.map(k => `<tr><td><span class="dot" style="background:${TX[k].color}"></span>${TX[k].name}</td>
    <td class="muted">${{ tooth: 'diş başı', multi: 'üye başı', arch: 'çene', mouth: 'tüm ağız' }[TX[k].scope]}</td>
    <td><input type="number" min="0" step="100" data-price="${k}" value="${priceOf(k)}"></td>
    <td><button class="ic play" data-anim="${k}" title="Animasyonu izle">▶</button></td></tr>`).join('');
  openModal('Ayarlar', `
    <div class="settings">
      <section><h4>Klinik</h4>
        <label>Klinik adı<input id="sName" value="${esc(s.clinicName)}"></label>
        <label>Alt başlık<input id="sTag" value="${esc(s.tagline)}"></label>
        <label>Varsayılan hekim<input id="sDoc" value="${esc(s.doctor)}"></label>
        <label>Telefon<input id="sPhone" value="${esc(s.phone)}"></label>
        <label>Adres<input id="sAddr" value="${esc(s.address)}"></label>
        <label>Web / Instagram<input id="sWeb" value="${esc(s.web)}"></label>
        <div class="row2">
          <label>Logo<input type="file" id="sLogo" accept="image/*"></label>
          <label>Kurumsal renk<input type="color" id="sAccent" value="${s.accent}"></label>
        </div>
        ${s.logo ? `<div class="logo-prev"><img src="${s.logo}"><button class="btn small ghost" id="sLogoRm">Logoyu kaldır</button></div>` : ''}
        <h4>Sunum &amp; Ödeme</h4>
        <label class="chk"><input type="checkbox" id="sShowPrices" ${s.showPrices ? 'checked' : ''}> Sunumda fiyatları göster</label>
        <div class="row2">
          <label>Nakit indirim (%)<input type="number" id="sCash" value="${s.cashDiscount}"></label>
          <label>Kart tek çekim indirim (%)<input type="number" id="sCard" value="${s.cardDiscount}"></label>
        </div>
        <label>Para birimi (TL simgesi)<input id="sCur" value="${esc(s.currency)}"></label>
        <label>Taksit seçenekleri (virgülle)<input id="sInst" value="${esc(s.installments)}"></label>
        <label>Animasyon hızı <input type="range" id="sSpeed" min=".5" max="2" step=".25" value="${s.animSpeed}"> <span id="sSpeedV">${s.animSpeed}×</span></label>
      </section>
      <section><h4>Fiyat Listesi</h4>
        <p class="muted">Yeni eklenen tedaviler bu fiyatlarla başlar. Mevcut planlardaki fiyatlar değişmez.</p>
        <table class="price-table">${rows}</table>
        <button class="btn small ghost" id="sResetPrices">Varsayılan fiyatlara dön</button>
      </section>
    </div>
    <div class="modal-foot"><button class="btn primary" id="sSave">Kaydet</button></div>`,
  body => {
    $('#sSpeed', body).oninput = e => $('#sSpeedV', body).textContent = e.target.value + '×';
    $('#sResetPrices', body).onclick = () => $$('[data-price]', body).forEach(i => i.value = TX[i.dataset.price].price);
    $$('[data-anim]', body).forEach(b => b.onclick = () => previewAnim(b.dataset.anim));
    const rm = $('#sLogoRm', body); if (rm) rm.onclick = () => { s.logo = null; save(); applyBrand(); rm.parentElement.remove(); };
    $('#sSave', body).onclick = async () => {
      Object.assign(s, {
        clinicName: $('#sName', body).value.trim(), tagline: $('#sTag', body).value.trim(), doctor: $('#sDoc', body).value.trim(),
        phone: $('#sPhone', body).value.trim(), address: $('#sAddr', body).value.trim(), web: $('#sWeb', body).value.trim(),
        accent: $('#sAccent', body).value, showPrices: $('#sShowPrices', body).checked, cashDiscount: +$('#sCash', body).value || 0, cardDiscount: +$('#sCard', body).value || 0,
        currency: $('#sCur', body).value.trim() || '₺', installments: $('#sInst', body).value, animSpeed: +$('#sSpeed', body).value || 1
      });
      $$('[data-price]', body).forEach(i => {
        const k = i.dataset.price, v = +i.value;
        if (v === TX[k].price) delete s.prices[k]; else s.prices[k] = v;
      });
      const f = $('#sLogo', body).files[0];
      if (f) s.logo = await readImage(f, 600, 'image/png');
      save(); closeModal(); renderAll(); flash('Ayarlar kaydedildi');
    };
  }, true);
}

/* ---------- Görseller ---------- */
function readImage(file, max = 1400, type = 'image/jpeg') {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        res(cv.toDataURL(type, .84));
      };
      img.onerror = rej; img.src = fr.result;
    };
    fr.onerror = rej; fr.readAsDataURL(file);
  });
}

/* ---------- Yedekleme ---------- */
function exportAll() {
  const blob = new Blob([JSON.stringify(DB, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `tedavi-plani-yedek-${today()}.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function importFile(file) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const d = JSON.parse(fr.result);
      if (!d.patients) throw new Error();
      const ids = new Set(DB.patients.map(p => p.id));
      let add = 0, upd = 0;
      d.patients.forEach(p => {
        if (ids.has(p.id)) { DB.patients[DB.patients.findIndex(x => x.id === p.id)] = p; upd++; } else { DB.patients.push(p); add++; }
      });
      if (d.settings && confirm('Yedekteki klinik ayarları ve fiyat listesi de yüklensin mi?')) DB.settings = { ...DEFAULT_SETTINGS, ...d.settings };
      save(); renderAll(); flash(`${add} hasta eklendi, ${upd} hasta güncellendi`);
    } catch (e) { alert('Dosya okunamadı. Lütfen bu programdan alınmış bir yedek dosyası seçin.'); }
  };
  fr.readAsText(file);
}

/* ---------- Hastaya gönderilecek tek dosya ---------- */
function exportForPatient() {
  const p = cur(), B = window.VIEWER_BUNDLE;
  if (!B) { alert('Görüntüleyici paketi bulunamadı (js/viewer-bundle.js).'); return; }
  if (!p.options.some(o => o.items.length)) { flash('Önce tedavi planı ekleyin.'); return; }
  const settings = JSON.parse(JSON.stringify(S()));
  if (settings.logo === DEFAULT_SETTINGS.logo) settings.logo = B.logo;
  const pt = JSON.parse(JSON.stringify(p));
  delete pt.notes; delete pt.phone;           // hekime özel notlar ve telefon dosyaya girmez
  const embed = { settings, patients: [pt], currentId: pt.id };
  const safe = s => String(s).replace(/</g, '\\u003c');
  const html = `<!doctype html>
<html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(p.name)} · Tedavi Planı · ${esc(settings.clinicName)}</title>
<style>${B.css}</style></head>
<body class="viewer presenting">
${B.presentHTML}
<script>window.__EMBED__ = ${safe(JSON.stringify(embed))};<\/script>
<script>${B.js}<\/script>
</body></html>`;
  const name = ('Tedavi-Plani-' + (p.name || 'Hasta')).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i').replace(/İ/g, 'I').replace(/[^A-Za-z0-9-]+/g, '-').replace(/-+/g, '-');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  a.download = name + '.html';
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  openModal('Hastaya gönderilecek dosya hazır', `<div class="send-info">
    <p><b>${esc(a.download)}</b> İndirilenler klasörüne kaydedildi (${Math.round(html.length / 1024)} KB).</p>
    <ol><li>WhatsApp'ta hastanın sohbetini açın → <b>📎 → Belge</b> → bu dosyayı seçin. E-posta eki olarak da gönderebilirsiniz.</li>
    <li>Hasta dosyaya dokunduğunda sunum tarayıcıda açılır; parmakla sağa-sola kaydırarak ilerler.</li>
    <li><b>iPhone:</b> Dosya önizlemede açılırsa animasyonlar oynamayabilir. Hastaya <b>Paylaş → Safari'de aç</b> (veya “Dosyalar'a kaydet” → dosyaya dokun) demesini söyleyin.</li></ol>
    <p class="muted">Dosyaya hekim notu ve telefon numarası eklenmez. Sağlık verisi içerdiği için yalnızca hastanın kendisine gönderin.</p></div>`);
}

/* ---------- Yazdırma ---------- */
function printPlan() {
  const p = cur(), o = opt(), s = S(), t = optionTotals(o);
  const after = TEETH.afterStates(p, o);
  const rows = sortedItems(o).map(it => `<tr><td>Faz ${it.phase}</td><td>${esc(itemName(it))}</td><td>${esc(itemWhere(it))}</td><td class="r">${itemQty(it)}</td><td class="r">${money(it.price, it.cur)}</td><td class="r">${itemLine(it)}</td></tr>`).join('');
  const others = p.options.length > 1 ? `<h3>Diğer seçenekler</h3><table>${p.options.filter(x => x !== o).map(x => `<tr><td>${esc(x.name)}</td><td class="r">${mt(optionTotals(x).total)}</td></tr>`).join('')}</table>` : '';
  $('#printView').innerHTML = `
    <div class="pv-head">${s.logo ? `<img src="${s.logo}">` : ''}<div><h1>${esc(s.clinicName)}</h1><p>${esc(s.tagline)}</p></div>
      <div class="pv-meta">${esc(s.phone)}<br>${esc(s.address)}<br>${esc(s.web)}</div></div>
    <h2>Tedavi Planı — ${esc(o.name)}</h2>
    <table class="pv-info"><tr><td><b>Hasta:</b> ${esc(p.name)}</td><td><b>Yaş:</b> ${esc(p.age)}</td><td><b>Tarih:</b> ${fmtDate(p.date)}</td><td><b>Hekim:</b> ${esc(p.doctor)}</td></tr></table>
    <div class="pv-charts"><div><h4>Mevcut durum</h4><div class="chart">${TEETH.chartHTML({ states: TEETH.beforeStates(p) })}</div></div>
      <div><h4>Tedavi sonrası</h4><div class="chart">${TEETH.chartHTML({ states: after })}</div></div></div>
    <table class="pv-items"><thead><tr><th>Faz</th><th>Tedavi</th><th>Bölge / Diş</th><th class="r">Adet</th><th class="r">Birim</th><th class="r">Tutar</th></tr></thead><tbody>${rows}</tbody>
      <tfoot><tr><td colspan="5" class="r">Ara toplam</td><td class="r">${mt(t.sub)}</td></tr>
      ${o.discount ? `<tr><td colspan="5" class="r">İndirim (%${o.discount})</td><td class="r">− ${mt(t.disc)}</td></tr>` : ''}
      <tr class="tot"><td colspan="5" class="r">Toplam</td><td class="r">${mt(t.total)}</td></tr>
      ${tZero(t.saved) ? '' : `<tr><td colspan="5" class="r">Hastaya özel avantaj (ücretsiz işlemler)</td><td class="r">${mt(t.saved)}</td></tr>`}
      <tr><td colspan="5" class="r">Nakit ödemede (%${s.cashDiscount} indirim)</td><td class="r">${mt(t.cash)}</td></tr>
      <tr><td colspan="5" class="r">Kartla tek çekimde (%${s.cardDiscount} indirim)</td><td class="r">${mt(t.card)}</td></tr></tfoot></table>
    ${others}
    ${p.info ? `<h3>Önemli bilgiler</h3><ul class="pv-info-list">${p.info.split('\n').filter(x => x.trim()).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <p class="pv-note">Bu plan muayene ve radyografik değerlendirme bulgularına göre hazırlanmıştır. Tedavi sürecinde klinik gerekliliklere göre değişiklik gösterebilir. Fiyat geçerlilik süresi: 30 gün.</p>
    <div class="pv-sign"><div>Hasta / Veli<br><br>İmza</div><div>Hekim<br>${esc(p.doctor)}<br>İmza</div></div>`;
  window.print();
}

/* ---------- Olaylar ---------- */
function bind() {
  $('#patientSelect').onchange = e => { DB.currentId = e.target.value; UI.bridgeSel.clear(); save(); renderAll(); };
  $('#btnNewPatient').onclick = () => {
    const p = newPatient(); DB.patients.push(p); DB.currentId = p.id; UI.mode = 'find'; UI.tool = 'curuk'; UI.after = false;
    $('#chkAfter').checked = false; save(); renderAll(); $('[data-f="name"]').select();
  };
  $('#btnDeletePatient').onclick = () => {
    const p = cur();
    if (!confirm(`"${p.name}" ve tüm planları silinsin mi? Bu işlem geri alınamaz.`)) return;
    DB.patients = DB.patients.filter(x => x !== p);
    if (!DB.patients.length) DB.patients.push(newPatient());
    DB.currentId = DB.patients[DB.patients.length - 1].id; save(); renderAll();
  };
  $$('#patientPanel [data-f]').forEach(inp => inp.addEventListener('input', () => {
    cur()[inp.dataset.f] = inp.value; save();
    if (inp.dataset.f === 'name' || inp.dataset.f === 'date') renderPatientSelect();
  }));
  $$('.upload').forEach(u => {
    const input = $('input', u);
    u.addEventListener('click', e => {
      if (e.target.classList.contains('rm')) { cur()[u.dataset.img] = null; save(); renderPatientForm(); return; }
      if (e.target !== input) input.click();
    });
    input.onchange = async () => { const f = input.files[0]; if (!f) return; cur()[u.dataset.img] = await readImage(f); input.value = ''; save(); renderPatientForm(); };
  });

  $('#modeSeg').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    UI.mode = b.dataset.mode; UI.tool = UI.mode === 'find' ? 'curuk' : 'dolgu'; UI.bridgeSel.clear();
    renderPalette(); renderChart();
  };
  $('#chkAfter').onchange = e => { UI.after = e.target.checked; renderChart(); };
  $('#palette').onclick = e => {
    const b = e.target.closest('[data-tool]'); if (!b) return;
    UI.tool = b.dataset.tool; UI.bridgeSel.clear(); renderPalette(); renderChart();
  };
  $('#hint').onclick = e => {
    if (e.target.id === 'btnAddMouth') addMouthItem();
    if (e.target.id === 'btnMakeBridge') makeBridge();
    if (e.target.id === 'btnClearSel') { UI.bridgeSel.clear(); renderHint(); renderChart(); }
  };
  $('#chart').onclick = e => { const t = e.target.closest('.tooth'); if (t) onToothClick(+t.dataset.n); };

  // Plan paneli
  $('#optTabs').onclick = e => {
    const p = cur();
    if (e.target.closest('#btnAddOpt')) {
      const copy = JSON.parse(JSON.stringify(opt()));
      copy.id = uid(); copy.recommended = false; copy.items.forEach(it => it.id = uid());
      copy.name = 'Seçenek ' + String.fromCharCode(65 + p.options.length);
      p.options.push(copy); p.activeOption = p.options.length - 1;
    } else {
      const b = e.target.closest('.opt-tab'); if (!b) return;
      p.activeOption = +b.dataset.i;
    }
    save(); renderChart(); renderPlan();
  };
  $('#optTabs').ondblclick = e => { if (e.target.closest('.opt-tab:not(.add)')) $('#btnRenameOpt').click(); };
  $('#btnRenameOpt').onclick = () => { const n = prompt('Seçenek adı (ör. "Ekonomik", "Premium Estetik"):', opt().name); if (n) { opt().name = n.trim(); save(); renderPlan(); } };
  $('#btnOptDesc').onclick = editOptionDesc;
  $('#btnRecommend').onclick = () => { const o = opt(); const v = !o.recommended; cur().options.forEach(x => x.recommended = false); o.recommended = v; save(); renderPlan(); };
  $('#btnDelOpt').onclick = () => {
    const p = cur(); if (p.options.length < 2) return;
    if (!confirm(`"${opt().name}" silinsin mi?`)) return;
    p.options.splice(p.activeOption, 1); p.activeOption = 0; save(); renderChart(); renderPlan();
  };
  $('#items').onclick = e => {
    const row = e.target.closest('.item'); if (!row) return;
    const o = opt(), it = o.items.find(x => x.id === row.dataset.id);
    if (e.target.closest('.del')) { o.items = o.items.filter(x => x !== it); save(); renderChart(); renderPlan(); }
    if (e.target.closest('.play')) previewAnim(it.tx);
    if (e.target.closest('.it-rename')) { const n = prompt('Sunumda görünecek ad:', itemName(it)); if (n !== null) { it.label = n.trim() && n.trim() !== TX[it.tx].name ? n.trim() : ''; save(); renderPlan(); } }
  };
  $('#items').onchange = e => {
    const row = e.target.closest('.item'); if (!row) return;
    const it = opt().items.find(x => x.id === row.dataset.id);
    if (e.target.classList.contains('it-phase')) { it.phase = +e.target.value; save(); renderPlan(); }
    if (e.target.classList.contains('it-cur')) { it.cur = e.target.value; save(); renderPlan(); }
    if (e.target.classList.contains('it-free')) { it.free = e.target.checked; save(); renderPlan(); }
  };
  $('#items').oninput = e => {
    const row = e.target.closest('.item'); if (!row) return;
    const it = opt().items.find(x => x.id === row.dataset.id);
    if (e.target.classList.contains('it-price')) {
      it.price = +e.target.value || 0; save();
      $('.line', row).innerHTML = itemLine(it); renderTotals();
      $$('.opt-tab small')[cur().activeOption].textContent = mt(optionTotals(opt()).total);
    }
  };
  $('#totals').oninput = e => {
    if (e.target.id === 'optDiscount') {
      opt().discount = Math.min(100, Math.max(0, +e.target.value || 0)); save();
      const pos = e.target.selectionStart; renderTotals();
      const inp = $('#optDiscount'); inp.focus(); try { inp.setSelectionRange(pos, pos); } catch (er) { /* number input */ }
      $$('.opt-tab small')[cur().activeOption].textContent = mt(optionTotals(opt()).total);
    }
  };

  $('#btnSettings').onclick = openSettings;
  $('#btnExport').onclick = exportAll;
  $('#importFile').onchange = e => { const f = e.target.files[0]; if (f) importFile(f); e.target.value = ''; };
  $('#btnPrint').onclick = printPlan;
  $('#btnSend').onclick = exportForPatient;
  $('#btnPresent').onclick = () => {
    if (!opt().items.length && !Object.keys(cur().findings || {}).length) { flash('Önce bulgu veya tedavi ekleyin.'); return; }
    PRESENT.open(cur());
  };
  $('#modalClose').onclick = closeModal;
  $('#modal').onclick = e => { if (e.target.id === 'modal') closeModal(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) closeModal(); });
}

/* ---------- Başlat ---------- */
(function init() {
  if (!DB.patients.length) {
    const p = newPatient(); p.name = 'Örnek Hasta';
    p.findings = { 16: ['curuk'], 26: ['iltihap', 'curuk'], 36: ['eksik'], 46: ['kirik'], 11: ['kirik'], 21: ['dolgu'], 47: ['kanalli'] };
    p.options[0].items = [
      { id: uid(), tx: 'detartraj', teeth: [], price: priceOf('detartraj'), phase: 1 },
      { id: uid(), tx: 'dolgu', teeth: [16], price: priceOf('dolgu'), phase: 1 },
      { id: uid(), tx: 'kanal', teeth: [26], price: priceOf('kanal'), phase: 1 },
      { id: uid(), tx: 'implant', teeth: [36], price: priceOf('implant'), phase: 2 },
      { id: uid(), tx: 'implantustu', teeth: [36], price: priceOf('implantustu'), phase: 3 },
      { id: uid(), tx: 'kron', teeth: [26, 46], price: priceOf('kron'), phase: 3 },
      { id: uid(), tx: 'lamina', teeth: [12, 11, 21, 22], price: priceOf('lamina'), phase: 3 }
    ];
    p.options[0].name = 'İmplant Çözümü'; p.options[0].recommended = true;
    const b = JSON.parse(JSON.stringify(p.options[0]));
    b.id = uid(); b.name = 'Köprü Çözümü'; b.recommended = false;
    b.items = b.items.filter(it => !['implant', 'implantustu'].includes(it.tx)).map(it => ({ ...it, id: uid() }));
    b.items.push({ id: uid(), tx: 'kopru', teeth: [37, 36, 35], price: priceOf('kopru'), phase: 3 });
    p.options.push(b);
    p.complaint = 'Sol alt bölgede eksik diş nedeniyle çiğneme zorluğu, ön dişlerin renginden memnun değil.';
    DB.patients.push(p);
  }
  if (!cur()) DB.currentId = DB.patients[DB.patients.length - 1].id;
  bind(); renderAll(); save();
})();
