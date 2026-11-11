/* =========================================================
   Sunum modu: hastaya tam ekran animasyonlu anlatım
   ========================================================= */

const PRESENT = (() => {
  let slides = [], idx = 0, patient = null, option = null, leave = null, dir = 1;
  const $ = (s, r = document) => r.querySelector(s);

  const clinicHead = () => {
    const s = DB.settings;
    return `<div class="s-brand">${s.logo ? `<img src="${s.logo}" alt="">` : `<span class="mk">${esc((s.clinicName || 'K').split(/\s+/).map(w => w[0]).slice(0, 2).join(''))}</span>`}<span>${esc(s.clinicName)}</span></div>`;
  };
  const head = (kicker, title) => `${clinicHead()}<div class="s-head"><span class="kicker">${kicker}</span><h2>${title}</h2></div>`;

  /* Tedavileri türe göre grupla */
  function groups(o) {
    const map = new Map();
    sortedItems(o).forEach(it => {
      if (!map.has(it.tx)) map.set(it.tx, { tx: it.tx, items: [], phase: it.phase });
      map.get(it.tx).items.push(it);
    });
    return [...map.values()];
  }
  /* Birden fazla seçenek varsa tüm seçeneklerdeki tedaviler (tekrarsız) */
  function allGroups(opts) {
    const map = new Map();
    opts.forEach(o => groups(o).forEach(g => { if (!map.has(g.tx)) map.set(g.tx, g); }));
    return [...map.values()].sort((a, b) => (a.phase - b.phase) || (TX_ORDER.indexOf(a.tx) - TX_ORDER.indexOf(b.tx)));
  }
  const groupWhere = g => {
    const sc = TX[g.tx].scope;
    if (sc === 'mouth') return 'Tüm ağız';
    if (sc === 'arch') return [...new Set(g.items.map(it => it.arch === 'upper' ? 'Üst çene' : 'Alt çene'))].join(' + ');
    if (sc === 'multi') {
      const n = g.items.reduce((a, it) => a + it.teeth.length, 0);
      return g.items.length > 1 ? `${n} üye · ` + g.items.map(it => it.teeth.join('-')).join(' / ') : it0(g).teeth.join('-');
    }
    const t = g.items.flatMap(it => it.teeth);
    return t.length > 6 ? `${t.length} diş · ${t.join(', ')}` : t.join(', ');
  };
  const it0 = g => g.items[0];
  const totAttr = t => `data-tot='${JSON.stringify(t)}'`;

  function countUp(root) {
    root.querySelectorAll('[data-tot]').forEach(el => {
      const target = JSON.parse(el.dataset.tot), t0 = performance.now(), d = 1300;
      const tick = t => {
        const k = Math.min(1, (t - t0) / d), e = 1 - Math.pow(1 - k, 3);
        el.textContent = mt(tMul(target, e));
        if (k < 1 && el.isConnected) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }
  const lines = txt => String(txt || '').split('\n').map(x => x.trim()).filter(Boolean);

  /* ---------- Slaytlar ---------- */
  function build() {
    const s = DB.settings, p = patient, o = option;
    const list = [];
    const findings = p.findings || {};
    const opts = p.options.filter(x => x.items.length);
    const multi = opts.length > 1;
    const gs = multi ? allGroups(opts) : groups(o);

    // 1. Kapak
    list.push({
      cls: 'cover', html: `
        <div class="cover-deco"><span></span><span></span><span></span></div>
        <div class="cover-in">
          ${s.logo ? `<img class="cover-logo" src="${s.logo}" alt="">` : `<div class="cover-mark">${esc(s.clinicName)}</div>`}
          <p class="cover-kicker">${esc(s.tagline || '')}</p>
          <h1>Kişisel Tedavi Planınız</h1>
          <div class="cover-name">${esc(p.name)}</div>
          <p class="cover-meta">${fmtDate(p.date)}${p.doctor ? ' · ' + esc(p.doctor) : ''}${multi ? ` · ${opts.length} tedavi seçeneği` : ''}</p>
        </div>`
    });

    // 2. Hedef / beklenti / görseller
    if (p.complaint || p.goal || p.photo || p.xray) {
      list.push({
        cls: 'photos', html: `${head('Başlangıç noktamız', p.goal ? 'Tedavi Hedefimiz' : 'Mevcut Durumunuz')}
          ${p.complaint ? `<blockquote class="s-quote">“${esc(p.complaint)}”</blockquote>` : ''}
          ${p.goal ? `<p class="s-goal">${esc(p.goal)}</p><div class="goal-tags"><span>Estetik</span><span>Fonksiyon</span><span>Konfor</span><span>Kişiye özel planlama</span></div>` : ''}
          <div class="s-imgs">${p.photo ? `<figure><img src="${p.photo}"><figcaption>Gülüşünüz</figcaption></figure>` : ''}${p.xray ? `<figure><img src="${p.xray}"><figcaption>Panoramik röntgen</figcaption></figure>` : ''}</div>`
      });
    }

    // 3. Bulgular
    const fCount = {};
    Object.entries(findings).forEach(([n, l]) => l.forEach(k => (fCount[k] = fCount[k] || []).push(+n)));
    const problemKeys = FINDING_ORDER.filter(k => fCount[k]);
    if (problemKeys.length) {
      const marks = {};
      Object.entries(findings).forEach(([n, l]) => marks[n] = l.map(k => ({ abbr: FINDINGS[k].abbr, color: FINDINGS[k].color })));
      const ext = (opts[0] || o).items.filter(it => it.tx === 'cekim').flatMap(it => it.teeth);
      list.push({
        cls: 'findings', html: `${head('Muayene bulguları', 'Ağız İçi Değerlendirme')}
          <div class="s-split">
            <div class="s-chart pulse-found">${TEETH.chartHTML({ states: TEETH.beforeStates(p), marks })}</div>
            <ul class="f-list">${problemKeys.map((k, i) => `<li style="--d:${i}"><i style="background:${FINDINGS[k].color}">${FINDINGS[k].abbr}</i><div><b>${FINDINGS[k].name}</b><small>${sortTeeth(fCount[k]).join(', ')}</small></div><span class="n">${fCount[k].length}</span></li>`).join('')}
            ${ext.length ? `<li class="hl" style="--d:${problemKeys.length}"><i style="background:${TX.cekim.color}">ÇKM</i><div><b>Çekimi planlanan diş</b><small>Kurtarılması öngörülmeyen dişler</small></div><span class="n">${ext.length}</span></li>` : ''}</ul>
          </div>`,
        enter: el => { el.querySelectorAll('.tooth').forEach(t => { if (findings[t.dataset.n]) t.classList.add('found'); }); }
      });
    }

    const baToggle = (el, delay = 1600) => {
      const chart = el.querySelector('.chart-inner');
      const set = v => { chart.classList.toggle('show-after', v); el.querySelectorAll('[data-ba]').forEach(b => b.classList.toggle('on', (+b.dataset.ba === 1) === v)); };
      el.querySelectorAll('[data-ba]').forEach(b => b.onclick = () => set(b.dataset.ba === '1'));
      const t = setTimeout(() => set(true), delay);
      return () => clearTimeout(t);
    };

    // 4. Tek seçenek: plan özeti / Çok seçenek: tanıtım
    if (!multi && gs.length) {
      list.push({
        cls: 'overview', html: `${head(esc(o.name), 'Önerilen Tedavi Planı')}
          <div class="ba-toggle"><button data-ba="0" class="on">Önce</button><button data-ba="1">Sonra</button></div>
          <div class="s-chart big">${TEETH.chartHTML({ states: TEETH.beforeStates(p), compare: TEETH.afterStates(p, o) })}</div>
          <div class="ov-chips">${gs.map((g, i) => `<span class="chip" style="--c:${TX[g.tx].color};--d:${i}">${TX[g.tx].name}<small>${esc(groupWhere(g))}</small></span>`).join('')}</div>`,
        enter: el => baToggle(el)
      });
    }
    if (multi) {
      list.push({
        cls: 'intro-opts', html: `${head('Size özel', `${opts.length} Farklı Tedavi Yolu`)}
          <div class="io">${opts.map((x, i) => `<div class="io-card" style="--d:${i}"><span class="io-n">${i + 1}</span><div><h3>${esc(x.name)}</h3><p>${esc(x.subtitle || groups(x).map(g => TX[g.tx].name).join(' · '))}</p></div></div>`).join('')}</div>
          <p class="io-note">Tüm seçeneklerde kalıcı dişler <b>sabit</b> olarak planlanmıştır.</p>`
      });
    }

    // 5. Tedavi animasyonları
    gs.forEach(g => {
      const t = TX[g.tx], ph = PHASES[g.phase];
      const qty = g.items.reduce((a, it) => a + itemQty(it), 0);
      const free = g.items.every(it => it.free);
      const tot = g.items.reduce((a, it) => tAdd(a, it.cur, itemTotal(it)), T0());
      const unitWord = { tooth: 'diş', multi: 'üye', arch: 'çene', mouth: '' }[t.scope];
      const marks = {};
      if (t.scope === 'tooth' || t.scope === 'multi') g.items.forEach(it => it.teeth.forEach(n => marks[n] = [{ abbr: t.abbr, color: t.color }]));
      const title = g.items.length === 1 && g.items[0].label && t.scope !== 'multi' ? g.items[0].label : t.name;
      const priceBox = free ? `<div class="free"><small>Ücret</small><b>Ücretsiz</b></div>`
        : (!multi && s.showPrices ? `<div><small>${qty > 1 && unitWord ? `${qty} ${unitWord}` : 'Tutar'}</small><b>${mt(tot)}</b></div>` : '');
      list.push({
        cls: 'tx', html: `${clinicHead()}
          <div class="tx-grid">
            <div class="tx-anim"></div>
            <div class="tx-info">
              <span class="kicker" style="color:${ph.color}">Faz ${g.phase} · ${ph.name}</span>
              <h2>${esc(title)}</h2>
              <div class="tx-where"><span style="background:${t.color}">${t.abbr}</span>${esc(groupWhere(g))}</div>
              <p class="tx-desc">${t.desc}</p>
              <ul class="tx-ben">${t.benefits.map((b, i) => `<li style="--d:${i}">${b}</li>`).join('')}</ul>
              <div class="tx-meta">
                <div><small>Seans</small><b>${t.sessions}</b></div>
                <div><small>Süre</small><b>${t.duration}</b></div>
                ${priceBox}
              </div>
              ${(t.scope === 'tooth' || t.scope === 'multi') ? `<div class="tx-mini">${TEETH.chartHTML({ states: TEETH.beforeStates(p), marks })}</div>` : ''}
            </div>
          </div>`,
        enter: el => {
          el.querySelectorAll('.tx-mini .tooth').forEach(b => { if (marks[b.dataset.n]) b.classList.add('found'); });
          const a = ANIM.mount(el.querySelector('.tx-anim'), t.anim, { speed: s.animSpeed });
          return () => a.destroy();
        }
      });
    });

    // 6. Her seçenek için ayrıntı slaytı
    if (multi) {
      opts.forEach((x, i) => {
        const tt = optionTotals(x);
        const kapsam = sortedItems(x).map(it => `<li><i style="background:${TX[it.tx].color}"></i><span>${esc(itemName(it))}</span><small>${esc(itemWhere(it).length > 40 ? TX[it.tx].scope === 'tooth' || TX[it.tx].scope === 'multi' ? it.teeth.length + (TX[it.tx].scope === 'multi' ? ' üye' : ' diş') : itemWhere(it) : itemWhere(it))}</small>${it.free ? '<em>Ücretsiz</em>' : ''}</li>`).join('');
        list.push({
          cls: 'option', html: `${head(`Tedavi seçeneği ${i + 1}`, esc(x.subtitle || x.name))}
            <div class="opt-grid">
              <div>
                <div class="ba-toggle"><button data-ba="0" class="on">Önce</button><button data-ba="1">Sonra</button></div>
                <div class="s-chart">${TEETH.chartHTML({ states: TEETH.beforeStates(p), compare: TEETH.afterStates(p, x) })}</div>
                ${x.desc ? `<p class="opt-desc">${esc(x.desc)}</p>` : ''}
              </div>
              <div class="opt-side">
                ${x.pros && x.pros.length ? `<h4>Bu seçeneğin avantajları</h4><ul class="tx-ben">${x.pros.map((b, k) => `<li style="--d:${k}">${esc(b)}</li>`).join('')}</ul>` : ''}
                <h4>Tedavi kapsamı</h4><ul class="kapsam">${kapsam}</ul>
                ${s.showPrices ? `<div class="opt-price"><small>Toplam tedavi bedeli</small><b ${totAttr(tt.total)}>${mt(tt.total)}</b></div>` : ''}
              </div>
            </div>`,
          enter: el => { countUp(el); return baToggle(el, 1800); }
        });
      });
    }

    // 7. Süreç
    const byPhase = [1, 2, 3, 4].map(f => ({ f, gs: gs.filter(g => g.phase === f) })).filter(x => x.gs.length);
    if (byPhase.length) {
      list.push({
        cls: 'timeline', html: `${head('Adım adım', 'Tedavi Sürecimiz')}
          <div class="tl">${byPhase.map((x, i) => `
            <div class="tl-col" style="--c:${PHASES[x.f].color};--d:${i}">
              <div class="tl-node">${x.f}</div>
              <h3>${PHASES[x.f].name}</h3><p>${PHASES[x.f].desc}</p>
              <ul>${x.gs.map(g => `<li><i style="background:${TX[g.tx].color}"></i><div><b>${TX[g.tx].name}</b><small>${TX[g.tx].duration}</small></div></li>`).join('')}</ul>
            </div>`).join('')}<div class="tl-line"></div></div>`
      });
    }

    // 8. Avantajlar (ücretsiz işlemler)
    const freeItems = (opts[0] || o).items.filter(it => it.free);
    if (freeItems.length) {
      const saved = optionTotals(opts[0] || o).saved;
      list.push({
        cls: 'gift', html: `${head('Size özel', 'Tedavi Avantajlarınız')}
          <div class="gift">${freeItems.map((it, i) => `<div class="gift-card" style="--d:${i}"><span class="gift-ic">🎁</span><div><b>${esc(itemName(it))}${TX[it.tx].scope === 'arch' ? ' · ' + itemWhere(it) : ''}</b>
            <small>${itemTotal(it) ? `${itemQty(it)} × ${money(it.price, it.cur)} = <s>${money(itemTotal(it), it.cur)}</s>` : 'Tedavi kapsamında'}</small></div><em>ÜCRETSİZ</em></div>`).join('')}</div>
          ${tZero(saved) ? '' : `<div class="gift-sum"><span>Toplam avantajınız</span><b ${totAttr(saved)}>${mt(saved)}</b></div>`}
          ${multi ? '<p class="io-note">Bu avantajlar tüm tedavi seçeneklerinde geçerlidir.</p>' : ''}`,
        enter: el => countUp(el)
      });
    }

    // 9. Karşılaştırma / maliyet ve ödeme
    if (s.showPrices) {
      if (multi) {
        list.push({
          cls: 'compare', html: `${head('Size uygun çözüm', 'Seçeneklerin Karşılaştırılması')}
            <div class="cmp">${opts.map((x, i) => {
              const tt = optionTotals(x);
              return `<div class="cmp-card ${x.recommended ? 'rec' : ''}" style="--d:${i}">
                ${x.recommended ? '<span class="rec-b">★ Hekim önerisi</span>' : ''}
                <span class="kicker">Seçenek ${i + 1}</span>
                <h3>${esc(x.subtitle || x.name)}</h3>
                <ul>${sortedItems(x).filter(it => !it.free).map(it => `<li><i style="background:${TX[it.tx].color}"></i>${esc(itemName(it))}<small>${itemQty(it) > 1 ? itemQty(it) + ' × ' + money(it.price, it.cur) + ' = ' : ''}${money(itemTotal(it), it.cur)}</small></li>`).join('')}
                  ${sortedItems(x).filter(it => it.free).map(it => `<li class="fr"><i></i>${esc(itemName(it))}${TX[it.tx].scope === 'arch' ? ' · ' + itemWhere(it) : ''}<small>Ücretsiz</small></li>`).join('')}</ul>
                <div class="cmp-price">${x.discount ? `<s>${mt(tt.sub)}</s>` : ''}<small>Toplam tedavi bedeli</small><b ${totAttr(tt.total)}>${mt(tt.total)}</b></div>
              </div>`;
            }).join('')}</div>`,
          enter: el => countUp(el)
        });
      } else {
        const tt = optionTotals(o);
        list.push({
          cls: 'cost', html: `${head(esc(o.name), 'Tedavi Maliyeti')}
            <div class="cost">
              <table>${sortedItems(o).map((it, i) => `<tr style="--d:${i}"><td><i style="background:${TX[it.tx].color}"></i>${esc(itemName(it))}</td><td class="w">${esc(itemWhere(it))}</td><td class="r">${itemQty(it)} × ${money(it.price, it.cur)}</td><td class="r b">${itemLine(it)}</td></tr>`).join('')}</table>
              <div class="cost-sum">${o.discount ? `<div><span>Ara toplam</span><s>${mt(tt.sub)}</s></div><div><span>İndirim %${o.discount}</span><b>− ${mt(tt.disc)}</b></div>` : ''}
                <div class="big"><span>Toplam</span><b ${totAttr(tt.total)}>${mt(tt.total)}</b></div></div>
            </div>`,
          enter: el => countUp(el)
        });
      }

      // Ödeme
      const inst = String(s.installments || '').split(',').map(x => +x.trim()).filter(Boolean);
      const payFor = x => {
        const tt = optionTotals(x);
        return `<div class="pay-block">${multi ? `<h3>${esc(x.subtitle || x.name)}</h3>` : ''}
          <div class="pay" style="--n:${2 + inst.length}">
            <div class="pay-card cash" style="--d:0"><small>Nakit · %${s.cashDiscount} indirim</small><b ${totAttr(tt.cash)}>${mt(tt.cash)}</b><span>Kazancınız: ${mt(tMul(tt.total, s.cashDiscount / 100))}</span></div>
            <div class="pay-card card1" style="--d:1"><small>Kartla tek çekim · %${s.cardDiscount} indirim</small><b ${totAttr(tt.card)}>${mt(tt.card)}</b><span>Kazancınız: ${mt(tMul(tt.total, s.cardDiscount / 100))}</span></div>
            ${inst.map((n, i) => `<div class="pay-card" style="--d:${i + 2}"><small>${n} taksit</small><b>${mt(tMul(tt.total, 1 / n))}</b><span>/ ay</span></div>`).join('')}
          </div></div>`;
      };
      (multi ? opts : [o]).forEach((x, i) => list.push({
        cls: 'pay', html: `${head(multi ? `Seçenek ${i + 1} · ödeme` : esc(o.name), 'Ödeme Seçenekleri')}
          ${payFor(x)}
          ${x.items.some(it => it.cur === 'EUR' && !it.free) ? '<p class="io-note">€ tutarların TL karşılığı ödeme tarihindeki klinik kuru üzerinden hesaplanır.</p>' : ''}`,
        enter: el => countUp(el)
      }));
    }

    // 10. Önemli bilgiler
    if (lines(p.info).length) {
      list.push({
        cls: 'info', html: `${head('Bilmeniz gerekenler', 'Önemli Bilgiler')}
          <ul class="info-list">${lines(p.info).map((x, i) => `<li style="--d:${i}">${esc(x)}</li>`).join('')}</ul>`
      });
    }

    // 11. Kapanış
    list.push({
      cls: 'closing', html: `
        <div class="cover-deco"><span></span><span></span><span></span></div>
        <div class="cover-in">
          ${s.logo ? `<img class="cover-logo" src="${s.logo}" alt="">` : `<div class="cover-mark">${esc(s.clinicName)}</div>`}
          <h1>Yeni gülüşünüze<br>birlikte ulaşalım</h1>
          <p class="cover-meta">Aklınıza takılan her soruyu sormaktan çekinmeyin.</p>
          <div class="contact">${[p.doctor || s.doctor, s.phone, s.web, s.address].filter(Boolean).map(esc).join('<span>·</span>')}</div>
          <p class="disclaimer">Bu plan muayene ve radyografik değerlendirme bulgularına göre hazırlanmıştır; tedavi sürecinde klinik gerekliliklere göre değişiklik gösterebilir.</p>
        </div>`
    });
    return list;
  }

  /* ---------- Gezinme ---------- */
  function render() {
    const stage = $('#pStage');
    if (leave) { leave(); leave = null; }
    stage.querySelectorAll('.slide.out-l, .slide.out-r').forEach(s => s.remove());
    const old = stage.querySelector('.slide');
    if (old) {
      old.classList.add(dir > 0 ? 'out-l' : 'out-r');
      old.addEventListener('animationend', e => { if (e.target === old) old.remove(); });
      setTimeout(() => old.remove(), 600);
    }
    const sl = slides[idx];
    const el = document.createElement('div');
    el.className = `slide s-${sl.cls} ${dir > 0 ? 'in-r' : 'in-l'}`;
    el.innerHTML = `<div class="slide-in">${sl.html}</div>`;
    stage.appendChild(el);
    if (sl.enter) leave = sl.enter(el) || null;
    $('#pDots').innerHTML = slides.map((_, i) => `<button class="${i === idx ? 'on' : ''}" data-i="${i}"></button>`).join('');
    $('#pCount').textContent = `${idx + 1} / ${slides.length}`;
    $('#pPrev').disabled = idx === 0; $('#pNext').disabled = idx === slides.length - 1;
  }
  function go(i) {
    if (i < 0 || i >= slides.length || i === idx) return;
    dir = i > idx ? 1 : -1; idx = i; render();
  }

  function onKey(e) {
    if ($('#present').classList.contains('hidden')) return;
    if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); go(idx + 1); }
    else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); go(idx - 1); }
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(slides.length - 1);
    else if (e.key === 'Escape') close();
    else if (e.key === 'f' || e.key === 'F') toggleFull();
  }
  function toggleFull() {
    const el = document.documentElement;
    if (!document.fullscreenElement) el.requestFullscreen && el.requestFullscreen().catch(() => { });
    else document.exitFullscreen();
  }

  function open(p) {
    patient = p; option = p.options[p.activeOption] || p.options[0];
    slides = build(); idx = 0; dir = 1;
    $('#pStage').innerHTML = '';
    $('#pOption').innerHTML = p.options.map((o, i) => `<option value="${i}" ${o === option ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
    $('#pOption').style.display = p.options.length > 1 ? '' : 'none';
    $('#present').classList.remove('hidden');
    document.body.classList.add('presenting');
    render();
    toggleFull();
  }
  function close() {
    if (leave) { leave(); leave = null; }
    $('#present').classList.add('hidden');
    $('#pStage').innerHTML = '';
    document.body.classList.remove('presenting');
    if (document.fullscreenElement) document.exitFullscreen();
  }

  document.addEventListener('DOMContentLoaded', () => { });
  window.addEventListener('keydown', onKey);
  // Telefonda parmakla kaydırma
  let tx0 = null, ty0 = null;
  $('#present').addEventListener('touchstart', e => { const t = e.touches[0]; tx0 = t.clientX; ty0 = t.clientY; }, { passive: true });
  $('#present').addEventListener('touchend', e => {
    if (tx0 === null) return;
    const t = e.changedTouches[0], dx = t.clientX - tx0, dy = t.clientY - ty0; tx0 = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(idx + (dx < 0 ? 1 : -1));
  }, { passive: true });
  $('#pPrev').onclick = () => go(idx - 1);
  $('#pNext').onclick = () => go(idx + 1);
  $('#pClose').onclick = close;
  $('#pFull').onclick = toggleFull;
  $('#pDots').onclick = e => { const b = e.target.closest('button'); if (b) go(+b.dataset.i); };
  $('#pOption').onchange = e => {
    patient.activeOption = +e.target.value; option = patient.options[patient.activeOption]; save();
    const keep = idx; slides = build(); idx = Math.min(keep, slides.length - 1); dir = 1; render();
  };

  return { open, close };
})();
