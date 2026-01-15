// TeamSpirit Info Display - Background Script
// Fetches attendance data from TeamSpirit attendance page

const TEAMSPIRIT_ATTENDANCE_URL = 'https://teamspirit-74532.lightning.force.com/lightning/n/teamspirit__AtkWorkTimeView';

// ログをContent Scriptに送信してUI表示
async function sendLogToContent(message, data = null) {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://teamspirit-74532.lightning.force.com/*', 'https://*.force.com/*'] });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'DEBUG_LOG', message, data }).catch(() => {});
    }
  } catch (e) {}
}

function log(message, data = null) {
  const timestamp = new Date().toLocaleTimeString();
  const text = data !== null ? `${message} ${JSON.stringify(data)}` : message;
  console.log(`[TS-Info ${timestamp}] ${text}`);
  sendLogToContent(`[BG] ${message}`, data);
}

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
    log('==========================================');
    log('========== データ取得開始 ==========');
    log('==========================================');
    log('勤怠ページURL: ' + TEAMSPIRIT_ATTENDANCE_URL);

    // Open attendance page in background
    log('STEP 1: バックグラウンドタブを作成中...');
    tempTab = await chrome.tabs.create({ url: TEAMSPIRIT_ATTENDANCE_URL, active: false });
    log('STEP 1 完了: タブ作成成功 tabId=' + tempTab.id);

    // Wait for page to load
    log('STEP 2: ページ読み込み待機中...');
    await waitForTabLoad(tempTab.id);
    log('STEP 2 完了: ページ読み込み完了');

    // Additional wait for dynamic content - Salesforce Lightning needs more time
    log('STEP 3: 動的コンテンツ待機中 (8秒)...');
    await new Promise(r => setTimeout(r, 8000));
    log('STEP 3 完了: 待機完了');

    // Check for iframes and wait for them to load
    log('STEP 3.5: iframe検出中...');
    const iframeCheck = await chrome.scripting.executeScript({
      target: { tabId: tempTab.id },
      func: () => {
        const iframes = document.querySelectorAll('iframe');
        return {
          count: iframes.length,
          srcs: Array.from(iframes).map(f => f.src || '(no src)').slice(0, 5)
        };
      }
    });
    log('iframe検出結果:', iframeCheck[0]?.result);

    if (iframeCheck[0]?.result?.count > 0) {
      log('iframeが見つかりました。追加で3秒待機...');
      await new Promise(r => setTimeout(r, 3000));
    }

    const dateStr = getTodayDateStr();
    log('検索対象日付: ' + dateStr);
    log('検索対象要素ID: ttvTimeSt' + dateStr);

    // Execute script to find data
    log('STEP 4: スクリプト実行中 (allFrames: true)...');
    const results = await chrome.scripting.executeScript({
      target: { tabId: tempTab.id, allFrames: true },
      func: (dateStr) => {
        const result = {
          success: false,
          clockInTime: null,
          clockOutTime: null,
          isWorking: false,
          summary: null,
          debug: {
            frameUrl: window.location.href,
            clockInElementFound: false,
            clockOutElementFound: false,
            tableCount: 0,
            summaryKeysFound: []
          }
        };

        try {
          // 1. Look for clock-in time
          const clockInId = `ttvTimeSt${dateStr}`;
          const clockInEl = document.getElementById(clockInId);

          result.debug.clockInElementFound = !!clockInEl;

          // 全てのttvで始まるIDを検索
          const allTtvIds = Array.from(document.querySelectorAll('[id^="ttv"]')).map(el => el.id).slice(0, 10);
          result.debug.ttvIdsFound = allTtvIds;

          if (clockInEl) {
            const timeText = clockInEl.textContent?.trim();
            result.debug.clockInRawText = timeText;
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
              result.debug.clockOutElementFound = !!clockOutEl;
              if (clockOutEl) {
                const timeText = clockOutEl.textContent?.trim();
                result.debug.clockOutRawText = timeText;
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
          result.debug.tableCount = tables.length;

          tables.forEach(table => {
            const rows = table.querySelectorAll('tr');
            rows.forEach(row => {
              const cells = row.querySelectorAll('td, th');
              if (cells.length >= 2) {
                const label = cells[0].textContent?.trim();
                const value = cells[cells.length - 1].textContent?.trim();

                if (label?.includes('所定労働時間')) {
                  summaryData.scheduledHours = value;
                  result.debug.summaryKeysFound.push('scheduledHours');
                }
                if (label?.includes('総労働時間') && !label?.includes('法定')) {
                  summaryData.totalHours = value;
                  result.debug.summaryKeysFound.push('totalHours');
                }
                if (label?.includes('過不足時間')) {
                  summaryData.overUnderHours = value;
                  result.debug.summaryKeysFound.push('overUnderHours');
                }
                if (label?.includes('所定出勤日数')) {
                  summaryData.scheduledDays = value;
                  result.debug.summaryKeysFound.push('scheduledDays');
                }
                if (label?.includes('実出勤日数')) {
                  summaryData.actualDays = value;
                  result.debug.summaryKeysFound.push('actualDays');
                }
              }
            });
          });

          if (Object.keys(summaryData).length > 0) {
            result.summary = summaryData;
            result.success = true;
          }

          return result;
        } catch (e) {
          result.debug.error = e.message;
          return result;
        }
      },
      args: [dateStr]
    });

    log('STEP 4 完了: スクリプト実行完了');
    log('実行結果フレーム数: ' + results.length);

    // Log each frame result
    results.forEach((r, index) => {
      log(`--- フレーム ${index + 1} ---`);
      if (r.result) {
        log(`  URL: ${r.result.debug?.frameUrl || 'unknown'}`);
        log(`  成功: ${r.result.success}`);
        log(`  出勤要素発見: ${r.result.debug?.clockInElementFound}`);
        log(`  出勤時刻: ${r.result.clockInTime || 'なし'}`);
        log(`  退勤要素発見: ${r.result.debug?.clockOutElementFound}`);
        log(`  退勤時刻: ${r.result.clockOutTime || 'なし'}`);
        log(`  勤務中: ${r.result.isWorking}`);
        log(`  テーブル数: ${r.result.debug?.tableCount}`);
        log(`  サマリーキー: ${r.result.debug?.summaryKeysFound?.join(', ') || 'なし'}`);
        log(`  ttv要素: ${r.result.debug?.ttvIdsFound?.join(', ') || 'なし'}`);
        if (r.result.debug?.error) {
          log(`  エラー: ${r.result.debug.error}`);
        }
      } else {
        log(`  結果なし`);
      }
    });

    // Close temp tab
    log('STEP 5: タブを閉じています...');
    await chrome.tabs.remove(tempTab.id);
    tempTab = null;
    log('STEP 5 完了: タブを閉じました');

    // Find best result
    log('STEP 6: 最適な結果を選択中...');
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
      log('STEP 6 完了: 最適な結果を発見');
      log('最終結果:', bestResult);

      // Save to storage
      log('STEP 7: ストレージに保存中...');
      await chrome.storage.local.set({
        attendanceData: bestResult,
        lastFetched: Date.now()
      });
      log('STEP 7 完了: ストレージ保存完了');
      log('========== データ取得完了 ==========');
      return bestResult;
    }

    log('警告: 有効な結果が見つかりませんでした');
    log('========== データ取得失敗 ==========');
    return null;
  } catch (error) {
    log('エラー発生: ' + error.message);
    log('エラースタック:', error.stack);
    if (tempTab) {
      try {
        await chrome.tabs.remove(tempTab.id);
        log('エラー後タブクリーンアップ完了');
      } catch (e) {
        log('タブクリーンアップ失敗: ' + e.message);
      }
    }
    return null;
  }
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  log('メッセージ受信:', message);
  if (message.type === 'FETCH_ATTENDANCE_DATA') {
    log('データ取得リクエスト受信 (from content script)');
    fetchAttendanceData().then(data => {
      log('content scriptへレスポンス送信:', { success: !!data, hasData: !!data });
      sendResponse({ success: !!data, data });
    });
    return true; // Keep channel open for async response
  }
});

// Fetch data when extension is installed/updated
chrome.runtime.onInstalled.addListener(() => {
  log('拡張機能インストール/更新検出 - 初回データ取得開始');
  fetchAttendanceData();
});

log('Background script 読み込み完了');
