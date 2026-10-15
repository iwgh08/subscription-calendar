// 화면 확인용: 헤드리스 Edge로 로컬 서버(npm start)의 앱을 캡처한다.
//   node tools/shot.js "/?demo=1#calendar" out.png [폭=390] [높이=844] [light|dark]
//   node tools/shot.js --dom "/?demo=1"        → 그려진 HTML을 출력(오류 확인용)
// - 헤드리스 Edge는 창 폭을 약 500px보다 좁게 만들지 못해서, 앱을 정확한 크기의 iframe에 넣어 찍는다.
// - 매번 새 사용자 프로필을 써서 서비스 워커가 캐시한 옛 파일이 찍히지 않게 한다.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const args = process.argv.slice(2);
const dom = args[0] === '--dom';
if (dom) args.shift();
const [urlPath = '/?demo=1', out = 'shot.png', w = '390', h = '844', theme = ''] = args;
const url = `http://localhost:${process.env.PORT || 8080}${urlPath}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subcal-shot-'));
const flags = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', `--user-data-dir=${path.join(tmp, 'profile')}`, '--virtual-time-budget=5000'];
if (theme === 'dark') flags.push('--force-dark-mode', '--blink-settings=preferredColorScheme=0');
if (theme === 'light') flags.push('--blink-settings=preferredColorScheme=1');
try {
  if (dom) {
    process.stdout.write(execFileSync(EDGE, [...flags, '--dump-dom', url], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } else {
    const frame = path.join(tmp, 'frame.html');
    fs.writeFileSync(frame, `<!doctype html><html><body style="margin:0;overflow:hidden"><iframe src="${url}" width="${w}" height="${h}" style="border:0;display:block"></iframe></body></html>`);
    execFileSync(EDGE, [...flags, `--window-size=${w},${h}`, `--screenshot=${path.resolve(out)}`, `file:///${frame.replace(/\\/g, '/')}`], { stdio: 'ignore' });
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
