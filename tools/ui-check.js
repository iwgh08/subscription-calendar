// 화면 점검: 헤드리스 Edge를 DevTools 프로토콜로 조종해 확인한다.
//  1) 샘플 데이터 화면(아이폰 크기 390×844, 모바일 에뮬레이션): 탭·시트·다크 모드 캡처, 가로 넘침
//  2) 가짜 GitHub(개발 서버 /__gh)로 PC(입력) ↔ 폰(보기) 연결: 연결, 빠른 입력(Enter), 받아오기, 오프라인, 충돌, 틀린 토큰
//   npm start 를 켜 둔 상태에서: node tools/ui-check.js <캡처 저장 폴더>
//   배포된 사이트는 1)만: BASE_URL=https://iwgh08.github.io/subscription-calendar node tools/ui-check.js <폴더>
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/$/, '');
const LIVE = !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE);
const outDir = path.resolve(process.argv[2] || 'ui-shots');
fs.mkdirSync(outDir, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  (${detail})` : ''}`);
};

async function launch({ width, height, mobile }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subcal-ui-'));
  const port = 9300 + Math.floor(Math.random() * 600);
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
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method === 'Page.javascriptDialogOpening') {
      send('Page.handleJavaScriptDialog', { accept: true }); // confirm()은 '확인'을 누른 것으로
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(d.exception ? d.exception.description : d.text);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && msg.params.entry.source !== 'network') {
      errors.push(`${msg.params.entry.text} ${msg.params.entry.url || ''}`); // 일부러 낸 401·오프라인 같은 네트워크 오류는 뺀다
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
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
    async waitFor(expression, ms = 8000) {
      for (let t = 0; t < ms; t += 150) {
        try {
          if (await b.eval(expression)) return true;
        } catch (e) {
          /* 페이지가 바뀌는 중 */
        }
        await wait(150);
      }
      return false;
    },
    // 항상 페이지를 새로 연다(같은 주소#해시로 이동하면 다시 열리지 않으므로 그때는 새로고침). 옛 페이지를 '준비됨'으로 착각하지 않게 표시를 남긴다
    async goto(url) {
      await b.eval('window.__stale = true').catch(() => {});
      const cur = await b.eval('location.href').catch(() => '');
      if (cur === url) await send('Page.reload', {});
      else await send('Page.navigate', { url });
      const ok = await b.waitFor('!window.__stale && document.body && (document.body.dataset.ready === "1" || !!document.body.dataset.error)', 12000);
      if (!ok) throw new Error(`페이지를 열지 못함: ${url}`);
      await wait(200);
    },
    async click(sel) {
      const ok = await b.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true; })()`);
      if (!ok) {
        const where = await b.eval("`시트: ${document.querySelector('#sheet').hidden ? '닫힘' : document.querySelector('#sheetTitle').textContent} | 상태 줄: ${(document.querySelector('#syncbar') || {}).innerText || ''}`");
        throw new Error(`누를 것을 못 찾음: ${sel} (${where})`);
      }
      await wait(250);
    },
    async fill(sel, value) {
      await b.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    },
    async tab(view) {
      await b.eval(`location.hash = '${view}'`);
      await wait(250);
    },
    async pressEnter(sel) {
      await b.eval(`document.querySelector(${JSON.stringify(sel)}).focus()`);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await wait(300);
    },
    async offline(on) {
      await send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
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
// 괄호로 감싸야 `${text(...)}.includes(...)`가 의도대로 계산된다(감싸지 않으면 || 뒤만 비교해서 늘 통과한다)
const text = (sel) => `((document.querySelector(${JSON.stringify(sel)}) || {}).innerText || '')`;

async function demoScreens() {
  const b = await launch({ width: 390, height: 844, mobile: true });
  try {
    await b.theme(false);
    await b.goto(`${BASE}/?demo=1#home`);
    check('샘플: 시작 오류 없음', (await b.eval('document.body.dataset.ready')) === '1', await b.eval('document.body.dataset.error || ""'));
    for (const v of ['home', 'calendar', 'subs', 'spend']) {
      await b.tab(v);
      check(`샘플: ${v} 탭 가로 넘침 없음`, await b.eval(noOverflow));
      await b.shot(`1-${v}`);
    }
    await b.tab('home');
    await b.eval("document.querySelector('#chart').scrollIntoView({ block: 'center' })");
    await b.click('#chart rect.hit:last-of-type');
    check('그래프: 막대를 누르면 말풍선', await b.eval("!!document.querySelector('#chart .tooltip')"));
    await b.shot('2-chart-tooltip');
    await b.tab('calendar');
    await b.click('.cal-cell.has');
    check('달력: 날짜를 누르면 시트', await b.eval("!document.querySelector('#sheet').hidden"));
    await b.shot('3-day-sheet');
    await b.click('[data-action="close-sheet"]');
    await b.tab('subs');
    await b.click('[data-action="add-sub"]');
    await b.shot('4-sub-form');
    await b.click('[data-action="close-sheet"]');
    await b.tab('spend');
    await b.click('#view-spend [data-action="edit-exp"]');
    check('지출: 항목을 누르면 수정 시트', await b.eval("!!document.querySelector('#expForm')"));
    await b.shot('5-exp-sheet');
    await b.click('[data-action="close-sheet"]');
    await b.click('[data-action="settings"]');
    await b.shot('6-settings');
    await b.click('[data-action="close-sheet"]');
    await b.theme(true);
    await b.tab('home');
    await b.shot('7-home-dark');
    await b.tab('spend');
    await b.shot('7-spend-dark');
    check('샘플: 콘솔 오류 없음', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
  } finally {
    await b.close();
  }
}

async function syncFlow() {
  await fetch(`${BASE}/__gh/_reset`, { method: 'POST' });
  const G = `${BASE}/?gh=/__gh`;
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const pc = await launch({ width: 1024, height: 800, mobile: false });
  const phone = await launch({ width: 390, height: 844, mobile: true });
  const saved = () => pc.waitFor("document.body.dataset.sync === 'ok' && document.querySelector('#syncbar').innerText.includes('저장됨')", 10000);
  const remote = async () => JSON.parse((await (await fetch(`${BASE}/__gh/_file`)).json()).text);
  try {
    // ----- PC: 입력 기기로 연결(토큰에 공백·줄바꿈을 섞어 붙여 넣어도 된다) -----
    await pc.theme(false);
    await pc.goto(`${G}#home`);
    await pc.click('[data-action="settings"]');
    await pc.fill('#syncToken', ' test-rw \n');
    await pc.eval("document.querySelector('input[name=\"syncRole\"][value=\"writer\"]').checked = true");
    await pc.click('[data-action="sync-connect"]');
    check('PC: 입력 기기로 연결', await pc.waitFor("document.body.dataset.sync === 'ok'"), await pc.eval(text('#syncbar')));

    await pc.tab('subs');
    await pc.click('[data-action="add-sub"]');
    await pc.eval("(() => { const f = document.querySelector('#subForm'); f.elements.name.value = '유튜브 프리미엄'; f.elements.amount.value = '14,900'; f.elements.day.value = '3'; f.requestSubmit(); })()");
    await wait(300);

    await pc.tab('spend');
    await pc.eval(`(() => { const f = document.querySelector('#quickAdd'); f.elements.date.value = '${ym}-02'; f.elements.amount.value = '5,500'; f.elements.title.value = 'GS25'; })()`);
    await pc.pressEnter('#quickAdd [name="title"]');
    check('빠른 입력: Enter로 추가되고 금액 칸이 비고 초점이 감', await pc.eval("(() => { const f = document.querySelector('#quickAdd'); return f.elements.amount.value === '' && document.activeElement === f.elements.amount; })()"));
    check('빠른 입력: 날짜는 그대로', (await pc.eval("document.querySelector('#quickAdd').elements.date.value")) === `${ym}-02`);
    await pc.fill('#quickAdd [name="amount"]', '32000');
    await pc.fill('#quickAdd [name="title"]', '쇼핑');
    await pc.pressEnter('#quickAdd [name="amount"]');
    check('지출 탭: 구독(자동) 1줄 + 직접 입력 2줄', (await pc.eval("document.querySelectorAll('#view-spend .list > li').length")) === 3);
    check('PC: GitHub에 저장됨', await saved(), await pc.eval(text('#syncbar')));
    let r = await remote();
    check('가짜 저장소: 구독 1개·지출 2건', r.subs.length === 1 && r.expenses.length === 2, JSON.stringify(r).slice(0, 120));
    check('가짜 저장소에 토큰이 들어가지 않음', !JSON.stringify(r).includes('test-rw'));
    await pc.shot('8-pc-spend');

    // ----- 폰: 읽기 전용 토큰으로 보기 기기 연결 -----
    await phone.theme(false);
    await phone.goto(`${G}#home`);
    await phone.click('[data-action="settings"]');
    await phone.fill('#syncToken', 'test-ro');
    await phone.eval("document.querySelector('input[name=\"syncRole\"][value=\"reader\"]').checked = true");
    await phone.click('[data-action="sync-connect"]');
    check('폰: 보기 기기로 연결해 받아옴', await phone.waitFor(`${text('#view-home .hero')} === '52,400원'`), await phone.eval(text('#view-home .hero')));
    const bar = await phone.eval(text('#syncbar'));
    check('폰: 상태 줄에 PC 수정 시각과 받아온 시각', bar.includes('PC 수정') && bar.includes('받아옴') && !bar.includes('PC 수정 -'), bar);
    await phone.shot('9-phone-home');
    await phone.tab('subs');
    check('폰: 구독 추가 버튼 없음', await phone.eval("!document.querySelector('[data-action=\"add-sub\"]')"));
    await phone.tab('spend');
    check('폰: 빠른 입력 줄·수정 버튼 없음', await phone.eval("!document.querySelector('#quickAdd') && !document.querySelector('[data-action=\"edit-exp\"]')"));
    check('폰: 지출 탭 가로 넘침 없음', await phone.eval(noOverflow));
    await phone.shot('9-phone-spend');

    // ----- PC에서 고치면 폰이 화면으로 돌아올 때 새 값 -----
    await pc.fill('#quickAdd [name="amount"]', '10000');
    await pc.fill('#quickAdd [name="title"]', '저녁');
    await pc.pressEnter('#quickAdd [name="title"]');
    check('PC: 추가분 저장됨', await saved());
    await phone.tab('home');
    await phone.eval("document.dispatchEvent(new Event('visibilitychange'))");
    check('폰: 화면으로 돌아오면 새 값(62,400원)', await phone.waitFor(`${text('#view-home .hero')} === '62,400원'`), await phone.eval(text('#view-home .hero')));

    // ----- 폰 오프라인: 다시 열어도 마지막 내용 + 경고 -----
    // 개발자 도구의 오프라인 흉내는 페이지(앱 파일)에만 걸리고 GitHub 요청에는 안 걸려서, 가짜 GitHub도 함께 끊는다
    for (let i = 0; i < 20 && !(await phone.eval('!!(navigator.serviceWorker && navigator.serviceWorker.controller)')); i++) await phone.goto(`${G}#home`);
    check('폰: 서비스 워커가 페이지를 맡음', await phone.eval('!!navigator.serviceWorker.controller'));
    await phone.offline(true);
    await fetch(`${BASE}/__gh/_down`, { method: 'POST', body: 'on' });
    await phone.goto(`${G}#home`);
    check('폰 오프라인: 마지막으로 받은 내용이 보임', (await phone.eval(text('#view-home .hero'))) === '62,400원');
    check('폰 오프라인: "받아오지 못함" 경고', await phone.waitFor(`${text('#syncbar')}.includes('받아오지 못함')`), await phone.eval(text('#syncbar')));
    await phone.shot('10-phone-offline');
    await fetch(`${BASE}/__gh/_down`, { method: 'POST', body: 'off' });
    await phone.offline(false);

    // ----- 충돌: 다른 곳에서 바뀐 뒤 PC에서 고치면 묻는다 -----
    const other = { version: 2, subs: [], expenses: [{ id: 'z', date: `${ym}-05`, amount: 777, title: '다른 기기', memo: '' }], settings: { lastBackupAt: null }, updatedAt: new Date().toISOString() };
    await fetch(`${BASE}/__gh/_file`, { method: 'POST', body: JSON.stringify(other) });
    await pc.fill('#quickAdd [name="amount"]', '1000');
    await pc.fill('#quickAdd [name="title"]', '커피');
    await pc.pressEnter('#quickAdd [name="title"]');
    check('충돌: 시트로 어느 쪽을 남길지 물음', await pc.waitFor(`!document.querySelector('#sheet').hidden && ${text('#sheetTitle')}.includes('달라요')`, 10000), await pc.eval(text('#syncbar')));
    await pc.shot('11-pc-conflict');
    await pc.click('[data-action="conflict-local"]');
    check('충돌: 이 PC 내용으로 덮어쓰면 저장됨', await saved());
    r = await remote();
    check('충돌: GitHub 내용 = PC 내용(지출 4건, 다른 기기 내용 없음)', r.expenses.length === 4 && !r.expenses.some((e) => e.amount === 777), JSON.stringify(r.expenses.map((e) => e.amount)));

    // ----- 틀린 토큰 -----
    await phone.click('[data-action="settings"]');
    await phone.click('[data-action="sync-disconnect"]');
    await phone.click('[data-action="settings"]');
    await phone.fill('#syncToken', 'wrong-token');
    await phone.eval("document.querySelector('input[name=\"syncRole\"][value=\"reader\"]').checked = true");
    await phone.click('[data-action="sync-connect"]');
    check('틀린 토큰: "HTTP 401" 오류를 보여 줌', await phone.waitFor(`${text('#syncError')}.includes('401')`), await phone.eval(text('#syncError')));
    await phone.shot('12-phone-bad-token');

    check('PC: 콘솔 오류 없음', pc.errors.length === 0, pc.errors.slice(0, 3).join(' | '));
    check('폰: 콘솔 오류 없음', phone.errors.length === 0, phone.errors.slice(0, 3).join(' | '));
  } finally {
    await pc.close();
    await phone.close();
  }
}

(async () => {
  await demoScreens();
  if (!LIVE) await syncFlow();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} 통과 · 캡처: ${outDir}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
