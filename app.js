/* 구독달력 화면
 * 흐름: app.state(저장되는 데이터)를 바꾼다 → commit() → 결제 확인을 다시 계산하고, IndexedDB에 저장하고, 지금 탭을 다시 그린다.
 * 은행 파일·사용자 입력에서 온 글자는 모두 esc()를 거쳐 HTML에 넣는다.
 */
(function () {
  'use strict';
  const C = window.Core;
  const params = new URLSearchParams(location.search);
  const DEMO = params.has('demo'); // 화면 확인용 샘플 데이터(저장하지 않음)
  const VIEWS = ['home', 'calendar', 'subs', 'spend'];
  const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
  const COLOR_SLOTS = 8; // styles.css의 --cat-0 ~ --cat-7
  const PICK_DAYS = 120; // "통장 내역에서 고르기"에 보여 줄 기간

  const app = {
    state: C.emptyState(),
    today: C.todayStr(),
    y: 0,
    m: 0,
    view: 'home',
    match: null, // Core.matchAll 결과
    txSub: new Map(), // 거래 id → 맞춰진 구독
    sheet: null, // 열린 시트 { kind, refresh }
    chartActive: -1,
    chart: null,
    pendingImport: null,
    canSave: !DEMO,
  };

  // ---------- 작은 도구 ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
  const won = (n) => `${Math.round(Number(n) || 0).toLocaleString('ko-KR')}원`;
  const sum = (list, f) => list.reduce((a, x) => a + (Number(f(x)) || 0), 0);
  const md = (date) => {
    const p = C.parseYmd(date);
    return `${p.m}/${p.d}`;
  };
  const mdw = (date) => `${md(date)} (${WEEK[C.weekday(date)]})`;
  const longDate = (date) => {
    const p = C.parseYmd(date);
    return `${p.m}월 ${p.d}일 (${WEEK[C.weekday(date)]})`;
  };
  const ddayText = (n) => (n === 0 ? '오늘' : n === 1 ? '내일' : `D-${n}`);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const short = (name) => Array.from(String(name || '')).slice(0, 2).join('');
  const digits = (s) => Number(String(s == null ? '' : s).replace(/[^\d]/g, '')) || 0;
  const colorOf = (sub) => {
    const n = Number(sub && sub.color);
    return Number.isInteger(n) ? ((n % COLOR_SLOTS) + COLOR_SLOTS) % COLOR_SLOTS : 0;
  };
  const isThisMonth = () => {
    const t = C.parseYmd(app.today);
    return t.y === app.y && t.m === app.m;
  };
  // 그래프 눈금·달력 칸용 짧은 금액 (15,000 → 1.5만)
  function compact(v) {
    if (v >= 1e8) return `${+(v / 1e8).toFixed(1)}억`;
    if (v >= 1e4) return `${+(v / 1e4).toFixed(v >= 1e5 ? 0 : 1)}만`;
    return Math.round(v).toLocaleString('ko-KR');
  }
  const cellAmount = (v) => (v < 100000 ? Math.round(v).toLocaleString('ko-KR') : compact(v));

  function loadScript(src, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => (window[globalName] ? resolve(window[globalName]) : reject(new Error(`${src} 파일을 불러오지 못했어요.`)));
      s.onerror = () => reject(new Error(`${src} 파일을 불러오지 못했어요.`));
      document.head.appendChild(s);
    });
  }

  let toastTimer = 0;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 2800);
  }

  // ---------- 저장: IndexedDB에 상태 전체를 레코드 하나로 ----------
  const DB = {
    open() {
      if (!this.p) {
        this.p = new Promise((resolve, reject) => {
          const req = indexedDB.open('subcal', 1);
          req.onupgradeneeded = () => req.result.createObjectStore('kv');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      }
      return this.p;
    },
    async get(key) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const r = db.transaction('kv').objectStore('kv').get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    },
    async set(key, value) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  };

  function save() {
    if (!app.canSave) return;
    DB.set('state', app.state).catch(() => toast('저장하지 못했어요. 휴대폰 저장 공간을 확인해 주세요.'));
  }

  function derive() {
    const s = app.state;
    app.match = C.matchAll(s.subs, s.txs, s.rules);
    const byId = new Map(s.subs.map((x) => [x.id, x]));
    app.txSub = new Map();
    for (const [ck, tx] of app.match.byCharge) {
      const sub = byId.get(ck.slice(0, ck.lastIndexOf('@')));
      if (sub) app.txSub.set(tx.id, sub);
    }
  }

  function commit(message) {
    derive();
    save();
    render();
    if (app.sheet && app.sheet.refresh) app.sheet.refresh();
    if (message) toast(message);
  }

  const monthStatuses = (y = app.y, m = app.m) => C.chargeStatuses(app.state.subs, app.state.txs, app.state.rules, y, m, app.match);

  function statusBadge(c) {
    if (c.status === 'paid') return '<span class="badge ok">✓ 확인</span>';
    if (c.status === 'missing') return '<span class="badge warn">! 확인 안 됨</span>';
    return `<span class="badge">${c.date < app.today ? '지남' : '예정'}</span>`;
  }
  const glyph = (s) => (s === 'paid' ? '<b class="ok" aria-hidden="true">✓</b>' : s === 'missing' ? '<b class="warn" aria-hidden="true">!</b>' : '');

  // ---------- 화면 그리기 ----------
  function render() {
    $('#monthLabel').textContent = `${app.y}년 ${app.m}월`;
    $('#thisMonth').hidden = isThisMonth();
    for (const v of VIEWS) $(`#view-${v}`).hidden = v !== app.view;
    document.querySelectorAll('.tabbar a').forEach((a) => {
      if (a.dataset.tab === app.view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    ({ home: renderHome, calendar: renderCalendar, subs: renderSubs, spend: renderSpend })[app.view]();
  }

  // ----- 홈 -----
  function renderHome() {
    const s = app.state;
    const sp = C.monthSpending(s.txs, app.y, app.m, s.rules, app.match.matchedTxIds);
    const cov = C.monthCoverage(s.txs, app.y, app.m);
    const st = monthStatuses();
    const paid = st.filter((c) => c.status === 'paid');
    const missing = st.filter((c) => c.status === 'missing');
    const remain = st.filter((c) => c.status !== 'paid' && c.date >= app.today);
    const parts = [];
    if (paid.length) parts.push(`<span class="ok">✓</span> ${paid.length}건 확인`);
    if (remain.length) parts.push(`남은 ${remain.length}건 ${won(sum(remain, (c) => c.sub.amount))}`);
    if (missing.length) parts.push(`<span class="warn">! ${missing.length}건 확인 안 됨</span>`);
    let subNote;
    if (!s.subs.length) subNote = '등록한 구독이 없어요. <button class="link" data-action="add-sub">구독 추가</button>';
    else if (!st.length) subNote = '이 달에는 결제할 구독이 없어요.';
    else subNote = parts.length ? parts.join(' · ') : `${st.length}건 · 통장에서 확인된 결제 없음`;
    const covText = cov ? `${md(cov.from)}~${md(cov.to)} 통장 내역 기준` : s.txs.length ? '이 달에 불러온 통장 내역이 없어요.' : '아직 불러온 통장 내역이 없어요.';
    const up = C.upcoming(s.subs, app.today, 30);

    $('#view-home').innerHTML = `
      <section class="card">
        <div class="label">${app.m}월 총 지출</div>
        <div class="hero">${won(sp.total)}</div>
        <div class="stat-row"><span><i class="key s1"></i>확인된 구독 결제</span><b>${won(sp.subs)}</b></div>
        <div class="stat-row"><span><i class="key s2"></i>그 외 지출</span><b>${won(sp.other)}</b></div>
        <p class="note">${esc(covText)}${cov ? '' : ' <button class="link" data-action="go" data-view="spend">불러오러 가기</button>'}</p>
      </section>
      <section class="card">
        <div class="label">${app.m}월 정기 구독료</div>
        <div class="stat">${won(sum(st, (c) => c.sub.amount))}</div>
        <p class="note">${subNote}</p>
      </section>
      <section class="card">
        <h2 class="card-title">다가오는 결제 <small>30일</small></h2>
        ${up.length ? `<ul class="list">${up.map(upcomingRow).join('')}</ul>` : '<p class="empty">30일 안에 결제할 구독이 없어요.</p>'}
      </section>
      <section class="card">
        <h2 class="card-title">최근 6개월 지출</h2>
        <div class="legend"><span><i class="key s1"></i>확인된 구독 결제</span><span><i class="key s2"></i>그 외 지출</span></div>
        <div class="chart-wrap" id="chart"></div>
        ${chartTable()}
      </section>`;
    drawChart();
  }

  const upcomingRow = (c) => `
    <li class="row">
      <i class="dot c${colorOf(c.sub)}"></i>
      <div class="grow"><div class="name">${esc(c.sub.name)}</div><div class="sub">${mdw(c.date)}</div></div>
      <span class="dday${c.dday <= 3 ? ' soon' : ''}">${ddayText(c.dday)}</span>
      <span class="amt">${won(c.sub.amount)}</span>
    </li>`;

  // ----- 6개월 쌓는 막대그래프: 아래 = 확인된 구독 결제, 위 = 그 외 지출 -----
  function chartData() {
    const s = app.state;
    const out = [];
    for (let i = 5; i >= 0; i--) {
      const { y, m } = C.addMonths(app.y, app.m, -i);
      const sp = C.monthSpending(s.txs, y, m, s.rules, app.match.matchedTxIds);
      out.push({ y, m, subs: sp.subs, other: sp.other, total: sp.total });
    }
    return out;
  }

  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const k of [1, 2, 2.5, 4, 5, 10]) if (k * p >= v) return k * p;
    return 10 * p;
  }

  // 막대 끝(위)만 4px 둥글게, 바닥은 각지게
  function barPath(x, y, w, h, roundTop, cls) {
    const f = (n) => Math.round(n * 10) / 10;
    const r = roundTop ? Math.min(4, h, w / 2) : 0;
    const d = r
      ? `M${f(x)},${f(y + h)}V${f(y + r)}A${r},${r} 0 0 1 ${f(x + r)},${f(y)}H${f(x + w - r)}A${r},${r} 0 0 1 ${f(x + w)},${f(y + r)}V${f(y + h)}Z`
      : `M${f(x)},${f(y + h)}V${f(y)}H${f(x + w)}V${f(y + h)}Z`;
    return `<path class="${cls}" d="${d}"/>`;
  }

  function drawChart() {
    const box = $('#chart');
    if (!box) return;
    const data = chartData();
    app.chart = null;
    if (data.every((d) => !d.total)) {
      box.innerHTML = '<p class="empty">불러온 출금 내역이 없어서 아직 그래프가 비어 있어요.</p>';
      return;
    }
    const W = Math.max(260, Math.round(box.clientWidth || 320));
    const H = 196;
    const L = 40;
    const R = 6;
    const T = 22;
    const B = 24;
    const pw = W - L - R;
    const ph = H - T - B;
    const max = niceMax(Math.max(...data.map((d) => d.total)));
    const yOf = (v) => T + ph - (v / max) * ph;
    const band = pw / data.length;
    const bw = Math.min(24, band * 0.5);
    const f = (n) => Math.round(n * 10) / 10;
    let svg = '';
    for (const t of [0, max / 2, max]) {
      const yy = Math.round(yOf(t)) + 0.5;
      svg += `<line class="${t ? 'grid' : 'axis'}" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/>`;
      svg += `<text class="tick" x="${L - 6}" y="${yy + 4}" text-anchor="end">${t ? compact(t) : '0'}</text>`;
    }
    data.forEach((d, i) => {
      const cx = L + band * i + band / 2;
      const x = cx - bw / 2;
      const base = yOf(0);
      const hs = (d.subs / max) * ph;
      const ho = (d.other / max) * ph;
      const otherH = ho - (hs > 0 ? 2 : 0); // 두 조각 사이 2px 틈
      let g = '<g class="col">';
      if (hs > 0) g += barPath(x, base - hs, bw, hs, !(otherH > 0), 's1');
      if (otherH > 0) g += barPath(x, base - hs - ho, bw, otherH, true, 's2');
      svg += g + '</g>';
      const last = i === data.length - 1;
      if (last && d.total) svg += `<text class="cap" x="${f(cx)}" y="${f(base - hs - ho - 6)}" text-anchor="middle">${compact(d.total)}</text>`;
      svg += `<text class="xlab${last ? ' cur' : ''}" x="${f(cx)}" y="${H - 6}" text-anchor="middle">${d.m}월</text>`;
      svg += `<rect class="hit" x="${f(L + band * i)}" y="${T - 14}" width="${f(band)}" height="${f(ph + 14)}" data-action="chart-col" data-i="${i}" tabindex="0" role="button" aria-label="${d.y}년 ${d.m}월 총 지출 ${won(d.total)}, 확인된 구독 결제 ${won(d.subs)}, 그 외 지출 ${won(d.other)}"/>`;
    });
    box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="group" aria-label="최근 6개월 지출 막대그래프">${svg}</svg>`;
    app.chart = { data, L, band, W };
    applyChartActive();
  }

  // 누른 달만 진하게 두고 말풍선을 띄운다(그래프를 다시 그리지 않아 키보드 초점이 유지된다)
  function applyChartActive() {
    const box = $('#chart');
    if (!box || !app.chart) return;
    if (app.chartActive >= app.chart.data.length) app.chartActive = -1;
    box.querySelectorAll('g.col').forEach((g, i) => g.classList.toggle('dim', app.chartActive >= 0 && i !== app.chartActive));
    const old = box.querySelector('.tooltip');
    if (old) old.remove();
    if (app.chartActive < 0) return;
    const d = app.chart.data[app.chartActive];
    const tip = document.createElement('div');
    tip.className = 'tooltip';
    tip.innerHTML = `
      <div class="tt-title">${d.y}년 ${d.m}월</div>
      <div class="tt-row"><i class="tt-key s1"></i><b>${won(d.subs)}</b><span>확인된 구독 결제</span></div>
      <div class="tt-row"><i class="tt-key s2"></i><b>${won(d.other)}</b><span>그 외 지출</span></div>
      <div class="tt-row"><i class="tt-key none"></i><b>${won(d.total)}</b><span>합계</span></div>`;
    box.appendChild(tip);
    const cx = app.chart.L + app.chart.band * app.chartActive + app.chart.band / 2;
    tip.style.left = `${Math.min(Math.max(cx - tip.offsetWidth / 2, 0), app.chart.W - tip.offsetWidth)}px`;
  }

  function chartTable() {
    const rows = chartData()
      .map((d) => `<tr><td>${d.y}.${d.m}</td><td>${won(d.subs)}</td><td>${won(d.other)}</td><td>${won(d.total)}</td></tr>`)
      .join('');
    return `<details class="table-view"><summary>표로 보기</summary><table class="data-table"><thead><tr><th>달</th><th>구독 결제</th><th>그 외</th><th>합계</th></tr></thead><tbody>${rows}</tbody></table></details>`;
  }

  // ----- 달력 -----
  function renderCalendar() {
    const st = monthStatuses();
    const byDate = new Map();
    for (const c of st) {
      if (!byDate.has(c.date)) byDate.set(c.date, []);
      byDate.get(c.date).push(c);
    }
    let cells = '';
    for (const week of C.calendarWeeks(app.y, app.m)) {
      week.forEach((date, i) => {
        if (!date) {
          cells += '<div class="cal-cell" aria-hidden="true"></div>';
          return;
        }
        const list = byDate.get(date) || [];
        const total = sum(list, (c) => c.sub.amount);
        const cls = ['cal-cell', i === 0 ? 'sun' : i === 6 ? 'sat' : '', list.length ? 'has' : '', date === app.today ? 'today' : ''].filter(Boolean).join(' ');
        const chips = list
          .slice(0, 2)
          .map((c) => `<span class="chip"><i class="dot c${colorOf(c.sub)}"></i>${esc(short(c.sub.name))}${glyph(c.status)}</span>`)
          .join('');
        const more = list.length > 2 ? `<span class="more">+${list.length - 2}</span>` : '';
        const label = `${longDate(date)}${list.length ? `, 구독 ${list.length}건 ${won(total)}` : ''}`;
        cells += `<button class="${cls}" data-action="day" data-date="${date}" aria-label="${esc(label)}"><span class="num">${Number(date.slice(8))}</span>${chips}${more}${total ? `<span class="amt">${cellAmount(total)}</span>` : ''}</button>`;
      });
    }
    $('#view-calendar').innerHTML = `
      <section class="card tight">
        <div class="cal-week" aria-hidden="true">${WEEK.map((w, i) => `<span class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</span>`).join('')}</div>
        <div class="cal-grid">${cells}</div>
      </section>
      <section class="card">
        <h2 class="card-title">${app.m}월 결제 <small>${st.length}건 · ${won(sum(st, (c) => c.sub.amount))}</small></h2>
        ${st.length ? `<ul class="list">${st.map(chargeRow).join('')}</ul>` : '<p class="empty">이 달에는 결제할 구독이 없어요.</p>'}
        <p class="note"><span class="ok">✓</span> 통장에서 결제 확인 · <span class="warn">!</span> 예전엔 확인됐는데 이번 달엔 안 보여요(잔액 부족 등)</p>
      </section>`;
  }

  const chargeRow = (c) => `
    <li><button class="row" data-action="day" data-date="${c.date}">
      <i class="dot c${colorOf(c.sub)}"></i>
      <div class="grow"><div class="name">${esc(c.sub.name)}</div><div class="sub">${mdw(c.date)}</div></div>
      ${statusBadge(c)}
      <span class="amt">${won(c.sub.amount)}</span>
    </button></li>`;

  function openDay(date) {
    const p = C.parseYmd(date);
    const charges = monthStatuses(p.y, p.m).filter((c) => c.date === date);
    const txs = app.state.txs.filter((t) => t.date === date).sort(C.sortTx);
    const chargeHtml = charges.length
      ? `<ul class="list">${charges
          .map((c) => {
            const how = c.tx
              ? `통장 ${md(c.tx.date)} ${esc(c.tx.desc || c.tx.memo)} ${won(c.tx.out)}`
              : c.sub.matchKey
                ? `통장 표시 이름: ${esc(c.sub.matchKey)}`
                : '통장 표시 이름이 없어 결제 확인을 하지 않아요';
            return `<li><button class="row" data-action="edit-sub" data-id="${esc(c.sub.id)}"><i class="dot c${colorOf(c.sub)}"></i>
              <div class="grow"><div class="name">${esc(c.sub.name)}</div><div class="sub">${how}</div></div>
              ${statusBadge(c)}<span class="amt">${won(c.sub.amount)}</span></button></li>`;
          })
          .join('')}</ul>`
      : '<p class="empty">이날 결제할 구독이 없어요.</p>';
    const txHtml = txs.length ? `<ul class="list">${txs.map(txRow).join('')}</ul>` : '<p class="empty">이날 통장 거래가 없어요.</p>';
    openSheet(longDate(date), `<h3>구독</h3>${chargeHtml}<h3 class="mt">통장 거래</h3>${txHtml}`, { kind: 'day', refresh: () => openDay(date) });
  }

  // ----- 구독 -----
  function renderSubs() {
    const s = app.state;
    const stById = new Map(monthStatuses().map((c) => [c.sub.id, c]));
    const rows = s.subs
      .map((sub) => ({ sub, next: C.nextChargeDate(sub, app.today) }))
      .sort((a, b) => {
        const x = a.next || '9999';
        const y = b.next || '9999';
        return x < y ? -1 : x > y ? 1 : String(a.sub.name).localeCompare(String(b.sub.name), 'ko');
      })
      .map(({ sub, next }) => {
        const cycle = sub.cycle === 'yearly' ? `매년 ${sub.month}월 ${sub.day}일` : `매월 ${sub.day}일`;
        const nextText = next ? `<span class="nowrap">${ddayText(C.diffDays(app.today, next))}</span>` : '끝난 구독';
        const c = stById.get(sub.id);
        return `<li><button class="row" data-action="edit-sub" data-id="${esc(sub.id)}">
          <i class="dot c${colorOf(sub)}"></i>
          <div class="grow"><div class="name">${esc(sub.name)}</div><div class="sub">${cycle} · ${nextText}</div></div>
          ${c && c.status !== 'scheduled' ? statusBadge(c) : ''}
          <span class="amt">${won(sub.amount)}</span>
        </button></li>`;
      })
      .join('');
    $('#view-subs').innerHTML = `
      <section class="card">
        <div class="label">월 환산 합계</div>
        <div class="stat">${won(C.monthlyEquivalent(s.subs, app.today))}</div>
        <p class="note">구독 ${s.subs.length}개 · 매년 구독은 12로 나눠 더했어요.</p>
      </section>
      <button class="btn primary block" data-action="add-sub">+ 구독 추가</button>
      <section class="card mt">
        ${
          s.subs.length
            ? `<ul class="list">${rows}</ul>`
            : '<p class="empty">아직 등록한 구독이 없어요.</p><p class="note">금액과 결제일은 네이버페이 → 결제내역·정기결제, 아이폰 설정 → 이름 → 구독에서 확인할 수 있어요.</p>'
        }
      </section>
      <p class="note">상태(✓·!)는 ${app.m}월 기준이에요. <button class="link" data-action="help" data-topic="subs">구독 입력 요령</button></p>`;
  }

  function nextColor() {
    const used = new Set(app.state.subs.map(colorOf));
    for (let i = 0; i < COLOR_SLOTS; i++) if (!used.has(i)) return i;
    return app.state.subs.length % COLOR_SLOTS;
  }

  function openSubForm(id, prefill) {
    const s = app.state;
    const t = C.parseYmd(app.today);
    const sub = id ? s.subs.find((x) => x.id === id) : null;
    const v = sub
      ? { ...sub }
      : { name: '', amount: '', cycle: 'monthly', day: t.d, month: t.m, color: nextColor(), matchKey: s.settings.payKey || '', startDate: '', endDate: '', memo: '', ...(prefill || {}) };
    const opt = (n, sel, unit) =>
      Array.from({ length: n }, (_, i) => i + 1)
        .map((k) => `<option value="${k}"${Number(sel) === k ? ' selected' : ''}>${k}${unit}</option>`)
        .join('');
    const swatches = Array.from(
      { length: COLOR_SLOTS },
      (_, i) => `<label class="c${i}"><input type="radio" name="color" value="${i}"${colorOf(v) === i ? ' checked' : ''} aria-label="색 ${i + 1}"></label>`,
    ).join('');
    const html = `
      <form id="subForm" class="form${v.cycle === 'yearly' ? ' is-yearly' : ''}" data-id="${esc(sub ? sub.id : '')}" autocomplete="off" novalidate>
        <label class="field"><span>이름</span><input name="name" maxlength="40" value="${esc(v.name)}" placeholder="예: 유튜브 프리미엄"></label>
        <label class="field"><span>금액(원)</span><input name="amount" inputmode="numeric" value="${v.amount ? esc(Number(v.amount).toLocaleString('ko-KR')) : ''}" placeholder="예: 14,900"></label>
        <div class="field"><span>주기</span><div class="seg">
          <label><input type="radio" name="cycle" value="monthly"${v.cycle !== 'yearly' ? ' checked' : ''}>매월</label>
          <label><input type="radio" name="cycle" value="yearly"${v.cycle === 'yearly' ? ' checked' : ''}>매년</label>
        </div></div>
        <div class="two">
          <label class="field yearly-only"><span>결제 달</span><select name="month">${opt(12, v.month || t.m, '월')}</select></label>
          <label class="field"><span>결제일</span><select name="day">${opt(31, v.day || 1, '일')}</select></label>
        </div>
        <div class="field"><span>색</span><div class="swatches">${swatches}</div></div>
        <label class="field"><span>통장 표시 이름</span><input name="matchKey" maxlength="40" value="${esc(v.matchKey || '')}" placeholder="${esc(s.settings.payKey || '예: 네이버페이')}">
          <small>통장 거래와 금액·날짜로 맞춰 볼 때 쓰는 이름이에요. 비워 두면 결제 확인(✓)을 하지 않아요.</small></label>
        <button type="button" class="btn block" data-action="pick-open">통장 내역에서 고르기</button>
        <div id="picker" class="picker" hidden></div>
        <details class="more"${v.startDate || v.endDate || v.memo ? ' open' : ''}><summary>시작일·종료일·메모</summary>
          <label class="field"><span>시작일</span><input type="date" name="startDate" value="${esc(v.startDate || '')}"></label>
          <label class="field"><span>종료일(해지한 날)</span><input type="date" name="endDate" value="${esc(v.endDate || '')}"></label>
          <label class="field"><span>메모</span><input name="memo" maxlength="80" value="${esc(v.memo || '')}"></label>
        </details>
        <p class="note">금액과 결제일은 네이버페이 → 결제내역·정기결제, 아이폰 설정 → 이름 → 구독에서 확인할 수 있어요.</p>
        <div class="actions"><button class="btn primary" type="submit">저장</button>${sub ? '<button type="button" class="btn danger" data-action="sub-delete">삭제</button>' : ''}</div>
      </form>`;
    openSheet(sub ? '구독 수정' : '구독 추가', html, { kind: 'sub' });
  }

  function saveSubForm(form) {
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim();
    const amount = digits(fd.get('amount'));
    const startDate = String(fd.get('startDate') || '');
    const endDate = String(fd.get('endDate') || '');
    if (!name) return toast('이름을 적어 주세요.');
    if (!amount) return toast('금액을 적어 주세요.');
    if (startDate && endDate && endDate < startDate) return toast('종료일이 시작일보다 빨라요.');
    const data = {
      name,
      amount,
      cycle: fd.get('cycle') === 'yearly' ? 'yearly' : 'monthly',
      day: Math.min(31, Math.max(1, Number(fd.get('day')) || 1)),
      month: Math.min(12, Math.max(1, Number(fd.get('month')) || 1)),
      color: Number(fd.get('color')) || 0,
      matchKey: String(fd.get('matchKey') || '').trim(),
      startDate,
      endDate,
      memo: String(fd.get('memo') || '').trim(),
    };
    const id = form.dataset.id;
    const subs = app.state.subs;
    if (id) {
      const i = subs.findIndex((x) => x.id === id);
      if (i >= 0) subs[i] = { ...subs[i], ...data };
    } else subs.push({ id: `s${uid()}`, ...data });
    closeSheet();
    commit(id ? '구독을 고쳤어요.' : '구독을 추가했어요.');
  }

  function deleteSub() {
    const form = $('#subForm');
    const sub = form && app.state.subs.find((x) => x.id === form.dataset.id);
    if (!sub || !confirm(`'${sub.name}' 구독을 지울까요?`)) return;
    app.state.subs = app.state.subs.filter((x) => x.id !== sub.id);
    closeSheet();
    commit('구독을 지웠어요.');
  }

  function openPicker() {
    const box = $('#picker');
    if (!box) return;
    if (!box.hidden) {
      box.hidden = true;
      return;
    }
    const list = C.recentWithdrawals(app.state.txs, app.today, PICK_DAYS).slice(0, 80);
    box.innerHTML = list.length
      ? `<ul class="list">${list
          .map(
            (t) => `<li><button type="button" class="row" data-action="pick" data-id="${esc(t.id)}">
              <div class="grow"><div class="name">${esc(t.desc || t.memo || '(내용 없음)')}</div><div class="sub">${mdw(t.date)}${t.memo && t.desc ? ` · ${esc(t.memo)}` : ''}</div></div>
              <span class="amt">${won(t.out)}</span></button></li>`,
          )
          .join('')}</ul>`
      : '<p class="empty">최근 4개월 출금 내역이 없어요. 지출 탭에서 신한 거래내역을 먼저 불러오세요.</p>';
    box.hidden = false;
  }

  function pickTx(id) {
    const t = app.state.txs.find((x) => x.id === id);
    const form = $('#subForm');
    if (!t || !form) return;
    const p = C.parseYmd(t.date);
    form.elements.amount.value = t.out.toLocaleString('ko-KR');
    form.elements.day.value = String(p.d);
    form.elements.month.value = String(p.m);
    form.elements.matchKey.value = C.suggestMatchKey(t);
    if (!form.elements.name.value.trim()) form.elements.name.value = t.desc || t.memo || '';
    $('#picker').hidden = true;
    toast('금액·결제일·통장 표시 이름을 채웠어요.');
  }

  // ----- 지출 -----
  function txRow(t) {
    const excluded = C.isExcluded(t, app.state.rules);
    const sub = app.txSub.get(t.id);
    const info = [t.memo, t.time ? t.time.slice(0, 5) : '', t.source === 'manual' ? '직접 입력' : ''].filter(Boolean).join(' · ');
    const badges = (sub ? ` <span class="badge"><i class="dot c${colorOf(sub)}"></i>${esc(sub.name)}</span>` : '') + (excluded ? ' <span class="badge">제외</span>' : '');
    return `<li><button class="row${excluded ? ' excluded' : ''}" data-action="tx" data-id="${esc(t.id)}">
      <div class="grow"><div class="name"><span class="txt">${esc(t.desc || t.memo || '(내용 없음)')}</span>${badges}</div>${info ? `<div class="sub">${esc(info)}</div>` : ''}</div>
      <span class="amt${t.out ? '' : ' in'}">${t.out ? `-${won(t.out)}` : `+${won(t.in)}`}</span>
    </button></li>`;
  }

  function renderSpend() {
    const s = app.state;
    const sp = C.monthSpending(s.txs, app.y, app.m, s.rules, app.match.matchedTxIds);
    const cov = C.monthCoverage(s.txs, app.y, app.m);
    const prefix = C.monthKey(app.y, app.m);
    const txs = s.txs.filter((t) => t.date.startsWith(prefix)).sort((a, b) => C.sortTx(b, a));
    let list = '';
    let cur = '';
    for (const t of txs) {
      if (t.date !== cur) {
        if (cur) list += '</ul>';
        cur = t.date;
        list += `<h3 class="day-head">${longDate(t.date)}</h3><ul class="list">`;
      }
      list += txRow(t);
    }
    if (cur) list += '</ul>';
    $('#view-spend').innerHTML = `
      <section class="card">
        <div class="label">${app.m}월 지출</div>
        <div class="stat">${won(sp.total)}</div>
        <p class="note">출금 ${sp.count}건${sp.excluded ? ` · 제외 ${sp.excluded}건` : ''}${cov ? ` · ${md(cov.from)}~${md(cov.to)} 내역` : ''}</p>
      </section>
      <div class="actions">
        <button class="btn primary wide" data-action="import">신한 거래내역 불러오기</button>
        <button class="btn" data-action="add-tx">직접 추가</button>
      </div>
      <p class="note"><button class="link" data-action="help" data-topic="shinhan">신한 거래내역 파일 받는 법</button> · 거래를 누르면 지출에서 뺄 수 있어요.</p>
      <section class="card mt">${txs.length ? list : `<p class="empty">${app.m}월 거래가 없어요.</p>`}</section>`;
  }

  function openTx(id) {
    const t = app.state.txs.find((x) => x.id === id);
    if (!t) return closeSheet();
    const rules = app.state.rules;
    const excluded = C.isExcluded(t, rules);
    const rule = C.ruleHit(t, rules);
    const sub = app.txSub.get(t.id);
    const kv = [
      ['날짜', `${longDate(t.date)}${t.time ? ` ${t.time.slice(0, 5)}` : ''}`],
      ['내용', t.desc || '-'],
      ['적요', t.memo || '-'],
      [t.out ? '출금' : '입금', won(t.out || t.in)],
      ...(t.balance != null ? [['잔액', won(t.balance)]] : []),
      ['출처', t.source === 'manual' ? '직접 입력' : '신한 거래내역'],
    ]
      .map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`)
      .join('');
    let html = `<dl class="kv">${kv}</dl>`;
    if (sub) html += `<p class="note"><span class="ok">✓</span> '${esc(sub.name)}' 구독 결제로 확인된 거래예요.</p>`;
    if (t.out) {
      html += `<label class="switch">지출에서 제외<input type="checkbox" id="excludeToggle" data-id="${esc(t.id)}"${excluded ? ' checked' : ''}></label>`;
      if (rule && typeof t.excluded !== 'boolean') html += `<p class="note">'${esc(rule.keyword)}' 규칙으로 제외됐어요.</p>`;
      html += `<div class="field mt"><span>같은 내용은 앞으로도 제외</span>
        <div class="inline"><input id="ruleKey" maxlength="40" value="${esc(C.suggestMatchKey(t))}"><button class="btn" type="button" data-action="add-rule" data-id="${esc(t.id)}">규칙 추가</button></div>
        <small>내용이나 적요에 이 글자가 들어간 거래는 모두 지출에서 빠져요(내 계좌 이체, 적금 등).</small></div>`;
      html += `<button class="btn block mt" data-action="tx-to-sub" data-id="${esc(t.id)}">이 거래로 구독 만들기</button>`;
    }
    if (t.source === 'manual') html += `<button class="btn danger block mt" data-action="tx-delete" data-id="${esc(t.id)}">이 거래 지우기</button>`;
    openSheet(t.desc || t.memo || '거래', html, { kind: 'tx', refresh: () => openTx(id) });
  }

  function addRule(el) {
    const input = $('#ruleKey');
    const keyword = input ? input.value.trim() : '';
    if (!keyword) return toast('제외할 글자를 적어 주세요.');
    const rules = app.state.rules;
    if (!rules.some((r) => C.normKey(r.keyword) === C.normKey(keyword))) rules.push({ id: `r${uid()}`, keyword });
    const t = app.state.txs.find((x) => x.id === el.dataset.id);
    if (t) delete t.excluded; // 이 거래도 규칙을 따르게 한다
    const n = app.state.txs.filter((x) => x.out > 0 && C.isExcluded(x, rules)).length;
    commit(`'${keyword}' 규칙을 추가했어요 · 제외된 거래 ${n}건`);
  }

  function txToSub(el) {
    const t = app.state.txs.find((x) => x.id === el.dataset.id);
    if (!t) return;
    const p = C.parseYmd(t.date);
    openSubForm(null, { name: t.desc || t.memo || '', amount: t.out, day: p.d, month: p.m, matchKey: C.suggestMatchKey(t) });
  }

  function deleteTx(el) {
    const t = app.state.txs.find((x) => x.id === el.dataset.id);
    if (!t || !confirm('이 거래를 지울까요?')) return;
    app.state.txs = app.state.txs.filter((x) => x !== t);
    closeSheet();
    commit('거래를 지웠어요.');
  }

  function openTxForm() {
    const date = isThisMonth() ? app.today : C.ymd(app.y, app.m, 1);
    openSheet(
      '지출 직접 추가',
      `<form id="txForm" class="form" autocomplete="off" novalidate>
        <label class="field"><span>날짜</span><input type="date" name="date" value="${date}"></label>
        <label class="field"><span>금액(원)</span><input name="amount" inputmode="numeric" placeholder="예: 12,000"></label>
        <label class="field"><span>내용</span><input name="desc" maxlength="40" placeholder="예: 현금 · 시장"></label>
        <label class="field"><span>메모</span><input name="memo" maxlength="80"></label>
        <p class="note">통장에 안 남는 지출(현금 등)만 적어 주세요. 통장 거래는 파일로 불러오면 돼요.</p>
        <div class="actions"><button class="btn primary" type="submit">추가</button></div>
      </form>`,
      { kind: 'txform' },
    );
  }

  function saveTxForm(form) {
    const fd = new FormData(form);
    const date = String(fd.get('date') || '');
    const out = digits(fd.get('amount'));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('날짜를 골라 주세요.');
    if (!out) return toast('금액을 적어 주세요.');
    app.state.txs.push({
      id: `m-${uid()}`,
      date,
      time: '',
      desc: String(fd.get('desc') || '').trim() || '직접 입력',
      memo: String(fd.get('memo') || '').trim(),
      out,
      in: 0,
      balance: null,
      source: 'manual',
    });
    app.state.txs.sort(C.sortTx);
    closeSheet();
    commit('지출을 추가했어요.');
  }

  // ----- 신한 거래내역 불러오기 -----
  async function handleImportFile(file) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (C.needsSheetJS(bytes)) await loadScript('vendor/xlsx.full.min.js', 'XLSX');
      const r = C.parseRows(C.fileToRows(bytes, window.XLSX));
      if (!r.ok) {
        openSheet(
          '파일을 읽지 못했어요',
          `<p>${esc(r.reason)}</p><div class="preview">${r.preview.map((l) => esc(l)).join('<br>')}</div>
          <p class="note">신한 PC 인터넷뱅킹 '파일 저장 → 엑셀 저장'으로 받은 파일인지 확인해 주세요. 안 되면 '텍스트 저장' 파일로 다시 해 보세요.</p>`,
          { kind: 'import' },
        );
        return;
      }
      if (!r.txs.length) {
        openSheet('거래가 없어요', '<p>파일에서 거래를 찾지 못했어요. 조회 기간을 확인해 주세요.</p>', { kind: 'import' });
        return;
      }
      const dry = C.mergeTransactions(app.state.txs, r.txs);
      const dates = r.txs.map((t) => t.date).sort();
      app.pendingImport = r.txs;
      openSheet(
        '신한 거래내역 불러오기',
        `<dl class="kv">
          <dt>기간</dt><dd>${longDate(dates[0])} ~ ${longDate(dates[dates.length - 1])}</dd>
          <dt>거래</dt><dd>${r.txs.length}건</dd>
          <dt>새로 추가</dt><dd>${dry.added}건</dd>
          <dt>이미 있음</dt><dd>${dry.duplicates}건</dd>
          <dt>출금 합계</dt><dd>${won(sum(r.txs, (t) => t.out))}</dd>
        </dl>
        <p class="note">계좌번호 같은 머리말 정보는 저장하지 않고 거래만 저장해요. 이미 있는 거래는 다시 넣지 않아요.</p>
        <div class="actions"><button class="btn primary" data-action="import-save"${dry.added ? '' : ' disabled'}>${dry.added ? `${dry.added}건 저장` : '새 거래 없음'}</button></div>`,
        { kind: 'import' },
      );
    } catch (err) {
      openSheet('파일을 읽지 못했어요', `<p>${esc((err && err.message) || err)}</p><p class="note">엑셀 파일이 열리지 않으면 신한 인터넷뱅킹의 '텍스트 저장' 파일로 다시 해 보세요.</p>`, { kind: 'import' });
    }
  }

  function saveImport() {
    if (!app.pendingImport) return;
    const res = C.mergeTransactions(app.state.txs, app.pendingImport);
    app.pendingImport = null;
    app.state.txs = res.merged;
    if (!app.state.settings.payKey) app.state.settings.payKey = C.guessPayKey(res.merged);
    closeSheet();
    derive();
    const t = C.parseYmd(app.today);
    const paid = monthStatuses(t.y, t.m).filter((c) => c.status === 'paid').length;
    commit(`${res.added}건을 저장했어요${app.state.subs.length ? ` · ${t.m}월 구독 ${paid}건 확인` : ''}`);
  }

  // ----- 설정·백업 -----
  function backupAgo(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '알 수 없음';
    const date = C.todayStr(d);
    const n = C.diffDays(date, app.today);
    return `${longDate(date)}${n > 0 ? ` (${n}일 전)` : ' (오늘)'}`;
  }

  function openSettings() {
    const s = app.state;
    const last = C.lastImportedDate(s.txs);
    const rules = s.rules.length
      ? `<ul class="list">${s.rules
          .map((r) => `<li class="row"><div class="grow name">${esc(r.keyword)}</div><button class="btn" data-action="delete-rule" data-id="${esc(r.id)}">삭제</button></li>`)
          .join('')}</ul>`
      : '<p class="empty">제외 규칙이 없어요. 지출 탭에서 거래를 눌러 추가할 수 있어요.</p>';
    openSheet(
      '설정',
      `<section class="set"><h3>내 데이터</h3>
        <p class="note">구독 ${s.subs.length}개 · 거래 ${s.txs.length}건${last ? ` · 마지막으로 불러온 거래 ${longDate(last)}` : ''}</p>
        <p class="note">데이터는 이 휴대폰에만 저장돼요. 휴대폰을 바꾸거나 앱을 지우면 사라지니, 가끔 백업 파일을 만들어 '파일' 앱에 저장해 두세요.</p>
        <div class="actions"><button class="btn primary" data-action="backup">백업 파일 만들기</button><button class="btn" data-action="restore">백업 불러오기</button></div>
        <p class="note">${s.settings.lastBackupAt ? `마지막 백업: ${backupAgo(s.settings.lastBackupAt)}` : '아직 백업한 적이 없어요.'}</p>
        ${DEMO ? '<p class="note warn">샘플 모드에서는 저장·백업이 되지 않아요.</p>' : ''}
      </section>
      <section class="set"><h3>통장 표시 이름 기본값</h3>
        <div class="inline"><input id="payKey" maxlength="40" value="${esc(s.settings.payKey || '')}" placeholder="예: 네이버페이"><button class="btn" data-action="save-paykey">저장</button></div>
        <p class="note">새 구독을 추가할 때 미리 채워 넣어요. 네이버페이 결제가 통장에 찍히는 이름을 적어 두세요.</p>
      </section>
      <section class="set"><h3>제외 규칙</h3>${rules}</section>
      <section class="set"><h3>도움말</h3>
        <ul class="list">
          <li><button class="row" data-action="help" data-topic="shinhan"><span class="grow">신한 거래내역 받는 법</span>›</button></li>
          <li><button class="row" data-action="help" data-topic="subs"><span class="grow">구독 입력 요령</span>›</button></li>
          <li><button class="row" data-action="help" data-topic="install"><span class="grow">홈 화면에 추가하는 법</span>›</button></li>
        </ul>
      </section>
      <section class="set"><button class="btn danger block" data-action="wipe">모든 데이터 지우기</button></section>
      <p class="note center">데이터는 이 기기 밖으로 나가지 않아요.</p>`,
      { kind: 'settings', refresh: openSettings },
    );
  }

  async function doBackup() {
    if (DEMO) return toast('샘플 모드에서는 백업하지 않아요.');
    const name = `구독달력-백업-${app.today}.json`;
    const file = new File([JSON.stringify(C.makeBackup(app.state))], name, { type: 'application/json' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: '구독달력 백업' });
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(file);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          URL.revokeObjectURL(a.href);
          a.remove();
        }, 1000);
      }
      app.state.settings.lastBackupAt = new Date().toISOString();
      commit('백업 파일을 만들었어요.');
    } catch (e) {
      if (!e || e.name !== 'AbortError') toast('백업 파일을 만들지 못했어요.');
    }
  }

  async function handleRestoreFile(file) {
    try {
      const state = C.readBackup(JSON.parse(await file.text()));
      if (!confirm(`백업(구독 ${state.subs.length}개, 거래 ${state.txs.length}건)으로 지금 데이터를 바꿀까요?`)) return;
      app.state = state;
      closeSheet();
      commit('백업을 불러왔어요.');
    } catch (e) {
      toast(e instanceof SyntaxError ? '백업 파일을 읽지 못했어요.' : e.message);
    }
  }

  function wipeAll() {
    if (!confirm('구독과 거래를 모두 지울까요? 되돌릴 수 없어요.')) return;
    if (!confirm('정말 지울까요? 백업 파일이 없으면 복구할 수 없어요.')) return;
    app.state = C.emptyState();
    closeSheet();
    commit('모든 데이터를 지웠어요.');
  }

  const HELP = {
    shinhan: [
      '신한 거래내역 받는 법',
      `<ol class="steps">
        <li>PC에서 신한은행 인터넷뱅킹에 로그인합니다.</li>
        <li><b>조회 → 계좌조회 → 예금/신탁</b>으로 가서 통장의 [조회]를 누릅니다.</li>
        <li>조회 기간을 고르고(처음엔 최근 3개월) [조회]를 누릅니다.</li>
        <li>목록 오른쪽 위 <b>[파일 저장]</b> → 항목 모두 체크 → <b>[엑셀 저장]</b>을 누릅니다.</li>
      </ol>
      <h3>아이폰으로 옮기기</h3>
      <ol class="steps">
        <li>PC 카카오톡 '나와의 채팅'에 파일을 보냅니다. 메일 첨부도 돼요.</li>
        <li>아이폰에서 파일을 열고 공유 → <b>'파일에 저장'</b>을 누릅니다.</li>
        <li>이 앱의 지출 탭 → <b>신한 거래내역 불러오기</b> → 파일 앱에서 고릅니다.</li>
      </ol>
      <p class="note">기간이 겹치게 불러와도 같은 거래는 한 번만 저장돼요. 한 달에 한 번쯤 불러오면 됩니다.</p>`,
    ],
    subs: [
      '구독 입력 요령',
      `<p>구독은 한 번만 등록해 두면 매달 달력에 표시돼요.</p>
      <ul class="steps">
        <li><b>금액·결제일 찾기</b>: 네이버페이 → 결제내역·정기결제, 아이폰 설정 → 이름 → 구독</li>
        <li><b>통장 표시 이름</b>: 통장에 찍히는 이름(예: 네이버페이)이에요. 금액·날짜와 함께 통장 거래와 맞춰 보는 데 써요. '통장 내역에서 고르기'를 누르면 자동으로 채워져요.</li>
        <li><b>✓</b> 통장에서 결제가 확인됨 · <b>!</b> 예전엔 확인됐는데 이번 달엔 결제가 안 보임(잔액 부족 등)</li>
        <li>아직 네이버페이로 옮기지 않은 구독은 표시 없이 일정만 보여요.</li>
      </ul>`,
    ],
    install: [
      '홈 화면에 추가하는 법',
      `<ol class="steps">
        <li>Safari로 이 앱 주소를 엽니다.</li>
        <li>아래쪽 <b>공유 버튼</b>(네모에 위쪽 화살표)을 누릅니다.</li>
        <li><b>'홈 화면에 추가'</b> → '추가'를 누릅니다.</li>
        <li>이제 홈 화면의 <b>구독달력</b> 아이콘으로 여세요.</li>
      </ol>
      <p class="note">Safari에서 연 화면과 홈 화면 앱은 데이터가 따로 저장될 수 있어요. 항상 아이콘으로 여세요.</p>`,
    ],
  };

  // ---------- 시트 ----------
  function openSheet(title, html, ctx) {
    app.sheet = ctx || {};
    $('#sheetTitle').textContent = title;
    $('#sheetBody').innerHTML = html;
    $('#sheet').hidden = false;
    document.body.classList.add('sheet-open');
  }

  function closeSheet() {
    $('#sheet').hidden = true;
    $('#sheetBody').innerHTML = '';
    app.sheet = null;
    document.body.classList.remove('sheet-open');
  }

  // ---------- 이벤트 ----------
  function moveMonth(n) {
    const r = C.addMonths(app.y, app.m, n);
    app.y = r.y;
    app.m = r.m;
    app.chartActive = -1;
    render();
  }

  const ACTIONS = {
    'prev-month': () => moveMonth(-1),
    'next-month': () => moveMonth(1),
    'this-month': () => {
      const t = C.parseYmd(app.today);
      app.y = t.y;
      app.m = t.m;
      app.chartActive = -1;
      render();
    },
    settings: openSettings,
    go: (el) => (location.hash = el.dataset.view),
    day: (el) => openDay(el.dataset.date),
    'add-sub': () => openSubForm(null),
    'edit-sub': (el) => openSubForm(el.dataset.id),
    'sub-delete': deleteSub,
    'pick-open': openPicker,
    pick: (el) => pickTx(el.dataset.id),
    import: () => $('#importFile').click(),
    'import-save': saveImport,
    'add-tx': openTxForm,
    tx: (el) => openTx(el.dataset.id),
    'add-rule': addRule,
    'delete-rule': (el) => {
      app.state.rules = app.state.rules.filter((r) => r.id !== el.dataset.id);
      commit('규칙을 지웠어요.');
    },
    'tx-delete': deleteTx,
    'tx-to-sub': txToSub,
    backup: doBackup,
    restore: () => $('#restoreFile').click(),
    wipe: wipeAll,
    'save-paykey': () => {
      app.state.settings.payKey = ($('#payKey').value || '').trim();
      commit('기본값을 저장했어요.');
    },
    help: (el) => {
      const h = HELP[el.dataset.topic];
      if (h) openSheet(h[0], h[1], { kind: 'help' });
    },
    'close-sheet': closeSheet,
    reload: () => location.reload(),
    'chart-col': (el) => {
      app.chartActive = Number(el.dataset.i);
      applyChartActive();
    },
    'close-banner': () => {
      $('#banner').hidden = true;
      try {
        sessionStorage.setItem('subcal-banner', '1');
      } catch (e) {
        /* 저장 못 해도 이번에만 닫으면 된다 */
      }
    },
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) {
      if (e.target === $('#sheet')) closeSheet();
      else if (app.chartActive >= 0 && !e.target.closest('#chart')) {
        app.chartActive = -1;
        applyChartActive();
      }
      return;
    }
    const fn = ACTIONS[el.dataset.action];
    if (fn) {
      e.preventDefault();
      fn(el);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && app.sheet) return closeSheet();
    const t = e.target;
    if ((e.key === 'Enter' || e.key === ' ') && t instanceof SVGElement && t.dataset.action) {
      e.preventDefault();
      ACTIONS[t.dataset.action](t);
    }
  });

  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t instanceof SVGElement && t.dataset.action === 'chart-col') {
      app.chartActive = Number(t.dataset.i);
      applyChartActive();
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'importFile' || t.id === 'restoreFile') {
      const f = t.files && t.files[0];
      t.value = ''; // 같은 파일을 다시 골라도 동작하게
      if (f) (t.id === 'importFile' ? handleImportFile : handleRestoreFile)(f);
    } else if (t.id === 'excludeToggle') {
      const tx = app.state.txs.find((x) => x.id === t.dataset.id);
      if (tx) {
        tx.excluded = t.checked;
        commit(t.checked ? '지출에서 뺐어요.' : '지출에 다시 넣었어요.');
      }
    } else if (t.name === 'cycle' && t.form) {
      t.form.classList.toggle('is-yearly', t.value === 'yearly');
    }
  });

  document.addEventListener('submit', (e) => {
    e.preventDefault();
    if (e.target.id === 'subForm') saveSubForm(e.target);
    else if (e.target.id === 'txForm') saveTxForm(e.target);
  });

  const viewFromHash = () => {
    const v = location.hash.slice(1);
    return VIEWS.includes(v) ? v : 'home';
  };

  window.addEventListener('hashchange', () => {
    app.view = viewFromHash();
    app.chartActive = -1;
    closeSheet();
    render();
    window.scrollTo(0, 0);
  });

  let resizeFrame = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (app.view === 'home') drawChart();
    });
  });

  // 앱을 켜 둔 채 날짜가 바뀌면 D-day를 다시 계산한다
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const t = C.todayStr();
    if (t !== app.today) {
      app.today = t;
      render();
    }
  });

  function showBanner() {
    const el = $('#banner');
    if (DEMO) {
      el.innerHTML = '<p>샘플 데이터예요. 바꾼 내용은 저장되지 않아요.</p>';
      el.hidden = false;
      return;
    }
    const standalone = navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
    let closed = false;
    try {
      closed = sessionStorage.getItem('subcal-banner') === '1';
    } catch (e) {
      closed = false;
    }
    if (standalone || closed) return;
    el.innerHTML = `<p>홈 화면에 추가한 <b>구독달력</b> 아이콘으로 열어 주세요. Safari와 홈 화면 앱은 데이터가 따로 저장될 수 있어요. <button class="link" data-action="help" data-topic="install">추가하는 법</button></p>
      <button class="icon-btn" data-action="close-banner" aria-label="안내 닫기">✕</button>`;
    el.hidden = false;
  }

  // ---------- 시작 ----------
  async function start() {
    const t = C.parseYmd(app.today);
    app.y = t.y;
    app.m = t.m;
    app.view = viewFromHash();
    if (DEMO) {
      await loadScript('demo.js', 'Demo');
      app.state = C.normalizeState(window.Demo.build(app.today));
    } else {
      try {
        app.state = C.normalizeState(await DB.get('state'));
      } catch (e) {
        app.canSave = false;
        setTimeout(() => toast('이 브라우저에서는 데이터를 저장할 수 없어요.'), 300);
      }
    }
    derive();
    showBanner();
    render();
    document.body.dataset.ready = '1';
    if (app.canSave && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    if ('serviceWorker' in navigator && location.protocol !== 'file:' && !params.has('nosw')) {
      // 새 버전이 설치되면 지금 화면은 옛 코드라서, 다시 불러오라고 알린다(처음 설치될 때는 알리지 않는다)
      const hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) return;
        const el = $('#banner');
        el.innerHTML = '<p>새 버전이 준비됐어요.</p><button class="pill" data-action="reload">적용</button>';
        el.hidden = false;
      });
      navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {});
    }
  }

  start().catch((e) => {
    document.body.dataset.error = String((e && e.message) || e);
    console.error(e);
  });
})();
