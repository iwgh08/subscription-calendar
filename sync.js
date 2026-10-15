/* PC ↔ 폰 연결: GitHub 비공개 저장소의 state.json 하나를 입력 기기(PC)가 쓰고, 보기 기기(폰)가 읽는다.
 * DOM을 쓰지 않는다. 브라우저: 전역 Sync / Node: require('./sync.js') — 테스트는 가짜 fetch를 넣는다.
 * GitHub 응답은 60초 동안 캐시되므로 항상 cache: 'no-store'로 요청한다(폰에 옛 내용이 보이지 않게).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const API = 'https://api.github.com';
  const FILE = 'state.json';

  // base64 ↔ 문자열. 한글이 깨지지 않게 UTF-8 바이트로 바꾼다. GitHub은 base64 중간에 줄바꿈을 넣어서 준다
  function utf8ToB64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64ToUtf8(b64) {
    const bin = atob(String(b64).replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // 'iwgh08/subscription-data' 또는 GitHub 주소 → '소유자/저장소' (알아볼 수 없으면 '')
  function normalizeRepo(input) {
    const s = String(input || '')
      .trim()
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '');
    return /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(s) ? s : '';
  }

  // 카톡 등에서 붙여 넣을 때 섞이는 공백·줄바꿈을 지운다
  const cleanToken = (t) => String(t || '').replace(/\s+/g, '');

  const MESSAGES = {
    0: '인터넷에 연결되지 않았어요',
    401: '토큰이 맞지 않거나 만료됐어요',
    403: '토큰 권한이 부족해요(읽기 전용 토큰이거나 요청 한도 초과)',
    404: '저장소를 찾을 수 없어요(저장소 이름과 토큰의 저장소 선택을 확인하세요)',
    409: '다른 곳에서 먼저 바뀌었어요',
    422: '다른 곳에서 먼저 바뀌었어요',
  };
  const CODES = { 0: 'offline', 401: 'auth', 403: 'forbidden', 404: 'notfound', 409: 'conflict', 422: 'conflict' };

  class SyncError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  const fail = (status) => new SyncError(status, CODES[status] || 'http', MESSAGES[status] || `GitHub 오류가 났어요`);

  // 화면에 보여 줄 오류 문구: "토큰이 맞지 않거나 만료됐어요 (HTTP 401)" / 오프라인이면 "인터넷에 연결되지 않았어요"
  const describe = (e) => {
    if (!e || e.status === undefined) return String((e && e.message) || e);
    return e.status ? `${e.message} (HTTP ${e.status})` : e.message;
  };

  function client({ repo, token, base, fetch: fetchFn }) {
    const f = fetchFn || ((...a) => fetch(...a));
    const root = (base || API).replace(/\/$/, '');
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };

    async function call(method, path, body) {
      let res;
      try {
        res = await f(`${root}${path}`, {
          method,
          headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
          body: body ? JSON.stringify(body) : undefined,
          cache: 'no-store',
        });
      } catch (e) {
        throw fail(0);
      }
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        data = null;
      }
      return { status: res.status, data };
    }

    return {
      // 연결 확인: 저장소에 접근할 수 있는지. 비공개 저장소는 권한이 없으면 404가 온다
      async checkRepo() {
        const r = await call('GET', `/repos/${repo}`);
        if (r.status !== 200 || !r.data) throw fail(r.status);
        return { private: !!r.data.private };
      },
      // 원격 state.json → { sha, state }, 아직 없으면 null
      async read() {
        const r = await call('GET', `/repos/${repo}/contents/${FILE}`);
        if (r.status === 404) return null;
        if (r.status !== 200 || !r.data) throw fail(r.status);
        if (typeof r.data.content !== 'string' || (!r.data.content && r.data.size > 0)) {
          throw new SyncError(200, 'too-large', '데이터가 너무 커서(1MB 넘음) GitHub에서 받을 수 없어요');
        }
        let state;
        try {
          state = JSON.parse(b64ToUtf8(r.data.content));
        } catch (e) {
          throw new SyncError(200, 'bad-data', '저장소의 state.json을 읽을 수 없어요');
        }
        return { sha: r.data.sha, state };
      },
      // 올리고 새 sha를 돌려준다. sha가 원격과 다르면 SyncError(code 'conflict')
      async write(state, sha) {
        const body = { message: `구독달력 데이터 ${new Date().toISOString()}`, content: utf8ToB64(JSON.stringify(state)) };
        if (sha) body.sha = sha;
        const r = await call('PUT', `/repos/${repo}/contents/${FILE}`, body);
        if ((r.status === 200 || r.status === 201) && r.data && r.data.content && r.data.content.sha) return r.data.content.sha;
        throw fail(r.status);
      },
    };
  }

  // 무엇을 할지 정한다: 'none' | 'push'(올리기) | 'pull'(받아오기) | 'conflict'(둘 다 바뀜) | 'missing'(원격에 아직 없음)
  //  보기 기기: 원격이 바뀌었으면 받아온다(보기 기기는 절대 올리지 않는다)
  //  입력 기기: 원격이 그대로면 바뀐 게 있을 때 올리고, 원격이 바뀌었으면 이 기기에 안 올린 변경이 없을 때만 받아온다
  function decideSync({ role, remoteSha, lastSha, dirty, localEmpty }) {
    if (role === 'reader') {
      if (!remoteSha) return 'missing';
      return remoteSha === lastSha ? 'none' : 'pull';
    }
    if (!remoteSha) return dirty || !localEmpty ? 'push' : 'none';
    if (remoteSha === lastSha) return dirty ? 'push' : 'none';
    if (localEmpty || !dirty) return 'pull';
    return 'conflict';
  }

  return { API, FILE, utf8ToB64, b64ToUtf8, normalizeRepo, cleanToken, SyncError, describe, client, decideSync };
});
