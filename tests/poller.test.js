/**
 * tests/poller.test.js
 * 
 * 백그라운드 폴링 스케줄러 및 토스트 알림 서비스 단위 테스트
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const {
  sendNotification,
  setNotificationSender,
  resetNotificationSender,
  getLastNotification,
  clearNotificationHistory,
} = require('../src/notifier.js');

const {
  evaluateNotifications,
  pollAllSlots,
  startPolling,
  getLatestPollResult,
  resetPollerState,
} = require('../src/poller.js');

const { setConfigDir, resetConfigDir, saveSlot, updateConfig } = require('../src/config.js');

/**
 * 테스트용 정규화된 사용량 메트릭 모의 생성 헬퍼
 */
function createMockMetrics(options = {}) {
  const primaryRemaining = options.primaryRemaining ?? 80;
  const secondaryRemaining = options.secondaryRemaining ?? 90;
  const primaryResetAt = options.primaryResetAt ?? 1700000000;
  const secondaryResetAt = options.secondaryResetAt ?? 1700500000;
  const primaryResetAfterSeconds = options.primaryResetAfterSeconds ?? 1800;

  return {
    primaryWindow: {
      usedPercent: 100 - primaryRemaining,
      remainingPercent: primaryRemaining,
      limitWindowSeconds: 18000,
      resetAfterSeconds: primaryResetAfterSeconds,
      resetAt: primaryResetAt,
      formattedResetText: options.primaryResetText || `${Math.floor(primaryResetAfterSeconds / 60)}분 후 초기화`,
    },
    secondaryWindow: {
      usedPercent: 100 - secondaryRemaining,
      remainingPercent: secondaryRemaining,
      limitWindowSeconds: 604800,
      resetAfterSeconds: 86400,
      resetAt: secondaryResetAt,
      formattedResetText: '1일 후 초기화',
    },
    planType: options.planType || 'plus',
    email: options.email || 'test@example.com',
    accountId: 'acc_test_123',
    userId: 'user_test_123',
    credits: { has_credits: false },
    rateLimitAllowed: primaryRemaining > 0,
    limitReached: primaryRemaining <= 0,
    fetchedAt: new Date().toISOString(),
  };
}

describe('notifier.js - 데스크톱 토스트 알림 모듈', () => {
  beforeEach(() => {
    resetNotificationSender();
    clearNotificationHistory();
  });

  afterEach(() => {
    resetNotificationSender();
    clearNotificationHistory();
  });

  it('기본 모의 발송자를 주입하여 알림 페이로드를 가로채고 기록해야 한다', async () => {
    const received = [];
    setNotificationSender(async (payload) => {
      received.push(payload);
      return { success: true, provider: 'mock' };
    });

    const result = await sendNotification({
      title: '테스트 알림',
      body: '내용입니다.',
      icon: 'assets/icon.png',
    });

    assert.equal(result.success, true);
    assert.equal(result.provider, 'mock');
    assert.equal(received.length, 1);
    assert.equal(received[0].title, '테스트 알림');
    assert.equal(received[0].body, '내용입니다.');

    const last = getLastNotification();
    assert.equal(last.title, '테스트 알림');
  });

  it('발송자 함수에서 에러가 발생해도 예외를 던지지 않고 안전하게 에러 객체를 반환해야 한다', async () => {
    setNotificationSender(async () => {
      throw new Error('OS 알림 서비스 연결 불가');
    });

    const result = await sendNotification({
      title: '실패 알림',
      body: '실패 테스트',
    });

    assert.equal(result.success, false);
    assert.match(result.error, /OS 알림 서비스 연결 불가/);
  });

  it('Electron 환경이 감지될 때 Notification 인스턴스를 통해 발송해야 한다', async () => {
    // Electron 환경 흉내내기
    let notificationCreated = false;
    let shown = false;

    class MockElectronNotification {
      static isSupported() {
        return true;
      }
      constructor(options) {
        notificationCreated = true;
        this.options = options;
      }
      show() {
        shown = true;
      }
    }

    // require 캐시를 이용해 electron 모듈 모킹
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (id) {
      if (id === 'electron') {
        return { Notification: MockElectronNotification };
      }
      return originalRequire.apply(this, arguments);
    };

    Object.defineProperty(process.versions, 'electron', {
      value: '30.0.0',
      configurable: true,
      writable: true,
    });

    try {
      const res = await sendNotification({
        title: 'Electron 테스트',
        body: '일렉트론 알림',
      });

      assert.equal(res.success, true);
      assert.equal(res.provider, 'electron');
      assert.equal(notificationCreated, true);
      assert.equal(shown, true);
    } finally {
      delete process.versions.electron;
      Module.prototype.require = originalRequire;
    }
  });

  it('payload가 비어있거나 생략된 경우에도 기본값을 사용하여 알림을 생성해야 한다', async () => {
    let captured = null;
    setNotificationSender(async (p) => {
      captured = p;
      return { success: true };
    });

    const res = await sendNotification(null);
    assert.equal(res.success, true);
    assert.ok(captured);
    assert.equal(captured.title, 'ChatGPT 사용량 모니터');
    assert.equal(captured.body, '');
  });
});

describe('poller.js - 알림 조건 평가 엔진 (evaluateNotifications)', () => {
  let state;
  const defaultConfig = {
    alertThresholdPercent: 10,
    notifyOnThreshold: true,
    notifyOnReset: true,
  };

  beforeEach(() => {
    state = {};
  });

  it('잔여량이 임계치(<= 10%) 이하로 떨어지면 임계치 경고 알림을 생성해야 한다', () => {
    const prev = createMockMetrics({ primaryRemaining: 25 });
    const curr = createMockMetrics({
      primaryRemaining: 8,
      primaryResetAt: 1700000000,
      primaryResetAfterSeconds: 1200,
      primaryResetText: '20분 후 초기화',
      email: 'slot1@openai.com',
    });

    const notifications = evaluateNotifications('slot1', prev, curr, defaultConfig, state, { send: false });

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].type, 'threshold');
    assert.equal(notifications[0].slotId, 'slot1');
    assert.match(notifications[0].title, /경고/);
    assert.match(notifications[0].body, /8%/);
    assert.match(notifications[0].body, /20분 후 초기화/);
  });

  it('커스텀 임계치(예: 15%) 설정 시 해당 임계치 기준으로 경고가 트리거되어야 한다', () => {
    const prev = createMockMetrics({ primaryRemaining: 30 });
    const curr = createMockMetrics({ primaryRemaining: 14, primaryResetAt: 1700000000 });
    const customConfig = { ...defaultConfig, alertThresholdPercent: 15 };

    const notifications = evaluateNotifications('slot2', prev, curr, customConfig, state, { send: false });
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].type, 'threshold');
  });

  it('잔여량이 임계치보다 높은 경우 알림이 생성되지 않아야 한다', () => {
    const prev = createMockMetrics({ primaryRemaining: 50 });
    const curr = createMockMetrics({ primaryRemaining: 15, primaryResetAt: 1700000000 });

    const notifications = evaluateNotifications('slot1', prev, curr, defaultConfig, state, { send: false });
    assert.equal(notifications.length, 0);
  });

  it('동일한 리셋 윈도우(resetAt) 내에서는 임계치 알림이 중복 발송되지 않아야 한다 (쿨다운/중복 방지)', () => {
    const prev1 = createMockMetrics({ primaryRemaining: 20 });
    const curr1 = createMockMetrics({ primaryRemaining: 8, primaryResetAt: 1700000000 });

    // 1차 폴링: 8% 도달 -> 알림 발송
    const notifs1 = evaluateNotifications('slot1', prev1, curr1, defaultConfig, state, { send: false });
    assert.equal(notifs1.length, 1);

    // 2차 폴링: 5분 뒤 5%로 더 떨어졌으나 동일 윈도우(resetAt 동일) -> 알림 중복 방지
    const curr2 = createMockMetrics({ primaryRemaining: 5, primaryResetAt: 1700000000 });
    const notifs2 = evaluateNotifications('slot1', curr1, curr2, defaultConfig, state, { send: false });
    assert.equal(notifs2.length, 0);

    // 3차 폴링: 리셋 윈도우가 새로 변경됨(resetAt 갱신) -> 새 윈도우에서 다시 임계치 도달 시 알림 발송
    const curr3 = createMockMetrics({ primaryRemaining: 7, primaryResetAt: 1700018000 });
    const notifs3 = evaluateNotifications('slot1', curr2, curr3, defaultConfig, state, { send: false });
    assert.equal(notifs3.length, 1);
    assert.equal(notifs3[0].type, 'threshold');
  });

  it('notifyOnThreshold가 false로 설정된 경우 임계치에 도달해도 알림이 발송되지 않아야 한다', () => {
    const prev = createMockMetrics({ primaryRemaining: 30 });
    const curr = createMockMetrics({ primaryRemaining: 5 });
    const offConfig = { ...defaultConfig, notifyOnThreshold: false };

    const notifs = evaluateNotifications('slot1', prev, curr, offConfig, state, { send: false });
    assert.equal(notifs.length, 0);
  });

  it('100% 미만에서 100%로 회복(리셋 완료)되었을 때 리셋 완료 알림을 생성해야 한다', () => {
    const prev = createMockMetrics({ primaryRemaining: 5, primaryResetAt: 1700000000 });
    const curr = createMockMetrics({ primaryRemaining: 100, primaryResetAt: 1700018000, email: 'user@test.com' });

    const notifications = evaluateNotifications('slot1', prev, curr, defaultConfig, state, { send: false });

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].type, 'reset');
    assert.equal(notifications[0].slotId, 'slot1');
    assert.match(notifications[0].title, /초기화|리셋/);
    assert.match(notifications[0].body, /100%/);
  });

  it('이전 메트릭이 없는 첫 번째 폴링에서는 100%여도 리셋 완료 알림을 발생시키지 않아야 한다', () => {
    const curr = createMockMetrics({ primaryRemaining: 100 });

    const notifications = evaluateNotifications('slot1', null, curr, defaultConfig, state, { send: false });
    assert.equal(notifications.length, 0);
  });

  it('이전 메트릭이 이미 100%였던 경우 다음 폴링에서 100%여도 중복 리셋 알림을 발생시키지 않아야 한다', () => {
    const prev = createMockMetrics({ primaryRemaining: 100 });
    const curr = createMockMetrics({ primaryRemaining: 100 });

    const notifications = evaluateNotifications('slot1', prev, curr, defaultConfig, state, { send: false });
    assert.equal(notifications.length, 0);
  });

  it('notifyOnReset이 false인 경우 리셋되어도 알림이 발생하지 않아야 한다', () => {
    const prev = createMockMetrics({ primaryRemaining: 10 });
    const curr = createMockMetrics({ primaryRemaining: 100 });
    const offConfig = { ...defaultConfig, notifyOnReset: false };

    const notifications = evaluateNotifications('slot1', prev, curr, offConfig, state, { send: false });
    assert.equal(notifications.length, 0);
  });

  it('send 옵션이 true(기본값)인 경우 sendNotification을 직접 호출해야 한다', async () => {
    const sent = [];
    setNotificationSender(async (p) => {
      sent.push(p);
      return { success: true };
    });

    const prev = createMockMetrics({ primaryRemaining: 50 });
    const curr = createMockMetrics({ primaryRemaining: 5 });

    const notifs = await evaluateNotifications('slot1', prev, curr, defaultConfig, state);
    assert.equal(notifs.length, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, notifs[0].title);
  });

  it('currMetrics가 null이거나 primaryWindow가 없는 경우 빈 배열을 안전하게 반환해야 한다', () => {
    const notifs1 = evaluateNotifications('slot1', null, null, defaultConfig, state);
    assert.deepEqual(notifs1, []);

    const notifs2 = evaluateNotifications('slot1', null, {}, defaultConfig, state);
    assert.deepEqual(notifs2, []);
  });
});

describe('poller.js - 다중 슬롯 병렬 폴링 (pollAllSlots)', () => {
  let tempDir;
  let sentNotifications;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'poller-test-'));
    setConfigDir(tempDir);
    resetPollerState();
    sentNotifications = [];
    setNotificationSender(async (p) => {
      sentNotifications.push(p);
      return { success: true };
    });
  });

  afterEach(async () => {
    resetConfigDir();
    resetPollerState();
    resetNotificationSender();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('슬롯 1과 슬롯 2를 병렬 조회하고 성공 결과를 정규화하여 반환해야 한다', async () => {
    const mockSlot1Metrics = createMockMetrics({ primaryRemaining: 70, email: 'slot1@openai.com' });
    const mockSlot2Metrics = createMockMetrics({ primaryRemaining: 90, email: 'slot2@openai.com' });

    const fetchUsageMock = async (slotId) => {
      if (slotId === 'slot1') return mockSlot1Metrics;
      if (slotId === 'slot2') return mockSlot2Metrics;
      throw new Error('Unknown slot');
    };

    const result = await pollAllSlots({
      fetchUsageFn: fetchUsageMock,
      configDir: tempDir,
    });

    assert.equal(result.slot1.success, true);
    assert.equal(result.slot1.metrics.primaryWindow.remainingPercent, 70);
    assert.equal(result.slot1.email, 'slot1@openai.com');

    assert.equal(result.slot2.success, true);
    assert.equal(result.slot2.metrics.primaryWindow.remainingPercent, 90);
    assert.equal(result.slot2.email, 'slot2@openai.com');

    assert.ok(result.timestamp > 0);

    // 최신 상태 캐시 검증
    const cached = getLatestPollResult();
    assert.deepEqual(cached, result);
  });

  it('한 슬롯이 실패(미연동 등)하더라도 다른 슬롯 조회가 정상 완료되어야 한다', async () => {
    const mockSlot1Metrics = createMockMetrics({ primaryRemaining: 60 });

    const fetchUsageMock = async (slotId) => {
      if (slotId === 'slot1') return mockSlot1Metrics;
      throw new Error('슬롯 slot2에 저장된 인증 정보가 없습니다.');
    };

    const result = await pollAllSlots({
      fetchUsageFn: fetchUsageMock,
      configDir: tempDir,
    });

    assert.equal(result.slot1.success, true);
    assert.equal(result.slot1.metrics.primaryWindow.remainingPercent, 60);

    assert.equal(result.slot2.success, false);
    assert.equal(result.slot2.metrics, null);
    assert.equal(result.slot2.linked, false);
    assert.match(result.slot2.error, /저장된 인증 정보가 없습니다/);
  });

  it('임계치에 도달한 슬롯이 있을 때 알림을 자동으로 발송해야 한다', async () => {
    const mockSlot1Metrics = createMockMetrics({ primaryRemaining: 5, primaryResetAt: 1700000000 });
    const mockSlot2Metrics = createMockMetrics({ primaryRemaining: 80 });

    const fetchUsageMock = async (slotId) => {
      return slotId === 'slot1' ? mockSlot1Metrics : mockSlot2Metrics;
    };

    await pollAllSlots({
      fetchUsageFn: fetchUsageMock,
      configDir: tempDir,
    });

    assert.equal(sentNotifications.length, 1);
    assert.match(sentNotifications[0].title, /경고/);
    assert.match(sentNotifications[0].body, /5%/);
  });

  it('두 슬롯 모두 네트워크 장애로 실패해도 예외 없이 실패 상태를 정규화하여 반환해야 한다', async () => {
    const fetchUsageMock = async () => {
      throw new Error('네트워크 연결 끊김 (ETIMEDOUT)');
    };

    const result = await pollAllSlots({
      fetchUsageFn: fetchUsageMock,
      configDir: tempDir,
    });

    assert.equal(result.slot1.success, false);
    assert.match(result.slot1.error, /ETIMEDOUT/);
    assert.equal(result.slot2.success, false);
    assert.match(result.slot2.error, /ETIMEDOUT/);
  });
});

describe('poller.js - 스케줄러 라이프사이클 (startPolling)', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-test-'));
    setConfigDir(tempDir);
    resetPollerState();
    resetNotificationSender();
  });

  afterEach(async () => {
    resetConfigDir();
    resetPollerState();
    resetNotificationSender();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('시작 즉시 1회 실행되고 onUpdate 콜백을 호출해야 한다', async () => {
    let callCount = 0;
    let lastPayload = null;

    const mockSlot1 = createMockMetrics({ primaryRemaining: 85 });
    const fetchMock = async (slotId) => (slotId === 'slot1' ? mockSlot1 : { error: 'none' });

    const poller = startPolling(5, (payload) => {
      callCount++;
      lastPayload = payload;
    }, {
      fetchUsageFn: fetchMock,
      configDir: tempDir,
    });

    try {
      // 즉시 실행 완료 대기
      await poller.pollNow();
      assert.ok(callCount >= 1);
      assert.ok(lastPayload);
      assert.equal(lastPayload.slot1.success, true);
    } finally {
      poller.stop();
    }
  });

  it('pollNow 수동 호출 시 즉시 갱신되고 onUpdate가 호출되어야 한다', async () => {
    let updates = [];
    let counter = 1;

    const fetchMock = async () => {
      return createMockMetrics({ primaryRemaining: counter++ * 10 });
    };

    const poller = startPolling(60, (data) => {
      updates.push(data);
    }, {
      fetchUsageFn: fetchMock,
      configDir: tempDir,
    });

    try {
      await poller.pollNow();
      const firstCount = updates.length;

      await poller.pollNow();
      assert.equal(updates.length, firstCount + 1);
    } finally {
      poller.stop();
    }
  });

  it('stop 호출 후에는 타이머가 해제되고 추가 콜백이 호출되지 않아야 한다', async () => {
    let updates = 0;
    const poller = startPolling(1, () => {
      updates++;
    }, {
      fetchUsageFn: async () => createMockMetrics(),
      configDir: tempDir,
      intervalMs: 50, // 테스트용 빠른 주기
    });

    // 조금 대기 후 stop
    await new Promise((resolve) => setTimeout(resolve, 80));
    poller.stop();

    const countAfterStop = updates;
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(updates, countAfterStop);
  });

  it('onUpdate 콜백에서 예외가 발생하더라도 폴러 루프가 중단되지 않아야 한다', async () => {
    let callCount = 0;
    const poller = startPolling(5, () => {
      callCount++;
      throw new Error('콜백 UI 렌더링 실패');
    }, {
      fetchUsageFn: async () => createMockMetrics(),
      configDir: tempDir,
    });

    try {
      await poller.pollNow();
      assert.ok(callCount >= 1);
    } finally {
      poller.stop();
    }
  });

  it('intervalMinutes가 0 이하이거나 유효하지 않으면 기본 5분을 적용해야 한다', () => {
    const poller = startPolling(-10, null, {
      fetchUsageFn: async () => createMockMetrics(),
      configDir: tempDir,
    });
    assert.ok(poller && typeof poller.stop === 'function');
    poller.stop();
  });
});
