/**
 * src/ui/renderer.js
 * 
 * ChatGPT 다중 사용량 모니터 - 트레이 팝업 렌더러 로직
 * 
 * 주요 기능:
 * 1. 실시간 사용량 메트릭(5시간 단위, 주간 한도) 동적 카드 목록 DOM 렌더링
 * 2. 부드러운 프로그레스 바 및 잔여량 임계치 컬러 큐 (초록 >30%, 노랑 11~30%, 빨강 <=10%)
 * 3. 1초 주기 실시간 카운트다운 타이머 (resetAt 타임스탬프 기반 모든 슬롯 동적 갱신)
 * 4. 동적 N개 계정 카드 생성 (미연동, 로그인 진행 중, 연동 완료) 및 슬롯 추가/삭제
 * 5. 창 항상 위 고정(📌 핀 모드) 및 다크/라이트 테마 전환
 * 6. 계정별 로그아웃 및 재연동 트리거
 * 7. 환경설정 모달 제어 및 외부 Electron IPC 통신 / 브라우저 모의 실행 지원
 */

// ============================================================================
// 순수 유틸리티 함수 (테스트 가능)
// ============================================================================

/**
 * 남은 시간(초)을 사용자 친화적인 한국어 문자열로 포맷팅합니다.
 * @param {number} seconds 
 * @returns {string}
 */
function formatCountdown(seconds) {
  if (typeof seconds !== 'number' || isNaN(seconds) || seconds <= 60) {
    return '곧 초기화';
  }

  // 1분 초과 1시간(3600초) 이하
  if (seconds <= 3600) {
    const mins = Math.floor(seconds / 60);
    return `${mins}분 후 초기화`;
  }

  // 1시간 초과 24시간(86400초) 이하
  if (seconds <= 86400) {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (mins === 0) {
      return `${hours}시간 후 초기화`;
    }
    return `${hours}시간 ${mins}분 후 초기화`;
  }

  // 24시간 초과
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (hours === 0) {
    return `${days}일 후 초기화`;
  }
  return `${days}일 ${hours}시간 후 초기화`;
}

/**
 * 잔여 퍼센트에 따른 진행 바 색상 클래스를 반환합니다.
 * - 초록: > 30%
 * - 노랑: 11% ~ 30%
 * - 빨강: <= 10%
 * 
 * @param {number} remainingPercent 
 * @returns {'progress-green' | 'progress-yellow' | 'progress-red'}
 */
function getProgressColorClass(remainingPercent) {
  const percent = typeof remainingPercent === 'number' ? remainingPercent : 0;
  if (percent > 30) {
    return 'progress-green';
  }
  if (percent > 10) {
    return 'progress-yellow';
  }
  return 'progress-red';
}

/**
 * 플랜 유형 문자열을 정규화하여 배지 텍스트와 CSS 클래스를 반환합니다.
 * @param {string} planType 
 * @returns {{ label: string, badgeClass: string }}
 */
function getPlanBadgeInfo(planType) {
  const normalized = String(planType || '').toLowerCase().trim();
  switch (normalized) {
    case 'plus':
      return { label: 'Plus', badgeClass: 'badge-plus' };
    case 'pro':
      return { label: 'Pro', badgeClass: 'badge-pro' };
    case 'team':
      return { label: 'Team', badgeClass: 'badge-team' };
    case 'free':
      return { label: 'Free', badgeClass: 'badge-free' };
    default:
      if (!normalized || normalized === 'unknown') {
        return { label: '기본', badgeClass: 'badge-default' };
      }
      return { label: normalized.toUpperCase(), badgeClass: 'badge-default' };
  }
}

/**
 * 마지막 갱신 일시를 시:분:초 형식으로 포맷팅합니다.
 * @param {number|string|Date} timestamp 
 * @returns {string}
 */
function formatLastUpdated(timestamp) {
  if (!timestamp) return '방금 전';
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return '방금 전';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 현재 테마를 기반으로 다음 테마 문자열을 반환합니다.
 * @param {string} currentTheme 
 * @returns {'dark' | 'light'}
 */
function getNextTheme(currentTheme) {
  return currentTheme === 'light' ? 'dark' : 'light';
}

/**
 * HTML 특수문자 이스케이프 유틸리티
 * @param {string} str 
 * @returns {string}
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * 슬롯 ID에 따른 배지 스타일 클래스를 반환합니다.
 * @param {string} slotId 
 * @returns {string}
 */
function getSlotBadgeClass(slotId) {
  if (slotId === 'slot1') return 'slot1-badge';
  if (slotId === 'slot2') return 'slot2-badge';
  if (slotId === 'slot3') return 'slot3-badge';
  return 'slot-badge-generic';
}

/**
 * 임의 개수의 슬롯 데이터를 바탕으로 카드 HTML 목록을 생성합니다.
 * @param {Record<string, object>} slotsData 슬롯별 상태/사용량 객체
 * @param {object} [state] UI 부가 상태 (loggingSlots 등)
 * @returns {string} 카드 HTML 문자열
 */
function generateSlotsHtml(slotsData = {}, state = {}) {
  const slotKeys = Object.keys(slotsData || {}).sort((a, b) => {
    const numA = parseInt((a.match(/\d+/) || [0])[0], 10);
    const numB = parseInt((b.match(/\d+/) || [0])[0], 10);
    return numA - numB;
  });

  const totalSlots = slotKeys.length;

  return slotKeys.map((slotId) => {
    const slot = slotsData[slotId] || {};
    const slotNum = (slotId.match(/\d+/) || [slotId])[0];
    const slotLabel = `계정 ${slotNum}`;
    const badgeClass = getSlotBadgeClass(slotId);
    const isLoggingIn = Boolean(state?.loggingSlots?.[slotId]);
    const isLinked = Boolean(slot.linked);
    const isExtraSlot = totalSlots > 2 && parseInt(slotNum, 10) > 2;

    // 1. 로그인 진행 중 상태 카드
    if (isLoggingIn) {
      return `
      <section id="${slotId}-card" class="account-card" data-slot="${slotId}">
        <div class="card-header">
          <div class="account-info">
            <span class="slot-badge ${badgeClass}">${slotLabel}</span>
            <span class="account-email text-warning">연동 진행 중...</span>
          </div>
        </div>
        <div class="logging-content">
          <div class="spinner" aria-label="로그인 진행 중"></div>
          <p class="logging-title">브라우저에서 로그인 대기 중...</p>
          <p class="logging-desc">웹 브라우저에서 OpenAI 로그인을 완료하면 자동으로 연결됩니다.</p>
          <button class="btn btn-secondary btn-cancel btn-cancel-login" data-slot="${slotId}">
            연동 취소
          </button>
        </div>
      </section>`;
    }

    // 2. 연동 완료 상태 카드
    if (isLinked) {
      const planInfo = getPlanBadgeInfo(slot.planType);
      const email = slot.email || '인증 완료 (이메일 미확인)';
      const metrics = slot.metrics || slot;
      const primary = metrics.primaryWindow || {};
      const secondary = metrics.secondaryWindow || {};

      const pRemaining = typeof primary.remainingPercent === 'number' ? primary.remainingPercent : 0;
      const pColor = getProgressColorClass(pRemaining);
      const pCountdown = primary.formattedResetText || formatCountdown(primary.resetAfterSeconds || 0);

      const sRemaining = typeof secondary.remainingPercent === 'number' ? secondary.remainingPercent : 0;
      const sColor = getProgressColorClass(sRemaining);
      const sCountdown = secondary.formattedResetText || formatCountdown(secondary.resetAfterSeconds || 0);

      return `
      <section id="${slotId}-card" class="account-card" data-slot="${slotId}">
        <div class="card-header">
          <div class="account-info">
            <span class="slot-badge ${badgeClass}">${slotLabel}</span>
            <span id="${slotId}-email" class="account-email" title="${escapeHtml(email)}">${escapeHtml(email)}</span>
          </div>
          <div class="card-header-actions">
            <span id="${slotId}-plan" class="plan-badge ${planInfo.badgeClass}">${planInfo.label}</span>
            <button class="btn-card-action btn-logout" data-slot="${slotId}" title="계정 로그아웃" aria-label="로그아웃">로그아웃</button>
          </div>
        </div>

        <div class="card-body">
          <!-- 5시간 단위 한도 (Primary Window) -->
          <div class="metric-block" id="${slotId}-primary-block">
            <div class="metric-header">
              <span class="metric-title">5시간 한도</span>
              <span id="${slotId}-primary-percent" class="metric-percent">${pRemaining}%</span>
            </div>
            <div class="progress-track" role="progressbar" aria-valuenow="${pRemaining}" aria-valuemin="0" aria-valuemax="100">
              <div id="${slotId}-primary-bar" class="progress-fill ${pColor}" style="width: ${pRemaining}%;"></div>
            </div>
            <div class="metric-footer">
              <span class="metric-subtext">잔여량</span>
              <span id="${slotId}-primary-countdown" class="countdown-text">${pCountdown}</span>
            </div>
          </div>

          <!-- 주간 사용 한도 (Secondary Window) -->
          <div class="metric-block" id="${slotId}-secondary-block">
            <div class="metric-header">
              <span class="metric-title">주간 사용 한도</span>
              <span id="${slotId}-secondary-percent" class="metric-percent">${sRemaining}%</span>
            </div>
            <div class="progress-track" role="progressbar" aria-valuenow="${sRemaining}" aria-valuemin="0" aria-valuemax="100">
              <div id="${slotId}-secondary-bar" class="progress-fill ${sColor}" style="width: ${sRemaining}%;"></div>
            </div>
            <div class="metric-footer">
              <span class="metric-subtext">잔여량</span>
              <span id="${slotId}-secondary-countdown" class="countdown-text">${sCountdown}</span>
            </div>
          </div>
        </div>
      </section>`;
    }

    // 3. 미연동 상태 카드
    const deleteBtnHtml = isExtraSlot
      ? `<button class="btn-card-action btn-delete-slot" data-slot="${slotId}" title="카드 삭제" aria-label="카드 삭제">카드 삭제</button>`
      : '';

    return `
    <section id="${slotId}-card" class="account-card" data-slot="${slotId}">
      <div class="card-header">
        <div class="account-info">
          <span class="slot-badge ${badgeClass}">${slotLabel}</span>
          <span class="account-email text-muted">미연동</span>
        </div>
        ${deleteBtnHtml ? `<div class="card-header-actions">${deleteBtnHtml}</div>` : ''}
      </div>
      <div class="unlinked-content">
        <div class="unlinked-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <p class="unlinked-desc">${slotLabel}을(를) 연동하여 실시간 사용량을 모니터링하세요.</p>
        <button class="btn btn-primary btn-link-account btn-login-slot" data-slot="${slotId}">
          + ${slotLabel} 연동하기
        </button>
      </div>
    </section>`;
  }).join('');
}

/**
 * 모의(Mock) 사용량 데이터 생성기 (브라우저 자립 실행 및 테스트용)
 * @returns {object}
 */
function createMockUsageData() {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    slot1: {
      slotId: 'slot1',
      success: true,
      linked: true,
      email: 'user1.openai@gmail.com',
      planType: 'plus',
      primaryWindow: {
        usedPercent: 28,
        remainingPercent: 72,
        limitWindowSeconds: 18000,
        resetAfterSeconds: 5200,
        resetAt: nowSec + 5200,
        formattedResetText: formatCountdown(5200),
      },
      secondaryWindow: {
        usedPercent: 12,
        remainingPercent: 88,
        limitWindowSeconds: 604800,
        resetAfterSeconds: 310000,
        resetAt: nowSec + 310000,
        formattedResetText: formatCountdown(310000),
      },
      updatedAt: new Date().toISOString(),
    },
    slot2: {
      slotId: 'slot2',
      success: false,
      linked: false,
      email: null,
      planType: null,
      primaryWindow: null,
      secondaryWindow: null,
      error: '계정 2가 연동되지 않았습니다.',
      updatedAt: new Date().toISOString(),
    },
    timestamp: Date.now(),
  };
}

/**
 * 모의(Mock) 애플리케이션 설정 생성기
 * @returns {object}
 */
function createMockConfig() {
  return {
    pollIntervalMinutes: 5,
    alertThresholdPercent: 10,
    notifyOnThreshold: true,
    notifyOnReset: true,
    startOnBoot: false,
    theme: 'dark',
    slots: ['slot1', 'slot2'],
  };
}

// ============================================================================
// 렌더러 컨트롤러 클래스
// ============================================================================

class MonitorRenderer {
  constructor(options = {}) {
    this.api = options.api || (typeof window !== 'undefined' ? window.electronAPI : null);
    this.doc = options.document || (typeof document !== 'undefined' ? document : null);
    
    // 상태 변수
    this.currentData = null;
    this.currentConfig = null;
    this.currentTheme = 'dark';
    this.isPinned = false;
    this.loggingSlots = {};
    this.countdownTimer = null;
    this.toastTimer = null;

    // 브라우저 직접 실행 시 모의 API 제공
    if (!this.api && typeof window !== 'undefined') {
      this.api = this._createBrowserMockApi();
    }
  }

  /**
   * 브라우저 개발/테스트용 Mock API 어댑터
   */
  _createBrowserMockApi() {
    let mockData = createMockUsageData();
    let mockConfig = createMockConfig();
    let isPinnedState = false;

    return {
      getUsage: async () => mockData,
      refreshUsage: async () => {
        await new Promise((r) => setTimeout(r, 600));
        mockData = createMockUsageData();
        return mockData;
      },
      refreshNow: async () => {
        await new Promise((r) => setTimeout(r, 600));
        mockData = createMockUsageData();
        return mockData;
      },
      getConfig: async () => ({ ...mockConfig }),
      saveConfig: async (patch) => {
        mockConfig = { ...mockConfig, ...patch };
        return { ...mockConfig };
      },
      setTheme: async ({ theme }) => {
        mockConfig.theme = theme;
        return { theme };
      },
      setPinMode: async ({ isPinned }) => {
        isPinnedState = Boolean(isPinned);
        return { isPinned: isPinnedState };
      },
      getPinMode: async () => ({ isPinned: isPinnedState }),
      closeWindow: async () => ({ closed: true }),
      loginSlot: async (slotId = 'slot2') => {
        await new Promise((r) => setTimeout(r, 1200));
        const nowSec = Math.floor(Date.now() / 1000);
        mockData[slotId] = {
          slotId,
          success: true,
          linked: true,
          email: `${slotId}.user@openai.com`,
          planType: 'plus',
          primaryWindow: {
            usedPercent: 40,
            remainingPercent: 60,
            limitWindowSeconds: 18000,
            resetAfterSeconds: 7200,
            resetAt: nowSec + 7200,
            formattedResetText: formatCountdown(7200),
          },
          secondaryWindow: {
            usedPercent: 25,
            remainingPercent: 75,
            limitWindowSeconds: 604800,
            resetAfterSeconds: 432000,
            resetAt: nowSec + 432000,
            formattedResetText: formatCountdown(432000),
          },
          updatedAt: new Date().toISOString(),
        };
        return { success: true };
      },
      startLoginSlot2: async () => {
        return this.api.loginSlot('slot2');
      },
      cancelLogin: async (slotId = 'slot2') => {
        return { success: true, cancelled: true };
      },
      cancelLoginSlot2: async () => {
        return { success: true, cancelled: true };
      },
      logoutSlot: async (slotId) => {
        if (mockData[slotId]) {
          mockData[slotId].linked = false;
          mockData[slotId].email = null;
          mockData[slotId].primaryWindow = null;
          mockData[slotId].secondaryWindow = null;
        }
        return { success: true };
      },
      addSlot: async () => {
        const slotKeys = Object.keys(mockData).filter((k) => k.startsWith('slot'));
        const nextNum = slotKeys.length + 1;
        const newSlotId = `slot${nextNum}`;
        mockData[newSlotId] = {
          slotId: newSlotId,
          linked: false,
          email: null,
          primaryWindow: null,
          secondaryWindow: null,
        };
        return { slotId: newSlotId, slots: Object.keys(mockData).filter((k) => k.startsWith('slot')) };
      },
      removeSlot: async (slotId) => {
        delete mockData[slotId];
        return { success: true, slots: Object.keys(mockData).filter((k) => k.startsWith('slot')) };
      },
      onUsageUpdated: (cb) => {
        this._mockUpdateCb = cb;
      },
    };
  }

  /**
   * DOM 요소 참조 바인딩 및 이벤트 리스너 등록
   */
  init() {
    if (!this.doc) return;

    this.cacheDomElements();
    this.bindEvents();
    this.startCountdownTicker();

    // 초기 데이터 로드
    this.loadInitialData();

    // 백그라운드 푸시 업데이트 리스너 연결
    if (this.api) {
      const subscribe = this.api.onUsageUpdated || this.api.onUsageUpdate;
      if (typeof subscribe === 'function') {
        subscribe((data) => {
          this.renderUsage(data);
        });
      }
    }
  }

  /**
   * 주요 DOM 요소 캐싱
   */
  cacheDomElements() {
    const d = this.doc;
    this.el = {
      // Header & Navigation
      connectionIndicator: d.getElementById('connection-indicator'),
      lastUpdatedText: d.getElementById('last-updated-text'),
      pinBtn: d.getElementById('pinBtn'),
      themeBtn: d.getElementById('themeBtn'),
      btnRefresh: d.getElementById('refreshBtn') || d.getElementById('btn-refresh'),
      btnSettings: d.getElementById('settingsBtn') || d.getElementById('btn-settings'),
      closeBtn: d.getElementById('closeBtn'),

      // Dynamic Cards Container & Add Action
      cardsContainer: d.getElementById('cardsContainer'),
      addSlotBtn: d.getElementById('addSlotBtn'),

      // Backward compatibility element references (for static tests)
      slot1Email: d.getElementById('slot1-email'),
      slot1Plan: d.getElementById('slot1-plan'),
      slot1PrimaryPercent: d.getElementById('slot1-primary-percent'),
      slot1PrimaryBar: d.getElementById('slot1-primary-bar'),
      slot1PrimaryCountdown: d.getElementById('slot1-primary-countdown'),
      slot1SecondaryPercent: d.getElementById('slot1-secondary-percent'),
      slot1SecondaryBar: d.getElementById('slot1-secondary-bar'),
      slot1SecondaryCountdown: d.getElementById('slot1-secondary-countdown'),

      slot2UnlinkedView: d.getElementById('slot2-unlinked-view'),
      slot2LoggingView: d.getElementById('slot2-logging-view'),
      slot2LinkedView: d.getElementById('slot2-linked-view'),
      btnLoginSlot2: d.getElementById('btn-login-slot2'),
      btnCancelLoginSlot2: d.getElementById('btn-cancel-login-slot2'),
      slot2Email: d.getElementById('slot2-email'),
      slot2Plan: d.getElementById('slot2-plan'),
      slot2PrimaryPercent: d.getElementById('slot2-primary-percent'),
      slot2PrimaryBar: d.getElementById('slot2-primary-bar'),
      slot2PrimaryCountdown: d.getElementById('slot2-primary-countdown'),
      slot2SecondaryPercent: d.getElementById('slot2-secondary-percent'),
      slot2SecondaryBar: d.getElementById('slot2-secondary-bar'),
      slot2SecondaryCountdown: d.getElementById('slot2-secondary-countdown'),

      // Toast Banner
      toastBanner: d.getElementById('toast-banner'),
      toastMessage: d.getElementById('toast-message'),

      // Settings Modal
      settingsModal: d.getElementById('settings-modal'),
      btnCloseSettings: d.getElementById('btn-close-settings'),
      btnCancelSettings: d.getElementById('btn-cancel-settings'),
      btnSaveSettings: d.getElementById('btn-save-settings'),

      // Settings Inputs
      settingPollInterval: d.getElementById('setting-poll-interval'),
      settingAlertThreshold: d.getElementById('setting-alert-threshold'),
      settingAlertThresholdVal: d.getElementById('setting-alert-threshold-val'),
      settingNotifyThreshold: d.getElementById('setting-notify-threshold'),
      settingNotifyReset: d.getElementById('setting-notify-reset'),
      settingStartOnBoot: d.getElementById('setting-start-on-boot'),
    };
  }

  /**
   * 사용자 이벤트 리스너 바인딩
   */
  bindEvents() {
    const { el } = this;

    // 1. 창 고정 핀 버튼
    if (el.pinBtn) {
      el.pinBtn.addEventListener('click', () => this.togglePinMode());
    }

    // 2. 테마 전환 버튼
    if (el.themeBtn) {
      el.themeBtn.addEventListener('click', () => this.toggleTheme());
    }

    // 3. 닫기 버튼
    if (el.closeBtn) {
      el.closeBtn.addEventListener('click', () => this.closeWindow());
    }

    // 4. 새로고침 버튼
    if (el.btnRefresh) {
      el.btnRefresh.addEventListener('click', () => this.handleRefresh());
    }

    // 5. 설정 모달 열기/닫기
    if (el.btnSettings) {
      el.btnSettings.addEventListener('click', () => this.openSettings());
    }
    if (el.btnCloseSettings) {
      el.btnCloseSettings.addEventListener('click', () => this.closeSettings());
    }
    if (el.btnCancelSettings) {
      el.btnCancelSettings.addEventListener('click', () => this.closeSettings());
    }
    if (el.settingsModal) {
      el.settingsModal.addEventListener('click', (e) => {
        if (e.target === el.settingsModal) {
          this.closeSettings();
        }
      });
    }

    // 설정 임계치 슬라이더 라이브 표시
    if (el.settingAlertThreshold) {
      el.settingAlertThreshold.addEventListener('input', (e) => {
        if (el.settingAlertThresholdVal) {
          el.settingAlertThresholdVal.textContent = `${e.target.value}%`;
        }
      });
    }

    // 설정 저장 버튼
    if (el.btnSaveSettings) {
      el.btnSaveSettings.addEventListener('click', () => this.saveSettings());
    }

    // 6. 슬롯 추가 버튼
    if (el.addSlotBtn) {
      el.addSlotBtn.addEventListener('click', () => this.handleAddSlot());
    }

    // 7. 동적 카드 컨테이너 이벤트 위임 (로그아웃, 로그인, 로그인 취소, 카드 삭제)
    if (el.cardsContainer) {
      el.cardsContainer.addEventListener('click', (e) => {
        const target = e.target;
        if (!target) return;

        // 로그아웃 버튼
        const logoutBtn = target.closest('.btn-logout');
        if (logoutBtn) {
          const slotId = logoutBtn.dataset.slot;
          if (slotId) this.handleLogout(slotId);
          return;
        }

        // 로그인 버튼
        const loginBtn = target.closest('.btn-login-slot');
        if (loginBtn) {
          const slotId = loginBtn.dataset.slot;
          if (slotId) this.handleLoginSlot(slotId);
          return;
        }

        // 로그인 취소 버튼
        const cancelBtn = target.closest('.btn-cancel-login');
        if (cancelBtn) {
          const slotId = cancelBtn.dataset.slot;
          if (slotId) this.handleCancelLoginSlot(slotId);
          return;
        }

        // 카드 삭제 버튼
        const deleteBtn = target.closest('.btn-delete-slot');
        if (deleteBtn) {
          const slotId = deleteBtn.dataset.slot;
          if (slotId) this.handleDeleteSlot(slotId);
          return;
        }
      });
    }

    // 하위 호환용 slot2 정적 버튼 리스너 바인딩
    if (el.btnLoginSlot2) {
      el.btnLoginSlot2.addEventListener('click', () => this.handleLoginSlot('slot2'));
    }
    if (el.btnCancelLoginSlot2) {
      el.btnCancelLoginSlot2.addEventListener('click', () => this.handleCancelLoginSlot('slot2'));
    }
  }

  /**
   * 테마 적용
   * @param {'dark' | 'light'} theme 
   */
  setTheme(theme) {
    this.currentTheme = theme;
    if (this.doc) {
      if (this.doc.documentElement) {
        this.doc.documentElement.dataset.theme = theme;
      }
      if (this.doc.body) {
        this.doc.body.setAttribute('data-theme', theme);
        this.doc.body.classList.toggle('light-theme', theme === 'light');
        this.doc.body.classList.toggle('dark-theme', theme === 'dark');
      }
    }
  }

  /**
   * 테마 토글 핸들러
   */
  async toggleTheme() {
    const next = getNextTheme(this.currentTheme);
    this.setTheme(next);

    try {
      if (this.api) {
        if (typeof this.api.setTheme === 'function') {
          await this.api.setTheme({ theme: next });
        } else if (typeof this.api.saveConfig === 'function') {
          await this.api.saveConfig({ theme: next });
        }
      }
      this.showToast(next === 'light' ? '라이트 테마로 변경되었습니다.' : '다크 테마로 변경되었습니다.');
    } catch {
      // 비동기 에러 무시
    }
  }

  /**
   * 창 고정 핀 토글 핸들러
   */
  async togglePinMode() {
    this.isPinned = !this.isPinned;
    const { el } = this;
    if (el.pinBtn) {
      el.pinBtn.classList.toggle('active', this.isPinned);
      el.pinBtn.title = this.isPinned ? '창 고정 해제' : '항상 위에 고정 (핀)';
      el.pinBtn.setAttribute('aria-pressed', String(this.isPinned));
    }

    try {
      if (this.api && typeof this.api.setPinMode === 'function') {
        await this.api.setPinMode({ isPinned: this.isPinned });
      }
      this.showToast(this.isPinned ? '창 항상 위 고정이 활성화되었습니다.' : '창 고정이 해제되었습니다.');
    } catch {
      // 무시
    }
  }

  /**
   * 창 닫기 핸들러
   */
  async closeWindow() {
    try {
      if (this.api && typeof this.api.closeWindow === 'function') {
        await this.api.closeWindow();
      }
    } catch {
      // 무시
    }
  }

  /**
   * 초기 데이터 및 테마/핀 설정 로드
   */
  async loadInitialData() {
    try {
      this.setConnectionStatus('updating');

      // 1. 설정 및 테마/핀 로드
      if (this.api) {
        if (typeof this.api.getConfig === 'function') {
          const cfg = await this.api.getConfig();
          if (cfg?.theme) {
            this.setTheme(cfg.theme);
          }
        }
        if (typeof this.api.getPinMode === 'function') {
          const pinRes = await this.api.getPinMode();
          if (pinRes && typeof pinRes.isPinned === 'boolean') {
            this.isPinned = pinRes.isPinned;
            if (this.el.pinBtn) {
              this.el.pinBtn.classList.toggle('active', this.isPinned);
            }
          }
        }
      }

      // 2. 사용량 데이터 로드
      if (this.api && typeof this.api.getUsage === 'function') {
        const data = await this.api.getUsage();
        this.renderUsage(data);
        return;
      }

      // 폴백
      this.renderUsage(createMockUsageData());
    } catch (err) {
      this.setConnectionStatus('error');
      this.showToast(err?.message || '사용량 조회 중 오류가 발생했습니다.', 'error');
    }
  }

  /**
   * 사용량 데이터에서 슬롯 맵 추출
   * @param {object} data 
   * @returns {Record<string, object>}
   */
  extractSlots(data) {
    if (!data || typeof data !== 'object') {
      return {
        slot1: { slotId: 'slot1', linked: false },
        slot2: { slotId: 'slot2', linked: false },
      };
    }

    if (data.slots && typeof data.slots === 'object' && !Array.isArray(data.slots)) {
      return data.slots;
    }

    const slots = {};
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('slot') && value && typeof value === 'object') {
        slots[key] = value;
      }
    }

    if (Object.keys(slots).length === 0) {
      return {
        slot1: data.slot1 || { slotId: 'slot1', linked: false },
        slot2: data.slot2 || { slotId: 'slot2', linked: false },
      };
    }

    return slots;
  }

  /**
   * 사용량 데이터 전체 렌더링
   * @param {object} data
   */
  renderUsage(data) {
    if (!data) return;
    this.currentData = data;

    // 헤더 상태 갱신
    this.renderHeader(data);

    // 동적 슬롯 카드 목록 렌더링
    this.renderSlots(data);

    // 하위 호환 정적 요소 렌더링 (존재할 경우)
    if (data.slot1) {
      this.renderSlot1(data.slot1);
    }
    if (data.slot2) {
      this.renderSlot2(data.slot2);
    }

    // 카운트다운 즉시 갱신
    this.tickCountdown();
  }

  /**
   * 동적 카드 목록 렌더링
   * @param {object} data 
   */
  renderSlots(data) {
    const slots = this.extractSlots(data);
    const html = generateSlotsHtml(slots, { loggingSlots: this.loggingSlots });

    if (this.el.cardsContainer) {
      this.el.cardsContainer.innerHTML = html;
    }
  }

  /**
   * 헤더 상태 렌더링
   */
  renderHeader(data) {
    const { el } = this;
    const ts = data.timestamp || data.slot1?.updatedAt || Date.now();
    
    if (el.lastUpdatedText) {
      el.lastUpdatedText.textContent = `마지막 갱신: ${formatLastUpdated(ts)}`;
    }

    const slots = this.extractSlots(data);
    const hasError = Object.values(slots).some(
      (slot) => slot && slot.linked && slot.success === false
    );

    if (hasError) {
      this.setConnectionStatus('error');
    } else {
      this.setConnectionStatus('online');
    }
  }

  /**
   * 연결 상태 인디케이터 클래스 설정
   */
  setConnectionStatus(status) {
    const { connectionIndicator } = this.el;
    if (!connectionIndicator) return;

    connectionIndicator.className = 'status-indicator';
    if (status === 'online') {
      connectionIndicator.classList.add('online');
      connectionIndicator.title = '연결 상태: 정상';
    } else if (status === 'updating') {
      connectionIndicator.classList.add('updating');
      connectionIndicator.title = '연결 상태: 갱신 중';
    } else {
      connectionIndicator.classList.add('error');
      connectionIndicator.title = '연결 상태: 오류 발생';
    }
  }

  /**
   * 슬롯 1 카드 렌더링 (하위 호환성)
   */
  renderSlot1(slotData) {
    const { el } = this;
    if (!slotData) return;

    if (el.slot1Email) {
      el.slot1Email.textContent = slotData.email || '인증 완료 (이메일 미확인)';
      el.slot1Email.title = slotData.email || '';
    }

    if (el.slot1Plan) {
      const planInfo = getPlanBadgeInfo(slotData.planType);
      el.slot1Plan.textContent = planInfo.label;
      el.slot1Plan.className = `plan-badge ${planInfo.badgeClass}`;
    }

    const metrics = slotData.metrics || slotData;
    const primary = metrics.primaryWindow || {};
    const secondary = metrics.secondaryWindow || {};

    const pRemaining = typeof primary.remainingPercent === 'number' ? primary.remainingPercent : 0;
    if (el.slot1PrimaryPercent) {
      el.slot1PrimaryPercent.textContent = `${pRemaining}%`;
    }
    if (el.slot1PrimaryBar) {
      el.slot1PrimaryBar.style.width = `${pRemaining}%`;
      el.slot1PrimaryBar.className = `progress-fill ${getProgressColorClass(pRemaining)}`;
    }
    if (el.slot1PrimaryCountdown) {
      el.slot1PrimaryCountdown.textContent = primary.formattedResetText || formatCountdown(primary.resetAfterSeconds || 0);
    }

    const sRemaining = typeof secondary.remainingPercent === 'number' ? secondary.remainingPercent : 0;
    if (el.slot1SecondaryPercent) {
      el.slot1SecondaryPercent.textContent = `${sRemaining}%`;
    }
    if (el.slot1SecondaryBar) {
      el.slot1SecondaryBar.style.width = `${sRemaining}%`;
      el.slot1SecondaryBar.className = `progress-fill ${getProgressColorClass(sRemaining)}`;
    }
    if (el.slot1SecondaryCountdown) {
      el.slot1SecondaryCountdown.textContent = secondary.formattedResetText || formatCountdown(secondary.resetAfterSeconds || 0);
    }
  }

  /**
   * 슬롯 2 카드 렌더링 (하위 호환성)
   */
  renderSlot2(slotData) {
    const { el } = this;
    const isLinked = Boolean(slotData && slotData.linked);

    if (this.loggingSlots['slot2']) {
      this._setSlot2View('logging');
      return;
    }

    if (!isLinked) {
      this._setSlot2View('unlinked');
      return;
    }

    this._setSlot2View('linked');

    if (el.slot2Email) {
      el.slot2Email.textContent = slotData.email || '인증 완료 (이메일 미확인)';
      el.slot2Email.title = slotData.email || '';
    }

    if (el.slot2Plan) {
      const planInfo = getPlanBadgeInfo(slotData.planType);
      el.slot2Plan.textContent = planInfo.label;
      el.slot2Plan.className = `plan-badge ${planInfo.badgeClass}`;
    }

    const metrics = slotData.metrics || slotData;
    const primary = metrics.primaryWindow || {};
    const secondary = metrics.secondaryWindow || {};

    const pRemaining = typeof primary.remainingPercent === 'number' ? primary.remainingPercent : 0;
    if (el.slot2PrimaryPercent) {
      el.slot2PrimaryPercent.textContent = `${pRemaining}%`;
    }
    if (el.slot2PrimaryBar) {
      el.slot2PrimaryBar.style.width = `${pRemaining}%`;
      el.slot2PrimaryBar.className = `progress-fill ${getProgressColorClass(pRemaining)}`;
    }
    if (el.slot2PrimaryCountdown) {
      el.slot2PrimaryCountdown.textContent = primary.formattedResetText || formatCountdown(primary.resetAfterSeconds || 0);
    }

    const sRemaining = typeof secondary.remainingPercent === 'number' ? secondary.remainingPercent : 0;
    if (el.slot2SecondaryPercent) {
      el.slot2SecondaryPercent.textContent = `${sRemaining}%`;
    }
    if (el.slot2SecondaryBar) {
      el.slot2SecondaryBar.style.width = `${sRemaining}%`;
      el.slot2SecondaryBar.className = `progress-fill ${getProgressColorClass(sRemaining)}`;
    }
    if (el.slot2SecondaryCountdown) {
      el.slot2SecondaryCountdown.textContent = secondary.formattedResetText || formatCountdown(secondary.resetAfterSeconds || 0);
    }
  }

  /**
   * 슬롯 2 뷰 전환 도우미 (하위 호환성)
   * @param {'unlinked' | 'logging' | 'linked'} viewName
   */
  _setSlot2View(viewName) {
    const { el } = this;
    if (!el.slot2UnlinkedView || !el.slot2LoggingView || !el.slot2LinkedView) return;

    el.slot2UnlinkedView.classList.toggle('hidden', viewName !== 'unlinked');
    el.slot2LoggingView.classList.toggle('hidden', viewName !== 'logging');
    el.slot2LinkedView.classList.toggle('hidden', viewName !== 'linked');
  }

  /**
   * 1초 주기 실시간 카운트다운 틱 루프
   */
  startCountdownTicker() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
    }
    this.countdownTimer = setInterval(() => {
      this.tickCountdown();
    }, 1000);
  }

  stopCountdownTicker() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  /**
   * 현재 시간과 resetAt 타임스탬프를 비교하여 화면의 모든 카운트다운 텍스트 갱신
   */
  tickCountdown() {
    if (!this.currentData) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const toEpochSec = (val) => (val > 1e11 ? Math.floor(val / 1000) : val);
    const slots = this.extractSlots(this.currentData);

    for (const [slotId, slot] of Object.entries(slots)) {
      if (!slot) continue;
      const metrics = slot.metrics || slot;

      // 5시간 한도 카운트다운
      if (metrics.primaryWindow?.resetAt) {
        const diff = Math.max(0, toEpochSec(metrics.primaryWindow.resetAt) - nowSec);
        const formatted = formatCountdown(diff);
        const target = this.doc?.getElementById(`${slotId}-primary-countdown`) || this.el?.[`${slotId}PrimaryCountdown`];
        if (target) {
          target.textContent = formatted;
        }
      }

      // 주간 한도 카운트다운
      if (metrics.secondaryWindow?.resetAt) {
        const diff = Math.max(0, toEpochSec(metrics.secondaryWindow.resetAt) - nowSec);
        const formatted = formatCountdown(diff);
        const target = this.doc?.getElementById(`${slotId}-secondary-countdown`) || this.el?.[`${slotId}SecondaryCountdown`];
        if (target) {
          target.textContent = formatted;
        }
      }
    }
  }

  /**
   * 새로고침 핸들러
   */
  async handleRefresh() {
    const { el } = this;
    if (el.btnRefresh) {
      el.btnRefresh.classList.add('spinning');
    }
    this.setConnectionStatus('updating');

    try {
      let freshData = null;
      if (this.api) {
        const refreshFn = this.api.refreshUsage || this.api.refreshNow;
        if (typeof refreshFn === 'function') {
          freshData = await refreshFn();
        } else if (typeof this.api.getUsage === 'function') {
          freshData = await this.api.getUsage();
        }
      }
      if (!freshData) {
        freshData = createMockUsageData();
      }
      this.renderUsage(freshData);
      this.showToast('사용량 정보를 성공적으로 갱신했습니다.', 'success');
    } catch (err) {
      this.setConnectionStatus('error');
      this.showToast(`갱신 실패: ${err?.message || '알 수 없는 오류'}`, 'error');
    } finally {
      if (el.btnRefresh) {
        el.btnRefresh.classList.remove('spinning');
      }
    }
  }

  /**
   * 특정 슬롯 연동 플로우 트리거
   * @param {string} slotId 
   */
  async handleLoginSlot(slotId) {
    this.loggingSlots[slotId] = true;
    this.renderSlots(this.currentData);
    if (slotId === 'slot2') this.renderSlot2(this.currentData?.slot2);

    try {
      if (this.api) {
        const loginFn = this.api.loginSlot || (slotId === 'slot2' ? this.api.startLoginSlot2 : null);
        if (typeof loginFn === 'function') {
          await loginFn(slotId);
          await this.handleRefresh();
          this.showToast(`계정(${slotId}) 연동이 완료되었습니다.`, 'success');
          return;
        }
      }
      this.showToast(`계정(${slotId}) 연동이 완료되었습니다.`, 'success');
    } catch (err) {
      this.showToast(`연동 실패: ${err?.message || '로그인이 취소되었습니다.'}`, 'error');
    } finally {
      delete this.loggingSlots[slotId];
      this.renderSlots(this.currentData);
      if (slotId === 'slot2') this.renderSlot2(this.currentData?.slot2);
    }
  }

  /**
   * 특정 슬롯 연동 취소
   * @param {string} slotId 
   */
  async handleCancelLoginSlot(slotId) {
    delete this.loggingSlots[slotId];
    try {
      if (this.api) {
        const cancelFn = this.api.cancelLogin || (slotId === 'slot2' ? this.api.cancelLoginSlot2 : null);
        if (typeof cancelFn === 'function') {
          await cancelFn(slotId);
        }
      }
      this.showToast(`계정(${slotId}) 연동이 취소되었습니다.`);
    } catch {
      // 무시
    } finally {
      this.renderSlots(this.currentData);
      if (slotId === 'slot2') this.renderSlot2(this.currentData?.slot2);
    }
  }

  /**
   * 하위 호환용 slot2 로그인 트리거
   */
  async handleSlot2Login() {
    return this.handleLoginSlot('slot2');
  }

  /**
   * 하위 호환용 slot2 로그인 취소
   */
  async handleCancelSlot2Login() {
    return this.handleCancelLoginSlot('slot2');
  }

  /**
   * 계정 로그아웃 처리
   * @param {string} slotId 
   */
  async handleLogout(slotId) {
    const confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
      ? window.confirm(`계정(${slotId})에서 로그아웃하시겠습니까?`)
      : true;

    if (!confirmed) return;

    try {
      if (this.api && typeof this.api.logoutSlot === 'function') {
        await this.api.logoutSlot(slotId);
      }
      await this.handleRefresh();
      this.showToast(`계정(${slotId})에서 로그아웃되었습니다.`, 'success');
    } catch (err) {
      this.showToast(`로그아웃 실패: ${err?.message || '오류'}`, 'error');
    }
  }

  /**
   * 새 계정 슬롯 추가
   */
  async handleAddSlot() {
    try {
      if (this.api && typeof this.api.addSlot === 'function') {
        const result = await this.api.addSlot();
        await this.handleRefresh();
        this.showToast(`새 계정(${result?.slotId || '슬롯'})이 추가되었습니다.`, 'success');
        return;
      }
      this.showToast('새 슬롯 추가를 지원하지 않는 환경입니다.', 'error');
    } catch (err) {
      this.showToast(`계정 추가 실패: ${err?.message || '오류'}`, 'error');
    }
  }

  /**
   * 계정 슬롯 삭제
   * @param {string} slotId 
   */
  async handleDeleteSlot(slotId) {
    const confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
      ? window.confirm(`계정(${slotId}) 카드를 삭제하시겠습니까?`)
      : true;

    if (!confirmed) return;

    try {
      if (this.api && typeof this.api.removeSlot === 'function') {
        await this.api.removeSlot(slotId);
      }
      await this.handleRefresh();
      this.showToast(`계정(${slotId}) 카드가 삭제되었습니다.`, 'success');
    } catch (err) {
      this.showToast(`삭제 실패: ${err?.message || '오류'}`, 'error');
    }
  }

  /**
   * 설정 모달 열기
   */
  async openSettings() {
    const { el } = this;
    if (!el.settingsModal) return;

    try {
      let cfg = this.currentConfig;
      if (!cfg && this.api) {
        const getCfgFn = this.api.getConfig || this.api.getSettings;
        if (typeof getCfgFn === 'function') {
          cfg = await getCfgFn();
        }
      }
      if (!cfg) {
        cfg = createMockConfig();
      }
      this.currentConfig = cfg;

      // 폼 컨트롤 채우기
      if (el.settingPollInterval) {
        el.settingPollInterval.value = String(cfg.pollIntervalMinutes ?? 5);
      }
      if (el.settingAlertThreshold) {
        const threshold = cfg.alertThresholdPercent ?? 10;
        el.settingAlertThreshold.value = String(threshold);
        if (el.settingAlertThresholdVal) {
          el.settingAlertThresholdVal.textContent = `${threshold}%`;
        }
      }
      if (el.settingNotifyThreshold) {
        el.settingNotifyThreshold.checked = cfg.notifyOnThreshold !== false;
      }
      if (el.settingNotifyReset) {
        el.settingNotifyReset.checked = cfg.notifyOnReset !== false;
      }
      if (el.settingStartOnBoot) {
        el.settingStartOnBoot.checked = Boolean(cfg.startOnBoot);
      }

      el.settingsModal.classList.remove('hidden');
    } catch (err) {
      this.showToast(`설정을 불러오지 못했습니다: ${err?.message || '오류'}`, 'error');
    }
  }

  /**
   * 설정 모달 닫기
   */
  closeSettings() {
    const { el } = this;
    if (el.settingsModal) {
      el.settingsModal.classList.add('hidden');
    }
  }

  /**
   * 설정 저장 핸들러
   */
  async saveSettings() {
    const { el } = this;
    const patch = {
      pollIntervalMinutes: parseInt(el.settingPollInterval?.value || '5', 10),
      alertThresholdPercent: parseInt(el.settingAlertThreshold?.value || '10', 10),
      notifyOnThreshold: Boolean(el.settingNotifyThreshold?.checked),
      notifyOnReset: Boolean(el.settingNotifyReset?.checked),
      startOnBoot: Boolean(el.settingStartOnBoot?.checked),
    };

    try {
      if (this.api) {
        const saveFn = this.api.saveConfig || this.api.saveSettings;
        if (typeof saveFn === 'function') {
          await saveFn(patch);
        }
      }
      this.currentConfig = { ...this.currentConfig, ...patch };
      this.closeSettings();
      this.showToast('환경설정이 안전하게 저장되었습니다.', 'success');
    } catch (err) {
      this.showToast(`설정 저장 실패: ${err?.message || '오류'}`, 'error');
    }
  }

  /**
   * 화면 하단 토스트 배너 표시
   * @param {string} message 
   * @param {'default' | 'success' | 'error'} type 
   */
  showToast(message, type = 'default') {
    const { el } = this;
    if (!el.toastBanner || !el.toastMessage) return;

    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
    }

    el.toastMessage.textContent = message;
    el.toastBanner.className = 'toast-banner';
    if (type === 'success') {
      el.toastBanner.classList.add('toast-success');
    } else if (type === 'error') {
      el.toastBanner.classList.add('toast-error');
    }
    el.toastBanner.classList.remove('hidden');

    this.toastTimer = setTimeout(() => {
      el.toastBanner.classList.add('hidden');
    }, 3000);
  }
}

// ============================================================================
// 런타임 자동 초기화 (브라우저/Electron 환경)
// ============================================================================

let appRendererInstance = null;

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    appRendererInstance = new MonitorRenderer({
      api: window.electronAPI,
      document: document,
    });
    appRendererInstance.init();
  });
}

// ============================================================================
// 모듈 내보내기 (테스트 및 외부 연동용)
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    formatCountdown,
    getProgressColorClass,
    getPlanBadgeInfo,
    formatLastUpdated,
    getNextTheme,
    escapeHtml,
    getSlotBadgeClass,
    generateSlotsHtml,
    createMockUsageData,
    createMockConfig,
    MonitorRenderer,
  };
}
