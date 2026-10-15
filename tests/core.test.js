// 핵심 로직 테스트: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core.js');

const sub = (o) => ({ id: o.id || o.name, name: 'x', amount: 10000, cycle: 'monthly', day: 1, ...o });
const exp = (o) => ({ id: o.id || `${o.date}-${o.amount}`, title: '', memo: '', ...o });

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
  assert.deepEqual(
    Core.upcoming(subs, '2026-10-15', 30).map((c) => [c.sub.name, c.date, c.dday]),
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

test('결제일이 지난 구독과 남은 구독(오늘은 남은 쪽)', () => {
  const subs = [sub({ id: 'a', amount: 14900, day: 3 }), sub({ id: 'b', amount: 13500, day: 15 }), sub({ id: 'c', amount: 10900, day: 27 })];
  assert.deepEqual(Core.monthProgress(subs, 2026, 10, '2026-10-15'), {
    count: 3,
    past: { count: 1, amount: 14900 },
    remain: { count: 2, amount: 24400 },
  });
  assert.equal(Core.monthProgress(subs, 2026, 9, '2026-10-15').remain.count, 0);
});

test('달력은 일요일 시작 7칸 주로 나뉜다', () => {
  const weeks = Core.calendarWeeks(2026, 10);
  assert.ok(weeks.every((w) => w.length === 7));
  assert.equal(weeks.flat().filter(Boolean).length, 31);
  assert.equal(weeks.flat().indexOf('2026-10-01'), Core.weekday('2026-10-01'));
});

// ---------- 월 합계 ----------
test('한 달 총 지출 = 구독료(결제일 기준) + 그 달에 직접 입력한 지출', () => {
  const subs = [sub({ id: 'a', amount: 14900, day: 3 }), sub({ id: 'b', amount: 13500, day: 27 })];
  const expenses = [
    exp({ date: '2026-10-02', amount: 5500, title: '편의점' }),
    exp({ date: '2026-10-20', amount: 32000, title: '쇼핑' }),
    exp({ date: '2026-09-30', amount: 7000, title: '지난달' }),
  ];
  assert.deepEqual(Core.monthTotals(subs, expenses, 2026, 10), { subs: 28400, other: 37500, total: 65900, count: 2 });
  assert.deepEqual(Core.expensesInMonth(expenses, 2026, 10).map((e) => e.title), ['편의점', '쇼핑']);
});

// ---------- 저장 상태 ----------
test('v1 저장본: 직접 입력한 거래만 지출로 옮기고, 불러온 통장 거래·규칙·통장 표시 이름은 버린다', () => {
  const v1 = {
    version: 1,
    subs: [{ id: 's1', name: '유튜브', amount: 14900, cycle: 'monthly', day: 3, color: 0, matchKey: '네이버페이' }],
    txs: [
      { id: 'm-1', date: '2026-10-02', time: '', desc: '현금 시장', memo: '반찬', out: 12000, in: 0, balance: null, source: 'manual' },
      { id: 'b-1', date: '2026-10-03', time: '06:10:00', desc: '네이버페이', memo: '체크카드', out: 14900, in: 0, balance: 1000, source: 'import' },
    ],
    rules: [{ id: 'r1', keyword: '적금' }],
    settings: { payKey: '네이버페이', lastBackupAt: '2026-10-01T00:00:00.000Z' },
  };
  const v2 = Core.normalizeState(v1);
  assert.equal(v2.version, 2);
  assert.deepEqual(v2.subs, [{ id: 's1', name: '유튜브', amount: 14900, cycle: 'monthly', day: 3, color: 0 }]);
  assert.deepEqual(v2.expenses, [{ id: 'm-1', date: '2026-10-02', amount: 12000, title: '현금 시장', memo: '반찬' }]);
  assert.deepEqual(v2.settings, { lastBackupAt: '2026-10-01T00:00:00.000Z' });
  assert.equal('rules' in v2, false);
  assert.equal('txs' in v2, false);
});

test('v1 백업 파일도 v2로 옮겨 읽는다', () => {
  const back = { app: 'subcal', version: 1, exportedAt: '2026-10-15T00:00:00Z', state: { subs: [], txs: [{ id: 'm-1', date: '2026-10-02', desc: '빵', out: 3000, source: 'manual' }] } };
  assert.deepEqual(Core.readBackup(back).expenses, [{ id: 'm-1', date: '2026-10-02', amount: 3000, title: '빵', memo: '' }]);
});

test('잘못된 지출(날짜 형식·0원 이하)은 버린다', () => {
  const s = Core.normalizeState({ expenses: [{ id: 1, date: '2026-10-02', amount: 100 }, { id: 2, date: '10/2', amount: 100 }, { id: 3, date: '2026-10-03', amount: 0 }] });
  assert.deepEqual(s.expenses.map((e) => e.id), ['1']);
});

test('v2 백업을 만들고 다시 읽는다, 다른 파일은 거부한다', () => {
  const state = { ...Core.emptyState(), subs: [sub({ id: 's1' })], expenses: [exp({ id: 'e1', date: '2026-10-02', amount: 5000, title: '점심' })], updatedAt: '2026-10-15T01:02:03.000Z' };
  const back = Core.readBackup(JSON.parse(JSON.stringify(Core.makeBackup(state, new Date('2026-10-15T00:00:00Z')))));
  assert.deepEqual(back, state);
  assert.throws(() => Core.readBackup({ hello: 1 }), /백업 파일이 아니/);
  assert.deepEqual(Core.normalizeState(null), Core.emptyState());
});

test('빈 상태 판단', () => {
  assert.equal(Core.isEmptyState(Core.emptyState()), true);
  assert.equal(Core.isEmptyState({ ...Core.emptyState(), subs: [sub({ id: 'a' })] }), false);
  assert.equal(Core.isEmptyState({ ...Core.emptyState(), expenses: [exp({ date: '2026-10-01', amount: 1 })] }), false);
});
