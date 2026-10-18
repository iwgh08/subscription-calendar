// 아이폰 위젯 스크립트 만들기: core.js + widget/widget-main.js → widget/subcal-widget.js(Scriptable에 붙여 넣는 파일 하나)
// core.js나 widget-main.js를 바꾸면 실행한다: node tools/make-widget.js (npm test가 다시 만들었는지 확인한다)
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const OUT = path.join(root, 'widget', 'subcal-widget.js');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n').trimEnd();

function build() {
  return [
    '// Variables used by Scriptable.',
    '// These must be at the very top of the file. Do not edit.',
    '// icon-color: deep-blue; icon-glyph: calendar-alt;',
    '',
    '// 구독달력 위젯 — 이 파일 전체를 Scriptable의 새 스크립트에 붙여 넣으세요.',
    '// 자동으로 만든 파일이에요. 고칠 때는 widget/widget-main.js를 고치고 node tools/make-widget.js를 실행해요.',
    '',
    // Scriptable에도 module 전역이 있어서, core.js가 거기에 붙지 않게 따로 감싼다
    'const Core = (function () {',
    '  const module = { exports: {} };',
    read('core.js'),
    '  return module.exports;',
    '})();',
    '',
    read('widget/widget-main.js'),
    '',
  ].join('\n');
}

module.exports = { build, OUT };

if (require.main === module) {
  fs.writeFileSync(OUT, build());
  console.log(`만들었어요: ${path.relative(root, OUT)}`);
}
