/**
 * tests/integration.test.js
 * 
 * OpenAI 사용량 모니터 - 메인 프로세스, 트레이 팝업, IPC 브릿지 통합 테스트
 * 
 * 테스트 항목:
 * 1. Preload 보안 브릿지 (exposeElectronApi):
 *    - contextBridge 노출 객체 구조 및 렌더러 호환 메서드 무결성
 *    - IPC 채널 매핑 (invoke 채널 일치성 및 인자 전달)
 *    - 백그라운드 이벤트 구독 (onUsageUpdate / onUsageUpdated 리스너 등록 및 해제)
 * 2. 시스템 트레이 위치 계산 엔진 (calculateWindowPosition):
 *    - 하단/상단/우측/좌측 작업표시줄 자동 감지 및 팝업 정렬
 *    - 화면 경계 오버플로우 방지 및 안전 클램핑
 *    - 트레이 바운드 미제공 시 안전 폴백 좌표
 * 3. 트레이 컨텍스트 메뉴 템플릿 (createTrayMenuTemplate):
 *    - 필수 메뉴 항목(열기, 새로고침, 자동 실행, 종료) 및 콜백 동작
 * 4. 메인 프로세스 IPC 핸들러 (registerIpcHandlers):
 *    - 7개 채널 (get-usage, refresh-now, login-slot, cancel-login, get-config, save-config, open-external) 등록
 *    - 각 핸들러 실행 시 모듈 위임 및 결과 반환 무결성
 *    - 로그인 중복 방지 및 취소 프로세스 제어
 *    - 환경설정 저장 시 부팅 시작 및 폴러 주기 동적 반영
 *    - 외부 링크 열기 시 안전 프로토콜 검증
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');

const { exposeElectronApi } = require('../src/preload.js');
const {
  calculateWindowPosition,
  createTrayMenuTemplate,
  registerIpcHandlers,
  getPinState,
  setPinState,
} = require('../src/main.js');

// ============================================================================
// 테스트 스위트 1: Preload 보안 브릿지 (contextBridge & IPC 매핑)
// ============================================================================

describe('Preload 보안 브릿지 (src/preload.js)', () => {
  let mockBridge;
  let mockIpc;
  let exposedApi;
  const invokeCalls = [];
  const eventListeners = new Map();

  beforeEach(() => {
    invokeCalls.length = 0;
    eventListeners.clear();

    mockIpc = {
      invoke: async (channel, ...args) => {
        invokeCalls.push({ channel, args });
        return { channel, args, mockSuccess: true };
      },
      on: (channel, listener) => {
        if (!eventListeners.has(channel)) {
          eventListeners.set(channel, new Set());
        }
        eventListeners.get(channel).add(listener);
      },
      removeListener: (channel, listener) => {
        if (eventListeners.has(channel)) {
          eventListeners.get(channel).delete(listener);
        }
      },
    };

    mockBridge = {
      exposeInMainWorld: (apiKey, api) => {
        if (apiKey === 'electronAPI') {
          exposedApi = api;
        }
      },
    };
  });

  it('contextBridge.exposeInMainWorld를 통해 electronAPI를 안전하게 노출해야 한다', () => {
    const result = exposeElectronApi(mockBridge, mockIpc);
    assert.ok(result);
    assert.strictEqual(exposedApi, result);

    // 필수 API 함수 목록 검증
    assert.strictEqual(typeof exposedApi.getUsage, 'function');
    assert.strictEqual(typeof exposedApi.refreshNow, 'function');
    assert.strictEqual(typeof exposedApi.refreshUsage, 'function');
    assert.strictEqual(typeof exposedApi.loginSlot, 'function');
    assert.strictEqual(typeof exposedApi.startLoginSlot2, 'function');
    assert.strictEqual(typeof exposedApi.loginSlot2, 'function');
    assert.strictEqual(typeof exposedApi.cancelLogin, 'function');
    assert.strictEqual(typeof exposedApi.cancelLoginSlot2, 'function');
    assert.strictEqual(typeof exposedApi.getConfig, 'function');
    assert.strictEqual(typeof exposedApi.saveConfig, 'function');
    assert.strictEqual(typeof exposedApi.openExternal, 'function');
    assert.strictEqual(typeof exposedApi.onUsageUpdate, 'function');
    assert.strictEqual(typeof exposedApi.onUsageUpdated, 'function');
    // 신규 추가 API (Task 4)
    assert.strictEqual(typeof exposedApi.setPinMode, 'function');
    assert.strictEqual(typeof exposedApi.getPinMode, 'function');
    assert.strictEqual(typeof exposedApi.closeWindow, 'function');
    assert.strictEqual(typeof exposedApi.setTheme, 'function');
    assert.strictEqual(typeof exposedApi.logoutSlot, 'function');
    assert.strictEqual(typeof exposedApi.addSlot, 'function');
    assert.strictEqual(typeof exposedApi.removeSlot, 'function');
  });

  it('각 API 호출 시 올바른 IPC 채널과 인자를 전달해야 한다', async () => {
    exposeElectronApi(mockBridge, mockIpc);

    // getUsage -> get-usage
    await exposedApi.getUsage();
    assert.strictEqual(invokeCalls[0].channel, 'get-usage');

    // refreshNow -> refresh-now
    await exposedApi.refreshNow();
    assert.strictEqual(invokeCalls[1].channel, 'refresh-now');

    // refreshUsage (별칭) -> refresh-now
    await exposedApi.refreshUsage();
    assert.strictEqual(invokeCalls[2].channel, 'refresh-now');

    // loginSlot -> login-slot
    await exposedApi.loginSlot('slot2');
    assert.strictEqual(invokeCalls[3].channel, 'login-slot');
    assert.deepStrictEqual(invokeCalls[3].args, ['slot2']);

    // startLoginSlot2 (별칭) -> login-slot with slot2
    await exposedApi.startLoginSlot2();
    assert.strictEqual(invokeCalls[4].channel, 'login-slot');
    assert.deepStrictEqual(invokeCalls[4].args, ['slot2']);

    // cancelLogin -> cancel-login
    await exposedApi.cancelLogin('slot2');
    assert.strictEqual(invokeCalls[5].channel, 'cancel-login');
    assert.deepStrictEqual(invokeCalls[5].args, ['slot2']);

    // getConfig -> get-config
    await exposedApi.getConfig();
    assert.strictEqual(invokeCalls[6].channel, 'get-config');

    // saveConfig -> save-config with patch
    const patch = { pollIntervalMinutes: 10 };
    await exposedApi.saveConfig(patch);
    assert.strictEqual(invokeCalls[7].channel, 'save-config');
    assert.deepStrictEqual(invokeCalls[7].args, [patch]);

    // openExternal -> open-external with url
    await exposedApi.openExternal('https://chatgpt.com');
    assert.strictEqual(invokeCalls[8].channel, 'open-external');
    assert.deepStrictEqual(invokeCalls[8].args, ['https://chatgpt.com']);

    // 신규 추가 API (Task 4)
    // setPinMode -> set-pin-mode
    await exposedApi.setPinMode({ isPinned: true });
    assert.strictEqual(invokeCalls[9].channel, 'set-pin-mode');
    assert.deepStrictEqual(invokeCalls[9].args, [{ isPinned: true }]);

    // getPinMode -> get-pin-mode
    await exposedApi.getPinMode();
    assert.strictEqual(invokeCalls[10].channel, 'get-pin-mode');
    assert.deepStrictEqual(invokeCalls[10].args, []);

    // closeWindow -> close-window
    await exposedApi.closeWindow();
    assert.strictEqual(invokeCalls[11].channel, 'close-window');
    assert.deepStrictEqual(invokeCalls[11].args, []);

    // setTheme -> set-theme
    await exposedApi.setTheme({ theme: 'light' });
    assert.strictEqual(invokeCalls[12].channel, 'set-theme');
    assert.deepStrictEqual(invokeCalls[12].args, [{ theme: 'light' }]);

    // logoutSlot -> logout-slot
    await exposedApi.logoutSlot('slot1');
    assert.strictEqual(invokeCalls[13].channel, 'logout-slot');
    assert.deepStrictEqual(invokeCalls[13].args, ['slot1']);

    // addSlot -> add-slot
    await exposedApi.addSlot();
    assert.strictEqual(invokeCalls[14].channel, 'add-slot');
    assert.deepStrictEqual(invokeCalls[14].args, []);

    // removeSlot -> remove-slot
    await exposedApi.removeSlot('slot3');
    assert.strictEqual(invokeCalls[15].channel, 'remove-slot');
    assert.deepStrictEqual(invokeCalls[15].args, ['slot3']);
  });

  it('onUsageUpdate는 usage-updated 이벤트를 구독하고 해제 함수를 정상 반환해야 한다', () => {
    exposeElectronApi(mockBridge, mockIpc);

    let receivedData = null;
    const unsubscribe = exposedApi.onUsageUpdate((data) => {
      receivedData = data;
    });

    assert.strictEqual(typeof unsubscribe, 'function');
    assert.strictEqual(eventListeners.get('usage-updated').size, 1);

    // 이벤트 브로드캐스트 모의 실행
    const dummyPayload = { timestamp: Date.now(), slot1: { success: true } };
    for (const listener of eventListeners.get('usage-updated')) {
      listener({}, dummyPayload);
    }
    assert.deepStrictEqual(receivedData, dummyPayload);

    // 해제 함수 호출
    unsubscribe();
    assert.strictEqual(eventListeners.get('usage-updated').size, 0);
  });

  it('onUsageUpdate에 함수가 아닌 값을 전달하면 TypeError를 던져야 한다', () => {
    exposeElectronApi(mockBridge, mockIpc);

    assert.throws(() => {
      exposedApi.onUsageUpdate(null);
    }, TypeError);

    assert.throws(() => {
      exposedApi.onUsageUpdated('not-a-function');
    }, TypeError);
  });
});

// ============================================================================
// 테스트 스위트 2: 트레이 팝업 위치 계산 엔진 (calculateWindowPosition)
// ============================================================================

describe('트레이 팝업 위치 계산 엔진 (calculateWindowPosition)', () => {
  const windowBounds = { width: 380, height: 530 };
  const displayBounds = { x: 0, y: 0, width: 1920, height: 1080 };

  it('하단 작업표시줄(기본 Windows): 트레이 아이콘 위쪽에 수평 중앙 정렬되어야 한다', () => {
    // 트레이가 화면 우하단 작업표시줄(y: 1040)에 위치할 때
    const trayBounds = { x: 1800, y: 1040, width: 24, height: 24 };
    const pos = calculateWindowPosition(trayBounds, windowBounds, displayBounds, { margin: 8 });

    // 수평 중앙 정렬: 1800 + 12 - 190 = 1622 -> 화면 최대 x(1920 - 380 = 1540)를 넘어가므로 1540으로 클램핑
    assert.strictEqual(pos.x, 1540);
    // 수직 배치: 트레이 위쪽 1040 - 530 - 8 = 502
    assert.strictEqual(pos.y, 502);
  });

  it('하단 작업표시줄 중앙 트레이(Windows 11): 클램핑 없이 정중앙에 위치해야 한다', () => {
    const trayBounds = { x: 960, y: 1040, width: 24, height: 24 };
    const pos = calculateWindowPosition(trayBounds, windowBounds, displayBounds, { margin: 8 });

    // 960 + 12 - 190 = 782
    assert.strictEqual(pos.x, 782);
    assert.strictEqual(pos.y, 502);
  });

  it('상단 작업표시줄: 트레이 아이콘 아래쪽에 배치되어야 한다', () => {
    const trayBounds = { x: 1800, y: 10, width: 24, height: 24 };
    const pos = calculateWindowPosition(trayBounds, windowBounds, displayBounds, { margin: 8 });

    assert.strictEqual(pos.x, 1540);
    // 트레이 아래쪽: 10 + 24 + 8 = 42
    assert.strictEqual(pos.y, 42);
  });

  it('우측 작업표시줄: 트레이 아이콘 왼쪽에 수직 중앙 정렬되어야 한다', () => {
    const trayBounds = { x: 1880, y: 500, width: 40, height: 40 };
    const pos = calculateWindowPosition(trayBounds, windowBounds, displayBounds, { margin: 8 });

    // 트레이 왼쪽: 1880 - 380 - 8 = 1492
    assert.strictEqual(pos.x, 1492);
    // 수직 중앙: 500 + 20 - 265 = 255
    assert.strictEqual(pos.y, 255);
  });

  it('좌측 작업표시줄: 트레이 아이콘 오른쪽에 수직 중앙 정렬되어야 한다', () => {
    const trayBounds = { x: 0, y: 500, width: 40, height: 40 };
    const pos = calculateWindowPosition(trayBounds, windowBounds, displayBounds, { margin: 8 });

    // 트레이 오른쪽: 0 + 40 + 8 = 48
    assert.strictEqual(pos.x, 48);
    assert.strictEqual(pos.y, 255);
  });

  it('트레이 정보가 없거나 0인 경우 화면 우하단 안전 폴백 좌표를 반환해야 한다', () => {
    const posNull = calculateWindowPosition(null, windowBounds, displayBounds, { margin: 8 });
    assert.strictEqual(posNull.x, 1920 - 380 - 8);
    assert.strictEqual(posNull.y, 1080 - 530 - 8);

    const posZero = calculateWindowPosition({ x: 0, y: 0, width: 0, height: 0 }, windowBounds, displayBounds, { margin: 8 });
    assert.strictEqual(posZero.x, 1920 - 380 - 8);
    assert.strictEqual(posZero.y, 1080 - 530 - 8);
  });

  it('화면 왼쪽 또는 상단 경계를 벗어나는 극단적 좌표도 화면 내로 안전하게 클램핑해야 한다', () => {
    const trayBounds = { x: -50, y: 1040, width: 24, height: 24 };
    const pos = calculateWindowPosition(trayBounds, windowBounds, displayBounds, { margin: 8 });

    // minX = 0
    assert.strictEqual(pos.x, 0);
  });
});

// ============================================================================
// 테스트 스위트 3: 트레이 컨텍스트 메뉴 템플릿 (createTrayMenuTemplate)
// ============================================================================

describe('트레이 컨텍스트 메뉴 템플릿 (createTrayMenuTemplate)', () => {
  it('열기, 새로고침, 시작 시 자동 실행, 종료 메뉴 항목을 올바르게 포함해야 한다', () => {
    let opened = false;
    let refreshed = false;
    let toggledValue = null;
    let quitted = false;

    const template = createTrayMenuTemplate({
      onOpen: () => { opened = true; },
      onRefresh: () => { refreshed = true; },
      onToggleStartOnBoot: (val) => { toggledValue = val; },
      onQuit: () => { quitted = true; },
      startOnBoot: true,
    });

    assert.ok(Array.isArray(template));
    assert.strictEqual(template.length, 6); // 열기, 새로고침, sep, 자동실행, sep, 종료

    // 1. 열기
    assert.strictEqual(template[0].label, '열기');
    template[0].click();
    assert.strictEqual(opened, true);

    // 2. 새로고침
    assert.strictEqual(template[1].label, '지금 새로고침');
    template[1].click();
    assert.strictEqual(refreshed, true);

    // 3. 구분선
    assert.strictEqual(template[2].type, 'separator');

    // 4. 시작 시 자동 실행 체크박스
    assert.strictEqual(template[3].label, '시작 시 자동 실행');
    assert.strictEqual(template[3].type, 'checkbox');
    assert.strictEqual(template[3].checked, true);
    template[3].click({ checked: false });
    assert.strictEqual(toggledValue, false);

    // 5. 구분선
    assert.strictEqual(template[4].type, 'separator');

    // 6. 종료
    assert.strictEqual(template[5].label, '종료');
    template[5].click();
    assert.strictEqual(quitted, true);
  });
});

// ============================================================================
// 테스트 스위트 4: IPC 핸들러 등록 및 실행 통합 (registerIpcHandlers)
// ============================================================================

describe('메인 프로세스 IPC 핸들러 통합 (registerIpcHandlers)', () => {
  const handlers = new Map();
  let mockIpcMain;
  let mockPollerModule;
  let mockAuthModule;
  let mockConfigModule;
  let mockShellModule;
  let mockAppInstance;
  let mockPollerInstance;
  let mockMainWindow;
  let mockIsPinned;
  let initialPoller;
  let activeLogins;
  let broadcastedData = null;
  let trayMenuUpdated = false;

  beforeEach(() => {
    handlers.clear();
    broadcastedData = null;
    trayMenuUpdated = false;
    activeLogins = new Map();
    mockIsPinned = false;

    mockMainWindow = {
      isDestroyed: () => false,
      hide: () => { mockMainWindow.hidden = true; },
      setAlwaysOnTop: (flag) => { mockMainWindow.alwaysOnTop = flag; },
    };

    mockIpcMain = {
      handle: (channel, fn) => {
        handlers.set(channel, fn);
      },
    };

    initialPoller = {
      pollNow: async () => ({ source: 'pollerInstance.pollNow' }),
      stop: () => { initialPoller.stopped = true; },
    };
    mockPollerInstance = initialPoller;

    mockPollerModule = {
      getLatestPollResult: () => null,
      pollAllSlots: async () => ({ source: 'pollerModule.pollAllSlots' }),
      startPolling: (interval, cb) => ({
        interval,
        pollNow: async () => ({ source: 'newPoller.pollNow' }),
        stop: () => {},
      }),
      cleanupSlot: (slotId) => { mockPollerModule.cleanedSlot = slotId; },
    };

    mockAuthModule = {
      startOAuthLoginFlow: (slotId) => {
        const child = {
          kill: (sig) => { child.killed = sig; },
        };
        const promise = Promise.resolve({ success: true, slotId });
        promise.childProcess = child;
        return promise;
      },
    };

    mockConfigModule = {
      normalizeSlotId: (s) => (String(s).includes('2') ? 'slot2' : 'slot1'),
      getConfig: async () => ({ pollIntervalMinutes: 5, startOnBoot: false }),
      updateConfig: async (patch) => ({ pollIntervalMinutes: 5, ...patch }),
      logoutSlot: async (slotId) => ({ success: true, slotId, loggedOut: true }),
      addSlot: async () => ({ slotId: 'slot3', slots: ['slot1', 'slot2', 'slot3'] }),
      removeSlot: async (slotId) => ({ success: true, removedSlot: slotId, slots: ['slot1', 'slot2'] }),
    };

    mockShellModule = {
      openExternal: async (url) => { mockShellModule.openedUrl = url; },
    };

    mockAppInstance = {
      setLoginItemSettings: (settings) => { mockAppInstance.loginSettings = settings; },
    };

    registerIpcHandlers({
      ipcMain: mockIpcMain,
      pollerModule: mockPollerModule,
      authModule: mockAuthModule,
      configModule: mockConfigModule,
      shellModule: mockShellModule,
      getPollerInstance: () => mockPollerInstance,
      setPollerInstance: (p) => { mockPollerInstance = p; },
      activeLogins,
      broadcastUsage: (d) => { broadcastedData = d; },
      updateTrayMenu: () => { trayMenuUpdated = true; },
      appInstance: mockAppInstance,
      getMainWindow: () => mockMainWindow,
      getPinState: () => mockIsPinned,
      setPinState: (v) => { mockIsPinned = Boolean(v); return mockIsPinned; },
    });
  });

  it('필수 IPC 채널(기존 7개 + 신규 7개)이 모두 등록되어야 한다', () => {
    const requiredChannels = [
      'get-usage',
      'refresh-now',
      'login-slot',
      'cancel-login',
      'get-config',
      'save-config',
      'open-external',
      'set-pin-mode',
      'get-pin-mode',
      'close-window',
      'set-theme',
      'logout-slot',
      'add-slot',
      'remove-slot',
    ];

    for (const channel of requiredChannels) {
      assert.ok(handlers.has(channel), `채널 [${channel}]이 등록되어 있어야 합니다.`);
      assert.strictEqual(typeof handlers.get(channel), 'function');
    }
  });

  it('get-usage: 캐시가 있으면 캐시를 반환하고, 없으면 pollAllSlots를 호출해야 한다', async () => {
    const getUsageHandler = handlers.get('get-usage');

    // 1. 캐시가 없을 때
    const resNoCache = await getUsageHandler();
    assert.deepStrictEqual(resNoCache, { source: 'pollerModule.pollAllSlots' });

    // 2. 캐시가 있을 때
    const cachedData = { cached: true, timestamp: 123456 };
    mockPollerModule.getLatestPollResult = () => cachedData;
    const resWithCache = await getUsageHandler();
    assert.deepStrictEqual(resWithCache, cachedData);
  });

  it('refresh-now: 활성 폴러가 있으면 pollNow()를 위임해야 한다', async () => {
    const refreshHandler = handlers.get('refresh-now');
    const res = await refreshHandler();
    assert.deepStrictEqual(res, { source: 'pollerInstance.pollNow' });
  });

  it('login-slot: 신규 로그인을 시작하고 activeLogins를 관리하며 결과를 반환해야 한다', async () => {
    const loginHandler = handlers.get('login-slot');

    const res = await loginHandler({}, 'slot2');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.slotId, 'slot2');
    // 완료 후 activeLogins에서 제거되었는지 확인
    assert.strictEqual(activeLogins.has('slot2'), false);
  });

  it('login-slot: 이미 진행 중인 슬롯에 대해 중복 로그인을 요청하면 에러를 던져야 한다', async () => {
    const loginHandler = handlers.get('login-slot');

    activeLogins.set('slot2', { pid: 9999 });

    await assert.rejects(async () => {
      await loginHandler({}, 'slot2');
    }, /로그인이 이미 진행 중입니다/);
  });

  it('cancel-login: 진행 중인 로그인이 있으면 childProcess를 종료하고 cancelled: true를 반환해야 한다', async () => {
    const cancelHandler = handlers.get('cancel-login');

    const mockChild = {
      kill: (sig) => { mockChild.killSignal = sig; },
    };
    activeLogins.set('slot2', mockChild);

    const res = await cancelHandler({}, 'slot2');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.cancelled, true);
    assert.strictEqual(mockChild.killSignal, 'SIGTERM');
    assert.strictEqual(activeLogins.has('slot2'), false);

    // 진행 중인 로그인이 없을 때
    const resNoOp = await cancelHandler({}, 'slot2');
    assert.strictEqual(resNoOp.success, true);
    assert.strictEqual(resNoOp.cancelled, false);
  });

  it('get-config: configModule.getConfig()의 결과를 반환해야 한다', async () => {
    const getConfigHandler = handlers.get('get-config');
    const res = await getConfigHandler();
    assert.strictEqual(res.pollIntervalMinutes, 5);
  });

  it('save-config: 설정을 업데이트하고 startOnBoot 및 폴러 주기를 동적 갱신해야 한다', async () => {
    const saveConfigHandler = handlers.get('save-config');

    const patch = {
      pollIntervalMinutes: 15,
      startOnBoot: true,
    };

    const res = await saveConfigHandler({}, patch);
    assert.strictEqual(res.pollIntervalMinutes, 15);
    assert.strictEqual(res.startOnBoot, true);

    // 부팅 시 실행 설정 적용 검증
    assert.deepStrictEqual(mockAppInstance.loginSettings, { openAtLogin: true });
    assert.strictEqual(trayMenuUpdated, true);

    // 기존 폴러 중단 및 신규 주기로 교체 검증
    assert.strictEqual(initialPoller.stopped, true);
    assert.strictEqual(mockPollerInstance.interval, 15);
  });

  it('open-external: 안전한 http/https URL은 shell.openExternal을 호출해야 한다', async () => {
    const openHandler = handlers.get('open-external');

    const res = await openHandler({}, 'https://platform.openai.com/usage');
    assert.strictEqual(res.success, true);
    assert.strictEqual(mockShellModule.openedUrl, 'https://platform.openai.com/usage');
  });

  it('open-external: 비정상적이거나 안전하지 않은 프로토콜(file://, javascript:)은 거부해야 한다', async () => {
    const openHandler = handlers.get('open-external');

    await assert.rejects(async () => {
      await openHandler({}, 'file:///etc/passwd');
    }, /안전하지 않거나 유효하지 않은 URL 프로토콜/);

    await assert.rejects(async () => {
      await openHandler({}, 'javascript:alert(1)');
    }, /안전하지 않거나 유효하지 않은 URL 프로토콜/);

    await assert.rejects(async () => {
      await openHandler({}, null);
    }, /안전하지 않거나 유효하지 않은 URL 프로토콜/);
  });

  it('set-pin-mode & get-pin-mode: 핀 모드 활성화/비활성화 시 상태를 갱신하고 mainWindow.setAlwaysOnTop(pinned)를 호출해야 한다', async () => {
    const setPinHandler = handlers.get('set-pin-mode');
    const getPinHandler = handlers.get('get-pin-mode');

    const res = await setPinHandler({}, { isPinned: true });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.isPinned, true);
    assert.strictEqual(mockMainWindow.alwaysOnTop, true);
    assert.strictEqual(mockIsPinned, true);

    const getRes = await getPinHandler();
    assert.strictEqual(getRes.isPinned, true);

    const resOff = await setPinHandler({}, { isPinned: false });
    assert.strictEqual(resOff.success, true);
    assert.strictEqual(resOff.isPinned, false);
    assert.strictEqual(mockMainWindow.alwaysOnTop, false);
    assert.strictEqual(mockIsPinned, false);

    const getResOff = await getPinHandler();
    assert.strictEqual(getResOff.isPinned, false);
  });

  it('close-window: mainWindow.hide()를 호출하고 success: true를 반환해야 한다', async () => {
    const closeHandler = handlers.get('close-window');
    const res = await closeHandler();
    assert.strictEqual(res.success, true);
    assert.strictEqual(mockMainWindow.hidden, true);
  });

  it('set-theme: configModule.updateConfig({ theme })를 호출하고 success: true를 반환해야 한다', async () => {
    const setThemeHandler = handlers.get('set-theme');
    const res = await setThemeHandler({}, { theme: 'light' });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.theme, 'light');
  });

  it('logout-slot: configModule.logoutSlot을 호출하고 사용량을 새로고침 및 브로드캐스트해야 한다', async () => {
    const logoutHandler = handlers.get('logout-slot');
    const res = await logoutHandler({}, 'slot1');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.loggedOut, true);
    assert.ok(broadcastedData);
  });

  it('add-slot: configModule.addSlot을 호출하고 결과를 반환해야 한다', async () => {
    const addHandler = handlers.get('add-slot');
    const res = await addHandler();
    assert.strictEqual(res.slotId, 'slot3');
    assert.deepStrictEqual(res.slots, ['slot1', 'slot2', 'slot3']);
  });

  it('remove-slot: configModule.removeSlot 및 poller.cleanupSlot을 호출하고 사용량을 새로고침해야 한다', async () => {
    const removeHandler = handlers.get('remove-slot');
    const res = await removeHandler({}, 'slot3');
    assert.strictEqual(res.success, true);
    assert.strictEqual(mockPollerModule.cleanedSlot, 'slot3');
    assert.ok(broadcastedData);
  });

  it('getPinState & setPinState: 핀 상태 조회 및 변경 함수 무결성', () => {
    assert.strictEqual(typeof getPinState, 'function');
    assert.strictEqual(typeof setPinState, 'function');
    setPinState(true);
    assert.strictEqual(getPinState(), true);
    setPinState(false);
    assert.strictEqual(getPinState(), false);
  });
});
