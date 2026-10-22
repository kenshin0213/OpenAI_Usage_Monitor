/**
 * scripts/build-portable.js
 * 
 * Windows x64 환경용 독립 실행형 포터블 바이너리 패키징 스크립트.
 * node_modules/electron/dist 바이너리를 기반으로
 * OpenAI_Usage_Monitor.exe 바이너리 및 resources/app 패키지를 구성합니다.
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const TARGET_DIR_NAME = 'OpenAI_Usage_Monitor-win32-x64';
const TARGET_DIR = path.join(DIST_DIR, TARGET_DIR_NAME);
const APP_EXE_NAME = 'OpenAI_Usage_Monitor.exe';

/**
 * 포터블 바이너리 패키징을 수행합니다.
 * 
 * @param {Object} [options]
 * @param {string} [options.sourceDistDir] Electron 바이너리 원본 디렉터리
 * @param {string} [options.targetDir] 패키징 대상 디렉터리
 * @param {string} [options.rootDir] 소스 프로젝트 루트 디렉터리
 * @param {boolean} [options.createRootHelper] 루트 디렉터리 내 편의 바로가기/도우미 생성 여부
 * @returns {{ success: boolean, targetDir: string, executablePath: string, appDir: string }}
 */
function buildPortable(options = {}) {
  const rootDir = options.rootDir || ROOT_DIR;
  const sourceDistDir = options.sourceDistDir || path.join(rootDir, 'node_modules', 'electron', 'dist');
  const targetDir = options.targetDir || TARGET_DIR;
  const executablePath = path.join(targetDir, APP_EXE_NAME);

  // 1. 원본 바이너리 존재 여부 검증
  if (!fs.existsSync(sourceDistDir)) {
    throw new Error(`Electron 배포 바이너리 디렉터리를 찾을 수 없습니다: ${sourceDistDir}`);
  }

  const electronExe = path.join(sourceDistDir, 'electron.exe');
  if (!fs.existsSync(electronExe)) {
    throw new Error(`electron.exe 원본 바이너리를 찾을 수 없습니다: ${electronExe}`);
  }

  // 2. 대상 디렉터리 초기화 및 생성
  let needFullCopy = true;
  if (fs.existsSync(targetDir)) {
    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
    } catch (err) {
      if (err.code === 'EBUSY' || err.code === 'EPERM') {
        console.warn('[포터블 빌더] 프로세스가 실행 중이어서 전체 디렉터리 삭제 대신 resources/app 소스 번들만 즉시 갱신합니다.');
        needFullCopy = false;
      } else {
        throw err;
      }
    }
  }

  if (needFullCopy) {
    fs.mkdirSync(targetDir, { recursive: true });

    // 3. Electron 바이너리 파일 복사 (default_app.asar 제외)
    fs.cpSync(sourceDistDir, targetDir, {
      recursive: true,
      filter: (source) => {
        const base = path.basename(source);
        if (base === 'default_app.asar') {
          return false;
        }
        return true;
      },
    });

    // 4. electron.exe -> OpenAI_Usage_Monitor.exe 이름 변경
    const targetElectronExe = path.join(targetDir, 'electron.exe');
    if (fs.existsSync(targetElectronExe)) {
      fs.renameSync(targetElectronExe, executablePath);
    } else if (!fs.existsSync(executablePath)) {
      throw new Error(`실행 파일 이름 변경 실패: ${targetElectronExe}가 존재하지 않습니다.`);
    }
  }

  // 5. resources/app 디렉터리 구성 및 앱 소스 복사
  const resourcesDir = path.join(targetDir, 'resources');
  const appDir = path.join(resourcesDir, 'app');
  fs.mkdirSync(appDir, { recursive: true });

  // package.json 복사
  const packageJsonPath = path.join(rootDir, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    fs.copyFileSync(packageJsonPath, path.join(appDir, 'package.json'));
  }

  // src/ 복사
  const srcDir = path.join(rootDir, 'src');
  if (fs.existsSync(srcDir)) {
    fs.cpSync(srcDir, path.join(appDir, 'src'), { recursive: true });
  }

  // assets/ 복사
  const assetsDir = path.join(rootDir, 'assets');
  if (fs.existsSync(assetsDir)) {
    fs.cpSync(assetsDir, path.join(appDir, 'assets'), { recursive: true });
  }

  // 6. 결과 검증
  if (!fs.existsSync(executablePath)) {
    throw new Error(`최종 실행 바이너리가 생성되지 않았습니다: ${executablePath}`);
  }
  const appMainJs = path.join(appDir, 'src', 'main.js');
  if (!fs.existsSync(appMainJs)) {
    throw new Error(`앱 진입점(src/main.js)이 패키징되지 않았습니다: ${appMainJs}`);
  }

  return {
    success: true,
    targetDir,
    executablePath,
    appDir,
  };
}

if (require.main === module) {
  try {
    const startTime = Date.now();
    console.log('[포터블 빌더] OpenAI_Usage_Monitor 독립 실행형 바이너리 패키징을 시작합니다...');
    const result = buildPortable();
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[포터블 빌더] 패키징이 성공적으로 완료되었습니다 (${duration}초):`);
    console.log(`  - 바이너리 경로: ${result.executablePath}`);
    console.log(`  - 패키지 디렉터리: ${result.targetDir}`);
    console.log(`  - 앱 번들 디렉터리: ${result.appDir}`);
    console.log(`  - 윈도우 작업 관리자 프로세스명: ${APP_EXE_NAME}`);
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'EPERM') {
      console.error('[포터블 빌더] 오류 발생: 기존 프로세스가 실행 중일 수 있습니다. 실행 중인 OpenAI_Usage_Monitor.exe를 종료한 후 다시 시도해 주세요.');
    } else {
      console.error(`[포터블 빌더] 오류 발생: ${err.message}`);
    }
    process.exit(1);
  }
}

module.exports = {
  buildPortable,
  ROOT_DIR,
  DIST_DIR,
  TARGET_DIR_NAME,
  TARGET_DIR,
  APP_EXE_NAME,
};
