// 화면 점검: 헤드리스 Edge를 DevTools 프로토콜로 조종해 확인한다.
//  1) 샘플 데이터 화면(아이폰 크기 390×844, 모바일 에뮬레이션): 탭·시트·다크 모드 캡처, 가로 넘침
//  2) 가짜 GitHub(개발 서버 /__gh)로 PC(입력) ↔ 폰(보기) 연결: 연결, 빠른 입력(Enter), 받아오기, 오프라인, 충돌, 틀린 토큰
//  3) PC·폰 둘 다 입력 기기: 따로 고친 내용이 묻지 않고 합쳐지는지
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
  const dialogs = []; // confirm() 문구 기록
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
      dialogs.push(msg.params.message);
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
    dialogs,
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
    // 항상 페이지를 새로 연다. 주소가 같고 #해시만 다르면 이동해도 다시 열리지 않으므로, 주소만 바꾼 뒤 새로고침한다.
    // 옛 페이지를 '준비됨'으로 착각하지 않게 표시(__stale)를 남긴다
    async goto(url) {
      await b.eval('window.__stale = true').catch(() => {});
      const cur = await b.eval('location.href').catch(() => '');
      if (cur.split('#')[0] === url.split('#')[0]) {
        await b.eval(`history.replaceState(null, '', ${JSON.stringify(url)})`);
        await send('Page.reload', {});
      } else await send('Page.navigate', { url });
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
    // sel 가운데에서 (dx, dy)만큼 손가락으로 민다
    async swipe(sel, dx, dy = 0) {
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      const c = await b.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y }] });
      for (let i = 1; i <= 5; i++) {
        await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x + (dx * i) / 5, y: c.y + (dy * i) / 5 }] });
        await wait(20);
      }
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
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
    for (const v of ['home', 'calendar', 'subs', 'spend', 'plan']) {
      await b.tab(v);
      check(`샘플: ${v} 탭 가로 넘침 없음`, await b.eval(noOverflow));
      await b.shot(`1-${v}`);
    }
    await b.tab('home');
    check('샘플: 홈에 지금 통장 잔액', /^-?[\d,]+원$/.test(await b.eval(text('#balanceHero'))), await b.eval(text('#balanceHero')));
    const upEv = await b.eval(text('#upcomingEvents'));
    check('홈: 다가오는 일정(치과 D-2·친구 생일 매년 D-3)', upEv.includes('치과') && upEv.includes('D-2') && upEv.includes('친구 생일') && upEv.includes('매년') && !upEv.includes('면접'), upEv);
    await b.click('#upcomingEvents [data-action="edit-event"]');
    check('홈: 다가오는 일정을 누르면 일정 수정 시트', (await b.eval(text('#sheetTitle'))) === '일정 수정');
    await b.click('[data-action="close-sheet"]');
    await b.click('[data-action="settings"]');
    await b.click('[data-action="help"][data-topic="widget"]');
    check('도움말: 아이폰 위젯 만들기에 "위젯 스크립트 복사" 버튼', (await b.eval(text('#sheetTitle'))) === '아이폰 위젯 만들기' && (await b.eval("!!document.querySelector('[data-action=\"copy-widget\"]')")));
    check('위젯 스크립트 파일을 앱 주소에서 받을 수 있음', await b.eval("fetch('widget/subcal-widget.js', { cache: 'no-store' }).then((r) => r.ok && r.text()).then((t) => !!t && t.includes('Scriptable') && t.includes('widgetSummary'))"));
    await b.shot('6-widget-help');
    await b.click('[data-action="close-sheet"]');
    await b.click('[data-action="balance"]');
    check('잔액 맞추기: 시트에 앱 계산 값과 입력 칸', await b.eval("!!document.querySelector('#balForm [name=\"amount\"]') && document.querySelector('#balForm').innerText.includes('지금 앱 계산')"));
    await b.shot('2-balance-sheet');
    await b.click('[data-action="close-sheet"]');
    await b.eval("document.querySelector('#chart').scrollIntoView({ block: 'center' })");
    await b.click('#chart rect.hit:last-of-type');
    check('그래프: 막대를 누르면 말풍선', await b.eval("!!document.querySelector('#chart .tooltip')"));
    await b.shot('2-chart-tooltip');
    await b.tab('calendar');
    const label0 = await b.eval(text('#monthLabel'));
    await b.eval("document.querySelector('#view-calendar .cal-grid').scrollIntoView({ block: 'center' })");
    await b.swipe('#view-calendar .cal-grid', -150);
    const label1 = await b.eval(text('#monthLabel'));
    check('달력 밀기: 왼쪽으로 밀면 다음 달(그날 시트는 안 열림)', label1 !== label0 && (await b.eval("document.querySelector('#sheet').hidden")), `${label0} → ${label1}`);
    await b.swipe('#view-calendar .cal-grid', 150);
    check('달력 밀기: 오른쪽으로 밀면 이전 달', (await b.eval(text('#monthLabel'))) === label0, await b.eval(text('#monthLabel')));
    await b.swipe('#view-calendar .cal-grid', 30, 160);
    check('달력 밀기: 위아래로 민 것은 달을 안 넘김', (await b.eval(text('#monthLabel'))) === label0 && (await b.eval("document.querySelector('#sheet').hidden")), await b.eval(text('#monthLabel')));
    await b.tab('plan');
    await b.swipe('#view-plan .cal-grid', -150);
    check('계산 탭 달력도 밀면 다음 달', (await b.eval(text('#monthLabel'))) === label1, await b.eval(text('#monthLabel')));
    await b.click('[data-action="this-month"]');
    await b.tab('calendar');
    await b.click('.cal-cell.has');
    check('달력: 날짜를 누르면 시트', await b.eval("!document.querySelector('#sheet').hidden"));
    await b.shot('3-day-sheet');
    await b.click('[data-action="close-sheet"]');
    check('달력: 일정이 칸(네모 표시)과 달 목록에 보임', await b.eval("!!document.querySelector('.cal-cell .chip.ev') && document.querySelectorAll('#view-calendar [data-action=\"edit-event\"]').length === document.querySelectorAll('#view-calendar .chip.ev').length"));
    await b.click('#view-calendar [data-action="add-event"]');
    await b.fill('#eventForm [name="title"]', '샘플 일정');
    await b.eval("document.querySelector('#eventForm').requestSubmit()");
    check('달력: 일정 추가하면 달 목록에 생김', (await b.eval(text('#view-calendar'))).includes('샘플 일정'));
    await b.click('.cal-cell .chip.ev');
    check('달력: 일정 있는 날 시트에 일정·추가 버튼', (await b.eval(text('#sheetBody'))).includes('일정') && (await b.eval("!!document.querySelector('#sheetBody [data-action=\"add-event\"]')")));
    await b.shot('3-day-sheet-event');
    await b.click('#sheetBody [data-action="edit-event"]');
    check('달력: 그날 시트에서 일정을 누르면 수정 시트', (await b.eval(text('#sheetTitle'))) === '일정 수정');
    await b.shot('3-event-form');
    await b.click('[data-action="close-sheet"]');
    check('매년 일정: 이번 달 목록에 "매년" 표시', (await b.eval(text('#view-calendar'))).includes('친구 생일') && (await b.eval("[...document.querySelectorAll('#view-calendar .list .name')].some((n) => n.innerText.includes('친구 생일') && n.innerText.includes('매년'))")));
    for (let i = 0; i < 12; i++) await b.click('[data-action="next-month"]');
    check('매년 일정: 1년 뒤 같은 달에도 나옴', (await b.eval(text('#view-calendar'))).includes('친구 생일') && !(await b.eval(text('#view-calendar'))).includes('치과'));
    await b.click('#view-calendar [data-action="edit-event"]');
    check('매년 일정: 고치기 시트에 "매년" 체크', await b.eval("document.querySelector('#eventForm [name=\"repeat\"]').checked"));
    await b.shot('3-event-yearly');
    await b.click('[data-action="close-sheet"]');
    await b.click('[data-action="this-month"]');
    await b.tab('subs');
    await b.click('[data-action="add-sub"]');
    await b.shot('4-sub-form');
    await b.click('[data-action="close-sheet"]');
    await b.tab('spend');
    await b.click('#view-spend [data-action="edit-exp"]');
    check('내역: 지출을 누르면 수정 시트', await b.eval("!!document.querySelector('#expForm')"));
    await b.shot('5-exp-sheet');
    await b.click('[data-action="close-sheet"]');
    check('내역: 수입은 + 금액과 "수입" 표시', await b.eval("(() => { const r = document.querySelector('#view-spend [data-action=\"edit-inc\"]'); return !!r && r.innerText.includes('수입') && r.querySelector('.amt').innerText.startsWith('+'); })()"));
    await b.click('#view-spend [data-action="edit-inc"]');
    check('내역: 수입을 누르면 "수입 수정" 시트(종류가 수입)', (await b.eval(text('#sheetTitle'))) === '수입 수정' && (await b.eval("document.querySelector('#expForm input[name=\"kind\"][value=\"in\"]').checked")));
    await b.click('[data-action="close-sheet"]');
    await b.click('[data-action="settings"]');
    await b.shot('6-settings');
    await b.click('[data-action="close-sheet"]');
    await b.theme(true);
    await b.tab('home');
    await b.shot('7-home-dark');
    await b.tab('spend');
    await b.shot('7-spend-dark');
    await b.tab('plan');
    check('샘플 계산: 오늘 남는 돈 = 지금 잔액', /^-?[\d,]+원$/.test(await b.eval(text('#planResult'))), await b.eval(text('#planResult')));
    await b.click('[data-action="plan-day"]:last-of-type');
    check('샘플 계산: 날짜를 누르면 그 날짜가 골라짐', await b.eval("document.querySelectorAll('.cal-cell.selected').length === 1 && !document.querySelector('.cal-cell.today.selected')"));
    await b.shot('7-plan-dark');
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
    // ----- 폰에 데이터가 있는데 PC가 아직 안 올렸을 때 연결하면 먼저 묻는다(나중에 조용히 덮어쓰지 않게) -----
    await phone.theme(false);
    await phone.goto(`${G}#subs`);
    await phone.click('[data-action="add-sub"]');
    await phone.eval("(() => { const f = document.querySelector('#subForm'); f.elements.name.value = '폰에만 있는 구독'; f.elements.amount.value = '9,900'; f.requestSubmit(); })()");
    await wait(300);
    await phone.click('[data-action="settings"]');
    await phone.fill('#syncToken', 'test-ro');
    await phone.eval("document.querySelector('input[name=\"syncRole\"][value=\"reader\"]').checked = true");
    await phone.click('[data-action="sync-connect"]');
    await phone.waitFor("document.body.dataset.sync === 'error'");
    check('폰(데이터 있음): PC가 올리기 전에 연결하면 먼저 확인을 받음', phone.dialogs.some((d) => d.includes('아직 올린 내용이 없어요')), phone.dialogs.join(' | '));
    check('폰: "PC에서 아직 올린 내용이 없어요" 안내', (await phone.eval(text('#syncbar'))).includes('아직 올린 내용이 없어요'), await phone.eval(text('#syncbar')));
    await phone.click('[data-action="settings"]');
    await phone.click('[data-action="sync-disconnect"]');
    phone.dialogs.length = 0;

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

    // ----- 폰: 읽기 전용 토큰으로 보기 기기 연결(폰에 남은 데이터가 있으니 바꿀지 묻고, 확인하면 PC 내용으로 바뀐다) -----
    await phone.goto(`${G}#home`);
    await phone.click('[data-action="settings"]');
    await phone.fill('#syncToken', 'test-ro');
    await phone.eval("document.querySelector('input[name=\"syncRole\"][value=\"reader\"]').checked = true");
    await phone.click('[data-action="sync-connect"]');
    check('폰: 보기 기기로 연결해 받아옴', await phone.waitFor(`${text('#monthTotal')} === '52,400원'`), await phone.eval(text('#monthTotal')));
    check('폰: 잔액을 안 맞췄으면 "PC에서 적어 두면" 안내만', await phone.eval("!document.querySelector('#balanceHero') && !document.querySelector('[data-action=\"balance\"]')"));
    check('폰: 이 기기 데이터를 바꾸기 전에 확인을 받음', phone.dialogs.some((d) => d.includes('GitHub에 올라온 내용으로 바꿀까요')), phone.dialogs.join(' | '));
    const bar = await phone.eval(text('#syncbar'));
    check('폰: 상태 줄에 수정 시각과 받아온 시각', bar.includes('수정 ') && bar.includes('받아옴') && !bar.includes('수정 -'), bar);
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
    check('폰: 화면으로 돌아오면 새 값(62,400원)', await phone.waitFor(`${text('#monthTotal')} === '62,400원'`), await phone.eval(text('#monthTotal')));

    // ----- 잔액: PC에서 맞춘 뒤 적은 수입은 더하고 지출은 뺀다. 수입은 총 지출에 안 들어간다. 폰도 같은 값 -----
    // 오늘이 구독 결제일(3일)이면 이미 빠진 것으로 저장된다 → 어느 날 돌려도 100,000원에서 시작
    const today = `${ym}-${String(now.getDate()).padStart(2, '0')}`;
    await pc.tab('home');
    await pc.click('[data-action="balance"]');
    await pc.fill('#balForm [name="amount"]', '100,000');
    await pc.eval("document.querySelector('#balForm').requestSubmit()");
    check('잔액: 맞춘 값이 그대로 보임(100,000원)', await pc.waitFor(`${text('#balanceHero')} === '100,000원'`), await pc.eval(text('#balanceHero')));
    await pc.tab('spend');
    await pc.eval(`(() => { const f = document.querySelector('#quickAdd'); f.querySelector('input[name="kind"][value="in"]').checked = true; f.elements.date.value = '${today}'; f.elements.amount.value = '30,000'; f.elements.title.value = '용돈'; })()`);
    await pc.pressEnter('#quickAdd [name="title"]');
    check('수입: 추가하면 빠른 입력이 다시 "지출"로', await pc.eval("document.querySelector('#quickAdd input[name=\"kind\"][value=\"out\"]').checked"));
    check('수입: 내역에 "+30,000원"', (await pc.eval(text('#view-spend'))).includes('+30,000원'), await pc.eval(text('#view-spend')));
    await pc.fill('#quickAdd [name="amount"]', '5,000');
    await pc.fill('#quickAdd [name="title"]', '간식');
    await pc.pressEnter('#quickAdd [name="title"]');
    await pc.tab('home');
    check('잔액: 수입 +30,000 · 지출 -5,000 반영(125,000원)', (await pc.eval(text('#balanceHero'))) === '125,000원', await pc.eval(text('#view-home .card')));
    check('수입은 총 지출에 안 들어감(62,400 + 5,000 = 67,400원)', (await pc.eval(text('#monthTotal'))) === '67,400원', await pc.eval(text('#monthTotal')));
    check('PC: 잔액·수입 저장됨', await saved(), await pc.eval(text('#syncbar')));
    r = await remote();
    check('가짜 저장소: 수입 1건·잔액 100,000원', r.incomes.length === 1 && r.balance && r.balance.amount === 100000, JSON.stringify({ incomes: r.incomes, balance: r.balance }));
    await pc.shot('8-pc-home-balance');
    await phone.eval("document.dispatchEvent(new Event('visibilitychange'))");
    check('폰: 같은 잔액(125,000원)', await phone.waitFor(`${text('#balanceHero')} === '125,000원'`), await phone.eval(text('#view-home')));
    check('폰: "잔액 맞추기" 버튼 없음', await phone.eval("!document.querySelector('[data-action=\"balance\"]')"));
    await phone.shot('9-phone-home-balance');

    // ----- 일정: PC에서 그날 시트로 추가 → 폰 달력에 보이고, 폰에는 추가·수정 버튼이 없다. 돈 계산은 그대로 -----
    await pc.tab('calendar');
    await pc.click(`.cal-cell[data-date="${today}"]`);
    await pc.click('#sheetBody [data-action="add-event"]');
    check('일정: 그날 시트에서 열면 날짜가 그날', (await pc.eval("document.querySelector('#eventForm').elements.date.value")) === `${today}`);
    await pc.eval("(() => { const f = document.querySelector('#eventForm'); f.elements.time.value = '14:30'; f.elements.title.value = '<b>치과</b>'; f.requestSubmit(); })()");
    check('일정: 저장하면 그날 시트로 돌아와 목록에 보임(글자 그대로)', (await pc.eval(text('#sheetBody'))).includes('<b>치과</b>') && (await pc.eval(text('#sheetBody'))).includes('14:30'), await pc.eval(text('#sheetBody')));
    await pc.click('[data-action="close-sheet"]');
    check('일정: 달력 칸에 표시', await pc.eval(`!!document.querySelector('.cal-cell[data-date="${today}"] .chip.ev')`));
    check('PC: 일정 저장됨', await saved(), await pc.eval(text('#syncbar')));
    r = await remote();
    check('가짜 저장소: 일정 1건(시간 14:30)', r.version === 5 && r.events.length === 1 && r.events[0].time === '14:30', JSON.stringify(r.events));
    await pc.tab('home');
    check('일정은 돈 계산에 안 들어감(잔액 125,000원·총 지출 67,400원)', (await pc.eval(text('#balanceHero'))) === '125,000원' && (await pc.eval(text('#monthTotal'))) === '67,400원');
    await phone.tab('calendar');
    await phone.eval("document.dispatchEvent(new Event('visibilitychange'))");
    check('폰: 달력에 PC가 적은 일정', await phone.waitFor(`${text('#view-calendar')}.includes('<b>치과</b>')`), await phone.eval(text('#view-calendar')));
    check('폰: 일정 추가·수정 버튼 없음', await phone.eval("!document.querySelector('[data-action=\"add-event\"]') && !document.querySelector('[data-action=\"edit-event\"]')"));
    await phone.tab('home');
    const phoneUp = await phone.eval(text('#upcomingEvents'));
    check('폰: 홈 다가오는 일정에 PC가 적은 일정(오늘), 누를 수 없는 줄', phoneUp.includes('<b>치과</b>') && phoneUp.includes('오늘') && (await phone.eval("!document.querySelector('#upcomingEvents [data-action]')")), phoneUp);
    await phone.tab('calendar');
    await phone.click(`.cal-cell[data-date="${today}"]`);
    check('폰: 그날 시트에 일정은 보이고 추가 버튼은 없음', (await phone.eval(text('#sheetBody'))).includes('<b>치과</b>') && (await phone.eval("!document.querySelector('#sheetBody [data-action=\"add-event\"]')")));
    await phone.shot('9-phone-day-event');
    await phone.click('[data-action="close-sheet"]');
    check('폰: 달력 탭 가로 넘침 없음', await phone.eval(noOverflow));

    // ----- 옛 앱(수입·잔액을 모름)이 받아 저장해 둔 폰: 새 앱으로 열면 원격이 그대로여도 다시 받는다 -----
    await phone.eval(`new Promise((res, rej) => {
      const o = indexedDB.open('subcal', 1);
      o.onerror = () => rej(o.error);
      o.onsuccess = () => {
        const db = o.result;
        const tx = db.transaction('kv', 'readwrite');
        const store = tx.objectStore('kv');
        const g = store.get('state');
        g.onsuccess = () => { const s = g.result; delete s.incomes; delete s.balance; s.version = 2; store.put(s, 'state'); };
        tx.oncomplete = () => { db.close(); res(true); };
        tx.onerror = () => rej(tx.error);
      };
    })`);
    await phone.goto(`${G}#home`);
    check('폰: 옛 형식으로 저장돼 있으면 다시 받아와서 잔액이 보임', await phone.waitFor(`${text('#balanceHero')} === '125,000원'`), await phone.eval(text('#view-home')));

    // ----- 폰 오프라인: 다시 열어도 마지막 내용 + 경고 -----
    // 개발자 도구의 오프라인 흉내는 페이지(앱 파일)에만 걸리고 GitHub 요청에는 안 걸려서, 가짜 GitHub도 함께 끊는다
    for (let i = 0; i < 20 && !(await phone.eval('!!(navigator.serviceWorker && navigator.serviceWorker.controller)')); i++) await phone.goto(`${G}#home`);
    check('폰: 서비스 워커가 페이지를 맡음', await phone.eval('!!navigator.serviceWorker.controller'));
    await phone.offline(true);
    await fetch(`${BASE}/__gh/_down`, { method: 'POST', body: 'on' });
    await phone.goto(`${G}#home`);
    check('폰 오프라인: 마지막으로 받은 내용이 보임', (await phone.eval(text('#monthTotal'))) === '67,400원' && (await phone.eval(text('#balanceHero'))) === '125,000원', await phone.eval(text('#view-home')));
    check('폰 오프라인: "받아오지 못함" 경고', await phone.waitFor(`${text('#syncbar')}.includes('받아오지 못함')`), await phone.eval(text('#syncbar')));
    await phone.shot('10-phone-offline');
    await fetch(`${BASE}/__gh/_down`, { method: 'POST', body: 'off' });
    await phone.offline(false);

    // ----- 충돌: 기준본(마지막으로 맞춘 내용)이 없는 PC는 자동으로 합칠 수 없으니 묻는다 -----
    // 기준본을 지우고 GitHub이 끊긴 채로 다시 열어야 한다(열 때 원격 sha가 같으면 기준본을 다시 만든다)
    await fetch(`${BASE}/__gh/_down`, { method: 'POST', body: 'on' });
    await pc.eval(`new Promise((res, rej) => {
      const o = indexedDB.open('subcal', 1);
      o.onerror = () => rej(o.error);
      o.onsuccess = () => { const db = o.result; const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete('base'); tx.oncomplete = () => { db.close(); res(true); }; tx.onerror = () => rej(tx.error); };
    })`);
    await pc.goto(`${G}#spend`);
    await pc.fill('#quickAdd [name="amount"]', '1000');
    await pc.fill('#quickAdd [name="title"]', '커피');
    await pc.pressEnter('#quickAdd [name="title"]');
    const other = { version: 2, subs: [], expenses: [{ id: 'z', date: `${ym}-05`, amount: 777, title: '다른 기기', memo: '' }], settings: { lastBackupAt: null }, updatedAt: new Date().toISOString() };
    await fetch(`${BASE}/__gh/_file`, { method: 'POST', body: JSON.stringify(other) });
    await wait(1800); // 끊긴 사이 올리기는 실패한다
    await fetch(`${BASE}/__gh/_down`, { method: 'POST', body: 'off' });
    await pc.eval("document.dispatchEvent(new Event('visibilitychange'))");
    check('충돌(기준본 없음): 시트로 어느 쪽을 남길지 물음', await pc.waitFor(`!document.querySelector('#sheet').hidden && ${text('#sheetTitle')}.includes('달라요')`, 10000), await pc.eval(text('#syncbar')));
    await pc.shot('11-pc-conflict');
    await pc.click('[data-action="conflict-local"]');
    check('충돌: 이 기기 내용으로 덮어쓰면 저장됨', await saved());
    r = await remote();
    check(
      '충돌: GitHub 내용 = PC 내용(지출 5건·수입 1건·잔액, 다른 기기 내용 없음)',
      r.expenses.length === 5 && r.incomes.length === 1 && r.balance && !r.expenses.some((e) => e.amount === 777),
      JSON.stringify(r.expenses.map((e) => e.amount)),
    );

    // ----- 더 새 버전 앱이 올린 내용: 폰은 받지 않고 알린다(받으면 모르는 칸이 사라진다) -----
    // 먼저 폰이 PC 내용을 받아 두게 한다(오프라인이 풀릴 때 폰이 충돌 중간 내용을 받아 갔을 수 있다).
    // 충돌 점검에서 오늘 날짜로 커피 1,000원을 더 적었으니 잔액은 124,000원
    await phone.eval("document.dispatchEvent(new Event('visibilitychange'))");
    check('폰: 충돌 뒤 PC 내용을 받아 잔액 124,000원', await phone.waitFor(`${text('#balanceHero')} === '124,000원' && document.body.dataset.sync === 'ok'`), await phone.eval(text('#view-home')));
    // ----- 계산 탭: 날짜를 누르면 그날 남는 돈. 써 볼 지출은 저장하지 않고, "지출로 적기"를 누른 것만 저장한다 -----
    // 남은 구독은 매달 3일 14,900원뿐이고, 직접 적은 지출·수입은 모두 오늘까지라 내일 남는 돈은 3일 결제만 빠진다
    const tm = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const tmr = `${tm.getFullYear()}-${String(tm.getMonth() + 1).padStart(2, '0')}-${String(tm.getDate()).padStart(2, '0')}`;
    const won = (n) => `${n.toLocaleString('ko-KR')}원`;
    const tmrLeft = 124000 - (tm.getDate() === 3 ? 14900 : 0);
    const pickTomorrow = async (b) => {
      if (!(await b.eval(`!!document.querySelector('[data-action="plan-day"][data-date="${tmr}"]')`))) await b.click('[data-action="next-month"]');
      await b.click(`[data-action="plan-day"][data-date="${tmr}"]`);
    };
    await pc.tab('plan');
    check('계산: 처음엔 오늘 남는 돈 = 지금 잔액(124,000원)', (await pc.eval(text('#planResult'))) === '124,000원', await pc.eval(text('#view-plan')));
    await pickTomorrow(pc);
    check(`계산: 내일을 누르면 그날 남는 돈(${won(tmrLeft)})`, (await pc.eval(text('#planResult'))) === won(tmrLeft), await pc.eval(text('#view-plan .card')));
    await pc.eval(`(() => { const f = document.querySelector('#planAdd'); f.elements.date.value = '${tmr}'; f.elements.amount.value = '20,000'; f.elements.title.value = '여행'; })()`);
    await pc.pressEnter('#planAdd [name="title"]');
    check('계산: 써 볼 지출을 더하면 그만큼 줄어듦', (await pc.eval(text('#planResult'))) === won(tmrLeft - 20000), await pc.eval(text('#view-plan .card')));
    check('계산: 더한 뒤 금액 칸이 비고 초점이 감', await pc.eval("(() => { const f = document.querySelector('#planAdd'); return f.elements.amount.value === '' && document.activeElement === f.elements.amount; })()"));
    await wait(1800);
    check('계산: 써 볼 지출은 저장하지 않음', (await remote()).expenses.length === 5);
    await pc.shot('8-pc-plan');
    await pc.click('[data-action="plan-commit"]');
    check('계산: 지출로 적어도 그날 남는 돈은 그대로', (await pc.eval(text('#planResult'))) === won(tmrLeft - 20000) && !(await pc.eval("!!document.querySelector('[data-action=\"plan-commit\"]')")), await pc.eval(text('#view-plan')));
    let committed = false;
    for (let i = 0; i < 40 && !committed; i++, await wait(250)) committed = (await remote()).expenses.some((e) => e.date === tmr && e.amount === 20000 && e.title === '여행');
    check('계산: "지출로 적기"는 내역에 저장됨', committed);
    await phone.eval("document.dispatchEvent(new Event('visibilitychange'))");
    await phone.tab('plan');
    check('폰 계산: 오늘 남는 돈이 보임(124,000원)', await phone.waitFor(`${text('#planResult')} === '124,000원'`), await phone.eval(text('#view-plan')));
    await pickTomorrow(phone);
    check('폰 계산: PC에서 적은 내일 지출이 반영됨', await phone.waitFor(`${text('#planResult')} === '${won(tmrLeft - 20000)}'`), await phone.eval(text('#planResult')));
    await phone.fill('#planAdd [name="amount"]', '1,000');
    await phone.pressEnter('#planAdd [name="amount"]');
    check('폰 계산: 보기 기기도 써 볼 지출을 더할 수 있음', (await phone.eval(text('#planResult'))) === won(tmrLeft - 21000), await phone.eval(text('#planResult')));
    check('폰 계산: "지출로 적기" 없음', await phone.eval("!document.querySelector('[data-action=\"plan-commit\"]') && !!document.querySelector('[data-action=\"plan-remove\"]')"));
    check('폰 계산: 가로 넘침 없음', await phone.eval(noOverflow));
    await phone.shot('9-phone-plan');
    await phone.tab('home');

    const latest = await remote();
    await fetch(`${BASE}/__gh/_file`, { method: 'POST', body: JSON.stringify({ ...latest, version: 99 }) });
    await phone.eval("document.dispatchEvent(new Event('visibilitychange'))");
    check('새 버전 내용: 폰이 받지 않고 "새 버전" 경고', await phone.waitFor(`${text('#syncbar')}.includes('새 버전')`), await phone.eval(text('#syncbar')));
    check('새 버전 내용: 폰 화면은 마지막 내용 그대로', (await phone.eval(text('#balanceHero'))) === '124,000원', await phone.eval(text('#view-home')));

    // ----- 틀린 토큰 -----
    await phone.click('[data-action="settings"]');
    await phone.click('[data-action="sync-disconnect"]');
    await phone.click('[data-action="settings"]');
    await phone.fill('#syncToken', 'wrong-token');
    await phone.eval("document.querySelector('input[name=\"syncRole\"][value=\"reader\"]').checked = true");
    await phone.click('[data-action="sync-connect"]');
    check('틀린 토큰: "HTTP 401" 오류를 보여 줌', await phone.waitFor(`${text('#syncError')}.includes('401')`), await phone.eval(text('#syncError')));
    await phone.shot('12-phone-bad-token');

    // ----- PC·폰 둘 다 입력 기기: 따로 고친 내용은 묻지 않고 합쳐진다 -----
    await fetch(`${BASE}/__gh/_file`, { method: 'POST', body: JSON.stringify(latest) }); // 새 버전 흉내를 되돌린다
    await pc.eval("document.dispatchEvent(new Event('visibilitychange'))");
    await pc.waitFor("document.body.dataset.sync === 'ok'");
    phone.dialogs.length = 0;
    await phone.fill('#syncToken', 'test-rw');
    await phone.eval("document.querySelector('input[name=\"syncRole\"][value=\"writer\"]').checked = true");
    await phone.click('[data-action="sync-connect"]');
    check('폰(입력 기기로 다시 연결): 내용이 같으면 묻지 않고 맞춤', await phone.waitFor("document.body.dataset.sync === 'ok'") && (await phone.eval("document.querySelector('#sheet').hidden")), `${await phone.eval(text('#syncbar'))} | ${await phone.eval(text('#sheetTitle'))}`);
    const phoneSaved = () => phone.waitFor("document.body.dataset.sync === 'ok' && document.querySelector('#syncbar').innerText.includes('저장됨')", 10000);
    const addPhoneEvent = async (day, title) => {
      await phone.tab('calendar');
      await phone.click(`.cal-cell[data-date="${ym}-${day}"]`);
      await phone.click('#sheetBody [data-action="add-event"]');
      await phone.eval(`(() => { const f = document.querySelector('#eventForm'); f.elements.title.value = ${JSON.stringify(title)}; f.requestSubmit(); })()`);
      await phone.click('[data-action="close-sheet"]');
    };
    // 둘 다 GitHub이 끊긴 사이에 고친다 → PC가 먼저 올리고, 폰은 바뀐 GitHub과 자기 변경을 합쳐 올린다
    await fetch(`${BASE}/__gh/_down`, { method: 'POST', body: 'on' });
    await pc.tab('spend');
    await pc.fill('#quickAdd [name="amount"]', '1,111');
    await pc.fill('#quickAdd [name="title"]', 'PC 지출');
    await pc.pressEnter('#quickAdd [name="title"]');
    await addPhoneEvent('12', '폰 일정');
    await wait(1800);
    await fetch(`${BASE}/__gh/_down`, { method: 'POST', body: 'off' });
    await pc.eval("document.dispatchEvent(new Event('visibilitychange'))");
    check('두 입력 기기: PC 변경 저장됨', await saved(), await pc.eval(text('#syncbar')));
    await phone.eval("document.dispatchEvent(new Event('visibilitychange'))");
    check('두 입력 기기: 폰이 묻지 않고 합쳐서 저장', (await phoneSaved()) && (await phone.eval("document.querySelector('#sheet').hidden")), `${await phone.eval(text('#syncbar'))} | ${await phone.eval(text('#sheetTitle'))}`);
    r = await remote();
    check('두 입력 기기: GitHub에 PC 지출과 폰 일정이 모두 있음', r.expenses.some((e) => e.title === 'PC 지출') && r.events.some((e) => e.title === '폰 일정'), JSON.stringify({ ex: r.expenses.map((e) => e.title), ev: r.events.map((e) => e.title) }));
    check('두 입력 기기: 폰 화면에도 PC 지출', await phone.eval("(() => { location.hash = 'spend'; return true; })()") && (await phone.waitFor(`${text('#view-spend')}.includes('PC 지출')`)), await phone.eval(text('#view-spend')));
    await pc.eval("document.dispatchEvent(new Event('visibilitychange'))");
    await pc.tab('calendar');
    check('두 입력 기기: PC가 폰 일정을 받아옴', await pc.waitFor(`${text('#view-calendar')}.includes('폰 일정')`), await pc.eval(text('#view-calendar')));
    await phone.shot('13-phone-writer-spend');

    // 한쪽에서 지운 것은 다른 쪽이 따로 고친 게 있어도 되살아나지 않는다
    await fetch(`${BASE}/__gh/_down`, { method: 'POST', body: 'on' });
    await pc.tab('spend');
    await pc.eval("[...document.querySelectorAll('#view-spend [data-action=\"edit-exp\"]')].find((el) => el.innerText.includes('PC 지출')).click()");
    await pc.click('[data-action="exp-delete"]');
    await addPhoneEvent('13', '폰 일정 2');
    await wait(1800);
    await fetch(`${BASE}/__gh/_down`, { method: 'POST', body: 'off' });
    await pc.eval("document.dispatchEvent(new Event('visibilitychange'))");
    check('지우기: PC 저장됨', await saved(), await pc.eval(text('#syncbar')));
    await phone.eval("document.dispatchEvent(new Event('visibilitychange'))");
    check('지우기: 폰이 합쳐서 저장', await phoneSaved(), await phone.eval(text('#syncbar')));
    r = await remote();
    check('지우기: PC에서 지운 지출은 없고, 폰 일정 2개는 있음', !r.expenses.some((e) => e.title === 'PC 지출') && r.events.filter((e) => e.title.startsWith('폰 일정')).length === 2, JSON.stringify({ ex: r.expenses.map((e) => e.title), ev: r.events.map((e) => e.title) }));

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
