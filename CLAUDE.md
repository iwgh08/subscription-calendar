# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트

아이폰 홈 화면에 설치해서 쓰는 개인용 PWA "구독달력"이다. **사용자 혼자 쓴다**(공유·다른 은행·온보딩 같은 다른 사람용 기능은 넣지 않는다). 설명·UI 문구·주석은 한국어, 식별자는 영어로 쓴다.

- 정기 구독은 사용자가 직접 등록한 목록이 기준이다. 달력과 구독료 합계는 이 목록의 결제일로 계산한다.
- 한 달 총 지출은 신한은행 PC 인터넷뱅킹에서 받은 거래내역 파일(엑셀/텍스트)의 출금 합계다. 은행 자동 연동은 개인 앱이라 불가능하다.
- 구독은 네이버페이(신한 체크카드 등록)로 결제한다. 통장에는 결제 금액이 그대로 찍히지만 이름은 '네이버페이'처럼 일반적으로만 찍힌다. 그래서 구독과 통장 거래는 **통장 표시 이름(`matchKey`) + 금액 ±10% + 날짜 ±3일**로 맞춘다.
- 서버·로그인이 없다. 데이터는 휴대폰 IndexedDB(`subcal` DB, `kv` 저장소, `state` 레코드 하나)에만 있고 JSON 백업 파일로 옮긴다. 빌드 과정이 없고, 외부 요청은 CSP로 막는다.

## 명령어

- `npm test`: `tests/*.test.js`를 `node --test`로 돌린다. 핵심 로직(`core.test.js`)과 파일 불러오기(`import.test.js`, SheetJS로 가짜 xls/xlsx를 만들어 왕복)를 확인한다.
- `npm start`: http://localhost:8080 개발 서버(`tools/serve.js`, 의존성 없음). Windows의 Python 서버는 `.js` MIME이 틀려 서비스 워커가 막힐 수 있어서 직접 만들었다. 앱 파일 확장자만 내보내고 `.git` 같은 숨김 경로는 막는다.
- `node tools/ui-check.js <폴더>`: `npm start`를 켠 상태에서 헤드리스 Edge를 DevTools 프로토콜로 조종한다. 390×844 모바일 에뮬레이션으로 탭·시트를 캡처하고, 가짜 신한 엑셀로 불러오기 → 저장 유지 → 결제 확인(✓) → 오프라인 열기 → 콘솔 오류를 점검한다(PASS/FAIL 출력). 화면이나 불러오기를 바꾸면 돌린다.
- `node tools/shot.js "/?demo=1#calendar" out.png [폭] [높이] [light|dark]`: 화면 한 장 캡처. 헤드리스 Edge는 창 폭이 약 500px 아래로 줄지 않아서 앱을 정확한 크기의 iframe에 넣어 찍는다. 그냥 `--window-size=390`으로 찍으면 오른쪽이 잘린 것처럼 보인다(앱 문제가 아님).
- `node tools/make-icons.js`: `icons/icon.svg` → PNG 180/192/512 (헤드리스 Edge 캡처).
- PowerShell에서 `npm`이 실행 정책으로 막히면 `npm.cmd`를 쓴다. 캡처·임시 파일은 스크래치패드나 OS 임시 폴더에 둔다.

## 구조

**`core.js` — 순수 로직(UMD).** DOM을 쓰면 안 된다(Node 테스트가 그대로 `require`한다). 날짜는 `'YYYY-MM-DD'` 문자열이고 계산은 UTC 일수로 한다.
- `chargeDate`: 29~31일 결제는 짧은 달에 말일로 옮긴다. 매년 구독은 그 달에만 나온다. 시작일·종료일을 반영한다.
- `matchAll`: 모든 달의 결제일과 출금(제외되지 않은 것)의 짝을 만들고, 날짜가 가까운 짝 → 금액이 가까운 짝 순으로 **거래 하나를 구독 하나에만** 붙인다. 같은 '네이버페이' 이름의 구독 여럿은 금액·날짜로 갈린다.
- `chargeStatuses`: `paid`(✓) / `missing`(!) / `scheduled`. `missing`은 (1) 그 구독이 이전 결제일에 `paid`였던 적이 있고 (2) 마지막으로 불러온 거래 날짜가 결제일+3일 이후일 때만이다. 아직 네이버페이로 옮기지 않은 구독에 잘못된 경고가 뜨지 않게 하려는 규칙이니 함부로 바꾸지 않는다.
- `monthSpending`: `total`(출금 − 제외) = `subs`(구독과 맞춰진 거래) + `other`. 예정 금액을 빼서 '그 외'를 만들지 않는다(음수가 될 수 있음).
- `assignIds`/`mergeTransactions`: 거래 id = `날짜|시간|출금|입금|잔액|내용|적요`. 같은 파일 안에 똑같은 거래가 있으면 `#2`, `#3`을 붙인다. 기간이 겹치게 다시 불러와도 중복되지 않고, 기존 거래의 `excluded` 설정은 유지된다.
- `isExcluded`: 거래에 `excluded`(true/false)가 있으면 그 값, 없으면 제외 규칙(내용·적요에 키워드 포함)을 따른다.
- `fileToRows` → `parseRows`: 앞 바이트로 xlsx(ZIP)·xls(OLE)는 SheetJS, HTML 표(이름만 .xls)는 정규식, 텍스트는 UTF-16 BOM → UTF-8 → EUC-KR 순으로 읽는다. 머리글 행은 키워드로 찾는다. `HEADER_RULES`는 순서가 중요하다(예: '입출금구분'은 출금이 아니라 구분 열).

**`app.js` — 화면.** 상태를 바꾸면 `commit()`이 `derive()`(결제 확인 다시 계산) → 저장 → `render()`를 한다. 사용자 입력·은행 파일에서 온 글자는 반드시 `esc()`를 거쳐 HTML에 넣는다. 클릭은 `data-action` 속성과 `ACTIONS` 표로 처리한다.
- `?demo=1`로 열면 `demo.js`의 가짜 데이터를 메모리에만 올린다(저장 안 함). 캡처·점검용이고 메뉴에는 없다.
- SheetJS(`vendor/xlsx.full.min.js`, 0.20.3, cdn.sheetjs.com에서 받은 고정본, Apache-2.0)는 엑셀 파일을 불러올 때만 동적으로 로드한다. `eval`을 쓰지 않아 CSP `script-src 'self'`에서 동작한다.
- 그래프는 SVG로 직접 그린다. 막대를 누르면 말풍선이 뜨고(`applyChartActive`, 다시 그리지 않아 초점 유지), "표로 보기"에 같은 숫자가 있다.

**`sw.js` — 서비스 워커.** 앱 파일을 미리 캐시하고 캐시를 먼저 쓴다. **앱 파일을 바꿔 배포할 때마다 `CACHE` 버전(`subcal-vN`)을 올린다.** 새 파일을 추가하면 `ASSETS`에도 넣는다. 모든 경로는 상대 경로다(GitHub Pages 하위 경로).
- 설치할 때 `cache: 'reload'`로 받는다. 그냥 `addAll`을 쓰면 GitHub Pages의 HTTP 캐시에 남은 옛 파일이 새 버전 캐시에 들어갈 수 있다.
- `addAll`은 파일 하나만 404여도 통째로 실패한다(오프라인·엑셀 불러오기가 조용히 망가진다). 배포 뒤 `ASSETS`의 모든 주소가 200인지 curl로 확인한다. 루트의 `.nojekyll`은 GitHub Pages가 파일을 그대로 내보내게 한다.
- 새 버전이 활성화되면(`controllerchange`, 이미 맡고 있던 워커가 있을 때만) 위쪽 안내에 "적용" 버튼을 띄운다.

**`styles.css`.** 색은 `:root` 변수로 두고 다크 모드는 `prefers-color-scheme`으로 바꾼다. 그래프 색(`--s1` 확인된 구독 결제, `--s2` 그 외 지출)과 구독 색(`--cat-0`~`--cat-7`, 구독에는 슬롯 번호를 저장)은 dataviz 기준 팔레트로 라이트·다크 검증을 통과한 값이니 임의로 바꾸지 않는다. 입력창 글자는 16px 미만으로 하지 않는다(아이폰이 화면을 확대한다).

## 개인정보 규칙

- 실제 신한 거래내역 파일과 백업 파일은 이 폴더에 두지 않는다. 이 폴더는 OneDrive와 동기화되고 공개 GitHub에도 올라간다. `.gitignore`가 `*.xls*`, `*.csv`, `*.txt`, 백업 json을 막는다.
- 실제 파일을 확인할 때는 Downloads에서 스크래치패드의 빈 폴더로 복사하고, `tools/`의 스크립트에 경로를 넘겨 실행한다. 출력은 구조만 한다(머리말 행, 열 이름, 이름·금액을 가린 데이터 1행). 거래 전체를 출력하지 않는다.
- 테스트용 은행 파일은 가짜 데이터로 테스트 중에 만든다.

## 배포

GitHub Pages(공개 저장소, main 브랜치 root)에 올린다. 아이폰 홈 화면 설치와 서비스 워커에 HTTPS가 필요하기 때문이다. push·배포 전에 사용자에게 확인한다.
