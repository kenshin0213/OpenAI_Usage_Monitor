/**
 * src/config.js
 * 
 * OpenAI 사용량 모니터 - 설정 및 계정 슬롯 영속화 관리자
 * 
 * 주요 기능:
 * 1. 세션 격리: 슬롯 1(slot1.json)과 슬롯 2(slot2.json)를 파일 수준에서 완전 분리
 * 2. 애플리케이션 환경설정: config.json (폴링 주기, 알림 임계치 등)
 * 3. ~/.codex/auth.json 세션 자동 임포트(시딩) 지원
 * 4. 원자적(Atomic) 파일 쓰기를 통한 데이터 손상 방지
 */

const fs = require('fs/promises');
const path = require('path');
const os = require('os');

/**
 * 기본 설정 객체
 */
const DEFAULT_CONFIG = Object.freeze({
  pollIntervalMinutes: 5,        // 백그라운드 사용량 조회 주기 (분)
  alertThresholdPercent: 10,     // 5시간 단위 한도 잔여량 알림 임계치 (%)
  notifyOnThreshold: true,       // 임계치 도달 시 Windows 알림 발송 여부
  notifyOnReset: true,           // 한도 100% 리셋 시 Windows 알림 발송 여부
  startOnBoot: false,            // 윈도우 부팅 시 자동 시작 여부
  theme: 'dark',                 // UI 테마 ('dark' | 'light')
  slots: Object.freeze(['slot1', 'slot2']), // 활성화된 계정 슬롯 목록
});

/**
 * 런타임 설정 디렉터리 오버라이드 변수
 */
let customConfigDir = null;

/**
 * 전역 설정 디렉터리 경로를 강제 지정합니다 (주로 단위 테스트용).
 * @param {string|null} dir 
 */
function setConfigDir(dir) {
  customConfigDir = dir;
}

/**
 * 설정 디렉터리 오버라이드를 초기화합니다.
 */
function resetConfigDir() {
  customConfigDir = null;
}

/**
 * 현재 활성화된 설정 저장소 디렉터리 경로를 반환합니다.
 * 우선순위:
 * 1. setConfigDir로 지정된 런타임 경로
 * 2. 환경 변수 OPENAI_MONITOR_CONFIG_DIR 또는 CONFIG_DIR
 * 3. Windows %APPDATA%/OpenAI_Usage_Monitor
 * 4. ~/.config/openai-usage-monitor (기타 OS)
 * 
 * @returns {string} 디렉터리 경로
 */
function getConfigDir() {
  if (customConfigDir) {
    return customConfigDir;
  }
  if (process.env.OPENAI_MONITOR_CONFIG_DIR) {
    return process.env.OPENAI_MONITOR_CONFIG_DIR;
  }
  if (process.env.CONFIG_DIR) {
    return process.env.CONFIG_DIR;
  }
  const appData = process.env.APPDATA;
  if (appData) {
    return path.join(appData, 'OpenAI_Usage_Monitor');
  }
  return path.join(os.homedir(), '.config', 'openai-usage-monitor');
}

/**
 * 슬롯 식별자('slot1', 'slot2', ..., 'slotN')를 검증하고 표준 형식으로 정규화합니다.
 * @param {string|number} slotId 
 * @returns {string} 정규화된 슬롯 ID (예: 'slot1', 'slot2', 'slot3')
 */
function normalizeSlotId(slotId) {
  if (typeof slotId === 'string') {
    const trimmed = slotId.trim().toLowerCase();
    const match = trimmed.match(/^slot(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > 0) return `slot${num}`;
    }
    const numOnly = parseInt(trimmed, 10);
    if (!isNaN(numOnly) && String(numOnly) === trimmed && numOnly > 0) {
      return `slot${numOnly}`;
    }
  } else if (typeof slotId === 'number' && Number.isInteger(slotId) && slotId > 0) {
    return `slot${slotId}`;
  }
  throw new Error(`유효하지 않은 슬롯 ID입니다: ${slotId}`);
}

/**
 * 임시 파일을 거쳐 원자적으로 JSON 데이터를 안전하게 기록합니다.
 * @param {string} filePath 파일 경로
 * @param {object} data 저장할 객체
 */
async function safeWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const content = JSON.stringify(data, null, 2);
  const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;

  await fs.writeFile(tempPath, content, 'utf8');

  try {
    await fs.rename(tempPath, filePath);
  } catch (err) {
    // Windows에서 파일 잠금 등으로 인해 rename이 일시 실패하는 경우의 대비책
    try {
      await fs.copyFile(tempPath, filePath);
      await fs.unlink(tempPath).catch(() => {});
    } catch (fallbackErr) {
      await fs.unlink(tempPath).catch(() => {});
      throw fallbackErr;
    }
  }
}

/**
 * JSON 파일을 안전하게 읽어옵니다. 파일이 없으면 null을 반환합니다.
 * @param {string} filePath 파일 경로
 * @returns {Promise<object|null>}
 */
async function safeReadJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * 전체 환경설정을 반환합니다. (파일이 없으면 기본값 반환)
 * @param {object} [options]
 * @param {string} [options.configDir]
 * @returns {Promise<typeof DEFAULT_CONFIG>}
 */
async function getConfig(options = {}) {
  const dir = options.configDir || getConfigDir();
  const filePath = path.join(dir, 'config.json');
  const fileData = await safeReadJson(filePath);

  if (!fileData) {
    return {
      ...DEFAULT_CONFIG,
      slots: [...DEFAULT_CONFIG.slots],
    };
  }

  return {
    ...DEFAULT_CONFIG,
    ...fileData,
    slots: Array.isArray(fileData.slots) ? [...fileData.slots] : [...DEFAULT_CONFIG.slots],
  };
}

/**
 * 설정을 부분 갱신(patch)하고 파일에 저장합니다.
 * @param {Partial<typeof DEFAULT_CONFIG>} patch
 * @param {object} [options]
 * @param {string} [options.configDir]
 * @returns {Promise<typeof DEFAULT_CONFIG>}
 */
async function updateConfig(patch, options = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('갱신할 설정 객체가 유효하지 않습니다.');
  }

  const current = await getConfig(options);
  const updated = {
    ...current,
    ...patch,
  };

  const dir = options.configDir || getConfigDir();
  const filePath = path.join(dir, 'config.json');
  await safeWriteJson(filePath, updated);

  return updated;
}

/**
 * 현재 활성화된 슬롯 식별자 목록을 반환합니다.
 * @param {object} [options]
 * @param {string} [options.configDir]
 * @returns {Promise<string[]>}
 */
async function getSlots(options = {}) {
  const config = await getConfig(options);
  if (Array.isArray(config.slots) && config.slots.length > 0) {
    return [...config.slots];
  }
  return ['slot1', 'slot2'];
}

/**
 * 신규 계정 슬롯을 추가하고 빈 슬롯 파일을 초기화합니다.
 * @param {object} [options]
 * @param {string} [options.configDir]
 * @returns {Promise<{ slotId: string, slots: string[] }>}
 */
async function addSlot(options = {}) {
  const currentSlots = await getSlots(options);

  // 기존 슬롯 번호 중 최댓값을 찾아 다음 슬롯 번호 산출
  let maxNum = 0;
  for (const s of currentSlots) {
    const m = String(s).match(/^slot(\d+)$/i);
    if (m) {
      const num = parseInt(m[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }
  const nextNum = maxNum > 0 ? maxNum + 1 : currentSlots.length + 1;
  const newSlotId = `slot${nextNum}`;
  const nextSlots = [...currentSlots, newSlotId];

  // 환경설정에 신규 슬롯 목록 반영
  await updateConfig({ slots: nextSlots }, options);

  // 신규 슬롯 데이터 초기화 (linked: false)
  await saveSlot(newSlotId, {
    linked: false,
    tokens: null,
    email: null,
    usage: null,
    plan: null,
  }, { ...options, overwrite: true });

  return { slotId: newSlotId, slots: nextSlots };
}

/**
 * 지정된 슬롯을 제거합니다. 최소 2개의 슬롯이 유지되어야 합니다.
 * 슬롯 데이터 파일과 프로필 폴더도 함께 정리합니다.
 * @param {string|number} slotId 
 * @param {object} [options]
 * @param {string} [options.configDir]
 * @returns {Promise<{ success: boolean, slots: string[] }>}
 */
async function removeSlot(slotId, options = {}) {
  const normalizedId = normalizeSlotId(slotId);
  const currentSlots = await getSlots(options);

  if (currentSlots.length <= 2) {
    throw new Error('슬롯은 최소 2개 이상 유지되어야 합니다.');
  }

  if (!currentSlots.includes(normalizedId)) {
    throw new Error(`존재하지 않는 슬롯입니다: ${normalizedId}`);
  }

  const nextSlots = currentSlots.filter((id) => id !== normalizedId);
  await updateConfig({ slots: nextSlots }, options);

  // 슬롯 JSON 파일 삭제
  await clearSlot(normalizedId, options);

  // 프로필 폴더 삭제
  const dir = options.configDir || getConfigDir();
  const profileDir = path.join(dir, 'profiles', normalizedId);
  try {
    await fs.rm(profileDir, { recursive: true, force: true });
  } catch {
    // 디렉터리 부재 무시
  }

  return { success: true, slots: nextSlots };
}

/**
 * 지정된 슬롯을 로그아웃 처리합니다.
 * 토큰, 이메일, 사용량을 초기화하고 linked: false로 설정하며,
 * 프로필 폴더 내 auth.json 파일을 삭제합니다.
 * @param {string|number} slotId 
 * @param {object} [options]
 * @param {string} [options.configDir]
 * @returns {Promise<{ success: boolean }>}
 */
async function logoutSlot(slotId, options = {}) {
  const normalizedId = normalizeSlotId(slotId);

  // 프로필 폴더 내 auth.json 삭제 (auth 모듈 위임)
  const auth = require('./auth');
  if (typeof auth.logoutSlot === 'function') {
    await auth.logoutSlot(normalizedId, options);
  }

  // 슬롯 파일 데이터 초기화
  await saveSlot(normalizedId, {
    linked: false,
    tokens: null,
    email: null,
    usage: null,
    plan: null,
  }, options);

  return { success: true };
}

/**
 * 지정된 슬롯 파일 경로를 반환합니다.
 * @param {string} normalizedSlotId 
 * @param {string} dir 
 * @returns {string}
 */
function getSlotFilePath(normalizedSlotId, dir) {
  return path.join(dir, `${normalizedSlotId}.json`);
}

/**
 * 슬롯(slot1 또는 slot2)의 인증 및 사용량 데이터를 조회합니다.
 * 존재하지 않으면 null을 반환합니다.
 * @param {string|number} slotId 
 * @param {object} [options]
 * @param {string} [options.configDir]
 * @returns {Promise<object|null>}
 */
async function getSlot(slotId, options = {}) {
  const normalizedId = normalizeSlotId(slotId);
  const dir = options.configDir || getConfigDir();
  const filePath = getSlotFilePath(normalizedId, dir);

  return await safeReadJson(filePath);
}

/**
 * 슬롯 데이터를 독립적으로 저장합니다.
 * 기본적으로 기존 슬롯 데이터와 병합(merge)되며, overwrite 옵션 시 완전 대체됩니다.
 * @param {string|number} slotId 슬롯 식별자 ('slot1' 또는 'slot2')
 * @param {object} slotData 저장할 데이터
 * @param {object} [options]
 * @param {string} [options.configDir]
 * @param {boolean} [options.overwrite] 완전 덮어쓰기 여부 (기본 false: 부분 병합)
 * @returns {Promise<object>}
 */
async function saveSlot(slotId, slotData, options = {}) {
  const normalizedId = normalizeSlotId(slotId);
  if (!slotData || typeof slotData !== 'object' || Array.isArray(slotData)) {
    throw new Error('저장할 슬롯 데이터 객체가 유효하지 않습니다.');
  }

  const dir = options.configDir || getConfigDir();
  const filePath = getSlotFilePath(normalizedId, dir);

  let merged;
  if (options.overwrite) {
    merged = {
      ...slotData,
      updatedAt: new Date().toISOString(),
    };
  } else {
    const existing = (await safeReadJson(filePath)) || {};
    merged = {
      ...existing,
      ...slotData,
      updatedAt: new Date().toISOString(),
    };
  }

  await safeWriteJson(filePath, merged);
  return merged;
}

/**
 * 슬롯 데이터를 저장소에서 완전히 삭제합니다.
 * @param {string|number} slotId 
 * @param {object} [options]
 * @param {string} [options.configDir]
 * @returns {Promise<boolean>} 삭제 성공 여부
 */
async function clearSlot(slotId, options = {}) {
  const normalizedId = normalizeSlotId(slotId);
  const dir = options.configDir || getConfigDir();
  const filePath = getSlotFilePath(normalizedId, dir);

  try {
    await fs.unlink(filePath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

/**
 * JWT ID 토큰에서 이메일 정보를 안전하게 추출합니다.
 * @param {string} token 
 * @returns {string|null}
 */
function extractEmailFromJwt(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson);
    return payload.email || payload['https://api.openai.com/profile']?.email || null;
  } catch {
    return null;
  }
}

/**
 * tokens 객체로부터 이메일 문자열을 추출합니다.
 * @param {object} tokens 
 * @returns {string|null}
 */
function extractEmailFromTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') return null;
  if (tokens.email && typeof tokens.email === 'string') return tokens.email;
  if (tokens.id_token) {
    const email = extractEmailFromJwt(tokens.id_token);
    if (email) return email;
  }
  if (tokens.access_token) {
    const email = extractEmailFromJwt(tokens.access_token);
    if (email) return email;
  }
  return null;
}

/**
 * 기본 ~/.codex/auth.json 경로를 반환합니다.
 * @returns {string}
 */
function getDefaultCodexAuthPath() {
  if (process.env.CODEX_AUTH_PATH) {
    return process.env.CODEX_AUTH_PATH;
  }
  return path.join(os.homedir(), '.codex', 'auth.json');
}

/**
 * PC에 이미 존재하는 ~/.codex/auth.json 파일에서 슬롯 1 초기 인증 정보를 자동 임포트(시딩)합니다.
 * 
 * @param {object} [options]
 * @param {string} [options.codexAuthPath] 커스텀 auth.json 경로
 * @param {boolean} [options.force] 이미 slot1이 존재해도 강제 덮어쓰기 여부 (기본 false)
 * @param {string} [options.configDir]
 * @returns {Promise<{ success: boolean, reason?: string, slot: object|null }>}
 */
async function seedSlot1FromCodex(options = {}) {
  const codexPath = options.codexAuthPath || getDefaultCodexAuthPath();
  const force = options.force ?? false;

  // 이미 slot1에 토큰이 설정되어 있고 force가 아닌 경우 덮어쓰지 않음
  const existingSlot1 = await getSlot('slot1', options);
  if (existingSlot1 && existingSlot1.tokens && !force) {
    return {
      success: false,
      reason: 'already_exists',
      slot: existingSlot1,
    };
  }

  // codex auth.json 파일 읽기
  let rawContent;
  try {
    rawContent = await fs.readFile(codexPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        success: false,
        reason: 'codex_auth_not_found',
        slot: null,
      };
    }
    throw err;
  }

  let authData;
  try {
    authData = JSON.parse(rawContent);
  } catch (err) {
    throw new Error(`Codex 인증 파일(${codexPath}) 파싱 실패: ${err.message}`);
  }

  const email = extractEmailFromTokens(authData.tokens);

  const slotData = {
    tokens: authData.tokens || null,
    auth_mode: authData.auth_mode || 'chatgpt',
    email: email || null,
    plan: null,
    usage: null,
    source: 'codex_auth',
    last_refresh: authData.last_refresh || null,
  };

  const saved = await saveSlot('slot1', slotData, { ...options, overwrite: true });

  return {
    success: true,
    slot: saved,
  };
}

module.exports = {
  DEFAULT_CONFIG,
  setConfigDir,
  resetConfigDir,
  getConfigDir,
  normalizeSlotId,
  getConfig,
  updateConfig,
  getSlot,
  saveSlot,
  clearSlot,
  seedSlot1FromCodex,
  extractEmailFromJwt,
  extractEmailFromTokens,
  getSlots,
  addSlot,
  removeSlot,
  logoutSlot,
};
