// icons/icon.svg → PNG(180·192·512)를 헤드리스 Edge로 캡처한다. 아이콘을 바꿨을 때만 실행: node tools/make-icons.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const root = path.resolve(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'icons', 'icon.svg'), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subcal-icons-'));

for (const size of [180, 192, 512]) {
  const html = path.join(tmp, `icon-${size}.html`);
  const sized = svg.replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `);
  fs.writeFileSync(html, `<!doctype html><html><body style="margin:0;overflow:hidden">${sized}</body></html>`);
  const out = path.join(root, 'icons', `icon-${size}.png`);
  execFileSync(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--user-data-dir=${path.join(tmp, 'profile')}`,
      `--window-size=${size},${size}`,
      `--screenshot=${out}`,
      `file:///${html.replace(/\\/g, '/')}`,
    ],
    { stdio: 'ignore' },
  );
  const png = fs.readFileSync(out);
  console.log(`icon-${size}.png ${png.readUInt32BE(16)}x${png.readUInt32BE(20)} (${png.length} bytes)`);
}
fs.rmSync(tmp, { recursive: true, force: true });
