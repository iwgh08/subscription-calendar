// ---------- 구독달력 위젯(Scriptable) ----------
// 이 위에 core.js가 그대로 들어가 있다(tools/make-widget.js가 이어 붙인다). 계산은 앱과 같은 Core 함수로 한다.
// GitHub 비공개 저장소의 state.json을 읽기 전용 토큰으로 받아서 지금 잔액·이번 달 총 지출·7일 안의 결제와 일정을 보여 준다.
// 중간·큰 위젯은 이번 달 달력(앱 달력 탭처럼 일정은 네모, 구독은 색 점)도 그린다.
// 토큰은 이 폰의 Scriptable 보관함(Keychain)에만 둔다. 실행 중에 다른 곳의 코드를 받아 돌리지 않는다.
const REPO = 'iwgh08/subscription-data';
const APP_URL = 'https://iwgh08.github.io/subscription-calendar/';
const TOKEN_KEY = 'subcal-widget-token';
const CACHE_FILE = 'subcal-widget-cache.json';
const REFRESH_MIN = 30; // 이만큼 뒤에 다시 그려 달라고 한다(실제 주기는 iOS가 정한다)

const color = (light, dark) => Color.dynamic(new Color(light), new Color(dark));
// 색은 앱 styles.css와 같다(라이트, 다크). 구독 색(CAT)은 --cat-0~7, 오늘 테두리는 --s1
const COLORS = {
  bg: color('#fcfcfb', '#1a1a19'),
  has: color('#f1f0ec', '#252523'),
  ink: color('#0b0b0b', '#f0efec'),
  ink2: color('#52514e', '#c3c2b7'),
  muted: color('#6e6c66', '#9a988f'),
  bad: color('#c23531', '#e66767'),
  soon: color('#1c5cab', '#6da7ec'),
  today: color('#2a78d6', '#3987e5'),
  sun: color('#c8352f', '#ef7d7d'),
  sat: color('#256abf', '#7fb2ef'),
};
const CAT = [
  ['#2a78d6', '#3987e5'],
  ['#eb6834', '#d95926'],
  ['#1baf7a', '#199e70'],
  ['#eda100', '#c98500'],
  ['#e87ba4', '#d55181'],
  ['#008300', '#008300'],
  ['#6250d6', '#9085e9'],
  ['#e34948', '#e66767'],
].map(([l, d]) => color(l, d));
// 구독의 color 값 → 팔레트 번호(app.js의 colorOf와 같다)
const colorOf = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? ((n % CAT.length) + CAT.length) % CAT.length : 0;
};
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

const comma = (n) => String(Math.round(Math.abs(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const won = (n) => `${Number(n) < 0 ? '-' : ''}${comma(n)}원`;
// 달력 칸용 짧은 금액(앱과 같다): 10만 아래는 그대로, 그 위는 '12만'
const cellAmount = (v) => (v < 1e5 ? comma(v) : v < 1e8 ? `${Math.round(v / 1e4)}만` : `${+(v / 1e8).toFixed(1)}억`);
const ddayText = (n) => (n === 0 ? '오늘' : n === 1 ? '내일' : `D-${n}`);
const pad2 = (n) => String(n).padStart(2, '0');
const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '-' : `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

// 토큰: 없으면 앱 안에서 실행할 때만 물어본다(위젯에서는 물어볼 수 없다)
async function askToken(message) {
  const a = new Alert();
  a.title = '구독달력 위젯';
  a.message = message;
  a.addSecureTextField('github_pat_로 시작해요', '');
  a.addAction('저장');
  a.addCancelAction('취소');
  if ((await a.presentAlert()) === -1) return null;
  const t = String(a.textFieldValue(0) || '').replace(/\s+/g, '');
  if (!t) return null;
  Keychain.set(TOKEN_KEY, t);
  return t;
}

async function getToken() {
  if (Keychain.contains(TOKEN_KEY)) return Keychain.get(TOKEN_KEY);
  if (!config.runsInApp) return null;
  return askToken('GitHub에서 만든 위젯용 읽기 전용 토큰(subscription-data, Contents Read-only)을 붙여 넣어 주세요. 이 폰의 Scriptable 보관함에만 저장돼요.');
}

class FetchError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function fetchState(token) {
  const req = new Request(`https://api.github.com/repos/${REPO}/contents/state.json`);
  req.headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  let data;
  try {
    data = await req.loadJSON();
  } catch (e) {
    throw new FetchError(0, '인터넷에 연결되지 않았어요');
  }
  const status = req.response ? req.response.statusCode : 0;
  if (status === 401) throw new FetchError(401, '토큰이 맞지 않거나 만료됐어요 (HTTP 401)');
  if (status === 404) throw new FetchError(404, '저장소나 파일을 찾을 수 없어요 (HTTP 404)');
  if (status !== 200 || !data || typeof data.content !== 'string') throw new FetchError(status, `GitHub 오류 (HTTP ${status})`);
  if (!data.content && data.size > 0) throw new FetchError(200, '데이터가 너무 커서 받을 수 없어요');
  const state = JSON.parse(Data.fromBase64String(data.content.replace(/\s+/g, '')).toRawString());
  if (Core.isNewerState(state)) throw new FetchError(200, '앱이 더 새 버전으로 저장했어요. 위젯 스크립트를 새로 복사해 주세요');
  return state;
}

// 마지막으로 받은 내용: 받지 못했을 때 경고와 함께 보여 준다(옛 데이터를 조용히 보여 주지 않는다)
const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), CACHE_FILE);
function readCache() {
  try {
    return fm.fileExists(cachePath) ? JSON.parse(fm.readString(cachePath)) : null;
  } catch (e) {
    return null;
  }
}

function addLine(parent, str, font, textColor, opts = {}) {
  const t = parent.addText(str);
  t.font = font;
  t.textColor = textColor;
  t.lineLimit = opts.lines || 1;
  if (opts.scale) t.minimumScaleFactor = opts.scale;
  return t;
}

// 가로 줄 하나. align: 'center'(양쪽에 늘어나는 빈칸, 끝나면 endRow) | 'right'(왼쪽에만) | 'left'
function addRow(parent, align = 'left', height = 0) {
  const r = parent.addStack();
  r.layoutHorizontally();
  r.centerAlignContent();
  if (height) r.size = new Size(0, height);
  if (align !== 'left') r.addSpacer();
  return r;
}
const endRow = (r, align) => {
  if (align !== 'right') r.addSpacer();
};

function addFooter(parent, view, size) {
  if (view.error) addLine(parent, `⚠ 받아오지 못함 · ${when(view.fetchedAt)}`, Font.mediumSystemFont(size), COLORS.bad, { scale: 0.7 });
  else addLine(parent, `받아옴 ${when(view.fetchedAt)}`, Font.systemFont(size), COLORS.muted, { scale: 0.7 });
}

function addBalance(parent, s, size) {
  if (s.balance === null) addLine(parent, '잔액 안 맞춤', Font.semiboldSystemFont(Math.round(size * 0.75)), COLORS.muted, { scale: 0.6 });
  else addLine(parent, won(s.balance), Font.boldSystemFont(size), s.balance < 0 ? COLORS.bad : COLORS.ink, { scale: 0.5 });
}

// 다가오는 결제·일정 한 줄: D-day, 이름(일정은 □), 구독이면 금액
function addItem(parent, it, size) {
  const row = addRow(parent);
  addLine(row, ddayText(it.dday), Font.semiboldSystemFont(size), it.dday <= 1 ? COLORS.soon : COLORS.ink2);
  row.addSpacer(Math.round(size * 0.6));
  const label = it.kind === 'event' && it.time ? `${it.title} ${it.time}` : it.title;
  addLine(row, it.kind === 'event' ? `□ ${label}` : label, Font.systemFont(size + 1), COLORS.ink);
  row.addSpacer();
  if (it.kind === 'sub') addLine(row, `-${won(it.amount)}`, Font.mediumSystemFont(size), COLORS.ink2, { scale: 0.8 });
}

// 표시 하나: 일정(cat이 null)은 테두리 네모, 구독은 그 구독 색(cat = 팔레트 번호)의 점. 앱 달력과 같은 모양
function addMark(parent, cat, size) {
  const m = parent.addStack();
  m.size = new Size(size, size);
  if (cat === null) {
    m.borderWidth = size >= 6 ? 1.5 : 1;
    m.borderColor = COLORS.ink2;
    m.cornerRadius = Math.max(1, size / 4);
  } else {
    m.backgroundColor = CAT[cat];
    m.cornerRadius = size / 2;
  }
}

// 달력 칸 하나. 폭은 고정, 높이는 위아래 빈칸이 늘어나 위젯 높이를 주별로 나눠 채운다(폰마다 위젯 크기가 달라서).
// 날짜 숫자, 표시 줄, (큰 위젯이면) 그날 구독료. 줄 높이를 고정해서 숫자 위치가 칸마다 같다
function addDay(row, cell, col, today, o) {
  const c = row.addStack();
  c.size = new Size(o.cw, 0);
  c.layoutVertically();
  c.cornerRadius = o.radius;
  if (!cell) return;
  const marks = [...Array(cell.events).fill(null), ...cell.colors.map(colorOf)]; // 일정을 먼저, 그다음 구독(앱과 같은 순서)
  if (marks.length) c.backgroundColor = COLORS.has;
  if (cell.date === today) {
    c.borderWidth = o.ring;
    c.borderColor = COLORS.today;
  }
  c.addSpacer();
  const n = addRow(c, 'center');
  addLine(n, String(cell.day), cell.date === today ? Font.boldSystemFont(o.num) : Font.semiboldSystemFont(o.num), col === 0 ? COLORS.sun : col === 6 ? COLORS.sat : COLORS.ink);
  endRow(n, 'center');
  c.addSpacer(o.gap);
  const m = addRow(c, 'center', o.mark);
  m.spacing = o.markGap;
  // 칸이 좁아서 o.marks개까지. 넘치면 큰 위젯은 하나를 줄이고 +N, 중간 위젯은 +N 글자가 들어갈 자리가 없어서 그냥 자른다
  const shown = marks.length <= o.marks ? marks : marks.slice(0, o.more ? o.marks - 1 : o.marks);
  for (const k of shown) addMark(m, k, o.mark);
  if (o.more && shown.length < marks.length) addLine(m, `+${marks.length - shown.length}`, Font.semiboldSystemFont(o.mark + 2), COLORS.ink2);
  endRow(m, 'center');
  if (o.amount) {
    c.addSpacer(o.gap);
    const a = addRow(c, 'center', o.amount + 2);
    if (cell.amount) addLine(a, cellAmount(cell.amount), Font.mediumSystemFont(o.amount), COLORS.ink2, { scale: 0.7 });
    endRow(a, 'center');
  }
  c.addSpacer();
}

// 이번 달 달력. 칸 폭은 고정이고, o.colGap이 없으면 칸 사이 빈칸이 늘어나 위젯 폭을 채운다
function addCalendar(parent, s, o) {
  const grid = parent.addStack();
  grid.layoutVertically();
  const gapCol = (r) => (o.colGap ? r.addSpacer(o.colGap) : r.addSpacer());
  const head = addRow(grid);
  WEEK.forEach((name, i) => {
    if (i) gapCol(head);
    const h = head.addStack();
    h.size = new Size(o.cw, 0);
    h.addSpacer();
    addLine(h, name, Font.mediumSystemFont(o.head), i === 0 ? COLORS.sun : i === 6 ? COLORS.sat : COLORS.ink2);
    h.addSpacer();
  });
  for (const week of s.weeks) {
    grid.addSpacer(o.rowGap);
    const r = addRow(grid);
    week.forEach((cell, i) => {
      if (i) gapCol(r);
      addDay(r, cell, i, s.today, o);
    });
  }
}

// 큰 위젯: 위에 잔액·이번 달 총 지출, 아래에 이번 달 달력(칸마다 일정 네모·구독 색 점·그날 구독료)
function buildLarge(w, s, view) {
  w.setPadding(12, 14, 10, 14);
  const top = addRow(w);
  top.topAlignContent();
  const left = top.addStack();
  left.layoutVertically();
  addLine(left, '지금 통장 잔액', Font.mediumSystemFont(11), COLORS.ink2);
  addBalance(left, s, 22);
  top.addSpacer();
  const right = top.addStack();
  right.layoutVertically();
  const r1 = addRow(right, 'right');
  addLine(r1, `${s.month}월 총 지출`, Font.mediumSystemFont(11), COLORS.ink2);
  const r2 = addRow(right, 'right');
  addLine(r2, won(s.monthTotal), Font.semiboldSystemFont(15), COLORS.ink, { scale: 0.6 });
  w.addSpacer(6);
  // 여백은 6주짜리 달이 가장 작은 큰 위젯(아이폰 SE, 321×324pt)에도 들어가게 잡았다
  addCalendar(w, s, { cw: 38, radius: 8, ring: 1.5, num: 12, head: 10, mark: 6, markGap: 2, marks: 4, more: true, gap: 2, amount: 8.5, rowGap: 2 });
  w.addSpacer(4);
  addFooter(w, view, 9.5);
}

// 중간 위젯: 왼쪽에 작은 달력(숫자·표시만), 오른쪽에 잔액·총 지출·다가오는 결제와 일정 2개
function buildMedium(w, s, view) {
  w.setPadding(10, 12, 10, 12);
  const body = w.addStack();
  body.layoutHorizontally();
  body.topAlignContent();
  addCalendar(body, s, { cw: 20, radius: 5, ring: 1.2, num: 10.5, head: 9, mark: 4, markGap: 1.5, marks: 3, more: false, gap: 1, amount: 0, rowGap: 1, colGap: 2 });
  body.addSpacer(10);
  const side = body.addStack();
  side.layoutVertically();
  addLine(side, '지금 통장 잔액', Font.mediumSystemFont(10.5), COLORS.ink2);
  addBalance(side, s, 19);
  side.addSpacer(2);
  addLine(side, `${s.month}월 총 지출 ${won(s.monthTotal)}`, Font.systemFont(10.5), COLORS.ink2, { scale: 0.7 });
  side.addSpacer(6);
  if (!s.items.length) addLine(side, '7일 안에 결제·일정이 없어요', Font.systemFont(10.5), COLORS.muted, { lines: 2, scale: 0.8 });
  const rows = s.items.slice(0, 2);
  for (const it of rows) {
    addItem(side, it, 10.5);
    side.addSpacer(2);
  }
  const hidden = s.more + (s.items.length - rows.length);
  if (hidden > 0) addLine(side, `+${hidden}개 더`, Font.systemFont(10), COLORS.muted);
  side.addSpacer();
  addFooter(side, view, 9);
}

// 작은 위젯: 잔액과 이번 달 총 지출
function buildSmall(w, s, view) {
  addLine(w, '지금 통장 잔액', Font.mediumSystemFont(12), COLORS.ink2);
  addBalance(w, s, 22);
  w.addSpacer(4);
  addLine(w, `${s.month}월 총 지출 ${won(s.monthTotal)}`, Font.systemFont(12), COLORS.ink2, { scale: 0.7 });
  w.addSpacer();
  addFooter(w, view, 10);
}

// view: { notice } 또는 { summary, fetchedAt, error }
function buildWidget(view) {
  const family = config.widgetFamily || 'medium';
  const w = new ListWidget();
  w.backgroundColor = COLORS.bg;
  w.setPadding(14, 16, 12, 16);
  w.url = APP_URL;
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MIN * 60 * 1000);

  if (view.notice) {
    addLine(w, '구독달력', Font.semiboldSystemFont(13), COLORS.ink2);
    w.addSpacer(6);
    addLine(w, view.notice, Font.systemFont(13), COLORS.ink, { lines: 5, scale: 0.8 });
    return w;
  }

  const s = view.summary;
  // 잠금 화면 위젯(accessory…)은 작아서 잔액 한 줄만
  if (family.startsWith('accessory')) {
    addLine(w, s.balance === null ? '잔액 안 맞춤' : `잔액 ${won(s.balance)}`, Font.semiboldSystemFont(13), COLORS.ink, { scale: 0.6 });
    if (view.error) addLine(w, '⚠ 받아오지 못함', Font.systemFont(10), COLORS.bad);
    return w;
  }
  if (family === 'small') buildSmall(w, s, view);
  else if (family === 'medium') buildMedium(w, s, view);
  else buildLarge(w, s, view); // large, extraLarge(아이패드)
  return w;
}

async function run() {
  let token = await getToken();
  let view;
  if (!token) view = { notice: 'Scriptable 앱에서 이 스크립트를 한 번 실행해 토큰을 넣어 주세요.' };
  else {
    let state = null;
    let fetchedAt = null;
    let error = null;
    try {
      state = await fetchState(token);
      fetchedAt = new Date().toISOString();
      fm.writeString(cachePath, JSON.stringify({ state, fetchedAt }));
    } catch (e) {
      // 앱 안에서 실행했는데 토큰이 틀렸으면 다시 넣게 한다
      if (e.status === 401 && config.runsInApp) {
        Keychain.remove(TOKEN_KEY);
        token = await askToken('토큰이 맞지 않거나 만료됐어요. 새 읽기 전용 토큰을 붙여 넣어 주세요.');
        if (token) return run();
      }
      error = e.message || String(e);
      const c = readCache();
      if (c && c.state) {
        state = c.state;
        fetchedAt = c.fetchedAt;
      }
    }
    view = state ? { summary: Core.widgetSummary(state, Core.todayStr()), fetchedAt, error } : { notice: `받아오지 못했어요: ${error}` };
  }
  const w = buildWidget(view);
  if (config.runsInWidget) Script.setWidget(w);
  else if (config.runsInApp) {
    if (view.error) {
      const a = new Alert();
      a.title = '받아오지 못했어요';
      a.message = `${view.error}\n마지막으로 받은 내용을 보여 줘요.`;
      a.addAction('확인');
      await a.presentAlert();
    }
    await w.presentMedium();
  }
  Script.complete();
}

await run();
