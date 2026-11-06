// 아이폰 위젯(Scriptable) 스크립트: 가짜 Scriptable 전역으로 widget/subcal-widget.js를 그대로 돌려 본다
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Core = require('../core.js');
const { build, OUT } = require('../tools/make-widget.js');

const code = fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
const today = Core.todayStr();

const sampleState = (o = {}) => ({
  ...Core.emptyState(),
  events: [{ id: 'e1', date: today, time: '14:30', repeat: '', title: '치과', memo: '' }],
  balance: { amount: 123456, date: Core.addDays(today, -1), setAt: '', paidToday: true },
  updatedAt: new Date().toISOString(),
  ...o,
});
const contentOf = (state) => {
  const b64 = Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
  return b64.replace(/(.{60})/g, '$1\n'); // GitHub처럼 줄바꿈을 섞는다
};

// 가짜 Scriptable. reply: { status, body } 또는 'offline'. alerts: presentAlert가 돌려줄 [고른 번호, 입력값]
async function runWidget({ token = 'tok', reply, cache = null, runsInApp = false, alerts = [], family = 'medium' } = {}) {
  const texts = [];
  const keychain = new Map(token ? [['subcal-widget-token', token]] : []);
  const files = new Map(cache ? [['/docs/subcal-widget-cache.json', JSON.stringify(cache)]] : []);
  const requests = [];
  let widget = null;
  let presented = false;
  // 위젯 묶음 구조를 그대로 기록한다: { type: 'stack'|'text'|'spacer', children, layout, size, … }
  const container = (node) => ({
    addText(str) {
      const t = { type: 'text', text: String(str) };
      texts.push(t);
      node.children.push(t);
      return t;
    },
    addSpacer(len) {
      node.children.push({ type: 'spacer', len });
    },
    addStack() {
      const st = { type: 'stack', children: [], layout: 'h' };
      node.children.push(st);
      return Object.assign(st, container(st), {
        layoutHorizontally: () => (st.layout = 'h'),
        layoutVertically: () => (st.layout = 'v'),
        topAlignContent() {},
        centerAlignContent() {},
        bottomAlignContent() {},
        setPadding() {},
      });
    },
  });
  class ListWidget {
    constructor() {
      this.type = 'widget';
      this.children = [];
      Object.assign(this, container(this));
    }
    setPadding() {}
    async presentMedium() {
      presented = true;
    }
  }
  class Color {
    constructor(hex) {
      this.hex = hex;
    }
    static dynamic(a, b) {
      return { light: a, dark: b };
    }
  }
  const font = (kind) => (size) => `${kind}${size}`;
  class Request {
    constructor(url) {
      this.url = url;
      this.headers = {};
      requests.push(this);
    }
    async loadJSON() {
      if (reply === 'offline') throw new Error('The Internet connection appears to be offline.');
      this.response = { statusCode: reply.status };
      return reply.body;
    }
  }
  class Alert {
    constructor() {
      this.fields = [];
    }
    addSecureTextField() {}
    addAction() {}
    addCancelAction() {}
    async presentAlert() {
      const [pick, value] = alerts.shift() || [0, ''];
      this.value = value;
      return pick;
    }
    textFieldValue() {
      return this.value;
    }
  }
  class Size {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }
  }
  const sandbox = {
    console,
    Color,
    Size,
    ListWidget,
    Request,
    Alert,
    Font: { systemFont: font('r'), mediumSystemFont: font('m'), semiboldSystemFont: font('s'), boldSystemFont: font('b') },
    Keychain: {
      contains: (k) => keychain.has(k),
      get: (k) => keychain.get(k),
      set: (k, v) => keychain.set(k, v),
      remove: (k) => keychain.delete(k),
    },
    Data: { fromBase64String: (s) => ({ toRawString: () => Buffer.from(s, 'base64').toString('utf8') }) },
    FileManager: {
      local: () => ({
        documentsDirectory: () => '/docs',
        joinPath: (a, b) => `${a}/${b}`,
        fileExists: (p) => files.has(p),
        readString: (p) => files.get(p),
        writeString: (p, s) => files.set(p, s),
      }),
    },
    Script: {
      setWidget: (w) => (widget = w),
      complete() {},
    },
    config: { runsInWidget: !runsInApp, runsInApp, widgetFamily: family },
    module: { exports: {} }, // Scriptable에도 module 전역이 있다
  };
  await vm.runInNewContext(`(async () => {\n${code}\n})()`, sandbox);
  const all = texts.map((t) => t.text).join(' | ');
  return { all, widget, presented, keychain, files, requests };
}

test('위젯 파일이 core.js·widget-main.js로 다시 만든 것과 같다(바꾸면 node tools/make-widget.js)', () => {
  assert.equal(code, build());
});

test('위젯: 받아오면 잔액·이번 달 총 지출·오늘 일정·받은 시각, 캐시에 저장', async () => {
  const r = await runWidget({ reply: { status: 200, body: { content: contentOf(sampleState()), sha: 'x' } } });
  assert.ok(r.widget, '위젯을 그렸다');
  assert.match(r.all, /지금 통장 잔액 \| 123,456원/);
  assert.match(r.all, /월 총 지출 0원/);
  assert.match(r.all, /오늘 \| □ 치과 14:30/);
  assert.match(r.all, /받아옴 /);
  assert.doesNotMatch(r.all, /⚠/);
  assert.equal(r.requests[0].url, 'https://api.github.com/repos/iwgh08/subscription-data/contents/state.json');
  assert.equal(r.requests[0].headers.Authorization, 'Bearer tok');
  assert.equal(JSON.parse(r.files.get('/docs/subcal-widget-cache.json')).state.balance.amount, 123456);
  assert.equal(r.widget.url, 'https://iwgh08.github.io/subscription-calendar/');
});

// 위젯 구조 살펴보기: 달력 칸은 폭이 고정된 세로 묶음, 표시(점·네모)는 내용 없는 정사각형 묶음
const walk = (n, out = []) => {
  out.push(n);
  for (const c of n.children || []) walk(c, out);
  return out;
};
const dayCells = (w) => walk(w).filter((n) => n.type === 'stack' && n.layout === 'v' && n.size && n.size.width > 0);
const textsIn = (n) => walk(n).filter((x) => x.type === 'text').map((x) => x.text);
const marksIn = (n) => walk(n).filter((x) => x.type === 'stack' && x.size && x.size.width === x.size.height && !x.children.length);
const ok = (state) => ({ status: 200, body: { content: contentOf(state) } });
const ev = (date, title, time = '') => ({ id: `${date}-${title}`, date, time, repeat: '', title, memo: '' });
const monthWeeks = () => {
  const t = Core.parseYmd(today);
  return Core.calendarWeeks(t.y, t.m);
};

test('위젯: 큰 위젯은 잔액·총 지출 아래에 이번 달 달력(오늘 테두리, 일정 네모·구독 색 점·그날 구독료)', async () => {
  const day = Number(today.slice(8));
  const state = sampleState({ subs: [{ id: 's1', name: '넷플릭스', amount: 13500, cycle: 'monthly', day, color: 3 }] });
  const r = await runWidget({ family: 'large', reply: ok(state) });
  assert.match(r.all, /지금 통장 잔액 \| 109,956원/); // 오늘 결제는 바로 빠진다
  assert.match(r.all, /월 총 지출 \| 13,500원/);
  assert.match(r.all, /일 \| 월 \| 화 \| 수 \| 목 \| 금 \| 토/);
  assert.match(r.all, /받아옴 /);
  const weeks = monthWeeks();
  const cells = dayCells(r.widget);
  assert.equal(cells.length, weeks.length * 7);
  const cell = cells[weeks.flat().indexOf(today)];
  assert.deepEqual(textsIn(cell), [String(day), '13,500']);
  assert.equal(cell.borderColor.light.hex, '#2a78d6', '오늘 테두리');
  assert.ok(cell.backgroundColor, '표시가 있는 날은 배경');
  const marks = marksIn(cell);
  assert.equal(marks.length, 2);
  assert.ok(marks[0].borderWidth > 0 && !marks[0].backgroundColor, '일정이 먼저, 테두리 네모');
  assert.equal(marks[1].backgroundColor.light.hex, '#eda100', '구독은 고른 색(3번)의 점');
  const empty = cells.filter((c) => c !== cell && !c.children.length);
  assert.equal(empty.length, weeks.flat().filter((d) => !d).length, '앞뒤 빈칸은 비워 둔다');
  assert.ok(cells.filter((c) => c !== cell).every((c) => !c.borderColor), '테두리는 오늘만');
});

test('위젯: 한 칸에 표시가 넘치면 큰 위젯은 3개 + 남은 수, 중간 위젯은 3개까지만', async () => {
  const day = Number(today.slice(8));
  const subs = [0, 1, 2, 3, 4].map((i) => ({ id: `s${i}`, name: `구독${i}`, amount: 1000, cycle: 'monthly', day, color: i }));
  const state = sampleState({ subs, events: [] });
  const cellOf = (r) => dayCells(r.widget)[monthWeeks().flat().indexOf(today)];
  const large = cellOf(await runWidget({ family: 'large', reply: ok(state) }));
  assert.equal(marksIn(large).length, 3);
  assert.deepEqual(textsIn(large), [String(day), '+2', '5,000']);
  const medium = cellOf(await runWidget({ family: 'medium', reply: ok(state) }));
  assert.equal(marksIn(medium).length, 3);
  assert.deepEqual(textsIn(medium), [String(day)], '중간 위젯 칸에는 숫자만(금액·+N 없음)');
});

test('위젯: 중간 위젯은 왼쪽에 작은 달력, 오른쪽에 잔액·총 지출·다가오는 것 2개와 남은 수', async () => {
  const state = sampleState({ events: [ev(today, '치과', '14:30'), ev(Core.addDays(today, 1), 'A'), ev(Core.addDays(today, 2), 'B'), ev(Core.addDays(today, 3), 'C')] });
  const r = await runWidget({ family: 'medium', reply: ok(state) });
  assert.equal(dayCells(r.widget).length, monthWeeks().length * 7);
  assert.equal(dayCells(r.widget)[0].size.width, 20);
  assert.match(r.all, /지금 통장 잔액 \| 123,456원 \| \d+월 총 지출 0원 \| 오늘 \| □ 치과 14:30 \| 내일 \| □ A \| \+2개 더 \| 받아옴 /);
  assert.doesNotMatch(r.all, /□ B/);
});

test('위젯: 작은 위젯은 잔액·총 지출만(달력·목록 없음)', async () => {
  const r = await runWidget({ family: 'small', reply: ok(sampleState()) });
  assert.equal(dayCells(r.widget).length, 0);
  assert.match(r.all, /^지금 통장 잔액 \| 123,456원 \| \d+월 총 지출 0원 \| 받아옴 /);
  assert.doesNotMatch(r.all, /치과/);
});

test('위젯: 잠금 화면(accessory)에서는 잔액 한 줄만', async () => {
  const r = await runWidget({ family: 'accessoryRectangular', reply: { status: 200, body: { content: contentOf(sampleState()) } } });
  assert.equal(r.all, '잔액 123,456원');
});

test('위젯: 받지 못하면(401·오프라인) 마지막 내용과 경고', async () => {
  const cache = { state: sampleState({ balance: { amount: 5000, date: today, setAt: '', paidToday: true } }), fetchedAt: '2026-10-18T03:04:00.000Z' };
  for (const reply of [{ status: 401, body: { message: 'Bad credentials' } }, 'offline']) {
    const r = await runWidget({ reply, cache });
    assert.match(r.all, /5,000원/);
    assert.match(r.all, /⚠ 받아오지 못함/);
  }
  const none = await runWidget({ reply: 'offline' });
  assert.match(none.all, /받아오지 못했어요: 인터넷에 연결되지 않았어요/);
});

test('위젯: 토큰이 없으면 앱에서 넣으라고 안내하고, 앱에서 실행하면 물어서 보관함에 저장', async () => {
  const w = await runWidget({ token: null, reply: { status: 500 } });
  assert.match(w.all, /Scriptable 앱에서 이 스크립트를 한 번 실행해 토큰을 넣어 주세요/);
  assert.equal(w.requests.length, 0);
  const a = await runWidget({ token: null, runsInApp: true, alerts: [[0, ' tok-new \n']], reply: { status: 200, body: { content: contentOf(sampleState()) } } });
  assert.equal(a.keychain.get('subcal-widget-token'), 'tok-new');
  assert.equal(a.requests[0].headers.Authorization, 'Bearer tok-new');
  assert.equal(a.presented, true);
});

test('위젯: 앱이 더 새 버전으로 저장한 내용은 읽지 않고 알린다', async () => {
  const r = await runWidget({ reply: { status: 200, body: { content: contentOf({ ...sampleState(), version: 99 }) } } });
  assert.match(r.all, /위젯 스크립트를 새로 복사해 주세요/);
  assert.doesNotMatch(r.all, /123,456원/);
});
