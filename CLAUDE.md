# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트

개인용 PWA "구독달력"이다(https://iwgh08.github.io/subscription-calendar/). **사용자 혼자 쓴다.** 공유, 다른 은행, 온보딩 같은 다른 사람용 기능은 넣지 않는다. 설명·UI 문구·주석은 한국어, 식별자는 영어로 쓴다.

- **PC와 아이폰 둘 다 입력 기기로 고칠 수 있다**(2026-10-18 사용자 요청으로 바꿈. 그 전에는 폰은 보기만 했다). 보기 기기(읽기 전용) 역할도 남겨 두었다. 신한 거래내역 불러오기와 통장 맞춰 보기(✓·!)는 사용자가 원하지 않아서 뺐다. 다시 넣자고 먼저 제안하지 않는다.
- **한 달 총 지출 = 정기 구독료 + 직접 입력한 지출.** 정기 구독료는 등록한 구독의 결제일을 기준으로 그 달 전체를 센다. 구독 결제는 지출로 따로 입력하지 않는다(두 번 계산된다). **수입은 총 지출·그래프에 넣지 않는다.**
- **지금 통장 잔액 = 사용자가 맞춘 잔액 + 그 뒤 수입 − 그 뒤 지출 − 그 뒤 구독 결제(오늘까지).** 은행과 연결된 값이 아니라 앱이 계산한 값이다. 구독은 모두 신한 통장(네이버페이 체크카드)에서 빠진다고 본다.
  - 잔액은 사용자가 앱(PC)에서 직접 적는다. 실제 금액을 코드·테스트·샘플·캡처에 넣지 않는다(앱 저장소는 공개다).
- **PC ↔ 폰 연결:** GitHub 비공개 저장소 `iwgh08/subscription-data`의 `state.json` 파일 하나로 잇는다.
  - 입력 기기(읽기·쓰기 토큰)는 올리고 받는다. 보기 기기(읽기 전용 토큰)는 받기만 한다.
  - 두 입력 기기가 따로 고치면 기준본(base)과 비교해 항목별로 합친다(`mergeStates`). 묻지 않는다.
  - 서버는 없다. 데이터는 각 기기의 IndexedDB(`subcal` DB, `kv` 저장소)에도 있다.
  - 빌드 과정은 없고, 외부 요청은 CSP로 `api.github.com`만 허용한다.

## 명령어

- `npm test`: `tests/*.test.js`를 `node --test`로 돌린다. `core.test.js`는 계산, 옛 형식 옮기기, 두 기기 합치기, `sync.test.js`는 가짜 fetch로 GitHub 요청·오류·`decideSync`를 확인한다.
- `npm start`: http://localhost:8080 개발 서버(`tools/serve.js`, 의존성 없음).
  - 앱 파일 확장자만 내보내고 `.git` 같은 숨김 경로는 막는다.
  - **가짜 GitHub API(`/__gh/...`)가 들어 있다.** 메모리에만 저장하고, 이 개발 서버에만 있다.
    - 앱을 `/?gh=/__gh`로 열면 연결된다.
    - 토큰: `test-rw`(읽기·쓰기), `test-ro`(읽기 전용)
    - 실제 GitHub처럼 base64에 줄바꿈을 섞고, 생성 201·수정 200, sha 틀림 409, sha 없음 422, 권한·파일 없음 404, 틀린 토큰 401을 돌려준다.
    - 테스트 도우미: `POST /__gh/_reset`, `GET·POST /__gh/_file`, `POST /__gh/_down`(on/off — 연결 끊김 흉내)
- `node tools/ui-check.js <폴더>`: `npm start`를 켠 상태에서 헤드리스 Edge를 DevTools 프로토콜로 조종한다(PASS/FAIL 출력).
  - 샘플 화면: 390×844 모바일 에뮬레이션, 다크 모드
  - PC(1024px)와 폰(390px) 브라우저 두 개로: 연결 → 빠른 입력(Enter) → 폰이 받아옴 → 화면 복귀 시 갱신 → 잔액 맞추기·수입 → 일정 추가(폰 달력에 보임) → 옛 형식 저장본 다시 받기 → 오프라인 → 충돌(기준본 없음 → 묻는 시트) → 계산 탭(내일 남는 돈·써 볼 지출·지출로 적기) → 새 버전 내용 거부 → 틀린 토큰 → 폰도 입력 기기로 다시 연결 → 둘 다 끊긴 사이 고친 것 합치기·지운 것 안 되살아남
  - 화면이나 동기화를 바꾸면 돌린다.
  - `BASE_URL=https://iwgh08.github.io/subscription-calendar`를 주면 배포된 사이트의 샘플 화면만 점검한다.
- `node tools/shot.js "/?demo=1#calendar" out.png [폭] [높이] [light|dark]`: 화면 한 장 캡처. 헤드리스 Edge는 창 폭이 약 500px 아래로 줄지 않아서 iframe에 넣어 찍는다.
- `node tools/make-icons.js`: `icons/icon.svg` → PNG 180/192/512
- PowerShell에서 `npm`이 막히면 `npm.cmd`를 쓴다. 캡처·임시 파일은 스크래치패드나 OS 임시 폴더에 둔다.

### 점검 스크립트를 고칠 때 주의

- **`text()` 도우미는 괄호로 감싼 식을 돌려줘야 한다.** 감싸지 않으면 `a || ''.includes(x)`처럼 계산돼서 늘 통과한다(실제로 이 때문에 검사가 헛통과했었다).
- **"다시 열기"는 같은 주소#해시로 이동하면 페이지가 새로 열리지 않는다.** `goto`는 그때 `Page.reload`를 쓰고, 옛 페이지를 준비된 것으로 착각하지 않게 `window.__stale` 표시를 확인한다.
- **DevTools 오프라인 흉내는 서비스 워커를 거쳐 나가는 요청에 걸리지 않는다.** 그래서 가짜 GitHub의 `_down`으로 끊는다.
- **다른 탭의 화면은 숨겨질 뿐 옛 HTML이 남아 있다.** `#quickAdd`에 쓰기 전에 꼭 `tab('spend')`로 옮긴다. 숨은 칸에 쓰면 초점을 못 받아 Enter가 헛돌고, 검사는 엉뚱한 이유로 실패한다.
- 폰은 오프라인이 풀릴 때(`online`) 스스로 받아 오므로, 그 사이 가짜 저장소에 넣은 중간 내용을 받아 갈 수 있다. 폰 화면 값을 확인하기 전에 `visibilitychange`로 다시 받게 한다.
- 일부러 낸 401·오프라인 같은 네트워크 오류 로그는 콘솔 오류 검사에서 뺀다.

## 구조

**`core.js` — 순수 로직(UMD, DOM 금지).** 날짜는 `'YYYY-MM-DD'` 문자열이고 계산은 UTC 일수로 한다.
- `chargeDate`: 29~31일 결제는 짧은 달에 말일로 옮긴다. 매년 구독은 그 달에만 나온다. 시작일·종료일을 반영한다.
  - 새 구독의 시작일 기본값은 이번 달 1일이다. 등록하기 전 달의 합계에 끼어들지 않게 하기 위해서다.
- `monthTotals(subs, expenses, y, m)` → `{ subs, other, total, count }`(수입은 넣지 않는다). `monthIncome`은 수입만 따로 센다. **구독은 결제일 당일이 되면 바로 결제된 것으로 본다**(2026-10-18 사용자 요청). `monthProgress`는 결제된 것(오늘까지)과 남은 것(내일부터)을 나누고, `upcoming`·`nextChargeDate`는 내일부터 본다. 달력 목록 표시는 '결제됨'/'예정'.
- `balanceNow(state, today)`: 맞춘 잔액이 없으면 null. 넣는 규칙은 다음과 같다(바꾸면 `core.test.js`의 잔액 테스트도 함께 고친다).
  - 맞춘 날보다 뒤이고 오늘까지인 수입·지출. 앞 날짜는 이미 잔액에 들어 있다고 보고, 앞으로의 날짜는 그날 넣는다.
  - 맞춘 날 날짜의 수입·지출은 맞춘 뒤에 적은 것(`createdAt > balance.setAt`)만 넣는다. 적은 시각이 없는 옛 항목은 넣지 않는다.
  - 구독 결제는 `chargesBetween`으로 맞춘 날 다음 날~오늘을 센다. 맞춘 날의 결제는 `paidToday`(그때 이미 빠짐)가 아닐 때만 넣는다. 새로 맞추면 언제나 `paidToday: true`다(당일 결제는 이미 빠졌다고 본다. 예전의 체크는 없앴고, false는 옛 저장본에만 있다).
- `balanceOn(state, today, date, plans)`: 앞으로의 날짜 끝에 남는 돈 = `balanceNow(오늘)` + 오늘 다음 날~그날의 수입 − 지출 − 구독 결제 − 써 볼 지출(plans, 오늘~그날). plans 없이 계산하면 `balanceNow(state, date)`와 같다. 지난 날짜·잔액 없음이면 null.
- `normalizeState`: 저장본·백업·GitHub에서 받은 내용을 읽을 때 모두 거친다. **여기서 고르지 않는 칸은 버려진다.** 칸을 새로 만들면 여기, `emptyState`, `isEmptyState`에 넣고 `STATE_VERSION`을 올린다.
  - v1(통장 불러오기 시절): 직접 입력한 거래(`source: 'manual'`)만 `expenses`·`incomes`로 옮긴다. 불러온 통장 거래, 제외 규칙, `payKey`, `matchKey`는 버린다(구독료가 두 번 계산되기 때문이다).
  - v2 → v3: `incomes: []`, `balance: null`을 채운다.
  - v3 → v4: `events: []`를 채운다. 날짜가 틀린 일정은 버리고, 이름이 비면 '일정', 시간은 `HH:MM`이 아니면 ''.
  - v4 → v5: 일정에 `repeat`('yearly' 또는 '')을 채운다.
- `mergeStates(base, local, remote)`: 두 입력 기기 내용 합치기. `subs`·`expenses`·`incomes`·`events`는 id별로 합친다.
  - 한쪽만 바뀐 항목은 바뀐 쪽을 쓴다(지운 것도 포함). 한쪽은 지우고 다른 쪽은 고쳤으면 고친 것을, 둘 다 고쳤으면 이 기기 것을 남긴다.
  - 잔액도 같은 규칙이고, 둘 다 맞췄으면 `setAt`이 나중인 것을 쓴다. 백업 시각은 나중 것.
  - 값 비교는 칸 순서를 무시한다(`canon`). `sameData`는 수정 시각·설정을 빼고 데이터가 같은지 본다.
- `isNewerState`: 이 앱보다 새 버전이 저장한 내용이면 받지 않는다(받으면 모르는 칸이 사라진다). 그런 백업도 `readBackup`이 거부한다.
- `eventsInMonth`: 그 달 일정을 날짜 → 시간 순으로(시간 없는 것이 그날 먼저). 매년 일정은 처음 날짜의 해부터 해마다 같은 월·일에 나오고(2월 29일은 평년에 28일), 돌려줄 때 `date`는 그해 날짜, `start`는 처음 날짜다. 고칠 때는 id로 원래 일정을 찾는다. **일정은 금액이 없고 돈 계산(총 지출·잔액·계산 탭)에 넣지 않는다.**
- state v5: `{ version: 5, subs, expenses, incomes, events, balance, settings: { lastBackupAt }, updatedAt }`
  - `expenses`·`incomes`: `[{ id, date, amount, title, memo, createdAt? }]` — `createdAt`은 적은 시각(ISO)
  - `events`: `[{ id, date, time, repeat, title, memo, createdAt? }]` — `time`은 'HH:MM' 또는 ''(하루 종일), `repeat`은 'yearly'(매년, `date`는 처음 날짜) 또는 ''
  - `balance`: `{ amount, date, setAt, paidToday } | null` — 0원도 된다

**`sync.js` — GitHub 연결(UMD, DOM 금지).**
- `client({ repo, token, base, fetch })`가 `checkRepo` / `read` / `write`를 만든다.
  - 모든 요청에 `cache: 'no-store'`를 붙인다. GitHub 응답은 60초 동안 캐시되기 때문이다.
  - 오류는 `SyncError { status, code }`로 바꾼다. `describe()`는 화면용 문구(HTTP 상태 포함)를 만든다.
- 비공개 저장소는 권한이 없어도 404를 돌려준다. 그래서 `read()`가 null(파일 없음)이면 `checkRepo()`로 저장소 접근부터 가린다.
- `decideSync`
  - 보기 기기는 절대 올리지 않는다.
  - 입력 기기는 원격이 그대로면 dirty일 때 올린다. 원격이 바뀌었으면 dirty가 아닐 때만 받아오고, dirty면 충돌이다.
  - 데이터가 있는 입력 기기를 처음 연결하면 dirty로 시작한다. 원격 파일이 있으면 조용히 덮지 않는다. 내용이 같으면 그대로 맞추고, 다르면(기준본이 없으니) 충돌로 묻는다.
- `state.json`은 1MB를 넘으면 contents API로 받을 수 없다(`too-large` 오류). 그 정도로 커지면 raw 받기로 바꿔야 한다.

**`app.js` — 화면.**
- 상태를 바꾸면 `commit()`이 `updatedAt`을 갱신하고, 입력 기기면 `dirty`를 표시한다. 그다음 `persist()`(state와 sync를 한 트랜잭션에 저장) → `render()` → 1.5초 뒤 `pushOnce`로 이어진다.
- GitHub 요청은 `serial()` 대기열로 하나씩 실행한다.
- **기준본 `app.base`는 항상 `app.sync.sha` 때의 GitHub 내용이다.** IndexedDB `base` 키에 state·sync와 한 트랜잭션으로 저장한다. 백업과 `state.json`에는 넣지 않는다.
  - 받아올 때(`applyRemote`)는 받은 내용으로, 올리기에 성공하면 올린 snapshot으로 바꾼다. 충돌 시트에서 고르면 그때 원격 내용으로, 연결·끊기·옛 형식 저장본이면 지운다.
  - 기준본이 없고 원격 sha가 같으면, 열 때 원격 내용으로 채운다(업데이트 전부터 쓰던 기기).
  - 충돌(dirty인데 원격이 바뀜, 또는 올리다 409)은 `resolveConflict`가 처리한다. 내용이 같으면 받아오고, 기준본이 있으면 합친다. 합친 state, 원격 sha, 새 기준본(원격)을 함께 저장한 뒤 올린다. 기준본이 없을 때만 시트로 묻는다.
- `visibilitychange`
  - hidden: 안 올린 변경을 바로 올린다.
  - visible: 날짜를 갱신하고 `syncNow`를 부른다. `online` 이벤트 때도 `syncNow`를 부른다.
- 상태 줄(`#syncbar`)
  - 보기 기기는 **항상 두 시각**("수정 … · 받아옴 …")을 보여 준다. 실패하면 경고와 HTTP 상태를 보여 준다. 옛 데이터를 조용히 보여 주지 않게 하기 위해서다.
  - `body[data-sync]`(off/busy/ok/error)는 점검 스크립트가 본다.
- 보기 기기(`readOnly()`)는 추가·수정·삭제 버튼, 빠른 입력 줄, 잔액 맞추기, 백업 불러오기, 전체 삭제를 그리지 않는다. 목록 줄도 누를 수 없는 `div`로 그린다.
- 저장본의 `version`이 옛것이면 옮긴 내용을 저장하고, `sync.sha`를 지워서 한 번 다시 받는다(보기 기기, 그리고 안 올린 변경이 없는 입력 기기). 옛 앱(배포 전에 열어 둔 창 포함)이 받으면서 수입·잔액 칸을 버렸을 수 있는데, 원격 sha가 같으면 다시 받지 않기 때문이다.
- 홈 맨 위는 지금 통장 잔액(`#balanceHero`, 고른 달과 상관없이 오늘 기준)이다. 그 아래가 고른 달의 총 지출(`#monthTotal`)이다. 점검 스크립트가 이 id를 본다.
- 내역 탭(주소는 `#spend` 그대로): 구독 결제(자동)·지출·수입을 날짜별로 보여 준다. 같은 날은 최근에 적은 것(`createdAt`)이 위다.
  - 빠른 입력 줄의 지출·수입 고르기는 다시 그려질 때 '지출'로 돌아온다. 수입으로 잘못 들어가지 않게 하기 위해서다.
  - 수정 시트(`#expForm`)에서 종류를 바꾸면 다른 목록으로 옮긴다.
- 달력 탭: 칸에는 일정(테두리 네모 `.ev-mark`)을 먼저, 구독(색 점)을 다음으로 두 줄까지 보여 주고 나머지는 `+N`. 구독 팔레트를 건드리지 않게 일정은 모양으로 구분한다. 아래에 그 달 일정 목록.
  - 그날 시트(`openDay`) 맨 위가 일정이다. 입력 기기에서는 "이날 일정 추가"(`add-event`)와 줄 누르기(`edit-event`)로 일정 시트(`#eventForm`)를 연다. 그날 시트에서 연 일정 시트는 저장·삭제 뒤 그날 시트로 돌아간다.
- 계산 탭(`#plan`): 달력에서 오늘 이후 날짜를 누르면 그날 끝에 남는 돈(`#planResult`)을 보여 준다.
  - 써 볼 지출(`app.plans`)은 메모리에만 두고 저장·연결하지 않는다. 그래서 보기 기기에서도 더할 수 있다(`#planAdd`는 submit의 읽기 전용 검사보다 먼저 처리).
  - 입력 기기에서만 줄마다 "지출로 적기"(`plan-commit`)로 실제 지출에 넣는다.
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

**`styles.css`.** 색은 `:root` 변수로 두고, 다크 모드는 `prefers-color-scheme`으로 바꾼다. `body`는 `word-break: keep-all`이다. 한국어를 띄어쓰기에서만 줄바꿈해서 "30,000원"이 "30,000 / 원"으로 갈리지 않게 한다. 그래프 색(`--s1` 정기 구독료, `--s2` 그 외 지출)과 구독 색(`--cat-0`~`--cat-7`)은 dataviz 기준 팔레트로 검증을 통과한 값이니 임의로 바꾸지 않는다. 입력창 글자는 16px 미만으로 하지 않는다(아이폰이 화면을 확대한다).

## 보안 규칙

- 토큰은 그 기기의 IndexedDB에만 둔다. 코드, 공개 저장소, 백업 파일에 넣지 않는다. **사용자에게 토큰을 채팅에 붙여 넣게 하지 않는다.**
- `iwgh08.github.io` 아래의 모든 Pages 사이트는 같은 출처라서 IndexedDB를 서로 읽을 수 있다. **이 계정의 어떤 Pages 사이트에도 외부 스크립트를 넣지 않는다.** CSP는 `script-src 'self'`를 유지한다.
- 토큰 권한은 최소로 한다: 저장소 하나, Contents만. 폰에서도 고치려면 Read and write(보기만 할 기기는 Read-only). PC용·폰용 토큰을 따로 만들어서, 폰을 잃어버리면 폰용만 지운다.

## 배포

GitHub Pages(공개 저장소 `iwgh08/subscription-calendar`, main 브랜치 root)에 올린다. push 전에 `npm test`와 `node tools/ui-check.js`를 통과시킨다. push한 뒤에는 `ASSETS`의 모든 주소가 200인지 curl로 확인하고, `BASE_URL`로 라이브 샘플 화면을 점검한다.
