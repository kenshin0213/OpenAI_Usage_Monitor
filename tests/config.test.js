/**
 * tests/config.test.js
 * 
 * 계정 슬롯 저장소 및 애플리케이션 설정 모듈 단위 테스트
 */

const { describe, it, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const {
  getConfig,
  updateConfig,
  getSlot,
  saveSlot,
  clearSlot,
  seedSlot1FromCodex,
  setConfigDir,
  resetConfigDir,
  normalizeSlotId,
  DEFAULT_CONFIG,
  getSlots,
  addSlot,
  removeSlot,
  logoutSlot,
} = require('../src/config');

describe('config.js - 계정 슬롯 및 설정 관리자', () => {
  let tempDir;

  beforeEach(async () => {
    // 임시 디렉터리 생성 및 설정 디렉터리로 지정
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openai-usage-test-'));
    setConfigDir(tempDir);
  });

  afterEach(async () => {
    resetConfigDir();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe('normalizeSlotId', () => {
    it('1, "1", "slot1"을 "slot1"로 정상 정규화해야 한다', () => {
      assert.strictEqual(normalizeSlotId(1), 'slot1');
      assert.strictEqual(normalizeSlotId('1'), 'slot1');
      assert.strictEqual(normalizeSlotId('slot1'), 'slot1');
      assert.strictEqual(normalizeSlotId('SLOT1'), 'slot1');
    });

    it('2, "2", "slot2"를 "slot2"로 정상 정규화해야 한다', () => {
      assert.strictEqual(normalizeSlotId(2), 'slot2');
      assert.strictEqual(normalizeSlotId('2'), 'slot2');
      assert.strictEqual(normalizeSlotId('slot2'), 'slot2');
      assert.strictEqual(normalizeSlotId('SLOT2'), 'slot2');
    });

    it('3, "3", "slot3" 등 임의의 N번 슬롯도 "slotN"으로 정상 정규화해야 한다', () => {
      assert.strictEqual(normalizeSlotId(3), 'slot3');
      assert.strictEqual(normalizeSlotId('3'), 'slot3');
      assert.strictEqual(normalizeSlotId('slot3'), 'slot3');
      assert.strictEqual(normalizeSlotId('SLOT3'), 'slot3');
    });

    it('지원되지 않는 슬롯 ID는 예외를 발생시켜야 한다', () => {
      assert.throws(() => normalizeSlotId('slot0'), /유효하지 않은 슬롯 ID/);
      assert.throws(() => normalizeSlotId('invalid'), /유효하지 않은 슬롯 ID/);
      assert.throws(() => normalizeSlotId(0), /유효하지 않은 슬롯 ID/);
      assert.throws(() => normalizeSlotId(-1), /유효하지 않은 슬롯 ID/);
      assert.throws(() => normalizeSlotId(null), /유효하지 않은 슬롯 ID/);
    });
  });

  describe('getConfig & updateConfig', () => {
    it('설정 파일이 없을 때 기본 설정값을 반환해야 한다', async () => {
      const config = await getConfig();
      assert.deepStrictEqual(config, DEFAULT_CONFIG);
      assert.strictEqual(config.pollIntervalMinutes, 5);
      assert.strictEqual(config.alertThresholdPercent, 10);
      assert.strictEqual(config.notifyOnThreshold, true);
      assert.strictEqual(config.notifyOnReset, true);
    });

    it('updateConfig를 통해 설정을 갱신하고 파일에 영속화해야 한다', async () => {
      const updated = await updateConfig({
        pollIntervalMinutes: 10,
        alertThresholdPercent: 15,
      });

      assert.strictEqual(updated.pollIntervalMinutes, 10);
      assert.strictEqual(updated.alertThresholdPercent, 15);
      assert.strictEqual(updated.notifyOnThreshold, true); // 기존 기본값 유지

      // 디스크에서 다시 읽어와 검증
      const reloaded = await getConfig();
      assert.strictEqual(reloaded.pollIntervalMinutes, 10);
      assert.strictEqual(reloaded.alertThresholdPercent, 15);
      assert.strictEqual(reloaded.notifyOnThreshold, true);
    });

    it('잘못된 입력값에 대해서도 안전하게 동작해야 한다', async () => {
      await assert.rejects(
        async () => updateConfig(null),
        /갱신할 설정 객체가 유효하지 않습니다/
      );
    });
  });

  describe('getSlot & saveSlot (세션 격리성 검증)', () => {
    it('초기 상태에서는 슬롯 데이터가 null을 반환해야 한다', async () => {
      const slot1 = await getSlot('slot1');
      const slot2 = await getSlot('slot2');
      assert.strictEqual(slot1, null);
      assert.strictEqual(slot2, null);
    });

    it('slot1에 저장해도 slot2는 완전히 격리되어 null이어야 한다', async () => {
      const mockSlot1Data = {
        tokens: {
          access_token: 'token_slot_1',
          refresh_token: 'refresh_slot_1',
          account_id: 'acc_1',
        },
        auth_mode: 'chatgpt',
        email: 'user1@example.com',
      };

      await saveSlot('slot1', mockSlot1Data);

      const slot1 = await getSlot('slot1');
      const slot2 = await getSlot('slot2');

      assert.ok(slot1);
      assert.strictEqual(slot1.tokens.access_token, 'token_slot_1');
      assert.strictEqual(slot1.email, 'user1@example.com');
      assert.strictEqual(slot2, null, 'slot1 저장 시 slot2는 영향을 받지 않아야 함');
    });

    it('slot1과 slot2를 각각 독립적으로 저장하고 조회할 수 있어야 한다', async () => {
      const mockSlot1 = {
        tokens: { access_token: 'token_1', refresh_token: 'ref_1' },
        email: 'slot1@example.com',
      };
      const mockSlot2 = {
        tokens: { access_token: 'token_2', refresh_token: 'ref_2' },
        email: 'slot2@example.com',
      };

      await saveSlot('slot1', mockSlot1);
      await saveSlot('slot2', mockSlot2);

      const slot1 = await getSlot('slot1');
      const slot2 = await getSlot('slot2');

      assert.strictEqual(slot1.tokens.access_token, 'token_1');
      assert.strictEqual(slot1.email, 'slot1@example.com');

      assert.strictEqual(slot2.tokens.access_token, 'token_2');
      assert.strictEqual(slot2.email, 'slot2@example.com');
    });

    it('saveSlot은 기존 슬롯 데이터를 보존하며 부분 업데이트(merge)를 수행해야 한다', async () => {
      await saveSlot('slot1', {
        tokens: { access_token: 'token_orig', refresh_token: 'ref_orig' },
        email: 'orig@example.com',
      });

      // 사용량 지표만 업데이트
      await saveSlot('slot1', {
        usage: {
          primaryRemainingPercent: 85,
          secondaryRemainingPercent: 90,
        },
      });

      const updated = await getSlot('slot1');
      assert.strictEqual(updated.tokens.access_token, 'token_orig');
      assert.strictEqual(updated.email, 'orig@example.com');
      assert.strictEqual(updated.usage.primaryRemainingPercent, 85);
    });

    it('saveSlot에 overwrite: true 지정 시 기존 데이터를 덮어써야 한다', async () => {
      await saveSlot('slot1', {
        tokens: { access_token: 'token_old' },
        email: 'old@example.com',
      });

      await saveSlot(
        'slot1',
        {
          tokens: { access_token: 'token_new' },
        },
        { overwrite: true }
      );

      const updated = await getSlot('slot1');
      assert.strictEqual(updated.tokens.access_token, 'token_new');
      assert.strictEqual(updated.email, undefined);
    });

    it('clearSlot 호출 시 지정된 슬롯만 제거되고 다른 슬롯은 유지되어야 한다', async () => {
      await saveSlot('slot1', { email: 'slot1@example.com' });
      await saveSlot('slot2', { email: 'slot2@example.com' });

      await clearSlot('slot1');

      assert.strictEqual(await getSlot('slot1'), null);
      const slot2 = await getSlot('slot2');
      assert.ok(slot2);
      assert.strictEqual(slot2.email, 'slot2@example.com');
    });
  });

  describe('seedSlot1FromCodex (PC 세션 자동 복사 검증)', () => {
    it('유효한 ~/.codex/auth.json 파일로부터 slot1으로 토큰 및 이메일을 자동 임포트해야 한다', async () => {
      // JWT mock 생성 (payload: { email: "dt.infra1009@gmail.com" })
      const headerB64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64');
      const payloadB64 = Buffer.from(JSON.stringify({ email: 'dt.infra1009@gmail.com' })).toString('base64');
      const mockIdToken = `${headerB64}.${payloadB64}.fake_signature`;

      const mockCodexAuth = {
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
          id_token: mockIdToken,
          access_token: 'mock_access_token_123',
          refresh_token: 'mock_refresh_token_456',
          account_id: 'mock_account_id_789',
        },
        last_refresh: '2026-10-16T21:17:36.820Z',
      };

      const mockCodexPath = path.join(tempDir, 'mock-codex-auth.json');
      await fs.writeFile(mockCodexPath, JSON.stringify(mockCodexAuth, null, 2), 'utf8');

      const result = await seedSlot1FromCodex({ codexAuthPath: mockCodexPath });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.slot.email, 'dt.infra1009@gmail.com');
      assert.strictEqual(result.slot.tokens.access_token, 'mock_access_token_123');
      assert.strictEqual(result.slot.tokens.refresh_token, 'mock_refresh_token_456');

      // slot1 저장소 검증
      const savedSlot1 = await getSlot('slot1');
      assert.ok(savedSlot1);
      assert.strictEqual(savedSlot1.email, 'dt.infra1009@gmail.com');
      assert.strictEqual(savedSlot1.tokens.refresh_token, 'mock_refresh_token_456');

      // slot2는 영향이 없어야 함
      const slot2 = await getSlot('slot2');
      assert.strictEqual(slot2, null);
    });

    it('codex auth 파일이 존재하지 않는 경우 실패 결과를 반환해야 한다', async () => {
      const nonExistentPath = path.join(tempDir, 'does-not-exist.json');
      const result = await seedSlot1FromCodex({ codexAuthPath: nonExistentPath });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, 'codex_auth_not_found');
      assert.strictEqual(await getSlot('slot1'), null);
    });

    it('이미 slot1에 토큰이 존재할 경우 force 옵션 없이는 덮어쓰지 않아야 한다', async () => {
      await saveSlot('slot1', {
        tokens: { access_token: 'existing_token' },
        email: 'existing@example.com',
      });

      const mockCodexPath = path.join(tempDir, 'mock-codex-auth.json');
      await fs.writeFile(
        mockCodexPath,
        JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'new_token' } }),
        'utf8'
      );

      const result = await seedSlot1FromCodex({ codexAuthPath: mockCodexPath, force: false });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, 'already_exists');

      const slot1 = await getSlot('slot1');
      assert.strictEqual(slot1.tokens.access_token, 'existing_token');
    });

    it('force: true 옵션 전달 시 기존 slot1을 덮어써야 한다', async () => {
      await saveSlot('slot1', {
        tokens: { access_token: 'existing_token' },
        email: 'existing@example.com',
      });

      const mockCodexPath = path.join(tempDir, 'mock-codex-auth.json');
      await fs.writeFile(
        mockCodexPath,
        JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'new_token' } }),
        'utf8'
      );

      const result = await seedSlot1FromCodex({ codexAuthPath: mockCodexPath, force: true });

      assert.strictEqual(result.success, true);
      const slot1 = await getSlot('slot1');
      assert.strictEqual(slot1.tokens.access_token, 'new_token');
    });
  });

  describe('동적 슬롯 관리 및 로그아웃, 테마 설정', () => {
    test('getSlots returns default [slot1, slot2] if slots not set', async () => {
      const slots = await getSlots();
      assert.deepStrictEqual(slots, ['slot1', 'slot2']);
    });

    test('addSlot appends a new slot and initializes empty slot file', async () => {
      const result = await addSlot();
      assert.strictEqual(result.slotId, 'slot3');
      assert.deepStrictEqual(result.slots, ['slot1', 'slot2', 'slot3']);
      const slot3Data = await getSlot('slot3');
      assert.strictEqual(slot3Data.linked, false);
    });

    test('removeSlot deletes specified slot when > 2 slots exist', async () => {
      await addSlot(); // slot3
      const res = await removeSlot('slot3');
      assert.strictEqual(res.success, true);
      const slots = await getSlots();
      assert.strictEqual(slots.includes('slot3'), false);
    });

    test('removeSlot fails when trying to delete when <= 2 slots exist', async () => {
      await assert.rejects(
        async () => removeSlot('slot1'),
        /최소 2개 이상 유지되어야 합니다/
      );
    });

    test('removeSlot fails when trying to delete non-existent slot', async () => {
      await addSlot(); // slot3
      await assert.rejects(
        async () => removeSlot('slot99'),
        /존재하지 않는 슬롯입니다/
      );
    });

    test('logoutSlot clears tokens and resets slot to unlinked', async () => {
      await saveSlot('slot1', { email: 'test@example.com', tokens: { access_token: 'abc' } });
      const result = await logoutSlot('slot1');
      assert.strictEqual(result.success, true);
      const slot = await getSlot('slot1');
      assert.strictEqual(slot.linked, false);
      assert.strictEqual(slot.email, null);
      assert.strictEqual(slot.tokens, null);
    });

    test('logoutSlot removes auth.json from profiles directory', async () => {
      const { getSlotCodexHome } = require('../src/auth');
      const slotHome = getSlotCodexHome('slot1', { configDir: tempDir });
      await fs.mkdir(slotHome, { recursive: true });
      const authPath = path.join(slotHome, 'auth.json');
      await fs.writeFile(authPath, JSON.stringify({ tokens: { access_token: '123' } }));

      await saveSlot('slot1', { email: 'test@example.com' });
      await logoutSlot('slot1');

      let exists = true;
      try {
        await fs.access(authPath);
      } catch {
        exists = false;
      }
      assert.strictEqual(exists, false);
    });

    test('updateConfig saves theme: "light" properly', async () => {
      const cfg = await updateConfig({ theme: 'light' });
      assert.strictEqual(cfg.theme, 'light');
    });
  });
});
