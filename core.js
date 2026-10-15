/* 구독달력 핵심 로직 — DOM을 쓰지 않는다(Node 테스트에서 그대로 불러온다).
 * 브라우저: 전역 Core / Node: require('./core.js')
 * 날짜는 모두 'YYYY-MM-DD' 문자열로 다루고, 날짜 계산은 UTC 일수로 해서 시간대 영향을 받지 않게 한다.
 * 한 달 총 지출 = 등록한 구독의 결제일 기준 구독료 + 직접 입력한 지출
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

  // 그 달 구독 결제 중 결제일이 지난 것(오늘 전)과 남은 것(오늘 포함)
  function monthProgress(subs, y, m, today) {
    const list = chargesInMonth(subs, y, m);
    const part = (arr) => ({ count: arr.length, amount: arr.reduce((s, c) => s + (Number(c.sub.amount) || 0), 0) });
    return { count: list.length, past: part(list.filter((c) => c.date < today)), remain: part(list.filter((c) => c.date >= today)) };
  }

  // today부터 days일 뒤까지의 결제 예정(오늘 포함). dday = 남은 일수
  function upcoming(subs, today, days) {
    const end = addDays(today, days);
    const t = parseYmd(today);
    const e = parseYmd(end);
    const out = [];
    for (let cur = { y: t.y, m: t.m }; cur.y * 12 + cur.m <= e.y * 12 + e.m; cur = addMonths(cur.y, cur.m, 1)) {
      for (const c of chargesInMonth(subs, cur.y, cur.m)) {
        if (c.date >= today && c.date <= end) out.push({ sub: c.sub, date: c.date, dday: diffDays(today, c.date) });
      }
    }
    return out.sort(byDateThenName);
  }

  // 오늘 이후 첫 결제일(13개월 안에 없으면 null — 끝난 구독)
  function nextChargeDate(sub, today) {
    const t = parseYmd(today);
    for (let i = 0; i <= 13; i++) {
      const { y, m } = addMonths(t.y, t.m, i);
      const date = chargeDate(sub, y, m);
      if (date && date >= today) return date;
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

  // ---------- 직접 입력한 지출 ----------
  // expense: { id, date, amount, title, memo }
  function expensesInMonth(expenses, y, m) {
    const prefix = monthKey(y, m);
    return expenses.filter((e) => e.date.startsWith(prefix)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  // 그 달 합계: subs = 구독료(결제일 기준, 그 달 전체), other = 직접 입력한 지출, total = 둘의 합
  function monthTotals(subs, expenses, y, m) {
    const list = expensesInMonth(expenses, y, m);
    const s = subscriptionTotal(subs, y, m);
    const other = list.reduce((a, e) => a + (Number(e.amount) || 0), 0);
    return { subs: s, other, total: s + other, count: list.length };
  }

  // ---------- 저장 상태 / 백업 ----------
  function emptyState() {
    return { version: 2, subs: [], expenses: [], settings: { lastBackupAt: null }, updatedAt: null };
  }

  const isEmptyState = (s) => !s || (!(s.subs && s.subs.length) && !(s.expenses && s.expenses.length));

  function cleanSub(x) {
    const { matchKey, ...rest } = x || {}; // v1의 통장 표시 이름은 더 쓰지 않는다
    return rest;
  }

  function cleanExpense(e) {
    if (!e || !isYmd(e.date) || !(Number(e.amount) > 0)) return null;
    return { id: String(e.id), date: e.date, amount: Math.round(Number(e.amount)), title: String(e.title || ''), memo: String(e.memo || '') };
  }

  // 저장본·백업·GitHub에서 받은 내용을 읽을 때 빠진 칸을 채우고 옛 형식(v1)을 옮긴다.
  // v1: 직접 입력한 거래만 지출로 옮기고, 불러온 통장 거래는 버린다(구독료가 두 번 계산되므로). 제외 규칙도 버린다.
  function normalizeState(s) {
    const base = emptyState();
    if (!s || typeof s !== 'object') return base;
    let expenses = [];
    if (Array.isArray(s.expenses)) expenses = s.expenses.map(cleanExpense).filter(Boolean);
    else if (Array.isArray(s.txs)) {
      expenses = s.txs
        .filter((t) => t && t.source === 'manual')
        .map((t) => cleanExpense({ id: t.id, date: t.date, amount: t.out, title: t.desc, memo: t.memo }))
        .filter(Boolean);
    }
    const st = s.settings && typeof s.settings === 'object' ? s.settings : {};
    return {
      version: 2,
      subs: Array.isArray(s.subs) ? s.subs.filter((x) => x && typeof x === 'object').map(cleanSub) : [],
      expenses,
      settings: { lastBackupAt: typeof st.lastBackupAt === 'string' ? st.lastBackupAt : null },
      updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : null,
    };
  }

  function makeBackup(state, now) {
    return { app: 'subcal', version: 2, exportedAt: (now || new Date()).toISOString(), state };
  }

  function readBackup(obj) {
    if (!obj || obj.app !== 'subcal' || !obj.state) throw new Error('구독달력 백업 파일이 아니에요.');
    return normalizeState(obj.state);
  }

  return {
    // 날짜
    ymd, parseYmd, monthKey, isYmd, daysInMonth, addDays, diffDays, addMonths, weekday, todayStr, calendarWeeks,
    // 구독
    chargeDate, chargesInMonth, subscriptionTotal, monthProgress, upcoming, nextChargeDate, monthlyEquivalent,
    // 지출
    expensesInMonth, monthTotals,
    // 저장
    emptyState, isEmptyState, normalizeState, makeBackup, readBackup,
  };
});
