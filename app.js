/* 구독달력 화면
 * 흐름: app.state(저장되는 데이터)를 바꾼다 → commit() → IndexedDB에 저장 → 지금 탭을 다시 그린다 → 입력 기기면 GitHub에 올린다.
 * PC ↔ 폰 연결(sync.js): 입력 기기(PC)가 GitHub 비공개 저장소의 state.json에 올리고,
 * 보기 기기(폰)는 열 때·화면으로 돌아올 때마다 받아 와서 읽기 전용으로 보여 준다.
 * 사용자 입력·GitHub에서 받은 글자는 모두 esc()를 거쳐 HTML에 넣는다(토큰이 저장되는 앱이라 특히 중요하다).
 */
(function () {
  'use strict';
  const C = window.Core;
  const S = window.Sync;
  const params = new URLSearchParams(location.search);
  const DEMO = params.has('demo'); // 화면 확인용 샘플 데이터(저장하지 않음)
  const VIEWS = ['home', 'calendar', 'subs', 'spend', 'plan'];
  const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
  const COLOR_SLOTS = 8; // styles.css의 --cat-0 ~ --cat-7
  const DEFAULT_REPO = 'iwgh08/subscription-data';
  const PUSH_DELAY = 1500; // 마지막으로 바꾼 뒤 이만큼 기다렸다가 올린다
  // 개발 서버의 가짜 GitHub(?gh=/__gh)는 localhost에서, '/'로 시작하는 상대 경로일 때만 받는다
  const API_BASE = (() => {
    const v = params.get('gh');
    const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    return local && v && /^\/[A-Za-z0-9_\-/]*$/.test(v) ? location.origin + v : S.API;
  })();
  const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const LOOKS_LIKE_PHONE = navigator.standalone === true || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  const app = {
    state: C.emptyState(),
    today: C.todayStr(),
    y: 0,
    m: 0,
    view: 'home',
    sheet: null, // 열린 시트 { kind, refresh }
    chartActive: -1,
    chart: null,
    sync: null, // { repo, token, role: 'writer' | 'reader', sha, dirty, lastSyncAt, remoteUpdatedAt }
    status: null, // 연결 상태 { kind: 'busy' | 'ok' | 'error', text }
    conflictRemote: null,
    quickDate: null, // 빠른 입력 줄에서 마지막으로 쓴 날짜
    planDate: null, // 계산 탭에서 고른 날짜
    plans: [], // 계산 탭의 써 볼 지출 [{ id, date, amount, title }] — 저장하지 않는다
    canSave: !DEMO,
  };

  // ---------- 작은 도구 ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
  const won = (n) => `${Math.round(Number(n) || 0).toLocaleString('ko-KR')}원`;
  const sum = (list, f) => list.reduce((a, x) => a + (Number(f(x)) || 0), 0);
  const pad2 = (n) => String(n).padStart(2, '0');
  const md = (date) => {
    const p = C.parseYmd(date);
    return `${p.m}/${p.d}`;
  };
  const mdw = (date) => `${md(date)} (${WEEK[C.weekday(date)]})`;
  const longDate = (date) => {
    const p = C.parseYmd(date);
    return `${p.m}월 ${p.d}일 (${WEEK[C.weekday(date)]})`;
  };
  const hm = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '-' : `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
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
  const isWriter = () => !!(app.sync && app.sync.role === 'writer');
  const readOnly = () => !!(app.sync && app.sync.role === 'reader');

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

  // ---------- 저장: IndexedDB의 'state'(데이터)와 'sync'(연결 설정·토큰) ----------
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
    // 여러 키를 한 번에(하나의 트랜잭션으로) 저장한다. 값이 undefined면 지운다
    async setMany(entries) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        const store = tx.objectStore('kv');
        for (const [k, v] of Object.entries(entries)) {
          if (v === undefined) store.delete(k);
          else store.put(v, k);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  };

  // 데이터와 연결 설정(아직 안 올린 변경 표시 포함)을 함께 저장한다 — 둘이 어긋나지 않게
  function persist() {
    if (!app.canSave) return Promise.resolve();
    return DB.setMany({ state: app.state, sync: app.sync || undefined }).catch(() => toast('저장하지 못했어요. 저장 공간을 확인해 주세요.'));
  }

  // 데이터를 바꾼 뒤 부른다. 입력 기기면 잠시 뒤 GitHub에 올린다
  function commit(message, changedData = true) {
    if (changedData) {
      app.state.updatedAt = new Date().toISOString();
      if (isWriter()) app.sync.dirty = true;
    }
    persist();
    render();
    if (app.sheet && app.sheet.refresh) app.sheet.refresh();
    if (message) toast(message);
    if (changedData && isWriter()) schedulePush();
  }

  // ---------- PC ↔ 폰 연결 ----------
  const client = () => S.client({ repo: app.sync.repo, token: app.sync.token, base: API_BASE });
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn)); // GitHub 요청이 겹치지 않게 차례로 실행
  let pushTimer = 0;
  const schedulePush = (delay = PUSH_DELAY) => {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => serial(pushOnce), delay);
  };

  function setStatus(kind, text) {
    app.status = kind ? { kind, text: text || '' } : null;
    renderSyncbar();
  }

  function syncLine() {
    if (!app.sync) return '';
    const st = app.status;
    if (readOnly()) {
      // 보기 기기는 옛 데이터를 조용히 보여 주지 않도록 두 시각을 항상 보여 준다
      const times = `PC 수정 ${app.sync.remoteUpdatedAt ? hm(app.sync.remoteUpdatedAt) : '-'} · 받아옴 ${app.sync.lastSyncAt ? hm(app.sync.lastSyncAt) : '-'}`;
      return st && st.kind !== 'ok' ? `${st.text} · ${times}` : times;
    }
    if (st && st.kind !== 'ok') return st.text;
    if (app.sync.dirty) return '아직 올리지 않은 변경이 있어요';
    return app.sync.lastSyncAt ? `GitHub에 저장됨 ${hm(app.sync.lastSyncAt)}` : 'GitHub에 연결됨';
  }

  function renderSyncbar() {
    const el = $('#syncbar');
    // 오류·진행 중이 아니어도 아직 안 올린 변경이 있으면 '진행 중'으로 본다(점검 스크립트도 data-sync를 본다)
    const kind = !app.sync ? 'off' : app.status && app.status.kind !== 'ok' ? app.status.kind : app.sync.dirty ? 'busy' : 'ok';
    document.body.dataset.sync = kind;
    if (!app.sync || DEMO) {
      el.hidden = true;
      return;
    }
    el.className = `syncbar ${kind}`;
    el.innerHTML = `<span class="grow">${kind === 'error' ? '⚠ ' : ''}${esc(syncLine())}</span>
      <button class="icon-btn small" data-action="sync-now" aria-label="${readOnly() ? '다시 받아오기' : '지금 동기화'}">↻</button>`;
    el.hidden = false;
    const line = $('#settingsSyncLine');
    if (line) line.textContent = syncLine();
  }

  // 다른 기기가 더 새 버전의 앱으로 저장했으면 받지도 올리지도 않는다(받으면 모르는 칸이 사라지고, 올리면 덮어쓴다)
  const NEWER_TEXT = '새 버전 앱에서 저장한 내용이에요. 이 기기 앱을 껐다 켜서 새 버전으로 바꿔 주세요';

  // 열 때·화면으로 돌아올 때·↻를 누를 때: 원격과 비교해서 받아오거나 올린다
  function syncNow() {
    if (!app.sync || DEMO) return Promise.resolve();
    return serial(async () => {
      if (!app.sync) return;
      setStatus('busy', readOnly() ? '받아오는 중…' : '확인 중…');
      try {
        const c = client();
        const remote = await c.read();
        if (remote && C.isNewerState(remote.state)) return setStatus('error', NEWER_TEXT);
        if (!remote) await c.checkRepo(); // 404가 '파일 없음'인지 '저장소·권한 없음'인지 가린다
        const action = S.decideSync({
          role: app.sync.role,
          remoteSha: remote ? remote.sha : null,
          lastSha: app.sync.sha,
          dirty: !!app.sync.dirty,
          localEmpty: C.isEmptyState(app.state),
        });
        if (action === 'pull') return applyRemote(remote);
        if (action === 'conflict') {
          setStatus('error', 'GitHub과 이 PC의 내용이 달라요');
          return openConflict(remote);
        }
        if (action === 'missing') return setStatus('error', 'PC에서 아직 올린 내용이 없어요');
        if (!remote) app.sync.sha = null; // 원격 파일이 없으면 새로 만든다
        if (action === 'push') return pushOnce();
        app.sync.lastSyncAt = new Date().toISOString(); // 바뀐 건 없어도 확인한 시각은 남긴다
        persist();
        setStatus('ok');
      } catch (e) {
        setStatus('error', `${readOnly() ? '받아오지 못함' : '확인하지 못함'}: ${S.describe(e)}`);
      }
    });
  }

  // 입력 기기: 바뀐 내용을 올린다(serial 안에서만 부른다)
  async function pushOnce() {
    if (!isWriter() || !app.sync.dirty) return;
    setStatus('busy', '올리는 중…');
    const snapshot = JSON.parse(JSON.stringify(app.state));
    try {
      app.sync.sha = await client().write(snapshot, app.sync.sha);
      app.sync.lastSyncAt = new Date().toISOString();
      app.sync.remoteUpdatedAt = snapshot.updatedAt;
      if (app.state.updatedAt === snapshot.updatedAt) app.sync.dirty = false; // 올리는 사이에 또 바뀌었으면 한 번 더
      persist();
      setStatus('ok');
      if (app.sync.dirty) schedulePush(300);
    } catch (e) {
      if (e.code === 'conflict') {
        // 다른 곳에서 먼저 바뀌었다 → 다시 받아서 어느 쪽을 남길지 묻는다
        const remote = await client()
          .read()
          .catch(() => null);
        if (remote && C.isNewerState(remote.state)) return setStatus('error', NEWER_TEXT);
        if (remote && remote.sha !== app.sync.sha) {
          setStatus('error', 'GitHub과 이 PC의 내용이 달라요');
          return openConflict(remote);
        }
      }
      setStatus('error', `올리지 못함: ${S.describe(e)}`);
    }
  }

  function applyRemote(remote) {
    app.state = C.normalizeState(remote.state);
    app.sync.sha = remote.sha;
    app.sync.dirty = false;
    app.sync.lastSyncAt = new Date().toISOString();
    app.sync.remoteUpdatedAt = app.state.updatedAt;
    persist();
    setStatus('ok');
    render();
    if (app.sheet && app.sheet.refresh) app.sheet.refresh();
  }

  function openConflict(remote) {
    const r = C.normalizeState(remote.state);
    const line = (s) => `구독 ${s.subs.length}개 · 지출 ${s.expenses.length}건 · 수입 ${s.incomes.length}건 · 수정 ${s.updatedAt ? hm(s.updatedAt) : '-'}`;
    app.conflictRemote = remote;
    openSheet(
      'GitHub과 이 PC의 내용이 달라요',
      `<p>다른 곳에서 GitHub 내용이 바뀌었는데, 이 PC에도 아직 올리지 않은 변경이 있어요. 어느 쪽을 남길지 골라 주세요.</p>
      <dl class="kv"><dt>GitHub</dt><dd>${esc(line(r))}</dd><dt>이 PC</dt><dd>${esc(line(app.state))}</dd></dl>
      <div class="actions"><button class="btn" data-action="conflict-remote">GitHub 내용 쓰기</button><button class="btn primary" data-action="conflict-local">이 PC 내용으로 덮어쓰기</button></div>
      <p class="note">고르기 전까지는 GitHub에 올리지 않아요.</p>`,
      { kind: 'conflict' },
    );
  }

  async function connect(btn) {
    const err = $('#syncError');
    const show = (msg) => {
      err.textContent = msg;
      err.hidden = !msg;
    };
    const repo = S.normalizeRepo($('#syncRepo').value);
    const token = S.cleanToken($('#syncToken').value);
    const roleEl = document.querySelector('input[name="syncRole"]:checked');
    const role = roleEl && roleEl.value === 'reader' ? 'reader' : 'writer';
    if (!repo) return show('저장소 이름을 확인해 주세요. 예: iwgh08/subscription-data');
    if (!token) return show('토큰을 붙여 넣어 주세요.');
    show('');
    btn.disabled = true;
    btn.textContent = '연결하는 중…';
    try {
      const c = S.client({ repo, token, base: API_BASE });
      const info = await c.checkRepo();
      if (!info.private && !confirm('이 저장소는 공개(Public) 저장소예요. 누구나 데이터를 볼 수 있어요. 그래도 연결할까요?')) return;
      const remote = await c.read();
      const localEmpty = C.isEmptyState(app.state);
      // 보기 기기에 데이터가 있으면 언제나 먼저 묻는다. PC가 아직 안 올렸어도, PC가 처음 올리는 순간 이 기기 내용이 바뀌기 때문이다
      if (role === 'reader' && !localEmpty) {
        const mine = `구독 ${app.state.subs.length}개, 지출 ${app.state.expenses.length}건, 수입 ${app.state.incomes.length}건`;
        const msg = remote
          ? `이 기기에 있는 데이터(${mine})를 PC에서 올린 내용으로 바꿀까요? 이 기기에만 있는 내용은 사라져요.`
          : `PC에서 아직 올린 내용이 없어요. 연결하면 PC가 처음 올릴 때 이 기기의 데이터(${mine})가 그 내용으로 바뀌어요. 먼저 백업 파일을 만들어 PC로 옮기는 게 좋아요. 그래도 연결할까요?`;
        if (!confirm(msg)) return;
      }
      // 데이터가 있는 PC를 처음 연결하면 '안 올린 변경'으로 본다 → 원격 파일이 있으면 덮지 않고 충돌로 묻는다
      app.sync = { repo, token, role, sha: null, dirty: role === 'writer' && !localEmpty, lastSyncAt: null, remoteUpdatedAt: null };
      app.status = null;
      await persist();
      closeSheet();
      render();
      toast(role === 'reader' ? '보기 기기로 연결했어요.' : '입력 기기로 연결했어요.');
      syncNow();
    } catch (e) {
      show(`연결하지 못했어요: ${S.describe(e)}`);
    } finally {
      if (btn.isConnected) {
        btn.disabled = false;
        btn.textContent = '연결';
      }
    }
  }

  function disconnect() {
    const warn = isWriter() && app.sync.dirty ? ' 아직 GitHub에 올리지 않은 변경이 있는데, 끊으면 올라가지 않아요.' : '';
    if (!confirm(`이 기기의 연결을 끊을까요? 데이터는 이 기기에 그대로 남아요.${warn}`)) return;
    clearTimeout(pushTimer);
    app.sync = null;
    app.status = null;
    persist();
    closeSheet();
    render();
    toast('연결을 끊었어요.');
  }

  // ---------- 화면 그리기 ----------
  function render() {
    $('#monthLabel').textContent = `${app.y}년 ${app.m}월`;
    $('#thisMonth').hidden = isThisMonth();
    for (const v of VIEWS) $(`#view-${v}`).hidden = v !== app.view;
    document.querySelectorAll('.tabbar a').forEach((a) => {
      if (a.dataset.tab === app.view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    renderSyncbar();
    ({ home: renderHome, calendar: renderCalendar, subs: renderSubs, spend: renderSpend, plan: renderPlan })[app.view]();
  }

  // ----- 홈 -----
  // 지금 통장 잔액: 고른 달과 상관없이 오늘 기준. 은행과 연결된 값이 아니라 앱이 계산한 값이라고 밝힌다
  function balanceCard() {
    const b = C.balanceNow(app.state, app.today);
    if (!b) {
      return `<section class="card">
        <div class="label">지금 통장 잔액</div>
        ${
          readOnly()
            ? '<p class="note">PC에서 통장 잔액을 한 번 적어 두면, 여기에 지금 있는 돈이 계산돼서 보여요.</p>'
            : `<p class="note">은행 앱에 보이는 잔액을 한 번 적어 두면, 그 뒤에 적는 수입·지출과 구독 결제를 더하고 빼서 지금 있는 돈을 보여 드려요.</p>
              <button class="btn primary block mt" data-action="balance">잔액 입력하기</button>`
        }
      </section>`;
    }
    const a = app.state.balance;
    // "수입 +30,000원"처럼 이름과 금액은 한 줄에 둔다
    const parts = [b.income ? `수입 +${won(b.income)}` : '', b.spent ? `지출 -${won(b.spent)}` : '', b.subs ? `구독 -${won(b.subs)}` : '']
      .filter(Boolean)
      .map((p) => `<span class="nowrap">${p}</span>`);
    const from = `${a.setAt ? hm(a.setAt) : md(a.date)}에 맞춘 잔액 ${won(b.base)}`;
    return `<section class="card">
      <div class="label">지금 통장 잔액 <span class="label-sub">오늘 기준 · 앱 계산</span></div>
      <div class="hero" id="balanceHero">${won(b.total)}</div>
      <p class="note">${from}${parts.length ? `에서 ${parts.join(' · ')}` : ' 그대로예요'}</p>
      ${b.total < 0 ? '<p class="note warn">계산한 잔액이 0원보다 적어요. 빠뜨린 수입이 있는지 보거나 잔액을 다시 맞춰 주세요.</p>' : ''}
      <p class="note">${readOnly() ? '' : '<button class="link" data-action="balance">잔액 맞추기</button> · '}<button class="link" data-action="help" data-topic="balance">계산 방법</button></p>
    </section>`;
  }

  function renderHome() {
    const s = app.state;
    const t = C.monthTotals(s.subs, s.expenses, app.y, app.m);
    const inc = C.monthIncome(s.incomes, app.y, app.m);
    const pr = C.monthProgress(s.subs, app.y, app.m, app.today);
    const up = C.upcoming(s.subs, app.today, 30);
    let subNote;
    if (!s.subs.length) subNote = readOnly() ? '등록한 구독이 없어요.' : '등록한 구독이 없어요. <button class="link" data-action="add-sub">구독 추가</button>';
    else if (!pr.count) subNote = '이 달에는 결제할 구독이 없어요.';
    else if (!pr.remain.count) subNote = `이 달 구독 결제 ${pr.count}건이 모두 지났어요.`;
    else if (!pr.past.count) subNote = `남은 구독 결제 ${pr.remain.count}건 ${won(pr.remain.amount)}`;
    else subNote = `구독 결제 지남 ${pr.past.count}건 · 남은 ${pr.remain.count}건 ${won(pr.remain.amount)}`;

    $('#view-home').innerHTML = `
      ${balanceCard()}
      <section class="card">
        <div class="label">${app.m}월 총 지출</div>
        <div class="stat" id="monthTotal">${won(t.total)}</div>
        <div class="stat-row"><span><i class="key s1"></i>정기 구독료</span><b>${won(t.subs)}</b></div>
        <div class="stat-row"><span><i class="key s2"></i>그 외 지출</span><b>${won(t.other)}</b></div>
        <p class="note">${subNote}</p>
        <p class="note">직접 적은 지출 ${t.count}건${inc.count ? ` · 수입 ${inc.count}건 +${won(inc.amount)}` : ''}${readOnly() ? '' : ' · <button class="link" data-action="go" data-view="spend">내역 적기</button>'}</p>
      </section>
      <section class="card">
        <h2 class="card-title">다가오는 결제 <small>30일</small></h2>
        ${up.length ? `<ul class="list">${up.map(upcomingRow).join('')}</ul>` : '<p class="empty">30일 안에 결제할 구독이 없어요.</p>'}
      </section>
      <section class="card">
        <h2 class="card-title">최근 6개월 지출</h2>
        <div class="legend"><span><i class="key s1"></i>정기 구독료</span><span><i class="key s2"></i>그 외 지출</span></div>
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

  // ----- 6개월 쌓는 막대그래프: 아래 = 정기 구독료, 위 = 그 외 지출 -----
  function chartData() {
    const out = [];
    for (let i = 5; i >= 0; i--) {
      const { y, m } = C.addMonths(app.y, app.m, -i);
      const t = C.monthTotals(app.state.subs, app.state.expenses, y, m);
      out.push({ y, m, subs: t.subs, other: t.other, total: t.total });
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
      box.innerHTML = '<p class="empty">아직 지출이 없어서 그래프가 비어 있어요.</p>';
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
      svg += `${g}</g>`;
      const last = i === data.length - 1;
      if (last && d.total) svg += `<text class="cap" x="${f(cx)}" y="${f(base - hs - ho - 6)}" text-anchor="middle">${compact(d.total)}</text>`;
      svg += `<text class="xlab${last ? ' cur' : ''}" x="${f(cx)}" y="${H - 6}" text-anchor="middle">${d.m}월</text>`;
      svg += `<rect class="hit" x="${f(L + band * i)}" y="${T - 14}" width="${f(band)}" height="${f(ph + 14)}" data-action="chart-col" data-i="${i}" tabindex="0" role="button" aria-label="${d.y}년 ${d.m}월 총 지출 ${won(d.total)}, 정기 구독료 ${won(d.subs)}, 그 외 지출 ${won(d.other)}"/>`;
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
      <div class="tt-row"><i class="tt-key s1"></i><b>${won(d.subs)}</b><span>정기 구독료</span></div>
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
    return `<details class="table-view"><summary>표로 보기</summary><table class="data-table"><thead><tr><th>달</th><th>구독료</th><th>그 외</th><th>합계</th></tr></thead><tbody>${rows}</tbody></table></details>`;
  }

  // ----- 달력 -----
  const whenBadge = (date) => `<span class="badge">${date < app.today ? '지남' : '예정'}</span>`;

  function renderCalendar() {
    const charges = C.chargesInMonth(app.state.subs, app.y, app.m);
    const events = C.eventsInMonth(app.state.events, app.y, app.m);
    const byDate = new Map();
    for (const c of charges) {
      if (!byDate.has(c.date)) byDate.set(c.date, []);
      byDate.get(c.date).push(c);
    }
    const evByDate = new Map();
    for (const e of events) {
      if (!evByDate.has(e.date)) evByDate.set(e.date, []);
      evByDate.get(e.date).push(e);
    }
    let cells = '';
    for (const week of C.calendarWeeks(app.y, app.m)) {
      week.forEach((date, i) => {
        if (!date) {
          cells += '<div class="cal-cell" aria-hidden="true"></div>';
          return;
        }
        const list = byDate.get(date) || [];
        const evs = evByDate.get(date) || [];
        const total = sum(list, (c) => c.sub.amount);
        const cls = ['cal-cell', i === 0 ? 'sun' : i === 6 ? 'sat' : '', list.length || evs.length ? 'has' : '', date === app.today ? 'today' : ''].filter(Boolean).join(' ');
        // 칸에는 두 줄까지: 일정(네모 표시)을 먼저, 그다음 구독(색 점)
        const chips = [
          ...evs.map((e) => `<span class="chip ev"><i class="ev-mark"></i><span class="t">${esc(e.title)}</span></span>`),
          ...list.map((c) => `<span class="chip"><i class="dot c${colorOf(c.sub)}"></i>${esc(short(c.sub.name))}</span>`),
        ];
        const more = chips.length > 2 ? `<span class="more">+${chips.length - 2}</span>` : '';
        const label = [longDate(date), evs.length ? `일정 ${evs.length}건` : '', list.length ? `구독 ${list.length}건 ${won(total)}` : ''].filter(Boolean).join(', ');
        cells += `<button class="${cls}" data-action="day" data-date="${date}" aria-label="${esc(label)}"><span class="num">${Number(date.slice(8))}</span>${chips.slice(0, 2).join('')}${more}${total ? `<span class="amt">${cellAmount(total)}</span>` : ''}</button>`;
      });
    }
    $('#view-calendar').innerHTML = `
      <section class="card tight">
        <div class="cal-week" aria-hidden="true">${WEEK.map((w, i) => `<span class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</span>`).join('')}</div>
        <div class="cal-grid">${cells}</div>
      </section>
      <section class="card">
        <h2 class="card-title">${app.m}월 일정 <small>${events.length}건</small></h2>
        ${events.length ? `<ul class="list">${events.map((e) => eventLine(e)).join('')}</ul>` : `<p class="empty">이 달에는 적어 둔 일정이 없어요.</p>`}
        ${readOnly() ? '' : '<button class="btn block mt" data-action="add-event">+ 일정 추가</button>'}
      </section>
      <section class="card">
        <h2 class="card-title">${app.m}월 구독 결제 <small>${charges.length}건 · ${won(sum(charges, (c) => c.sub.amount))}</small></h2>
        ${charges.length ? `<ul class="list">${charges.map(chargeRow).join('')}</ul>` : '<p class="empty">이 달에는 결제할 구독이 없어요.</p>'}
      </section>`;
  }

  const chargeRow = (c) => `
    <li><button class="row" data-action="day" data-date="${c.date}">
      <i class="dot c${colorOf(c.sub)}"></i>
      <div class="grow"><div class="name">${esc(c.sub.name)}</div><div class="sub">${mdw(c.date)}</div></div>
      ${whenBadge(c.date)}
      <span class="amt">${won(c.sub.amount)}</span>
    </button></li>`;

  // 목록 한 줄: 보기 기기에서는 누를 수 없는 줄로 그린다
  const rowOpen = (action, id) => (readOnly() ? '<div class="row">' : `<button class="row" data-action="${action}" data-id="${esc(id)}">`);
  const rowClose = () => (readOnly() ? '</div>' : '</button>');

  const subChargeLine = (c) => `<li>${rowOpen('edit-sub', c.sub.id)}<i class="dot c${colorOf(c.sub)}"></i>
      <div class="grow"><div class="name">${esc(c.sub.name)} <span class="badge">정기 구독</span></div></div>
      <span class="amt">-${won(c.sub.amount)}</span>${rowClose()}</li>`;

  // 직접 적은 지출·수입 한 줄. 수입은 + 금액과 '수입' 표시(색만으로 구분하지 않는다)
  const entryLine = ({ e, inc }) => `<li>${rowOpen(inc ? 'edit-inc' : 'edit-exp', e.id)}
      <div class="grow"><div class="name">${esc(e.title || (inc ? '수입' : '지출'))}${inc ? ' <span class="badge">수입</span>' : ''}</div>${e.memo ? `<div class="sub">${esc(e.memo)}</div>` : ''}</div>
      <span class="amt${inc ? ' plus' : ''}">${inc ? '+' : '-'}${won(e.amount)}</span>${rowClose()}</li>`;

  // 일정 한 줄. withDate: 달 목록에서는 날짜도 보여 준다(그날 시트에서는 뺀다)
  const eventLine = (e, withDate = true) => `<li>${rowOpen('edit-event', e.id)}<i class="ev-mark"></i>
      <div class="grow"><div class="name">${esc(e.title)}</div><div class="sub">${[withDate ? mdw(e.date) : '', e.time || '하루 종일', esc(e.memo)].filter(Boolean).join(' · ')}</div></div>${rowClose()}</li>`;

  // 지출·수입 고르기(빠른 입력 줄과 수정 시트)
  const kindSeg = (inc) => `<div class="seg" role="radiogroup" aria-label="종류">
      <label><input type="radio" name="kind" value="out"${inc ? '' : ' checked'}>지출</label>
      <label><input type="radio" name="kind" value="in"${inc ? ' checked' : ''}>수입</label>
    </div>`;

  // 그 달의 직접 적은 지출·수입. i = 목록 안 순서(적은 시각이 없는 옛 항목을 정렬할 때 쓴다)
  const entryItems = (y, m) => [
    ...C.entriesInMonth(app.state.expenses, y, m).map((e, i) => ({ e, inc: false, i })),
    ...C.entriesInMonth(app.state.incomes, y, m).map((e, i) => ({ e, inc: true, i })),
  ];
  // 같은 날에서는 나중에 적은 것이 위로
  const byRecent = (a, b) => {
    const x = a.e.createdAt || '';
    const y = b.e.createdAt || '';
    return x < y ? 1 : x > y ? -1 : b.i - a.i;
  };

  function openDay(date) {
    const p = C.parseYmd(date);
    const charges = C.chargesInMonth(app.state.subs, p.y, p.m).filter((c) => c.date === date);
    const entries = entryItems(p.y, p.m)
      .filter((x) => x.e.date === date)
      .sort(byRecent);
    const spent = sum(charges, (c) => c.sub.amount) + sum(entries.filter((x) => !x.inc), (x) => x.e.amount);
    const income = sum(entries.filter((x) => x.inc), (x) => x.e.amount);
    const events = C.eventsInMonth(app.state.events, p.y, p.m).filter((e) => e.date === date);
    openSheet(
      longDate(date),
      `<h3>일정</h3>${events.length ? `<ul class="list">${events.map((e) => eventLine(e, false)).join('')}</ul>` : '<p class="empty">이날 적어 둔 일정이 없어요.</p>'}
      ${readOnly() ? '' : `<button class="btn block mt" data-action="add-event" data-date="${date}">+ 이날 일정 추가</button>`}
      <h3 class="mt">구독 결제</h3>${charges.length ? `<ul class="list">${charges.map(subChargeLine).join('')}</ul>` : '<p class="empty">이날 결제할 구독이 없어요.</p>'}
      <h3 class="mt">직접 적은 지출·수입</h3>${entries.length ? `<ul class="list">${entries.map(entryLine).join('')}</ul>` : '<p class="empty">이날 적은 내역이 없어요.</p>'}
      <p class="note">이날 지출 ${won(spent)}${income ? ` · 수입 +${won(income)}` : ''}</p>`,
      { kind: 'day', date, refresh: () => openDay(date) },
    );
  }

  // ----- 구독 -----
  function renderSubs() {
    const s = app.state;
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
        return `<li>${rowOpen('edit-sub', sub.id)}
          <i class="dot c${colorOf(sub)}"></i>
          <div class="grow"><div class="name">${esc(sub.name)}</div><div class="sub">${cycle} · ${nextText}</div></div>
          <span class="amt">${won(sub.amount)}</span>${rowClose()}</li>`;
      })
      .join('');
    $('#view-subs').innerHTML = `
      <section class="card">
        <div class="label">월 환산 합계</div>
        <div class="stat">${won(C.monthlyEquivalent(s.subs, app.today))}</div>
        <p class="note">구독 ${s.subs.length}개 · 매년 구독은 12로 나눠 더했어요.</p>
      </section>
      ${readOnly() ? '' : '<button class="btn primary block" data-action="add-sub">+ 구독 추가</button>'}
      <section class="card mt">
        ${
          s.subs.length
            ? `<ul class="list">${rows}</ul>`
            : `<p class="empty">아직 등록한 구독이 없어요.</p>${readOnly() ? '' : '<p class="note">금액과 결제일은 네이버페이 → 결제내역·정기결제, 아이폰 설정 → 이름 → 구독에서 확인할 수 있어요.</p>'}`
        }
      </section>
      <p class="note">구독료는 결제일에 맞춰 그 달 지출에 자동으로 더해져요.${readOnly() ? '' : ' <button class="link" data-action="help" data-topic="subs">구독 입력 요령</button>'}</p>`;
  }

  function nextColor() {
    const used = new Set(app.state.subs.map(colorOf));
    for (let i = 0; i < COLOR_SLOTS; i++) if (!used.has(i)) return i;
    return app.state.subs.length % COLOR_SLOTS;
  }

  function openSubForm(id) {
    if (readOnly()) return;
    const s = app.state;
    const t = C.parseYmd(app.today);
    const sub = id ? s.subs.find((x) => x.id === id) : null;
    // 새 구독은 이번 달부터 센다(등록하기 전 달의 합계에 끼어들지 않게). 더 일찍 시작했으면 시작일을 고치면 된다
    const v = sub ? { ...sub } : { name: '', amount: '', cycle: 'monthly', day: t.d, month: t.m, color: nextColor(), startDate: C.ymd(t.y, t.m, 1), endDate: '', memo: '' };
    const opt = (n, sel, unit) =>
      Array.from({ length: n }, (_, i) => i + 1)
        .map((k) => `<option value="${k}"${Number(sel) === k ? ' selected' : ''}>${k}${unit}</option>`)
        .join('');
    const swatches = Array.from(
      { length: COLOR_SLOTS },
      (_, i) => `<label class="c${i}"><input type="radio" name="color" value="${i}"${colorOf(v) === i ? ' checked' : ''} aria-label="색 ${i + 1}"></label>`,
    ).join('');
    openSheet(
      sub ? '구독 수정' : '구독 추가',
      `<form id="subForm" class="form${v.cycle === 'yearly' ? ' is-yearly' : ''}" data-id="${esc(sub ? sub.id : '')}" autocomplete="off" novalidate>
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
        <details class="more"${v.endDate || v.memo ? ' open' : ''}><summary>시작일·종료일·메모${v.startDate ? ` (${md(v.startDate)}부터 계산)` : ''}</summary>
          <label class="field"><span>시작일 (이날부터 합계에 넣어요)</span><input type="date" name="startDate" value="${esc(v.startDate || '')}"></label>
          <label class="field"><span>종료일(해지한 날)</span><input type="date" name="endDate" value="${esc(v.endDate || '')}"></label>
          <label class="field"><span>메모</span><input name="memo" maxlength="80" value="${esc(v.memo || '')}"></label>
        </details>
        <p class="note">구독료는 결제일에 맞춰 그 달 지출에 자동으로 더해져요. 내역 탭에 따로 적지 마세요.</p>
        <div class="actions"><button class="btn primary" type="submit">저장</button>${sub ? '<button type="button" class="btn danger" data-action="sub-delete">삭제</button>' : ''}</div>
      </form>`,
      { kind: 'sub' },
    );
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

  // ----- 내역(지출·수입) -----
  function renderSpend() {
    const s = app.state;
    const t = C.monthTotals(s.subs, s.expenses, app.y, app.m);
    const inc = C.monthIncome(s.incomes, app.y, app.m);
    // 그 달의 구독 결제(자동)와 직접 적은 지출·수입을 날짜별로 함께 보여 준다. 같은 날은 구독 먼저, 나머지는 최근에 적은 것 먼저
    const items = [
      ...C.chargesInMonth(s.subs, app.y, app.m).map((c, i) => ({ date: c.date, kind: 0, i, html: subChargeLine(c) })),
      ...entryItems(app.y, app.m).map((x) => ({ date: x.e.date, kind: 1, x, html: entryLine(x) })),
    ].sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : a.kind - b.kind || (a.kind ? byRecent(a.x, b.x) : a.i - b.i)));
    let list = '';
    let cur = '';
    for (const it of items) {
      if (it.date !== cur) {
        if (cur) list += '</ul>';
        cur = it.date;
        list += `<h3 class="day-head">${longDate(it.date)}</h3><ul class="list">`;
      }
      list += it.html;
    }
    if (cur) list += '</ul>';
    const inMonth = app.quickDate && app.quickDate.startsWith(C.monthKey(app.y, app.m));
    const date = inMonth ? app.quickDate : isThisMonth() ? app.today : C.ymd(app.y, app.m, 1);
    $('#view-spend').innerHTML = `
      <section class="card">
        <div class="label">${app.m}월 지출</div>
        <div class="stat">${won(t.total)}</div>
        <p class="note">정기 구독료 ${won(t.subs)} + 직접 적은 지출 ${t.count}건 ${won(t.other)}</p>
        ${inc.count ? `<p class="note">수입 ${inc.count}건 +${won(inc.amount)}</p>` : ''}
      </section>
      ${
        readOnly()
          ? ''
          : `<section class="card">
        <form id="quickAdd" class="quick" autocomplete="off" novalidate>
          ${kindSeg(false)}
          <input type="date" name="date" value="${date}" aria-label="날짜">
          <input name="amount" inputmode="numeric" placeholder="금액" aria-label="금액" enterkeyhint="next">
          <input name="title" maxlength="40" placeholder="내용 (예: 점심)" aria-label="내용" enterkeyhint="done">
          <button class="btn primary" type="submit">추가</button>
        </form>
        <p class="note">Enter로 바로 추가돼요. 수입을 하나 넣으면 다시 지출로 돌아와요. 구독료는 자동으로 빠지니 따로 적지 마세요.</p>
      </section>`
      }
      <section class="card">${items.length ? list : `<p class="empty">${app.m}월 내역이 없어요.</p>`}</section>`;
  }

  // 빠른 입력: 다시 그려지면 종류는 '지출'로 돌아온다(수입으로 잘못 들어가는 일이 없게)
  function quickAdd(form) {
    const fd = new FormData(form);
    const income = fd.get('kind') === 'in';
    const date = String(fd.get('date') || '');
    const amount = digits(fd.get('amount'));
    const title = String(fd.get('title') || '').trim();
    if (!C.isYmd(date)) return toast('날짜를 골라 주세요.');
    if (!amount) {
      form.elements.amount.focus();
      return toast('금액을 적어 주세요.');
    }
    const entry = { id: `${income ? 'i' : 'e'}${uid()}`, date, amount, title: title || (income ? '수입' : '지출'), memo: '', createdAt: new Date().toISOString() };
    (income ? app.state.incomes : app.state.expenses).push(entry);
    app.quickDate = date;
    const p = C.parseYmd(date); // 다른 달 날짜를 골랐으면 그 달을 보여 준다
    app.y = p.y;
    app.m = p.m;
    commit(`${income ? '수입' : '지출'} ${won(amount)}을 추가했어요.`);
    const f = $('#quickAdd');
    if (f) f.elements.amount.focus();
  }

  function findEntry(id) {
    const e = app.state.expenses.find((x) => x.id === id);
    if (e) return { e, inc: false };
    const i = app.state.incomes.find((x) => x.id === id);
    return i ? { e: i, inc: true } : null;
  }

  function openEntry(id) {
    if (readOnly()) return;
    const f = findEntry(id);
    if (!f) return;
    const { e, inc } = f;
    openSheet(
      inc ? '수입 수정' : '지출 수정',
      `<form id="expForm" class="form" data-id="${esc(e.id)}" autocomplete="off" novalidate>
        <div class="field"><span>종류</span>${kindSeg(inc)}</div>
        <label class="field"><span>날짜</span><input type="date" name="date" value="${esc(e.date)}"></label>
        <label class="field"><span>금액(원)</span><input name="amount" inputmode="numeric" value="${esc(Number(e.amount).toLocaleString('ko-KR'))}"></label>
        <label class="field"><span>내용</span><input name="title" maxlength="40" value="${esc(e.title)}"></label>
        <label class="field"><span>메모</span><input name="memo" maxlength="80" value="${esc(e.memo)}"></label>
        <div class="actions"><button class="btn primary" type="submit">저장</button><button type="button" class="btn danger" data-action="exp-delete">삭제</button></div>
      </form>`,
      { kind: 'exp' },
    );
  }

  function saveEntry(form) {
    const f = findEntry(form.dataset.id);
    if (!f) return closeSheet();
    const fd = new FormData(form);
    const income = fd.get('kind') === 'in';
    const date = String(fd.get('date') || '');
    const amount = digits(fd.get('amount'));
    if (!C.isYmd(date)) return toast('날짜를 골라 주세요.');
    if (!amount) return toast('금액을 적어 주세요.');
    let title = String(fd.get('title') || '').trim();
    if (!title || (income !== f.inc && title === (f.inc ? '수입' : '지출'))) title = income ? '수입' : '지출'; // 기본 이름은 종류를 따라 바꾼다
    Object.assign(f.e, { date, amount, title, memo: String(fd.get('memo') || '').trim() });
    if (income !== f.inc) {
      // 종류를 바꿨으면 다른 목록으로 옮긴다(적은 시각은 그대로)
      const from = f.inc ? 'incomes' : 'expenses';
      app.state[from] = app.state[from].filter((x) => x !== f.e);
      (income ? app.state.incomes : app.state.expenses).push(f.e);
    }
    closeSheet();
    commit(`${income ? '수입' : '지출'}을 고쳤어요.`);
  }

  function deleteEntry() {
    const form = $('#expForm');
    const f = form && findEntry(form.dataset.id);
    if (!f || !confirm(`'${f.e.title}' ${won(f.e.amount)}을 지울까요?`)) return;
    const key = f.inc ? 'incomes' : 'expenses';
    app.state[key] = app.state[key].filter((x) => x !== f.e);
    closeSheet();
    commit(`${f.inc ? '수입' : '지출'}을 지웠어요.`);
  }

  // ----- 일정 -----
  // back: 그날 시트에서 열었으면 그 날짜(저장·삭제 뒤 그날 시트로 돌아간다)
  function openEvent(id, date, back) {
    if (readOnly()) return;
    const e = id ? app.state.events.find((x) => x.id === id) : null;
    if (id && !e) return;
    // 날짜를 안 정했으면 보고 있는 달(이번 달이면 오늘, 다른 달이면 그 달 1일)
    const d = e ? e.date : C.isYmd(date) ? date : isThisMonth() ? app.today : C.ymd(app.y, app.m, 1);
    openSheet(
      e ? '일정 수정' : '일정 추가',
      `<form id="eventForm" class="form" data-id="${esc(e ? e.id : '')}" data-back="${esc(back || '')}" autocomplete="off" novalidate>
        <label class="field"><span>날짜</span><input type="date" name="date" value="${esc(d)}"></label>
        <label class="field"><span>시간 <small>(비우면 하루 종일)</small></span><input type="time" name="time" value="${esc(e ? e.time : '')}"></label>
        <label class="field"><span>내용</span><input name="title" maxlength="40" placeholder="예: 치과" value="${esc(e ? e.title : '')}"></label>
        <label class="field"><span>메모</span><input name="memo" maxlength="80" value="${esc(e ? e.memo : '')}"></label>
        <div class="actions"><button class="btn primary" type="submit">저장</button>${e ? '<button type="button" class="btn danger" data-action="event-delete">삭제</button>' : ''}</div>
      </form>`,
      { kind: 'event' },
    );
    if (!e) $('#eventForm').elements.title.focus();
  }

  function saveEvent(form) {
    const fd = new FormData(form);
    const date = String(fd.get('date') || '');
    const time = String(fd.get('time') || '').slice(0, 5);
    const title = String(fd.get('title') || '').trim();
    if (!C.isYmd(date)) return toast('날짜를 골라 주세요.');
    if (!title) {
      form.elements.title.focus();
      return toast('내용을 적어 주세요.');
    }
    const fields = { date, time: /^\d{2}:\d{2}$/.test(time) ? time : '', title, memo: String(fd.get('memo') || '').trim() };
    const id = form.dataset.id;
    if (id) {
      const e = app.state.events.find((x) => x.id === id);
      if (!e) return closeSheet();
      Object.assign(e, fields);
    } else app.state.events.push({ id: uid(), ...fields, createdAt: new Date().toISOString() });
    afterEvent(form.dataset.back, date);
    commit(id ? '일정을 고쳤어요.' : '일정을 추가했어요.');
  }

  function deleteEvent() {
    const form = $('#eventForm');
    const e = form && app.state.events.find((x) => x.id === form.dataset.id);
    if (!e || !confirm(`'${e.title}' 일정을 지울까요?`)) return;
    app.state.events = app.state.events.filter((x) => x !== e);
    afterEvent(form.dataset.back, form.dataset.back);
    commit('일정을 지웠어요.');
  }

  // 그날 시트에서 열었으면 (날짜를 바꿨으면 바꾼 날의) 그날 시트로 돌아가고, 아니면 닫는다
  function afterEvent(back, date) {
    if (back && C.isYmd(date)) openDay(date);
    else closeSheet();
  }

  // ----- 통장 잔액 맞추기 -----
  function openBalance() {
    if (readOnly()) return;
    const today = C.todayStr();
    if (today !== app.today) {
      app.today = today;
      render();
    }
    const now = C.balanceNow(app.state, app.today);
    const p = C.parseYmd(app.today);
    const due = C.chargesInMonth(app.state.subs, p.y, p.m).filter((c) => c.date === app.today);
    openSheet(
      '통장 잔액 맞추기',
      `<form id="balForm" class="form" autocomplete="off" novalidate>
        <p class="note">은행 앱(신한 SOL뱅크)에 보이는 <b>지금 잔액</b>을 적어 주세요. 그 뒤에 적는 수입은 더하고, 지출과 앞으로 결제될 구독료는 빼서 계산해요.</p>
        <p class="note">오늘 이미 쓰거나 들어온 돈은 <b>먼저 적은 뒤에</b> 잔액을 맞추세요. 맞춘 뒤에 적으면 두 번 계산돼요.</p>
        ${now ? `<p class="note">지금 앱 계산: <b>${won(now.total)}</b></p>` : ''}
        <label class="field"><span>지금 잔액(원)</span><input name="amount" inputmode="numeric" placeholder="예: 1,250,000"></label>
        ${
          due.length
            ? `<label class="check"><input type="checkbox" name="paidToday" checked><span>오늘 결제일인 구독(${esc(due.map((c) => `${c.sub.name} ${won(c.sub.amount)}`).join(', '))})이 이미 통장에서 빠졌어요</span></label>
          <p class="note">아직 안 빠졌으면 체크를 풀어 주세요. 그러면 앱이 오늘 빼서 계산해요.</p>`
            : ''
        }
        <div class="actions"><button class="btn primary" type="submit">저장</button>${app.state.balance ? '<button type="button" class="btn danger" data-action="balance-clear">잔액 계산 끄기</button>' : ''}</div>
      </form>`,
      { kind: 'balance' },
    );
    $('#balForm').elements.amount.focus();
  }

  function saveBalance(form) {
    const fd = new FormData(form);
    const raw = String(fd.get('amount') || '');
    if (!/\d/.test(raw)) {
      form.elements.amount.focus();
      return toast('지금 잔액을 적어 주세요.'); // 0원도 적을 수 있게 빈칸만 막는다
    }
    app.today = C.todayStr();
    app.state.balance = { amount: digits(raw), date: app.today, setAt: new Date().toISOString(), paidToday: fd.get('paidToday') === 'on' };
    closeSheet();
    commit('잔액을 맞췄어요.');
  }

  function clearBalance() {
    if (!confirm('잔액 계산을 끌까요? 적어 둔 잔액만 지워지고 수입·지출 내역은 그대로 남아요.')) return;
    app.state.balance = null;
    closeSheet();
    commit('잔액 계산을 껐어요.');
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
    const sync = app.sync;
    const syncHtml = sync
      ? `<section class="set"><h3>PC ↔ 폰 연결</h3>
          <p class="note">연결됨: <b>${esc(sync.repo)}</b> · ${sync.role === 'reader' ? '보기만 하는 기기' : '입력하는 기기'}</p>
          <p class="note" id="settingsSyncLine">${esc(syncLine())}</p>
          <div class="actions"><button class="btn" data-action="sync-now">지금 동기화</button><button class="btn danger" data-action="sync-disconnect">연결 끊기</button></div>
        </section>`
      : `<section class="set"><h3>PC ↔ 폰 연결</h3>
          <p class="note">PC에서 입력하고 폰에서 보려면 두 기기를 GitHub 비공개 저장소에 연결하세요. <button class="link" data-action="help" data-topic="sync">연결 방법</button></p>
          <div class="form mt">
            <label class="field"><span>저장소</span><input id="syncRepo" value="${esc(DEFAULT_REPO)}" autocapitalize="none" autocorrect="off" spellcheck="false"></label>
            <label class="field"><span>토큰</span><input id="syncToken" type="password" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="github_pat_로 시작해요"></label>
            <div class="field"><span>이 기기는</span><div class="seg">
              <label><input type="radio" name="syncRole" value="writer"${LOOKS_LIKE_PHONE ? '' : ' checked'}>입력(PC)</label>
              <label><input type="radio" name="syncRole" value="reader"${LOOKS_LIKE_PHONE ? ' checked' : ''}>보기만(폰)</label>
            </div></div>
            <p id="syncError" class="note warn" hidden></p>
            <button class="btn primary block" data-action="sync-connect">연결</button>
          </div>
        </section>`;
    openSheet(
      '설정',
      `${DEMO ? '<p class="note warn">샘플 모드에서는 저장·연결·백업이 되지 않아요.</p>' : ''}
      ${syncHtml}
      <section class="set"><h3>내 데이터</h3>
        <p class="note">구독 ${s.subs.length}개 · 지출 ${s.expenses.length}건 · 수입 ${s.incomes.length}건 · 잔액 ${s.balance ? `${md(s.balance.date)}에 맞춤` : '안 맞춤'}</p>
        <p class="note">${readOnly() ? '이 기기는 PC에서 올린 내용을 받아서 보여 줘요.' : '휴대폰을 바꾸거나 브라우저 데이터를 지우면 사라질 수 있으니 가끔 백업 파일을 만들어 두세요.'}</p>
        <div class="actions"><button class="btn primary" data-action="backup">백업 파일 만들기</button>${readOnly() ? '' : '<button class="btn" data-action="restore">백업 불러오기</button>'}</div>
        <p class="note">${s.settings.lastBackupAt ? `마지막 백업: ${backupAgo(s.settings.lastBackupAt)}` : '아직 백업한 적이 없어요.'}</p>
      </section>
      <section class="set"><h3>도움말</h3>
        <ul class="list">
          <li><button class="row" data-action="help" data-topic="sync"><span class="grow">PC ↔ 폰 연결 방법</span>›</button></li>
          <li><button class="row" data-action="help" data-topic="balance"><span class="grow">잔액 계산 방법</span>›</button></li>
          <li><button class="row" data-action="help" data-topic="subs"><span class="grow">구독 입력 요령</span>›</button></li>
          <li><button class="row" data-action="help" data-topic="install"><span class="grow">아이폰 홈 화면에 추가하는 법</span>›</button></li>
        </ul>
      </section>
      ${readOnly() ? '' : '<section class="set"><button class="btn danger block" data-action="wipe">모든 데이터 지우기</button></section>'}
      <p class="note center">토큰은 이 기기에만 저장되고 백업 파일에는 들어가지 않아요.</p>`,
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
      commit('백업 파일을 만들었어요.', false);
    } catch (e) {
      if (!e || e.name !== 'AbortError') toast('백업 파일을 만들지 못했어요.');
    }
  }

  async function handleRestoreFile(file) {
    try {
      const state = C.readBackup(JSON.parse(await file.text()));
      const where = isWriter() ? ' GitHub에도 이 내용이 올라가요.' : '';
      if (!confirm(`백업(구독 ${state.subs.length}개, 지출 ${state.expenses.length}건, 수입 ${state.incomes.length}건)으로 지금 데이터를 바꿀까요?${where}`)) return;
      app.state = state;
      closeSheet();
      commit('백업을 불러왔어요.');
    } catch (e) {
      toast(e instanceof SyntaxError ? '백업 파일을 읽지 못했어요.' : e.message);
    }
  }

  function wipeAll() {
    const where = isWriter() ? ' GitHub에 올린 내용도 비워져요.' : '';
    if (!confirm(`구독·지출·수입과 맞춰 둔 잔액을 모두 지울까요? 되돌릴 수 없어요.${where}`)) return;
    if (!confirm('정말 지울까요? 백업 파일이 없으면 복구할 수 없어요.')) return;
    app.state = C.emptyState();
    closeSheet();
    commit('모든 데이터를 지웠어요.');
  }

  const HELP = {
    sync: [
      'PC ↔ 폰 연결 방법',
      `<ol class="steps">
        <li><b>비공개 저장소 만들기</b>: github.com → New repository → 이름 <b>subscription-data</b> → <b>Private</b> → <b>Add a README file 체크</b> → Create repository</li>
        <li><b>토큰 두 개 만들기</b>: 프로필 → Settings → Developer settings → Personal access tokens → <b>Fine-grained tokens</b> → Generate new token
          <ul>
            <li>Repository access: Only select repositories → subscription-data</li>
            <li>Expiration: 고를 수 있는 <b>가장 긴 기간</b>(기본값이면 금방 만료돼요)</li>
            <li>PC용: Repository permissions → Contents → <b>Read and write</b></li>
            <li>폰용: Contents → <b>Read-only</b></li>
          </ul></li>
        <li><b>PC</b>: 이 앱 → 설정 → PC ↔ 폰 연결 → PC용 토큰 붙여 넣기 → 입력(PC) → 연결</li>
        <li><b>폰</b>: 폰용 토큰을 PC 카카오톡 '나와의 채팅'으로 보내 복사 → 홈 화면의 구독달력 → 설정 → 붙여 넣기 → 보기만(폰) → 연결 → 카톡 메시지 지우기</li>
      </ol>
      <p class="note">폰에 이미 입력한 구독이 있으면, PC를 연결하기 전에 폰에서 백업 파일을 만들어 PC에서 불러오세요.</p>
      <p class="note">토큰은 이 기기에만 저장되고 백업 파일에도 들어가지 않아요. 폰을 잃어버리면 GitHub에서 그 토큰만 지우면 돼요.</p>`,
    ],
    subs: [
      '구독 입력 요령',
      `<p>구독은 한 번만 등록해 두면 매달 달력에 표시되고, 결제일에 맞춰 그 달 지출에 자동으로 더해져요.</p>
      <ul class="steps">
        <li><b>금액·결제일 찾기</b>: 네이버페이 → 결제내역·정기결제, 아이폰 설정 → 이름 → 구독</li>
        <li><b>29~31일 결제</b>는 짧은 달에 말일로 표시돼요.</li>
        <li>해지했으면 지우지 말고 <b>종료일</b>을 넣으세요. 지난 달 합계가 그대로 남아요.</li>
        <li>구독 결제는 내역 탭에 따로 적지 마세요. 두 번 더해져요.</li>
      </ul>`,
    ],
    balance: [
      '잔액 계산 방법',
      `<p>은행 앱에서 본 잔액을 한 번 적어 두면, 그 뒤의 수입·지출과 구독 결제를 더하고 빼서 지금 있는 돈을 계산해요. 은행과 연결된 값이 아니라 앱이 계산한 값이에요.</p>
      <ul class="steps">
        <li><b>계산</b>: 맞춘 잔액 + 그 뒤 수입 − 그 뒤 지출 − 그 뒤 구독 결제</li>
        <li>맞춘 날보다 <b>앞 날짜</b>로 적은 수입·지출은 이미 통장에 들어 있다고 보고 계산에 넣지 않아요.</li>
        <li>맞춘 날 날짜로 적은 것은 <b>맞춘 뒤에 적은 것만</b> 넣어요. 그래서 오늘 이미 쓴 돈은 먼저 적고 나서 잔액을 맞추세요.</li>
        <li>구독은 결제일이 되면 자동으로 빠져요. 구독 결제는 따로 적지 마세요.</li>
        <li>앞으로의 날짜로 적은 것은 그날이 되면 계산에 들어가요.</li>
        <li>은행 앱 잔액과 다르면 PC에서 <b>잔액 맞추기</b>로 다시 적으세요. 맞추기 화면에 앱이 계산한 값도 보여서, 빠뜨린 내역이 있는지 가늠할 수 있어요.</li>
      </ul>`,
    ],
    install: [
      '아이폰 홈 화면에 추가하는 법',
      `<ol class="steps">
        <li>Safari로 이 앱 주소를 엽니다.</li>
        <li>아래쪽 <b>공유 버튼</b>(네모에 위쪽 화살표)을 누릅니다.</li>
        <li><b>'홈 화면에 추가'</b> → '추가'를 누릅니다.</li>
        <li>이제 홈 화면의 <b>구독달력</b> 아이콘으로 여세요.</li>
      </ol>
      <p class="note">Safari에서 연 화면과 홈 화면 앱은 데이터가 따로 저장될 수 있어요. 연결도 아이콘으로 연 앱에서 하세요.</p>`,
    ],
  };

  // ----- 계산: 앞으로의 날짜를 누르면 그날 끝에 남는 돈 -----
  // 써 볼 지출(app.plans)은 메모리에만 두고 저장·연결하지 않는다. 데이터를 바꾸지 않으니 보기 기기에서도 쓸 수 있다
  const signedCell = (v) => `${v < 0 ? '-' : ''}${cellAmount(Math.abs(v))}`;
  const PLAN_KIND = { sub: ['정기 구독', '-'], in: ['수입', '+'], out: ['지출', '-'], plan: ['써 볼 지출', '-'] };

  function renderPlan() {
    const s = app.state;
    if (!app.planDate || app.planDate < app.today) app.planDate = app.today;
    app.plans = app.plans.filter((p) => p.date >= app.today);
    if (!s.balance) {
      $('#view-plan').innerHTML = `<section class="card">
        <div class="label">그날 남는 돈</div>
        ${
          readOnly()
            ? '<p class="note">PC에서 통장 잔액을 한 번 적어 두면, 날짜를 눌러 그날 남는 돈을 볼 수 있어요.</p>'
            : `<p class="note">지금 통장 잔액을 먼저 적어 주세요. 그 잔액에서 앞으로의 구독 결제와 적어 둔 수입·지출을 더하고 빼서 그날 남는 돈을 계산해요.</p>
              <button class="btn primary block mt" data-action="balance">잔액 입력하기</button>`
        }
      </section>`;
      return;
    }
    const r = C.balanceOn(s, app.today, app.planDate, app.plans);
    const parts = [
      r.subs ? `구독 -${won(r.subs)}` : '',
      r.spent ? `지출 -${won(r.spent)}` : '',
      r.income ? `수입 +${won(r.income)}` : '',
      r.planned ? `써 볼 지출 -${won(r.planned)}` : '',
    ]
      .filter(Boolean)
      .map((p) => `<span class="nowrap">${p}</span>`);
    const itemRow = (x) => {
      const [badge, sign] = PLAN_KIND[x.kind];
      return `<li><div class="row"><div class="grow"><div class="name">${esc(x.title || badge)} <span class="badge">${badge}</span></div><div class="sub">${mdw(x.date)}</div></div>
        <span class="amt${sign === '+' ? ' plus' : ''}">${sign}${won(x.amount)}</span></div></li>`;
    };
    const isToday = app.planDate === app.today;

    const planDays = new Set(app.plans.map((p) => p.date));
    let cells = '';
    for (const week of C.calendarWeeks(app.y, app.m)) {
      week.forEach((date, i) => {
        if (!date) {
          cells += '<div class="cal-cell" aria-hidden="true"></div>';
          return;
        }
        const num = `<span class="num">${Number(date.slice(8))}</span>`;
        const day = i === 0 ? 'sun' : i === 6 ? 'sat' : '';
        if (date < app.today) {
          cells += `<div class="${['cal-cell', 'past', day].filter(Boolean).join(' ')}" aria-hidden="true">${num}</div>`;
          return;
        }
        const left = C.balanceOn(s, app.today, date, app.plans).total;
        const cls = ['cal-cell', day, date === app.today ? 'today' : '', date === app.planDate ? 'selected' : '', planDays.has(date) ? 'has' : ''].filter(Boolean).join(' ');
        const label = `${longDate(date)}, 남는 돈 ${won(left)}${planDays.has(date) ? ', 써 볼 지출 있음' : ''}`;
        cells += `<button class="${cls}" data-action="plan-day" data-date="${date}" aria-label="${esc(label)}"${date === app.planDate ? ' aria-pressed="true"' : ''}>${num}<span class="amt${left < 0 ? ' neg' : ''}">${signedCell(left)}</span></button>`;
      });
    }

    const plans = app.plans.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const planRow = (p) => `<li><div class="row">
        <div class="grow"><div class="name">${esc(p.title || '써 볼 지출')}</div><div class="sub">${mdw(p.date)}${
          readOnly() ? '' : ` · <button class="link" data-action="plan-commit" data-id="${esc(p.id)}">지출로 적기</button>`
        } · <button class="link" data-action="plan-remove" data-id="${esc(p.id)}">빼기</button></div></div>
        <span class="amt">-${won(p.amount)}</span></div></li>`;

    $('#view-plan').innerHTML = `
      <section class="card">
        <div class="label">${isToday ? '오늘' : longDate(app.planDate)} 끝에 남는 돈 <span class="label-sub">앱 계산</span></div>
        <div class="hero" id="planResult">${won(r.total)}</div>
        <p class="note">지금 잔액 ${won(r.now)}${parts.length ? `에서 ${parts.join(' · ')}` : isToday ? '' : ' 그대로예요'}</p>
        ${r.total < 0 ? '<p class="note warn">이날 통장 잔액이 모자라요.</p>' : ''}
        ${
          r.items.length
            ? `<details class="plan-items mt"><summary>${isToday ? '오늘' : '그사이'} 들어오고 나가는 돈 ${r.items.length}건</summary><ul class="list">${r.items.map(itemRow).join('')}</ul></details>`
            : ''
        }
      </section>
      <section class="card tight">
        <div class="cal-week" aria-hidden="true">${WEEK.map((w, i) => `<span class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</span>`).join('')}</div>
        <div class="cal-grid">${cells}</div>
        <p class="note">날짜를 누르면 그날 끝에 남는 돈을 보여 줘요. 칸 아래 숫자가 그날 남는 돈이에요.</p>
      </section>
      <section class="card">
        <h2 class="card-title">써 볼 지출 <small>저장 안 됨</small></h2>
        <form id="planAdd" class="plan-add" autocomplete="off" novalidate>
          <input type="date" name="date" value="${app.planDate}" min="${app.today}" aria-label="날짜">
          <input name="amount" inputmode="numeric" placeholder="금액" aria-label="금액" enterkeyhint="next">
          <input name="title" maxlength="40" placeholder="내용 (예: 여행)" aria-label="내용" enterkeyhint="done">
          <button class="btn primary" type="submit">더하기</button>
        </form>
        ${plans.length ? `<ul class="list mt">${plans.map(planRow).join('')}</ul>` : ''}
        <p class="note">여기 더한 지출은 계산에만 쓰고 저장하지 않아요(앱을 닫으면 사라져요).${readOnly() ? '' : ' 실제로 쓸 거면 "지출로 적기"를 눌러 내역에 넣으세요.'}</p>
      </section>`;
  }

  function addPlan(form) {
    const fd = new FormData(form);
    const date = String(fd.get('date') || '');
    const amount = digits(fd.get('amount'));
    const title = String(fd.get('title') || '').trim();
    if (!C.isYmd(date) || date < app.today) return toast('오늘이나 앞으로의 날짜를 골라 주세요.');
    if (!amount) {
      form.elements.amount.focus();
      return toast('금액을 적어 주세요.');
    }
    app.plans.push({ id: `p${uid()}`, date, amount, title });
    // 고른 날보다 뒤에 더했으면 그날까지 보이게 고른 날을 옮긴다
    if (date > app.planDate) {
      app.planDate = date;
      const p = C.parseYmd(date);
      app.y = p.y;
      app.m = p.m;
    }
    render();
    const f = $('#planAdd');
    if (f) f.elements.amount.focus();
  }

  function commitPlan(id) {
    if (readOnly()) return;
    const i = app.plans.findIndex((p) => p.id === id);
    if (i < 0) return;
    const p = app.plans[i];
    app.plans.splice(i, 1);
    app.state.expenses.push({ id: `e${uid()}`, date: p.date, amount: p.amount, title: p.title || '지출', memo: '', createdAt: new Date().toISOString() });
    commit(`${md(p.date)} 지출 ${won(p.amount)}을 내역에 적었어요.`);
  }

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
    'plan-day': (el) => {
      app.planDate = el.dataset.date;
      render();
    },
    'plan-remove': (el) => {
      app.plans = app.plans.filter((p) => p.id !== el.dataset.id);
      render();
    },
    'plan-commit': (el) => commitPlan(el.dataset.id),
    'add-sub': () => openSubForm(null),
    'edit-sub': (el) => openSubForm(el.dataset.id),
    'sub-delete': deleteSub,
    'edit-exp': (el) => openEntry(el.dataset.id),
    'edit-inc': (el) => openEntry(el.dataset.id),
    'exp-delete': deleteEntry,
    'add-event': (el) => openEvent(null, el.dataset.date, el.dataset.date),
    'edit-event': (el) => openEvent(el.dataset.id, null, app.sheet && app.sheet.kind === 'day' ? app.sheet.date : ''),
    'event-delete': deleteEvent,
    balance: openBalance,
    'balance-clear': clearBalance,
    backup: doBackup,
    restore: () => $('#restoreFile').click(),
    wipe: wipeAll,
    help: (el) => {
      const h = HELP[el.dataset.topic];
      if (h) openSheet(h[0], h[1], { kind: 'help' });
    },
    'sync-connect': (el) => {
      if (DEMO) return toast('샘플 모드에서는 연결하지 않아요.');
      connect(el);
    },
    'sync-disconnect': disconnect,
    'sync-now': () => syncNow(),
    'conflict-remote': () => {
      const r = app.conflictRemote;
      app.conflictRemote = null;
      closeSheet();
      if (r) serial(async () => applyRemote(r));
      toast('GitHub 내용으로 바꿨어요.');
    },
    'conflict-local': () => {
      const r = app.conflictRemote;
      app.conflictRemote = null;
      closeSheet();
      if (!r || !app.sync) return;
      app.sync.sha = r.sha; // 원격 위에 이 PC 내용을 올린다
      app.sync.dirty = true;
      persist();
      serial(pushOnce);
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
    if (t.id === 'restoreFile') {
      const f = t.files && t.files[0];
      t.value = ''; // 같은 파일을 다시 골라도 동작하게
      if (f) handleRestoreFile(f);
    } else if (t.name === 'cycle' && t.form) {
      t.form.classList.toggle('is-yearly', t.value === 'yearly');
    } else if (t.name === 'kind' && t.form && t.form.id === 'quickAdd') {
      t.form.elements.title.placeholder = t.value === 'in' ? '내용 (예: 용돈)' : '내용 (예: 점심)';
    }
  });

  document.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = e.target.id;
    if (id === 'planAdd') return addPlan(e.target); // 저장하지 않으니 보기 기기에서도 된다
    if (readOnly()) return;
    if (id === 'subForm') saveSubForm(e.target);
    else if (id === 'expForm') saveEntry(e.target);
    else if (id === 'quickAdd') quickAdd(e.target);
    else if (id === 'balForm') saveBalance(e.target);
    else if (id === 'eventForm') saveEvent(e.target);
  });

  const viewFromHash = () => {
    const v = location.hash.slice(1);
    return VIEWS.includes(v) ? v : 'home';
  };

  window.addEventListener('hashchange', () => {
    app.view = viewFromHash();
    app.chartActive = -1;
    if (app.sheet && app.sheet.kind !== 'conflict') closeSheet();
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

  // 화면을 떠날 때는 안 올린 변경을 바로 올리고, 돌아오면 날짜(D-day)와 원격 내용을 다시 확인한다
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (isWriter() && app.sync.dirty) {
        clearTimeout(pushTimer);
        serial(pushOnce);
      }
      return;
    }
    const t = C.todayStr();
    if (t !== app.today) {
      app.today = t;
      render();
    }
    if (app.sync) syncNow();
  });
  window.addEventListener('online', () => {
    if (app.sync) syncNow();
  });

  function showBanner() {
    const el = $('#banner');
    if (DEMO) {
      el.innerHTML = '<p>샘플 데이터예요. 바꾼 내용은 저장되지 않아요.</p>';
      el.hidden = false;
      return;
    }
    // 아이폰 Safari 탭으로 열었을 때만: 홈 화면 앱과 저장 공간이 따로라서 아이콘으로 열라고 알린다
    const standalone = navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
    let closed = false;
    try {
      closed = sessionStorage.getItem('subcal-banner') === '1';
    } catch (e) {
      closed = false;
    }
    if (!IS_IOS || standalone || closed) return;
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
        const raw = await DB.get('state');
        app.state = C.normalizeState(raw);
        const sync = await DB.get('sync');
        app.sync = sync && sync.repo && sync.token ? sync : null;
        if (raw && raw.version !== C.STATE_VERSION) {
          // 옛 형식을 옮긴 내용을 저장해 둔다. 옛 앱(배포 전에 열어 둔 창 포함)이 받으면서 모르는 칸(수입·잔액)을
          // 버렸을 수 있으니, 원격이 그대로여도 한 번 다시 받는다(sha를 지우면 다음 동기화에서 받아온다).
          // 입력 기기에 안 올린 변경이 있으면 그대로 둔다(지우면 괜히 충돌로 묻게 된다)
          if (app.sync && (app.sync.role === 'reader' || !app.sync.dirty)) app.sync.sha = null;
          persist();
        }
      } catch (e) {
        app.canSave = false;
        setTimeout(() => toast('이 브라우저에서는 데이터를 저장할 수 없어요.'), 300);
      }
    }
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
    if (app.sync) syncNow();
  }

  start().catch((e) => {
    document.body.dataset.error = String((e && e.message) || e);
    console.error(e);
  });
})();
