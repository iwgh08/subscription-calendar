// 개발용 로컬 서버(의존성 없음). Windows의 Python 서버는 .js MIME이 틀려 서비스 워커가 막힐 수 있어서 직접 만든다.
// 사용: npm start → http://localhost:8080/   (PORT 환경변수로 포트 변경)
//
// /__gh/... 는 테스트용 가짜 GitHub API다. 메모리에만 저장하고, 이 개발 서버에만 있다(배포되는 사이트에는 없다).
//   앱을 http://localhost:8080/?gh=/__gh 로 열면 GitHub 대신 여기에 연결한다.
//   토큰: test-rw(읽기·쓰기), test-ro(읽기 전용). 저장소: iwgh08/subscription-data
//   실제 GitHub처럼: base64에 줄바꿈 섞기, 생성 201·수정 200, sha 틀림 409, sha 없음 422, 권한 없음·파일 없음 404, 틀린 토큰 401
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.PORT) || 8080;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// ---------- 가짜 GitHub ----------
const MOCK_REPO = 'iwgh08/subscription-data';
const TOKENS = { 'test-rw': 'write', 'test-ro': 'read' };
const files = new Map(); // '소유자/저장소/경로' → { text, sha }
let down = false; // true면 GitHub에 닿지 않는 것처럼 연결을 끊는다(오프라인 흉내)
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const wrap64 = (s) => s.replace(/(.{60})/g, '$1\n');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

async function mockGitHub(req, res, p) {
  const sub = p.slice('/__gh'.length);
  // 테스트 도우미: 비우기 / 지금 내용 보기 / 다른 기기가 바꾼 것처럼 직접 바꾸기
  if (sub === '/_reset' && req.method === 'POST') {
    files.clear();
    down = false;
    return json(res, 200, { ok: true });
  }
  if (sub === '/_down' && req.method === 'POST') {
    down = (await readBody(req)) === 'on';
    return json(res, 200, { down });
  }
  if (down && !sub.startsWith('/_')) return req.socket.destroy();
  if (sub === '/_file') {
    const key = `${MOCK_REPO}/state.json`;
    if (req.method === 'GET') {
      const f = files.get(key);
      return f ? json(res, 200, { sha: f.sha, text: f.text }) : json(res, 404, { message: 'Not Found' });
    }
    if (req.method === 'POST') {
      const text = await readBody(req);
      files.set(key, { text, sha: sha1(text) });
      return json(res, 200, { ok: true });
    }
  }

  const auth = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const perm = auth && TOKENS[auth[1]];
  if (!perm) return json(res, 401, { message: 'Bad credentials' });

  let m = /^\/repos\/([^/]+\/[^/]+)$/.exec(sub);
  if (m && req.method === 'GET') return m[1] === MOCK_REPO ? json(res, 200, { full_name: m[1], private: true }) : json(res, 404, { message: 'Not Found' });

  m = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(sub);
  if (!m || m[1] !== MOCK_REPO) return json(res, 404, { message: 'Not Found' });
  const key = `${m[1]}/${m[2]}`;
  const file = files.get(key);
  if (req.method === 'GET') {
    if (!file) return json(res, 404, { message: 'Not Found' });
    return json(res, 200, { type: 'file', encoding: 'base64', size: Buffer.byteLength(file.text), sha: file.sha, content: wrap64(Buffer.from(file.text, 'utf8').toString('base64')) });
  }
  if (req.method === 'PUT') {
    if (perm !== 'write') return json(res, 403, { message: 'Resource not accessible by personal access token' });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      return json(res, 400, { message: 'Problems parsing JSON' });
    }
    if (!body.message || typeof body.content !== 'string') return json(res, 422, { message: 'Invalid request.' });
    if (file && !body.sha) return json(res, 422, { message: 'Invalid request. "sha" wasn\'t supplied.' });
    if (file && body.sha !== file.sha) return json(res, 409, { message: `${m[2]} does not match ${body.sha}` });
    if (!file && body.sha) return json(res, 422, { message: 'Invalid request. sha for a file that does not exist.' });
    const text = Buffer.from(body.content, 'base64').toString('utf8');
    const sha = sha1(`${text}|${Date.now()}`);
    files.set(key, { text, sha });
    return json(res, file ? 200 : 201, { content: { name: m[2], path: m[2], sha }, commit: { sha: sha1(sha) } });
  }
  return json(res, 405, { message: 'Method not allowed' });
}

// ---------- 정적 파일 ----------
http
  .createServer((req, res) => {
    let p;
    try {
      p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch (e) {
      res.writeHead(400);
      return res.end();
    }
    if (p === '/__gh' || p.startsWith('/__gh/')) {
      mockGitHub(req, res, p).catch((e) => json(res, 500, { message: String(e) }));
      return;
    }
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, p);
    const ext = path.extname(file).toLowerCase();
    // 프로젝트 밖 경로, 숨김 폴더(.git 등), 앱 파일이 아닌 형식은 내보내지 않는다
    if (!file.startsWith(root + path.sep) || /(^|[\\/])\./.test(path.relative(root, file)) || !types[ext]) {
      res.writeHead(404);
      return res.end('not found');
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': types[ext], 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  })
  .listen(port, '127.0.0.1', () => console.log(`구독달력: http://localhost:${port}/  (가짜 GitHub: /?gh=/__gh)`));
