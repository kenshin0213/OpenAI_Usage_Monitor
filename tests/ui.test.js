/**
 * tests/ui.test.js
 * 
 * 트레이 팝업 UI 마크업 구조 및 렌더러 로직 단위 테스트
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  formatCountdown,
  getProgressColorClass,
  getPlanBadgeInfo,
  formatLastUpdated,
  createMockUsageData,
  createMockConfig,
  MonitorRenderer,
} = require('../src/ui/renderer.js');

describe('UI 컴포넌트 및 렌더러 단위 테스트', () => {
  describe('formatCountdown - 리셋 카운트다운 시간 포맷팅', () => {
    it('60초 이하 또는 0 이하의 시간은 "곧 초기화"를 반환해야 한다', () => {
      assert.strictEqual(formatCountdown(0), '곧 초기화');
      assert.strictEqual(formatCountdown(30), '곧 초기화');
      assert.strictEqual(formatCountdown(60), '곧 초기화');
      assert.strictEqual(formatCountdown(-10), '곧 초기화');
      assert.strictEqual(formatCountdown(NaN), '곧 초기화');
      assert.strictEqual(formatCountdown(null), '곧 초기화');
    });

    it('1분 초과 1시간 이하는 "X분 후 초기화"를 반환해야 한다', () => {
      assert.strictEqual(formatCountdown(61), '1분 후 초기화');
      assert.strictEqual(formatCountdown(180), '3분 후 초기화');
      assert.strictEqual(formatCountdown(1500), '25분 후 초기화');
      assert.strictEqual(formatCountdown(3600), '60분 후 초기화');
    });

    it('1시간 초과 24시간 이하는 시간 및 분 단위로 반환해야 한다', () => {
      // 분이 0인 경우
      assert.strictEqual(formatCountdown(7200), '2시간 후 초기화');
      // 시간 및 분이 모두 있는 경우
      assert.strictEqual(formatCountdown(3660), '1시간 1분 후 초기화');
      assert.strictEqual(formatCountdown(5400), '1시간 30분 후 초기화');
      assert.strictEqual(formatCountdown(86340), '23시간 59분 후 초기화');
    });

    it('24시간 초과는 일 및 시간 단위로 반환해야 한다', () => {
      // 시간이 0인 경우
      assert.strictEqual(formatCountdown(86400 * 2), '2일 후 초기화');
      // 일 및 시간이 모두 있는 경우
      assert.strictEqual(formatCountdown(86400 + 3600 * 5), '1일 5시간 후 초기화');
      assert.strictEqual(formatCountdown(86400 * 3 + 3600 * 12 + 120), '3일 12시간 후 초기화');
    });
  });

  describe('getProgressColorClass - 잔여량에 따른 컬러 큐 분류', () => {
    it('30% 초과일 때는 안전 상태인 progress-green을 반환해야 한다', () => {
      assert.strictEqual(getProgressColorClass(100), 'progress-green');
      assert.strictEqual(getProgressColorClass(75), 'progress-green');
      assert.strictEqual(getProgressColorClass(31), 'progress-green');
    });

    it('11% ~ 30% 일 때는 경고 상태인 progress-yellow를 반환해야 한다', () => {
      assert.strictEqual(getProgressColorClass(30), 'progress-yellow');
      assert.strictEqual(getProgressColorClass(20), 'progress-yellow');
      assert.strictEqual(getProgressColorClass(11), 'progress-yellow');
    });

    it('10% 이하일 때는 위험 상태인 progress-red를 반환해야 한다', () => {
      assert.strictEqual(getProgressColorClass(10), 'progress-red');
      assert.strictEqual(getProgressColorClass(5), 'progress-red');
      assert.strictEqual(getProgressColorClass(0), 'progress-red');
      assert.strictEqual(getProgressColorClass(-5), 'progress-red');
    });
  });

  describe('getPlanBadgeInfo - 플랜 유형에 따른 배지 정보 매핑', () => {
    it('plus 플랜에 대해 Plus 텍스트와 badge-plus 클래스를 반환해야 한다', () => {
      const info = getPlanBadgeInfo('plus');
      assert.strictEqual(info.label, 'Plus');
      assert.strictEqual(info.badgeClass, 'badge-plus');
    });

    it('pro 플랜에 대해 Pro 텍스트와 badge-pro 클래스를 반환해야 한다', () => {
      const info = getPlanBadgeInfo('pro');
      assert.strictEqual(info.label, 'Pro');
      assert.strictEqual(info.badgeClass, 'badge-pro');
    });

    it('team 플랜에 대해 Team 텍스트와 badge-team 클래스를 반환해야 한다', () => {
      const info = getPlanBadgeInfo('team');
      assert.strictEqual(info.label, 'Team');
      assert.strictEqual(info.badgeClass, 'badge-team');
    });

    it('free 플랜에 대해 Free 텍스트와 badge-free 클래스를 반환해야 한다', () => {
      const info = getPlanBadgeInfo('free');
      assert.strictEqual(info.label, 'Free');
      assert.strictEqual(info.badgeClass, 'badge-free');
    });

    it('알 수 없거나 빈 플랜에 대해 기본 배지를 반환해야 한다', () => {
      const infoUnknown = getPlanBadgeInfo('unknown');
      assert.strictEqual(infoUnknown.label, '기본');
      assert.strictEqual(infoUnknown.badgeClass, 'badge-default');

      const infoEmpty = getPlanBadgeInfo(null);
      assert.strictEqual(infoEmpty.label, '기본');
      assert.strictEqual(infoEmpty.badgeClass, 'badge-default');
    });
  });

  describe('formatLastUpdated - 갱신 일시 포맷팅', () => {
    it('유효한 타임스탬프를 시:분:초 형식으로 포맷팅해야 한다', () => {
      const fixedDate = new Date('2026-10-21T15:30:45');
      const formatted = formatLastUpdated(fixedDate.getTime());
      assert.match(formatted, /^\d{2}:\d{2}:\d{2}$/);
      assert.strictEqual(formatted, '15:30:45');
    });

    it('타임스탬프가 없거나 유효하지 않은 경우 "방금 전"을 반환해야 한다', () => {
      assert.strictEqual(formatLastUpdated(null), '방금 전');
      assert.strictEqual(formatLastUpdated('invalid-date'), '방금 전');
    });
  });

  describe('HTML 마크업 구조 무결성 검증 (src/ui/index.html)', () => {
    const htmlPath = path.resolve(__dirname, '../src/ui/index.html');
    let htmlContent = '';

    beforeEach(() => {
      htmlContent = fs.readFileSync(htmlPath, 'utf-8');
    });

    it('HTML 파일이 존재하고 한국어 lang 속성과 적절한 메타 태그를 포함해야 한다', () => {
      assert.ok(htmlContent.includes('<html lang="ko">'));
      assert.ok(htmlContent.includes('ChatGPT 사용량 모니터'));
      assert.ok(htmlContent.includes('style.css'));
      assert.ok(htmlContent.includes('renderer.js'));
    });

    it('헤더 영역 필수 요소(타이틀, 상태 표시, 새로고침 및 설정 버튼)가 존재해야 한다', () => {
      assert.ok(htmlContent.includes('id="connection-indicator"'));
      assert.ok(htmlContent.includes('id="last-updated-text"'));
      assert.ok(htmlContent.includes('id="btn-refresh"'));
      assert.ok(htmlContent.includes('id="btn-settings"'));
    });

    it('계정 1(Slot 1) 카드 필수 요소가 존재해야 한다', () => {
      assert.ok(htmlContent.includes('id="slot1-card"'));
      assert.ok(htmlContent.includes('id="slot1-email"'));
      assert.ok(htmlContent.includes('id="slot1-plan"'));
      assert.ok(htmlContent.includes('id="slot1-primary-percent"'));
      assert.ok(htmlContent.includes('id="slot1-primary-bar"'));
      assert.ok(htmlContent.includes('id="slot1-primary-countdown"'));
      assert.ok(htmlContent.includes('id="slot1-secondary-percent"'));
      assert.ok(htmlContent.includes('id="slot1-secondary-bar"'));
      assert.ok(htmlContent.includes('id="slot1-secondary-countdown"'));
    });

    it('계정 2(Slot 2) 카드 필수 3단계 뷰 및 액션 버튼이 존재해야 한다', () => {
      assert.ok(htmlContent.includes('id="slot2-card"'));
      // 1. 미연동 뷰 및 연동 버튼
      assert.ok(htmlContent.includes('id="slot2-unlinked-view"'));
      assert.ok(htmlContent.includes('id="btn-login-slot2"'));
      assert.ok(htmlContent.includes('+ 계정 2 연동하기'));
      // 2. 로그인 진행 중 뷰 및 취소 버튼
      assert.ok(htmlContent.includes('id="slot2-logging-view"'));
      assert.ok(htmlContent.includes('id="btn-cancel-login-slot2"'));
      assert.ok(htmlContent.includes('브라우저에서 로그인 대기 중...'));
      // 3. 연동 완료 뷰
      assert.ok(htmlContent.includes('id="slot2-linked-view"'));
      assert.ok(htmlContent.includes('id="slot2-email"'));
      assert.ok(htmlContent.includes('id="slot2-primary-bar"'));
      assert.ok(htmlContent.includes('id="slot2-secondary-bar"'));
    });

    it('설정 모달 및 필수 옵션 컨트롤들이 존재해야 한다', () => {
      assert.ok(htmlContent.includes('id="settings-modal"'));
      assert.ok(htmlContent.includes('id="setting-poll-interval"'));
      assert.ok(htmlContent.includes('id="setting-alert-threshold"'));
      assert.ok(htmlContent.includes('id="setting-notify-threshold"'));
      assert.ok(htmlContent.includes('id="setting-notify-reset"'));
      assert.ok(htmlContent.includes('id="setting-start-on-boot"'));
      assert.ok(htmlContent.includes('id="btn-save-settings"'));
      assert.ok(htmlContent.includes('id="btn-close-settings"'));
    });
  });

  describe('CSS 스타일시트 무결성 검증 (src/ui/style.css)', () => {
    const cssPath = path.resolve(__dirname, '../src/ui/style.css');
    let cssContent = '';

    beforeEach(() => {
      cssContent = fs.readFileSync(cssPath, 'utf-8');
    });

    it('다크 테마 색상 변수와 컴포넌트 스타일이 정의되어 있어야 한다', () => {
      assert.ok(cssContent.includes('--bg-app'));
      assert.ok(cssContent.includes('--bg-card'));
      assert.ok(cssContent.includes('--color-brand'));
      assert.ok(cssContent.includes('.progress-green'));
      assert.ok(cssContent.includes('.progress-yellow'));
      assert.ok(cssContent.includes('.progress-red'));
    });

    it('새로고침 스핀 애니메이션 및 스위치 스타일이 정의되어 있어야 한다', () => {
      assert.ok(cssContent.includes('@keyframes spin'));
      assert.ok(cssContent.includes('.spinning'));
      assert.ok(cssContent.includes('.switch'));
      assert.ok(cssContent.includes('.slider'));
    });
  });

  describe('MonitorRenderer - 가상 DOM 기반 상태 바인딩 및 이벤트 동작 검증', () => {
    // 경량 모의 DOM 요소 팩토리
    function createMockElement(id) {
      return {
        id,
        textContent: '',
        value: '',
        checked: false,
        title: '',
        style: {},
        classList: {
          classes: new Set(),
          add(c) { this.classes.add(c); },
          remove(c) { this.classes.delete(c); },
          toggle(c, force) {
            if (force === undefined) {
              if (this.classes.has(c)) this.classes.delete(c);
              else this.classes.add(c);
            } else if (force) {
              this.classes.add(c);
            } else {
              this.classes.delete(c);
            }
          },
          contains(c) { return this.classes.has(c); },
        },
        listeners: {},
        addEventListener(event, fn) {
          this.listeners[event] = this.listeners[event] || [];
          this.listeners[event].push(fn);
        },
        dispatchEvent(event, payload) {
          const fns = this.listeners[event] || [];
          for (const fn of fns) fn(payload || { target: this });
        },
      };
    }

    // 모의 Document 팩토리
    function createMockDocument() {
      const elementMap = new Map();
      const ids = [
        'connection-indicator', 'last-updated-text', 'btn-refresh', 'btn-settings',
        'slot1-email', 'slot1-plan', 'slot1-primary-percent', 'slot1-primary-bar',
        'slot1-primary-countdown', 'slot1-secondary-percent', 'slot1-secondary-bar',
        'slot1-secondary-countdown', 'slot2-unlinked-view', 'slot2-logging-view',
        'slot2-linked-view', 'btn-login-slot2', 'btn-cancel-login-slot2',
        'slot2-email', 'slot2-plan', 'slot2-primary-percent', 'slot2-primary-bar',
        'slot2-primary-countdown', 'slot2-secondary-percent', 'slot2-secondary-bar',
        'slot2-secondary-countdown', 'toast-banner', 'toast-message',
        'settings-modal', 'btn-close-settings', 'btn-cancel-settings', 'btn-save-settings',
        'setting-poll-interval', 'setting-alert-threshold', 'setting-alert-threshold-val',
        'setting-notify-threshold', 'setting-notify-reset', 'setting-start-on-boot',
      ];

      for (const id of ids) {
        elementMap.set(id, createMockElement(id));
      }

      return {
        getElementById(id) {
          return elementMap.get(id) || null;
        },
      };
    }

    let mockDoc;
    let mockApi;
    let renderer;

    beforeEach(() => {
      mockDoc = createMockDocument();
      mockApi = {
        getUsage: async () => createMockUsageData(),
        refreshUsage: async () => createMockUsageData(),
        getConfig: async () => createMockConfig(),
        saveConfig: async (patch) => ({ ...createMockConfig(), ...patch }),
        startLoginSlot2: async () => ({ success: true }),
        cancelLoginSlot2: async () => ({ cancelled: true }),
        onUsageUpdated: () => {},
      };
      renderer = new MonitorRenderer({ api: mockApi, document: mockDoc });
      renderer.init();
    });

    afterEach(() => {
      renderer.stopCountdownTicker();
    });

    it('초기화 시 DOM 요소를 정상 캐싱하고 헤더 및 슬롯 1 데이터를 렌더링해야 한다', async () => {
      const data = createMockUsageData();
      renderer.renderUsage(data);

      const el = renderer.el;
      assert.strictEqual(el.slot1Email.textContent, 'user1.openai@gmail.com');
      assert.strictEqual(el.slot1Plan.textContent, 'Plus');
      assert.strictEqual(el.slot1PrimaryPercent.textContent, '72%');
      assert.strictEqual(el.slot1PrimaryBar.style.width, '72%');
      assert.ok(el.slot1PrimaryBar.className.includes('progress-green'));
      assert.strictEqual(el.connectionIndicator.classList.contains('online'), true);
    });

    it('잔여량이 10% 이하일 때 진행 바에 progress-red 클래스를 적용해야 한다', () => {
      const data = createMockUsageData();
      data.slot1.primaryWindow.remainingPercent = 8;
      renderer.renderUsage(data);

      const el = renderer.el;
      assert.strictEqual(el.slot1PrimaryPercent.textContent, '8%');
      assert.ok(el.slot1PrimaryBar.className.includes('progress-red'));
    });

    it('계정 2가 미연동(linked: false)인 경우 unlinked 뷰가 표시되고 나머지는 hidden이어야 한다', () => {
      const data = createMockUsageData();
      data.slot2.linked = false;
      renderer.renderUsage(data);

      const el = renderer.el;
      assert.strictEqual(el.slot2UnlinkedView.classList.contains('hidden'), false);
      assert.strictEqual(el.slot2LoggingView.classList.contains('hidden'), true);
      assert.strictEqual(el.slot2LinkedView.classList.contains('hidden'), true);
    });

    it('계정 2가 연동 완료(linked: true)된 경우 linked 뷰가 표시되어야 한다', () => {
      const data = createMockUsageData();
      const nowSec = Math.floor(Date.now() / 1000);
      data.slot2 = {
        slotId: 'slot2',
        linked: true,
        email: 'second@openai.com',
        planType: 'pro',
        primaryWindow: {
          usedPercent: 20,
          remainingPercent: 80,
          resetAt: nowSec + 3600,
        },
        secondaryWindow: {
          usedPercent: 10,
          remainingPercent: 90,
          resetAt: nowSec + 86400,
        },
      };
      renderer.renderUsage(data);

      const el = renderer.el;
      assert.strictEqual(el.slot2UnlinkedView.classList.contains('hidden'), true);
      assert.strictEqual(el.slot2LoggingView.classList.contains('hidden'), true);
      assert.strictEqual(el.slot2LinkedView.classList.contains('hidden'), false);
      assert.strictEqual(el.slot2Email.textContent, 'second@openai.com');
      assert.strictEqual(el.slot2Plan.textContent, 'Pro');
    });

    it('새로고침 버튼 클릭 시 spinning 애니메이션이 동작하고 데이터를 갱신해야 한다', async () => {
      let refreshCalled = false;
      mockApi.refreshUsage = async () => {
        refreshCalled = true;
        return createMockUsageData();
      };

      await renderer.handleRefresh();
      assert.strictEqual(refreshCalled, true);
      assert.strictEqual(renderer.el.btnRefresh.classList.contains('spinning'), false);
    });

    it('설정 모달 열기 및 저장 시 saveConfig API에 올바른 파라미터를 전달해야 한다', async () => {
      let savedPatch = null;
      mockApi.saveConfig = async (patch) => {
        savedPatch = patch;
        return patch;
      };

      await renderer.openSettings();
      assert.strictEqual(renderer.el.settingsModal.classList.contains('hidden'), false);

      // 값 변경 시뮬레이션
      renderer.el.settingPollInterval.value = '10';
      renderer.el.settingAlertThreshold.value = '15';
      renderer.el.settingNotifyThreshold.checked = true;
      renderer.el.settingNotifyReset.checked = false;
      renderer.el.settingStartOnBoot.checked = true;

      await renderer.saveSettings();

      assert.deepStrictEqual(savedPatch, {
        pollIntervalMinutes: 10,
        alertThresholdPercent: 15,
        notifyOnThreshold: true,
        notifyOnReset: false,
        startOnBoot: true,
      });
      assert.strictEqual(renderer.el.settingsModal.classList.contains('hidden'), true);
    });

    it('tickCountdown 호출 시 resetAt 타임스탬프 기반으로 카운트다운 텍스트를 자동 재계산해야 한다', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const data = createMockUsageData();
      data.slot1.primaryWindow.resetAt = nowSec + 1200; // 20분 후
      renderer.renderUsage(data);

      renderer.tickCountdown();
      assert.strictEqual(renderer.el.slot1PrimaryCountdown.textContent, '20분 후 초기화');
    });
  });
});
