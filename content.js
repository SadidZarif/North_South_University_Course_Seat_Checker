// Content script for NSU Course Seat Checker
// This script may be injected multiple times from the popup. Make it idempotent.
if (globalThis.__NSU_SEAT_CHECKER_LOADED__) {
  // already loaded in this page context
} else {
globalThis.__NSU_SEAT_CHECKER_LOADED__ = true;

let checkerInterval = null;
let refreshInterval = null;
let currentCourse = null;
let currentSection = null;
let checkInterval = 3000; // Default 3 seconds
let refreshIntervalMs = 3000; // Default 3 seconds
let searchAttempted = false; // Track if we've tried searching
let lastSearchValue = ''; // Track last search value to avoid duplicate searches
let isRunning = false; // Hard stop guard (prevents any further search/refresh after FOUND)
let searchRecheckTimeoutId = null; // clear on stop/found

// Multi-target support
const MAX_TARGETS = 7;
let targets = []; // [{course, section}]
let targetIndex = 0;
let mode = 'multi'; // 'multi' | 'beast'

const STATE_KEY = 'nsuSeatCheckerState';
const LOG_KEY = 'nsuSeatCheckerLog';

// Avoid log write races: multiple appendLog() calls can happen in the same tick (multi mode),
// so we batch them and write once.
let pendingLogLines = [];
let logFlushTimer = null;

function flushLogs() {
  logFlushTimer = null;
  if (!pendingLogLines.length) return;
  const batch = pendingLogLines;
  pendingLogLines = [];

  chrome.storage.local.get([LOG_KEY], (data) => {
    const prev = Array.isArray(data?.[LOG_KEY]) ? data[LOG_KEY] : [];
    // batch currently oldest->newest; we want newest first in storage
    const next = [...batch].reverse().concat(prev).slice(0, 200);
    chrome.storage.local.set({ [LOG_KEY]: next });
  });
}

function appendLog(line) {
  const logLine = `[${new Date().toLocaleTimeString()}] ${line}`;
  pendingLogLines.push(logLine);
  if (logFlushTimer) return;
  logFlushTimer = setTimeout(flushLogs, 50);
}

function pairKey(course, section) {
  return `${(course || '').toString().trim().toUpperCase()}.${(section || '').toString().trim()}`;
}

// Serialize state updates to avoid lost writes (multiple FOUND events in same tick)
let stateWriteInFlight = false;
let pendingStatePatches = [];

function flushState() {
  if (stateWriteInFlight) return;
  if (pendingStatePatches.length === 0) return;
  stateWriteInFlight = true;

  const patches = pendingStatePatches;
  pendingStatePatches = [];

  chrome.storage.local.get([STATE_KEY], (data) => {
    const prev = data?.[STATE_KEY] || {};
    const next = patches.reduce((acc, p) => ({ ...acc, ...(p || {}) }), { ...prev });
    chrome.storage.local.set({ [STATE_KEY]: next }, () => {
      stateWriteInFlight = false;
      // flush any patches queued while we were writing
      flushState();
    });
  });
}

function setState(patch) {
  pendingStatePatches.push(patch);
  // tiny debounce so multiple setState calls within same JS turn collapse into one write
  setTimeout(flushState, 0);
}

function ensureHighlightStyle() {
  if (document.getElementById('nsu-seat-checker-style')) return;
  const style = document.createElement('style');
  style.id = 'nsu-seat-checker-style';
  style.textContent = `
    .nsu-seat-checker-highlight {
      outline: 3px solid #22c55e !important;
      box-shadow: 0 0 0 5px rgba(34, 197, 94, 0.25) !important;
      border-radius: 6px;
    }
  `;
  document.documentElement.appendChild(style);
}

function highlightRow(row) {
  if (!row) return;
  ensureHighlightStyle();
  row.classList.add('nsu-seat-checker-highlight');
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => row.classList.remove('nsu-seat-checker-highlight'), 6000);
}

function isRds4() {
  return window.location.hostname === 'rds4.northsouth.ac.bd';
}

// Verify we're on the correct domain
function isValidDomain() {
  const hostname = window.location.hostname;
  return hostname === 'rds3.northsouth.edu' || hostname === 'rds4.northsouth.ac.bd';
}

// Resume checking after page refresh
function resumeCheckingIfNeeded() {
  if (!isValidDomain()) return;

  chrome.storage.local.get(['isChecking', 'targets', 'mode', 'targetIndex', 'course', 'section', 'checkInterval', 'refreshInterval'], (data) => {
    if (data.isChecking) {
      mode = data.mode === 'beast' ? 'beast' : 'multi';
      targetIndex = Number.isInteger(data.targetIndex) ? data.targetIndex : 0;

      // Backward compat: if targets not present, build from course/section
      if (Array.isArray(data.targets) && data.targets.length > 0) {
        targets = data.targets.slice(0, MAX_TARGETS).map(t => ({
          course: (t?.course || '').toString().trim().toUpperCase(),
          section: (t?.section || '').toString().trim()
        })).filter(t => t.course && t.section);
      } else if (data.course && data.section) {
        targets = [{ course: data.course.toString().trim().toUpperCase(), section: data.section.toString().trim() }];
      } else {
        targets = [];
      }

      if (!targets.length) return;

      currentCourse = targets[Math.min(targetIndex, targets.length - 1)].course;
      currentSection = targets[Math.min(targetIndex, targets.length - 1)].section;
      checkInterval = data.checkInterval || 3000;
      refreshIntervalMs = data.refreshInterval || 3000;

      // Reset search flags after page refresh
      searchAttempted = false;
      lastSearchValue = '';

      // Wait for page to be ready
      if (document.readyState === 'complete') {
        startChecking();
      } else {
        window.addEventListener('load', startChecking, { once: true });
      }
    }
  });
}

// Start checking function
function selectNextTarget() {
  if (!targets || targets.length === 0) return null;
  if (targetIndex >= targets.length) targetIndex = 0;

  const idx = targetIndex;
  const t = targets[idx];
  targetIndex = (targetIndex + 1) % targets.length;

  currentCourse = t.course;
  currentSection = t.section;

  chrome.storage.local.set({ targetIndex });
  setState({
    state: 'running',
    course: currentCourse,
    section: currentSection,
    mode,
    queue: { index: idx, total: targets.length }
  });

  return t;
}

function tickOnce() {
  if (!isRunning) return;
  if (!targets || targets.length === 0) return;

  // Multi mode: check ALL pairs each interval (as requested)
  // Beast mode: only one target exists anyway.
  for (const t of targets) {
    if (!isRunning) return;
    appendLog(`CHECK: ${t.course}.${t.section}`);
    checkSeat(t.course, t.section);
  }
}

function startChecking() {
  if (checkerInterval) clearInterval(checkerInterval);
  if (refreshInterval) clearInterval(refreshInterval);
  isRunning = true;
  if (searchRecheckTimeoutId) {
    clearTimeout(searchRecheckTimeoutId);
    searchRecheckTimeoutId = null;
  }

  // Wait a bit for page to fully render after refresh
  const checkAfterLoad = () => {
    // Start checking seats after a short delay to ensure DOM is ready
    setTimeout(() => {
      if (!isRunning) return;
      tickOnce();
    }, 500);

    // Set up interval for checking (check DOM periodically)
    checkerInterval = setInterval(() => {
      if (!isRunning) return;
      tickOnce();
    }, checkInterval);
  };

  if (document.readyState === 'complete') {
    checkAfterLoad();
  } else {
    window.addEventListener('load', checkAfterLoad, { once: true });
  }

  // Set up interval for page refresh (refresh page to get updated data)
  refreshInterval = setInterval(() => {
    if (checkerInterval && isRunning) {
      // Save state before refresh
      chrome.storage.local.set({
        isChecking: true,
        course: currentCourse,
        section: currentSection,
        targets,
        mode,
        targetIndex,
        checkInterval: checkInterval,
        refreshInterval: refreshIntervalMs
      });
      window.location.reload();
    }
  }, refreshIntervalMs);
}

// Resume on page load
if (document.readyState === 'complete') {
  resumeCheckingIfNeeded();
} else {
  window.addEventListener('load', resumeCheckingIfNeeded, { once: true });
}

// Listen for messages from popup
// Make sure listener is set up immediately when script loads
// Debug logs removed for production stability (kept minimal)

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  
  // Always return true to keep channel open for async response
  const respond = (response) => {
    try {
      if (typeof sendResponse === 'function') {
        sendResponse(response);
        console.log('[NSU Checker] Sent response:', response);
      }
    } catch (e) {
      console.error('[NSU Checker] Error sending response:', e);
    }
  };

  // Handle PING message to check if script is ready
  if (msg.action === "PING") {
    respond({ success: true, ready: true, domain: window.location.hostname });
    return true;
  }

  try {
    if (!isValidDomain()) {
      respond({ success: false, error: 'Extension only works on rds3.northsouth.edu or rds4.northsouth.ac.bd' });
      return true;
    }

    if (msg.action === "START") {
      mode = msg.mode === 'beast' ? 'beast' : 'multi';

      // Parse targets (up to 7)
      if (Array.isArray(msg.targets) && msg.targets.length > 0) {
        targets = msg.targets.slice(0, MAX_TARGETS).map(t => ({
          course: (t?.course || '').toString().trim().toUpperCase(),
          section: (t?.section || '').toString().trim()
        })).filter(t => t.course && t.section);
      } else {
        // Backward compat: single target
        const c = (msg.course || '').toString().trim().toUpperCase();
        const s = (msg.section || '').toString().trim();
        targets = (c && s) ? [{ course: c, section: s }] : [];
      }

      if (!targets.length) {
        respond({ success: false, error: 'No valid course/section provided' });
        return true;
      }

      // Beast mode: only 1 target
      if (mode === 'beast') {
        targets = [targets[0]];
      }

      targetIndex = 0;
      currentCourse = targets[0].course;
      currentSection = targets[0].section;
      checkInterval = msg.checkInterval || 3000;
      refreshIntervalMs = msg.refreshInterval || 3000;

      // Reset search flags for new check
      searchAttempted = false;
      lastSearchValue = '';

      // Save state to storage
      chrome.storage.local.set({
        isChecking: true,
        course: currentCourse,
        section: currentSection,
        targets,
        mode,
        targetIndex,
        checkInterval: checkInterval,
        refreshInterval: refreshIntervalMs
      });

      setState({
        state: 'running',
        course: currentCourse,
        section: currentSection,
        mode,
        queue: { index: 0, total: targets.length },
        foundPairs: [],
        foundInfo: {},
        lastCheckedAt: Date.now(),
        foundAt: null,
        foundUrl: null,
        details: null
      });

      appendLog(`START (${mode}): ${targets.map(t => `${t.course}.${t.section}`).join(', ')}`);

      startChecking();
      respond({ success: true, message: 'Started checking' });
    }

    if (msg.action === "STOP") {
      isRunning = false;
      if (searchRecheckTimeoutId) {
        clearTimeout(searchRecheckTimeoutId);
        searchRecheckTimeoutId = null;
      }
      if (checkerInterval) {
        clearInterval(checkerInterval);
        checkerInterval = null;
      }
      if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
      }
      currentCourse = null;
      currentSection = null;
      targets = [];
      targetIndex = 0;
      mode = 'multi';
      
      // Clear storage
      chrome.storage.local.remove(['isChecking', 'course', 'section', 'targets', 'mode', 'targetIndex', 'checkInterval', 'refreshInterval']);
      setState({ state: 'idle', course: null, section: null });

      appendLog('STOP');
      
      respond({ success: true, message: 'Stopped checking' });
    }

    if (msg.action === "STATUS") {
      respond({
        success: true,
        isRunning: checkerInterval !== null,
        course: currentCourse,
        section: currentSection,
        mode,
        totalTargets: targets?.length || 0
      });
    }

    if (msg.action === "FOCUS_COURSE") {
      const c = (msg.course || currentCourse || '').toString().trim().toUpperCase();
      const s = (msg.section || currentSection || '').toString().trim();
      // Only reveal/filter the page if explicitly requested (or Beast Mode).
      if (isRds4() && c && (msg.reveal === true || mode === 'beast')) {
        revealCourseToUserRds4(c);
      } else if (!isRds4() && c && (msg.reveal === true || mode === 'beast')) {
        performSearch(c);
      }
      setTimeout(() => {
        // Try to find row again after search filter
        const table = document.querySelector('table');
        if (!table) return;
        const rows = table.querySelectorAll('tr');
        for (const row of rows) {
          const tds = row.querySelectorAll('td');
          if (tds.length < 3) continue;
          const courseText = (tds[1]?.innerText || '').trim().toUpperCase();
          const sectionText = (tds[2]?.innerText || '').trim();
          if (courseText === c && sectionText === s) {
            highlightRow(row);
            break;
          }
        }
      }, 400);
      respond({ success: true });
    }
  } catch (error) {
    console.error('[NSU Checker] Error in content script:', error);
    respond({ success: false, error: error.message });
  }

  return true; // Keep message channel open for async response
});

// Improved seat checking function with better error handling
let rds4DtApiCache = null;
let rds4DtColCache = null; // {courseIdx, sectionIdx, seatsIdx}

function getRds4DataTableApi() {
  if (!isRds4()) return null;
  if (rds4DtApiCache) return rds4DtApiCache;
  const $ = window.jQuery || window.$;
  if (!$ || !$.fn || !$.fn.dataTable) return null;

  const tables = document.querySelectorAll('table');
  for (const t of tables) {
    try {
      const api = $(t).DataTable();
      if (api && typeof api.rows === 'function') {
        rds4DtApiCache = api;
        return api;
      }
    } catch (e) {
      // not a datatable
    }
  }
  return null;
}

function getRds4ColumnIndices(api) {
  if (rds4DtColCache) return rds4DtColCache;
  try {
    const headers = api.columns().header().toArray().map(h => (h?.textContent || '').trim().toUpperCase());
    const courseIdx = headers.findIndex(h => h.includes('COURSE') && !h.includes('SECTION'));
    const sectionIdx = headers.findIndex(h => h.includes('SECTION'));
    let seatsIdx = headers.findIndex(h => h.includes('SEATS') && h.includes('AVAILABLE'));
    if (seatsIdx === -1) seatsIdx = headers.findIndex(h => h.includes('SEAT') && h.includes('AVAILABLE'));
    if (seatsIdx === -1) seatsIdx = headers.length - 1;
    rds4DtColCache = {
      courseIdx: courseIdx >= 0 ? courseIdx : 1,
      sectionIdx: sectionIdx >= 0 ? sectionIdx : 2,
      seatsIdx: seatsIdx >= 0 ? seatsIdx : (headers.length - 1)
    };
    return rds4DtColCache;
  } catch (e) {
    rds4DtColCache = { courseIdx: 1, sectionIdx: 2, seatsIdx: 6 };
    return rds4DtColCache;
  }
}

function parseSeatsValue(seatText) {
  const txt = (seatText || '').toString().trim();
  // rds4 commonly has just a number (available seats)
  const m1 = txt.match(/^(\d+)$/);
  if (m1) {
    const available = parseInt(m1[1], 10);
    return { available, taken: 0, total: available + 1 };
  }
  // legacy format: taken(total)
  const m2 = txt.match(/(\d+)\((\d+)\)/);
  if (m2) {
    const taken = parseInt(m2[1], 10);
    const total = parseInt(m2[2], 10);
    return { available: total - taken, taken, total };
  }
  return null;
}

function revealCourseToUserRds4(courseCode) {
  const api = getRds4DataTableApi();
  if (api) {
    try {
      api.search(courseCode).draw();
    } catch (e) {
      // ignore
    }
  }
  // Also set the visible search input value (Beast Mode only)
  const searchInput = document.querySelector('input[type="search"]') || document.querySelector('input[placeholder*="Search" i]');
  if (searchInput) {
    searchInput.value = courseCode;
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    searchInput.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// rds3 advising page often renders as a non-standard table; safest is to scan rows for "COURSE.SECTION"
function scanRds3Row(courseUpper, sectionTrim) {
  const target = `${courseUpper}.${sectionTrim}`;
  const re = new RegExp(`\\b${escapeRegExp(target)}\\b`, 'i');

  const rows = document.querySelectorAll('tr');
  for (const row of rows) {
    const rowText = (row.innerText || '').replace(/\s+/g, ' ').trim();
    if (!re.test(rowText)) continue;

    const m = rowText.match(/(\d+)\((\d+)\)/);
    if (!m) continue;

    const taken = parseInt(m[1], 10);
    const total = parseInt(m[2], 10);
    if (Number.isNaN(taken) || Number.isNaN(total)) continue;

    return { row, taken, total, available: total - taken };
  }

  // Fallback: scan any element text if table rows aren't used
  const elems = document.querySelectorAll('td, div, span, a');
  for (const el of elems) {
    const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!re.test(t)) continue;

    // try to parse seats in parent container
    const container = el.closest('tr') || el.parentElement;
    const containerText = (container?.innerText || '').replace(/\s+/g, ' ').trim();
    const m = containerText.match(/(\d+)\((\d+)\)/);
    if (!m) continue;

    const taken = parseInt(m[1], 10);
    const total = parseInt(m[2], 10);
    if (Number.isNaN(taken) || Number.isNaN(total)) continue;

    return { row: container, taken, total, available: total - taken };
  }

  return null;
}

let beastSoundPlayed = false;
function playBeastSoundOnce() {
  if (beastSoundPlayed) return;
  beastSoundPlayed = true;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.15);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.26);
    o.onended = () => {
      try { ctx.close(); } catch (e) {}
    };
  } catch (e) {
    // ignore audio failures (autoplay policy etc.)
  }
}

function checkSeat(course, section) {
  try {
    if (!isRunning) return; // hard stop after FOUND/STOP
    if (!course || !section) {
      console.error('Course or section not provided');
      return;
    }

    // Wait for DOM to be ready
    if (document.readyState !== 'complete') {
      console.log('Waiting for page to load...');
      return;
    }

    setState({ lastCheckedAt: Date.now() });

    // rds3 advising: direct scan the row for COURSE.SECTION and taken(total)
    if (!isRds4()) {
      const courseUpper = course.toUpperCase().trim();
      const sectionTrim = section.trim();
      const hit = scanRds3Row(courseUpper, sectionTrim);
      if (hit) {
        const isAvailable = hit.taken < hit.total;
        if (isAvailable) {
          const key = pairKey(courseUpper, sectionTrim);
          chrome.storage.local.get([STATE_KEY], (data) => {
            const prev = data?.[STATE_KEY] || {};
            const prevFound = Array.isArray(prev.foundPairs) ? prev.foundPairs : [];
            const alreadyFound = prevFound.includes(key);

            if (!alreadyFound) {
              appendLog(`FOUND: ${key} (avail: ${hit.available})`);
              setState({
                lastFound: { course: courseUpper, section: sectionTrim, available: hit.available, taken: hit.taken, total: hit.total },
                foundPairs: [...prevFound, key].slice(0, 50),
                foundInfo: {
                  ...(prev.foundInfo || {}),
                  [key]: { available: hit.available, taken: hit.taken, total: hit.total, foundAt: Date.now() }
                }
              });

              chrome.runtime.sendMessage({
                action: 'SEAT_FOUND',
                notification: true,
                course: courseUpper,
                section: sectionTrim,
                taken: hit.taken,
                total: hit.total,
                available: hit.available,
                foundUrl: window.location.href,
                mode
              }).catch(() => {});
            }

            if (mode === 'beast') {
              playBeastSoundOnce();
              isRunning = false;
              if (searchRecheckTimeoutId) {
                clearTimeout(searchRecheckTimeoutId);
                searchRecheckTimeoutId = null;
              }
              if (checkerInterval) {
                clearInterval(checkerInterval);
                checkerInterval = null;
              }
              if (refreshInterval) {
                clearInterval(refreshInterval);
                refreshInterval = null;
              }
              chrome.storage.local.remove(['isChecking', 'course', 'section', 'targets', 'mode', 'targetIndex', 'checkInterval', 'refreshInterval']);
              highlightRow(hit.row);
              setState({
                state: 'found',
                course: courseUpper,
                section: sectionTrim,
                mode,
                foundAt: Date.now(),
                foundUrl: window.location.href,
                details: { available: hit.available, taken: hit.taken, total: hit.total }
              });
            } else {
              // Multi Mode: keep running; do NOT stop checking other pairs
              setState({ state: 'running' });
            }
          });

          return; // seat available processed
        }
      }
      // If not found/available in rds3 scan, continue to generic logic below
    }

    // rds4: INTERNAL scan via DataTables API (no visible typing/search while checking)
    if (isRds4()) {
      const api = getRds4DataTableApi();
      if (api) {
        const courseUpper = course.toUpperCase().trim();
        const sectionTrim = section.trim();
        const { courseIdx, sectionIdx, seatsIdx } = getRds4ColumnIndices(api);

        let foundRow = null;
        let seatInfo = null;

        api.rows().every(function () {
          const data = this.data();
          const rowArr = Array.isArray(data) ? data : null;
          if (!rowArr) return;

          const c = (rowArr[courseIdx] ?? '').toString().trim().toUpperCase();
          const s = (rowArr[sectionIdx] ?? '').toString().trim();
          if (c === courseUpper && s === sectionTrim) {
            foundRow = this; // row API context
            seatInfo = parseSeatsValue(rowArr[seatsIdx]);
          }
        });

        if (foundRow && seatInfo) {
          const isAvailable = seatInfo.available > 0;
          if (isAvailable) {
            const key = pairKey(courseUpper, sectionTrim);
            chrome.storage.local.get([STATE_KEY], (data) => {
              const prev = data?.[STATE_KEY] || {};
              const prevFound = Array.isArray(prev.foundPairs) ? prev.foundPairs : [];
              const alreadyFound = prevFound.includes(key);

              if (!alreadyFound) {
                appendLog(`FOUND: ${key} (avail: ${seatInfo.available})`);
                setState({
                  lastFound: { course: courseUpper, section: sectionTrim, available: seatInfo.available, taken: seatInfo.taken, total: seatInfo.total },
                  foundPairs: [...prevFound, key].slice(0, 50),
                  foundInfo: {
                    ...(prev.foundInfo || {}),
                    [key]: { available: seatInfo.available, taken: seatInfo.taken, total: seatInfo.total, foundAt: Date.now() }
                  }
                });

                chrome.runtime.sendMessage({
                  action: 'SEAT_FOUND',
                  notification: true,
                  course: courseUpper,
                  section: sectionTrim,
                  taken: seatInfo.taken,
                  total: seatInfo.total,
                  available: seatInfo.available,
                  foundUrl: window.location.href,
                  mode
                }).catch(() => {});
              }

              if (mode === 'beast') {
                // Beast Mode: stop everything and reveal/filter for user + play sound
                playBeastSoundOnce();
                isRunning = false;
                if (searchRecheckTimeoutId) {
                  clearTimeout(searchRecheckTimeoutId);
                  searchRecheckTimeoutId = null;
                }
                if (checkerInterval) {
                  clearInterval(checkerInterval);
                  checkerInterval = null;
                }
                if (refreshInterval) {
                  clearInterval(refreshInterval);
                  refreshInterval = null;
                }
                chrome.storage.local.remove(['isChecking', 'course', 'section', 'targets', 'mode', 'targetIndex', 'checkInterval', 'refreshInterval']);

                revealCourseToUserRds4(courseUpper);
                setTimeout(() => {
                  try {
                    const node = foundRow.node?.();
                    if (node) highlightRow(node);
                  } catch (e) {}
                }, 200);

                setState({
                  state: 'found',
                  course: courseUpper,
                  section: sectionTrim,
                  mode,
                  foundAt: Date.now(),
                  foundUrl: window.location.href,
                  details: { available: seatInfo.available, taken: seatInfo.taken, total: seatInfo.total }
                });
              } else {
                // Multi Mode: keep running
                setState({ state: 'running' });
              }
            });

            return;
          }
        }

        // If DataTables exists and no seat, just return (no DOM/search needed)
        return;
      }
      // If DataTables isn't available, fall back to DOM approach below.
    }

    // Try multiple selectors to find course table
    const table = document.querySelector('table') || 
                  document.querySelector('[class*="table"]') ||
                  document.querySelector('tbody');

    if (!table) {
      console.warn('Course table not found. Waiting for page to load...');
      return;
    }

    // Get all table rows (handle both separate columns and combined format)
    const rows = table.querySelectorAll('tr');
    
    if (rows.length === 0) {
      console.warn('[NSU Checker] No table rows found');
      return;
    }

    const courseUpper = course.toUpperCase().trim();
    const sectionTrim = section.trim();
    let found = false;

    // Debug: Log what we're looking for
    console.log(`[NSU Checker] Looking for Course: "${courseUpper}", Section: "${sectionTrim}"`);
    console.log(`[NSU Checker] Found ${rows.length} table rows`);

    // Try to find header row to identify column positions
    let courseColIndex = 0; // Default: first column
    let sectionColIndex = 1; // Default: second column
    let seatColIndex = -1; // Will be determined

    // Check first row for headers
    const firstRow = rows[0];
    const headerCells = firstRow.querySelectorAll('th, td');
    if (headerCells.length > 0) {
      Array.from(headerCells).forEach((cell, idx) => {
        const headerText = cell.innerText.trim().toUpperCase();
        if (headerText.includes('COURSE') && !headerText.includes('SECTION')) {
          courseColIndex = idx;
        } else if (headerText.includes('SECTION')) {
          sectionColIndex = idx;
        } else if (headerText.includes('SEAT') || headerText.includes('AVAILABLE') || headerText.includes('TAKEN')) {
          seatColIndex = idx;
        }
      });
    }

    // If seat column not found in header, try to find it by looking at last column or pattern
    if (seatColIndex === -1) {
      // Check last few columns for seat pattern
      if (rows.length > 1) {
        const firstDataRow = rows[1];
        const cells = firstDataRow.querySelectorAll('td');
        for (let i = cells.length - 1; i >= Math.max(0, cells.length - 3); i--) {
          const cellText = cells[i].innerText.trim();
          if (cellText.match(/\d+/) || cellText.match(/\d+\(\d+\)/)) {
            seatColIndex = i;
            break;
          }
        }
      }
      // Default to last column if not found
      if (seatColIndex === -1 && headerCells.length > 0) {
        seatColIndex = headerCells.length - 1;
      }
    }

    console.log(`[NSU Checker] Column indices - Course: ${courseColIndex}, Section: ${sectionColIndex}, Seat: ${seatColIndex}`);

    // Search through rows
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      const cells = row.querySelectorAll('td');
      
      if (cells.length === 0) continue; // Skip header rows without td

      // Get course and section from separate columns
      const courseCell = cells[courseColIndex];
      const sectionCell = cells[sectionColIndex];
      
      if (!courseCell || !sectionCell) continue;

      const courseText = courseCell.innerText.trim().toUpperCase();
      const sectionText = sectionCell.innerText.trim();

      // Debug: Log potential matches
      if (courseText.includes(courseUpper) || sectionText === sectionTrim) {
        console.log(`[NSU Checker] Row ${rowIndex}: Course="${courseText}", Section="${sectionText}"`);
      }

      // Match course+section (supports both separate columns and combined "COURSE.SECTION" cell)
      const combinedCell = (courseCell.innerText || '').trim().toUpperCase().replace(/\s+/g, '');
      const combinedTarget = `${courseUpper}.${sectionTrim}`.toUpperCase().replace(/\s+/g, '');
      const matchesCombined = combinedCell === combinedTarget;
      const matchesSeparate = courseText === courseUpper && sectionText === sectionTrim;

      if (matchesSeparate || matchesCombined) {
        console.log(`[NSU Checker] ✓ Found match at row ${rowIndex}: Course="${courseText}", Section="${sectionText}"`);
        
        // Find seat info - try multiple formats
        let seatText = '';
        let taken = 0;
        let total = 0;
        let available = 0;

        // Try to find seat column
        if (seatColIndex >= 0 && seatColIndex < cells.length) {
          seatText = cells[seatColIndex].innerText.trim();
        } else {
          // Search through all cells in row for seat pattern
          for (let i = 0; i < cells.length; i++) {
            const cellText = cells[i].innerText.trim();
            // Try format: "39(40)" or just "0" or "Available: 1"
            if (cellText.match(/\d+\(\d+\)/) || 
                (cellText.match(/^\d+$/) && i > sectionColIndex)) {
              seatText = cellText;
              break;
            }
          }
        }

        console.log(`[NSU Checker] Seat text found: "${seatText}"`);

        // Parse seat information - multiple formats
        // Format 1: "39(40)" - taken(total)
        let match = seatText.match(/(\d+)\((\d+)\)/);
        if (match) {
          taken = parseInt(match[1], 10);
          total = parseInt(match[2], 10);
          available = total - taken;
        } else {
          // Format 2: Just a number like "0" or "1" (seats available)
          match = seatText.match(/^(\d+)$/);
          if (match) {
            available = parseInt(match[1], 10);
            // If it's just available seats, we don't know total, so assume seat is available if > 0
            if (available > 0) {
              taken = 0; // Unknown, but seat is available
              total = available + 1; // At least this many
            } else {
              // No seats available, but we don't know total
              console.warn(`[NSU Checker] Seat shows 0 available, but total unknown`);
              return;
            }
          } else {
            console.warn(`[NSU Checker] Could not parse seat format: "${seatText}"`);
            // Log all cells for debugging
            console.log(`[NSU Checker] All cells in row:`, 
              Array.from(cells).map((c, i) => `${i}: "${c.innerText.trim()}"`).join(', '));
            return;
          }
        }

        if (isNaN(taken) && isNaN(available)) {
          console.error('[NSU Checker] Invalid seat numbers');
          return;
        }

        console.log(`[NSU Checker] ${courseUpper}.${sectionTrim} → Available: ${available}, Taken: ${taken}, Total: ${total || 'unknown'}`);

        // Check if seat is available
        // If we have total, check taken < total
        // If we only have available count, check available > 0
        const isAvailable = (total > 0 && taken < total) || (available > 0);
        
        if (isAvailable) {
          found = true;

          const key = pairKey(courseUpper, sectionTrim);
          chrome.storage.local.get([STATE_KEY], (data) => {
            const prev = data?.[STATE_KEY] || {};
            const prevFound = Array.isArray(prev.foundPairs) ? prev.foundPairs : [];
            const alreadyFound = prevFound.includes(key);

            if (!alreadyFound) {
              appendLog(`FOUND: ${key} (avail: ${available})`);
              setState({
                lastFound: { course: courseUpper, section: sectionTrim, available, taken: taken || 0, total: total || (available + 1) },
                foundPairs: [...prevFound, key].slice(0, 50),
                foundInfo: {
                  ...(prev.foundInfo || {}),
                  [key]: { available, taken: taken || 0, total: total || (available + 1), foundAt: Date.now() }
                }
              });

              chrome.runtime.sendMessage({
                action: 'SEAT_FOUND',
                notification: true,
                course: courseUpper,
                section: sectionTrim,
                taken: taken || 0,
                total: total || (available + 1),
                available: available,
                foundUrl: window.location.href,
                mode
              }).catch(() => {});
            }

            if (mode === 'beast') {
              // Hard stop all future actions
              playBeastSoundOnce();
              isRunning = false;
              if (searchRecheckTimeoutId) {
                clearTimeout(searchRecheckTimeoutId);
                searchRecheckTimeoutId = null;
              }
              if (checkerInterval) {
                clearInterval(checkerInterval);
                checkerInterval = null;
              }
              if (refreshInterval) {
                clearInterval(refreshInterval);
                refreshInterval = null;
              }

              chrome.storage.local.remove(['isChecking', 'course', 'section', 'targets', 'mode', 'targetIndex', 'checkInterval', 'refreshInterval']);

              highlightRow(row);

              setState({
                state: 'found',
                course: courseUpper,
                section: sectionTrim,
                mode,
                foundAt: Date.now(),
                foundUrl: window.location.href,
                details: { available, taken: taken || 0, total: total || (available + 1) }
              });
            } else {
              // Multi Mode: keep running
              setState({ state: 'running' });
            }
          });

          return;
        } else {
          const statusMsg = total > 0 
            ? `${courseUpper}.${sectionTrim} is full (${taken}/${total})`
            : `${courseUpper}.${sectionTrim} has no available seats`;
          console.log(`[NSU Checker] ${statusMsg}`);
        }
      }
    }

    if (!found) {
      console.log(`[NSU Checker] ❌ Course ${courseUpper}.${sectionTrim} not found in current page`);
      console.log(`[NSU Checker] Searched through ${rows.length} rows`);
      
      // Show sample courses found for debugging
      const foundCourses = new Set();
      for (let i = 1; i < Math.min(rows.length, 10); i++) {
        const cells = rows[i].querySelectorAll('td');
        if (cells.length > courseColIndex && cells.length > sectionColIndex) {
          const courseText = cells[courseColIndex].innerText.trim();
          const sectionText = cells[sectionColIndex].innerText.trim();
          if (courseText && sectionText) {
            foundCourses.add(`${courseText}.${sectionText}`);
          }
        }
      }
      if (foundCourses.size > 0) {
        console.log(`[NSU Checker] Sample courses found on page:`, Array.from(foundCourses).slice(0, 10));
      }

      // rds4 internal scanning should NOT visibly search while checking.
      // Only rds3 (non-DataTables) uses this fallback search behavior.
      if (!isRds4() && (!searchAttempted || lastSearchValue !== courseUpper)) {
        performSearch(courseUpper);
      } else {
        searchAttempted = true;
        lastSearchValue = courseUpper;
      }
    } else {
      // Reset search flag if course is found
      searchAttempted = false;
      lastSearchValue = '';
    }
  } catch (error) {
    console.error('Error checking seat:', error);
  }
}

// Function to perform search on the website
function performSearch(courseCode) {
  try {
    if (!isRunning) return; // hard stop after FOUND/STOP
    // Find search input box - try multiple selectors
    const searchSelectors = [
      'input[type="search"]',
      'input[placeholder*="Search" i]',
      'input[placeholder*="search" i]',
      'input[name*="search" i]',
      'input[id*="search" i]',
      'input[class*="search" i]',
      'input[type="text"]' // Fallback to any text input
    ];

    let searchInput = null;
    for (const selector of searchSelectors) {
      const inputs = document.querySelectorAll(selector);
      for (const input of inputs) {
        // Check if it's likely a search box (near "Search:" label or has search-like attributes)
        const parentText = input.parentElement?.innerText || '';
        const labelText = input.previousElementSibling?.innerText || '';
        if (parentText.toLowerCase().includes('search') || 
            labelText.toLowerCase().includes('search') ||
            selector.includes('search')) {
          searchInput = input;
          console.log(`[NSU Checker] Found search input with selector: ${selector}`);
          break;
        }
      }
      if (searchInput) break;
    }

    // If no specific search box found, try to find any input near "Search:" text
    if (!searchInput) {
      const allInputs = document.querySelectorAll('input[type="text"], input[type="search"]');
      for (const input of allInputs) {
        // Check if there's "Search:" text nearby
        let element = input.previousElementSibling;
        let checked = 0;
        while (element && checked < 3) {
          if (element.innerText && element.innerText.toLowerCase().includes('search')) {
            searchInput = input;
            console.log(`[NSU Checker] Found search input near "Search:" text`);
            break;
          }
          element = element.previousElementSibling;
          checked++;
        }
        if (searchInput) break;
      }
    }

    if (!searchInput) {
      console.warn(`[NSU Checker] Could not find search input box. Course might be on a different page.`);
      searchAttempted = true;
      lastSearchValue = courseCode;
      return;
    }

    // Clear existing search and type course code
    searchInput.focus();
    searchInput.value = '';
    searchInput.value = courseCode;
    
    // Trigger input event
    const inputEvent = new Event('input', { bubbles: true });
    searchInput.dispatchEvent(inputEvent);
    
    // Trigger change event
    const changeEvent = new Event('change', { bubbles: true });
    searchInput.dispatchEvent(changeEvent);

    // Try to trigger search - look for search button or press Enter
    // Method 1: Look for a search button
    const searchButton = searchInput.parentElement?.querySelector('button[type="submit"]') ||
                        searchInput.parentElement?.querySelector('button') ||
                        document.querySelector('button[type="submit"]');
    
    if (searchButton) {
      console.log(`[NSU Checker] Clicking search button`);
      searchButton.click();
    } else {
      // Method 2: Simulate Enter key press
      console.log(`[NSU Checker] Simulating Enter key press`);
      const enterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true
      });
      searchInput.dispatchEvent(enterEvent);
      
      const enterEvent2 = new KeyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true
      });
      searchInput.dispatchEvent(enterEvent2);
    }

    // Mark search as attempted
    searchAttempted = true;
    lastSearchValue = courseCode;
    
    console.log(`[NSU Checker] ✓ Search performed for: ${courseCode}`);
    
    // Wait a bit for search results to load, then check again (cancelable)
    if (searchRecheckTimeoutId) clearTimeout(searchRecheckTimeoutId);
    searchRecheckTimeoutId = setTimeout(() => {
      if (!isRunning) return;
      searchAttempted = false; // Allow re-check
      if (currentCourse && currentSection) {
        checkSeat(currentCourse, currentSection);
      }
    }, 450); // DataTables usually filters fast

  } catch (error) {
    console.error('[NSU Checker] Error performing search:', error);
    searchAttempted = true;
    lastSearchValue = courseCode;
  }
}

// Clean up on page unload
window.addEventListener('beforeunload', () => {
  if (checkerInterval) clearInterval(checkerInterval);
  if (refreshInterval) clearInterval(refreshInterval);
});

} // end idempotent guard
