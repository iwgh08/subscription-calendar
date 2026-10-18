// ---------- 구독달력 위젯(Scriptable) ----------
// 이 위에 core.js가 그대로 들어가 있다(tools/make-widget.js가 이어 붙인다). 계산은 앱과 같은 Core 함수로 한다.
// GitHub 비공개 저장소의 state.json을 읽기 전용 토큰으로 받아서 지금 잔액·이번 달 총 지출·7일 안의 결제와 일정을 보여 준다.
// 토큰은 이 폰의 Scriptable 보관함(Keychain)에만 둔다. 실행 중에 다른 곳의 코드를 받아 돌리지 않는다.
const REPO = 'iwgh08/subscription-data';
const APP_URL = 'https://iwgh08.github.io/subscription-calendar/';
const TOKEN_KEY = 'subcal-widget-token';
const CACHE_FILE = 'subcal-widget-cache.json';
const REFRESH_MIN = 30; // 이만큼 뒤에 다시 그려 달라고 한다(실제 주기는 iOS가 정한다)

const color = (light, dark) => Color.dynamic(new Color(light), new Color(dark));
const COLORS = {
  bg: color('#fcfcfb', '#1a1a19'),
  ink: color('#0b0b0b', '#f0efec'),
  ink2: color('#52514e', '#c3c2b7'),
  muted: color('#6e6c66', '#9a988f'),
  bad: color('#c23531', '#e66767'),
  soon: color('#1c5cab', '#6da7ec'),
};

const comma = (n) => String(Math.round(Math.abs(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const won = (n) => `${Number(n) < 0 ? '-' : ''}${comma(n)}원`;
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
  addLine(w, '지금 통장 잔액', Font.mediumSystemFont(12), COLORS.ink2);
  if (s.balance === null) addLine(w, '잔액 안 맞춤', Font.semiboldSystemFont(18), COLORS.muted, { scale: 0.6 });
  else addLine(w, won(s.balance), Font.boldSystemFont(family === 'small' ? 22 : 26), s.balance < 0 ? COLORS.bad : COLORS.ink, { scale: 0.5 });
  w.addSpacer(4);
  addLine(w, `${s.month}월 총 지출 ${won(s.monthTotal)}`, Font.systemFont(12), COLORS.ink2, { scale: 0.7 });

  if (family !== 'small') {
    w.addSpacer(8);
    if (!s.items.length) addLine(w, '7일 안에 결제·일정이 없어요', Font.systemFont(12), COLORS.muted);
    const rows = family === 'large' ? s.items : s.items.slice(0, 3);
    for (const it of rows) {
      const row = w.addStack();
      row.layoutHorizontally();
      row.centerAlignContent();
      const d = row.addText(ddayText(it.dday));
      d.font = Font.semiboldSystemFont(12);
      d.textColor = it.dday <= 1 ? COLORS.soon : COLORS.ink2;
      row.addSpacer(8);
      const label = it.kind === 'event' && it.time ? `${it.title} ${it.time}` : it.title;
      const t = row.addText(it.kind === 'event' ? `□ ${label}` : label);
      t.font = Font.systemFont(13);
      t.textColor = COLORS.ink;
      t.lineLimit = 1;
      row.addSpacer();
      if (it.kind === 'sub') {
        const a = row.addText(`-${won(it.amount)}`);
        a.font = Font.mediumSystemFont(12);
        a.textColor = COLORS.ink2;
      }
      w.addSpacer(3);
    }
    const hidden = s.more + (s.items.length - rows.length);
    if (hidden > 0) addLine(w, `+${hidden}개 더`, Font.systemFont(11), COLORS.muted);
  }

  w.addSpacer();
  if (view.error) addLine(w, `⚠ 받아오지 못함 · ${when(view.fetchedAt)}`, Font.mediumSystemFont(10), COLORS.bad, { scale: 0.7 });
  else addLine(w, `받아옴 ${when(view.fetchedAt)}`, Font.systemFont(10), COLORS.muted);
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
