/* 화면 확인용 샘플 데이터(?demo=1로 열 때만 불러온다). 실제 데이터가 아니며 저장하지 않는다. */
(function (root) {
  'use strict';

  function build(today) {
    const C = root.Core;
    const t = C.parseYmd(today);
    let seed = 20261015;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const subs = [
      { id: 'd1', name: '유튜브 프리미엄', amount: 14900, cycle: 'monthly', day: 3, color: 0 },
      { id: 'd2', name: '네이버플러스 멤버십', amount: 4900, cycle: 'monthly', day: 8, color: 2 },
      { id: 'd3', name: '넷플릭스', amount: 13500, cycle: 'monthly', day: 15, color: 1 },
      { id: 'd4', name: '휴대폰 요금', amount: 45000, cycle: 'monthly', day: 25, color: 3 },
      { id: 'd5', name: '멜론', amount: 10900, cycle: 'monthly', day: 27, color: 4 },
      { id: 'd6', name: 'iCloud+', amount: 1100, cycle: 'monthly', day: 31, color: 6 },
      { id: 'd7', name: '도메인 연장', amount: 22000, cycle: 'yearly', month: C.addMonths(t.y, t.m, 1).m, day: 12, color: 7 },
    ];
    const first = C.addMonths(t.y, t.m, -5);
    const expenses = [];
    const incomes = [];
    for (let d = C.ymd(first.y, first.m, 1); d <= today; d = C.addDays(d, 1)) {
      const day = C.parseYmd(d).d;
      if (day === 1) incomes.push({ id: `p${incomes.length}`, date: d, amount: 300000, title: '용돈', memo: '' });
      if (day === 20) incomes.push({ id: `p${incomes.length}`, date: d, amount: 420000, title: '알바비', memo: '' });
      const n = Math.floor(rand() * 3);
      for (let i = 0; i < n; i++) {
        const [title, lo, hi] = pick([
          ['점심', 7000, 12000],
          ['카페', 4500, 7000],
          ['편의점', 1500, 8000],
          ['교통', 1450, 1450],
          ['배달', 15000, 28000],
          ['쇼핑', 12000, 45000],
          ['생활용품', 3000, 15000],
        ]);
        expenses.push({ id: `x${expenses.length}`, date: d, amount: Math.round((lo + rand() * (hi - lo)) / 100) * 100, title, memo: '' });
      }
    }
    // 6주 전 저녁에 잔액을 맞춰 둔 것으로 한다(가짜 금액)
    const anchor = C.addDays(today, -42);
    const a = C.parseYmd(anchor);
    const balance = { amount: 850000, date: anchor, setAt: new Date(a.y, a.m - 1, a.d, 21, 0).toISOString(), paidToday: true };
    const events = [
      { id: 'v1', date: C.addDays(today, 2), time: '14:30', title: '치과', memo: '스케일링' },
      { id: 'v2', date: C.ymd(t.y - 20, t.m, Math.min(28, t.d + 3)), time: '', repeat: 'yearly', title: '친구 생일', memo: '' },
      { id: 'v3', date: C.addDays(today, 5), time: '19:00', title: '저녁 약속', memo: '' },
      { id: 'v4', date: C.addDays(today, -4), time: '10:00', title: '면접', memo: '' },
    ];
    return { version: 5, subs, expenses, incomes, events, balance, settings: { lastBackupAt: null }, updatedAt: new Date().toISOString() };
  }

  root.Demo = { build };
})(typeof self !== 'undefined' ? self : this);
