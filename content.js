// TeamSpirit Info Display - Content Script
// Displays attendance info on TeamSpirit home page

(function() {
  'use strict';

  // デバッグパネル
  let debugPanel = null;
  function createDebugPanel() {
    const panel = document.createElement('div');
    panel.id = 'ts-debug-panel';
    panel.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      width: 500px;
      max-height: 80vh;
      background: #1a1a1a;
      color: #0f0;
      font-family: monospace;
      font-size: 11px;
      padding: 10px;
      border-radius: 8px;
      z-index: 999999;
      overflow-y: auto;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    `;
    panel.innerHTML = '<div style="color:#fff;font-weight:bold;margin-bottom:8px;">🔍 TeamSpirit Info Display - Debug Log</div>';
    document.body.appendChild(panel);
    return panel;
  }

  function log(message, data = null) {
    const timestamp = new Date().toLocaleTimeString();
    const text = data !== null ? `${message} ${JSON.stringify(data)}` : message;
    console.log(`[TS-Info-Content ${timestamp}] ${text}`);

    // 画面にも表示
    if (!debugPanel && document.body) {
      debugPanel = createDebugPanel();
    }
    if (debugPanel) {
      const line = document.createElement('div');
      line.style.cssText = 'border-bottom: 1px solid #333; padding: 3px 0; word-break: break-all;';
      line.innerHTML = `<span style="color:#888">${timestamp}</span> ${text}`;
      debugPanel.appendChild(line);
      debugPanel.scrollTop = debugPanel.scrollHeight;
    }
  }

  log('Content script 開始');
  log('現在のURL: ' + window.location.href);
  log('メインフレーム: ' + (window === window.top));

  // Only run in main frame
  if (window !== window.top) {
    log('メインフレームではないため終了');
    return;
  }

  // 勤怠ページでは実行しない（無限ループ防止）
  if (window.location.href.includes('AtkWorkTimeTab')) {
    log('勤怠ページのため終了（データ取得用ページ）');
    return;
  }

  // Avoid running multiple times
  if (window.tsInfoDisplayInitialized) {
    log('既に初期化済みのため終了');
    return;
  }
  window.tsInfoDisplayInitialized = true;
  log('初期化フラグ設定完了');

  // Configuration
  const CHECK_INTERVAL = 2000;
  const MAX_RETRIES = 30;
  const DATA_REFRESH_INTERVAL = 60000; // Refresh data every 60 seconds

  let infoPanel = null;
  let retryCount = 0;
  let cachedData = null;

  // ==================== Utility Functions ====================

  function formatDuration(ms) {
    if (!ms || ms < 0) return '--:--:--';
    const totalSeconds = Math.floor(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function formatTimeShort(date) {
    if (!date) return '--:--';
    const h = String(date.getHours()).padStart(2, '0');
    const m = String(date.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }

  function parseTimeToMinutes(timeStr) {
    if (!timeStr || timeStr === '--:--') return null;
    const isNegative = timeStr.startsWith('-');
    const cleanTime = timeStr.replace('-', '');
    const parts = cleanTime.split(':');
    if (parts.length < 2) return null;
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    if (isNaN(hours) || isNaN(minutes)) return null;
    const totalMinutes = hours * 60 + minutes;
    return isNegative ? -totalMinutes : totalMinutes;
  }

  function formatMinutesToTime(totalMinutes) {
    if (totalMinutes === null || totalMinutes === undefined) return '--:--';
    const isNegative = totalMinutes < 0;
    const absMinutes = Math.abs(totalMinutes);
    const hours = Math.floor(absMinutes / 60);
    const minutes = absMinutes % 60;
    const timeStr = `${hours}:${String(minutes).padStart(2, '0')}`;
    return isNegative ? `-${timeStr}` : timeStr;
  }

  function parseTimeToDate(timeStr) {
    if (!timeStr || timeStr === '--:--') return null;
    const parts = timeStr.split(':');
    if (parts.length < 2) return null;
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    if (isNaN(hours) || isNaN(minutes)) return null;
    const date = new Date();
    date.setHours(hours, minutes, 0, 0);
    return date;
  }

  // ==================== Data Loading ====================

  async function loadDataFromStorage() {
    log('ストレージからデータ読み込み中...');
    return new Promise((resolve) => {
      chrome.storage.local.get(['attendanceData', 'lastFetched'], (result) => {
        if (chrome.runtime.lastError) {
          log('ストレージエラー:', chrome.runtime.lastError);
          resolve(null);
          return;
        }
        log('ストレージ結果:', result);
        if (result.attendanceData) {
          log('キャッシュデータ発見 (lastFetched: ' + new Date(result.lastFetched).toLocaleString() + ')');
        } else {
          log('キャッシュデータなし');
        }
        resolve(result.attendanceData || null);
      });
    });
  }

  async function requestDataFetch() {
    log('backgroundにデータ取得リクエスト送信中...');
    return new Promise((resolve) => {
      try {
        if (!chrome.runtime?.id) {
          log('拡張機能コンテキストが無効です。ページをリロードしてください。');
          resolve(null);
          return;
        }
        chrome.runtime.sendMessage({ type: 'FETCH_ATTENDANCE_DATA' }, (response) => {
          if (chrome.runtime.lastError) {
            log('メッセージエラー:', chrome.runtime.lastError.message);
            resolve(null);
            return;
          }
          log('backgroundからのレスポンス:', response);
          resolve(response?.data || null);
        });
      } catch (e) {
        log('sendMessageエラー:', e.message);
        resolve(null);
      }
    });
  }

  async function loadData() {
    log('===== データ読み込み開始 =====');

    // First try to load from storage
    let data = await loadDataFromStorage();

    // If no data, request fetch from background
    if (!data) {
      log('キャッシュなし - backgroundに取得リクエスト');
      data = await requestDataFetch();
    }

    cachedData = data;
    log('最終データ:', data);
    log('===== データ読み込み完了 =====');
    return data;
  }

  // ==================== UI Creation ====================

  function createInfoPanel() {
    const panel = document.createElement('div');
    panel.id = 'ts-info-display';
    panel.innerHTML = `
      <div class="info-header">勤怠情報</div>

      <div class="info-section">
        <div class="info-row">
          <span class="info-label">状態</span>
          <span class="status-badge not-started" id="ts-status-badge">読込中...</span>
        </div>
      </div>

      <div class="info-section" id="ts-time-section" style="display: none;">
        <div class="info-row">
          <span class="info-label">出勤時刻</span>
          <span class="info-value" id="ts-clock-in">--:--</span>
        </div>
        <div class="info-row" id="ts-clock-out-row" style="display: none;">
          <span class="info-label">退勤時刻</span>
          <span class="info-value" id="ts-clock-out">--:--</span>
        </div>
        <div class="info-row">
          <span class="info-label">勤務時間</span>
          <span class="info-value large" id="ts-working-time">--:--:--</span>
        </div>
        <div class="info-row" id="ts-target-row">
          <span class="info-label">目標退勤</span>
          <span class="info-value highlight" id="ts-target-time">--:--</span>
        </div>
      </div>

      <div class="info-divider" id="ts-divider" style="display: none;"></div>

      <div class="info-section" id="ts-summary-section" style="display: none;">
        <div class="summary-toggle" id="ts-summary-toggle">
          <span class="toggle-icon">▼</span>
          <span class="info-label">月間サマリー</span>
        </div>
        <div class="summary-content" id="ts-summary-content">
          <div class="info-row">
            <span class="info-label">所定労働時間</span>
            <span class="info-value" id="ts-scheduled-hours">--:--</span>
          </div>
          <div class="info-row">
            <span class="info-label">総労働時間</span>
            <span class="info-value" id="ts-total-hours">--:--</span>
          </div>
          <div class="info-row">
            <span class="info-label">過不足時間</span>
            <span class="info-value" id="ts-over-under">--:--</span>
          </div>
          <div class="info-row">
            <span class="info-label">残り勤務日数</span>
            <span class="info-value" id="ts-remaining-days">--日</span>
          </div>
          <div class="info-row">
            <span class="info-label">一日当たり必要</span>
            <span class="info-value highlight" id="ts-required-per-day">--:--</span>
          </div>
        </div>
      </div>
    `;

    // Add toggle functionality
    const toggle = panel.querySelector('#ts-summary-toggle');
    const content = panel.querySelector('#ts-summary-content');
    toggle.addEventListener('click', () => {
      toggle.classList.toggle('collapsed');
      content.classList.toggle('collapsed');
    });

    return panel;
  }

  // ==================== Display Update ====================

  function updateDisplay() {
    if (!infoPanel) return;

    const data = cachedData;

    const statusBadge = infoPanel.querySelector('#ts-status-badge');
    const timeSection = infoPanel.querySelector('#ts-time-section');
    const clockInEl = infoPanel.querySelector('#ts-clock-in');
    const clockOutRow = infoPanel.querySelector('#ts-clock-out-row');
    const clockOutEl = infoPanel.querySelector('#ts-clock-out');
    const workingTimeEl = infoPanel.querySelector('#ts-working-time');
    const targetRow = infoPanel.querySelector('#ts-target-row');
    const targetTimeEl = infoPanel.querySelector('#ts-target-time');
    const divider = infoPanel.querySelector('#ts-divider');
    const summarySection = infoPanel.querySelector('#ts-summary-section');

    if (!data) {
      statusBadge.textContent = '読込中...';
      statusBadge.className = 'status-badge not-started';
      return;
    }

    // Update status based on data
    if (data.isWorking && data.clockInTime) {
      statusBadge.textContent = '出勤中';
      statusBadge.className = 'status-badge working';
      timeSection.style.display = 'block';
      clockOutRow.style.display = 'none';
      targetRow.style.display = 'flex';

      clockInEl.textContent = data.clockInTime;

      // Calculate working time
      const clockInDate = parseTimeToDate(data.clockInTime);
      if (clockInDate) {
        const workingMs = Date.now() - clockInDate.getTime();
        workingTimeEl.textContent = formatDuration(workingMs);
      }

    } else if (data.clockOutTime && data.clockInTime) {
      statusBadge.textContent = '退勤済み';
      statusBadge.className = 'status-badge finished';
      timeSection.style.display = 'block';
      clockOutRow.style.display = 'flex';
      targetRow.style.display = 'none';

      clockInEl.textContent = data.clockInTime;
      clockOutEl.textContent = data.clockOutTime;

      // Calculate final working time
      const clockInDate = parseTimeToDate(data.clockInTime);
      const clockOutDate = parseTimeToDate(data.clockOutTime);
      if (clockInDate && clockOutDate) {
        const workingMs = clockOutDate.getTime() - clockInDate.getTime();
        workingTimeEl.textContent = formatDuration(workingMs);
      }

    } else {
      statusBadge.textContent = '未出勤';
      statusBadge.className = 'status-badge not-started';
      timeSection.style.display = 'none';
    }

    // Update summary
    const summary = data.summary;
    if (summary) {
      divider.style.display = 'block';
      summarySection.style.display = 'block';

      infoPanel.querySelector('#ts-scheduled-hours').textContent = summary.scheduledHours || '--:--';
      infoPanel.querySelector('#ts-total-hours').textContent = summary.totalHours || '--:--';

      const scheduledMinutes = parseTimeToMinutes(summary.scheduledHours);
      const totalMinutes = parseTimeToMinutes(summary.totalHours);
      const overUnderEl = infoPanel.querySelector('#ts-over-under');

      if (scheduledMinutes !== null && totalMinutes !== null) {
        let currentTotalMinutes = totalMinutes;
        if (data.isWorking && data.clockInTime) {
          const clockInDate = parseTimeToDate(data.clockInTime);
          if (clockInDate) {
            const todayWorkingMinutes = Math.floor((Date.now() - clockInDate.getTime()) / 60000);
            currentTotalMinutes += todayWorkingMinutes;
          }
        }

        const overUnderMinutes = currentTotalMinutes - scheduledMinutes;
        const overUnderStr = formatMinutesToTime(overUnderMinutes);
        overUnderEl.textContent = overUnderMinutes >= 0 ? `+${overUnderStr}` : overUnderStr;
        overUnderEl.className = `info-value ${overUnderMinutes >= 0 ? 'positive' : 'negative'}`;

        const scheduledDays = parseInt(summary.scheduledDays, 10);
        const actualDays = parseInt(summary.actualDays, 10);
        const remainingDaysEl = infoPanel.querySelector('#ts-remaining-days');
        const requiredPerDayEl = infoPanel.querySelector('#ts-required-per-day');

        if (!isNaN(scheduledDays) && !isNaN(actualDays)) {
          const remainingDays = scheduledDays - actualDays;
          remainingDaysEl.textContent = `${remainingDays}日`;

          if (remainingDays > 0) {
            const remainingMinutes = scheduledMinutes - currentTotalMinutes;
            if (remainingMinutes > 0) {
              const requiredMinutesPerDay = Math.ceil(remainingMinutes / remainingDays);
              requiredPerDayEl.textContent = formatMinutesToTime(requiredMinutesPerDay);
              requiredPerDayEl.className = 'info-value highlight';

              if (data.isWorking && data.clockInTime) {
                const clockInDate = parseTimeToDate(data.clockInTime);
                if (clockInDate) {
                  const breakMinutes = 60;
                  const targetMs = clockInDate.getTime() + (requiredMinutesPerDay + breakMinutes) * 60 * 1000;
                  const targetDate = new Date(targetMs);
                  targetTimeEl.textContent = formatTimeShort(targetDate);
                }
              }
            } else {
              requiredPerDayEl.textContent = '達成済み';
              requiredPerDayEl.className = 'info-value positive';
              targetTimeEl.textContent = '達成済み';
            }
          }
        }
      } else if (summary.overUnderHours) {
        overUnderEl.textContent = summary.overUnderHours;
        const isNegative = summary.overUnderHours.startsWith('-');
        overUnderEl.className = `info-value ${isNegative ? 'negative' : 'positive'}`;
      }
    } else {
      divider.style.display = 'none';
      summarySection.style.display = 'none';
    }
  }

  // ==================== Panel Injection ====================

  function findAndInjectPanel() {
    log('パネル挿入位置を検索中... (試行 ' + (retryCount + 1) + '/' + MAX_RETRIES + ')');

    const punchAreaSelectors = [
      '.pw_base',
      '[class*="punch"]',
      '.empWorkArea',
      '#empWorkArea',
      '.slds-card'
    ];

    let punchArea = null;
    for (const selector of punchAreaSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        log('セレクタ "' + selector + '" で要素発見');
        punchArea = el;
        break;
      }
    }

    if (!punchArea) {
      retryCount++;
      log('パネル挿入位置が見つかりません (リトライ ' + retryCount + '/' + MAX_RETRIES + ')');
      if (retryCount < MAX_RETRIES) {
        setTimeout(findAndInjectPanel, CHECK_INTERVAL);
      } else {
        log('最大リトライ回数に達しました - パネル挿入を断念');
      }
      return;
    }

    if (document.getElementById('ts-info-display')) {
      log('パネルは既に存在します');
      return;
    }

    log('パネルを作成・挿入中...');
    infoPanel = createInfoPanel();

    // 打刻エリアの右隣に配置（絶対位置）
    infoPanel.style.position = 'absolute';
    infoPanel.style.zIndex = '1000';

    // 打刻エリアの位置を取得して右に配置
    const rect = punchArea.getBoundingClientRect();
    const parentRect = punchArea.offsetParent?.getBoundingClientRect() || { left: 0, top: 0 };
    infoPanel.style.left = (rect.right - parentRect.left + 20) + 'px';
    infoPanel.style.top = (rect.top - parentRect.top) + 'px';

    // 親要素にposition: relativeがなければ設定
    if (punchArea.offsetParent) {
      const parentPos = getComputedStyle(punchArea.offsetParent).position;
      if (parentPos === 'static') {
        punchArea.offsetParent.style.position = 'relative';
      }
      punchArea.offsetParent.appendChild(infoPanel);
    } else {
      document.body.appendChild(infoPanel);
    }

    log('パネル挿入完了 - 位置: left=' + infoPanel.style.left + ', top=' + infoPanel.style.top);

    // Load and display data
    log('初期データ読み込み開始...');
    loadData().then(() => {
      log('初期データ読み込み完了 - 表示更新');
      updateDisplay();
    });

    // Update working time every second
    setInterval(() => {
      if (cachedData?.isWorking && cachedData?.clockInTime) {
        const workingTimeEl = infoPanel?.querySelector('#ts-working-time');
        const clockInDate = parseTimeToDate(cachedData.clockInTime);
        if (clockInDate && workingTimeEl) {
          const workingMs = Date.now() - clockInDate.getTime();
          workingTimeEl.textContent = formatDuration(workingMs);
        }
      }
    }, 1000);

    // Refresh data periodically
    setInterval(() => {
      log('定期データ更新開始...');
      requestDataFetch().then(data => {
        if (data) {
          log('定期データ更新完了');
          cachedData = data;
          updateDisplay();
        } else {
          log('定期データ更新: データなし');
        }
      });
    }, DATA_REFRESH_INTERVAL);

    log('===== パネル初期化完了 =====');
  }

  // ==================== Initialization ====================

  function init() {
    log('init() 開始 - readyState: ' + document.readyState);
    if (document.readyState === 'loading') {
      log('DOMContentLoaded待機中...');
      document.addEventListener('DOMContentLoaded', () => {
        log('DOMContentLoaded発火 - 1秒後にパネル挿入開始');
        setTimeout(findAndInjectPanel, 1000);
      });
    } else {
      log('DOM準備完了 - 1秒後にパネル挿入開始');
      setTimeout(findAndInjectPanel, 1000);
    }
  }

  init();

  // Handle SPA navigation
  log('SPA ナビゲーション監視を設定中...');
  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      log('URL変更検出: ' + lastUrl + ' -> ' + url);
      lastUrl = url;
      retryCount = 0;
      infoPanel = null;
      cachedData = null;
      setTimeout(findAndInjectPanel, 1000);
    }
  }).observe(document, { subtree: true, childList: true });
  log('SPA ナビゲーション監視設定完了');

  // Listen for storage changes
  log('ストレージ変更リスナー設定中...');
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.attendanceData) {
      log('ストレージ変更検出:', changes.attendanceData);
      cachedData = changes.attendanceData.newValue;
      updateDisplay();
    }
  });
  log('ストレージ変更リスナー設定完了');

  // Background scriptからのログを受信
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'DEBUG_LOG') {
      log(message.message, message.data);
    }
  });
  log('Backgroundログ受信リスナー設定完了');

  log('===== Content script 初期化完了 =====');

})();
