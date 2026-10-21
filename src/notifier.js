/**
 * src/notifier.js
 * 
 * 데스크톱 토스트 알림 서비스 모듈
 * 
 * 주요 기능:
 * 1. Electron 런타임 환경 감지 시 Electron의 네이티브 Notification API 사용
 * 2. 일반 Node.js 환경(Windows)에서는 PowerShell 윈도우 런타임 토스트 API 폴백 지원
 * 3. 단위 테스트 및 커스텀 발송자 주입을 위한 setNotificationSender 제공
 * 4. 발송 이력 추적 및 안전한 에러 핸들링
 */

const { execFile } = require('child_process');
const path = require('path');

/**
 * 테스트 및 커스텀 발송자 주입용 변수
 */
let customSender = null;

/**
 * 발송된 알림 기록 (최대 50건 유지)
 */
const notificationHistory = [];

/**
 * 커스텀 알림 발송자를 설정합니다 (테스트용 mock 등).
 * @param {Function|null} senderFn (payload) => Promise<{ success: boolean, provider?: string }>
 */
function setNotificationSender(senderFn) {
  customSender = senderFn;
}

/**
 * 커스텀 알림 발송자를 기본값으로 리셋합니다.
 */
function resetNotificationSender() {
  customSender = null;
}

/**
 * 가장 최근에 발송된 알림 페이로드를 반환합니다.
 * @returns {object|null}
 */
function getLastNotification() {
  return notificationHistory.length > 0
    ? notificationHistory[notificationHistory.length - 1]
    : null;
}

/**
 * 알림 발송 이력 전체를 반환합니다.
 * @returns {Array<object>}
 */
function getNotificationHistory() {
  return [...notificationHistory];
}

/**
 * 알림 발송 이력을 초기화합니다.
 */
function clearNotificationHistory() {
  notificationHistory.length = 0;
}

/**
 * PowerShell을 통해 Windows 10/11 네이티브 토스트 알림을 발송합니다.
 * 특수문자 및 유니코드 왜곡을 방지하기 위해 Base64 인코딩을 거쳐 전달합니다.
 * 
 * @param {string} title 알림 제목
 * @param {string} body 알림 본문
 * @returns {Promise<{ success: boolean, provider: string, error?: string }>}
 */
function sendPowerShellToast(title, body) {
  return new Promise((resolve) => {
    const encodedTitle = Buffer.from(title || '알림', 'utf8').toString('base64');
    const encodedBody = Buffer.from(body || '', 'utf8').toString('base64');

    const psScript = [
      `[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]`,
      `$title = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedTitle}'))`,
      `$body = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedBody}'))`,
      `$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)`,
      `$xml = [xml]$template.GetXml()`,
      `$nodes = $xml.GetElementsByTagName('text')`,
      `[void]$nodes[0].AppendChild($xml.CreateTextNode($title))`,
      `[void]$nodes[1].AppendChild($xml.CreateTextNode($body))`,
      `$toast = [Windows.UI.Notifications.ToastNotification]::new($template)`,
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('OpenAI Usage Monitor').Show($toast)`,
    ].join('; ');

    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
      windowsHide: true,
      timeout: 5000,
    }, (err) => {
      if (err) {
        resolve({ success: false, provider: 'powershell', error: err.message });
      } else {
        resolve({ success: true, provider: 'powershell' });
      }
    });
  });
}

/**
 * 데스크톱 토스트 알림을 발송합니다.
 * 
 * 1. customSender가 설정되어 있으면 해당 함수 호출
 * 2. Electron 환경인 경우 new Notification(...).show() 실행
 * 3. Windows 환경인 경우 PowerShell Toast 발송
 * 4. 기타 환경에서는 콘솔 폴백
 * 
 * @param {object} payload
 * @param {string} payload.title 알림 제목
 * @param {string} payload.body 알림 본문
 * @param {string} [payload.icon] 아이콘 경로
 * @param {boolean} [payload.silent=false] 무음 여부
 * @param {object} [options]
 * @param {Function} [options.sender] 일회성 발송자 지정
 * @returns {Promise<{ success: boolean, provider?: string, error?: string }>}
 */
async function sendNotification(payload, options = {}) {
  const safePayload = {
    title: payload?.title || 'ChatGPT 사용량 모니터',
    body: payload?.body || '',
    icon: payload?.icon || path.join(__dirname, '..', 'assets', 'icon.png'),
    silent: Boolean(payload?.silent),
    sentAt: new Date().toISOString(),
  };

  // 이력 저장 (최대 50개 유지)
  notificationHistory.push(safePayload);
  if (notificationHistory.length > 50) {
    notificationHistory.shift();
  }

  try {
    // 1. 일회성 옵션 또는 전역 주입된 커스텀 발송자 우선 처리
    const sender = options.sender || customSender;
    if (typeof sender === 'function') {
      return await sender(safePayload);
    }

    // 2. Electron 환경 감지 시 Electron의 Notification API 사용
    if (process.versions && process.versions.electron) {
      try {
        const { Notification } = require('electron');
        if (Notification && (typeof Notification.isSupported !== 'function' || Notification.isSupported())) {
          const notif = new Notification({
            title: safePayload.title,
            body: safePayload.body,
            icon: safePayload.icon,
            silent: safePayload.silent,
          });
          notif.show();
          return { success: true, provider: 'electron' };
        }
      } catch (electronErr) {
        // electron require 실패 시 아래 폴백으로 진행
      }
    }

    // 3. Windows 환경 폴백 (PowerShell 토스트)
    if (process.platform === 'win32') {
      return await sendPowerShellToast(safePayload.title, safePayload.body);
    }

    // 4. 일반 터미널 / 기타 OS 기본 성공 처리
    return { success: true, provider: 'fallback' };
  } catch (err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

module.exports = {
  sendNotification,
  setNotificationSender,
  resetNotificationSender,
  getLastNotification,
  getNotificationHistory,
  clearNotificationHistory,
  sendPowerShellToast,
};
