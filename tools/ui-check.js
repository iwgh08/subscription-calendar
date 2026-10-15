// 화면 점검: 헤드리스 Edge를 DevTools 프로토콜로 조종해 아이폰 크기(390×844, 모바일 에뮬레이션)에서
// 탭·시트를 열어 캡처하고, 가짜 신한 엑셀 파일 불러오기 → 저장 유지 → 결제 확인(✓) → 오프라인 열기까지 확인한다.
//   npm start 를 켜 둔 상태에서: node tools/ui-check.js <캡처 저장 폴더>
// 실제 은행 파일은 쓰지 않는다(가짜 데이터로 같은 구조를 만든다).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('../vendor/xlsx.full.min.js');

const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = `http://localhost:${process.env.PORT || 8080}`;
const outDir = path.resolve(process.argv[2] || 'ui-shots');
fs.mkdirSync(outDir, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function launch() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subcal-ui-'));
  const port = 9300 + Math.floor(Math.random() * 400);
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(tmp, 'profile')}`, 'about:blank'], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch (e) {
      /* 아직 안 켜짐 */
    }
    if (!wsUrl) await wait(250);
  }
  if (!wsUrl) throw new Error('Edge DevTools에 연결하지 못했어요');
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception ? msg.params.exceptionDetails.exception.description : msg.params.exceptionDetails.text);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push(`${msg.params.entry.text} ${msg.params.entry.url || ''}`);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const b = {
    send,
    errors,
    async theme(dark) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
    },
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`${expression}: ${r.exceptionDetails.text} ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description : ''}`);
      return r.result.value;
    },
    async goto(url) {
      await send('Page.navigate', { url });
      for (let i = 0; i < 80; i++) {
        await wait(150);
        try {
          if (await b.eval('document.body && (document.body.dataset.ready === "1" || !!document.body.dataset.error)')) break;
        } catch (e) {
          /* 페이지가 바뀌는 중 */
        }
      }
      await wait(250);
    },
    async click(sel) {
      const ok = await b.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true; })()`);
      if (!ok) throw new Error(`누를 것을 못 찾음: ${sel}`);
      await wait(250);
    },
    async shot(name) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(r.data, 'base64'));
    },
    async close() {
      try {
        ws.close();
      } catch (e) {
        /* 이미 닫힘 */
      }
      proc.kill();
      await wait(500);
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    },
  };
  return b;
}

const noOverflow = 'document.documentElement.scrollWidth <= innerWidth';

// 신한 거래내역과 같은 구조의 가짜 엑셀 파일(이번 달 3일에 네이버페이 14,900원)
function fakeShinhanFile(dir) {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const rows = [
    ['신한은행 거래내역조회'],
    ['계좌번호', '110-000-000000'],
    [],
    ['거래일자', '거래시간', '적요', '출금(원)', '입금(원)', '내용', '잔액(원)', '거래점'],
    [`${y}.${m}.01`, '09:00:00', '급여', '', 2000000, '회사', 2100000, ''],
    [`${y}.${m}.02`, '12:10:00', '체크카드', 5500, '', 'GS25', 2094500, ''],
    [`${y}.${m}.03`, '06:10:00', '체크카드', 14900, '', '네이버페이', 2079600, '온라인'],
    [`${y}.${m}.03`, '18:40:00', '체크카드', 32000, '', '네이버페이', 2047600, '온라인'],
    [`${y}.${m}.04`, '08:30:00', '자동이체', 300000, '', '내 적금', 1747600, ''],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '거래내역');
  const file = path.join(dir, '가짜-신한-거래내역.xlsx');
  fs.writeFileSync(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  return { file, day: 3 };
}

(async () => {
  const b = await launch();
  try {
    // ---------- 1. 샘플 데이터로 화면 ----------
    await b.theme(false);
    await b.goto(`${BASE}/?demo=1#home`);
    check('샘플: 시작 오류 없음', (await b.eval('document.body.dataset.ready')) === '1', await b.eval('document.body.dataset.error || ""'));
    for (const v of ['home', 'calendar', 'subs', 'spend']) {
      await b.eval(`location.hash = '${v}'`);
      await wait(300);
      check(`샘플: ${v} 탭 가로 넘침 없음`, await b.eval(noOverflow));
      await b.shot(`1-${v}`);
    }
    await b.eval("location.hash = 'home'");
    await wait(300);
    await b.eval("document.querySelector('#chart').scrollIntoView({ block: 'center' })");
    await wait(200);
    await b.click('#chart rect.hit:last-of-type');
    check('그래프: 막대를 누르면 말풍선', await b.eval("!!document.querySelector('#chart .tooltip')"));
    await b.shot('2-chart-tooltip');

    await b.eval("location.hash = 'calendar'");
    await wait(300);
    await b.click('.cal-cell.has');
    check('달력: 날짜를 누르면 시트', await b.eval("!document.querySelector('#sheet').hidden"));
    await b.shot('3-day-sheet');
    await b.click('[data-action="close-sheet"]');

    await b.eval("location.hash = 'subs'");
    await wait(300);
    await b.click('[data-action="add-sub"]');
    await b.click('[data-action="pick-open"]');
    await b.click('#picker [data-action="pick"]');
    check('구독 추가: 통장 내역에서 고르면 금액이 채워짐', (await b.eval("document.querySelector('#subForm').elements.amount.value")) !== '');
    await b.shot('4-sub-form');
    await b.click('[data-action="close-sheet"]');

    await b.eval("location.hash = 'spend'");
    await wait(300);
    await b.click('#view-spend [data-action="tx"]');
    await b.shot('5-tx-sheet');
    await b.click('[data-action="close-sheet"]');
    await b.click('[data-action="settings"]');
    await b.shot('6-settings');
    await b.click('[data-action="close-sheet"]');

    await b.theme(true);
    await b.eval("location.hash = 'home'");
    await wait(300);
    await b.shot('7-home-dark');
    await b.eval("location.hash = 'calendar'");
    await wait(300);
    await b.shot('7-calendar-dark');
    await b.theme(false);

    // ---------- 2. 실제 사용 흐름(빈 상태 → 파일 불러오기 → 저장 유지) ----------
    await b.goto(`${BASE}/#home`);
    check('빈 상태: 시작 오류 없음', (await b.eval('document.body.dataset.ready')) === '1');
    await b.shot('8-empty-home');

    const { file, day } = fakeShinhanFile(fs.mkdtempSync(path.join(os.tmpdir(), 'subcal-fake-')));
    await b.eval("location.hash = 'spend'");
    await wait(300);
    const doc = await b.send('DOM.getDocument', { depth: 1 });
    const { nodeId } = await b.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#importFile' });
    await b.send('DOM.setFileInputFiles', { nodeId, files: [file] });
    for (let i = 0; i < 40 && !(await b.eval("!!document.querySelector('[data-action=\"import-save\"]')")); i++) await wait(150);
    check('불러오기: 엑셀 미리보기(SheetJS가 CSP 아래에서 로드됨)', await b.eval("(document.querySelector('[data-action=\"import-save\"]') || {}).textContent === '5건 저장'"), await b.eval("document.querySelector('#sheetBody').innerText.slice(0, 200)"));
    await b.shot('9-import-preview');
    await b.click('[data-action="import-save"]');
    check('불러오기: 지출 목록에 거래 5건', (await b.eval("document.querySelectorAll('#view-spend [data-action=\"tx\"]').length")) === 5);
    check('불러오기: 적금 규칙 없을 때 총 지출 352,400원', (await b.eval("document.querySelector('#view-spend .stat').textContent")) === '352,400원');

    // 구독 추가(통장 표시 이름은 불러온 내역에서 찾은 '네이버페이'가 기본값으로 들어가야 한다)
    await b.eval("location.hash = 'subs'");
    await wait(300);
    await b.click('[data-action="add-sub"]');
    check('구독 추가: 통장 표시 이름 기본값 = 네이버페이', (await b.eval("document.querySelector('#subForm').elements.matchKey.value")) === '네이버페이');
    await b.eval(`(() => { const f = document.querySelector('#subForm'); f.elements.name.value = '유튜브 프리미엄'; f.elements.amount.value = '14,900'; f.elements.day.value = '${day}'; })()`);
    await b.eval("document.querySelector('#subForm').requestSubmit()");
    await wait(300);
    check('구독 추가: 목록에 보임', (await b.eval("document.querySelector('#view-subs').innerText")).includes('유튜브 프리미엄'));
    check('결제 확인: 같은 날 32,000원 쇼핑은 빼고 14,900원에 ✓', (await b.eval("document.querySelector('#view-subs .badge.ok') ? document.querySelector('#view-subs .badge.ok').textContent : ''")).includes('확인'));

    // 다시 열어도 남아 있는지(IndexedDB)
    await b.goto(`${BASE}/#home`);
    const homeText = await b.eval("document.querySelector('#view-home').innerText");
    check('저장 유지: 다시 열어도 총 지출 352,400원', homeText.includes('352,400원'), homeText.slice(0, 80).replace(/\n/g, ' '));
    check('저장 유지: 확인된 구독 결제 14,900원', homeText.includes('14,900원'));
    await b.eval("location.hash = 'calendar'");
    await wait(300);
    check('달력: 결제일 칸에 ✓', await b.eval(`(() => { const c = [...document.querySelectorAll('.cal-cell')].find((x) => x.querySelector('.num') && x.querySelector('.num').textContent === '${day}'); return !!(c && c.querySelector('.ok')); })()`));
    await b.shot('10-calendar-after-import');

    // ---------- 3. 오프라인(서비스 워커) ----------
    for (let i = 0; i < 30 && !(await b.eval('!!(navigator.serviceWorker && navigator.serviceWorker.controller)')); i++) {
      await b.goto(`${BASE}/#home`);
      await wait(300);
    }
    check('서비스 워커: 페이지를 맡고 있음', await b.eval('!!navigator.serviceWorker.controller'));
    await b.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await b.goto(`${BASE}/#home`);
    check('오프라인: 다시 열어도 화면이 뜸', (await b.eval("document.body.dataset.ready === '1' && document.querySelector('#view-home').innerText.includes('352,400원')")) === true);
    await b.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

    check('콘솔 오류 없음', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
  } finally {
    await b.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} 통과 · 캡처: ${outDir}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
