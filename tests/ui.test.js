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
  getNextTheme,
  generateSlotsHtml,
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

  describe('getNextTheme - 다크/라이트 테마 전환', () => {
    it('toggleTheme switches between dark and light themes', () => {
      const current = 'dark';
      const next = getNextTheme(current);
      assert.strictEqual(next, 'light');
    });

    it('light 테마에서는 dark로 전환되어야 한다', () => {
      assert.strictEqual(getNextTheme('light'), 'dark');
      assert.strictEqual(getNextTheme(null), 'light');
    });
  });

  describe('generateSlotsHtml - 임의 개수의 동적 슬롯 HTML 마크업 생성', () => {
    it('renderSlots generates cards for arbitrary number of slots', () => {
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

    it('3개 이상의 슬롯에서 번호가 2를 초과하는 미연동 카드에만 "카드 삭제" 버튼이 포함되어야 한다', () => {
      const slotsData = {
        slot1: { linked: false },
        slot2: { linked: false },
        slot3: { linked: false },
        slot4: { linked: false }
      };
      const html = generateSlotsHtml(slotsData);
      // slot3, slot4는 미연동이고 번호 > 2이므로 삭제 버튼 표시
      assert.ok(html.includes('btn-delete-slot" data-slot="slot3"'));
      assert.ok(html.includes('btn-delete-slot" data-slot="slot4"'));
      // 기본 슬롯(slot1, slot2)은 미연동이라도 삭제 버튼이 표시되지 않아야 함
      assert.ok(!html.includes('btn-delete-slot" data-slot="slot1"'));
      assert.ok(!html.includes('btn-delete-slot" data-slot="slot2"'));
    });

    it('총 슬롯이 2개 이하인 경우 어떤 슬롯에도 "카드 삭제" 버튼이 포함되지 않아야 한다', () => {
      const slotsData = {
        slot1: { linked: false },
        slot2: { linked: false }
      };
      const html = generateSlotsHtml(slotsData);
      assert.ok(!html.includes('카드 삭제'));
      assert.ok(!html.includes('btn-delete-slot'));
    });
  });

  describe('HTML 마크업 구조 무결성 검증 (src/ui/index.html)', () => {
    const htmlPath = path.resolve(__dirname, '../src/ui/index.html');
    let htmlContent = '';

    beforeEach(() => {
      htmlContent = fs.readFileSync(htmlPath, 'utf-8');
    });

    it('HTML 파일이 존재하고 한국어 lang 속성과 적절한 메타 태그를 포함해야 한다', () => {
      assert.ok(htmlContent.includes('<html lang="ko"'));
      assert.ok(htmlContent.includes('ChatGPT 사용량 모니터'));
      assert.ok(htmlContent.includes('style.css'));
      assert.ok(htmlContent.includes('renderer.js'));
    });

    it('헤더 영역 필수 요소(타이틀, 상태 표시, 핀, 테마, 새로고침, 설정, 닫기 버튼)가 존재해야 한다', () => {
      assert.ok(htmlContent.includes('id="connection-indicator"'));
      assert.ok(htmlContent.includes('id="last-updated-text"'));
      assert.ok(htmlContent.includes('id="pinBtn"'));
      assert.ok(htmlContent.includes('id="themeBtn"'));
      assert.ok(htmlContent.includes('id="refreshBtn"'));
      assert.ok(htmlContent.includes('id="settingsBtn"'));
      assert.ok(htmlContent.includes('id="closeBtn"'));
    });

    it('동적 카드 컨테이너(#cardsContainer) 및 계정 추가 버튼(#addSlotBtn)이 존재해야 한다', () => {
      assert.ok(htmlContent.includes('id="cardsContainer"'));
      assert.ok(htmlContent.includes('id="addSlotBtn"'));
      assert.ok(htmlContent.includes('+ 새 계정 추가'));
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

    it('다크 및 라이트 테마 색상 변수와 컴포넌트 스타일이 정의되어 있어야 한다', () => {
      assert.ok(cssContent.includes('--bg-app'));
      assert.ok(cssContent.includes('--bg-card'));
      assert.ok(cssContent.includes('--color-brand'));
      assert.ok(cssContent.includes('[data-theme="light"]'));
      assert.ok(cssContent.includes('.progress-green'));
      assert.ok(cssContent.includes('.progress-yellow'));
      assert.ok(cssContent.includes('.progress-red'));
    });

    it('헤더 드래그 영역(-webkit-app-region: drag) 및 버튼 no-drag가 정의되어 있어야 한다', () => {
      assert.ok(cssContent.includes('-webkit-app-region: drag'));
      assert.ok(cssContent.includes('-webkit-app-region: no-drag'));
    });

    it('핀 버튼 활성화 스타일 및 동적 카드 스크롤바가 정의되어 있어야 한다', () => {
      assert.ok(cssContent.includes('#pinBtn.active') || cssContent.includes('.btn-icon.active'));
      assert.ok(cssContent.includes('.cards-container'));
      assert.ok(cssContent.includes('max-height: calc(100vh - 120px)'));
      assert.ok(cssContent.includes('.cards-container::-webkit-scrollbar'));
    });

    it('카드 액션 버튼([로그아웃], [카드 삭제]) 및 새 계정 추가 버튼 스타일이 정의되어 있어야 한다', () => {
      assert.ok(cssContent.includes('.btn-card-action'));
      assert.ok(cssContent.includes('.btn-logout'));
      assert.ok(cssContent.includes('.btn-delete-slot'));
      assert.ok(cssContent.includes('.btn-add-slot'));
    });
  });

  describe('MonitorRenderer - 가상 DOM 기반 상태 바인딩 및 이벤트 동작 검증', () => {
    // 경량 모의 DOM 요소 팩토리
    function createMockElement(id) {
      return {
        id,
        textContent: '',
        innerHTML: '',
        value: '',
        checked: false,
        title: '',
        style: {},
        attributes: {},
        dataset: {},
        setAttribute(k, v) { this.attributes[k] = String(v); },
        getAttribute(k) { return this.attributes[k]; },
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
        'pinBtn', 'themeBtn', 'refreshBtn', 'settingsBtn', 'closeBtn',
        'cardsContainer', 'addSlotBtn',
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
        documentElement: {
          dataset: { theme: 'dark' },
        },
        body: {
          setAttribute(k, v) {},
          classList: createMockElement('body').classList,
        },
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
        setTheme: async ({ theme }) => ({ theme }),
        setPinMode: async ({ isPinned }) => ({ isPinned }),
        getPinMode: async () => ({ isPinned: false }),
        closeWindow: async () => ({ closed: true }),
        logoutSlot: async (slotId) => ({ success: true }),
        addSlot: async () => ({ slotId: 'slot3', slots: ['slot1', 'slot2', 'slot3'] }),
        removeSlot: async (slotId) => ({ success: true, slots: ['slot1', 'slot2'] }),
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

    it('togglePinMode 호출 시 핀 상태가 토글되고 setPinMode API가 호출되어야 한다', async () => {
      let pinPayload = null;
      mockApi.setPinMode = async (payload) => {
        pinPayload = payload;
        return payload;
      };

      // 1회 클릭: 핀 활성화
      await renderer.togglePinMode();
      assert.strictEqual(renderer.isPinned, true);
      assert.deepStrictEqual(pinPayload, { isPinned: true });
      assert.strictEqual(renderer.el.pinBtn.classList.contains('active'), true);

      // 2회 클릭: 핀 해제
      await renderer.togglePinMode();
      assert.strictEqual(renderer.isPinned, false);
      assert.deepStrictEqual(pinPayload, { isPinned: false });
      assert.strictEqual(renderer.el.pinBtn.classList.contains('active'), false);
    });

    it('toggleTheme 호출 시 테마가 전환되고 document dataset 및 setTheme API가 호출되어야 한다', async () => {
      let themePayload = null;
      mockApi.setTheme = async (payload) => {
        themePayload = payload;
        return payload;
      };

      // 초기 'dark'에서 light로 전환
      await renderer.toggleTheme();
      assert.strictEqual(renderer.currentTheme, 'light');
      assert.strictEqual(mockDoc.documentElement.dataset.theme, 'light');
      assert.deepStrictEqual(themePayload, { theme: 'light' });

      // light에서 dark로 다시 전환
      await renderer.toggleTheme();
      assert.strictEqual(renderer.currentTheme, 'dark');
      assert.strictEqual(mockDoc.documentElement.dataset.theme, 'dark');
      assert.deepStrictEqual(themePayload, { theme: 'dark' });
    });

    it('closeWindow 호출 시 closeWindow API를 호출해야 한다', async () => {
      let closed = false;
      mockApi.closeWindow = async () => {
        closed = true;
      };

      await renderer.closeWindow();
      assert.strictEqual(closed, true);
    });

    it('handleLogout 호출 시 logoutSlot API를 호출하고 데이터를 갱신해야 한다', async () => {
      let loggedOutSlot = null;
      let refreshCount = 0;

      mockApi.logoutSlot = async (slotId) => {
        loggedOutSlot = slotId;
        return { success: true };
      };
      mockApi.refreshUsage = async () => {
        refreshCount++;
        return createMockUsageData();
      };

      await renderer.handleLogout('slot1');
      assert.strictEqual(loggedOutSlot, 'slot1');
      assert.strictEqual(refreshCount, 1);
    });

    it('handleAddSlot 호출 시 addSlot API를 호출하고 데이터를 갱신해야 한다', async () => {
      let addSlotCalled = false;
      let refreshCount = 0;

      mockApi.addSlot = async () => {
        addSlotCalled = true;
        return { slotId: 'slot3', slots: ['slot1', 'slot2', 'slot3'] };
      };
      mockApi.refreshUsage = async () => {
        refreshCount++;
        return createMockUsageData();
      };

      await renderer.handleAddSlot();
      assert.strictEqual(addSlotCalled, true);
      assert.strictEqual(refreshCount, 1);
    });

    it('handleDeleteSlot 호출 시 removeSlot API를 호출하고 데이터를 갱신해야 한다', async () => {
      let removedSlot = null;
      let refreshCount = 0;

      mockApi.removeSlot = async (slotId) => {
        removedSlot = slotId;
        return { success: true, slots: ['slot1', 'slot2'] };
      };
      mockApi.refreshUsage = async () => {
        refreshCount++;
        return createMockUsageData();
      };

      await renderer.handleDeleteSlot('slot3');
      assert.strictEqual(removedSlot, 'slot3');
      assert.strictEqual(refreshCount, 1);
    });

    it('renderUsage 호출 시 cardsContainer.innerHTML에 동적 카드 목록이 렌더링되어야 한다', () => {
      const data = {
        slot1: { slotId: 'slot1', linked: true, email: 'user1@test.com' },
        slot2: { slotId: 'slot2', linked: false },
        slot3: { slotId: 'slot3', linked: true, email: 'user3@test.com' },
      };

      renderer.renderUsage(data);
      const innerHtml = renderer.el.cardsContainer.innerHTML;
      assert.ok(innerHtml.includes('slot1-card'));
      assert.ok(innerHtml.includes('slot2-card'));
      assert.ok(innerHtml.includes('slot3-card'));
      assert.ok(innerHtml.includes('user1@test.com'));
      assert.ok(innerHtml.includes('user3@test.com'));
      assert.ok(innerHtml.includes('로그아웃'));
    });
  });
});
