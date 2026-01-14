// TeamSpirit Info Display - Content Script
// Injects working time and summary info into TeamSpirit home page
// Reads data from chrome.storage.local (shared with TeamSpirit Quick Punch extension)

(function() {
  'use strict';

  // Only run in main frame
  if (window !== window.top) return;

  // Avoid running multiple times
  if (window.tsInfoDisplayInitialized) return;
  window.tsInfoDisplayInitialized = true;

  // Configuration
  const CHECK_INTERVAL = 2000;
  const UPDATE_INTERVAL = 1000;
  const MAX_RETRIES = 30;

  let infoPanel = null;
  let updateTimer = null;
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

  function isToday(timestamp) {
    if (!timestamp) return false;
    const date = new Date(timestamp);
    const today = new Date();
    return date.getFullYear() === today.getFullYear() &&
           date.getMonth() === today.getMonth() &&
           date.getDate() === today.getDate();
  }

  // ==================== Data Loading ====================

  async function loadDataFromStorage() {
    return new Promise((resolve) => {
      chrome.storage.local.get([
        'clockInTimestamp',
        'clockOutTimestamp',
        'hasClockedOut',
        'workSummary'
      ], (result) => {
        if (chrome.runtime.lastError) {
          console.log('TeamSpirit Info Display: Storage error', chrome.runtime.lastError);
          resolve(null);
          return;
        }

        // Check if data is from today
        if (result.clockInTimestamp && isToday(result.clockInTimestamp)) {
          cachedData = {
            clockInTimestamp: result.clockInTimestamp,
            clockOutTimestamp: result.clockOutTimestamp || null,
            hasClockedOut: result.hasClockedOut || false,
            isWorking: !!(result.clockInTimestamp && !result.hasClockedOut),
            summary: result.workSummary || null
          };
        } else {
          cachedData = {
            clockInTimestamp: null,
            clockOutTimestamp: null,
            hasClockedOut: false,
            isWorking: false,
            summary: result.workSummary || null
          };
        }

        resolve(cachedData);
      });
    });
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

  async function updateDisplay() {
    if (!infoPanel) return;

    // Load fresh data from storage
    await loadDataFromStorage();
    const data = cachedData;

    if (!data) {
      console.log('TeamSpirit Info Display: No data available');
      return;
    }

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

    // Update status based on data
    if (data.isWorking && data.clockInTimestamp) {
      statusBadge.textContent = '出勤中';
      statusBadge.className = 'status-badge working';
      timeSection.style.display = 'block';
      clockOutRow.style.display = 'none';
      targetRow.style.display = 'flex';

      // Show clock-in time
      const clockInDate = new Date(data.clockInTimestamp);
      clockInEl.textContent = formatTimeShort(clockInDate);

      // Calculate working time
      const workingMs = Date.now() - data.clockInTimestamp;
      workingTimeEl.textContent = formatDuration(workingMs);

    } else if (data.hasClockedOut && data.clockInTimestamp && data.clockOutTimestamp) {
      statusBadge.textContent = '退勤済み';
      statusBadge.className = 'status-badge finished';
      timeSection.style.display = 'block';
      clockOutRow.style.display = 'flex';
      targetRow.style.display = 'none';

      // Show clock-in/out times
      const clockInDate = new Date(data.clockInTimestamp);
      const clockOutDate = new Date(data.clockOutTimestamp);
      clockInEl.textContent = formatTimeShort(clockInDate);
      clockOutEl.textContent = formatTimeShort(clockOutDate);

      // Calculate final working time
      const workingMs = data.clockOutTimestamp - data.clockInTimestamp;
      workingTimeEl.textContent = formatDuration(workingMs);

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

      // Calculate over/under
      const scheduledMinutes = parseTimeToMinutes(summary.scheduledHours);
      const totalMinutes = parseTimeToMinutes(summary.totalHours);
      const overUnderEl = infoPanel.querySelector('#ts-over-under');

      if (scheduledMinutes !== null && totalMinutes !== null) {
        // Add today's working time if currently working
        let currentTotalMinutes = totalMinutes;
        if (data.isWorking && data.clockInTimestamp) {
          const todayWorkingMinutes = Math.floor((Date.now() - data.clockInTimestamp) / 60000);
          currentTotalMinutes += todayWorkingMinutes;
        }

        const overUnderMinutes = currentTotalMinutes - scheduledMinutes;
        const overUnderStr = formatMinutesToTime(overUnderMinutes);
        overUnderEl.textContent = overUnderMinutes >= 0 ? `+${overUnderStr}` : overUnderStr;
        overUnderEl.className = `info-value ${overUnderMinutes >= 0 ? 'positive' : 'negative'}`;

        // Calculate remaining days and required per day
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

              // Calculate target clock-out time
              if (data.isWorking && data.clockInTimestamp) {
                const breakMinutes = 60; // 1 hour break
                const targetMs = data.clockInTimestamp + (requiredMinutesPerDay + breakMinutes) * 60 * 1000;
                const targetDate = new Date(targetMs);
                targetTimeEl.textContent = formatTimeShort(targetDate);
              }
            } else {
              requiredPerDayEl.textContent = '達成済み';
              requiredPerDayEl.className = 'info-value positive';
              targetTimeEl.textContent = '達成済み';
            }
          }
        }
      }
    } else {
      divider.style.display = 'none';
      summarySection.style.display = 'none';
    }
  }

  // ==================== Panel Injection ====================

  function findAndInjectPanel() {
    // Look for the punch area container
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

    // Check if panel already exists
    if (document.getElementById('ts-info-display')) {
      return;
    }

    // Create and inject the panel
    infoPanel = createInfoPanel();

    // Insert after the punch area
    punchArea.style.display = 'inline-block';
    punchArea.style.verticalAlign = 'top';
    punchArea.insertAdjacentElement('afterend', infoPanel);

    // Initial update
    updateDisplay();

    // Start periodic updates
    updateTimer = setInterval(updateDisplay, UPDATE_INTERVAL);

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

  // Start
  init();

  // Handle SPA navigation
  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      retryCount = 0;
      if (updateTimer) {
        clearInterval(updateTimer);
        updateTimer = null;
      }
      infoPanel = null;
      setTimeout(findAndInjectPanel, 1000);
    }
  }).observe(document, { subtree: true, childList: true });

  // Listen for storage changes
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
      updateDisplay();
    }
  });

})();
