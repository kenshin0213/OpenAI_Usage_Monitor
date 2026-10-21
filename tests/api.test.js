/**
 * tests/api.test.js
 * 
 * OpenAI 사용량 조회 엔진 및 OAuth 토큰 관리자 단위 테스트
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const { formatResetSeconds, parseUsageResponse, fetchUsage } = require('../src/api.js');
const {
  getSlotCodexHome,
  isTokenExpired,
  ensureValidToken,
  startOAuthLoginFlow,
  refreshSlotToken,
} = require('../src/auth.js');
const { setConfigDir, resetConfigDir, getSlot } = require('../src/config.js');

/**
 * 테스트용 JWT 토큰 생성 헬퍼
 */
function createFakeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

describe('api.js - 사용량 조회 및 파싱 엔진', () => {
  describe('formatResetSeconds', () => {
    it('60초 이하 또는 0초 이하는 "곧 초기화"를 반환해야 한다', () => {
      assert.equal(formatResetSeconds(0), '곧 초기화');
      assert.equal(formatResetSeconds(30), '곧 초기화');
      assert.equal(formatResetSeconds(60), '곧 초기화');
      assert.equal(formatResetSeconds(-10), '곧 초기화');
      assert.equal(formatResetSeconds(null), '곧 초기화');
      assert.equal(formatResetSeconds(undefined), '곧 초기화');
      assert.equal(formatResetSeconds(NaN), '곧 초기화');
    });

    it('1분 초과 1시간 이하는 "X분 후 초기화"를 반환해야 한다', () => {
      assert.equal(formatResetSeconds(61), '1분 후 초기화');
      assert.equal(formatResetSeconds(1080), '18분 후 초기화');
      assert.equal(formatResetSeconds(3599), '59분 후 초기화');
      assert.equal(formatResetSeconds(3600), '60분 후 초기화');
    });

    it('1시간 초과 24시간 이하는 시간 및 분 단위로 반환해야 한다', () => {
      // 4시간 18분 (4 * 3600 + 18 * 60 = 14400 + 1080 = 15480)
      assert.equal(formatResetSeconds(15480), '4시간 18분 후 초기화');
      // 분이 0인 경우 시간만 표시
      assert.equal(formatResetSeconds(7200), '2시간 후 초기화');
      assert.equal(formatResetSeconds(86400), '24시간 후 초기화');
    });

    it('24시간 초과는 일 및 시간 단위로 반환해야 한다', () => {
      // 6일 5시간 (6 * 86400 + 5 * 3600 = 518400 + 18000 = 536400)
      assert.equal(formatResetSeconds(536400), '6일 5시간 후 초기화');
      // 시간이 0인 경우 일만 표시
      assert.equal(formatResetSeconds(86400 * 2), '2일 후 초기화');
      // 12일 0시간
      assert.equal(formatResetSeconds(86400 * 12), '12일 후 초기화');
    });
  });

  describe('parseUsageResponse', () => {
    it('실제 WHAM usage 응답 형태를 표준화된 메트릭 구조로 정상 파싱해야 한다', () => {
      const mockRaw = {
        user_id: 'user-123456',
        account_id: 'acc-abcdef',
        email: 'test@example.com',
        plan_type: 'plus',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 38,
            limit_window_seconds: 18000,
            reset_after_seconds: 4683,
            reset_at: 1792566994,
          },
          secondary_window: {
            used_percent: 26,
            limit_window_seconds: 604800,
            reset_after_seconds: 523381,
            reset_at: 1793085691,
          },
        },
        credits: {
          has_credits: false,
          balance: '0',
        },
      };

      const parsed = parseUsageResponse(mockRaw);

      assert.equal(parsed.planType, 'plus');
      assert.equal(parsed.email, 'test@example.com');
      assert.equal(parsed.accountId, 'acc-abcdef');
      assert.equal(parsed.userId, 'user-123456');

      // Primary Window (5시간 단위)
      assert.equal(parsed.primaryWindow.usedPercent, 38);
      assert.equal(parsed.primaryWindow.remainingPercent, 62);
      assert.equal(parsed.primaryWindow.limitWindowSeconds, 18000);
      assert.equal(parsed.primaryWindow.resetAfterSeconds, 4683);
      assert.equal(parsed.primaryWindow.resetAt, 1792566994);
      assert.equal(parsed.primaryWindow.formattedResetText, '1시간 18분 후 초기화');

      // Secondary Window (주간 한도)
      assert.equal(parsed.secondaryWindow.usedPercent, 26);
      assert.equal(parsed.secondaryWindow.remainingPercent, 74);
      assert.equal(parsed.secondaryWindow.limitWindowSeconds, 604800);
      assert.equal(parsed.secondaryWindow.resetAfterSeconds, 523381);
      assert.equal(parsed.secondaryWindow.resetAt, 1793085691);
      assert.equal(parsed.secondaryWindow.formattedResetText, '6일 1시간 후 초기화');

      // 크레딧 및 상태
      assert.equal(parsed.credits.has_credits, false);
      assert.equal(parsed.rateLimitAllowed, true);
      assert.equal(parsed.limitReached, false);
      assert.ok(parsed.fetchedAt);
    });

    it('100% 사용 및 0% 사용 등 경계값을 올바르게 클램핑해야 한다', () => {
      const mockRaw100 = {
        plan_type: 'pro',
        email: 'full@example.com',
        rate_limit: {
          limit_reached: true,
          primary_window: {
            used_percent: 100,
            limit_window_seconds: 18000,
            reset_after_seconds: 120,
            reset_at: 1792560000,
          },
          secondary_window: {
            used_percent: 105, // 100 초과 비정상 값 방어
            limit_window_seconds: 604800,
            reset_after_seconds: 3600,
            reset_at: 1793000000,
          },
        },
      };

      const parsed = parseUsageResponse(mockRaw100);
      assert.equal(parsed.primaryWindow.usedPercent, 100);
      assert.equal(parsed.primaryWindow.remainingPercent, 0);
      assert.equal(parsed.secondaryWindow.usedPercent, 100); // 100으로 클램핑
      assert.equal(parsed.secondaryWindow.remainingPercent, 0);
      assert.equal(parsed.limitReached, true);
    });

    it('필드가 누락되거나 비어 있는 경우에도 안전하게 기본값을 반환해야 한다', () => {
      const parsedEmpty = parseUsageResponse({});
      assert.equal(parsedEmpty.planType, 'unknown');
      assert.equal(parsedEmpty.email, null);
      assert.equal(parsedEmpty.primaryWindow.usedPercent, 0);
      assert.equal(parsedEmpty.primaryWindow.remainingPercent, 100);
      assert.equal(parsedEmpty.secondaryWindow.usedPercent, 0);
      assert.equal(parsedEmpty.secondaryWindow.remainingPercent, 100);
      assert.equal(parsedEmpty.credits.has_credits, false);

      const parsedNull = parseUsageResponse(null);
      assert.equal(parsedNull.planType, 'unknown');
    });

    it('문자열 형태의 JSON이 전달되어도 정상 파싱되어야 한다', () => {
      const jsonStr = JSON.stringify({
        plan_type: 'team',
        email: 'team@company.com',
      });
      const parsed = parseUsageResponse(jsonStr);
      assert.equal(parsed.planType, 'team');
      assert.equal(parsed.email, 'team@company.com');
    });
  });
});

describe('auth.js - 토큰 수명 주기 및 OAuth 격리 관리자', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-auth-test-'));
    setConfigDir(tempDir);
  });

  afterEach(async () => {
    resetConfigDir();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe('getSlotCodexHome', () => {
    it('각 슬롯에 대해 완전히 격리된 독립 프로필 디렉터리 경로를 반환해야 한다', () => {
      const slot1Home = getSlotCodexHome('slot1', { configDir: tempDir });
      const slot2Home = getSlotCodexHome('slot2', { configDir: tempDir });

      assert.ok(slot1Home.includes('slot1'));
      assert.ok(slot2Home.includes('slot2'));
      assert.notEqual(slot1Home, slot2Home);
      assert.equal(path.dirname(slot1Home), path.dirname(slot2Home));
    });
  });

  describe('isTokenExpired', () => {
    it('만료 시간이 미래인 유효한 토큰은 false를 반환해야 한다', () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600; // 1시간 뒤
      const token = createFakeJwt({ exp: futureExp });
      assert.equal(isTokenExpired(token), false);
    });

    it('이미 만료된 토큰은 true를 반환해야 한다', () => {
      const pastExp = Math.floor(Date.now() / 1000) - 60; // 1분 전
      const token = createFakeJwt({ exp: pastExp });
      assert.equal(isTokenExpired(token), true);
    });

    it('버퍼 시간(기본 300초) 이내에 만료되는 임박 토큰은 true를 반환해야 한다', () => {
      const soonExp = Math.floor(Date.now() / 1000) + 120; // 2분 뒤 만료 (300초 미만)
      const token = createFakeJwt({ exp: soonExp });
      assert.equal(isTokenExpired(token, 300), true);
      // 버퍼를 60초로 줄이면 유효한 것으로 판정
      assert.equal(isTokenExpired(token, 60), false);
    });

    it('유효하지 않거나 빈 토큰은 true를 반환해야 한다', () => {
      assert.equal(isTokenExpired(null), true);
      assert.equal(isTokenExpired(''), true);
      assert.equal(isTokenExpired('invalid-token'), true);
    });
  });

  describe('ensureValidToken', () => {
    it('slot1에 토큰이 없으나 ~/.codex/auth.json(모의)이 있으면 자동 시딩하고 유효 토큰을 반환해야 한다', async () => {
      // 모의 전역 codex auth.json 생성
      const mockCodexAuthPath = path.join(tempDir, 'global-codex-auth.json');
      const validFutureExp = Math.floor(Date.now() / 1000) + 7200;
      const fakeToken = createFakeJwt({ exp: validFutureExp, email: 'user1@example.com' });
      await fs.writeFile(
        mockCodexAuthPath,
        JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: {
            access_token: fakeToken,
            refresh_token: 'fake-refresh-token',
            account_id: 'acc-slot-1',
          },
        })
      );

      const tokenInfo = await ensureValidToken('slot1', {
        configDir: tempDir,
        codexAuthPath: mockCodexAuthPath,
      });

      assert.equal(tokenInfo.accessToken, fakeToken);
      assert.equal(tokenInfo.accountId, 'acc-slot-1');
      assert.equal(tokenInfo.email, 'user1@example.com');

      // slot1 디렉터리에 auth.json이 복사되었는지 확인
      const slot1Home = getSlotCodexHome('slot1', { configDir: tempDir });
      const slot1AuthExists = await fs.access(path.join(slot1Home, 'auth.json')).then(() => true).catch(() => false);
      assert.ok(slot1AuthExists);
    });

    it('미연동된 슬롯 2에 대해 ensureValidToken을 호출하면 명확한 오류를 발생시켜야 한다', async () => {
      await assert.rejects(
        async () => {
          await ensureValidToken('slot2', { configDir: tempDir });
        },
        /슬롯 2가 연동되지 않았습니다/
      );
    });

    it('토큰이 만료된 경우 refreshSlotToken을 트리거하여 갱신된 새 토큰을 반환해야 한다', async () => {
      const slot1Home = getSlotCodexHome('slot1', { configDir: tempDir });
      await fs.mkdir(slot1Home, { recursive: true });

      const expiredToken = createFakeJwt({ exp: Math.floor(Date.now() / 1000) - 100 });
      const refreshedToken = createFakeJwt({ exp: Math.floor(Date.now() / 1000) + 7200, email: 'refreshed@example.com' });

      await fs.writeFile(
        path.join(slot1Home, 'auth.json'),
        JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: {
            access_token: expiredToken,
            refresh_token: 'valid-refresh-token',
            account_id: 'acc-refreshed',
          },
        })
      );

      // 모의 refresh 함수 주입
      let refreshCalled = false;
      const mockRefreshFn = async (slotId, homeDir) => {
        refreshCalled = true;
        await fs.writeFile(
          path.join(homeDir, 'auth.json'),
          JSON.stringify({
            auth_mode: 'chatgpt',
            tokens: {
              access_token: refreshedToken,
              refresh_token: 'new-refresh-token',
              account_id: 'acc-refreshed',
            },
          })
        );
      };

      const tokenInfo = await ensureValidToken('slot1', {
        configDir: tempDir,
        refreshFn: mockRefreshFn,
      });

      assert.ok(refreshCalled, '갱신 함수가 호출되어야 함');
      assert.equal(tokenInfo.accessToken, refreshedToken);
      assert.equal(tokenInfo.email, 'refreshed@example.com');
    });
  });

  describe('startOAuthLoginFlow', () => {
    it('슬롯 디렉터리를 생성하고 codex login 프로세스를 실행하며 완료 시 슬롯 정보를 저장해야 한다', async () => {
      const slot2Home = getSlotCodexHome('slot2', { configDir: tempDir });
      const newToken = createFakeJwt({ exp: Math.floor(Date.now() / 1000) + 7200, email: 'newslot2@example.com' });

      // 모의 spawn 함수 주입
      const mockSpawn = (cmd, args, options) => {
        const emitter = new EventEmitter();
        emitter.pid = 9999;
        emitter.kill = () => {};

        // 비동기로 auth.json 작성 후 프로세스 정상 종료 시뮬레이션
        setTimeout(async () => {
          await fs.mkdir(options.env.CODEX_HOME, { recursive: true });
          await fs.writeFile(
            path.join(options.env.CODEX_HOME, 'auth.json'),
            JSON.stringify({
              auth_mode: 'chatgpt',
              tokens: {
                access_token: newToken,
                refresh_token: 'slot2-refresh',
                account_id: 'acc-slot2',
              },
            })
          );
          emitter.emit('close', 0);
        }, 20);

        return emitter;
      };

      const result = await startOAuthLoginFlow('slot2', {
        configDir: tempDir,
        spawnFn: mockSpawn,
      });

      assert.equal(result.success, true);
      assert.equal(result.slot.email, 'newslot2@example.com');

      // config store에도 slot2가 저장되었는지 확인
      const savedSlot = await getSlot('slot2', { configDir: tempDir });
      assert.ok(savedSlot);
      assert.equal(savedSlot.email, 'newslot2@example.com');
      assert.equal(savedSlot.tokens.access_token, newToken);
    });

    it('startOAuthLoginFlow 호출 즉시 loginPromise.childProcess가 정의되어 프로세스 제어가 가능해야 한다', async () => {
      let killCalled = false;
      const mockSpawn = (cmd, args, options) => {
        const emitter = new EventEmitter();
        emitter.pid = 12345;
        emitter.kill = () => {
          killCalled = true;
          emitter.emit('close', 1);
        };
        return emitter;
      };

      const loginPromise = startOAuthLoginFlow('slot2', {
        configDir: tempDir,
        spawnFn: mockSpawn,
      });

      // 동기 반환 즉시 childProcess가 존재해야 함
      assert.ok(loginPromise.childProcess, 'childProcess가 동기적으로 정의되어야 함');
      assert.equal(loginPromise.childProcess.pid, 12345);

      // 프로세스 kill 제어 가능 확인
      loginPromise.childProcess.kill();
      assert.equal(killCalled, true);

      // 프로세스가 비정상 종료(코드 1)되었으므로 reject 검증
      await assert.rejects(async () => {
        await loginPromise;
      }, /Codex 로그인이 비정상 종료되었습니다/);
    });
  });
});

describe('fetchUsage - API 통신 및 에러 복구', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-fetch-test-'));
    setConfigDir(tempDir);
  });

  afterEach(async () => {
    resetConfigDir();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('유효한 토큰으로 사용량을 정상 조회하고 슬롯에 저장해야 한다', async () => {
    const validToken = createFakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, email: 'user@test.com' });
    const slot1Home = getSlotCodexHome('slot1', { configDir: tempDir });
    await fs.mkdir(slot1Home, { recursive: true });
    await fs.writeFile(
      path.join(slot1Home, 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: validToken,
          account_id: 'acc-123',
        },
      })
    );

    let capturedHeaders = null;
    const mockFetch = async (url, options) => {
      capturedHeaders = options.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plan_type: 'plus',
          email: 'user@test.com',
          rate_limit: {
            allowed: true,
            primary_window: {
              used_percent: 40,
              limit_window_seconds: 18000,
              reset_after_seconds: 3600,
            },
          },
        }),
      };
    };

    const usage = await fetchUsage('slot1', {
      configDir: tempDir,
      fetchFn: mockFetch,
    });

    assert.equal(usage.planType, 'plus');
    assert.equal(usage.primaryWindow.usedPercent, 40);
    assert.equal(usage.primaryWindow.remainingPercent, 60);
    assert.equal(capturedHeaders['Authorization'], `Bearer ${validToken}`);
    assert.equal(capturedHeaders['ChatGPT-Account-Id'], 'acc-123');

    // 슬롯 저장소에 사용량 정보가 기록되었는지 확인
    const slotData = await getSlot('slot1', { configDir: tempDir });
    assert.ok(slotData.usage);
    assert.equal(slotData.usage.primaryWindow.usedPercent, 40);
    assert.equal(slotData.plan, 'plus');
  });

  it('WHAM API 응답에 email 필드가 없는 경우 tokenInfo.email을 폴백으로 채워야 한다', async () => {
    const validToken = createFakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, email: 'fallback-user@test.com' });
    const slot1Home = getSlotCodexHome('slot1', { configDir: tempDir });
    await fs.mkdir(slot1Home, { recursive: true });
    await fs.writeFile(
      path.join(slot1Home, 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: validToken,
          account_id: 'acc-fallback',
        },
      })
    );

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        plan_type: 'plus',
        // email 필드 의도적 누락
        rate_limit: {
          primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_after_seconds: 1800 },
        },
      }),
    });

    const usage = await fetchUsage('slot1', {
      configDir: tempDir,
      fetchFn: mockFetch,
    });

    assert.equal(usage.email, 'fallback-user@test.com');
    const slotData = await getSlot('slot1', { configDir: tempDir });
    assert.equal(slotData.email, 'fallback-user@test.com');
  });

  it('401 Unauthorized 발생 시 토큰을 강제 갱신한 후 재시도하여 성공해야 한다', async () => {
    const initialToken = createFakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const refreshedToken = createFakeJwt({ exp: Math.floor(Date.now() / 1000) + 7200 });

    const slot1Home = getSlotCodexHome('slot1', { configDir: tempDir });
    await fs.mkdir(slot1Home, { recursive: true });
    await fs.writeFile(
      path.join(slot1Home, 'auth.json'),
      JSON.stringify({
        tokens: { access_token: initialToken },
      })
    );

    let fetchCallCount = 0;
    const mockFetch = async (url, options) => {
      fetchCallCount++;
      if (options.headers['Authorization'] === `Bearer ${initialToken}`) {
        return {
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          text: async () => 'Token expired or revoked',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plan_type: 'pro',
          email: 'retry-success@example.com',
          rate_limit: {
            primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 600 },
          },
        }),
      };
    };

    let refreshCalled = false;
    const mockRefresh = async (slotId, homeDir) => {
      refreshCalled = true;
      await fs.writeFile(
        path.join(homeDir, 'auth.json'),
        JSON.stringify({
          tokens: { access_token: refreshedToken },
        })
      );
    };

    const usage = await fetchUsage('slot1', {
      configDir: tempDir,
      fetchFn: mockFetch,
      refreshFn: mockRefresh,
    });

    assert.equal(refreshCalled, true);
    assert.equal(fetchCallCount, 2, '초기 호출 실패 후 1회 재시도해야 함');
    assert.equal(usage.planType, 'pro');
    assert.equal(usage.email, 'retry-success@example.com');
  });

  it('서버가 지속적으로 401을 반환하면 에러를 던져야 한다', async () => {
    const token = createFakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const slot1Home = getSlotCodexHome('slot1', { configDir: tempDir });
    await fs.mkdir(slot1Home, { recursive: true });
    await fs.writeFile(
      path.join(slot1Home, 'auth.json'),
      JSON.stringify({
        tokens: { access_token: token },
      })
    );

    const mockFetch = async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'Invalid credentials',
    });

    const mockRefresh = async () => {};

    await assert.rejects(
      async () => {
        await fetchUsage('slot1', {
          configDir: tempDir,
          fetchFn: mockFetch,
          refreshFn: mockRefresh,
        });
      },
      /401 Unauthorized/
    );
  });

  it('PC에 ~/.codex/auth.json이 존재하는 경우 실제 OpenAI 엔드포인트 연동 검증', async (t) => {
    const codexAuthPath = path.join(os.homedir(), '.codex', 'auth.json');
    const exists = await fs.access(codexAuthPath).then(() => true).catch(() => false);
    if (!exists) {
      t.skip('~/.codex/auth.json이 존재하지 않는 환경이므로 건너뜁니다.');
      return;
    }

    const usage = await fetchUsage('slot1', { configDir: tempDir, codexAuthPath });
    assert.ok(usage);
    assert.ok(typeof usage.primaryWindow.usedPercent === 'number');
    assert.ok(usage.email);
    assert.ok(usage.planType);
  });
});
