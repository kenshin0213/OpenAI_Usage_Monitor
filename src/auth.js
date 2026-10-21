/**
 * src/auth.js
 * 
 * OpenAI 사용량 모니터 - OAuth 토큰 생명주기 및 계정 슬롯 격리 관리자
 * 
 * 주요 기능:
 * 1. 슬롯별 격리된 CODEX_HOME 디렉터리 경로 관리 (getSlotCodexHome)
 * 2. JWT 만료 시간 검사 및 자동 갱신 판별 (isTokenExpired)
 * 3. 토큰 유효성 보장 및 무중단 자동 갱신 (ensureValidToken, refreshSlotToken)
 * 4. 슬롯 2 등 신규 계정 브라우저 OAuth 로그인 플로우 실행 (startOAuthLoginFlow)
 */

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const {
  getConfigDir,
  normalizeSlotId,
  getSlot,
  saveSlot,
  seedSlot1FromCodex,
  extractEmailFromTokens,
  extractEmailFromJwt,
} = require('./config.js');

/**
 * 슬롯 전용 CODEX_HOME 디렉터리 경로를 반환합니다.
 * 전역 ~/.codex 환경과 완전히 분리된 슬롯별 독립 프로필 경로입니다.
 * 
 * @param {string|number} slotId 
 * @param {object} [options]
 * @param {string} [options.configDir]
 * @returns {string} 슬롯 전용 CODEX_HOME 디렉터리 경로
 */
function getSlotCodexHome(slotId, options = {}) {
  const normalizedId = normalizeSlotId(slotId);
  const baseDir = options.configDir || getConfigDir();
  return path.join(baseDir, 'profiles', normalizedId);
}

/**
 * JWT Access Token의 만료 여부를 판별합니다.
 * 
 * @param {string|null} token 
 * @param {number} [bufferSeconds=300] 만료 임박 판정 버퍼 시간 (기본 300초 = 5분)
 * @returns {boolean} 토큰이 없거나 만료되었거나 임박했으면 true, 안전하면 false
 */
function isTokenExpired(token, bufferSeconds = 300) {
  if (!token || typeof token !== 'string') {
    return true;
  }

  try {
    const parts = token.split('.');
    if (parts.length < 2) {
      return true;
    }

    let payloadJson;
    try {
      payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
    } catch {
      // base64url 실패 시 일반 base64 대체
      let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4 !== 0) base64 += '=';
      payloadJson = Buffer.from(base64, 'base64').toString('utf8');
    }

    const payload = JSON.parse(payloadJson);
    if (!payload || typeof payload.exp !== 'number') {
      return false; // 만료 필드가 명시되지 않은 토큰은 유효한 것으로 간주
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    return nowSeconds >= (payload.exp - bufferSeconds);
  } catch {
    return true;
  }
}

/**
 * tokens 객체 또는 auth.json 데이터로부터 주요 토큰 필드를 추출합니다.
 * @param {object} tokens 
 * @returns {{ accessToken: string|null, refreshToken: string|null, accountId: string|null, email: string|null, idToken: string|null }}
 */
function extractTokenInfo(tokens) {
  if (!tokens || typeof tokens !== 'object') {
    return {
      accessToken: null,
      refreshToken: null,
      accountId: null,
      email: null,
      idToken: null,
    };
  }

  return {
    accessToken: tokens.access_token || null,
    refreshToken: tokens.refresh_token || null,
    accountId: tokens.account_id || null,
    email: extractEmailFromTokens(tokens),
    idToken: tokens.id_token || null,
  };
}

/**
 * 지정된 슬롯의 격리된 CODEX_HOME 환경에서 토큰을 갱신합니다.
 * Codex CLI(`codex login status`)를 실행하여 백그라운드 갱신을 수행하고,
 * 갱신된 최신 토큰을 슬롯 저장소에 동기화합니다.
 * 
 * @param {string|number} slotId 
 * @param {object} [options]
 * @param {string} [options.configDir]
 * @param {Function} [options.refreshFn] 테스트용 커스텀 갱신 함수 (slotId, slotDir) => Promise<void>
 * @returns {Promise<{ accessToken: string, accountId: string|null, email: string|null, tokens: object }>}
 */
async function refreshSlotToken(slotId, options = {}) {
  const normalizedId = normalizeSlotId(slotId);
  const slotDir = getSlotCodexHome(normalizedId, options);
  await fs.mkdir(slotDir, { recursive: true });

  const authFilePath = path.join(slotDir, 'auth.json');

  if (typeof options.refreshFn === 'function') {
    await options.refreshFn(normalizedId, slotDir);
  } else {
    // Codex CLI를 격리된 CODEX_HOME 환경에서 실행하여 토큰 자동 갱신 트리거
    const runResult = spawnSync('codex', ['login', 'status'], {
      env: {
        ...process.env,
        CODEX_HOME: slotDir,
      },
      shell: true,
      encoding: 'utf8',
      windowsHide: true,
    });

    if (runResult.status !== 0) {
      const stderr = runResult.stderr || runResult.stdout || '로그인되지 않았거나 갱신 실패';
      throw new Error(`슬롯 ${normalizedId} 토큰 갱신 실패 (exit code: ${runResult.status}): ${stderr}`);
    }
  }

  // 갱신된 auth.json 파일 다시 읽기
  let rawContent;
  try {
    rawContent = await fs.readFile(authFilePath, 'utf8');
  } catch (err) {
    throw new Error(`슬롯 ${normalizedId}의 갱신된 auth.json 파일을 읽을 수 없습니다: ${err.message}`);
  }

  let authData;
  try {
    authData = JSON.parse(rawContent);
  } catch (err) {
    throw new Error(`슬롯 ${normalizedId}의 auth.json 파싱 실패: ${err.message}`);
  }

  if (!authData.tokens || !authData.tokens.access_token) {
    throw new Error(`슬롯 ${normalizedId}의 갱신 결과에 access_token이 누락되었습니다.`);
  }

  const email = extractEmailFromTokens(authData.tokens);

  // 슬롯 저장소에 최신 토큰 및 이메일 동기화
  await saveSlot(normalizedId, {
    tokens: authData.tokens,
    email: email || undefined,
    last_refresh: new Date().toISOString(),
  }, options);

  return {
    accessToken: authData.tokens.access_token,
    accountId: authData.tokens.account_id || null,
    email: email || null,
    tokens: authData.tokens,
  };
}

/**
 * 슬롯의 유효한 Access Token을 보장하고 반환합니다.
 * 토큰이 없거나 만료되었을 경우 격리 환경에서 자동 갱신을 수행합니다.
 * 
 * @param {string|number} slotId 
 * @param {object} [options]
 * @param {string} [options.configDir]
 * @param {string} [options.codexAuthPath] 전역 codex auth.json 경로
 * @param {boolean} [options.forceRefresh] 만료 여부와 무관하게 강제 갱신할지 여부
 * @param {number} [options.bufferSeconds=300] 만료 판정 버퍼 (초)
 * @param {Function} [options.refreshFn] 커스텀 갱신 함수 (테스트용)
 * @returns {Promise<{ accessToken: string, accountId: string|null, email: string|null, tokens: object }>}
 */
async function ensureValidToken(slotId, options = {}) {
  const normalizedId = normalizeSlotId(slotId);
  const slotDir = getSlotCodexHome(normalizedId, options);
  await fs.mkdir(slotDir, { recursive: true });

  const authFilePath = path.join(slotDir, 'auth.json');

  let authFileExists = false;
  try {
    await fs.access(authFilePath);
    authFileExists = true;
  } catch {
    authFileExists = false;
  }

  // 슬롯 디렉터리에 auth.json이 없는 경우 처리
  if (!authFileExists) {
    // 1. 슬롯 저장소(slot1.json/slot2.json)에 이미 저장된 토큰이 있는지 확인
    const slotData = await getSlot(normalizedId, options);
    if (slotData && slotData.tokens && slotData.tokens.access_token) {
      // 슬롯 저장소의 토큰을 auth.json으로 동기화 복원
      const restoredAuth = {
        auth_mode: slotData.auth_mode || 'chatgpt',
        tokens: slotData.tokens,
        last_refresh: slotData.last_refresh || null,
      };
      await fs.writeFile(authFilePath, JSON.stringify(restoredAuth, null, 2), 'utf8');
      authFileExists = true;
    } else if (normalizedId === 'slot1') {
      // 2. 슬롯 1인 경우, 전역 ~/.codex/auth.json에서 자동 임포트(시딩) 시도
      const globalCodexPath = options.codexAuthPath || path.join(os.homedir(), '.codex', 'auth.json');
      try {
        const globalContent = await fs.readFile(globalCodexPath, 'utf8');
        const parsedGlobal = JSON.parse(globalContent);
        if (parsedGlobal.tokens && parsedGlobal.tokens.access_token) {
          await fs.writeFile(authFilePath, JSON.stringify(parsedGlobal, null, 2), 'utf8');
          await seedSlot1FromCodex({ ...options, codexAuthPath: globalCodexPath, force: true });
          authFileExists = true;
        }
      } catch {
        // 전역 파일 없음 or 읽기 실패
      }
    }
  }

  // 여전히 인증 파일이 없는 경우 안내 에러
  if (!authFileExists) {
    if (normalizedId === 'slot1') {
      throw new Error('슬롯 1의 인증 정보를 찾을 수 없습니다. (Codex 로그인이 필요합니다)');
    } else {
      throw new Error('슬롯 2가 연동되지 않았습니다. ([계정 2 연동하기]를 통해 로그인해 주세요)');
    }
  }

  // auth.json 로드
  const rawContent = await fs.readFile(authFilePath, 'utf8');
  let authData;
  try {
    authData = JSON.parse(rawContent);
  } catch (err) {
    throw new Error(`슬롯 ${normalizedId}의 auth.json 파싱 실패: ${err.message}`);
  }

  if (!authData.tokens || !authData.tokens.access_token) {
    throw new Error(`슬롯 ${normalizedId}의 인증 파일에 access_token이 없습니다.`);
  }

  // 만료 검사 또는 강제 갱신 요청 확인
  const bufferSec = options.bufferSeconds ?? 300;
  const expired = isTokenExpired(authData.tokens.access_token, bufferSec);

  if (options.forceRefresh || expired) {
    return await refreshSlotToken(normalizedId, options);
  }

  const email = extractEmailFromTokens(authData.tokens);

  return {
    accessToken: authData.tokens.access_token,
    accountId: authData.tokens.account_id || null,
    email: email || null,
    tokens: authData.tokens,
  };
}

/**
 * 신규 계정(주로 슬롯 2) 로그인을 위해 브라우저 기반 Codex OAuth 인증 플로우를 시작합니다.
 * 슬롯 전용 CODEX_HOME 디렉터리를 격리 적용하여 전역 환경이나 슬롯 1에 전혀 영향을 주지 않습니다.
 * 
 * @param {string|number} slotId 
 * @param {object} [options]
 * @param {string} [options.configDir]
 * @param {Function} [options.spawnFn] 테스트용 커스텀 spawn 함수
 * @returns {Promise<{ success: boolean, slot: object }> & { childProcess: any }}
 */
function startOAuthLoginFlow(slotId, options = {}) {
  const normalizedId = normalizeSlotId(slotId);
  const slotDir = getSlotCodexHome(normalizedId, options);

  let child;
  const promise = (async () => {
    await fs.mkdir(slotDir, { recursive: true });

    const spawnFn = options.spawnFn || spawn;

    return new Promise((resolve, reject) => {
      child = spawnFn('codex', ['login'], {
        env: {
          ...process.env,
          CODEX_HOME: slotDir,
        },
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.on('error', (err) => {
        reject(new Error(`Codex 로그인 프로세스 시작 실패: ${err.message}`));
      });

      child.on('close', async (code) => {
        if (code !== 0) {
          return reject(new Error(`Codex 로그인이 비정상 종료되었습니다 (종료 코드: ${code})`));
        }

        try {
          const authFilePath = path.join(slotDir, 'auth.json');
          const raw = await fs.readFile(authFilePath, 'utf8');
          const authData = JSON.parse(raw);

          if (!authData.tokens || !authData.tokens.access_token) {
            return reject(new Error('로그인 완료 후 생성된 auth.json에 유효한 토큰이 없습니다.'));
          }

          const email = extractEmailFromTokens(authData.tokens);

          const slotData = await saveSlot(normalizedId, {
            tokens: authData.tokens,
            email: email || null,
            auth_mode: authData.auth_mode || 'chatgpt',
            status: 'active',
            source: 'codex_login',
            last_refresh: new Date().toISOString(),
          }, options);

          resolve({
            success: true,
            slot: slotData,
          });
        } catch (err) {
          reject(new Error(`로그인 완료 후 인증 정보 로드 실패: ${err.message}`));
        }
      });
    });
  })();

  promise.childProcess = child;
  return promise;
}

module.exports = {
  getSlotCodexHome,
  isTokenExpired,
  extractTokenInfo,
  refreshSlotToken,
  ensureValidToken,
  startOAuthLoginFlow,
};