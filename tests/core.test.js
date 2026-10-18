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

test('그날 남는 돈: 지금 잔액에 앞으로의 수입·지출·구독 결제와 써 볼 지출을 더하고 뺀다', () => {
  const state = {
    ...Core.emptyState(),
    subs: [sub({ id: 'a', name: 'A', amount: 14900, day: 31 }), sub({ id: 'b', name: 'B', amount: 13500, day: 17 })],
    expenses: [exp({ date: '2026-10-16', amount: 5000 }), exp({ date: '2026-11-02', amount: 7000, title: '병원' })],
    incomes: [exp({ id: 'i1', date: '2026-11-01', amount: 300000 })],
    balance: bal(),
  };
  const today = '2026-10-17';
  const now = Core.balanceNow(state, today).total; // 100,000 − 5,000 − 13,500(10/17 결제)
  assert.equal(now, 81500);
  // 오늘 그대로: 오늘 결제·지출은 이미 지금 잔액에 들어 있다
  assert.deepEqual(Core.balanceOn(state, today, today, []).items, []);
  assert.equal(Core.balanceOn(state, today, today).total, now);
  // 11/2까지: 10/31 구독 −14,900, 11/1 수입 +300,000, 11/2 지출 −7,000
  const r = Core.balanceOn(state, today, '2026-11-02', []);
  assert.equal(r.total, now - 14900 + 300000 - 7000);
  assert.deepEqual(r.items.map((x) => [x.date, x.kind]), [['2026-10-31', 'sub'], ['2026-11-01', 'in'], ['2026-11-02', 'out']]);
  // 써 볼 지출 없이 계산하면 그날의 balanceNow와 같다
  assert.equal(r.total, Core.balanceNow(state, '2026-11-02').total);
  // 써 볼 지출: 오늘~그날만 넣고, 그날 뒤는 넣지 않는다
  const plans = [{ date: today, amount: 1000, title: '' }, { date: '2026-10-25', amount: 20000, title: '선물' }, { date: '2026-11-03', amount: 50000, title: '' }];
  const p = Core.balanceOn(state, today, '2026-11-02', plans);
  assert.equal(p.planned, 21000);
  assert.equal(p.total, r.total - 21000);
});

test('그날 남는 돈: 잔액을 맞춘 적이 없거나 지난 날짜면 null', () => {
  assert.equal(Core.balanceOn(Core.emptyState(), '2026-10-17', '2026-10-20', []), null);
  assert.equal(Core.balanceOn({ ...Core.emptyState(), balance: bal() }, '2026-10-17', '2026-10-16', []), null);
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
  assert.deepEqual(s.events, []);
  assert.equal(s.balance, null);
  assert.equal(s.updatedAt, v2.updatedAt);
});

test('v3 저장본: 일정은 빈 목록으로 채우고 나머지는 그대로', () => {
  const v3 = {
    version: 3,
    subs: [sub({ id: 's1' })],
    expenses: [{ id: 'e1', date: '2026-10-02', amount: 5000, title: '점심', memo: '' }],
    incomes: [{ id: 'i1', date: '2026-10-01', amount: 300000, title: '용돈', memo: '' }],
    balance: { amount: 1000, date: '2026-10-01', setAt: '', paidToday: false },
    settings: { lastBackupAt: null },
    updatedAt: '2026-10-15T00:00:00.000Z',
  };
  const s = Core.normalizeState(v3);
  assert.equal(s.version, Core.STATE_VERSION);
  assert.deepEqual(s.events, []);
  assert.deepEqual({ ...s, events: undefined, version: 3 }, { ...v3, events: undefined });
});

test('일정: 날짜가 틀리면 버리고, 이름이 비면 "일정", 시간은 HH:MM만 남긴다', () => {
  const s = Core.normalizeState({
    events: [
      { id: 1, date: '2026-10-20', time: '14:30', title: ' 치과 ', memo: '' },
      { id: 2, date: '10/20', title: '틀린 날짜' },
      { id: 3, date: '2026-10-21', time: '2시', title: '' },
      null,
    ],
  });
  assert.deepEqual(s.events, [
    { id: '1', date: '2026-10-20', time: '14:30', repeat: '', title: '치과', memo: '' },
    { id: '3', date: '2026-10-21', time: '', repeat: '', title: '일정', memo: '' },
  ]);
});

test('일정: 그 달 것만 날짜·시간 순(시간 없는 것이 그날 먼저), 돈 계산에는 안 들어감', () => {
  const events = [
    { id: 'a', date: '2026-10-20', time: '15:00', title: 'B' },
    { id: 'b', date: '2026-11-01', time: '', title: '다음 달' },
    { id: 'c', date: '2026-10-20', time: '', title: '종일' },
    { id: 'd', date: '2026-10-05', time: '09:00', title: 'A' },
  ];
  assert.deepEqual(Core.eventsInMonth(events, 2026, 10).map((e) => e.id), ['d', 'c', 'a']);
  const state = { ...Core.emptyState(), events, balance: { amount: 1000, date: '2026-10-01', setAt: '', paidToday: false } };
  assert.equal(Core.balanceNow(state, '2026-10-25').total, 1000);
  assert.equal(Core.monthTotals([], [], 2026, 10).total, 0);
});

test('수입·잔액·일정·적은 시각은 백업을 거쳐도 남고(0원 잔액 포함), 잘못된 잔액은 버린다', () => {
  const state = {
    ...Core.emptyState(),
    expenses: [exp({ id: 'e1', date: '2026-10-15', amount: 5000, createdAt: '2026-10-15T06:00:00.000Z' })],
    incomes: [exp({ id: 'i1', date: '2026-10-15', amount: 300000, title: '용돈', createdAt: '2026-10-15T07:00:00.000Z' })],
    events: [{ id: 'v1', date: '2026-10-20', time: '14:30', repeat: 'yearly', title: '치과', memo: '스케일링', createdAt: '2026-10-15T08:00:00.000Z' }],
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
  assert.equal(Core.isEmptyState({ ...Core.emptyState(), events: [{ id: 'v', date: '2026-10-01', time: '', title: '일정', memo: '' }] }), false);
  assert.equal(Core.isEmptyState({ ...Core.emptyState(), balance: { amount: 0, date: '2026-10-01', setAt: '', paidToday: false } }), false);
});

// ---------- 두 기기 합치기 ----------
const ev = (id, title, date = '2026-10-20') => ({ id, date, time: '', title, memo: '' });
const st = (o) => Core.normalizeState({ ...Core.emptyState(), ...o });

test('합치기: 양쪽에서 새로 적은 것은 모두 남는다', () => {
  const base = st({ expenses: [exp({ id: 'a', date: '2026-10-01', amount: 1000 })] });
  const local = st({ expenses: [...base.expenses, exp({ id: 'pc', date: '2026-10-02', amount: 2000 })] });
  const remote = st({ expenses: [...base.expenses, exp({ id: 'ph', date: '2026-10-03', amount: 3000 })], events: [ev('e1', '치과')] });
  const m = Core.mergeStates(base, local, remote, '2026-10-18T00:00:00.000Z');
  assert.deepEqual(m.expenses.map((e) => e.id), ['a', 'ph', 'pc']);
  assert.deepEqual(m.events.map((e) => e.id), ['e1']);
  assert.equal(m.updatedAt, '2026-10-18T00:00:00.000Z');
});

test('합치기: 한쪽에서 지운 것은 지워지고, 지웠는데 다른 쪽이 고쳤으면 고친 것을 남긴다', () => {
  const base = st({ events: [ev('x', '지울 것'), ev('y', '고칠 것')] });
  const local = st({ events: [] }); // 이 기기에서 둘 다 지움
  const remote = st({ events: [ev('x', '지울 것'), ev('y', '고쳤음')] });
  assert.deepEqual(Core.mergeStates(base, local, remote).events.map((e) => e.title), ['고쳤음']);
  // 반대로 원격에서 지운 것도 지워진다
  assert.deepEqual(Core.mergeStates(base, base, st({ events: [ev('y', '고칠 것')] })).events.map((e) => e.id), ['y']);
});

test('합치기: 같은 항목을 둘 다 고치면 이 기기 것, 한쪽만 고치면 그쪽 것(칸 순서는 안 따짐)', () => {
  const base = st({ subs: [sub({ id: 's', name: '넷플릭스', amount: 13500 })] });
  const remoteEdit = st({ subs: [sub({ id: 's', name: '넷플릭스', amount: 17000 })] });
  const reordered = st({ subs: [{ amount: 13500, day: 1, cycle: 'monthly', name: '넷플릭스', id: 's' }] });
  assert.equal(Core.mergeStates(base, reordered, remoteEdit).subs[0].amount, 17000);
  const localEdit = st({ subs: [sub({ id: 's', name: '넷플릭스', amount: 9000 })] });
  assert.equal(Core.mergeStates(base, localEdit, remoteEdit).subs[0].amount, 9000);
});

test('합치기: 잔액은 바뀐 쪽, 둘 다 맞췄으면 나중에 맞춘 것. 백업 시각은 나중 것', () => {
  const bal = (amount, setAt) => ({ amount, date: '2026-10-18', setAt, paidToday: false });
  const base = st({ balance: bal(100, '2026-10-18T01:00:00.000Z') });
  const l = st({ balance: bal(200, '2026-10-18T03:00:00.000Z'), settings: { lastBackupAt: '2026-10-10T00:00:00.000Z' } });
  const r = st({ balance: bal(300, '2026-10-18T02:00:00.000Z'), settings: { lastBackupAt: '2026-10-12T00:00:00.000Z' } });
  const m = Core.mergeStates(base, l, r);
  assert.equal(m.balance.amount, 200);
  assert.equal(m.settings.lastBackupAt, '2026-10-12T00:00:00.000Z');
  assert.equal(Core.mergeStates(base, base, r).balance.amount, 300);
  assert.equal(Core.mergeStates(base, base, st({ balance: null })).balance, null); // 저쪽에서 잔액 계산을 껐다
});

test('같은 데이터인지: 수정 시각·백업 시각은 따지지 않는다', () => {
  const a = st({ events: [ev('e', '치과')], updatedAt: '2026-10-01T00:00:00.000Z' });
  const b = st({ events: [ev('e', '치과')], updatedAt: '2026-10-18T00:00:00.000Z', settings: { lastBackupAt: '2026-10-18T00:00:00.000Z' } });
  assert.equal(Core.sameData(a, b), true);
  assert.equal(Core.sameData(a, st({ events: [ev('e', '안과')] })), false);
});

test('매년 일정: 처음 날짜의 해부터 해마다 같은 월·일, 2월 29일은 평년에 28일', () => {
  const events = [
    { id: 'b', date: '2000-10-21', time: '', repeat: 'yearly', title: '생일' },
    { id: 'f', date: '2024-02-29', time: '', repeat: 'yearly', title: '윤일' },
    { id: 'n', date: '2030-10-05', time: '', repeat: 'yearly', title: '아직' },
    { id: 'o', date: '2025-10-03', time: '', repeat: '', title: '한 번' },
  ];
  const oct = Core.eventsInMonth(events, 2026, 10);
  assert.deepEqual(oct.map((e) => [e.id, e.date]), [['b', '2026-10-21']]);
  assert.equal(oct[0].start, '2000-10-21');
  assert.deepEqual(Core.eventsInMonth(events, 2027, 2).map((e) => e.date), ['2027-02-28']);
  assert.deepEqual(Core.eventsInMonth(events, 2028, 2).map((e) => e.date), ['2028-02-29']);
  assert.deepEqual(Core.eventsInMonth(events, 2030, 10).map((e) => e.id), ['n', 'b']);
  assert.deepEqual(Core.eventsInMonth(events, 2025, 10).map((e) => e.id), ['o', 'b']);
});

test('v4 저장본: 일정의 반복은 없음으로 채운다', () => {
  const s = Core.normalizeState({ version: 4, events: [{ id: 'e', date: '2026-10-20', time: '', title: '치과', memo: '' }] });
  assert.equal(s.events[0].repeat, '');
  assert.equal(Core.normalizeState({ events: [{ id: 'e', date: '2026-10-20', repeat: 'weekly' }] }).events[0].repeat, '');
});
