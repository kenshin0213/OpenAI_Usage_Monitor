# OpenAI 사용량 모니터 - 다중 계정 확장 및 UI/UX 개선 설계서 (Spec)

## 1. 개요 및 목표

본 문서는 Windows 시스템 트레이 기반의 OpenAI 사용량 모니터(OpenAI Usage Monitor)의 기능 확장 및 사용성 개선을 위한 기술 설계서입니다.

사용자의 피드백을 반영하여 다음 핵심 요구사항을 구현합니다:
1. **모니터 창 계속 유지 (Pin Mode):** 창 상단 핀(📌) 버튼을 통해 외부 클릭(blur) 시에도 창이 닫히지 않고 최상위 고정 유지.
2. **모니터 창 드래그 이동:** 상단 헤더 영역 마우스 드래그를 통해 화면 어디든 자유롭게 이동.
3. **다크 / 라이트 테마 전환:** 헤더 상단 원클릭 ☀️/🌙 토글 버튼 및 CSS 변수 기반 완벽한 테마 전환.
4. **계정 로그아웃 및 다른 계정으로 로그인:** 각 계정 카드별 독립 로그아웃 지원, 로그아웃 후 즉시 해당 카드에서 다른 계정 재연동.
5. **동적 다중 계정 추가 (N개 계정 지원):** 고정 2계정 구조를 벗어나 3개 이상의 계정을 동적으로 추가/삭제 가능한 확장형 스크롤 대시보드 구축.
6. **단일 실행 파일 및 프로세스명 변경 (`OpenAI_Usage_Monitor.exe`):** 터미널 명령어(`npm start`) 대신 윈도우 탐색기에서 더블클릭으로 바로 실행되며, 작업 관리자에서도 'Electron'이 아닌 'OpenAI_Usage_Monitor'로 표시되는 독립 실행 환경 제공.

---

## 2. 아키텍처 및 세부 컴포넌트 설계

### 2.1 윈도우 창 제어 (고정 핀 & 마우스 드래그)
* **드래그 이동:**
  * 상단 헤더 영역(`.header`)에 `-webkit-app-region: drag` 스타일 적용.
  * 내부 인터랙티브 요소(핀 버튼, 테마 토글, 새로고침, 설정, 닫기 버튼 등)는 `-webkit-app-region: no-drag` 적용.
  * 윈도우 생성 옵션에 `movable: true` 적용.
* **창 고정 모드 (Pin Mode):**
  * 헤더 좌측/우측에 📌 아이콘 버튼 배치.
  * 렌더러에서 토글 시 `set-pin-mode(isPinned)` IPC 호출.
  * Electron 메인 프로세스는 `isPinned` 상태를 관리하며, `blur` 이벤트 핸들러에서 `if (!isPinned) mainWindow.hide();`로 분기 처리.
  * 핀 활성화 시 닫기 버튼(`✕`)을 제공하여 원하는 시점에 트레이로 즉시 숨김 가능.
* **열림 위치 기본 동작:**
  * 트레이 아이콘을 클릭하여 창을 열 때는 항상 트레이 아이콘 위치에 맞추어 열리며, 열린 이후 사용자가 원하는 위치로 드래그하여 배치 가능.

### 2.2 다크 / 라이트 테마 시스템
* **CSS 토큰 설계 (`src/ui/style.css`):**
  * `:root` (기본 다크 테마) 및 `[data-theme="light"]` (라이트 테마) 지원.
  * CSS 변수 매핑:
    * `--bg-primary`: `#18181b` (다크) / `#f8fafc` (라이트)
    * `--bg-card`: `#27272a` (다크) / `#ffffff` (라이트)
    * `--border-color`: `#3f3f46` (다크) / `#e2e8f0` (라이트)
    * `--text-primary`: `#f4f4f5` (다크) / `#0f172a` (라이트)
    * `--text-secondary`: `#a1a1aa` (다크) / `#64748b` (라이트)
    * 게이지 및 뱃지 색상은 가독성을 유지하면서 명도 조절.
* **런타임 전환 및 저장:**
  * 헤더 상단에 ☀️ / 🌙 토글 버튼 배치.
  * 클릭 시 `document.documentElement.dataset.theme = newTheme` 즉시 적용.
  * `save-config` IPC를 통해 `config.json`의 `theme` 속성에 저장되어 다음 실행 시 복원.

### 2.3 동적 슬롯 데이터 모델 및 계정 세션 관리
* **데이터 모델 확장 (`src/config.js`):**
  * `config.json` 구조 확장:
    ```json
    {
      "slots": ["slot1", "slot2", "slot3"],
      "pollIntervalMinutes": 5,
      "alertThresholdPercent": 10,
      "notifyOnReset": true,
      "startOnBoot": false,
      "theme": "dark"
    }
    ```
  * 하위 호환성: 기존 `slot1.json`, `slot2.json` 및 `profiles/slot1`, `profiles/slot2`는 그대로 승계.
  * `getSlots()`: 현재 등록된 모든 슬롯 ID 목록 반환.
  * `addSlot()`: 새 슬롯(`slotN`)을 등록하고 빈 슬롯 상태 파일 초기화.
  * `removeSlot(slotId)`: 3개 이상의 슬롯 중 사용하지 않는 슬롯 삭제 (단, 최소 2개 슬롯 유지 가능).
  * `logoutSlot(slotId)`: 슬롯의 `auth.json` 및 세션 토큰 삭제, 슬롯 상태 파일은 빈 슬롯(미연동) 상태로 초기화.
* **OpenAI 인증 격리 (`src/auth.js`):**
  * 동적 슬롯 ID(`slotId`)를 지원하도록 `getSlotCodexHome(slotId)` 경로 바인딩.
  * `startOAuthLoginFlow(slotId)`: 지정된 슬롯 디렉터리로 Codex OAuth 플로우 실행.
  * `logoutSlot(slotId)`: 해당 슬롯 프로필 디렉터리의 토큰 파일 파기 및 캐시 삭제.
* **백그라운드 폴러 (`src/poller.js`):**
  * `config.slots`에 등록된 모든 활성 슬롯을 병렬 조회하여 통합된 데이터 브로드캐스트.
  * 계정별 알림 중복 방지 상태(`notifiedWindows`)도 슬롯 ID 단위로 격리 관리.

### 2.4 UI 대시보드 컴포넌트 개선 (`src/ui/`)
* **스크롤 가능한 슬롯 카드 컨테이너:**
  * 카드가 3개 이상 등록되어도 창 크기가 비정상적으로 커지지 않도록 세로 스크롤 레이아웃 구축.
  * 모던 다크/라이트 커스텀 스크롤바 디자인 적용.
* **계정 카드 뷰:**
  * **연동 완료 상태:**
    * 계정 이메일, 플랜 뱃지 (Plus / Pro), 새로고침 상태.
    * 5시간 Primary Window 게이지 및 실시간 카운트다운 타이머.
    * 7일 Secondary Window 게이지 및 실시간 카운트다운 타이머.
    * `[로그아웃]` 버튼 제공.
  * **미연동 상태 (로그아웃 후 또는 신규 슬롯):**
    * `[+ 계정 로그인하기]` 버튼.
    * 3개 이상 추가된 슬롯인 경우 `[카드 삭제]` 휴지통 버튼 제공.
* **하단 액션 영역:**
  * `[+ 새 계정 추가]` 버튼: 클릭 시 새 슬롯 카드가 추가되고 즉시 로그인 안내.

### 2.5 단일 실행 파일 및 프로세스명 변경 (`OpenAI_Usage_Monitor.exe`)
* **실행 파일 빌드 전략:**
  * `@electron/packager` 또는 내장 바이너리 커스터마이징 스크립트를 통해 Windows PE 헤더와 바이너리명을 `OpenAI_Usage_Monitor.exe`로 패키징.
  * Windows 아이콘(`assets/icon.ico`)을 실행 파일 리소스에 적용.
  * 결과물: `dist/OpenAI_Usage_Monitor-win32-x64/OpenAI_Usage_Monitor.exe` (또는 프로젝트 루트 바로가기/포터블 exe).
* **작업 관리자 표시 효과:**
  * 프로세스명: **`OpenAI_Usage_Monitor`**
  * 이미지명: **`OpenAI_Usage_Monitor.exe`**
* **탐색기 실행 지원:**
  * 프로젝트 루트에 원클릭 실행 런처 (`OpenAI_Usage_Monitor.exe` 또는 무창 바로가기)를 생성하여 윈도우 탐색기에서 더블클릭만으로 즉시 구동.

---

## 3. 신규 IPC 인터페이스 명세

| IPC 채널 | 방향 | 페이로드 | 반환값 | 설명 |
|---|---|---|---|---|
| `set-pin-mode` | Renderer -> Main | `{ isPinned: boolean }` | `{ success: boolean, isPinned: boolean }` | 팝업 창 항상 고정 모드 설정 |
| `get-pin-mode` | Renderer -> Main | 없음 | `{ isPinned: boolean }` | 현재 고정 모드 상태 조회 |
| `close-window` | Renderer -> Main | 없음 | `{ success: boolean }` | 창을 트레이로 숨김 (✕ 버튼 클릭 시) |
| `set-theme` | Renderer -> Main | `{ theme: 'dark' \| 'light' }` | `{ success: boolean }` | 테마 설정 저장 |
| `logout-slot` | Renderer -> Main | `{ slotId: string }` | `{ success: boolean }` | 지정 슬롯 인증 해제 및 미연동 전환 |
| `add-slot` | Renderer -> Main | 없음 | `{ slotId: string, slots: string[] }` | 신규 슬롯 추가 |
| `remove-slot` | Renderer -> Main | `{ slotId: string }` | `{ success: boolean, slots: string[] }` | 슬롯 제거 |

---

## 4. 테스트 및 검증 계획

1. **설정 및 스토리지 단위 테스트 (`tests/config.test.js`):**
   * 동적 `slots` 배열 추가, 슬롯 추가(`addSlot`), 슬롯 삭제(`removeSlot`), 슬롯 로그아웃(`logoutSlot`) 검증.
   * 테마 설정 읽기/쓰기 검증.
2. **폴러 다중 슬롯 테스트 (`tests/poller.test.js`):**
   * 3개 이상 슬롯에 대한 순회 폴링 및 이벤트 발행 검증.
   * 슬롯 삭제 시 폴러 캐시 및 알림 상태 정상 정리 검증.
3. **UI 렌더러 테스트 (`tests/ui.test.js`):**
   * 다크/라이트 테마 클래스/데이터 속성 토글 검증.
   * 동적 카드 렌더링 및 미연동/연동 상태 전환 검증.
4. **Electron 메인 프로세스 통합 테스트 (`tests/integration.test.js`):**
   * 신규 IPC 채널 처리 및 윈도우 고정(pin) 플래그 동작 검증.
5. **실행 파일 빌드 검증:**
   * 패키징 스크립트 실행 후 `OpenAI_Usage_Monitor.exe` 생성 확인 및 프로세스명 확인.
