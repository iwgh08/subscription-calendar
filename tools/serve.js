// 개발용 로컬 서버(의존성 없음). Windows의 Python 서버는 .js MIME이 틀려 서비스 워커가 막힐 수 있어서 직접 만든다.
// 사용: npm start → http://localhost:8080/   (PORT 환경변수로 포트 변경)
const http = require('http');
const fs = require('fs');
const path = require('path');

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

http
  .createServer((req, res) => {
    let p;
    try {
      p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch (e) {
      res.writeHead(400);
      return res.end();
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
  .listen(port, '127.0.0.1', () => console.log(`구독달력: http://localhost:${port}/`));
