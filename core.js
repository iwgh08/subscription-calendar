/* 구독달력 핵심 로직 — DOM을 쓰지 않는다(Node 테스트에서 그대로 불러온다).
 * 브라우저: 전역 Core / Node: require('./core.js')
 * 날짜는 모두 'YYYY-MM-DD' 문자열로 다루고, 날짜 계산은 UTC 일수로 해서 시간대 영향을 받지 않게 한다.
 * 한 달 총 지출 = 등록한 구독의 결제일 기준 구독료 + 직접 입력한 지출(수입은 넣지 않는다)
 * 지금 통장 잔액 = 사용자가 맞춘 잔액 + 그 뒤의 수입 − 지출 − 구독 결제
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 날짜 ----------
  const pad2 = (n) => String(n).padStart(2, '0');
  const ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
  const monthKey = (y, m) => `${y}-${pad2(m)}`;
  const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

  function parseYmd(s) {
    const [y, m, d] = s.split('-').map(Number);
    return { y, m, d };
  }
  function daysInMonth(y, m) {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }
  function dayNum(s) {
    const { y, m, d } = parseYmd(s);
    return Date.UTC(y, m - 1, d) / 86400000;
  }
  function fromDayNum(n) {
    const dt = new Date(n * 86400000);
    return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  const addDays = (s, n) => fromDayNum(dayNum(s) + n);
  const diffDays = (a, b) => dayNum(b) - dayNum(a); // b - a (일)
  function addMonths(y, m, n) {
    const i = y * 12 + (m - 1) + n;
    return { y: Math.floor(i / 12), m: (((i % 12) + 12) % 12) + 1 };
  }
  function weekday(s) {
    const { y, m, d } = parseYmd(s);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = 일요일
  }
  function todayStr(now) {
    const t = now || new Date();
    return ymd(t.getFullYear(), t.getMonth() + 1, t.getDate());
  }

  // 달력 한 달: 일요일부터 시작하는 주 배열. 칸은 날짜 문자열 또는 null(앞뒤 빈칸)
  function calendarWeeks(y, m) {
    const cells = [];
    for (let i = weekday(ymd(y, m, 1)); i > 0; i--) cells.push(null);
    for (let d = 1, n = daysInMonth(y, m); d <= n; d++) cells.push(ymd(y, m, d));
    while (cells.length % 7) cells.push(null);
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  }

  // ---------- 구독 ----------
  // sub: { id, name, amount, cycle: 'monthly' | 'yearly', day: 1~31, month: 1~12(매년만), color, startDate, endDate, memo }
  const byDateThenName = (a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.sub.name).localeCompare(String(b.sub.name), 'ko');

  // 그 달의 결제일. 29~31일은 짧은 달에 말일로 옮긴다. 결제가 없는 달이면 null
  function chargeDate(sub, y, m) {
    if (sub.cycle === 'yearly' && Number(sub.month) !== m) return null;
    const day = Math.min(Math.max(1, Number(sub.day) || 1), daysInMonth(y, m));
    const date = ymd(y, m, day);
    if (sub.startDate && date < sub.startDate) return null;
    if (sub.endDate && date > sub.endDate) return null;
    return date;
  }

  function chargesInMonth(subs, y, m) {
    const list = [];
    for (const sub of subs) {
      const date = chargeDate(sub, y, m);
      if (date) list.push({ sub, date });
    }
    return list.sort(byDateThenName);
  }

  function subscriptionTotal(subs, y, m) {
    return chargesInMonth(subs, y, m).reduce((sum, c) => sum + (Number(c.sub.amount) || 0), 0);
  }

  // 그 달 구독 결제 중 결제된 것(오늘까지)과 남은 것(내일부터)
  function monthProgress(subs, y, m, today) {
    const list = chargesInMonth(subs, y, m);
    const part = (arr) => ({ count: arr.length, amount: arr.reduce((s, c) => s + (Number(c.sub.amount) || 0), 0) });
    // 결제일 당일이 되면 바로 결제된 것으로 본다(오늘은 past)
    return { count: list.length, past: part(list.filter((c) => c.date <= today)), remain: part(list.filter((c) => c.date > today)) };
  }

  // 내일부터 today + days일까지의 결제 예정(오늘 결제는 이미 된 것으로 본다). dday = 남은 일수
  function upcoming(subs, today, days) {
    const end = addDays(today, days);
    const t = parseYmd(today);
    const e = parseYmd(end);
    const out = [];
    for (let cur = { y: t.y, m: t.m }; cur.y * 12 + cur.m <= e.y * 12 + e.m; cur = addMonths(cur.y, cur.m, 1)) {
      for (const c of chargesInMonth(subs, cur.y, cur.m)) {
        if (c.date > today && c.date <= end) out.push({ sub: c.sub, date: c.date, dday: diffDays(today, c.date) });
      }
    }
    return out.sort(byDateThenName);
  }

  // 오늘 다음의 첫 결제일(오늘 결제는 이미 됐다. 13개월 안에 없으면 null — 끝난 구독)
  function nextChargeDate(sub, today) {
    const t = parseYmd(today);
    for (let i = 0; i <= 13; i++) {
      const { y, m } = addMonths(t.y, t.m, i);
      const date = chargeDate(sub, y, m);
      if (date && date > today) return date;
    }
    return null;
  }

  // 월 환산 합계: 매월은 그대로, 매년은 12로 나눈다. 이미 끝난 구독은 뺀다
  function monthlyEquivalent(subs, today) {
    let sum = 0;
    for (const s of subs) {
      if (s.endDate && s.endDate < today) continue;
      const a = Number(s.amount) || 0;
      sum += s.cycle === 'yearly' ? a / 12 : a;
    }
    return Math.round(sum);
  }

  // ---------- 직접 입력한 지출·수입 ----------
  // entry(지출·수입 같은 모양): { id, date, amount, title, memo, createdAt? } — createdAt은 적은 시각(ISO). 잔액 계산에 쓴다
  function entriesInMonth(list, y, m) {
    const prefix = monthKey(y, m);
    return list.filter((e) => e.date.startsWith(prefix)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  const expensesInMonth = entriesInMonth;

  // 일정: 그 달의 것을 날짜 → 시간 순으로(시간 없는 것이 그날 맨 앞). 돈 계산에는 넣지 않는다
  // 매년 일정(repeat: 'yearly')은 처음 날짜의 해부터 해마다 같은 월·일에 나온다. 2월 29일은 평년에 28일로.
  // 돌려주는 항목의 date는 그 달에 나오는 날짜이고, 처음 날짜는 start에 있다(고칠 때는 id로 원래 일정을 찾는다)
  const eventKey = (e) => `${e.date} ${e.time || ''}`;
  function eventsInMonth(events, y, m) {
    const prefix = monthKey(y, m);
    const out = [];
    for (const e of events || []) {
      if (e.repeat === 'yearly') {
        const s = parseYmd(e.date);
        if (s.m !== m || s.y > y) continue;
        out.push({ ...e, date: ymd(y, m, Math.min(s.d, daysInMonth(y, m))), start: e.date });
      } else if (e.date.startsWith(prefix)) out.push(e);
    }
    return out.sort((a, b) => (eventKey(a) < eventKey(b) ? -1 : eventKey(a) > eventKey(b) ? 1 : 0));
  }
  const sumAmount = (list) => list.reduce((a, e) => a + (Number(e.amount) || 0), 0);

  // 그 달 합계: subs = 구독료(결제일 기준, 그 달 전체), other = 직접 입력한 지출, total = 둘의 합
  function monthTotals(subs, expenses, y, m) {
    const list = expensesInMonth(expenses, y, m);
    const s = subscriptionTotal(subs, y, m);
    const other = sumAmount(list);
    return { subs: s, other, total: s + other, count: list.length };
  }

  // 그 달 수입 합계(총 지출과는 따로 센다)
  function monthIncome(incomes, y, m) {
    const list = entriesInMonth(incomes, y, m);
    return { amount: sumAmount(list), count: list.length };
  }

  // ---------- 통장 잔액 ----------
  // from~to(둘 다 포함) 사이의 구독 결제
  function chargesBetween(subs, from, to) {
    const out = [];
    if (from > to) return out;
    const f = parseYmd(from);
    const t = parseYmd(to);
    for (let cur = { y: f.y, m: f.m }; cur.y * 12 + cur.m <= t.y * 12 + t.m; cur = addMonths(cur.y, cur.m, 1)) {
      for (const c of chargesInMonth(subs, cur.y, cur.m)) if (c.date >= from && c.date <= to) out.push(c);
    }
    return out;
  }

  // balance: { amount, date, setAt, paidToday } — date(맞춘 날) setAt(맞춘 시각)에 은행 앱에서 본 잔액
  // 지금 잔액 = amount + 그 뒤 수입 − 그 뒤 지출 − 그 뒤 구독 결제(오늘까지). 맞춘 적이 없으면 null
  //  - 맞춘 날보다 앞 날짜의 수입·지출은 이미 잔액에 들어 있다고 본다
  //  - 맞춘 날 날짜의 수입·지출은 맞춘 뒤에 적은 것(createdAt > setAt)만 넣는다. 적은 시각이 없는 옛 항목은 넣지 않는다
  //  - 맞춘 날의 구독 결제는 paidToday(그때 이미 빠짐)면 넣지 않는다
  //  - 앞으로의 날짜는 그날이 되면 넣는다
  function balanceNow(state, today) {
    const b = state && state.balance;
    if (!b) return null;
    const counts = (e) => e.date <= today && (e.date > b.date || (e.date === b.date && !!e.createdAt && e.createdAt > b.setAt));
    const ins = (state.incomes || []).filter(counts);
    const outs = (state.expenses || []).filter(counts);
    const charges = chargesBetween(state.subs || [], b.paidToday ? addDays(b.date, 1) : b.date, today);
    const income = sumAmount(ins);
    const spent = sumAmount(outs);
    const subs = charges.reduce((a, c) => a + (Number(c.sub.amount) || 0), 0);
    return {
      base: b.amount,
      income,
      spent,
      subs,
      total: b.amount + income - spent - subs,
      counts: { income: ins.length, spent: outs.length, subs: charges.length },
    };
  }

  // 앞으로의 날짜(date) 끝에 남는 돈 = 지금 잔액 + 오늘 다음 날~date의 수입 − 같은 기간 지출·구독 결제 − 써 볼 지출(plans, 오늘~date)
  // plans: [{ date, amount, title }] — 계산 탭에서만 쓰고 저장하지 않는다. 잔액을 맞춘 적이 없거나 date가 오늘 전이면 null
  function balanceOn(state, today, date, plans) {
    const now = balanceNow(state, today);
    if (!now || !isYmd(date) || date < today) return null;
    const inRange = (e) => e.date > today && e.date <= date;
    const items = [
      ...chargesBetween(state.subs || [], addDays(today, 1), date).map((c) => ({ date: c.date, kind: 'sub', title: String(c.sub.name || ''), amount: Number(c.sub.amount) || 0 })),
      ...(state.incomes || []).filter(inRange).map((e) => ({ date: e.date, kind: 'in', title: e.title, amount: Number(e.amount) || 0 })),
      ...(state.expenses || []).filter(inRange).map((e) => ({ date: e.date, kind: 'out', title: e.title, amount: Number(e.amount) || 0 })),
      ...(plans || []).filter((p) => p.date >= today && p.date <= date).map((p) => ({ date: p.date, kind: 'plan', title: String(p.title || ''), amount: Number(p.amount) || 0 })),
    ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const total = (kind) => items.filter((x) => x.kind === kind).reduce((a, x) => a + x.amount, 0);
    const income = total('in');
    const spent = total('out');
    const subs = total('sub');
    const planned = total('plan');
    return { now: now.total, income, spent, subs, planned, total: now.total + income - spent - subs - planned, items };
  }

  // 오늘부터 today + days일까지의 일정(오늘 포함, 매년 일정도 펼친다). dday = 남은 일수
  function upcomingEvents(events, today, days) {
    const end = addDays(today, days);
    const t = parseYmd(today);
    const e = parseYmd(end);
    const out = [];
    for (let cur = { y: t.y, m: t.m }; cur.y * 12 + cur.m <= e.y * 12 + e.m; cur = addMonths(cur.y, cur.m, 1)) {
      for (const ev of eventsInMonth(events, cur.y, cur.m)) {
        if (ev.date >= today && ev.date <= end) out.push({ ...ev, dday: diffDays(today, ev.date) });
      }
    }
    return out; // 달 순서대로 모았고 달 안에서는 eventsInMonth가 날짜·시간 순으로 정렬했다
  }

  // 아이폰 위젯(Scriptable)에 보여 줄 요약: 지금 잔액, 이번 달 총 지출, 7일 안의 결제(내일부터)·일정(오늘부터) 최대 4개
  function widgetSummary(state, today) {
    const s = normalizeState(state);
    const t = parseYmd(today);
    const totals = monthTotals(s.subs, s.expenses, t.y, t.m);
    const now = balanceNow(s, today);
    const items = [
      ...upcoming(s.subs, today, 7).map((c) => ({ kind: 'sub', date: c.date, dday: c.dday, time: '', title: String(c.sub.name || ''), amount: Number(c.sub.amount) || 0 })),
      ...upcomingEvents(s.events, today, 7).map((e) => ({ kind: 'event', date: e.date, dday: e.dday, time: e.time, title: e.title })),
    ].sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.time !== b.time ? (a.time < b.time ? -1 : 1) : 0));
    return { balance: now ? now.total : null, month: t.m, monthTotal: totals.total, monthSubs: totals.subs, monthOther: totals.other, items: items.slice(0, 4), more: Math.max(0, items.length - 4) };
  }

  // ---------- 저장 상태 / 백업 ----------
  // 저장 형식 버전. 칸을 새로 만들면 올린다(옛 앱은 모르는 칸을 버리므로, 받은 쪽에서 다시 받게 하는 데 쓴다)
  const STATE_VERSION = 5;

  function emptyState() {
    return { version: STATE_VERSION, subs: [], expenses: [], incomes: [], events: [], balance: null, settings: { lastBackupAt: null }, updatedAt: null };
  }

  const isEmptyState = (s) =>
    !s || (!(s.subs && s.subs.length) && !(s.expenses && s.expenses.length) && !(s.incomes && s.incomes.length) && !(s.events && s.events.length) && !s.balance);

  // 이 앱보다 새 버전이 저장한 내용인지(그대로 읽으면 모르는 칸이 사라진다)
  const isNewerState = (s) => !!s && typeof s === 'object' && Number(s.version) > STATE_VERSION;

  function cleanSub(x) {
    const { matchKey, ...rest } = x || {}; // v1의 통장 표시 이름은 더 쓰지 않는다
    return rest;
  }

  function cleanEntry(e) {
    if (!e || !isYmd(e.date) || !(Number(e.amount) > 0)) return null;
    const out = { id: String(e.id), date: e.date, amount: Math.round(Number(e.amount)), title: String(e.title || ''), memo: String(e.memo || '') };
    if (typeof e.createdAt === 'string' && e.createdAt) out.createdAt = e.createdAt;
    return out;
  }

  // 일정 { id, date, time('HH:MM' 또는 ''), repeat('yearly' 또는 ''), title, memo, createdAt? }. 날짜가 틀리면 버리고, 이름이 비면 '일정'
  function cleanEvent(e) {
    if (!e || typeof e !== 'object' || !isYmd(e.date)) return null;
    const time = typeof e.time === 'string' && /^\d{2}:\d{2}$/.test(e.time) ? e.time : '';
    const out = { id: String(e.id), date: e.date, time, repeat: e.repeat === 'yearly' ? 'yearly' : '', title: String(e.title || '').trim() || '일정', memo: String(e.memo || '') };
    if (typeof e.createdAt === 'string' && e.createdAt) out.createdAt = e.createdAt;
    return out;
  }

  function cleanBalance(b) {
    if (!b || typeof b !== 'object' || !isYmd(b.date) || b.amount === null || b.amount === '') return null;
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount < 0) return null;
    return { amount: Math.round(amount), date: b.date, setAt: typeof b.setAt === 'string' ? b.setAt : '', paidToday: !!b.paidToday };
  }

  // 저장본·백업·GitHub에서 받은 내용을 읽을 때 빠진 칸을 채우고 옛 형식을 옮긴다. 여기 없는 칸은 버려진다.
  // v1: 직접 입력한 거래만 지출·수입으로 옮기고, 불러온 통장 거래는 버린다(구독료가 두 번 계산되므로). 제외 규칙도 버린다.
  // v2 → v3: 수입(incomes)과 잔액(balance) 칸이 생겼다
  // v3 → v4: 일정(events) 칸이 생겼다
  // v4 → v5: 일정에 매년 반복(repeat) 칸이 생겼다(없으면 '')
  function normalizeState(s) {
    const base = emptyState();
    if (!s || typeof s !== 'object') return base;
    let expenses = [];
    let incomes = [];
    if (Array.isArray(s.expenses)) expenses = s.expenses.map(cleanEntry).filter(Boolean);
    else if (Array.isArray(s.txs)) {
      const manual = s.txs.filter((t) => t && t.source === 'manual');
      expenses = manual.map((t) => cleanEntry({ id: t.id, date: t.date, amount: t.out, title: t.desc, memo: t.memo })).filter(Boolean);
      incomes = manual.map((t) => cleanEntry({ id: t.id, date: t.date, amount: t.in, title: t.desc, memo: t.memo })).filter(Boolean);
    }
    if (Array.isArray(s.incomes)) incomes = s.incomes.map(cleanEntry).filter(Boolean);
    const st = s.settings && typeof s.settings === 'object' ? s.settings : {};
    return {
      version: STATE_VERSION,
      subs: Array.isArray(s.subs) ? s.subs.filter((x) => x && typeof x === 'object').map(cleanSub) : [],
      expenses,
      incomes,
      events: Array.isArray(s.events) ? s.events.map(cleanEvent).filter(Boolean) : [],
      balance: cleanBalance(s.balance),
      settings: { lastBackupAt: typeof st.lastBackupAt === 'string' ? st.lastBackupAt : null },
      updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : null,
    };
  }

  // ---------- 두 기기 내용 합치기 ----------
  // 칸 순서가 달라도 같은 값으로 본다
  function canon(v) {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
      return o;
    }
    return v;
  }
  const same = (a, b) => JSON.stringify(canon(a === undefined ? null : a)) === JSON.stringify(canon(b === undefined ? null : b));
  const LISTS = ['subs', 'expenses', 'incomes', 'events'];

  // 데이터 내용이 같은지(수정 시각·백업 시각은 따지지 않는다)
  const sameData = (a, b) => LISTS.every((k) => same(a[k] || [], b[k] || [])) && same(a.balance, b.balance);

  // 한 칸을 기준본(base) 대비로 합친다: 한쪽만 바뀌었으면 바뀐 쪽, 둘 다 바뀌었으면 tie(local, remote)
  function mergeValue(b, l, r, tie) {
    if (same(l, b)) return r;
    if (same(r, b)) return l;
    return tie(l, r);
  }

  // id별로 합친다. 새로 생긴 것은 양쪽 다 넣고, 한쪽에서 지웠는데 다른 쪽이 고쳤으면 고친 것을 남기고,
  // 둘 다 고쳤으면 이 기기(local) 것을 남긴다. 순서는 원격 순서에 이 기기에서 새로 생긴 것을 뒤에 붙인다
  function mergeList(base, local, remote) {
    const byId = (list) => new Map((list || []).map((x) => [String(x.id), x]));
    const B = byId(base);
    const L = byId(local);
    const R = byId(remote);
    const out = [];
    for (const id of new Set([...R.keys(), ...L.keys()])) {
      const b = B.get(id);
      const l = L.get(id);
      const r = R.get(id);
      let x;
      if (!b) x = l || r;
      else if (!l) x = same(r, b) ? null : r;
      else if (!r) x = same(l, b) ? null : l;
      else x = same(l, b) ? r : l;
      if (x) out.push(x);
    }
    return out;
  }

  // 기준본 = 이 기기가 마지막으로 GitHub과 맞췄을 때의 내용. 그 뒤 이 기기(local)와 GitHub(remote)이 따로 바뀐 것을 합친다
  function mergeStates(base, local, remote, nowIso) {
    const B = normalizeState(base);
    const L = normalizeState(local);
    const R = normalizeState(remote);
    const out = { ...L };
    for (const k of LISTS) out[k] = mergeList(B[k], L[k], R[k]);
    // 잔액을 양쪽에서 다시 맞췄으면 나중에 맞춘 것
    out.balance = mergeValue(B.balance, L.balance, R.balance, (l, r) => (!l ? r : !r ? l : (l.setAt || '') >= (r.setAt || '') ? l : r));
    const lb = L.settings.lastBackupAt || '';
    const rb = R.settings.lastBackupAt || '';
    out.settings = { lastBackupAt: (lb >= rb ? lb : rb) || null };
    out.updatedAt = nowIso || new Date().toISOString();
    return out;
  }

  function makeBackup(state, now) {
    return { app: 'subcal', version: STATE_VERSION, exportedAt: (now || new Date()).toISOString(), state };
  }

  function readBackup(obj) {
    if (!obj || obj.app !== 'subcal' || !obj.state) throw new Error('구독달력 백업 파일이 아니에요.');
    if (isNewerState(obj.state)) throw new Error('새 버전 앱에서 만든 백업이에요. 앱을 새 버전으로 바꾼 뒤 불러와 주세요.');
    return normalizeState(obj.state);
  }

  return {
    // 날짜
    ymd, parseYmd, monthKey, isYmd, daysInMonth, addDays, diffDays, addMonths, weekday, todayStr, calendarWeeks,
    // 구독
    chargeDate, chargesInMonth, subscriptionTotal, monthProgress, upcoming, nextChargeDate, monthlyEquivalent,
    // 지출·수입·잔액
    entriesInMonth, expensesInMonth, monthTotals, monthIncome, chargesBetween, balanceNow, balanceOn,
    // 일정
    eventsInMonth, upcomingEvents,
    // 위젯
    widgetSummary,
    // 두 기기 합치기
    sameData, mergeStates,
    // 저장
    STATE_VERSION, emptyState, isEmptyState, isNewerState, normalizeState, makeBackup, readBackup,
  };
});
