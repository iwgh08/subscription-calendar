// 핵심 로직 테스트: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core.js');

const sub = (o) => ({ id: o.id || o.name, name: 'x', amount: 10000, cycle: 'monthly', day: 1, matchKey: '', ...o });
const tx = (o) => ({ time: '', desc: '', memo: '', out: 0, in: 0, balance: null, source: 'import', ...o });
const withIds = (list) => Core.assignIds(list.map(tx));

// ---------- 결제일 ----------
test('31일 결제는 짧은 달의 말일로 옮겨진다(2월·윤년·4월)', () => {
  const s = sub({ day: 31 });
  assert.equal(Core.chargeDate(s, 2026, 2), '2026-02-28');
  assert.equal(Core.chargeDate(s, 2028, 2), '2028-02-29');
  assert.equal(Core.chargeDate(s, 2026, 4), '2026-04-30');
  assert.equal(Core.chargeDate(s, 2026, 10), '2026-10-31');
});

test('매년 구독은 해당 달에만 결제되고, 2월 29일은 평년에 28일로', () => {
  const s = sub({ cycle: 'yearly', month: 3, day: 15 });
  assert.equal(Core.chargeDate(s, 2026, 3), '2026-03-15');
  assert.equal(Core.chargeDate(s, 2026, 4), null);
  const leap = sub({ cycle: 'yearly', month: 2, day: 29 });
  assert.equal(Core.chargeDate(leap, 2027, 2), '2027-02-28');
  assert.equal(Core.chargeDate(leap, 2028, 2), '2028-02-29');
});

test('시작일 전·종료일 뒤에는 결제가 없다', () => {
  const s = sub({ day: 15, startDate: '2026-10-20', endDate: '2027-01-10' });
  assert.equal(Core.chargeDate(s, 2026, 10), null);
  assert.equal(Core.chargeDate(s, 2026, 11), '2026-11-15');
  assert.equal(Core.chargeDate(s, 2026, 12), '2026-12-15');
  assert.equal(Core.chargeDate(s, 2027, 1), null);
});

test('다가오는 결제와 D-day', () => {
  const subs = [
    sub({ name: '넷플릭스', day: 15 }),
    sub({ name: '유튜브', day: 3 }),
    sub({ name: '클라우드', day: 31 }),
    sub({ name: '연간', cycle: 'yearly', month: 1, day: 1 }),
  ];
  const list = Core.upcoming(subs, '2026-10-15', 30);
  assert.deepEqual(
    list.map((c) => [c.sub.name, c.date, c.dday]),
    [
      ['넷플릭스', '2026-10-15', 0],
      ['클라우드', '2026-10-31', 16],
      ['유튜브', '2026-11-03', 19],
    ],
  );
});

test('다음 결제일과 끝난 구독', () => {
  assert.equal(Core.nextChargeDate(sub({ day: 10 }), '2026-10-15'), '2026-11-10');
  assert.equal(Core.nextChargeDate(sub({ day: 15 }), '2026-10-15'), '2026-10-15');
  assert.equal(Core.nextChargeDate(sub({ day: 10, endDate: '2026-10-31' }), '2026-10-15'), null);
});

test('그 달 구독료 합계와 월 환산 합계', () => {
  const subs = [sub({ amount: 10000, day: 5 }), sub({ id: 'y', amount: 120000, cycle: 'yearly', month: 10, day: 20 })];
  assert.equal(Core.subscriptionTotal(subs, 2026, 10), 130000);
  assert.equal(Core.subscriptionTotal(subs, 2026, 11), 10000);
  assert.equal(Core.monthlyEquivalent(subs, '2026-10-15'), 20000);
  assert.equal(Core.monthlyEquivalent([sub({ amount: 5000, endDate: '2026-09-30' })], '2026-10-15'), 0);
});

test('달력은 일요일 시작 7칸 주로 나뉜다', () => {
  const weeks = Core.calendarWeeks(2026, 10);
  assert.ok(weeks.every((w) => w.length === 7));
  const days = weeks.flat().filter(Boolean);
  assert.equal(days.length, 31);
  assert.equal(weeks.flat().indexOf('2026-10-01'), Core.weekday('2026-10-01'));
});

// ---------- 결제 확인 ----------
test('결제일 다음 날, 금액이 5% 다른 거래도 결제 확인(✓)', () => {
  const subs = [sub({ id: 'a', amount: 10000, day: 5, matchKey: '네이버페이' })];
  const txs = withIds([{ date: '2026-10-06', desc: '네이버페이', out: 10500 }]);
  const [c] = Core.chargeStatuses(subs, txs, [], 2026, 10);
  assert.equal(c.status, 'paid');
  assert.equal(c.tx.out, 10500);
});

test('금액이 10%를 넘게 다르거나 날짜가 3일을 넘으면 확인하지 않는다', () => {
  const subs = [sub({ id: 'a', amount: 10000, day: 5, matchKey: '네이버페이' })];
  const far = withIds([{ date: '2026-10-09', desc: '네이버페이', out: 10000 }]);
  assert.equal(Core.chargeStatuses(subs, far, [], 2026, 10)[0].status, 'scheduled');
  const pricey = withIds([{ date: '2026-10-05', desc: '네이버페이', out: 11200 }]);
  assert.equal(Core.chargeStatuses(subs, pricey, [], 2026, 10)[0].status, 'scheduled');
});

test('같은 통장 이름, 금액이 다른 네이버페이 구독 두 개는 각자 자기 거래에 붙는다', () => {
  const subs = [
    sub({ id: 'melon', name: '멜론', amount: 10900, day: 5, matchKey: '네이버페이' }),
    sub({ id: 'yt', name: '유튜브', amount: 14900, day: 5, matchKey: '네이버페이' }),
  ];
  const txs = withIds([
    { date: '2026-10-05', time: '09:00:00', desc: '네이버페이', out: 14900 },
    { date: '2026-10-05', time: '09:01:00', desc: '네이버페이', out: 10900 },
    { date: '2026-10-05', time: '12:00:00', desc: '네이버페이', out: 32000 },
  ]);
  const st = Core.chargeStatuses(subs, txs, [], 2026, 10);
  const byId = Object.fromEntries(st.map((c) => [c.sub.id, c.tx && c.tx.out]));
  assert.deepEqual(byId, { melon: 10900, yt: 14900 });
});

test('같은 날 금액이 다른 네이버페이 쇼핑 결제는 구독에 붙지 않는다', () => {
  const subs = [sub({ id: 'a', amount: 10900, day: 5, matchKey: '네이버페이' })];
  const txs = withIds([{ date: '2026-10-05', desc: '네이버페이', out: 25000 }]);
  const m = Core.matchAll(subs, txs, []);
  assert.equal(m.matchedTxIds.size, 0);
  assert.equal(Core.chargeStatuses(subs, txs, [], 2026, 10, m)[0].status, 'scheduled');
});

test('거래 하나는 구독 하나에만 붙는다', () => {
  const subs = [
    sub({ id: 'a', name: '가', amount: 10900, day: 5, matchKey: '네이버페이' }),
    sub({ id: 'b', name: '나', amount: 10900, day: 5, matchKey: '네이버페이' }),
  ];
  const txs = withIds([{ date: '2026-10-05', desc: '네이버페이', out: 10900 }]);
  const st = Core.chargeStatuses(subs, txs, [], 2026, 10);
  assert.deepEqual(st.map((c) => c.status).sort(), ['paid', 'scheduled']);
});

test('통장 표시 이름이 없는 구독, 제외한 거래는 맞추지 않는다', () => {
  const noKey = [sub({ id: 'a', amount: 10900, day: 5 })];
  const txs = withIds([{ date: '2026-10-05', desc: '네이버페이', out: 10900 }]);
  assert.equal(Core.chargeStatuses(noKey, txs, [], 2026, 10)[0].status, 'scheduled');
  const keyed = [sub({ id: 'a', amount: 10900, day: 5, matchKey: '네이버페이' })];
  const excluded = txs.map((t) => ({ ...t, excluded: true }));
  assert.equal(Core.chargeStatuses(keyed, excluded, [], 2026, 10)[0].status, 'scheduled');
});

test('월말 결제가 다음 달 초 거래와 맞춰진다', () => {
  const subs = [sub({ id: 'a', amount: 1100, day: 31, matchKey: 'APPLE' })];
  const txs = withIds([{ date: '2026-11-02', desc: 'APPLE.COM/BILL', out: 1100 }]);
  assert.equal(Core.chargeStatuses(subs, txs, [], 2026, 10)[0].status, 'paid');
});

test('!는 이전 달에 확인된 적이 있고 내역이 결제일+3일을 넘을 때만', () => {
  const subs = [sub({ id: 'a', amount: 10900, day: 5, matchKey: '네이버페이' })];
  const sep = { date: '2026-09-05', desc: '네이버페이', out: 10900 };
  // 9월에 확인됨 + 내역이 10/8까지 → 10월은 !
  const covered = withIds([sep, { date: '2026-10-08', desc: '편의점', out: 3000 }]);
  assert.equal(Core.chargeStatuses(subs, covered, [], 2026, 10)[0].status, 'missing');
  // 내역이 10/7까지면 아직 판단하지 않는다
  const short = withIds([sep, { date: '2026-10-07', desc: '편의점', out: 3000 }]);
  assert.equal(Core.chargeStatuses(subs, short, [], 2026, 10)[0].status, 'scheduled');
  // 한 번도 확인된 적이 없으면(아직 네이버페이로 안 옮긴 구독) 경고하지 않는다
  const never = withIds([{ date: '2026-10-20', desc: '편의점', out: 3000 }]);
  assert.equal(Core.chargeStatuses(subs, never, [], 2026, 10)[0].status, 'scheduled');
});

// ---------- 지출 ----------
test('총 지출 = 확인된 구독 결제 + 그 외 지출, 제외 항목은 빠진다', () => {
  const subs = [sub({ id: 'a', amount: 10900, day: 5, matchKey: '네이버페이' })];
  const txs = withIds([
    { date: '2026-10-05', desc: '네이버페이', out: 10900 },
    { date: '2026-10-06', desc: '편의점', out: 5000 },
    { date: '2026-10-07', desc: '내적금', memo: '자동이체', out: 100000 },
    { date: '2026-10-08', desc: '월급', in: 2000000 },
    { date: '2026-09-30', desc: '편의점', out: 7000 },
  ]);
  const rules = [{ id: 'r1', keyword: '적금' }];
  const m = Core.matchAll(subs, txs, rules);
  const sp = Core.monthSpending(txs, 2026, 10, rules, m.matchedTxIds);
  assert.deepEqual(sp, { total: 15900, subs: 10900, other: 5000, count: 2, excluded: 1 });
  assert.equal(sp.total, sp.subs + sp.other);
});

test('직접 바꾼 제외 설정이 규칙보다 먼저다', () => {
  const rules = [{ keyword: '적금' }];
  assert.equal(Core.isExcluded(tx({ desc: '내 적금' }), rules), true);
  assert.equal(Core.isExcluded(tx({ desc: '내 적금', excluded: false }), rules), false);
  assert.equal(Core.isExcluded(tx({ desc: '편의점', excluded: true }), rules), true);
  assert.equal(Core.isExcluded(tx({ desc: '편의점' }), rules), false);
});

// ---------- 중복 제거 ----------
test('기간이 겹치게 다시 불러와도 같은 거래는 한 번만', () => {
  const a = [
    { date: '2026-10-01', time: '10:00:00', desc: '편의점', out: 3000, balance: 97000 },
    { date: '2026-10-02', time: '11:00:00', desc: '네이버페이', out: 10900, balance: 86100 },
  ].map(tx);
  const b = [
    { date: '2026-10-02', time: '11:00:00', desc: '네이버페이', out: 10900, balance: 86100 },
    { date: '2026-10-03', time: '12:00:00', desc: '식당', out: 9000, balance: 77100 },
  ].map(tx);
  const first = Core.mergeTransactions([], a);
  assert.equal(first.added, 2);
  const second = Core.mergeTransactions(first.merged, b);
  assert.deepEqual([second.added, second.duplicates, second.merged.length], [1, 1, 3]);
});

test('같은 날 같은 금액 두 건은 둘 다 남고, 다시 불러오면 둘 다 중복', () => {
  const same = [
    { date: '2026-10-01', desc: '편의점', out: 1500 },
    { date: '2026-10-01', desc: '편의점', out: 1500 },
  ].map(tx);
  const first = Core.mergeTransactions([], same);
  assert.equal(first.added, 2);
  const again = Core.mergeTransactions(first.merged, same);
  assert.deepEqual([again.added, again.duplicates], [0, 2]);
});

test('불러온 기존 거래의 제외 설정은 다시 불러와도 유지된다', () => {
  const first = Core.mergeTransactions([], [tx({ date: '2026-10-01', desc: '이체', out: 50000 })]);
  const edited = first.merged.map((t) => ({ ...t, excluded: true }));
  const again = Core.mergeTransactions(edited, [tx({ date: '2026-10-01', desc: '이체', out: 50000 })]);
  assert.equal(again.merged[0].excluded, true);
});

// ---------- 행 → 거래 ----------
test('계좌정보 행을 건너뛰고 머리글을 찾아 거래로 바꾼다(합계 행은 무시)', () => {
  const rows = [
    ['신한은행 거래내역조회'],
    ['계좌번호', '110-000-000000'],
    [],
    ['거래일자', '거래시간', '적요', '출금(원)', '입금(원)', '내용', '잔액(원)', '거래점'],
    ['2026.10.14', '12:30:11', '체크카드', '14,900', '', '네이버페이', '1,234,567', '온라인'],
    ['2026.10.13', '09:05', '급여', '', '2,000,000', '회사', '1,249,467', ''],
    ['합계', '', '', '14,900', '2,000,000', '', '', ''],
  ];
  const r = Core.parseRows(rows);
  assert.equal(r.ok, true);
  assert.equal(r.headerRow, 3);
  assert.deepEqual(r.txs, [
    { date: '2026-10-14', time: '12:30:11', desc: '네이버페이', memo: '체크카드', out: 14900, in: 0, balance: 1234567 },
    { date: '2026-10-13', time: '09:05:00', desc: '회사', memo: '급여', out: 0, in: 2000000, balance: 1249467 },
  ]);
  assert.equal(r.skipped, 1);
});

test('열 순서가 바뀌고 날짜와 시간이 한 칸에 있어도 읽는다', () => {
  const rows = [
    ['거래일시', '내용', '입금', '출금', '잔액'],
    ['2026-10-15 13:45:10', '편의점', '0', '3,500원', '10,000'],
    ['20261016', '식당', '', 9000, ''],
  ];
  const r = Core.parseRows(rows);
  assert.deepEqual(
    r.txs.map((t) => [t.date, t.time, t.desc, t.out, t.in, t.balance]),
    [
      ['2026-10-15', '13:45:10', '편의점', 3500, 0, 10000],
      ['2026-10-16', '', '식당', 9000, 0, null],
    ],
  );
});

test('엑셀 날짜 일련번호와 시간 소수를 읽는다', () => {
  const serial = Core.diffDays('1970-01-01', '2026-10-15') + 25569;
  const r = Core.parseRows([
    ['거래일자', '거래시간', '출금', '입금', '내용'],
    [serial, 0.5, 1000, '', '빵집'],
    [serial + 0.75, '', 2000, '', '카페'],
  ]);
  assert.deepEqual(
    r.txs.map((t) => [t.date, t.time]),
    [
      ['2026-10-15', '12:00:00'],
      ['2026-10-15', '18:00:00'],
    ],
  );
});

test("'입출금구분' + '거래금액' 한 칸 형식", () => {
  const r = Core.parseRows([
    ['거래일자', '입출금구분', '거래금액', '거래내용'],
    ['2026.10.01', '출금', '5,000', '빵집'],
    ['2026.10.02', '입금', '30,000', '용돈'],
  ]);
  assert.deepEqual(
    r.txs.map((t) => [t.out, t.in, t.desc]),
    [
      [5000, 0, '빵집'],
      [0, 30000, '용돈'],
    ],
  );
});

test('머리글을 못 찾으면 이유와 앞부분을 알려 준다', () => {
  const r = Core.parseRows([['아무', '내용'], ['1', '2']]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /머리글/);
  assert.equal(r.preview.length, 2);
});

test('날짜·금액·시간 칸 해석', () => {
  assert.deepEqual(Core.parseDateTime('2026.1.5'), { date: '2026-01-05', time: '' });
  assert.deepEqual(Core.parseDateTime('2026년 10월 15일'), { date: '2026-10-15', time: '' });
  assert.equal(Core.parseDateTime('2026.02.30'), null);
  assert.equal(Core.parseDateTime('합계'), null);
  assert.ok(Number.isNaN(Core.parseAmount('')));
  assert.equal(Core.parseAmount('1,234원'), 1234);
  assert.equal(Core.parseTime('093005'), '09:30:05');
});

// ---------- 텍스트 파일 ----------
test('CSV 따옴표 안의 쉼표, 탭 구분 텍스트', () => {
  assert.deepEqual(Core.parseCsvLine('2026.10.01,"13,500",빵집'), ['2026.10.01', '13,500', '빵집']);
  assert.deepEqual(Core.splitDelimited('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
});

test('HTML 표(이름만 .xls인 파일)를 행으로 바꾼다', () => {
  const html = '<table><tr><th>거래일자</th><th>내용</th></tr><tr><td>2026.10.01</td><td>빵&amp;우유<br>세트&nbsp;</td></tr></table>';
  assert.deepEqual(Core.htmlTableRows(html), [['거래일자', '내용'], ['2026.10.01', '빵&우유 세트']]);
});

// ---------- 제안값 ----------
test('통장 표시 이름 제안과 네이버페이 이름 찾기', () => {
  assert.equal(Core.suggestMatchKey({ desc: 'NETFLIX.COM 1234' }), 'NETFLIX.COM');
  assert.equal(Core.suggestMatchKey({ desc: '', memo: '네이버페이' }), '네이버페이');
  const txs = [
    tx({ desc: '네이버페이', out: 1000 }),
    tx({ desc: '네이버페이', out: 2000 }),
    tx({ desc: '네이버파이낸셜', out: 3000 }),
    tx({ desc: '네이버페이', in: 5000 }),
  ];
  assert.equal(Core.guessPayKey(txs), '네이버페이');
});

test('최근 출금 목록은 최신순, 입금은 빠진다', () => {
  const txs = [
    tx({ date: '2026-10-01', desc: 'a', out: 1 }),
    tx({ date: '2026-10-10', desc: 'b', out: 2 }),
    tx({ date: '2026-10-11', desc: 'c', in: 3 }),
    tx({ date: '2026-05-01', desc: 'old', out: 4 }),
  ];
  assert.deepEqual(Core.recentWithdrawals(txs, '2026-10-15', 90).map((t) => t.desc), ['b', 'a']);
});

// ---------- 백업 ----------
test('백업을 만들고 다시 읽는다, 다른 파일은 거부한다', () => {
  const state = { ...Core.emptyState(), subs: [sub({ id: 's1' })] };
  const back = Core.readBackup(JSON.parse(JSON.stringify(Core.makeBackup(state, new Date('2026-10-15T00:00:00Z')))));
  assert.deepEqual(back, state);
  assert.throws(() => Core.readBackup({ hello: 1 }), /백업 파일이 아니/);
  assert.deepEqual(Core.normalizeState(null), Core.emptyState());
});
