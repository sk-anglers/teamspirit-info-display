// TeamSpirit Info Display - Content Script
// Injects working time and summary info into TeamSpirit home page
// Reads data from iframe DOM and displays in main frame

(function() {
  'use strict';

  // Avoid running multiple times in same frame
  if (window.tsInfoDisplayInitialized) return;
  window.tsInfoDisplayInitialized = true;

  const isMainFrame = (window === window.top);

  // ==================== Utility Functions ====================

  function getTodayDateStr() {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  }

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

  // ==================== Data Fetching from DOM ====================

  function getAttendanceDataFromPage() {
    const dateStr = getTodayDateStr();
    const result = {
      clockInTime: null,
      clockOutTime: null,
      isWorking: false,
      hasClockedOut: false,
      summary: null,
      found: false
    };

    // 1. Look for clock-in time with ID ttvTimeSt{date}
    const clockInId = `ttvTimeSt${dateStr}`;
    const clockInEl = document.getElementById(clockInId);

    if (clockInEl) {
      result.found = true;
      const timeText = clockInEl.textContent?.trim();
      if (timeText && timeText !== '' && timeText !== '--:--') {
        result.clockInTime = timeText;
      }
    }

    // 2. Look for clock-out time - no ID, use class "vet" (visit end)
    // ONLY search in the same row as clock-in to avoid getting wrong day's data
    if (clockInEl) {
      const row = clockInEl.closest('tr');
      if (row) {
        const clockOutEl = row.querySelector('td.vet, td.dval.vet');
        if (clockOutEl) {
          const timeText = clockOutEl.textContent?.trim();
          if (timeText && timeText !== '' && timeText !== '--:--') {
            result.clockOutTime = timeText;
            result.hasClockedOut = true;
          }
        }
      }
    }

    // 3. Determine if user is currently working
    result.isWorking = !!(result.clockInTime && !result.clockOutTime);

    // 4. Look for summary data
    const summaryData = {};

    // Search for specific patterns in table structure
    const tables = document.querySelectorAll('table');
    tables.forEach(table => {
      const rows = table.querySelectorAll('tr');
      rows.forEach(row => {
        const cells = row.querySelectorAll('td, th');
        if (cells.length >= 2) {
          const label = cells[0].textContent?.trim();
          const value = cells[cells.length - 1].textContent?.trim();

          if (label?.includes('所定労働時間')) summaryData.scheduledHours = value;
          if (label?.includes('総労働時間') && !label?.includes('法定')) summaryData.totalHours = value;
          if (label?.includes('過不足時間')) summaryData.overUnderHours = value;
          if (label?.includes('所定出勤日数')) summaryData.scheduledDays = value;
          if (label?.includes('実出勤日数')) summaryData.actualDays = value;
        }
      });
    });

    // Also try div-based layout
    const divs = document.querySelectorAll('div');
    divs.forEach(div => {
      const text = div.textContent?.trim();
      if (!text) return;

      if (text.includes('所定労働時間') && !summaryData.scheduledHours) {
        const match = text.match(/所定労働時間[:\s]*(\d{1,3}:\d{2})/);
        if (match) summaryData.scheduledHours = match[1];
      }
      if (text.includes('総労働時間') && !text.includes('法定') && !summaryData.totalHours) {
        const match = text.match(/総労働時間[^法]*?(\d{1,3}:\d{2})/);
        if (match) summaryData.totalHours = match[1];
      }
      if (text.includes('過不足時間') && !summaryData.overUnderHours) {
        const match = text.match(/過不足時間[:\s]*(-?\d{1,3}:\d{2})/);
        if (match) summaryData.overUnderHours = match[1];
      }
      if (text.includes('所定出勤日数') && !summaryData.scheduledDays) {
        const match = text.match(/所定出勤日数[:\s]*(\d+)/);
        if (match) summaryData.scheduledDays = match[1];
      }
      if (text.includes('実出勤日数') && !summaryData.actualDays) {
        const match = text.match(/実出勤日数[:\s]*(\d+)/);
        if (match) summaryData.actualDays = match[1];
      }
    });

    if (Object.keys(summaryData).length > 0) {
      result.summary = summaryData;
      result.found = true;
    }

    return result;
  }

  // ==================== IFRAME: Send data to parent ====================

  if (!isMainFrame) {
    // In iframe: search for data and send to parent
    let lastDataJson = '';

    function checkAndSendData() {
      const data = getAttendanceDataFromPage();
      if (data.found) {
        const dataJson = JSON.stringify(data);
        // Only send if data changed
        if (dataJson !== lastDataJson) {
          lastDataJson = dataJson;
          window.top.postMessage({
            type: 'TS_INFO_DISPLAY_DATA',
            data: data
          }, '*');
        }
      }
    }

    // Check immediately and periodically
    checkAndSendData();
    setInterval(checkAndSendData, 1000);

    return; // Don't continue with UI code in iframe
  }

  // ==================== MAIN FRAME: Display panel ====================

  // Configuration
  const CHECK_INTERVAL = 2000;
  const MAX_RETRIES = 30;

  let infoPanel = null;
  let updateTimer = null;
  let retryCount = 0;
  let latestData = null;

  // Listen for data from iframes
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'TS_INFO_DISPLAY_DATA') {
      latestData = event.data.data;
      updateDisplay();
    }
  });

  // ==================== UI Creation ====================

  function createInfoPanel() {
    const panel = document.createElement('div');
    panel.id = 'ts-info-display';
    panel.innerHTML = `
      <div class="info-header">勤怠情報</div>

      <div class="info-section">
        <div class="info-row">
          <span class="info-label">状態</span>
          <span class="status-badge not-started" id="ts-status-badge">確認中...</span>
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

    const data = latestData;

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
      statusBadge.textContent = '確認中...';
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

      // Show clock-in time
      clockInEl.textContent = data.clockInTime;

      // Calculate working time
      const clockInDate = parseTimeToDate(data.clockInTime);
      if (clockInDate) {
        const workingMs = Date.now() - clockInDate.getTime();
        workingTimeEl.textContent = formatDuration(workingMs);
      }

    } else if (data.hasClockedOut && data.clockInTime && data.clockOutTime) {
      statusBadge.textContent = '退勤済み';
      statusBadge.className = 'status-badge finished';
      timeSection.style.display = 'block';
      clockOutRow.style.display = 'flex';
      targetRow.style.display = 'none';

      // Show clock-in/out times
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

      // Calculate over/under
      const scheduledMinutes = parseTimeToMinutes(summary.scheduledHours);
      const totalMinutes = parseTimeToMinutes(summary.totalHours);
      const overUnderEl = infoPanel.querySelector('#ts-over-under');

      if (scheduledMinutes !== null && totalMinutes !== null) {
        // Add today's working time if currently working
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
              if (data.isWorking && data.clockInTime) {
                const clockInDate = parseTimeToDate(data.clockInTime);
                if (clockInDate) {
                  const breakMinutes = 60; // 1 hour break
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
        // Use pre-calculated over/under if available
        overUnderEl.textContent = summary.overUnderHours;
        const isNegative = summary.overUnderHours.startsWith('-');
        overUnderEl.className = `info-value ${isNegative ? 'negative' : 'positive'}`;
      }
    } else {
      divider.style.display = 'none';
      summarySection.style.display = 'none';
    }
  }

  // Update working time every second (for real-time counter)
  function startWorkingTimeUpdates() {
    setInterval(() => {
      if (latestData?.isWorking && latestData?.clockInTime && infoPanel) {
        const workingTimeEl = infoPanel.querySelector('#ts-working-time');
        const clockInDate = parseTimeToDate(latestData.clockInTime);
        if (clockInDate && workingTimeEl) {
          const workingMs = Date.now() - clockInDate.getTime();
          workingTimeEl.textContent = formatDuration(workingMs);
        }
      }
    }, 1000);
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

    // Start working time updates
    startWorkingTimeUpdates();

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
      latestData = null;
      infoPanel = null;
      setTimeout(findAndInjectPanel, 1000);
    }
  }).observe(document, { subtree: true, childList: true });

})();
