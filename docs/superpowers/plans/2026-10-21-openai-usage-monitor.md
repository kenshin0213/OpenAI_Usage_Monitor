# OpenAI 듀얼 사용량 모니터 구현 계획서 (OpenAI Usage Monitor Implementation Plan)

> **작업 에이전트 가이드:** REQUIRED SUB-SKILL: 이 계획을 실행할 때 `subagent-driven-development` 또는 `executing-plans`를 사용하여 태스크 단위로 순차 진행합니다. 단계별 체크박스(`- [ ]`)로 진행 상황을 추적합니다.

**목표:** 2개의 ChatGPT/Codex 계정의 실시간 사용량(5시간 단위 및 주간 한도 잔여량%, 리셋 카운트다운)을 Windows 시스템 트레이에서 세션 충돌 및 토큰 만료 없이 모니터링하고 임계치 알림을 제공하는 경량 데스크톱 애플리케이션 구축.

**아키텍처:** Node.js + Electron 기반의 백그라운드 트레이 애플리케이션. 전역 환경과 분리된 독립 듀얼 계정 슬롯(`Slot 1`, `Slot 2`)을 관리하며, 공식 OAuth `refresh_token`을 통해 만료 없는 자동 갱신을 수행하고 `wham/usage` 엔드포인트를 주기적으로 폴링하여 미려한 트레이 팝업 UI와 Windows 네이티브 토스트 알림을 제공함.

**기술 스택:**
- Runtime: Node.js (v24), Electron
- Architecture: Dual Account Slot Store, OAuth Token Refresher, Background Usage Poller, Windows Native Notification Service
- Frontend: HTML5, CSS3 (Modern Dark/Light UI, Progress bars, Smooth Transitions), Vanilla JavaScript

**참조 사양서:**
- 도메인 용어: [`CONTEXT.md`](file:///d:/Workspace/OpneAI_Usage_Monitor/CONTEXT.md)
- 아키텍처 결정 기록 1: [`docs/adr/0001-dual-isolated-account-slots.md`](file:///d:/Workspace/OpneAI_Usage_Monitor/docs/adr/0001-dual-isolated-account-slots.md)
- 아키텍처 결정 기록 2: [`docs/adr/0002-electron-tray-application.md`](file:///d:/Workspace/OpneAI_Usage_Monitor/docs/adr/0002-electron-tray-application.md)

---

## 전역 제약 조건 (Global Constraints)
1. **세션 격리성**: 슬롯 1과 슬롯 2의 토큰, 쿠키, 상태는 완전히 분리되어 상호 간섭이 발생하지 않아야 함.
2. **토큰 무중단 자동 갱신**: 사용자가 수동으로 토큰을 복사하거나 갱신할 필요 없이, 만료 임박 시 백그라운드에서 자동 재발급되어야 함.
3. **리소스 최소화**: 백그라운드 상주 프로그램이므로 불필요한 렌더러 창은 평소에 숨기거나 백그라운드 유휴 상태를 유지해야 함.
4. **언어 일관성**: 모든 사용자 인터페이스 및 내부 주석/문서는 한국어를 기본으로 함.

---

### Task 1: 프로젝트 스캐폴딩 및 계정 슬롯 저장소 구현 (`config.js`)

**작업 대상 파일:**
- 생성: `package.json`
- 생성: `src/config.js`
- 생성: `tests/config.test.js`

**인터페이스:**
- 제공 함수:
  - `getConfig()`: 전체 설정(폴링 주기, 알림 임계치 등) 반환
  - `updateConfig(patch)`: 설정 갱신 및 파일 저장
  - `getSlot(slotId)`: 슬롯 1 또는 슬롯 2의 인증/사용량 상태 반환
  - `saveSlot(slotId, slotData)`: 슬롯 데이터 독립 저장
  - `seedSlot1FromCodex()`: PC에 이미 존재하는 `~/.codex/auth.json`에서 슬롯 1 초기 인증 정보 자동 임포트

- [ ] **Step 1: package.json 초기화 및 필수 의존성 선언**
- [ ] **Step 2: config 단위 테스트 작성 (`tests/config.test.js`)**
  - 슬롯 1, 슬롯 2 데이터 독립 저장 및 읽기 테스트
  - `seedSlot1FromCodex`가 PC의 기존 세션을 안전하게 복사하는지 검증
- [ ] **Step 3: `src/config.js` 구현**
- [ ] **Step 4: 단위 테스트 실행 및 통과 확인**

---

### Task 2: OAuth 자동 갱신 및 백엔드 사용량 조회 엔진 (`auth.js`, `api.js`)

**작업 대상 파일:**
- 생성: `src/auth.js`
- 생성: `src/api.js`
- 생성: `tests/api.test.js`

**인터페이스:**
- `ensureValidToken(slotId)`: 해당 슬롯의 `refresh_token`을 사용하여 필요 시 `https://auth0.openai.com/oauth/token`에서 새 `access_token` 발급
- `fetchUsage(slotId)`: 유효한 토큰으로 `https://chatgpt.com/backend-api/wham/usage` 호출 및 표준화된 지표 반환
- `startOAuthLoginFlow(slotId)`: 슬롯 2 신규 등록을 위한 1회성 로컬 HTTP 콜백 리스너 및 브라우저 로그인 창 실행

- [ ] **Step 1: API 및 Auth 모듈 단위 테스트 작성 (Mock 기반 토큰 갱신 및 사용량 파싱 검증)**
- [ ] **Step 2: `src/auth.js` 토큰 갱신 및 로컬 OAuth 플로우 구현**
- [ ] **Step 3: `src/api.js` 사용량 엔드포인트 호출 및 에러 핸들링(401, 재시도, 타임아웃) 구현**
- [ ] **Step 4: 테스트 실행 및 슬롯 1 실서버 연동 검증**

---

### Task 3: 폴링 스케줄러 및 토스트 알림 서비스 (`poller.js`, `notifier.js`)

**작업 대상 파일:**
- 생성: `src/notifier.js`
- 생성: `src/poller.js`
- 생성: `tests/poller.test.js`

**인터페이스:**
- `notify(title, message, options)`: Windows 네이티브 토스트 알림 발송
- `startPolling(intervalMinutes, onUpdate)`: 주기적(기본 5분)으로 슬롯 1과 슬롯 2를 병렬 조회
- 알림 조건 체크:
  - 5시간 한도 잔여량 <= 10% 도달 시 알림 (중복 발송 방지 쿨다운 포함)
  - 5시간 한도 100% 리셋 완료 시 알림

- [ ] **Step 1: 폴러 및 알림 로직 단위 테스트 작성**
- [ ] **Step 2: `src/notifier.js` 구현**
- [ ] **Step 3: `src/poller.js` 구현**
- [ ] **Step 4: 테스트 실행 및 검증**

---

### Task 4: 트레이 팝업 UI 구현 (HTML / CSS / JS)

**작업 대상 파일:**
- 생성: `src/ui/index.html`
- 생성: `src/ui/style.css`
- 생성: `src/ui/renderer.js`
- 생성: `assets/icon.png`, `assets/icon.ico`

**화면 구성:**
- 헤더: "ChatGPT 사용량 모니터", 마지막 갱신 시각, [새로고침] 버튼, [설정] 버튼
- 계정 1 카드:
  - 이메일 / 플랜(Plus/Pro) 배지
  - 5시간 단위 한도: 잔여량(%), 진행 바, "00분 후 초기화" 카운트다운
  - 주간 사용 한도: 잔여량(%), 진행 바, "0일 00시간 후 초기화"
- 계정 2 카드:
  - 연동 전: "[계정 2 연동하기]" 버튼 표시
  - 연동 후: 계정 1과 동일한 실시간 지표 카드 표시
- 하단: 알림 설정 토글 및 갱신 주기 선택 팝업

- [ ] **Step 1: 다크 모드 기반의 고품질 카드 UI 마크업 작성 (`src/ui/index.html`)**
- [ ] **Step 2: 부드러운 프로그레스 바 및 타이머 애니메이션 스타일 작성 (`src/ui/style.css`)**
- [ ] **Step 3: 렌더러 스크립트 작성 (`src/ui/renderer.js`)**

---

### Task 5: Electron 메인 프로세스 및 시스템 트레이 통합 (`main.js`)

**작업 대상 파일:**
- 생성: `src/main.js`
- 생성: `src/preload.js`

**인터페이스:**
- Windows 시스템 트레이 아이콘 생성 및 컨텍스트 메뉴(열기, 지금 새로고침, 자동 시작 등록, 종료)
- 트레이 클릭 시 마우스/작업표시줄 위치에 맞춰 트레이 팝업 창 토글
- 창 외부 클릭 시 자동 숨김(Blur 이벤트)
- IPC 통신: 렌더러와 메인 간의 `get-usage`, `refresh-now`, `login-account-2`, `save-settings` 핸들러 연결

- [ ] **Step 1: `src/preload.js` 안전한 IPC 브리지 작성**
- [ ] **Step 2: `src/main.js` 트레이 및 윈도우 라이프사이클 구현**
- [ ] **Step 3: IPC 핸들러 및 폴러 연동**

---

### Task 6: 전체 통합 실행 및 동작 검증

- [ ] **Step 1: 슬롯 1(기존 계정) 실시간 데이터 로드 확인**
- [ ] **Step 2: 시스템 트레이 팝업 및 실시간 프로그레스 바 렌더링 확인**
- [ ] **Step 3: 수동 새로고침 및 백그라운드 5분 주기 동작 확인**
- [ ] **Step 4: 슬롯 2 연동 UI 및 알림 동작 검증**
