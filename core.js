/* 구독달력 핵심 로직 — DOM을 쓰지 않는다(Node 테스트에서 그대로 불러온다).
 * 브라우저: 전역 Core / Node: require('./core.js')
 * 날짜는 모두 'YYYY-MM-DD' 문자열로 다루고, 날짜 계산은 UTC 일수로 해서 시간대 영향을 받지 않게 한다.
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
  function hms(secs) {
    const s = Math.max(0, Math.min(86399, Math.round(secs)));
    return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
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
  // sub: { id, name, amount, cycle: 'monthly' | 'yearly', day: 1~31, month: 1~12(매년만),
  //        color, startDate, endDate, memo, matchKey(통장에 찍히는 이름) }
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

  // ---------- 거래 ----------
  // tx: { id, date, time, desc(내용), memo(적요), out(출금), in(입금), balance, source: 'import' | 'manual',
  //       excluded?: true | false (직접 바꾼 경우만 있음 — 없으면 제외 규칙을 따른다) }
  const normKey = (s) => String(s == null ? '' : s).replace(/\s+/g, '').toUpperCase();
  const haystack = (tx) => normKey(tx.desc) + '|' + normKey(tx.memo);

  function ruleHit(tx, rules) {
    if (!rules || !rules.length) return null;
    const hay = haystack(tx);
    for (const r of rules) {
      const k = normKey(r.keyword);
      if (k && hay.includes(k)) return r;
    }
    return null;
  }

  function isExcluded(tx, rules) {
    if (typeof tx.excluded === 'boolean') return tx.excluded;
    return !!ruleHit(tx, rules);
  }

  const sortTx = (a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : (a.time || '') < (b.time || '') ? -1 : (a.time || '') > (b.time || '') ? 1 : 0;

  function baseKey(tx) {
    return [tx.date, tx.time || '', tx.out || 0, tx.in || 0, tx.balance == null ? '' : tx.balance, tx.desc || '', tx.memo || ''].join('|');
  }

  // 같은 파일 안에 똑같은 거래(같은 날 같은 금액 두 번 결제 등)가 있으면 #2, #3 순번을 붙여 둘 다 남긴다
  function assignIds(txs) {
    const seen = new Map();
    return txs.map((tx) => {
      const b = baseKey(tx);
      const n = (seen.get(b) || 0) + 1;
      seen.set(b, n);
      return { ...tx, id: n === 1 ? b : `${b}#${n}` };
    });
  }

  // 기간이 겹치게 다시 불러와도 같은 거래는 한 번만 들어간다. 기존 거래(제외 설정 포함)는 그대로 둔다
  function mergeTransactions(existing, incoming) {
    const have = new Set(existing.map((t) => t.id));
    const added = [];
    let duplicates = 0;
    for (const tx of assignIds(incoming)) {
      if (have.has(tx.id)) duplicates++;
      else {
        have.add(tx.id);
        added.push({ ...tx, source: 'import' });
      }
    }
    return { merged: existing.concat(added).sort(sortTx), added: added.length, duplicates };
  }

  function lastImportedDate(txs) {
    let last = null;
    for (const t of txs) if (t.source === 'import' && (!last || t.date > last)) last = t.date;
    return last;
  }

  // 그 달에 불러온 내역의 기간(홈 화면 "10/1~10/12 내역 기준")
  function monthCoverage(txs, y, m) {
    const prefix = monthKey(y, m);
    let from = null;
    let to = null;
    for (const t of txs) {
      if (t.source !== 'import' || !t.date.startsWith(prefix)) continue;
      if (!from || t.date < from) from = t.date;
      if (!to || t.date > to) to = t.date;
    }
    return from ? { from, to } : null;
  }

  // "통장 내역에서 고르기" 목록: 최근 출금(최신순)
  function recentWithdrawals(txs, today, days) {
    const since = addDays(today, -days);
    return txs
      .filter((t) => t.out > 0 && t.date >= since && t.date <= today)
      .sort((a, b) => sortTx(b, a));
  }

  // 거래 내용으로 통장 표시 이름 제안: 끝에 붙은 번호·공백·기호는 매달 바뀔 수 있어서 떼어 낸다
  function suggestMatchKey(tx) {
    const s = String(tx.desc || tx.memo || '').trim();
    return s.replace(/[\s\d*#\-_.:/]+$/, '') || s;
  }

  // 불러온 내역에서 네이버페이 결제가 통장에 찍히는 이름을 찾는다(가장 많이 나온 것)
  function guessPayKey(txs) {
    const counts = new Map();
    for (const t of txs) {
      if (!(t.out > 0)) continue;
      for (const field of [t.desc, t.memo]) {
        if (/네이버|NAVER/i.test(field || '')) {
          const key = suggestMatchKey({ desc: field });
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
    }
    let best = '';
    let bestN = 0;
    for (const [k, n] of counts) if (n > bestN) [best, bestN] = [k, n];
    return best;
  }

  // ---------- 결제 확인(구독 ↔ 통장 출금) ----------
  const chargeKey = (subId, date) => `${subId}@${date}`;
  const MATCH_DAYS = 3; // 결제일 앞뒤 3일
  const MATCH_RATE = 0.1; // 금액 ±10%

  // 모든 달의 결제일을 통장 출금과 맞춘다. 거래 하나는 구독 결제 하나에만 붙는다.
  // 날짜가 가장 가까운 짝부터, 같으면 금액이 가장 가까운 짝부터 정한다.
  // (네이버페이 구독 여러 개가 같은 통장 이름을 써도 금액·날짜로 구분된다)
  function matchAll(subs, txs, rules) {
    const result = { byCharge: new Map(), matchedTxIds: new Set(), firstPaid: new Map() };
    const outs = txs.filter((t) => t.out > 0 && !isExcluded(t, rules));
    if (!outs.length || !subs.length) return result;

    const byDate = new Map();
    let first = outs[0].date;
    let last = outs[0].date;
    for (const t of outs) {
      if (!byDate.has(t.date)) byDate.set(t.date, []);
      byDate.get(t.date).push(t);
      if (t.date < first) first = t.date;
      if (t.date > last) last = t.date;
    }

    const pairs = [];
    const f = parseYmd(first);
    const l = parseYmd(last);
    const start = addMonths(f.y, f.m, -1);
    const end = addMonths(l.y, l.m, 1);
    for (let cur = start; cur.y * 12 + cur.m <= end.y * 12 + end.m; cur = addMonths(cur.y, cur.m, 1)) {
      for (const c of chargesInMonth(subs, cur.y, cur.m)) {
        const key = normKey(c.sub.matchKey);
        if (!key) continue;
        const amount = Number(c.sub.amount) || 0;
        for (let d = -MATCH_DAYS; d <= MATCH_DAYS; d++) {
          for (const t of byDate.get(addDays(c.date, d)) || []) {
            if (!haystack(t).includes(key)) continue;
            const da = Math.abs(t.out - amount);
            if (da > amount * MATCH_RATE) continue;
            pairs.push({ ck: chargeKey(c.sub.id, c.date), subId: c.sub.id, date: c.date, tx: t, dd: Math.abs(d), da });
          }
        }
      }
    }

    pairs.sort((a, b) => a.dd - b.dd || a.da - b.da || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || (a.tx.id < b.tx.id ? -1 : a.tx.id > b.tx.id ? 1 : 0));
    for (const p of pairs) {
      if (result.byCharge.has(p.ck) || result.matchedTxIds.has(p.tx.id)) continue;
      result.byCharge.set(p.ck, p.tx);
      result.matchedTxIds.add(p.tx.id);
      const fp = result.firstPaid.get(p.subId);
      if (!fp || p.date < fp) result.firstPaid.set(p.subId, p.date);
    }
    return result;
  }

  // 그 달 결제 목록과 상태
  //  paid    ✓ 통장에서 확인됨
  //  missing ! 이전 달에 확인된 적이 있고, 불러온 내역이 결제일+3일을 넘었는데도 결제가 없음
  //  scheduled 그 밖의 모든 경우(아직 네이버페이로 옮기지 않은 구독도 여기에 해당 — 잘못된 경고를 막는다)
  function chargeStatuses(subs, txs, rules, y, m, match) {
    const mt = match || matchAll(subs, txs, rules);
    const last = lastImportedDate(txs);
    return chargesInMonth(subs, y, m).map((c) => {
      const tx = mt.byCharge.get(chargeKey(c.sub.id, c.date)) || null;
      let status = 'scheduled';
      if (tx) status = 'paid';
      else {
        const fp = mt.firstPaid.get(c.sub.id);
        if (fp && fp < c.date && last && last >= addDays(c.date, MATCH_DAYS)) status = 'missing';
      }
      return { sub: c.sub, date: c.date, status, tx };
    });
  }

  // 그 달 지출: total = 출금 합계(제외 뺌), subs = 구독과 맞춰진 거래 합계, other = total - subs
  // 예정 금액은 쓰지 않으므로 other는 음수가 될 수 없다
  function monthSpending(txs, y, m, rules, matchedTxIds) {
    const prefix = monthKey(y, m);
    let total = 0;
    let subs = 0;
    let count = 0;
    let excluded = 0;
    for (const t of txs) {
      if (!t.date.startsWith(prefix) || !(t.out > 0)) continue;
      if (isExcluded(t, rules)) {
        excluded++;
        continue;
      }
      total += t.out;
      count++;
      if (matchedTxIds && matchedTxIds.has(t.id)) subs += t.out;
    }
    return { total, subs, other: total - subs, count, excluded };
  }

  // ---------- 파일 → 행 ----------
  function sniff(bytes) {
    if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return 'zip'; // xlsx
    if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return 'ole'; // xls
    return 'text';
  }

  // 텍스트 인코딩: UTF-16 BOM → UTF-8 → 안 되면 EUC-KR(국내 은행 파일에 흔함)
  function decodeText(bytes) {
    let text;
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le').decode(bytes);
    else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be').decode(bytes);
    else {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch (e) {
        text = new TextDecoder('euc-kr').decode(bytes);
      }
    }
    return text.replace(/^﻿/, '');
  }

  function htmlText(s) {
    return s
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 은행이 .xls라는 이름으로 HTML 표를 주는 경우가 있다
  function htmlTableRows(html) {
    const rows = [];
    const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let tr;
    while ((tr = trRe.exec(html))) {
      const cells = [];
      const tdRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let td;
      while ((td = tdRe.exec(tr[1]))) cells.push(htmlText(td[1]));
      rows.push(cells);
    }
    return rows;
  }

  // 따옴표로 감싼 칸 안의 쉼표(예: "13,500")는 나누지 않는다
  function parseCsvLine(line) {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else q = false;
        } else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') {
        out.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  }

  function splitDelimited(text) {
    const lines = text.split(/\r\n|\n|\r/);
    const sample = lines.slice(0, 50).join('\n');
    if (sample.includes('\t')) return lines.map((l) => l.split('\t').map((c) => c.trim()));
    if (sample.includes(',')) return lines.map(parseCsvLine);
    return lines.map((l) => l.trim().split(/\s{2,}/));
  }

  function workbookRows(XLSX, wb) {
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '', blankrows: false });
      if (rows.length) return rows;
    }
    return [];
  }

  // 엑셀 읽기 도구(SheetJS)가 필요한 파일인지 — 브라우저는 필요할 때만 불러온다
  function needsSheetJS(bytes) {
    const kind = sniff(bytes);
    if (kind !== 'text') return true;
    const head = decodeText(bytes.subarray ? bytes.subarray(0, 512) : bytes.slice(0, 512));
    return /^\s*<\?xml/i.test(head) && !/<table/i.test(decodeText(bytes));
  }

  // 파일 바이트 → 셀 배열의 배열
  function fileToRows(bytes, XLSX) {
    const kind = sniff(bytes);
    if (kind === 'zip' || kind === 'ole') {
      if (!XLSX) throw new Error('엑셀 파일을 읽는 도구를 불러오지 못했어요');
      return workbookRows(XLSX, XLSX.read(bytes, { type: 'array', cellDates: false }));
    }
    const text = decodeText(bytes);
    if (/<table/i.test(text)) return htmlTableRows(text);
    if (/^\s*<\?xml/i.test(text)) {
      if (!XLSX) throw new Error('엑셀 파일을 읽는 도구를 불러오지 못했어요');
      return workbookRows(XLSX, XLSX.read(text, { type: 'string', cellDates: false }));
    }
    return splitDelimited(text);
  }

  // ---------- 행 → 거래 ----------
  const cellStr = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());

  function parseAmount(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    const s = String(v == null ? '' : v).replace(/[,\s원₩]/g, '');
    if (!s || s === '-') return NaN;
    const n = Number(s);
    return isFinite(n) ? n : NaN;
  }

  function parseTime(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number') return v >= 0 && v < 1 ? hms(v * 86400) : '';
    if (v instanceof Date) return `${pad2(v.getHours())}:${pad2(v.getMinutes())}:${pad2(v.getSeconds())}`;
    const m = String(v).trim().match(/^(\d{1,2}):?(\d{2}):?(\d{2})?$/);
    return m ? `${pad2(m[1])}:${m[2]}:${m[3] || '00'}` : '';
  }

  // 날짜(+시간) 칸 → { date, time } 또는 null
  function parseDateTime(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') {
      if (v >= 19000101 && v <= 21001231) {
        const s = String(Math.floor(v));
        return validDate(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8), '');
      }
      if (v > 20000 && v < 80000) {
        // 엑셀 날짜 일련번호(1900-01-01 = 1, 1899-12-30 기준)
        const days = Math.floor(v);
        const date = fromDayNum(days - 25569);
        const secs = Math.round((v - days) * 86400);
        return { date, time: secs ? hms(secs) : '' };
      }
      return null;
    }
    if (v instanceof Date) {
      if (isNaN(v)) return null;
      const time = `${pad2(v.getHours())}:${pad2(v.getMinutes())}:${pad2(v.getSeconds())}`;
      return { date: ymd(v.getFullYear(), v.getMonth() + 1, v.getDate()), time: time === '00:00:00' ? '' : time };
    }
    const s = String(v).trim();
    let m = s.match(/^(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})(?:\s*일)?\.?(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) m = s.match(/^(\d{4})(\d{2})(\d{2})(?:\s*(\d{2}):?(\d{2}):?(\d{2})?)?$/);
    if (!m) return null;
    const time = m[4] != null ? `${pad2(m[4])}:${m[5]}:${m[6] != null ? pad2(m[6]) : '00'}` : '';
    return validDate(+m[1], +m[2], +m[3], time);
  }
  function validDate(y, mo, d, time) {
    if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
    return { date: ymd(y, mo, d), time };
  }

  // 머리글 칸 이름 → 열 종류. 위에 있는 규칙이 먼저 (예: '입출금구분'은 출금이 아니라 구분 열)
  const HEADER_RULES = [
    ['balance', /잔액/],
    ['memo', /적요|구분/],
    ['time', /시간|시각/],
    ['date', /거래일|일자|일시|날짜/],
    ['out', /출금|찾으신|지급/],
    ['in', /입금|맡기신/],
    ['amount', /금액/],
    ['desc', /내용|기재|받는|보낸|상대|가맹/],
  ];

  function classifyHeader(row) {
    const cols = {};
    row.forEach((cell, i) => {
      const name = cellStr(cell).replace(/\s+/g, '');
      if (!name || name.length > 20) return;
      for (const [kind, re] of HEADER_RULES) {
        if (re.test(name)) {
          if (cols[kind] == null) cols[kind] = i;
          return;
        }
      }
    });
    return cols;
  }

  // 은행 파일의 행 배열 → 거래 목록. 위쪽 계좌정보 행은 건너뛰고 머리글 행을 키워드로 찾는다
  function parseRows(rows) {
    let headerRow = -1;
    let cols = null;
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const c = classifyHeader(rows[i] || []);
      if (c.date != null && (c.out != null || c.in != null || c.amount != null)) {
        headerRow = i;
        cols = c;
        break;
      }
    }
    if (headerRow < 0) {
      return {
        ok: false,
        reason: '거래내역 머리글(거래일자, 출금, 입금 같은 칸 이름)을 찾지 못했어요.',
        preview: rows.slice(0, 6).map((r) => (r || []).map((c) => cellStr(c).slice(0, 12)).join(' | ')),
      };
    }

    const txs = [];
    let skipped = 0;
    const amt = (v) => {
      const n = parseAmount(v);
      return isNaN(n) ? 0 : Math.abs(n);
    };
    for (let i = headerRow + 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const dt = parseDateTime(row[cols.date]);
      if (!dt) {
        if (row.some((c) => cellStr(c))) skipped++;
        continue;
      }
      let out = cols.out != null ? amt(row[cols.out]) : 0;
      let inn = cols.in != null ? amt(row[cols.in]) : 0;
      const memo = cols.memo != null ? cellStr(row[cols.memo]) : '';
      if (cols.out == null && cols.in == null && cols.amount != null) {
        // '금액' 한 칸만 있는 형식: 음수거나 구분이 출금이면 출금
        const n = parseAmount(row[cols.amount]);
        if (!isNaN(n)) {
          if (n < 0 || /출금|지급|찾/.test(memo)) out = Math.abs(n);
          else inn = n;
        }
      }
      if (!out && !inn) {
        skipped++;
        continue;
      }
      const bal = cols.balance != null ? parseAmount(row[cols.balance]) : NaN;
      txs.push({
        date: dt.date,
        time: cols.time != null ? parseTime(row[cols.time]) || dt.time : dt.time,
        desc: cols.desc != null ? cellStr(row[cols.desc]) : memo,
        memo: cols.desc != null ? memo : '',
        out,
        in: inn,
        balance: isNaN(bal) ? null : bal,
      });
    }
    const header = {};
    for (const k of Object.keys(cols)) header[k] = cellStr(rows[headerRow][cols[k]]);
    return { ok: true, txs, headerRow, header, skipped };
  }

  // ---------- 저장 상태 / 백업 ----------
  function emptyState() {
    return { version: 1, subs: [], txs: [], rules: [], settings: { payKey: '', lastBackupAt: null } };
  }

  // 저장본·백업을 읽을 때 빠진 칸을 채운다
  function normalizeState(s) {
    const base = emptyState();
    if (!s || typeof s !== 'object') return base;
    return {
      version: 1,
      subs: Array.isArray(s.subs) ? s.subs : [],
      txs: Array.isArray(s.txs) ? s.txs : [],
      rules: Array.isArray(s.rules) ? s.rules : [],
      settings: { ...base.settings, ...(s.settings && typeof s.settings === 'object' ? s.settings : {}) },
    };
  }

  function makeBackup(state, now) {
    return { app: 'subcal', version: 1, exportedAt: (now || new Date()).toISOString(), state };
  }

  function readBackup(obj) {
    if (!obj || obj.app !== 'subcal' || !obj.state) throw new Error('구독달력 백업 파일이 아니에요.');
    return normalizeState(obj.state);
  }

  return {
    // 날짜
    ymd, parseYmd, monthKey, daysInMonth, addDays, diffDays, addMonths, weekday, todayStr, calendarWeeks,
    // 구독
    chargeDate, chargesInMonth, subscriptionTotal, upcoming, nextChargeDate, monthlyEquivalent,
    // 거래
    normKey, ruleHit, isExcluded, assignIds, mergeTransactions, lastImportedDate, monthCoverage,
    recentWithdrawals, suggestMatchKey, guessPayKey, sortTx,
    // 결제 확인 / 지출
    matchAll, chargeStatuses, chargeKey, monthSpending,
    // 파일
    sniff, decodeText, htmlTableRows, splitDelimited, parseCsvLine, needsSheetJS, fileToRows,
    parseAmount, parseTime, parseDateTime, parseRows,
    // 저장
    emptyState, normalizeState, makeBackup, readBackup,
  };
});
