/* 화면 확인용 샘플 데이터(?demo=1로 열 때만 불러온다). 실제 데이터가 아니며 저장하지 않는다.
 * 네이버플러스 멤버십은 이번 달 결제가 빠져 있어서 달력에 ! 표시가 어떻게 보이는지 확인할 수 있다. */
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
      { id: 'd1', name: '유튜브 프리미엄', amount: 14900, cycle: 'monthly', day: 3, color: 0, matchKey: '네이버페이' },
      { id: 'd2', name: '네이버플러스 멤버십', amount: 4900, cycle: 'monthly', day: 8, color: 2, matchKey: '네이버페이' },
      { id: 'd3', name: '넷플릭스', amount: 13500, cycle: 'monthly', day: 15, color: 1, matchKey: '네이버페이' },
      { id: 'd4', name: '휴대폰 요금', amount: 45000, cycle: 'monthly', day: 25, color: 3, matchKey: 'SKT' },
      { id: 'd5', name: '멜론', amount: 10900, cycle: 'monthly', day: 27, color: 4, matchKey: '네이버페이' },
      { id: 'd6', name: 'iCloud+', amount: 1100, cycle: 'monthly', day: 31, color: 6, matchKey: '네이버페이' },
      { id: 'd7', name: '도메인 연장', amount: 22000, cycle: 'yearly', month: C.addMonths(t.y, t.m, 1).m, day: 12, color: 7, matchKey: '' },
    ];

    const first = C.addMonths(t.y, t.m, -5);
    const end = C.addDays(today, -1); // 어제까지 불러온 것처럼
    const rows = [];
    let balance = 1850000;
    const add = (date, time, memo, desc, out, inn) => {
      balance += (inn || 0) - (out || 0);
      rows.push({ date, time, memo, desc, out: out || 0, in: inn || 0, balance });
    };
    for (let d = C.ymd(first.y, first.m, 1); d <= end; d = C.addDays(d, 1)) {
      const p = C.parseYmd(d);
      if (p.d === 10) add(d, '09:00:00', '급여', '(주)한빛상사', 0, 2350000);
      if (p.d === 11) add(d, '08:30:00', '자동이체', '내 적금', 300000, 0);
      for (const s of subs) {
        if (!s.matchKey || C.chargeDate(s, p.y, p.m) !== d) continue;
        if (s.id === 'd2' && p.y === t.y && p.m === t.m) continue; // 이번 달 결제 실패(! 예시)
        const card = s.matchKey !== 'SKT';
        add(d, '06:10:00', card ? '체크카드' : '자동이체', card ? '네이버페이' : 'SKT 통신요금', s.amount, 0);
      }
      const n = Math.floor(rand() * 3);
      for (let i = 0; i < n; i++) {
        const [desc, lo, hi] = pick([
          ['GS25', 1500, 8000],
          ['스타벅스', 4500, 7800],
          ['배달의민족', 15000, 29000],
          ['네이버페이', 18000, 48000],
          ['다이소', 2000, 12000],
          ['교통카드', 1450, 1450],
          ['김밥천국', 6000, 11000],
        ]);
        const hh = String(10 + i * 4).padStart(2, '0');
        const mm = String(Math.floor(rand() * 60)).padStart(2, '0');
        add(d, `${hh}:${mm}:00`, '체크카드', desc, Math.round((lo + rand() * (hi - lo)) / 100) * 100, 0);
      }
    }

    return {
      version: 1,
      subs,
      txs: C.assignIds(rows).map((x) => ({ ...x, source: 'import' })),
      rules: [{ id: 'r1', keyword: '적금' }],
      settings: { payKey: '네이버페이', lastBackupAt: null },
    };
  }

  root.Demo = { build };
})(typeof self !== 'undefined' ? self : this);
