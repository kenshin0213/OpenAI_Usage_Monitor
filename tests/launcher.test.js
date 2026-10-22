/**
 * tests/launcher.test.js
 * 
 * 윈도우 탐색기 직접 실행기(VBScript), 바로가기 생성기(create-shortcut.js),
 * 포터블 바이너리 패키징(build-portable.js) 모듈 단위 테스트
 */

const { describe, it, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  createShortcut,
  getDesktopPath,
  getDefaultTargetPath,
  ROOT_DIR,
} = require('../scripts/create-shortcut');

const {
  buildPortable,
  DIST_DIR,
  TARGET_DIR_NAME,
  TARGET_DIR,
  APP_EXE_NAME,
} = require('../scripts/build-portable');

describe('launcher.test.js - 윈도우 무창 실행기 및 바이너리 패키징 테스트', () => {
  let tempTestDir;

  beforeEach(() => {
    tempTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-test-'));
  });

  afterEach(() => {
    if (tempTestDir && fs.existsSync(tempTestDir)) {
      try {
        fs.rmSync(tempTestDir, { recursive: true, force: true });
      } catch (err) {
        // 임시 디렉터리 정리 실패 시 무시
      }
    }
  });

  describe('1. OpenAI_Usage_Monitor.vbs - 윈도우 탐색기 직접 무창 실행기 무결성', () => {
    const vbsPath = path.join(ROOT_DIR, 'OpenAI_Usage_Monitor.vbs');

    it('프로젝트 루트에 OpenAI_Usage_Monitor.vbs 파일이 존재해야 한다', () => {
      assert.strictEqual(fs.existsSync(vbsPath), true, 'OpenAI_Usage_Monitor.vbs 파일이 루트에 존재해야 합니다.');
    });

    it('VBScript 파일에 필수 WScript.Shell 및 Scripting.FileSystemObject가 정의되어 있어야 한다', () => {
      const content = fs.readFileSync(vbsPath, 'utf8');
      assert.match(content, /CreateObject\s*\(\s*"WScript\.Shell"\s*\)/i);
      assert.match(content, /CreateObject\s*\(\s*"Scripting\.FileSystemObject"\s*\)/i);
    });

    it('우선순위에 따른 바이너리 탐색 로직(dist -> node_modules -> 시스템 전역)이 포함되어야 한다', () => {
      const content = fs.readFileSync(vbsPath, 'utf8');
      assert.match(content, /OpenAI_Usage_Monitor-win32-x64\\OpenAI_Usage_Monitor\.exe/i);
      assert.match(content, /node_modules\\electron\\dist\\electron\.exe/i);
      assert.match(content, /electron \./i);
    });

    it('검은 콘솔창 없이 백그라운드로 실행되도록 0(WindowStyle) 및 False(비동기) 매개변수를 사용해야 한다', () => {
      const content = fs.readFileSync(vbsPath, 'utf8');
      // WshShell.Run runCommand, 0, False 패턴 검증
      assert.match(content, /WshShell\.Run\s+runCommand,\s*0,\s*False/i);
    });

    it('스크립트가 위치한 디렉터리를 작업 디렉터리로 설정해야 한다', () => {
      const content = fs.readFileSync(vbsPath, 'utf8');
      assert.match(content, /WshShell\.CurrentDirectory\s*=\s*strPath/i);
    });
  });

  describe('2. scripts/create-shortcut.js - 바탕화면 바로가기 생성기', () => {
    it('getDesktopPath는 유효하고 존재하는 바탕화면 경로를 반환해야 한다', () => {
      const desktop = getDesktopPath();
      assert.ok(typeof desktop === 'string' && desktop.length > 0);
      assert.strictEqual(fs.existsSync(desktop), true, '바탕화면 경로가 실제로 존재해야 합니다.');
    });

    it('getDefaultTargetPath는 존재하는 실행기 경로(.exe 또는 .vbs)를 반환해야 한다', () => {
      const target = getDefaultTargetPath();
      assert.ok(typeof target === 'string' && target.length > 0);
      assert.strictEqual(fs.existsSync(target), true, `실행 대상 파일이 존재해야 합니다: ${target}`);
      assert.ok(target.endsWith('.exe') || target.endsWith('.vbs'));
    });

    it('지정된 임시 디렉터리에 .lnk 바로가기 파일을 정상 생성해야 한다', () => {
      const shortcutResult = createShortcut({
        name: '테스트바로가기.lnk',
        destDir: tempTestDir,
        targetPath: path.join(ROOT_DIR, 'OpenAI_Usage_Monitor.vbs'),
        description: '단위 테스트용 바로가기',
      });

      assert.strictEqual(shortcutResult.success, true);
      assert.strictEqual(fs.existsSync(shortcutResult.shortcutPath), true);
      assert.ok(shortcutResult.shortcutPath.endsWith('테스트바로가기.lnk'));
    });

    it('.lnk 확장자가 누락된 경우 자동으로 .lnk를 추가해야 한다', () => {
      const shortcutResult = createShortcut({
        name: '확장자없는이름',
        destDir: tempTestDir,
      });

      assert.strictEqual(shortcutResult.success, true);
      assert.ok(shortcutResult.shortcutPath.endsWith('확장자없는이름.lnk'));
      assert.strictEqual(fs.existsSync(shortcutResult.shortcutPath), true);
    });
  });

  describe('3. scripts/build-portable.js - 독립 실행형 포터블 바이너리 패키징', () => {
    it('필수 패키징 상수 및 buildPortable 함수를 내보내야 한다', () => {
      assert.strictEqual(typeof buildPortable, 'function');
      assert.strictEqual(TARGET_DIR_NAME, 'OpenAI_Usage_Monitor-win32-x64');
      assert.strictEqual(APP_EXE_NAME, 'OpenAI_Usage_Monitor.exe');
      assert.ok(typeof ROOT_DIR === 'string');
      assert.ok(typeof DIST_DIR === 'string');
    });

    it('원본 바이너리 디렉터리가 존재하지 않으면 명확한 에러를 발생시켜야 한다', () => {
      const invalidSource = path.join(tempTestDir, 'non_existent_electron');
      assert.throws(
        () => {
          buildPortable({ sourceDistDir: invalidSource, targetDir: path.join(tempTestDir, 'out') });
        },
        /Electron 배포 바이너리 디렉터리를 찾을 수 없습니다/
      );
    });

    it('electron.exe가 없으면 명확한 에러를 발생시켜야 한다', () => {
      const fakeSource = path.join(tempTestDir, 'fake_electron');
      fs.mkdirSync(fakeSource, { recursive: true });
      assert.throws(
        () => {
          buildPortable({ sourceDistDir: fakeSource, targetDir: path.join(tempTestDir, 'out') });
        },
        /electron\.exe 원본 바이너리를 찾을 수 없습니다/
      );
    });

    it('모의 바이너리 구조를 바탕으로 OpenAI_Usage_Monitor.exe 및 resources/app 패키징을 정상 수행해야 한다', () => {
      // 가상 Electron 소스 디렉터리 구성
      const mockSource = path.join(tempTestDir, 'mock_electron_dist');
      fs.mkdirSync(mockSource, { recursive: true });
      fs.writeFileSync(path.join(mockSource, 'electron.exe'), 'MOCK_EXE_BINARY_DATA');
      fs.writeFileSync(path.join(mockSource, 'chrome_100_percent.pak'), 'MOCK_PAK_DATA');

      const mockTarget = path.join(tempTestDir, 'mock_output_dist');

      const result = buildPortable({
        sourceDistDir: mockSource,
        targetDir: mockTarget,
        rootDir: ROOT_DIR,
      });

      assert.strictEqual(result.success, true);

      // 1. OpenAI_Usage_Monitor.exe 파일이 존재하고 이름이 변경되었는지 확인
      const exePath = path.join(mockTarget, 'OpenAI_Usage_Monitor.exe');
      assert.strictEqual(fs.existsSync(exePath), true);
      assert.strictEqual(fs.existsSync(path.join(mockTarget, 'electron.exe')), false, '원래 electron.exe는 삭제/이름변경되어야 합니다.');

      // 2. resources/app 디렉터리 및 앱 소스가 복사되었는지 확인
      const appPackageJson = path.join(result.appDir, 'package.json');
      const appMainJs = path.join(result.appDir, 'src', 'main.js');
      const appIcon = path.join(result.appDir, 'assets', 'icon.ico');

      assert.strictEqual(fs.existsSync(appPackageJson), true);
      assert.strictEqual(fs.existsSync(appMainJs), true);
      assert.strictEqual(fs.existsSync(appIcon), true);
    });
  });

  describe('4. package.json 스크립트 및 메타데이터 무결성', () => {
    it('package.json에 build 및 shortcut 스크립트가 정의되어 있어야 한다', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
      assert.strictEqual(pkg.scripts.build, 'node scripts/build-portable.js');
      assert.strictEqual(pkg.scripts.shortcut, 'node scripts/create-shortcut.js');
    });

    it('package.json에 productName이 OpenAI_Usage_Monitor로 정의되어 있어야 한다', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
      assert.strictEqual(pkg.productName, 'OpenAI_Usage_Monitor');
    });
  });
});
