/**
 * src/api.js
 * 
 * OpenAI 백엔드 사용량(WHAM) 조회 및 응답 정규화 엔진
 * 
 * 주요 기능:
 * 1. 한도 리셋 카운트다운 시간 한국어 친화적 포맷팅 (formatResetSeconds)
 * 2. WHAM API 응답 파싱 및 UI 친화적 메트릭 구조 변환 (parseUsageResponse)
 * 3. 듀얼 슬롯 사용량 원격 조회 및 401 인증 만료 시 자동 재시도 (fetchUsage)
 */

const { normalizeSlotId, saveSlot } = require('./config.js');
const { ensureValidToken } = require('./auth.js');

/**
 * 남은 초(seconds)를 사용자 친화적인 한국어 문자열로 변환합니다.
 * 
 * 예시:
 * - 45초 -> "곧 초기화"
 * - 1080초 -> "18분 후 초기화"
 * - 15480초 -> "4시간 18분 후 초기화"
 * - 7200초 -> "2시간 후 초기화"
 * - 536400초 -> "6일 5시간 후 초기화"
 * - 172800초 -> "2일 후 초기화"
 * 
 * @param {number} seconds 남은 시간(초)
 * @returns {string} 포맷팅된 한국어 문자열
 */
function formatResetSeconds(seconds) {
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
 * WHAM 사용량 API의 원본 JSON을 파싱하여 정규화된 사용량 지표 객체로 변환합니다.
 * 
 * @param {object|string} rawJson API 응답 데이터 (객체 또는 문자열)
 * @returns {object} 정규화된 사용량 객체
 */
function parseUsageResponse(rawJson) {
  let data = rawJson;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      data = {};
    }
  }

  if (!data || typeof data !== 'object') {
    data = {};
  }

  const rateLimit = data.rate_limit || {};
  const pw = rateLimit.primary_window || {};
  const sw = rateLimit.secondary_window || {};

  // Primary Window (5시간 단위 한도)
  const pUsedRaw = typeof pw.used_percent === 'number' ? pw.used_percent : 0;
  const pUsed = Math.max(0, Math.min(100, Math.round(pUsedRaw)));
  const pRemaining = Math.max(0, Math.min(100, 100 - pUsed));
  const pLimitSeconds = typeof pw.limit_window_seconds === 'number' ? pw.limit_window_seconds : 0;
  const pResetAfterSeconds = typeof pw.reset_after_seconds === 'number' ? pw.reset_after_seconds : 0;
  const pResetAt = typeof pw.reset_at === 'number' ? pw.reset_at : null;

  // Secondary Window (주간 7일 단위 한도)
  const sUsedRaw = typeof sw.used_percent === 'number' ? sw.used_percent : 0;
  const sUsed = Math.max(0, Math.min(100, Math.round(sUsedRaw)));
  const sRemaining = Math.max(0, Math.min(100, 100 - sUsed));
  const sLimitSeconds = typeof sw.limit_window_seconds === 'number' ? sw.limit_window_seconds : 0;
  const sResetAfterSeconds = typeof sw.reset_after_seconds === 'number' ? sw.reset_after_seconds : 0;
  const sResetAt = typeof sw.reset_at === 'number' ? sw.reset_at : null;

  return {
    primaryWindow: {
      usedPercent: pUsed,
      remainingPercent: pRemaining,
      limitWindowSeconds: pLimitSeconds,
      resetAfterSeconds: pResetAfterSeconds,
      resetAt: pResetAt,
      formattedResetText: formatResetSeconds(pResetAfterSeconds),
    },
    secondaryWindow: {
      usedPercent: sUsed,
      remainingPercent: sRemaining,
      limitWindowSeconds: sLimitSeconds,
      resetAfterSeconds: sResetAfterSeconds,
      resetAt: sResetAt,
      formattedResetText: formatResetSeconds(sResetAfterSeconds),
    },
    planType: data.plan_type || 'unknown',
    email: data.email || null,
    accountId: data.account_id || null,
    userId: data.user_id || null,
    credits: data.credits || { has_credits: false },
    rateLimitAllowed: rateLimit.allowed !== false,
    limitReached: Boolean(rateLimit.limit_reached),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * 특정 슬롯의 실시간 사용량을 조회합니다.
 * 
 * 1. ensureValidToken으로 유효한 OAuth 토큰을 확보
 * 2. https://chatgpt.com/backend-api/wham/usage 호출
 * 3. 401 Unauthorized 발생 시 자동 갱신 후 1회 재시도
 * 4. parseUsageResponse로 정규화 후 슬롯 저장소에 저장
 * 
 * @param {string|number} slotId 조회할 슬롯 식별자 ('slot1' 또는 'slot2')
 * @param {object} [options]
 * @param {string} [options.baseUrl] 기본 엔드포인트 URL 재정의
 * @param {Function} [options.fetchFn] 커스텀 fetch 함수
 * @param {boolean} [options.save=true] 슬롯 저장소 영속화 여부
 * @param {number} [options.timeoutMs=15000] 요청 타임아웃 (ms)
 * @param {string} [options.configDir]
 * @param {Function} [options.refreshFn] 커스텀 갱신 함수 (테스트용)
 * @returns {Promise<ReturnType<typeof parseUsageResponse>>}
 */
async function fetchUsage(slotId, options = {}) {
  const normalizedId = normalizeSlotId(slotId);
  const baseUrl = options.baseUrl || 'https://chatgpt.com/backend-api/wham/usage';
  const fetchFn = options.fetchFn || globalThis.fetch;

  if (typeof fetchFn !== 'function') {
    throw new Error('런타임에 fetch 함수가 지원되지 않습니다 (Node.js 18+ 필요).');
  }

  // 1. 유효한 토큰 확보 (만료 시 자동 갱신)
  let tokenInfo = await ensureValidToken(normalizedId, options);

  const buildHeaders = (info) => {
    const headers = {
      'Authorization': `Bearer ${info.accessToken}`,
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    };
    if (info.accountId) {
      headers['ChatGPT-Account-Id'] = info.accountId;
    }
    return headers;
  };

  // 2. WHAM API 호출
  let response;
  try {
    response = await fetchFn(baseUrl, {
      method: 'GET',
      headers: buildHeaders(tokenInfo),
      signal: AbortSignal.timeout(options.timeoutMs || 15000),
    });
  } catch (err) {
    throw new Error(`OpenAI 사용량 조회 네트워크 오류: ${err.message}`);
  }

  // 3. 401 Unauthorized 발생 시 토큰 강제 갱신 후 1회 재시도
  if (response.status === 401) {
    tokenInfo = await ensureValidToken(normalizedId, { ...options, forceRefresh: true });

    try {
      response = await fetchFn(baseUrl, {
        method: 'GET',
        headers: buildHeaders(tokenInfo),
        signal: AbortSignal.timeout(options.timeoutMs || 15000),
      });
    } catch (err) {
      throw new Error(`OpenAI 사용량 재시도 네트워크 오류: ${err.message}`);
    }

    if (response.status === 401) {
      throw new Error(`슬롯 ${normalizedId}의 인증이 만료되었거나 권한이 없습니다 (401 Unauthorized).`);
    }
  }

  // 4. 기타 HTTP 에러 처리
  if (!response.ok) {
    const errorBody = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
    throw new Error(`OpenAI 사용량 조회 실패 (${response.status} ${response.statusText || ''}): ${errorBody}`);
  }

  // 5. 응답 정규화 및 파싱
  const rawData = await response.json();
  const parsed = parseUsageResponse(rawData);

  // WHAM API 응답에 email이 누락된 경우 tokenInfo.email을 폴백으로 채워 반환값과 저장소 일관성 유지
  if (!parsed.email && tokenInfo.email) {
    parsed.email = tokenInfo.email;
  }

  // 6. 슬롯 저장소 영속화 (옵션)
  if (options.save !== false) {
    await saveSlot(normalizedId, {
      usage: parsed,
      plan: parsed.planType,
      email: parsed.email,
    }, options);
  }

  return parsed;
}

module.exports = {
  formatResetSeconds,
  parseUsageResponse,
  fetchUsage,
};