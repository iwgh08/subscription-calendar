// PC ↔ 폰 연결(sync.js) 테스트: 가짜 fetch로 GitHub 요청·응답을 흉내 낸다
const test = require('node:test');
const assert = require('node:assert/strict');
const Sync = require('../sync.js');

// 가짜 fetch: 순서대로 응답을 돌려주고, 받은 요청을 기록한다
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return { status: r.status, json: async () => (r.body === undefined ? null : r.body) };
  };
  fn.calls = calls;
  return fn;
}
const cfg = (f) => ({ repo: 'iwgh08/subscription-data', token: 'tok', base: 'https://api.example', fetch: f });

test('base64 ↔ 한글 왕복, 줄바꿈이 섞인 base64도 읽는다', () => {
  const text = JSON.stringify({ name: '유튜브 프리미엄 🎵', amount: 14900 });
  const b64 = Sync.utf8ToB64(text);
  assert.equal(Sync.b64ToUtf8(b64), text);
  const wrapped = b64.replace(/(.{20})/g, '$1\n');
  assert.equal(Sync.b64ToUtf8(wrapped), text);
});

test('저장소 이름 정리와 토큰 공백 제거', () => {
  assert.equal(Sync.normalizeRepo(' iwgh08/subscription-data '), 'iwgh08/subscription-data');
  assert.equal(Sync.normalizeRepo('https://github.com/iwgh08/subscription-data.git'), 'iwgh08/subscription-data');
  assert.equal(Sync.normalizeRepo('subscription-data'), '');
  assert.equal(Sync.normalizeRepo('a/b/c'), '');
  assert.equal(Sync.cleanToken(' github_pat_abc\n123 \t'), 'github_pat_abc123');
});

test('무엇을 할지 정하기(decideSync)', () => {
  const d = (o) => Sync.decideSync({ role: 'writer', remoteSha: null, lastSha: null, dirty: false, localEmpty: false, ...o });
  // 보기 기기는 절대 올리지 않는다
  assert.equal(d({ role: 'reader' }), 'missing');
  assert.equal(d({ role: 'reader', remoteSha: 'a', lastSha: 'a', dirty: true }), 'none');
  assert.equal(d({ role: 'reader', remoteSha: 'b', lastSha: 'a', dirty: true }), 'pull');
  // 입력 기기
  assert.equal(d({ remoteSha: null }), 'push');
  assert.equal(d({ remoteSha: null, localEmpty: true }), 'none');
  assert.equal(d({ remoteSha: 'a', lastSha: 'a', dirty: true }), 'push');
  assert.equal(d({ remoteSha: 'a', lastSha: 'a', dirty: false }), 'none');
  assert.equal(d({ remoteSha: 'b', lastSha: 'a', dirty: false }), 'pull');
  assert.equal(d({ remoteSha: 'b', lastSha: 'a', dirty: true, localEmpty: true }), 'pull');
  assert.equal(d({ remoteSha: 'b', lastSha: 'a', dirty: true }), 'conflict');
  // 데이터가 있는 PC를 처음 연결(dirty로 시작)했는데 원격 파일이 이미 있으면 덮지 않고 충돌로 묻는다
  assert.equal(d({ remoteSha: 'b', lastSha: null, dirty: true }), 'conflict');
});

test('읽기: 토큰·캐시 끄기 헤더를 보내고 base64(줄바꿈 포함)를 풀어 준다', async () => {
  const state = { version: 2, subs: [{ id: 's1', name: '멜론' }], expenses: [] };
  const content = Sync.utf8ToB64(JSON.stringify(state)).replace(/(.{60})/g, '$1\n');
  const f = fakeFetch([{ status: 200, body: { sha: 'abc', content, encoding: 'base64', size: 10 } }]);
  const r = await Sync.client(cfg(f)).read();
  assert.deepEqual(r, { sha: 'abc', state });
  const call = f.calls[0];
  assert.equal(call.url, 'https://api.example/repos/iwgh08/subscription-data/contents/state.json');
  assert.equal(call.opts.method, 'GET');
  assert.equal(call.opts.headers.Authorization, 'Bearer tok');
  assert.equal(call.opts.cache, 'no-store');
});

test('읽기: 파일이 아직 없으면(404) null', async () => {
  const f = fakeFetch([{ status: 404, body: { message: 'Not Found' } }]);
  assert.equal(await Sync.client(cfg(f)).read(), null);
});

test('쓰기: sha를 붙여 PUT하고 새 sha를 돌려준다(새로 만들면 201, 고치면 200)', async () => {
  const f = fakeFetch([
    { status: 201, body: { content: { sha: 'new1' } } },
    { status: 200, body: { content: { sha: 'new2' } } },
  ]);
  const c = Sync.client(cfg(f));
  assert.equal(await c.write({ a: '한글' }, null), 'new1');
  assert.equal(await c.write({ a: '한글2' }, 'new1'), 'new2');
  assert.equal(f.calls[0].opts.method, 'PUT');
  assert.equal('sha' in f.calls[0].body, false);
  assert.equal(f.calls[1].body.sha, 'new1');
  assert.deepEqual(JSON.parse(Sync.b64ToUtf8(f.calls[1].body.content)), { a: '한글2' });
  assert.equal(f.calls[1].opts.headers['Content-Type'], 'application/json');
});

test('오류를 상태 번호와 알기 쉬운 문구로 바꾼다', async () => {
  const cases = [
    [401, 'auth'],
    [403, 'forbidden'],
    [404, 'notfound'],
    [409, 'conflict'],
    [422, 'conflict'],
    [500, 'http'],
  ];
  for (const [status, code] of cases) {
    const f = fakeFetch([{ status, body: { message: 'x' } }]);
    await assert.rejects(Sync.client(cfg(f)).write({}, 'old'), (e) => e.status === status && e.code === code);
  }
  const off = fakeFetch([new TypeError('Failed to fetch')]);
  await assert.rejects(Sync.client(cfg(off)).read(), (e) => e.status === 0 && e.code === 'offline');
  assert.equal(Sync.describe(new Sync.SyncError(401, 'auth', '토큰이 맞지 않거나 만료됐어요')), '토큰이 맞지 않거나 만료됐어요 (HTTP 401)');
  assert.equal(Sync.describe(new Sync.SyncError(0, 'offline', '인터넷에 연결되지 않았어요')), '인터넷에 연결되지 않았어요');
});

test('연결 확인: 비공개 여부를 알려 주고, 권한이 없으면 404 오류', async () => {
  const ok = fakeFetch([{ status: 200, body: { full_name: 'iwgh08/subscription-data', private: true } }]);
  assert.deepEqual(await Sync.client(cfg(ok)).checkRepo(), { private: true });
  assert.equal(ok.calls[0].url, 'https://api.example/repos/iwgh08/subscription-data');
  const no = fakeFetch([{ status: 404, body: { message: 'Not Found' } }]);
  await assert.rejects(Sync.client(cfg(no)).checkRepo(), (e) => e.code === 'notfound');
});

test('너무 큰 파일(내용이 비어서 옴)과 깨진 파일은 알기 쉬운 오류', async () => {
  const big = fakeFetch([{ status: 200, body: { sha: 'x', content: '', encoding: 'none', size: 2000000 } }]);
  await assert.rejects(Sync.client(cfg(big)).read(), (e) => e.code === 'too-large');
  const bad = fakeFetch([{ status: 200, body: { sha: 'x', content: Sync.utf8ToB64('{깨짐'), size: 5 } }]);
  await assert.rejects(Sync.client(cfg(bad)).read(), (e) => e.code === 'bad-data');
});
