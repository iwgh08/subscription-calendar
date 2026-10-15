// 파일 불러오기 테스트: 가짜 데이터로 은행 파일과 같은 구조를 만들어 바이트 → 행 → 거래까지 확인한다.
// (실제 은행 파일은 개인정보라 저장소에 넣지 않는다)
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core.js');
const XLSX = require('../vendor/xlsx.full.min.js');

// 신한 거래내역과 비슷한 구조(위쪽 계좌정보 → 머리글 → 거래 → 합계)
const HEADER = ['거래일자', '거래시간', '적요', '출금(원)', '입금(원)', '내용', '잔액(원)', '거래점'];
const ROWS = [
  ['신한은행 거래내역조회'],
  ['계좌번호', '110-000-000000', '예금주', '홍길동'],
  ['조회기간', '2026.08.01 ~ 2026.10.14'],
  [],
  HEADER,
  ['2026.10.14', '12:30:11', '체크카드', 14900, '', '네이버페이', 1234567, '온라인'],
  ['2026.10.13', '09:05:00', '급여', '', 2000000, '회사', 1249467, ''],
  ['2026.10.05', '08:00:02', '체크카드', 10900, '', '네이버페이', 1049467, '온라인'],
];
const EXPECTED = [
  ['2026-10-14', '12:30:11', '네이버페이', '체크카드', 14900, 0, 1234567],
  ['2026-10-13', '09:05:00', '회사', '급여', 0, 2000000, 1249467],
  ['2026-10-05', '08:00:02', '네이버페이', '체크카드', 10900, 0, 1049467],
];
const flat = (txs) => txs.map((t) => [t.date, t.time, t.desc, t.memo, t.out, t.in, t.balance]);

function workbookBytes(rows, bookType) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '거래내역');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType }));
}

for (const bookType of ['xlsx', 'biff8']) {
  test(`SheetJS로 만든 ${bookType === 'biff8' ? 'xls' : 'xlsx'} 파일을 읽는다`, () => {
    const bytes = workbookBytes(ROWS, bookType);
    assert.equal(Core.needsSheetJS(bytes), true);
    const r = Core.parseRows(Core.fileToRows(bytes, XLSX));
    assert.equal(r.ok, true);
    assert.deepEqual(flat(r.txs), EXPECTED);
  });
}

test('엑셀 날짜 형식 칸(일련번호)도 읽는다', () => {
  const serial = Core.diffDays('1970-01-01', '2026-10-14') + 25569;
  const ws = XLSX.utils.aoa_to_sheet([['거래일자', '출금', '입금', '내용'], [serial, 3000, '', '빵집']]);
  ws.A2.z = 'yyyy-mm-dd';
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'S');
  const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
  const r = Core.parseRows(Core.fileToRows(bytes, XLSX));
  assert.deepEqual(r.txs.map((t) => [t.date, t.out, t.desc]), [['2026-10-14', 3000, '빵집']]);
});

test('이름만 .xls인 HTML 표 파일을 SheetJS 없이 읽는다', () => {
  const tr = (cells, tag) => `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join('')}</tr>`;
  const html =
    '<html><head><meta charset="utf-8"></head><body><table>' +
    tr(['계좌번호', '110-000-000000'], 'td') +
    tr(HEADER, 'th') +
    tr(['2026.10.14', '12:30:11', '체크카드', '14,900', '&nbsp;', '네이버페이', '1,234,567', '온라인'], 'td') +
    '</table></body></html>';
  const bytes = new TextEncoder().encode(html);
  assert.equal(Core.needsSheetJS(bytes), false);
  const r = Core.parseRows(Core.fileToRows(bytes, null));
  assert.deepEqual(flat(r.txs), [EXPECTED[0]]);
});

// 테스트용 EUC-KR 인코더: TextDecoder('euc-kr')로 2바이트 조합을 모두 풀어 글자 → 바이트 표를 만든다
function eucKrEncoder() {
  const dec = new TextDecoder('euc-kr');
  const map = new Map();
  for (let a = 0xa1; a <= 0xfe; a++) {
    for (let b = 0xa1; b <= 0xfe; b++) {
      const ch = dec.decode(new Uint8Array([a, b]));
      if (ch.length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, [a, b]);
    }
  }
  return (s) => {
    const out = [];
    for (const ch of s) {
      const code = ch.charCodeAt(0);
      if (code < 0x80) out.push(code);
      else if (map.has(ch)) out.push(...map.get(ch));
      else throw new Error(`EUC-KR로 바꿀 수 없는 글자: ${ch}`);
    }
    return new Uint8Array(out);
  };
}

test('EUC-KR 탭 구분 텍스트 파일을 읽는다', () => {
  const lines = [['계좌번호', '110-000-000000'], HEADER, ['2026.10.14', '12:30:11', '체크카드', '14,900', '', '네이버페이', '1,234,567', '온라인']];
  const bytes = eucKrEncoder()(lines.map((l) => l.join('\t')).join('\r\n'));
  assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)); // 정말 UTF-8이 아닌지
  assert.equal(Core.needsSheetJS(bytes), false);
  const r = Core.parseRows(Core.fileToRows(bytes, null));
  assert.deepEqual(flat(r.txs), [EXPECTED[0]]);
});

test('UTF-8 CSV(BOM 포함) 파일을 읽는다', () => {
  const csv = '﻿거래일자,출금(원),입금(원),내용\r\n2026.10.14,"14,900",,네이버페이\r\n';
  const r = Core.parseRows(Core.fileToRows(new TextEncoder().encode(csv), null));
  assert.deepEqual(r.txs.map((t) => [t.date, t.out, t.desc]), [['2026-10-14', 14900, '네이버페이']]);
});

test('엑셀 파일인데 SheetJS가 없으면 알기 쉬운 오류', () => {
  const bytes = workbookBytes(ROWS, 'xlsx');
  assert.throws(() => Core.fileToRows(bytes, null), /엑셀 파일을 읽는 도구/);
});
