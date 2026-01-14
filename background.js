// TeamSpirit Info Display - Background Script
// Fetches attendance data from TeamSpirit attendance page

const TEAMSPIRIT_ATTENDANCE_URL = 'https://teamspirit-74532.lightning.force.com/lightning/n/teamspirit__AtkWorkTimeView';

// Get today's date string
function getTodayDateStr() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

// Wait for tab to finish loading
function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Fetch attendance data from TeamSpirit
async function fetchAttendanceData() {
  let tempTab = null;
  try {
    console.log('TeamSpirit Info Display: Fetching attendance data...');

    // Open attendance page in background
    tempTab = await chrome.tabs.create({ url: TEAMSPIRIT_ATTENDANCE_URL, active: false });

    // Wait for page to load
    await waitForTabLoad(tempTab.id);

    // Additional wait for dynamic content
    await new Promise(r => setTimeout(r, 5000));

    const dateStr = getTodayDateStr();

    // Execute script to find data
    const results = await chrome.scripting.executeScript({
      target: { tabId: tempTab.id, allFrames: true },
      func: (dateStr) => {
        try {
          const result = {
            success: false,
            clockInTime: null,
            clockOutTime: null,
            isWorking: false,
            summary: null
          };

          // 1. Look for clock-in time
          const clockInId = `ttvTimeSt${dateStr}`;
          const clockInEl = document.getElementById(clockInId);

          if (clockInEl) {
            const timeText = clockInEl.textContent?.trim();
            if (timeText && timeText !== '' && timeText !== '--:--') {
              result.clockInTime = timeText;
              result.success = true;
            }
          }

          // 2. Look for clock-out time in same row
          if (clockInEl) {
            const row = clockInEl.closest('tr');
            if (row) {
              const clockOutEl = row.querySelector('td.vet, td.dval.vet');
              if (clockOutEl) {
                const timeText = clockOutEl.textContent?.trim();
                if (timeText && timeText !== '' && timeText !== '--:--') {
                  result.clockOutTime = timeText;
                }
              }
            }
          }

          // 3. Determine working status
          result.isWorking = !!(result.clockInTime && !result.clockOutTime);

          // 4. Look for summary data
          const summaryData = {};
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

          if (Object.keys(summaryData).length > 0) {
            result.summary = summaryData;
            result.success = true;
          }

          return result;
        } catch (e) {
          return { success: false, error: e.message };
        }
      },
      args: [dateStr]
    });

    // Close temp tab
    await chrome.tabs.remove(tempTab.id);
    tempTab = null;

    // Find best result
    let bestResult = null;
    for (const r of results) {
      if (r.result?.success) {
        if (!bestResult || (r.result.clockInTime && !bestResult.clockInTime)) {
          bestResult = r.result;
        }
        // Merge summary data
        if (r.result.summary && bestResult) {
          bestResult.summary = { ...bestResult.summary, ...r.result.summary };
        }
      }
    }

    if (bestResult) {
      // Save to storage
      await chrome.storage.local.set({
        attendanceData: bestResult,
        lastFetched: Date.now()
      });
      console.log('TeamSpirit Info Display: Data fetched successfully', bestResult);
      return bestResult;
    }

    return null;
  } catch (error) {
    console.error('TeamSpirit Info Display: Error fetching data', error);
    if (tempTab) {
      try { await chrome.tabs.remove(tempTab.id); } catch (e) {}
    }
    return null;
  }
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_ATTENDANCE_DATA') {
    fetchAttendanceData().then(data => {
      sendResponse({ success: !!data, data });
    });
    return true; // Keep channel open for async response
  }
});

// Fetch data when extension is installed/updated
chrome.runtime.onInstalled.addListener(() => {
  fetchAttendanceData();
});
