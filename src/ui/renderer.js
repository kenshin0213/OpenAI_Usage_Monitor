/**
 * src/ui/renderer.js
 * 
 * ChatGPT 듀얼 사용량 모니터 - 트레이 팝업 렌더러 로직
 * 
 * 주요 기능:
 * 1. 실시간 사용량 메트릭(5시간 단위, 주간 한도) DOM 바인딩 및 시각화
 * 2. 부드러운 프로그레스 바 및 잔여량 임계치 컬러 큐 (초록 >30%, 노랑 11~30%, 빨강 <=10%)
 * 3. 1초 주기 실시간 카운트다운 타이머 (resetAt 타임스탬프 기반 자동 계산)
 * 4. 계정 2 동적 상태 전환 (미연동, 로그인 진행 중, 연동 완료)
 * 5. 환경설정 모달 제어 (갱신 주기, 임계치 슬라이더, 토스트 알림 ON/OFF)
 * 6. Electron IPC 통신 및 브라우저 독립 모의(Mock) 실행 지원
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
    this.isLoggingInSlot2 = false;
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
      startLoginSlot2: async () => {
        await new Promise((r) => setTimeout(r, 1500));
        const nowSec = Math.floor(Date.now() / 1000);
        mockData.slot2 = {
          slotId: 'slot2',
          success: true,
          linked: true,
          email: 'user2.work@gmail.com',
          planType: 'plus',
          primaryWindow: {
            usedPercent: 45,
            remainingPercent: 55,
            limitWindowSeconds: 18000,
            resetAfterSeconds: 8400,
            resetAt: nowSec + 8400,
            formattedResetText: formatCountdown(8400),
          },
          secondaryWindow: {
            usedPercent: 20,
            remainingPercent: 80,
            limitWindowSeconds: 604800,
            resetAfterSeconds: 420000,
            resetAt: nowSec + 420000,
            formattedResetText: formatCountdown(420000),
          },
          updatedAt: new Date().toISOString(),
        };
        return { success: true };
      },
      cancelLoginSlot2: async () => {
        return { success: true, cancelled: true };
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
      // Header
      connectionIndicator: d.getElementById('connection-indicator'),
      lastUpdatedText: d.getElementById('last-updated-text'),
      btnRefresh: d.getElementById('btn-refresh'),
      btnSettings: d.getElementById('btn-settings'),

      // Slot 1
      slot1Email: d.getElementById('slot1-email'),
      slot1Plan: d.getElementById('slot1-plan'),
      slot1PrimaryPercent: d.getElementById('slot1-primary-percent'),
      slot1PrimaryBar: d.getElementById('slot1-primary-bar'),
      slot1PrimaryCountdown: d.getElementById('slot1-primary-countdown'),
      slot1SecondaryPercent: d.getElementById('slot1-secondary-percent'),
      slot1SecondaryBar: d.getElementById('slot1-secondary-bar'),
      slot1SecondaryCountdown: d.getElementById('slot1-secondary-countdown'),

      // Slot 2 Views
      slot2UnlinkedView: d.getElementById('slot2-unlinked-view'),
      slot2LoggingView: d.getElementById('slot2-logging-view'),
      slot2LinkedView: d.getElementById('slot2-linked-view'),

      // Slot 2 Actions
      btnLoginSlot2: d.getElementById('btn-login-slot2'),
      btnCancelLoginSlot2: d.getElementById('btn-cancel-login-slot2'),

      // Slot 2 Linked Elements
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

    // 새로고침 버튼
    if (el.btnRefresh) {
      el.btnRefresh.addEventListener('click', () => this.handleRefresh());
    }

    // 설정 모달 열기/닫기
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

    // 계정 2 연동 버튼
    if (el.btnLoginSlot2) {
      el.btnLoginSlot2.addEventListener('click', () => this.handleSlot2Login());
    }

    // 계정 2 연동 취소 버튼
    if (el.btnCancelLoginSlot2) {
      el.btnCancelLoginSlot2.addEventListener('click', () => this.handleCancelSlot2Login());
    }
  }

  /**
   * 초기 데이터 로드
   */
  async loadInitialData() {
    try {
      this.setConnectionStatus('updating');
      if (this.api) {
        const getUsageFn = this.api.getUsage;
        if (typeof getUsageFn === 'function') {
          const data = await getUsageFn();
          this.renderUsage(data);
          return;
        }
      }
      // 폴백
      this.renderUsage(createMockUsageData());
    } catch (err) {
      this.setConnectionStatus('error');
      this.showToast(err?.message || '사용량 조회 중 오류가 발생했습니다.', 'error');
    }
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

    // 슬롯 1 렌더링
    this.renderSlot1(data.slot1);

    // 슬롯 2 렌더링
    this.renderSlot2(data.slot2);

    // 카운트다운 즉시 갱신
    this.tickCountdown();
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

    const hasError = (data.slot1 && data.slot1.success === false) ||
                     (data.slot2 && data.slot2.linked && data.slot2.success === false);

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
   * 슬롯 1 카드 렌더링
   */
  renderSlot1(slotData) {
    const { el } = this;
    if (!slotData) return;

    // 이메일
    if (el.slot1Email) {
      el.slot1Email.textContent = slotData.email || '인증 완료 (이메일 미확인)';
      el.slot1Email.title = slotData.email || '';
    }

    // 플랜 배지
    if (el.slot1Plan) {
      const planInfo = getPlanBadgeInfo(slotData.planType);
      el.slot1Plan.textContent = planInfo.label;
      el.slot1Plan.className = `plan-badge ${planInfo.badgeClass}`;
    }

    const metrics = slotData.metrics || slotData;
    const primary = metrics.primaryWindow || {};
    const secondary = metrics.secondaryWindow || {};

    // 5시간 단위 한도 (Primary Window)
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

    // 주간 사용 한도 (Secondary Window)
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
   * 슬롯 2 카드 렌더링 (미연동, 로그인 진행 중, 연동 완료)
   */
  renderSlot2(slotData) {
    const { el } = this;
    const isLinked = Boolean(slotData && slotData.linked);

    // 1. 로그인 진행 중 상태
    if (this.isLoggingInSlot2) {
      this._setSlot2View('logging');
      return;
    }

    // 2. 미연동 상태
    if (!isLinked) {
      this._setSlot2View('unlinked');
      return;
    }

    // 3. 연동 완료 상태
    this._setSlot2View('linked');

    // 이메일
    if (el.slot2Email) {
      el.slot2Email.textContent = slotData.email || '인증 완료 (이메일 미확인)';
      el.slot2Email.title = slotData.email || '';
    }

    // 플랜 배지
    if (el.slot2Plan) {
      const planInfo = getPlanBadgeInfo(slotData.planType);
      el.slot2Plan.textContent = planInfo.label;
      el.slot2Plan.className = `plan-badge ${planInfo.badgeClass}`;
    }

    const metrics = slotData.metrics || slotData;
    const primary = metrics.primaryWindow || {};
    const secondary = metrics.secondaryWindow || {};

    // 5시간 단위 한도 (Primary Window)
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

    // 주간 사용 한도 (Secondary Window)
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
   * 슬롯 2 뷰 전환 도우미
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
   * 현재 시간과 resetAt 타임스탬프를 비교하여 화면의 카운트다운 텍스트 갱신
   */
  tickCountdown() {
    if (!this.currentData) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const { el } = this;

    // 슬롯 1 카운트다운
    if (this.currentData.slot1) {
      const s1 = this.currentData.slot1.metrics || this.currentData.slot1;
      if (s1.primaryWindow?.resetAt && el.slot1PrimaryCountdown) {
        const diff = Math.max(0, s1.primaryWindow.resetAt - nowSec);
        el.slot1PrimaryCountdown.textContent = formatCountdown(diff);
      }
      if (s1.secondaryWindow?.resetAt && el.slot1SecondaryCountdown) {
        const diff = Math.max(0, s1.secondaryWindow.resetAt - nowSec);
        el.slot1SecondaryCountdown.textContent = formatCountdown(diff);
      }
    }

    // 슬롯 2 카운트다운
    if (this.currentData.slot2 && this.currentData.slot2.linked && !this.isLoggingInSlot2) {
      const s2 = this.currentData.slot2.metrics || this.currentData.slot2;
      if (s2.primaryWindow?.resetAt && el.slot2PrimaryCountdown) {
        const diff = Math.max(0, s2.primaryWindow.resetAt - nowSec);
        el.slot2PrimaryCountdown.textContent = formatCountdown(diff);
      }
      if (s2.secondaryWindow?.resetAt && el.slot2SecondaryCountdown) {
        const diff = Math.max(0, s2.secondaryWindow.resetAt - nowSec);
        el.slot2SecondaryCountdown.textContent = formatCountdown(diff);
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
   * 계정 2 연동 플로우 트리거
   */
  async handleSlot2Login() {
    this.isLoggingInSlot2 = true;
    this.renderSlot2(this.currentData?.slot2);

    try {
      if (this.api) {
        const loginFn = this.api.startLoginSlot2 || this.api.loginSlot2 || this.api.loginAccount2;
        if (typeof loginFn === 'function') {
          await loginFn();
          // 로그인 완료 후 최신 데이터 재조회
          await this.handleRefresh();
          this.showToast('계정 2 연동이 성공적으로 완료되었습니다.', 'success');
          return;
        }
      }
      // API 미제공 시 모의 완료
      this.showToast('계정 2 연동이 완료되었습니다.', 'success');
    } catch (err) {
      this.showToast(`연동 실패: ${err?.message || '로그인이 취소되었습니다.'}`, 'error');
    } finally {
      this.isLoggingInSlot2 = false;
      this.renderSlot2(this.currentData?.slot2);
    }
  }

  /**
   * 계정 2 연동 취소
   */
  async handleCancelSlot2Login() {
    this.isLoggingInSlot2 = false;
    try {
      if (this.api) {
        const cancelFn = this.api.cancelLoginSlot2 || this.api.cancelLogin;
        if (typeof cancelFn === 'function') {
          await cancelFn();
        }
      }
      this.showToast('계정 2 연동이 취소되었습니다.');
    } catch {
      // 무시
    } finally {
      this.renderSlot2(this.currentData?.slot2);
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
    createMockUsageData,
    createMockConfig,
    MonitorRenderer,
  };
}
