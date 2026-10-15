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

test('수입은 한 달 총 지출에 들어가지 않고 따로 센다', () => {
  const subs = [sub({ amount: 10000, day: 5 })];
  const expenses = [exp({ date: '2026-10-02', amount: 5000 })];
  const incomes = [exp({ id: 'i1', date: '2026-10-10', amount: 300000 }), exp({ id: 'i2', date: '2026-11-10', amount: 1 })];
  assert.deepEqual(Core.monthTotals(subs, expenses, 2026, 10), { subs: 10000, other: 5000, total: 15000, count: 1 });
  assert.deepEqual(Core.monthIncome(incomes, 2026, 10), { amount: 300000, count: 1 });
});

// ---------- 통장 잔액 ----------
// 10/15 14:00(한국 시각)에 은행 앱에서 본 잔액 100,000원
const bal = (o) => ({ amount: 100000, date: '2026-10-15', setAt: '2026-10-15T05:00:00.000Z', paidToday: false, ...o });

test('잔액: 맞춘 날 뒤의 수입·지출·구독 결제를 더하고 뺀다(달이 바뀌어도)', () => {
  const state = {
    ...Core.emptyState(),
    subs: [sub({ id: 'a', amount: 14900, day: 3 }), sub({ id: 'b', amount: 13500, day: 20 })],
    expenses: [exp({ date: '2026-10-16', amount: 5000 }), exp({ date: '2026-11-02', amount: 7000 })],
    incomes: [exp({ id: 'i1', date: '2026-11-01', amount: 300000 })],
    balance: bal(),
  };
  // 11/5까지: 수입 300,000 − 지출 12,000 − 구독(10/20 13,500 + 11/3 14,900). 10/3 결제는 맞추기 전이라 넣지 않는다
  const b = Core.balanceNow(state, '2026-11-05');
  assert.equal(b.total, 100000 + 300000 - 12000 - 28400);
  assert.deepEqual(b.counts, { income: 1, spent: 2, subs: 2 });
  assert.equal(Core.balanceNow(state, '2026-10-15').total, 100000);
});

test('잔액: 맞춘 날 날짜는 맞춘 뒤에 적은 것만, 앞 날짜는 넣지 않고 앞으로의 날짜는 그날 넣는다', () => {
  const state = {
    ...Core.emptyState(),
    expenses: [
      exp({ id: 'before', date: '2026-10-15', amount: 1000, createdAt: '2026-10-15T04:00:00.000Z' }), // 맞추기 전에 적음
      exp({ id: 'after', date: '2026-10-15', amount: 2000, createdAt: '2026-10-15T06:00:00.000Z' }), // 맞춘 뒤에 적음
      exp({ id: 'old', date: '2026-10-15', amount: 4000 }), // 적은 시각이 없는 옛 항목
      exp({ id: 'back', date: '2026-10-12', amount: 8000, createdAt: '2026-10-16T00:00:00.000Z' }), // 맞춘 뒤에 앞 날짜로 적음
      exp({ id: 'future', date: '2026-10-20', amount: 16000, createdAt: '2026-10-15T06:00:00.000Z' }),
    ],
    balance: bal(),
  };
  assert.equal(Core.balanceNow(state, '2026-10-16').total, 98000);
  assert.equal(Core.balanceNow(state, '2026-10-20').total, 82000);
});

test('잔액: 맞춘 날의 구독 결제는 "이미 빠짐"이면 빼지 않고, 아니면 뺀다', () => {
  const state = { ...Core.emptyState(), subs: [sub({ amount: 13500, day: 15 })], balance: bal({ paidToday: true }) };
  assert.equal(Core.balanceNow(state, '2026-10-15').total, 100000);
  assert.equal(Core.balanceNow(state, '2026-11-15').total, 86500);
  assert.equal(Core.balanceNow({ ...state, balance: bal({ paidToday: false }) }, '2026-10-15').total, 86500);
});

test('잔액: 맞춘 적이 없으면 null, 오늘이 맞춘 날보다 앞이면 맞춘 값 그대로', () => {
  assert.equal(Core.balanceNow(Core.emptyState(), '2026-10-15'), null);
  const state = {
    ...Core.emptyState(),
    subs: [sub({ day: 14 })],
    expenses: [exp({ date: '2026-10-14', amount: 3000, createdAt: '2026-10-15T06:00:00.000Z' })],
    balance: bal(),
  };
  assert.equal(Core.balanceNow(state, '2026-10-14').total, 100000);
});

// ---------- 저장 상태 ----------
test('v1 저장본: 직접 입력한 거래만 지출·수입으로 옮기고, 불러온 통장 거래·규칙·통장 표시 이름은 버린다', () => {
  const v1 = {
    version: 1,
    subs: [{ id: 's1', name: '유튜브', amount: 14900, cycle: 'monthly', day: 3, color: 0, matchKey: '네이버페이' }],
    txs: [
      { id: 'm-1', date: '2026-10-02', time: '', desc: '현금 시장', memo: '반찬', out: 12000, in: 0, balance: null, source: 'manual' },
      { id: 'm-2', date: '2026-10-05', time: '', desc: '용돈', memo: '', out: 0, in: 50000, balance: null, source: 'manual' },
      { id: 'b-1', date: '2026-10-03', time: '06:10:00', desc: '네이버페이', memo: '체크카드', out: 14900, in: 0, balance: 1000, source: 'import' },
    ],
    rules: [{ id: 'r1', keyword: '적금' }],
    settings: { payKey: '네이버페이', lastBackupAt: '2026-10-01T00:00:00.000Z' },
  };
  const s = Core.normalizeState(v1);
  assert.equal(s.version, Core.STATE_VERSION);
  assert.deepEqual(s.subs, [{ id: 's1', name: '유튜브', amount: 14900, cycle: 'monthly', day: 3, color: 0 }]);
  assert.deepEqual(s.expenses, [{ id: 'm-1', date: '2026-10-02', amount: 12000, title: '현금 시장', memo: '반찬' }]);
  assert.deepEqual(s.incomes, [{ id: 'm-2', date: '2026-10-05', amount: 50000, title: '용돈', memo: '' }]);
  assert.equal(s.balance, null);
  assert.deepEqual(s.settings, { lastBackupAt: '2026-10-01T00:00:00.000Z' });
  assert.equal('rules' in s, false);
  assert.equal('txs' in s, false);
});

test('v2 저장본: 지출은 그대로, 수입은 빈 목록, 잔액은 없음으로 채운다', () => {
  const v2 = {
    version: 2,
    subs: [sub({ id: 's1' })],
    expenses: [{ id: 'e1', date: '2026-10-02', amount: 5000, title: '점심', memo: '' }],
    settings: { lastBackupAt: null },
    updatedAt: '2026-10-15T00:00:00.000Z',
  };
  const s = Core.normalizeState(v2);
  assert.equal(s.version, Core.STATE_VERSION);
  assert.deepEqual(s.subs, v2.subs);
  assert.deepEqual(s.expenses, v2.expenses);
  assert.deepEqual(s.incomes, []);
  assert.equal(s.balance, null);
  assert.equal(s.updatedAt, v2.updatedAt);
});

test('수입·잔액·적은 시각은 백업을 거쳐도 남고(0원 잔액 포함), 잘못된 잔액은 버린다', () => {
  const state = {
    ...Core.emptyState(),
    expenses: [exp({ id: 'e1', date: '2026-10-15', amount: 5000, createdAt: '2026-10-15T06:00:00.000Z' })],
    incomes: [exp({ id: 'i1', date: '2026-10-15', amount: 300000, title: '용돈', createdAt: '2026-10-15T07:00:00.000Z' })],
    balance: { amount: 0, date: '2026-10-15', setAt: '2026-10-15T05:00:00.000Z', paidToday: true },
    updatedAt: '2026-10-15T07:00:00.000Z',
  };
  assert.deepEqual(Core.readBackup(JSON.parse(JSON.stringify(Core.makeBackup(state)))), state);
  for (const bad of [{ amount: -1, date: '2026-10-15' }, { amount: 1000, date: '10/15' }, { amount: null, date: '2026-10-15' }, { amount: 'abc', date: '2026-10-15' }, 5]) {
    assert.equal(Core.normalizeState({ balance: bad }).balance, null, JSON.stringify(bad));
  }
});

test('새 버전 앱이 저장한 내용은 알아보고, 그런 백업은 거부한다', () => {
  assert.equal(Core.isNewerState({ version: Core.STATE_VERSION + 1 }), true);
  assert.equal(Core.isNewerState({ version: 2 }), false);
  assert.equal(Core.isNewerState(null), false);
  assert.throws(() => Core.readBackup({ app: 'subcal', version: 99, state: { version: 99 } }), /새 버전/);
});

test('v1 백업 파일도 지금 형식으로 옮겨 읽는다', () => {
  const back = { app: 'subcal', version: 1, exportedAt: '2026-10-15T00:00:00Z', state: { subs: [], txs: [{ id: 'm-1', date: '2026-10-02', desc: '빵', out: 3000, source: 'manual' }] } };
  assert.deepEqual(Core.readBackup(back).expenses, [{ id: 'm-1', date: '2026-10-02', amount: 3000, title: '빵', memo: '' }]);
});

test('잘못된 지출(날짜 형식·0원 이하)은 버린다', () => {
  const s = Core.normalizeState({ expenses: [{ id: 1, date: '2026-10-02', amount: 100 }, { id: 2, date: '10/2', amount: 100 }, { id: 3, date: '2026-10-03', amount: 0 }] });
  assert.deepEqual(s.expenses.map((e) => e.id), ['1']);
});

test('백업을 만들고 다시 읽는다, 다른 파일은 거부한다', () => {
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
  // 수입만 있거나 잔액만 맞춰 둔 PC도 비어 있지 않다(비었다고 보면 연결할 때 GitHub 내용으로 덮인다)
  assert.equal(Core.isEmptyState({ ...Core.emptyState(), incomes: [exp({ date: '2026-10-01', amount: 1 })] }), false);
  assert.equal(Core.isEmptyState({ ...Core.emptyState(), balance: { amount: 0, date: '2026-10-01', setAt: '', paidToday: false } }), false);
});
