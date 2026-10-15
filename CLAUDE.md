# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트

개인용 PWA "구독달력"이다(https://iwgh08.github.io/subscription-calendar/). **사용자 혼자 쓴다.** 공유, 다른 은행, 온보딩 같은 다른 사람용 기능은 넣지 않는다. 설명·UI 문구·주석은 한국어, 식별자는 영어로 쓴다.

- **PC에서 직접 입력하고, 아이폰은 보기만 한다.** 신한 거래내역 불러오기와 통장 맞춰 보기(✓·!)는 사용자가 원하지 않아서 뺐다. 다시 넣자고 먼저 제안하지 않는다.
- **한 달 총 지출 = 정기 구독료 + 직접 입력한 지출.** 정기 구독료는 등록한 구독의 결제일을 기준으로 그 달 전체를 센다. 구독 결제는 지출로 따로 입력하지 않는다(두 번 계산된다).
- **PC ↔ 폰 연결:** GitHub 비공개 저장소 `iwgh08/subscription-data`의 `state.json` 파일 하나로 잇는다.
  - 입력 기기(PC, 읽기·쓰기 토큰)가 올리고, 보기 기기(폰, 읽기 전용 토큰)가 받는다.
  - 서버는 없다. 데이터는 각 기기의 IndexedDB(`subcal` DB, `kv` 저장소)에도 있다.
  - 빌드 과정은 없고, 외부 요청은 CSP로 `api.github.com`만 허용한다.

## 명령어

- `npm test`: `tests/*.test.js`를 `node --test`로 돌린다. `core.test.js`는 계산과 v1→v2 옮기기, `sync.test.js`는 가짜 fetch로 GitHub 요청·오류·`decideSync`를 확인한다.
- `npm start`: http://localhost:8080 개발 서버(`tools/serve.js`, 의존성 없음).
  - 앱 파일 확장자만 내보내고 `.git` 같은 숨김 경로는 막는다.
  - **가짜 GitHub API(`/__gh/...`)가 들어 있다.** 메모리에만 저장하고, 이 개발 서버에만 있다.
    - 앱을 `/?gh=/__gh`로 열면 연결된다.
    - 토큰: `test-rw`(읽기·쓰기), `test-ro`(읽기 전용)
    - 실제 GitHub처럼 base64에 줄바꿈을 섞고, 생성 201·수정 200, sha 틀림 409, sha 없음 422, 권한·파일 없음 404, 틀린 토큰 401을 돌려준다.
    - 테스트 도우미: `POST /__gh/_reset`, `GET·POST /__gh/_file`, `POST /__gh/_down`(on/off — 연결 끊김 흉내)
- `node tools/ui-check.js <폴더>`: `npm start`를 켠 상태에서 헤드리스 Edge를 DevTools 프로토콜로 조종한다(PASS/FAIL 출력).
  - 샘플 화면: 390×844 모바일 에뮬레이션, 다크 모드
  - PC(1024px)와 폰(390px) 브라우저 두 개로: 연결 → 빠른 입력(Enter) → 폰이 받아옴 → 화면 복귀 시 갱신 → 오프라인 → 충돌 → 틀린 토큰
  - 화면이나 동기화를 바꾸면 돌린다.
  - `BASE_URL=https://iwgh08.github.io/subscription-calendar`를 주면 배포된 사이트의 샘플 화면만 점검한다.
- `node tools/shot.js "/?demo=1#calendar" out.png [폭] [높이] [light|dark]`: 화면 한 장 캡처. 헤드리스 Edge는 창 폭이 약 500px 아래로 줄지 않아서 iframe에 넣어 찍는다.
- `node tools/make-icons.js`: `icons/icon.svg` → PNG 180/192/512
- PowerShell에서 `npm`이 막히면 `npm.cmd`를 쓴다. 캡처·임시 파일은 스크래치패드나 OS 임시 폴더에 둔다.

### 점검 스크립트를 고칠 때 주의

- **`text()` 도우미는 괄호로 감싼 식을 돌려줘야 한다.** 감싸지 않으면 `a || ''.includes(x)`처럼 계산돼서 늘 통과한다(실제로 이 때문에 검사가 헛통과했었다).
- **"다시 열기"는 같은 주소#해시로 이동하면 페이지가 새로 열리지 않는다.** `goto`는 그때 `Page.reload`를 쓰고, 옛 페이지를 준비된 것으로 착각하지 않게 `window.__stale` 표시를 확인한다.
- **DevTools 오프라인 흉내는 서비스 워커를 거쳐 나가는 요청에 걸리지 않는다.** 그래서 가짜 GitHub의 `_down`으로 끊는다.
- 일부러 낸 401·오프라인 같은 네트워크 오류 로그는 콘솔 오류 검사에서 뺀다.

## 구조

**`core.js` — 순수 로직(UMD, DOM 금지).** 날짜는 `'YYYY-MM-DD'` 문자열이고 계산은 UTC 일수로 한다.
- `chargeDate`: 29~31일 결제는 짧은 달에 말일로 옮긴다. 매년 구독은 그 달에만 나온다. 시작일·종료일을 반영한다.
  - 새 구독의 시작일 기본값은 이번 달 1일이다. 등록하기 전 달의 합계에 끼어들지 않게 하기 위해서다.
- `monthTotals(subs, expenses, y, m)` → `{ subs, other, total, count }`. `monthProgress`는 결제일이 지난 것과 남은 것(오늘 포함)을 나눈다.
- `normalizeState`: 저장본·백업·GitHub에서 받은 내용을 읽을 때 모두 거친다. v1(통장 불러오기 시절)을 옮긴다.
  - 직접 입력한 거래(`source: 'manual'`)만 `expenses`로 옮긴다.
  - 불러온 통장 거래, 제외 규칙, `payKey`, `matchKey`는 버린다(구독료가 두 번 계산되기 때문이다).
- state v2: `{ version: 2, subs, expenses: [{ id, date, amount, title, memo }], settings: { lastBackupAt }, updatedAt }`

**`sync.js` — GitHub 연결(UMD, DOM 금지).**
- `client({ repo, token, base, fetch })`가 `checkRepo` / `read` / `write`를 만든다.
  - 모든 요청에 `cache: 'no-store'`를 붙인다. GitHub 응답은 60초 동안 캐시되기 때문이다.
  - 오류는 `SyncError { status, code }`로 바꾼다. `describe()`는 화면용 문구(HTTP 상태 포함)를 만든다.
- 비공개 저장소는 권한이 없어도 404를 돌려준다. 그래서 `read()`가 null(파일 없음)이면 `checkRepo()`로 저장소 접근부터 가린다.
- `decideSync`
  - 보기 기기는 절대 올리지 않는다.
  - 입력 기기는 원격이 그대로면 dirty일 때 올린다. 원격이 바뀌었으면 dirty가 아닐 때만 받아오고, dirty면 충돌이다.
  - 데이터가 있는 PC를 처음 연결하면 dirty로 시작한다. 원격 파일이 있으면 조용히 덮지 않고 충돌로 묻는다.
- `state.json`은 1MB를 넘으면 contents API로 받을 수 없다(`too-large` 오류). 그 정도로 커지면 raw 받기로 바꿔야 한다.

**`app.js` — 화면.**
- 상태를 바꾸면 `commit()`이 `updatedAt`을 갱신하고, 입력 기기면 `dirty`를 표시한다. 그다음 `persist()`(state와 sync를 한 트랜잭션에 저장) → `render()` → 1.5초 뒤 `pushOnce`로 이어진다.
- GitHub 요청은 `serial()` 대기열로 하나씩 실행한다.
- `visibilitychange`
  - hidden: 안 올린 변경을 바로 올린다.
  - visible: 날짜를 갱신하고 `syncNow`를 부른다. `online` 이벤트 때도 `syncNow`를 부른다.
- 상태 줄(`#syncbar`)
  - 보기 기기는 **항상 두 시각**("PC 수정 … · 받아옴 …")을 보여 준다. 실패하면 경고와 HTTP 상태를 보여 준다. 옛 데이터를 조용히 보여 주지 않게 하기 위해서다.
  - `body[data-sync]`(off/busy/ok/error)는 점검 스크립트가 본다.
- 보기 기기(`readOnly()`)는 추가·수정·삭제 버튼, 빠른 입력 줄, 백업 불러오기, 전체 삭제를 그리지 않는다. 목록 줄도 누를 수 없는 `div`로 그린다.
- 사용자·GitHub에서 온 글자는 반드시 `esc()`를 거친다. 클릭은 `data-action` 속성과 `ACTIONS` 표로 처리한다.
- `?demo=1`은 `demo.js`의 가짜 데이터를 메모리에만 올린다(저장·연결 안 함).
- `?gh=`는 주소가 localhost·127.0.0.1이고 값이 `/`로 시작할 때만 받는다(개발용 가짜 GitHub).
- 연결 설정과 토큰은 IndexedDB의 `sync` 키에 둔다. 백업 파일에는 state만 들어간다.

**`sw.js` — 서비스 워커.**
- 앱 파일을 미리 캐시하고 캐시를 먼저 쓴다. **앱 파일을 바꿔 배포할 때마다 `CACHE` 버전(`subcal-vN`)을 올린다.** 새 파일을 만들면 `ASSETS`에도 넣는다.
- 설치할 때 `cache: 'reload'`로 받는다. 그래야 GitHub Pages의 HTTP 캐시에 남은 옛 파일이 새 캐시에 들어가지 않는다.
- `addAll`은 파일 하나만 404여도 통째로 실패한다. 배포 뒤 `ASSETS`의 모든 주소가 200인지 curl로 확인한다. 루트의 `.nojekyll`은 Pages가 파일을 그대로 내보내게 한다.
- 다른 사이트(GitHub API)와 `/__gh/` 요청에는 손대지 않는다.
- 새 버전이 활성화되면(`controllerchange`, 이미 맡고 있던 워커가 있을 때만) 위쪽 안내에 "적용" 버튼을 띄운다.

**`styles.css`.** 색은 `:root` 변수로 두고, 다크 모드는 `prefers-color-scheme`으로 바꾼다. 그래프 색(`--s1` 정기 구독료, `--s2` 그 외 지출)과 구독 색(`--cat-0`~`--cat-7`)은 dataviz 기준 팔레트로 검증을 통과한 값이니 임의로 바꾸지 않는다. 입력창 글자는 16px 미만으로 하지 않는다(아이폰이 화면을 확대한다).

## 보안 규칙

- 토큰은 그 기기의 IndexedDB에만 둔다. 코드, 공개 저장소, 백업 파일에 넣지 않는다. **사용자에게 토큰을 채팅에 붙여 넣게 하지 않는다.**
- `iwgh08.github.io` 아래의 모든 Pages 사이트는 같은 출처라서 IndexedDB를 서로 읽을 수 있다. **이 계정의 어떤 Pages 사이트에도 외부 스크립트를 넣지 않는다.** CSP는 `script-src 'self'`를 유지한다.
- 토큰 권한은 최소로 한다: 저장소 하나, Contents만, 폰은 Read-only.

## 배포

GitHub Pages(공개 저장소 `iwgh08/subscription-calendar`, main 브랜치 root)에 올린다. push 전에 `npm test`와 `node tools/ui-check.js`를 통과시킨다. push한 뒤에는 `ASSETS`의 모든 주소가 200인지 curl로 확인하고, `BASE_URL`로 라이브 샘플 화면을 점검한다.
