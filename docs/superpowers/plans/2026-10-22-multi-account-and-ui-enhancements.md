# 다중 계정 확장 및 UI/UX 개선 구현 계획서 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 다중 계정 동적 확장(N개 계정), 계정별 로그아웃/재연동, 창 고정 핀(📌) 및 마우스 드래그 이동, 다크/라이트 테마 전환, 그리고 윈도우 탐색기 직접 실행용 `OpenAI_Usage_Monitor.exe` 바이너리/런처를 구축합니다.

**Architecture:** 기존 2슬롯 격리 구조를 동적 슬롯 배열(`slots: ['slot1', 'slot2', ...]`) 모델로 확장하고, Electron 창 제어(핀 모드, blur 방지, 드래그 영역)와 CSS 테마 변수를 추가하며, 독립 실행형 포터블 바이너리 패키징 스크립트를 작성합니다.

**Tech Stack:** Node.js (v24 내장 test runner, child_process, fs/promises), Electron (v45), HTML5 / CSS3 / ES6+, Windows Shell (vbs/ico).

**Spec:** [docs/superpowers/specs/2026-10-22-multi-account-and-ui-enhancements-design.md](file:///d:/Workspace/OpneAI_Usage_Monitor/docs/superpowers/specs/2026-10-22-multi-account-and-ui-enhancements-design.md)

## Global Constraints
- 모든 주석, UI 텍스트, 메뉴 레이블, 토스트 알림 메시지는 한국어로 작성합니다.
- 기존 슬롯 1(`slot1.json`, `profiles/slot1`) 및 슬롯 2의 데이터와 100% 하위 호환성을 유지합니다.
- TDD 원칙을 준수하여 단위/통합 테스트를 작성하고 `node --test tests/*.test.js`가 무결하게 통과해야 합니다.
- 계정 간 프로필 격리 원칙(독립된 `CODEX_HOME` 디렉터리)을 엄격히 준수합니다.

---

### Task 1: 동적 슬롯 스토리지 및 테마 환경설정 확장 (`src/config.js`, `src/auth.js`)

**Files:**
- Modify: `src/config.js`
- Modify: `src/auth.js`
- Test: `tests/config.test.js`

**Interfaces:**
- Consumes: `getConfig()`, `updateConfig()`, `getSlot()`, `saveSlot()`
- Produces: 
  - `getSlots(): Promise<string[]>`
  - `addSlot(): Promise<{ slotId: string, slots: string[] }>`
  - `removeSlot(slotId: string): Promise<{ success: boolean, slots: string[] }>`
  - `logoutSlot(slotId: string): Promise<{ success: boolean }>`

- [ ] **Step 1: 동적 슬롯 및 로그아웃 실패 테스트 작성**

`tests/config.test.js`에 다음 테스트들을 추가합니다:
```javascript
test('getSlots returns default [slot1, slot2] if slots not set', async () => {
  const slots = await getSlots();
  assert.deepStrictEqual(slots, ['slot1', 'slot2']);
});

test('addSlot appends a new slot and initializes empty slot file', async () => {
  const result = await addSlot();
  assert.strictEqual(result.slotId, 'slot3');
  assert.deepStrictEqual(result.slots, ['slot1', 'slot2', 'slot3']);
  const slot3Data = await getSlot('slot3');
  assert.strictEqual(slot3Data.linked, false);
});

test('removeSlot deletes specified slot when > 2 slots exist', async () => {
  await addSlot(); // slot3
  const res = await removeSlot('slot3');
  assert.strictEqual(res.success, true);
  const slots = await getSlots();
  assert.strictEqual(slots.includes('slot3'), false);
});

test('logoutSlot clears tokens and resets slot to unlinked', async () => {
  await saveSlot('slot1', { email: 'test@example.com', tokens: { access_token: 'abc' } });
  const result = await logoutSlot('slot1');
  assert.strictEqual(result.success, true);
  const slot = await getSlot('slot1');
  assert.strictEqual(slot.linked, false);
  assert.strictEqual(slot.email, null);
  assert.strictEqual(slot.tokens, null);
});

test('updateConfig saves theme: "light" properly', async () => {
  const cfg = await updateConfig({ theme: 'light' });
  assert.strictEqual(cfg.theme, 'light');
});
```

- [ ] **Step 2: 테스트 실행하여 실패 확인**

Run: `node --test tests/config.test.js`
Expected: FAIL (`addSlot`, `removeSlot`, `logoutSlot`, `getSlots` is not a function)

- [ ] **Step 3: `src/config.js` 및 `src/auth.js`에 동적 슬롯 함수 구현**

`src/config.js`에 `getSlots`, `addSlot`, `removeSlot`, `logoutSlot`을 구현하고 export합니다:
- `DEFAULT_CONFIG`에 `theme: 'dark'`, `slots: ['slot1', 'slot2']` 포함.
- `getSlots()`: config의 `slots` 배열 반환.
- `addSlot()`: `slots`에서 가장 큰 번호를 찾아 다음 슬롯 ID(예: `slot3`) 생성 후 config에 추가 및 빈 슬롯 파일 생성.
- `removeSlot(slotId)`: 2개 초과일 때 config `slots`에서 제거하고 해당 슬롯 파일 및 프로필 정리.
- `logoutSlot(slotId)`: 해당 슬롯의 `tokens`, `email`, `usage`를 null로 초기화하고 `linked: false` 저장. 또한 `auth.logoutSlot(slotId)` 호출로 `profiles/<slotId>/auth.json` 제거.
`src/auth.js`에 `logoutSlot(slotId)` 함수 추가 (프로필 폴더 내 `auth.json` 안전 삭제).

- [ ] **Step 4: 테스트 실행하여 통과 확인**

Run: `node --test tests/config.test.js`
Expected: PASS

- [ ] **Step 5: 변경사항 커밋**

```bash
git add src/config.js src/auth.js tests/config.test.js
git commit -m "feat(config): support dynamic slot management, slot logout, and theme configuration"
```

---

### Task 2: 백그라운드 폴러 동적 다중 슬롯 순회 지원 (`src/poller.js`)

**Files:**
- Modify: `src/poller.js`
- Test: `tests/poller.test.js`

**Interfaces:**
- Consumes: `getSlots()`, `getSlot()`, `saveSlot()`, `fetchUsage()`
- Produces: `pollAllSlots(): Promise<Record<string, object>>`, `getLatestPollResult()`

- [ ] **Step 1: 다중 슬롯 폴링 실패 테스트 작성**

`tests/poller.test.js`에 동적 N개 슬롯 폴링 테스트를 작성합니다:
```javascript
test('pollAllSlots iterates over all slots returned by getSlots()', async () => {
  // getSlots mocks ['slot1', 'slot2', 'slot3']
  const result = await poller.pollAllSlots();
  assert.ok(result.slot1);
  assert.ok(result.slot2);
  assert.ok(result.slot3);
});

test('cleanupRemovedSlots removes notifiedWindows for deleted slots', () => {
  poller.recordWindowNotified('slot3', 'primary', 12345);
  poller.cleanupSlot('slot3');
  assert.strictEqual(poller.hasNotifiedWindow('slot3', 'primary', 12345), false);
});
```

- [ ] **Step 2: 테스트 실행하여 실패 확인**

Run: `node --test tests/poller.test.js`
Expected: FAIL

- [ ] **Step 3: `src/poller.js` 다중 슬롯 폴링 구현**

`src/poller.js`의 `pollAllSlots`에서 하드코딩된 `['slot1', 'slot2']` 대신 `await configModule.getSlots()`를 사용하여 모든 슬롯을 순회하도록 수정. 슬롯별 알림 상태 정리용 `cleanupSlot(slotId)` 구현.

- [ ] **Step 4: 테스트 실행하여 통과 확인**

Run: `node --test tests/poller.test.js`
Expected: PASS

- [ ] **Step 5: 변경사항 커밋**

```bash
git add src/poller.js tests/poller.test.js
git commit -m "feat(poller): adapt poller scheduler for dynamic N-slot polling"
```

---

### Task 3: 프론트엔드 UI 대시보드 개선 (창 고정 핀, 드래그 영역, 다크/라이트 테마, 동적 카드, 로그아웃) (`src/ui/`)

**Files:**
- Modify: `src/ui/index.html`
- Modify: `src/ui/style.css`
- Modify: `src/ui/renderer.js`
- Test: `tests/ui.test.js`

**Interfaces:**
- HTML/CSS:
  - `-webkit-app-region: drag` (헤더 드래그 이동)
  - `-webkit-app-region: no-drag` (버튼 요소)
  - `data-theme="light"` 스타일 정의
  - `#cardsContainer` (가변 계정 카드 스크롤 컨테이너)
  - `#pinBtn` (📌 고정 토글 버튼)
  - `#themeBtn` (☀️/🌙 테마 토글 버튼)
  - `#closeBtn` (✕ 닫기 버튼)
  - `#addSlotBtn` (`[+ 새 계정 추가]` 버튼)
- JS:
  - `togglePinMode()`, `toggleTheme()`, `handleLogout(slotId)`, `handleAddSlot()`, `handleDeleteSlot(slotId)`

- [ ] **Step 1: UI 렌더러 실패 테스트 작성**

`tests/ui.test.js`에 다음 테스트를 추가합니다:
```javascript
test('toggleTheme switches between dark and light themes', () => {
  const current = 'dark';
  const next = getNextTheme(current);
  assert.strictEqual(next, 'light');
});

test('renderSlots generates cards for arbitrary number of slots', () => {
  const slotsData = {
    slot1: { linked: true, email: 'a@test.com' },
    slot2: { linked: false },
    slot3: { linked: true, email: 'c@test.com' }
  };
  const html = generateSlotsHtml(slotsData);
  assert.ok(html.includes('slot1'));
  assert.ok(html.includes('slot2'));
  assert.ok(html.includes('slot3'));
  assert.ok(html.includes('로그아웃'));
});
```

- [ ] **Step 2: 테스트 실행하여 실패 확인**

Run: `node --test tests/ui.test.js`
Expected: FAIL

- [ ] **Step 3: HTML, CSS, 렌더러 구현**

1. `src/ui/index.html`:
   - 헤더에 `pinBtn` (📌), `themeBtn` (☀️/🌙), `refreshBtn` (🔄), `settingsBtn` (⚙️), `closeBtn` (✕) 배치.
   - 고정된 2개 슬롯 마크업 대신 동적 컨테이너 `<div id="cardsContainer" class="cards-container"></div>` 배치.
   - 카드 컨테이너 하단에 `<button id="addSlotBtn" class="btn-add-slot">+ 새 계정 추가</button>` 배치.
2. `src/ui/style.css`:
   - 헤더에 `-webkit-app-region: drag;` 적용. 버튼들에 `-webkit-app-region: no-drag;` 적용.
   - `[data-theme="light"]`에 대한 화이트 배경, 그레이 카드, 텍스트 컬러 CSS 변수 세트 정의.
   - `.cards-container`: 최대 높이(`calc(100vh - 120px)`), `overflow-y: auto`, 슬림 모던 스크롤바 스타일 적용.
   - 카드 헤더에 `[로그아웃]` 버튼 및 `[카드 삭제]` 버튼 스타일 추가.
3. `src/ui/renderer.js`:
   - 테마 토글 이벤트 리스너: `document.documentElement.dataset.theme` 전환 및 `window.electronAPI.setTheme` 호출.
   - 핀 토글 이벤트 리스너: 활성화 시 버튼 강조 스타일 및 `window.electronAPI.setPinMode` 호출.
   - 닫기 버튼 이벤트 리스너: `window.electronAPI.closeWindow` 호출.
   - 동적 카드 렌더링: 슬롯 데이터를 받아 순회하며 각 슬롯의 연동/미연동 카드 렌더링.
   - 각 카드의 `[로그아웃]` 클릭 시 확인 대화상자 후 `window.electronAPI.logoutSlot(slotId)` 호출.
   - `[+ 새 계정 추가]` 클릭 시 `window.electronAPI.addSlot()` 호출.

- [ ] **Step 4: 테스트 실행하여 통과 확인**

Run: `node --test tests/ui.test.js`
Expected: PASS

- [ ] **Step 5: 변경사항 커밋**

```bash
git add src/ui/index.html src/ui/style.css src/ui/renderer.js tests/ui.test.js
git commit -m "feat(ui): add window pinning, header drag, light theme, and dynamic card list"
```

---

### Task 4: Electron 메인 프로세스 및 IPC 연동 (`src/main.js`, `src/preload.js`)

**Files:**
- Modify: `src/main.js`
- Modify: `src/preload.js`
- Test: `tests/integration.test.js`

**Interfaces:**
- IPC Channels:
  - `set-pin-mode`, `get-pin-mode`, `close-window`, `set-theme`, `logout-slot`, `add-slot`, `remove-slot`
- Main behavior:
  - `mainWindow.on('blur')`: `isPinned`가 참이면 `mainWindow.hide()`를 호출하지 않음.
  - `mainWindow` 옵션에 `movable: true` 설정.

- [ ] **Step 1: 통합 테스트 작성**

`tests/integration.test.js`에 신규 IPC 채널 및 preload 브리지 정의 테스트를 추가합니다:
```javascript
test('preload exposes new APIs: setPinMode, getPinMode, closeWindow, setTheme, logoutSlot, addSlot, removeSlot', () => {
  // verify preload.js definitions
});

test('IPC handlers register set-pin-mode, logout-slot, add-slot, remove-slot, set-theme', () => {
  // verify main.js IPC registrations
});
```

- [ ] **Step 2: 테스트 실행하여 실패 확인**

Run: `node --test tests/integration.test.js`
Expected: FAIL

- [ ] **Step 3: `src/preload.js` 및 `src/main.js` 구현**

1. `src/preload.js`:
   - `electronAPI`에 `setPinMode`, `getPinMode`, `closeWindow`, `setTheme`, `logoutSlot`, `addSlot`, `removeSlot` 노출.
2. `src/main.js`:
   - 변수 `let isPinned = false;` 추가.
   - `createWindow()`에서 `movable: true` 명시.
   - `mainWindow.on('blur')`에서 `if (!isPinned) mainWindow.hide();`로 변경.
   - 신규 IPC 핸들러 등록:
     - `set-pin-mode`: `isPinned = Boolean(payload.isPinned); mainWindow.setAlwaysOnTop(isPinned);`
     - `get-pin-mode`: `return { isPinned };`
     - `close-window`: `mainWindow.hide();`
     - `set-theme`: `await configModule.updateConfig({ theme: payload.theme });`
     - `logout-slot`: `await configModule.logoutSlot(slotId); await poller.pollAllSlots();`
     - `add-slot`: `const res = await configModule.addSlot(); return res;`
     - `remove-slot`: `const res = await configModule.removeSlot(slotId); poller.cleanupSlot(slotId); return res;`

- [ ] **Step 4: 테스트 실행하여 통과 확인**

Run: `node --test tests/*.test.js`
Expected: ALL PASS

- [ ] **Step 5: 변경사항 커밋**

```bash
git add src/main.js src/preload.js tests/integration.test.js
git commit -m "feat(main): integrate pin mode, window controls, and dynamic slot ipc handlers"
```

---

### Task 5: 단일 실행 바이너리 패키징 및 윈도우 탐색기 직접 실행기 구성 (`package.json`, `scripts/build-portable.js`, `OpenAI_Usage_Monitor.vbs`)

**Files:**
- Create: `OpenAI_Usage_Monitor.vbs`
- Create: `scripts/build-portable.js`
- Create: `scripts/create-shortcut.js`
- Modify: `package.json`

**Interfaces:**
- Produces:
  - `OpenAI_Usage_Monitor.vbs`: 윈도우 탐색기에서 더블클릭 시 검은 콘솔창 없이 백그라운드 트레이로 즉시 실행.
  - `npm run build`: `OpenAI_Usage_Monitor.exe` 단일 실행 파일 생성.
  - `npm run shortcut`: 바탕화면에 아이콘이 지정된 바로가기 파일 생성.

- [ ] **Step 1: 무창 VBScript 런처 작성 (`OpenAI_Usage_Monitor.vbs`)**

프로젝트 루트에 탐색기 더블클릭 전용 VBScript를 생성합니다:
```vbscript
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
strPath = fso.GetParentFolderName(WScript.ScriptFullName)

' electron.exe 경로 탐색 (로컬 또는 node_modules)
strExe = strPath & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(strExe) Then
    strExe = "electron"
End If

' 0 = 창 숨김 (검은 콘솔창 없이 무음 백그라운드 실행)
WshShell.CurrentDirectory = strPath
WshShell.Run """" & strExe & """ .", 0, False
```

- [ ] **Step 2: 바탕화면 바로가기 생성기 작성 (`scripts/create-shortcut.js`)**

PowerShell 또는 WScript.Shell을 활용하여 바탕화면에 전용 아이콘(`assets/icon.ico`)이 포함된 `OpenAI 사용량 모니터.lnk`를 생성하는 스크립트 작성.

- [ ] **Step 3: 포터블 바이너리 빌드 스크립트 작성 (`scripts/build-portable.js`) 및 `package.json` 등록**

`scripts/build-portable.js` 작성:
- `@electron/packager`를 사용하거나 `electron.exe` 바이너리를 `OpenAI_Usage_Monitor.exe`로 복사/패키징하여 작업 관리자에서 `OpenAI_Usage_Monitor.exe`로 표시되도록 구성.
- `package.json` scripts에 `"build": "node scripts/build-portable.js"`, `"shortcut": "node scripts/create-shortcut.js"` 추가.

- [ ] **Step 4: 빌드 및 바로가기 스크립트 검증**

Run: `node scripts/create-shortcut.js`
Expected: 바탕화면에 바로가기 생성 확인.
Run: `node --test tests/*.test.js`
Expected: ALL PASS.

- [ ] **Step 5: 변경사항 커밋**

```bash
git add OpenAI_Usage_Monitor.vbs scripts/ package.json
git commit -m "feat(launcher): add explorer vbs launcher, desktop shortcut generator, and portable build scripts"
```

---

## Plan Self-Review Checklist

1. **Spec coverage:** 
   - 1. 모니터 창 계속 유지 기능 -> Task 3 & 4 (Pin button, IPC, blur bypass)
   - 2. 모니터 창 이동 기능 -> Task 3 & 4 (`-webkit-app-region: drag`, `movable: true`)
   - 3. 테마 변경 -> Task 1, 3, 4 (`theme: 'light'`, CSS 변수, ☀️/🌙 토글)
   - 4. 계정 로그아웃 및 다른 계정 로그인 -> Task 1, 3, 4 (`logoutSlot`, 미연동 카드 유지)
   - 5. 동적 계정 추가 -> Task 1, 2, 3, 4 (`slots` 배열, `addSlot`, `removeSlot`, 카드 스크롤)
   - 6. 프로세스명 및 탐색기 실행 -> Task 5 (`OpenAI_Usage_Monitor.vbs`, `scripts/build-portable.js`)
2. **Placeholder scan:** TODO / TBD 없음.
3. **Type consistency:** `getSlots`, `addSlot`, `removeSlot`, `logoutSlot`, `isPinned`, `theme` 등 모든 명칭 일치.
