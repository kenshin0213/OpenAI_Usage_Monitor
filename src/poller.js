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
const { getConfig, normalizeSlotId } = require('./config.js');
const { sendNotification } = require('./notifier.js');

/**
 * 전역 폴러 내부 상태 (각 슬롯의 직전 지표 및 알림 발송 윈도우 추적)
 */
let pollerState = {
  slot1: { prevMetrics: null, lastAlertedResetAt: null },
  slot2: { prevMetrics: null, lastAlertedResetAt: null },
};

/**
 * 가장 최근에 성공/정규화된 전체 폴링 결과 캐시
 */
let latestPollResult = null;

/**
 * 폴러 내부 상태를 초기화합니다 (단위 테스트 및 계정 전환용).
 */
function resetPollerState() {
  pollerState = {
    slot1: { prevMetrics: null, lastAlertedResetAt: null },
    slot2: { prevMetrics: null, lastAlertedResetAt: null },
  };
  latestPollResult = null;
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

  const slotLabel = normalizedId === 'slot2' ? '계정 2' : '계정 1';
  const emailSuffix = currMetrics.email ? ` (${currMetrics.email})` : '';

  const thresholdPercent = config.alertThresholdPercent ?? 10;
  const notifyOnThreshold = config.notifyOnThreshold !== false;
  const notifyOnReset = config.notifyOnReset !== false;

  const currPrimary = currMetrics.primaryWindow;
  const currRemaining = typeof currPrimary.remainingPercent === 'number' ? currPrimary.remainingPercent : null;
  const currentResetAt = currPrimary.resetAt ?? 'no-reset-at';

  // 1. 임계치 경고 알림 평가
  if (notifyOnThreshold && currRemaining !== null && currRemaining <= thresholdPercent) {
    const alreadyAlertedForThisWindow = (slotState.lastAlertedResetAt === currentResetAt);

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
 * @param {'slot1' | 'slot2'} slotId 
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
 * 등록된 슬롯 1, 슬롯 2의 사용량을 병렬로 조회하고 결과를 정규화 및 알림 평가합니다.
 * 
 * @param {object} [options]
 * @param {Function} [options.fetchUsageFn]
 * @param {Function} [options.getConfigFn]
 * @param {Function} [options.notifyFn]
 * @param {string} [options.configDir]
 * @param {object} [options.state]
 * @returns {Promise<{ slot1: object, slot2: object, timestamp: number }>}
 */
async function pollAllSlots(options = {}) {
  const fetchFn = options.fetchUsageFn || fetchUsage;
  const getConfigFn = options.getConfigFn || getConfig;
  const state = options.state || pollerState;

  // 1. 현재 설정 로드
  let config = {};
  try {
    config = await getConfigFn({ configDir: options.configDir });
  } catch {
    config = {};
  }

  // 2. 슬롯 1, 슬롯 2 병렬 조회
  const [slot1Settled, slot2Settled] = await Promise.allSettled([
    fetchFn('slot1', options),
    fetchFn('slot2', options),
  ]);

  // 3. 응답 결과 정규화
  const slot1Data = normalizeSlotResult('slot1', slot1Settled);
  const slot2Data = normalizeSlotResult('slot2', slot2Settled);

  // 4. 슬롯 1 알림 평가
  if (slot1Data.success && slot1Data.metrics) {
    if (!state.slot1) state.slot1 = { prevMetrics: null, lastAlertedResetAt: null };
    const prev1 = state.slot1.prevMetrics;
    evaluateNotifications('slot1', prev1, slot1Data.metrics, config, state, options);
    state.slot1.prevMetrics = slot1Data.metrics;
  }

  // 5. 슬롯 2 알림 평가
  if (slot2Data.success && slot2Data.metrics) {
    if (!state.slot2) state.slot2 = { prevMetrics: null, lastAlertedResetAt: null };
    const prev2 = state.slot2.prevMetrics;
    evaluateNotifications('slot2', prev2, slot2Data.metrics, config, state, options);
    state.slot2.prevMetrics = slot2Data.metrics;
  }

  const result = {
    slot1: slot1Data,
    slot2: slot2Data,
    timestamp: Date.now(),
  };

  // 6. 최신 결과 메모리 캐싱
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
};
