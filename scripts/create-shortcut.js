/**
 * scripts/create-shortcut.js
 * 
 * Windows 바탕화면 또는 지정된 디렉터리에
 * "OpenAI 사용량 모니터" 바로가기 파일(.lnk)을 생성합니다.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// 프로젝트 루트 경로
const ROOT_DIR = path.resolve(__dirname, '..');

/**
 * Windows 바탕화면 디렉터리 경로를 확인합니다.
 * @returns {string} 바탕화면 절대 경로
 */
function getDesktopPath() {
  try {
    const script = '[Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop)';
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status === 0 && result.stdout && result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch (err) {
    // PowerShell 실패 시 폴백 진행
  }

  // 환경 변수 기반 폴백
  if (process.env.USERPROFILE) {
    const fallbackPath = path.join(process.env.USERPROFILE, 'Desktop');
    if (fs.existsSync(fallbackPath)) {
      return fallbackPath;
    }
  }

  // os.homedir() 폴백
  const os = require('os');
  return path.join(os.homedir(), 'Desktop');
}

/**
 * 기본 대상 실행 파일 경로를 탐색합니다.
 * 1. dist/OpenAI_Usage_Monitor-win32-x64/OpenAI_Usage_Monitor.exe (빌드된 경우)
 * 2. OpenAI_Usage_Monitor.vbs (탐색기 무음 실행기)
 * @returns {string} 대상 파일 절대 경로
 */
function getDefaultTargetPath() {
  const builtExe = path.join(ROOT_DIR, 'dist', 'OpenAI_Usage_Monitor-win32-x64', 'OpenAI_Usage_Monitor.exe');
  if (fs.existsSync(builtExe)) {
    return builtExe;
  }
  return path.join(ROOT_DIR, 'OpenAI_Usage_Monitor.vbs');
}

/**
 * 바로가기(.lnk) 파일을 생성합니다.
 * 
 * @param {Object} [options]
 * @param {string} [options.name] 바로가기 파일명 (기본값: 'OpenAI 사용량 모니터.lnk')
 * @param {string} [options.destDir] 바로가기가 생성될 대상 폴더 (기본값: 사용자 바탕화면)
 * @param {string} [options.targetPath] 실행 대상 파일 경로
 * @param {string} [options.workingDir] 작업 디렉터리 (기본값: 프로젝트 루트)
 * @param {string} [options.iconPath] 아이콘 파일 경로 (기본값: assets/icon.ico)
 * @param {string} [options.description] 바로가기 설명 문구
 * @returns {{ success: boolean, shortcutPath: string, targetPath: string, iconPath: string }}
 */
function createShortcut(options = {}) {
  const name = options.name || 'OpenAI 사용량 모니터.lnk';
  const destDir = options.destDir || getDesktopPath();
  const targetPath = path.resolve(options.targetPath || getDefaultTargetPath());
  const workingDir = path.resolve(options.workingDir || ROOT_DIR);
  const iconPath = path.resolve(options.iconPath || path.join(ROOT_DIR, 'assets', 'icon.ico'));
  const description = options.description || 'OpenAI 사용량 모니터 (Windows 트레이)';

  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const shortcutPath = path.join(destDir, name.endsWith('.lnk') ? name : `${name}.lnk`);

  // PowerShell WScript.Shell COM 객체를 활용한 바로가기 생성
  const psScript = `
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')
$Shortcut.TargetPath = '${targetPath.replace(/'/g, "''")}'
$Shortcut.WorkingDirectory = '${workingDir.replace(/'/g, "''")}'
$Shortcut.IconLocation = '${iconPath.replace(/'/g, "''")},0'
$Shortcut.Description = '${description.replace(/'/g, "''")}'
$Shortcut.Save()
`;

  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.status !== 0) {
    const errorMsg = result.stderr ? result.stderr.trim() : `종료 코드 ${result.status}`;
    throw new Error(`바로가기 생성 실패: ${errorMsg}`);
  }

  if (!fs.existsSync(shortcutPath)) {
    throw new Error(`바로가기 파일이 디스크에 생성되지 않았습니다: ${shortcutPath}`);
  }

  return {
    success: true,
    shortcutPath,
    targetPath,
    iconPath,
  };
}

if (require.main === module) {
  try {
    console.log('[바로가기 생성기] 바탕화면 바로가기 생성을 시작합니다...');
    const result = createShortcut();
    console.log('[바로가기 생성기] 바로가기가 성공적으로 생성되었습니다:');
    console.log(`  - 바로가기 위치: ${result.shortcutPath}`);
    console.log(`  - 실행 대상: ${result.targetPath}`);
    console.log(`  - 아이콘: ${result.iconPath}`);
  } catch (err) {
    console.error(`[바로가기 생성기] 오류 발생: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  createShortcut,
  getDesktopPath,
  getDefaultTargetPath,
  ROOT_DIR,
};
