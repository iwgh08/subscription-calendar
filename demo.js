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
    for (let d = C.ymd(first.y, first.m, 1); d <= today; d = C.addDays(d, 1)) {
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
    return { version: 2, subs, expenses, settings: { lastBackupAt: null }, updatedAt: new Date().toISOString() };
  }

  root.Demo = { build };
})(typeof self !== 'undefined' ? self : this);
