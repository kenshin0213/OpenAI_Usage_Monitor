/**
 * src/main.js
 * 
 * OpenAI 사용량 모니터 - Electron 메인 프로세스 및 시스템 트레이 통합
 * 
 * 주요 기능:
 * 1. 단일 인스턴스 잠금 (requestSingleInstanceLock)
 * 2. 시작 시 PC 기존 세션(~/.codex/auth.json) 자동 시딩 (seedSlot1FromCodex)
 * 3. 시스템 트레이 아이콘 생성 및 작업표시줄 위치 기반 팝업 윈도우 좌표 계산
 * 4. 프레임리스 팝업 윈도우 생성 및 포커스 해제(blur) 시 자동 숨김
 * 5. 트레이 우클릭 컨텍스트 메뉴 (열기, 새로고침, 부팅 시 자동 시작, 종료)
 * 6. 백그라운드 사용량 폴러 구동 및 실시간 데이터 브로드캐스트
 * 7. 안전한 IPC 핸들러 등록 (get-usage, refresh-now, login-slot, cancel-login, get-config, save-config, open-external)
 */

const path = require('path');
const os = require('os');
const electron = require('electron');

const configModule = require('./config.js');
const authModule = require('./auth.js');
const pollerModule = require('./poller.js');

const { getConfig, updateConfig, seedSlot1FromCodex, normalizeSlotId } = configModule;
const { startOAuthLoginFlow } = authModule;
const { startPolling, pollAllSlots, getLatestPollResult } = pollerModule;

// ============================================================================
// 순수 유틸리티 함수 (테스트 가능)
// ============================================================================

/**
 * 트레이 아이콘의 위치와 화면 작업 영역을 기반으로 팝업 윈도우가 위치할 최적 좌표를 계산합니다.
 * 
 * Windows 작업표시줄의 다양한 위치(하단, 상단, 우측, 좌측)를 모두 감지하여
 * 팝업이 트레이 아이콘 바로 인접 영역에 정확히 뜨도록 하며, 화면 경계를 벗어나지 않도록 클램핑합니다.
 * 
 * @param {object} [trayBounds] 트레이 바운드 { x, y, width, height }
 * @param {object} [windowBounds] 윈도우 크기 { width, height }
 * @param {object} [displayBounds] 디스플레이 바운드 또는 작업 영역 { x, y, width, height }
 * @param {object} [options]
 * @param {number} [options.margin=8] 여백 (픽셀)
 * @returns {{ x: number, y: number }} 계산된 윈도우 좌상단 좌표
 */
function calculateWindowPosition(trayBounds, windowBounds, displayBounds, options = {}) {
  const windowWidth = (windowBounds && typeof windowBounds.width === 'number') ? windowBounds.width : 380;
  const windowHeight = (windowBounds && typeof windowBounds.height === 'number') ? windowBounds.height : 530;

  const dispX = (displayBounds && typeof displayBounds.x === 'number') ? displayBounds.x : 0;
  const dispY = (displayBounds && typeof displayBounds.y === 'number') ? displayBounds.y : 0;
  const dispW = (displayBounds && typeof displayBounds.width === 'number') ? displayBounds.width : 1920;
  const dispH = (displayBounds && typeof displayBounds.height === 'number') ? displayBounds.height : 1080;

  const margin = (options && typeof options.margin === 'number') ? options.margin : 8;

  // 트레이 바운드가 없거나 유효하지 않은 경우 화면 우하단 기본 배치
  if (!trayBounds || typeof trayBounds.x !== 'number' || !trayBounds.width || !trayBounds.height) {
    const fallbackX = dispX + dispW - windowWidth - margin;
    const fallbackY = dispY + dispH - windowHeight - margin;
    return {
      x: Math.round(Math.max(dispX, Math.min(fallbackX, dispX + dispW - windowWidth))),
      y: Math.round(Math.max(dispY, Math.min(fallbackY, dispY + dispH - windowHeight))),
    };
  }

  const trayCenterX = trayBounds.x + (trayBounds.width / 2);
  const trayCenterY = trayBounds.y + (trayBounds.height / 2);

  // 디스플레이 4개 가장자리와의 거리 계산하여 작업표시줄 방향 결정
  const distBottom = (dispY + dispH) - (trayBounds.y + trayBounds.height);
  const distTop = trayBounds.y - dispY;
  const distRight = (dispX + dispW) - (trayBounds.x + trayBounds.width);
  const distLeft = trayBounds.x - dispX;

  const minDist = Math.min(distBottom, distTop, distRight, distLeft);

  let targetX, targetY;

  if (minDist === distBottom) {
    // 하단 작업표시줄: 트레이 아이콘 위쪽에 수평 중앙 정렬
    targetX = trayCenterX - (windowWidth / 2);
    targetY = trayBounds.y - windowHeight - margin;
  } else if (minDist === distTop) {
    // 상단 작업표시줄: 트레이 아이콘 아래쪽에 수평 중앙 정렬
    targetX = trayCenterX - (windowWidth / 2);
    targetY = trayBounds.y + trayBounds.height + margin;
  } else if (minDist === distRight) {
    // 우측 작업표시줄: 트레이 아이콘 왼쪽에 수직 중앙 정렬
    targetX = trayBounds.x - windowWidth - margin;
    targetY = trayCenterY - (windowHeight / 2);
  } else {
    // 좌측 작업표시줄: 트레이 아이콘 오른쪽에 수직 중앙 정렬
    targetX = trayBounds.x + trayBounds.width + margin;
    targetY = trayCenterY - (windowHeight / 2);
  }

  // 화면 경계 내 안전 클램핑
  const minX = dispX;
  const maxX = dispX + dispW - windowWidth;
  const minY = dispY;
  const maxY = dispY + dispH - windowHeight;

  return {
    x: Math.round(Math.max(minX, Math.min(targetX, maxX))),
    y: Math.round(Math.max(minY, Math.min(targetY, maxY))),
  };
}

/**
 * 트레이 우클릭 컨텍스트 메뉴 템플릿을 생성합니다.
 * 
 * @param {object} params
 * @param {Function} [params.onOpen] 열기 클릭 핸들러
 * @param {Function} [params.onRefresh] 새로고침 클릭 핸들러
 * @param {Function} [params.onToggleStartOnBoot] 부팅 시 시작 토글 핸들러 (enabled) => void
 * @param {Function} [params.onQuit] 종료 클릭 핸들러
 * @param {boolean} [params.startOnBoot=false] 시작 시 자동 실행 여부
 * @returns {Array<object>} Menu.buildFromTemplate용 템플릿 배열
 */
function createTrayMenuTemplate({ onOpen, onRefresh, onToggleStartOnBoot, onQuit, startOnBoot = false } = {}) {
  return [
    {
      label: '열기',
      click: () => onOpen && onOpen(),
    },
    {
      label: '지금 새로고침',
      click: () => onRefresh && onRefresh(),
    },
    {
      type: 'separator',
    },
    {
      label: '시작 시 자동 실행',
      type: 'checkbox',
      checked: Boolean(startOnBoot),
      click: (menuItem) => onToggleStartOnBoot && onToggleStartOnBoot(menuItem.checked),
    },
    {
      type: 'separator',
    },
    {
      label: '종료',
      click: () => onQuit && onQuit(),
    },
  ];
}

/**
 * IPC 핸들러들을 등록합니다.
 * 
 * @param {object} params
 * @param {object} params.ipcMain Electron ipcMain 객체
 * @param {object} [params.pollerModule] poller 모듈
 * @param {object} [params.authModule] auth 모듈
 * @param {object} [params.configModule] config 모듈
 * @param {object} [params.shellModule] Electron shell 모듈
 * @param {Function} [params.getPollerInstance] 현재 활성 폴러 인스턴스 반환 함수
 * @param {Function} [params.setPollerInstance] 활성 폴러 인스턴스 갱신 함수
 * @param {Map} [params.activeLogins] 진행 중인 로그인 자식 프로세스 맵
 * @param {Function} [params.broadcastUsage] 사용량 브로드캐스트 함수
 * @param {Function} [params.updateTrayMenu] 트레이 메뉴 갱신 함수
 * @param {object} [params.appInstance] Electron app 객체
 */
function registerIpcHandlers({
  ipcMain,
  pollerModule: poller = pollerModule,
  authModule: auth = authModule,
  configModule: cfg = configModule,
  shellModule: shell = (typeof electron === 'object' ? electron.shell : null),
  getPollerInstance = () => null,
  setPollerInstance = () => {},
  activeLogins = new Map(),
  broadcastUsage = () => {},
  updateTrayMenu = () => {},
  appInstance = (typeof electron === 'object' ? electron.app : null),
}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    return;
  }

  // 1. 실시간 사용량 조회 (캐시 우선 또는 강제 조회)
  ipcMain.handle('get-usage', async () => {
    const cached = poller.getLatestPollResult();
    if (cached) {
      return cached;
    }
    return await poller.pollAllSlots();
  });

  // 2. 수동 즉시 새로고침
  ipcMain.handle('refresh-now', async () => {
    const currentPoller = getPollerInstance();
    if (currentPoller && typeof currentPoller.pollNow === 'function') {
      return await currentPoller.pollNow();
    }
    return await poller.pollAllSlots();
  });

  // 3. 신규 계정(슬롯 2 등) 브라우저 OAuth 로그인 플로우 시작
  ipcMain.handle('login-slot', async (_event, slotId = 'slot2') => {
    const normalizedSlot = cfg.normalizeSlotId(slotId);

    if (activeLogins.has(normalizedSlot)) {
      throw new Error(`슬롯 ${normalizedSlot}에 대한 로그인이 이미 진행 중입니다.`);
    }

    const loginPromise = auth.startOAuthLoginFlow(normalizedSlot);
    if (loginPromise.childProcess) {
      activeLogins.set(normalizedSlot, loginPromise.childProcess);
    }

    try {
      const result = await loginPromise;

      // 로그인 성공 시 백그라운드 폴러를 통해 즉시 최신 지표 갱신
      const currentPoller = getPollerInstance();
      if (currentPoller && typeof currentPoller.pollNow === 'function') {
        currentPoller.pollNow().catch(() => {});
      } else {
        poller.pollAllSlots().catch(() => {});
      }

      return result;
    } finally {
      activeLogins.delete(normalizedSlot);
    }
  });

  // 4. 진행 중인 로그인 플로우 강제 취소
  ipcMain.handle('cancel-login', async (_event, slotId = 'slot2') => {
    const normalizedSlot = cfg.normalizeSlotId(slotId);
    const child = activeLogins.get(normalizedSlot);

    if (child) {
      try {
        child.kill('SIGTERM');
      } catch {
        // 프로세스 종료 시그널 오류 무시
      }
      activeLogins.delete(normalizedSlot);
      return { success: true, cancelled: true };
    }

    return { success: true, cancelled: false, message: '진행 중인 로그인이 없습니다.' };
  });

  // 5. 환경설정 조회
  ipcMain.handle('get-config', async () => {
    return await cfg.getConfig();
  });

  // 6. 환경설정 저장 및 런타임 적용
  ipcMain.handle('save-config', async (_event, patch) => {
    const updated = await cfg.updateConfig(patch);

    // 윈도우 시작 시 자동 실행 시스템 반영
    if (patch && typeof patch.startOnBoot === 'boolean' && appInstance) {
      try {
        if (typeof appInstance.setLoginItemSettings === 'function') {
          appInstance.setLoginItemSettings({ openAtLogin: patch.startOnBoot });
        }
      } catch (err) {
        console.warn('[main] startOnBoot 설정 실패:', err.message);
      }
      if (typeof updateTrayMenu === 'function') {
        updateTrayMenu();
      }
    }

    // 폴링 주기 변경 시 스케줄러 재시작
    if (patch && typeof patch.pollIntervalMinutes === 'number' && patch.pollIntervalMinutes > 0) {
      const currentPoller = getPollerInstance();
      if (currentPoller && typeof currentPoller.stop === 'function') {
        currentPoller.stop();
      }
      const newPoller = poller.startPolling(patch.pollIntervalMinutes, (data) => {
        if (typeof broadcastUsage === 'function') {
          broadcastUsage(data);
        }
      });
      setPollerInstance(newPoller);
    }

    return updated;
  });

  // 7. 외부 브라우저 URL 오픈
  ipcMain.handle('open-external', async (_event, url) => {
    if (typeof url !== 'string' || (!url.startsWith('https://') && !url.startsWith('http://'))) {
      throw new Error('안전하지 않거나 유효하지 않은 URL 프로토콜입니다.');
    }
    if (shell && typeof shell.openExternal === 'function') {
      await shell.openExternal(url);
      return { success: true };
    }
    return { success: false, message: 'shell API를 사용할 수 없습니다.' };
  });
}

// ============================================================================
// Electron 애플리케이션 런타임 수명 주기 관리
// ============================================================================

let mainWindow = null;
let tray = null;
let pollerInstance = null;
const activeLogins = new Map();
let isQuitting = false;
let lastBlurTime = 0;

/**
 * 렌더러 프로세스로 실시간 사용량 데이터를 브로드캐스트합니다.
 * @param {object} data 
 */
function broadcastUsage(data) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    mainWindow.webContents.send('usage-updated', data);
  }
}

/**
 * 트레이 팝업 윈도우를 화면에 표시하고 포커스를 부여합니다.
 */
function showWindow() {
  if (!mainWindow || !tray) return;

  const electronScreen = electron.screen;
  const trayBounds = tray.getBounds();
  const windowBounds = mainWindow.getBounds();
  const display = (electronScreen && typeof electronScreen.getDisplayMatching === 'function')
    ? electronScreen.getDisplayMatching(trayBounds)
    : (electronScreen?.getPrimaryDisplay() || null);

  const displayBounds = display ? (display.workArea || display.bounds) : null;
  const pos = calculateWindowPosition(trayBounds, windowBounds, displayBounds);

  mainWindow.setPosition(pos.x, pos.y, false);
  mainWindow.show();
  mainWindow.focus();
}

/**
 * 트레이 팝업 윈도우 표시/숨김을 토글합니다.
 */
function toggleWindow() {
  if (!mainWindow) return;

  // 윈도우가 blur로 닫힌 직후(150ms 이내)에 발생한 트레이 클릭은 재오픈 방지
  if (Date.now() - lastBlurTime < 150) {
    return;
  }

  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    showWindow();
  }
}

/**
 * 트레이 우클릭 컨텍스트 메뉴를 갱신합니다.
 */
async function updateTrayMenu() {
  if (!tray || typeof electron.Menu?.buildFromTemplate !== 'function') return;

  let startOnBoot = false;
  try {
    const cfg = await getConfig();
    startOnBoot = Boolean(cfg.startOnBoot);
  } catch {
    // 무시
  }

  const template = createTrayMenuTemplate({
    onOpen: () => showWindow(),
    onRefresh: async () => {
      if (pollerInstance) {
        await pollerInstance.pollNow();
      } else {
        await pollAllSlots();
      }
    },
    onToggleStartOnBoot: async (enabled) => {
      await updateConfig({ startOnBoot: enabled });
      try {
        electron.app.setLoginItemSettings({ openAtLogin: enabled });
      } catch (err) {
        console.warn('[main] setLoginItemSettings 오류:', err.message);
      }
      updateTrayMenu();
    },
    onQuit: () => {
      isQuitting = true;
      electron.app.quit();
    },
    startOnBoot,
  });

  const menu = electron.Menu.buildFromTemplate(template);
  tray.setContextMenu(menu);
}

/**
 * 시스템 트레이 아이콘을 생성하고 이벤트를 바인딩합니다.
 */
function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  let icon = iconPath;
  if (electron.nativeImage && typeof electron.nativeImage.createFromPath === 'function') {
    icon = electron.nativeImage.createFromPath(iconPath);
  }

  tray = new electron.Tray(icon);
  tray.setToolTip('ChatGPT 사용량 모니터');

  // 좌클릭: 팝업 토글
  tray.on('click', () => {
    toggleWindow();
  });

  // 우클릭: 컨텍스트 메뉴 표시
  tray.on('right-click', () => {
    updateTrayMenu().then(() => {
      if (tray && typeof tray.popUpContextMenu === 'function') {
        // 일부 플랫폼 호환용
      }
    });
  });

  updateTrayMenu();
}

/**
 * 트레이 팝업용 프레임리스 윈도우를 생성합니다.
 */
function createWindow() {
  mainWindow = new electron.BrowserWindow({
    width: 380,
    height: 530,
    frame: false,
    resizable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  const htmlPath = path.join(__dirname, 'ui', 'index.html');
  mainWindow.loadFile(htmlPath);

  // 포커스를 잃었을 때(blur) 자동 숨김 (개발자 도구가 열려있지 않은 경우)
  mainWindow.on('blur', () => {
    lastBlurTime = Date.now();
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
      if (!mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.hide();
      }
    }
  });

  // 창 닫기 시도 시 프로세스 종료 대신 트레이로 숨김
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

/**
 * Electron 메인 애플리케이션 초기화 루틴
 */
async function initApp() {
  // 1. 기존 PC 세션(~/.codex/auth.json) 자동 시딩 (1회)
  try {
    const seedResult = await seedSlot1FromCodex();
    if (seedResult && seedResult.success) {
      console.log('[main] PC 세션(~/.codex/auth.json)으로부터 계정 1을 자동 연동했습니다.');
    }
  } catch (err) {
    console.warn('[main] 계정 1 초기 자동 시딩 생략 또는 실패:', err.message);
  }

  // 2. 윈도우 생성
  createWindow();

  // 3. 트레이 아이콘 생성
  createTray();

  // 4. IPC 핸들러 등록
  registerIpcHandlers({
    ipcMain: electron.ipcMain,
    pollerModule,
    authModule,
    configModule,
    shellModule: electron.shell,
    getPollerInstance: () => pollerInstance,
    setPollerInstance: (p) => { pollerInstance = p; },
    activeLogins,
    broadcastUsage,
    updateTrayMenu,
    appInstance: electron.app,
  });

  // 5. 백그라운드 사용량 폴러 시작 및 시작 시 자동 실행 레지스트리 동기화
  try {
    const config = await getConfig();
    if (electron.app?.setLoginItemSettings) {
      try {
        electron.app.setLoginItemSettings({ openAtLogin: Boolean(config.startOnBoot) });
      } catch {
        // OS 수준 로그인 아이템 설정 실패 무시
      }
    }
    const interval = config.pollIntervalMinutes || 5;
    pollerInstance = startPolling(interval, (data) => {
      broadcastUsage(data);
    });
  } catch (err) {
    console.error('[main] 폴러 시작 실패:', err.message);
    pollerInstance = startPolling(5, (data) => {
      broadcastUsage(data);
    });
  }
}

// ============================================================================
// Electron 프로세스 시작부 (단일 인스턴스 잠금 처리)
// ============================================================================

const isElectronRuntime = typeof electron === 'object' && electron !== null && Boolean(electron.app);

if (isElectronRuntime) {
  const gotTheLock = electron.app.requestSingleInstanceLock();

  if (!gotTheLock) {
    console.log('[main] 이미 다른 인스턴스가 실행 중입니다. 프로세스를 종료합니다.');
    electron.app.quit();
  } else {
    // 중복 실행 감지 시 기존 윈도우 표시
    electron.app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        showWindow();
      }
    });

    electron.app.whenReady().then(initApp);

    electron.app.on('before-quit', () => {
      isQuitting = true;
      if (pollerInstance && typeof pollerInstance.stop === 'function') {
        pollerInstance.stop();
        pollerInstance = null;
      }
    });

    // 모든 윈도우가 닫혀도 트레이 상주 유지
    electron.app.on('window-all-closed', () => {
      // no-op (트레이에 상주)
    });
  }
}

module.exports = {
  calculateWindowPosition,
  createTrayMenuTemplate,
  registerIpcHandlers,
  broadcastUsage,
  showWindow,
  toggleWindow,
  updateTrayMenu,
};
