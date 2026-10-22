/**
 * src/poller.js
 * 
 * OpenAI 듀얼 슬롯 사용량 주기적 폴링 스케줄러 및 알림 평가 엔진
 * 
 * 주요 기능:
 * 1. 슬롯 1 및 슬롯 2의 사용량을 병렬로 조회 (pollAllSlots)
 * 2. 조회 결과 성공/실패/미연동 상태 정규화
 * 3. 5시간 한도 잔여량 임계치(<= 10%) 도달 시 토스트 알림 (동일 리셋 윈도우 내 중복 방지)
 * 4. 5시간 한도 100% 리셋 회복 시 토스트 알림
 * 5. 주기적 스케줄링 및 즉시 수동 갱신 제어 (startPolling)
 */

const { fetchUsage } = require('./api.js');
const { getConfig, getSlots, normalizeSlotId } = require('./config.js');
const { sendNotification } = require('./notifier.js');

/**
 * 전역 폴러 내부 상태 (각 슬롯의 직전 지표 및 알림 발송 윈도우 추적)
 */
let pollerState = {
  slot1: { prevMetrics: null, lastAlertedResetAt: null },
  slot2: { prevMetrics: null, lastAlertedResetAt: null },
};

/**
 * 발송된 알림 리셋 윈도우 추적 Set (동일 리셋 윈도우 내 중복 방지 및 메모리 누수 방지)
 * 포맷: `${slotId}:${windowType}:${resetAt}` (예: 'slot1:primary:1700000000')
 */
const notifiedWindows = new Set();

/**
 * 가장 최근에 성공/정규화된 전체 폴링 결과 캐시
 */
let latestPollResult = null;

/**
 * 폴러 내부 상태 및 알림 발송 기록을 초기화합니다 (단위 테스트 및 계정 전환용).
 */
function resetPollerState() {
  pollerState = {
    slot1: { prevMetrics: null, lastAlertedResetAt: null },
    slot2: { prevMetrics: null, lastAlertedResetAt: null },
  };
  notifiedWindows.clear();
  latestPollResult = null;
}

/**
 * 지정된 슬롯과 리셋 윈도우에 대해 알림 발송 완료 상태를 기록합니다.
 * @param {string|number} slotId 슬롯 식별자 (예: 'slot1', 'slot2', 'slot3')
 * @param {string} windowType 윈도우 유형 ('primary' | 'secondary')
 * @param {string|number} resetAt 리셋 시각
 */
function recordWindowNotified(slotId, windowType, resetAt) {
  let normalized = slotId;
  try {
    normalized = normalizeSlotId(slotId);
  } catch {
    normalized = String(slotId);
  }
  notifiedWindows.add(`${normalized}:${windowType}:${resetAt}`);
}

/**
 * 지정된 슬롯과 리셋 윈도우에 대해 이미 알림이 발송되었는지 여부를 확인합니다.
 * @param {string|number} slotId 슬롯 식별자 (예: 'slot1', 'slot2', 'slot3')
 * @param {string} windowType 윈도우 유형 ('primary' | 'secondary')
 * @param {string|number} resetAt 리셋 시각
 * @returns {boolean}
 */
function hasNotifiedWindow(slotId, windowType, resetAt) {
  let normalized = slotId;
  try {
    normalized = normalizeSlotId(slotId);
  } catch {
    normalized = String(slotId);
  }
  return notifiedWindows.has(`${normalized}:${windowType}:${resetAt}`);
}

/**
 * 특정 슬롯의 폴러 상태 및 알림 윈도우 기록을 정리합니다.
 * 슬롯 삭제 또는 로그아웃 시 호출되어 메모리 누수를 방지합니다.
 * @param {string|number} slotId 슬롯 식별자
 * @param {object} [state] 정리 대상 상태 객체 (미지정 시 전역 pollerState)
 */
function cleanupSlot(slotId, state = pollerState) {
  let normalized = slotId;
  try {
    normalized = normalizeSlotId(slotId);
  } catch {
    normalized = String(slotId);
  }

  // 1. notifiedWindows에서 해당 슬롯으로 시작하는 모든 키 제거
  const prefix = `${normalized}:`;
  for (const key of notifiedWindows) {
    if (key.startsWith(prefix)) {
      notifiedWindows.delete(key);
    }
  }

  // 2. 전달된 state 및 전역 pollerState에서 해당 슬롯 상태 제거
  if (state && state[normalized]) {
    delete state[normalized];
  }
  if (pollerState && pollerState[normalized]) {
    delete pollerState[normalized];
  }

  // 3. 최신 폴링 캐시 결과에서도 해당 슬롯 데이터 제거
  if (latestPollResult && latestPollResult[normalized]) {
    delete latestPollResult[normalized];
  }
}

/**
 * 현재 활성 슬롯 목록에 포함되지 않는 모든 제거된 슬롯들의 상태를 일괄 정리합니다.
 * @param {string[]} [activeSlots] 현재 활성화된 슬롯 식별자 목록
 * @param {object} [state] 정리 대상 상태 객체
 */
function cleanupRemovedSlots(activeSlots = ['slot1', 'slot2'], state = pollerState) {
  if (!Array.isArray(activeSlots)) {
    activeSlots = ['slot1', 'slot2'];
  }
  const activeSet = new Set(activeSlots.map((s) => {
    try {
      return normalizeSlotId(s);
    } catch {
      return String(s);
    }
  }));

  const targetState = state || pollerState;
  for (const slotId of Object.keys(targetState)) {
    if (!activeSet.has(slotId)) {
      cleanupSlot(slotId, targetState);
    }
  }

  for (const key of notifiedWindows) {
    const parts = key.split(':');
    const slotId = parts[0];
    if (!activeSet.has(slotId)) {
      notifiedWindows.delete(key);
    }
  }
}

/**
 * 메모리에 캐시된 가장 최근 폴링 결과를 반환합니다.
 * @returns {object|null}
 */
function getLatestPollResult() {
  return latestPollResult;
}

/**
 * 주어진 슬롯의 사용량 메트릭을 평가하여 발송할 알림 목록을 도출하고 발송합니다.
 * 
 * 알림 평가 조건:
 * 1. 임계치 조건:
 *    - currMetrics.primaryWindow.remainingPercent <= (config.alertThresholdPercent ?? 10)
 *    - 동일 리셋 윈도우(resetAt) 내에서는 1회만 발송 (쿨다운/중복 방지)
 * 2. 리셋 완료 조건:
 *    - prevMetrics가 존재하고, 이전 잔여량 < 100% 였으나 현재 잔여량 === 100%로 회복된 경우
 * 
 * @param {string|number} slotId 슬롯 식별자 ('slot1' 또는 'slot2')
 * @param {object|null} prevMetrics 직전 사용량 메트릭
 * @param {object} currMetrics 현재 사용량 메트릭
 * @param {object} [config] 애플리케이션 설정
 * @param {object} [state] 상태 추적 객체 (미지정 시 내부 pollerState 사용)
 * @param {object} [options]
 * @param {boolean} [options.send=true] 알림 직접 발송 여부
 * @param {Function} [options.notifyFn] 커스텀 알림 발송 함수
 * @returns {Promise<Array<object>>|Array<object>} 생성된 알림 목록
 */
function evaluateNotifications(slotId, prevMetrics, currMetrics, config = {}, state = pollerState, options = {}) {
  const normalizedId = normalizeSlotId(slotId);
  const notifications = [];

  if (!currMetrics || !currMetrics.primaryWindow) {
    return notifications;
  }

  // 상태 슬롯 슬라이스 추출
  if (!state[normalizedId]) {
    state[normalizedId] = { prevMetrics: null, lastAlertedResetAt: null };
  }
  const slotState = state[normalizedId];

  const match = normalizedId.match(/^slot(\d+)$/i);
  const slotNum = match ? match[1] : normalizedId;
  const slotLabel = `계정 ${slotNum}`;
  const emailSuffix = currMetrics.email ? ` (${currMetrics.email})` : '';

  const thresholdPercent = config.alertThresholdPercent ?? 10;
  const notifyOnThreshold = config.notifyOnThreshold !== false;
  const notifyOnReset = config.notifyOnReset !== false;

  const currPrimary = currMetrics.primaryWindow;
  const currRemaining = typeof currPrimary.remainingPercent === 'number' ? currPrimary.remainingPercent : null;
  const currentResetAt = currPrimary.resetAt ?? 'no-reset-at';

  // 1. 임계치 경고 알림 평가
  if (notifyOnThreshold && currRemaining !== null && currRemaining <= thresholdPercent) {
    const alreadyAlertedForThisWindow = (slotState.lastAlertedResetAt === currentResetAt) ||
      (state === pollerState && hasNotifiedWindow(normalizedId, 'primary', currentResetAt));

    if (!alreadyAlertedForThisWindow) {
      const resetText = currPrimary.formattedResetText ? ` (${currPrimary.formattedResetText})` : '';
      notifications.push({
        type: 'threshold',
        slotId: normalizedId,
        title: `[ChatGPT 사용량 경고] ${slotLabel}${emailSuffix}`,
        body: `5시간 한도 잔여량이 ${currRemaining}% 남았습니다.${resetText}`,
        icon: options.icon,
      });

      // 동일 윈도우 중복 발송 방지를 위해 기록
      slotState.lastAlertedResetAt = currentResetAt;
      if (state === pollerState) {
        recordWindowNotified(normalizedId, 'primary', currentResetAt);
      }
    }
  }

  // 2. 100% 한도 리셋 완료 알림 평가
  if (notifyOnReset && prevMetrics && prevMetrics.primaryWindow) {
    const prevRemaining = typeof prevMetrics.primaryWindow.remainingPercent === 'number'
      ? prevMetrics.primaryWindow.remainingPercent
      : null;

    if (prevRemaining !== null && prevRemaining < 100 && currRemaining === 100) {
      notifications.push({
        type: 'reset',
        slotId: normalizedId,
        title: `[ChatGPT 사용량 리셋] ${slotLabel}${emailSuffix}`,
        body: '5시간 한도가 100%로 초기화되었습니다.',
        icon: options.icon,
      });

      // 리셋 완료 시 차기 윈도우 임계치 경고를 위해 알림 기록 초기화
      slotState.lastAlertedResetAt = null;
    }
  }

  // 알림 발송 옵션이 켜져 있는 경우 실제 발송
  const shouldSend = options.send !== false && !options.dryRun;
  if (shouldSend && notifications.length > 0) {
    const sendFn = options.notifyFn || sendNotification;
    for (const notif of notifications) {
      try {
        const sendPromise = sendFn(notif);
        if (sendPromise && typeof sendPromise.catch === 'function') {
          sendPromise.catch(() => {});
        }
      } catch {
        // 알림 발송 실패가 메인 루프를 방해하지 않도록 처리
      }
    }
  }

  return notifications;
}

/**
 * Settled Promise 결과를 표준 슬롯 상태 객체로 정규화합니다.
 * @param {string} slotId 
 * @param {PromiseSettledResult<object>} settledResult 
 * @returns {object}
 */
function normalizeSlotResult(slotId, settledResult) {
  const now = new Date().toISOString();

  if (settledResult.status === 'fulfilled') {
    const metrics = settledResult.value;
    return {
      slotId,
      success: true,
      linked: true,
      metrics,
      data: metrics,
      ...metrics,
      error: null,
      updatedAt: now,
    };
  }

  const err = settledResult.reason;
  const errMsg = err?.message || String(err || '알 수 없는 오류');
  const isUnlinked = errMsg.includes('연동되지 않았습니다') ||
                     errMsg.includes('인증 정보를 찾을 수 없습니다') ||
                     errMsg.includes('저장된 인증 정보가 없습니다') ||
                     errMsg.includes('인증 정보가 없습니다');

  return {
    slotId,
    success: false,
    linked: !isUnlinked,
    metrics: null,
    data: null,
    error: errMsg,
    updatedAt: now,
  };
}

/**
 * 등록된 모든 활성 슬롯의 사용량을 병렬로 조회하고 결과를 정규화 및 알림 평가합니다.
 * 
 * @param {object} [options]
 * @param {Function} [options.fetchUsageFn]
 * @param {Function} [options.getConfigFn]
 * @param {Function} [options.getSlotsFn]
 * @param {Function} [options.notifyFn]
 * @param {string} [options.configDir]
 * @param {object} [options.state]
 * @returns {Promise<Record<string, object> & { timestamp: number }>}
 */
async function pollAllSlots(options = {}) {
  const fetchFn = options.fetchUsageFn || fetchUsage;
  const getConfigFn = options.getConfigFn || getConfig;
  const getSlotsFn = options.getSlotsFn || getSlots;
  const state = options.state || pollerState;

  // 1. 현재 설정 로드
  let config = {};
  try {
    config = await getConfigFn({ configDir: options.configDir });
  } catch {
    config = {};
  }

  // 2. 활성화된 슬롯 목록 조회 (getSlotsFn 우선, config.slots 폴백, 기본 ['slot1', 'slot2'])
  let activeSlots = ['slot1', 'slot2'];
  try {
    const slots = await getSlotsFn({ configDir: options.configDir });
    if (Array.isArray(slots) && slots.length > 0) {
      activeSlots = slots;
    } else if (Array.isArray(config.slots) && config.slots.length > 0) {
      activeSlots = config.slots;
    }
  } catch {
    if (Array.isArray(config.slots) && config.slots.length > 0) {
      activeSlots = config.slots;
    }
  }

  // 제거된 슬롯 상태 정리 (메모리 누수 방지)
  cleanupRemovedSlots(activeSlots, state);

  // 3. 모든 활성 슬롯 병렬 사용량 조회
  const settledResults = await Promise.allSettled(
    activeSlots.map((slotId) => fetchFn(slotId, options))
  );

  const result = {
    timestamp: Date.now(),
  };

  // 4. 슬롯별 결과 정규화 및 알림 평가
  for (let i = 0; i < activeSlots.length; i++) {
    const slotId = activeSlots[i];
    const settled = settledResults[i];
    const slotData = normalizeSlotResult(slotId, settled);

    if (slotData.success && slotData.metrics) {
      if (!state[slotId]) {
        state[slotId] = { prevMetrics: null, lastAlertedResetAt: null };
      }
      const prev = state[slotId].prevMetrics;
      evaluateNotifications(slotId, prev, slotData.metrics, config, state, options);
      state[slotId].prevMetrics = slotData.metrics;
    }

    result[slotId] = slotData;
  }

  // 5. 최신 결과 메모리 캐싱
  latestPollResult = result;

  return result;
}

/**
 * 백그라운드 사용량 주기적 폴링을 시작합니다.
 * 
 * - 시작 즉시 1회 pollAllSlots 실행
 * - setInterval을 통해 지정된 분(minutes) 단위로 주기적 갱신
 * - 갱신 완료 시 onUpdate({ slot1, slot2, timestamp }) 콜백 호출
 * 
 * @param {number} [intervalMinutes=5] 폴링 주기 (분)
 * @param {Function} [onUpdate] 갱신 이벤트 콜백
 * @param {object} [options]
 * @param {number} [options.intervalMs] 밀리초 단위 주기 직접 지정 (테스트용)
 * @returns {{ stop: () => void, pollNow: () => Promise<object> }}
 */
function startPolling(intervalMinutes = 5, onUpdate, options = {}) {
  let isStopped = false;
  let currentPollPromise = null;

  const validMinutes = (typeof intervalMinutes === 'number' && intervalMinutes > 0)
    ? intervalMinutes
    : 5;

  const intervalMs = options.intervalMs || (validMinutes * 60 * 1000);

  /**
   * 단일 폴링 실행기 (동시 중복 실행 방지 및 진행 중인 폴링 대기)
   */
  async function runPoll() {
    if (isStopped) {
      return latestPollResult;
    }

    // 이미 진행 중인 폴링이 있으면 해당 Promise 대기
    if (currentPollPromise) {
      return await currentPollPromise;
    }

    currentPollPromise = (async () => {
      try {
        const result = await pollAllSlots(options);

        if (!isStopped && typeof onUpdate === 'function') {
          try {
            onUpdate(result);
          } catch (cbErr) {
            console.error('[poller] onUpdate 콜백 실행 실패:', cbErr);
          }
        }

        return result;
      } finally {
        currentPollPromise = null;
      }
    })();

    return await currentPollPromise;
  }

  // 1. 즉시 1회 실행
  const initialPromise = runPoll();

  // 2. 주기적 타이머 등록
  const timerId = setInterval(() => {
    runPoll().catch(() => {});
  }, intervalMs);
  if (typeof timerId.unref === 'function') {
    timerId.unref();
  }

  return {
    stop: () => {
      isStopped = true;
      clearInterval(timerId);
    },
    pollNow: async () => {
      return await runPoll();
    },
    initialPromise,
  };
}

module.exports = {
  evaluateNotifications,
  normalizeSlotResult,
  pollAllSlots,
  startPolling,
  getLatestPollResult,
  resetPollerState,
  cleanupSlot,
  cleanupRemovedSlots,
  recordWindowNotified,
  hasNotifiedWindow,
};
