/**
 * src/preload.js
 * 
 * OpenAI 사용량 모니터 - Electron Preload 보안 브릿지
 * 
 * 컨텍스트 격리(contextIsolation: true) 환경에서 렌더러 프로세스가
 * 안전하게 메인 프로세스와 통신할 수 있도록 contextBridge를 통해
 * 명시적이고 제한된 API 집합만을 window.electronAPI에 노출합니다.
 */

const electron = require('electron');

/**
 * 렌더러에 노출할 electronAPI 객체를 생성하고 contextBridge에 등록합니다.
 * @param {object} bridge contextBridge 객체
 * @param {object} ipc ipcRenderer 객체
 * @returns {object|null} 노출된 API 정의
 */
function exposeElectronApi(bridge, ipc) {
  const targetBridge = bridge || (typeof electron === 'object' ? electron.contextBridge : null);
  const targetIpc = ipc || (typeof electron === 'object' ? electron.ipcRenderer : null);

  if (!targetBridge || typeof targetBridge.exposeInMainWorld !== 'function' || !targetIpc) {
    return null;
  }

  const api = {
    // 1. 실시간 사용량 조회
    getUsage: () => targetIpc.invoke('get-usage'),

    // 2. 수동 새로고침 (refreshNow 및 렌더러 호환 별칭)
    refreshNow: () => targetIpc.invoke('refresh-now'),
    refreshUsage: () => targetIpc.invoke('refresh-now'),

    // 3. 계정 슬롯 연동 및 로그인 플로우 제어
    loginSlot: (slotId = 'slot2') => targetIpc.invoke('login-slot', slotId),
    startLoginSlot2: () => targetIpc.invoke('login-slot', 'slot2'),
    loginSlot2: () => targetIpc.invoke('login-slot', 'slot2'),
    cancelLogin: (slotId = 'slot2') => targetIpc.invoke('cancel-login', slotId),
    cancelLoginSlot2: () => targetIpc.invoke('cancel-login', 'slot2'),

    // 4. 환경설정 조회 및 저장
    getConfig: () => targetIpc.invoke('get-config'),
    saveConfig: (patch) => targetIpc.invoke('save-config', patch),

    // 5. 외부 브라우저 URL 오픈
    openExternal: (url) => targetIpc.invoke('open-external', url),

    // 6. 백그라운드 사용량 주기적 브로드캐스트 이벤트 구독
    onUsageUpdate: (callback) => {
      if (typeof callback !== 'function') {
        throw new TypeError('onUsageUpdate 콜백은 함수여야 합니다.');
      }
      const listener = (_event, data) => callback(data);
      targetIpc.on('usage-updated', listener);
      return () => {
        targetIpc.removeListener('usage-updated', listener);
      };
    },

    // onUsageUpdated 별칭 지원 (해제 함수 반환)
    onUsageUpdated: (callback) => {
      if (typeof callback !== 'function') {
        throw new TypeError('onUsageUpdated 콜백은 함수여야 합니다.');
      }
      const listener = (_event, data) => callback(data);
      targetIpc.on('usage-updated', listener);
      return () => {
        targetIpc.removeListener('usage-updated', listener);
      };
    },

    // 7. 창 제어 및 핀(상단 고정) 모드 제어
    setPinMode: (payload) => targetIpc.invoke('set-pin-mode', payload),
    getPinMode: () => targetIpc.invoke('get-pin-mode'),
    closeWindow: () => targetIpc.invoke('close-window'),

    // 8. 테마 설정
    setTheme: (payload) => targetIpc.invoke('set-theme', payload),

    // 9. 슬롯 동적 관리 및 세션 로그아웃
    logoutSlot: (slotId) => targetIpc.invoke('logout-slot', slotId),
    addSlot: () => targetIpc.invoke('add-slot'),
    removeSlot: (slotId) => targetIpc.invoke('remove-slot', slotId),
  };

  targetBridge.exposeInMainWorld('electronAPI', api);
  return api;
}

// Electron Preload 환경에서 자동 등록
if (typeof electron === 'object' && electron !== null && electron.contextBridge && electron.ipcRenderer) {
  exposeElectronApi(electron.contextBridge, electron.ipcRenderer);
}

module.exports = {
  exposeElectronApi,
};
