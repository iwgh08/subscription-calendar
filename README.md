# 구독달력

정기 구독료와 한 달 지출을 달마다 보여 주는 개인용 앱(PWA)입니다. **PC에서 입력하고, 아이폰에서는 보기만** 합니다. 구독 결제일은 달력에 표시되고, 결제일에 맞춰 그 달 지출에 자동으로 더해집니다.

앱 주소: https://iwgh08.github.io/subscription-calendar/

## 처음 한 번: PC와 폰 연결하기

1. **비공개 저장소 만들기:** github.com → New repository
   - 이름: `subscription-data`
   - **Private**를 고르고 **Add a README file을 체크**한 뒤 Create repository를 누릅니다.
2. **토큰 두 개 만들기:** 프로필 → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token
   - Repository access: Only select repositories → `subscription-data`
   - Expiration: 고를 수 있는 **가장 긴 기간**. 기본값으로 두면 금방 만료됩니다.
   - PC용: Repository permissions → Contents → **Read and write**
   - 폰용: Contents → **Read-only**
3. **PC:** 앱 주소를 열고 설정 → PC ↔ 폰 연결 → PC용 토큰 붙여 넣기 → **입력(PC)** → 연결
4. **아이폰**
   1. Safari로 앱 주소를 열고 공유 → **홈 화면에 추가**를 누릅니다.
   2. 홈 화면의 **구독달력** 아이콘으로 엽니다.
   3. PC 카카오톡 '나와의 채팅'으로 폰용 토큰을 보내 복사하고, 설정 → 붙여 넣기 → **보기만(폰)** → 연결을 누릅니다.
   4. 카톡 메시지는 지웁니다.

폰에 이미 입력한 구독이 있으면, 3번 전에 폰에서 설정 → 백업 파일 만들기 → PC로 보내기 → PC에서 백업 불러오기를 해 주세요.

## 쓰는 법

- **구독:** 구독 탭 → + 구독 추가. 금액과 결제일은 네이버페이 → 결제내역·정기결제, 아이폰 설정 → 이름 → 구독에서 확인할 수 있습니다.
- **지출:** 지출 탭 위쪽 입력 줄에 날짜·금액·내용을 적고 Enter를 누릅니다. 구독 결제는 자동으로 더해지니 따로 적지 않습니다.
- **폰:** 앱을 열거나 다시 화면으로 돌아올 때마다 PC에서 올린 내용을 받아 옵니다. 위쪽 줄에 "PC 수정 시각 · 받아온 시각"이 보이고, 받아오지 못하면 경고가 뜹니다.
- **백업:** 설정 → 백업 파일 만들기 → '파일에 저장'. 토큰은 백업 파일에 들어가지 않습니다.

## 개발

- `npm test`: 계산·동기화 테스트
- `npm start`: http://localhost:8080
  - 샘플 데이터: `/?demo=1`
  - 가짜 GitHub: `/?gh=/__gh`, 토큰 `test-rw` / `test-ro`
- `node tools/ui-check.js <폴더>`: PC·폰 브라우저 두 개로 연결·입력·받아오기·오프라인·충돌 자동 점검(헤드리스 Edge)

구조와 규칙은 [CLAUDE.md](CLAUDE.md)에 있습니다.
