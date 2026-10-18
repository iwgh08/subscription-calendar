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
  const container = () => ({
    addText(str) {
      const t = { text: String(str) };
      texts.push(t);
      return t;
    },
    addSpacer() {},
    addStack() {
      return { ...container(), layoutHorizontally() {}, centerAlignContent() {} };
    },
  });
  class ListWidget {
    constructor() {
      Object.assign(this, container());
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
  const sandbox = {
    console,
    Color,
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
