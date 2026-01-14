// TeamSpirit Info Display - Content Script
// Displays attendance info on TeamSpirit home page

(function() {
  'use strict';

  // Only run in main frame
  if (window !== window.top) return;

  // Avoid running multiple times
  if (window.tsInfoDisplayInitialized) return;
  window.tsInfoDisplayInitialized = true;

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
    return new Promise((resolve) => {
      chrome.storage.local.get(['attendanceData', 'lastFetched'], (result) => {
        if (chrome.runtime.lastError) {
          console.log('TeamSpirit Info Display: Storage error', chrome.runtime.lastError);
          resolve(null);
          return;
        }
        resolve(result.attendanceData || null);
      });
    });
  }

  async function requestDataFetch() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'FETCH_ATTENDANCE_DATA' }, (response) => {
        if (chrome.runtime.lastError) {
          console.log('TeamSpirit Info Display: Message error', chrome.runtime.lastError);
          resolve(null);
          return;
        }
        resolve(response?.data || null);
      });
    });
  }

  async function loadData() {
    // First try to load from storage
    let data = await loadDataFromStorage();

    // If no data, request fetch from background
    if (!data) {
      data = await requestDataFetch();
    }

    cachedData = data;
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
    const punchAreaSelectors = [
      '.pw_base',
      '[class*="punch"]',
      '.empWorkArea',
      '#empWorkArea',
      '.slds-card'
    ];

    let punchArea = null;
    for (const selector of punchAreaSelectors) {
      punchArea = document.querySelector(selector);
      if (punchArea) break;
    }

    if (!punchArea) {
      retryCount++;
      if (retryCount < MAX_RETRIES) {
        setTimeout(findAndInjectPanel, CHECK_INTERVAL);
      }
      return;
    }

    if (document.getElementById('ts-info-display')) {
      return;
    }

    infoPanel = createInfoPanel();
    punchArea.style.display = 'inline-block';
    punchArea.style.verticalAlign = 'top';
    punchArea.insertAdjacentElement('afterend', infoPanel);

    // Load and display data
    loadData().then(() => {
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
      requestDataFetch().then(data => {
        if (data) {
          cachedData = data;
          updateDisplay();
        }
      });
    }, DATA_REFRESH_INTERVAL);

    console.log('TeamSpirit Info Display: Panel injected successfully');
  }

  // ==================== Initialization ====================

  function init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(findAndInjectPanel, 1000);
      });
    } else {
      setTimeout(findAndInjectPanel, 1000);
    }
  }

  init();

  // Handle SPA navigation
  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      retryCount = 0;
      infoPanel = null;
      cachedData = null;
      setTimeout(findAndInjectPanel, 1000);
    }
  }).observe(document, { subtree: true, childList: true });

  // Listen for storage changes
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.attendanceData) {
      cachedData = changes.attendanceData.newValue;
      updateDisplay();
    }
  });

})();
