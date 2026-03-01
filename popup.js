// Popup script for NSU Course Seat Checker
const status = document.getElementById("status");
const pill = document.getElementById("pill");
const modeSelect = document.getElementById("mode");
const courseInput = document.getElementById("course");
const sectionInput = document.getElementById("section");
const refreshIntervalInput = document.getElementById("refreshInterval");
const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
const logEl = document.getElementById("log");
const clearLogBtn = document.getElementById("clearLog");
const statusSub = document.getElementById("statusSub");
const clearStatusBtn = document.getElementById("clearStatus");

let isChecking = false;

const STATE_KEY = 'nsuSeatCheckerState';
const LOG_KEY = 'nsuSeatCheckerLog';

function renderLog(lines) {
  if (!logEl) return;
  if (!lines || lines.length === 0) {
    logEl.textContent = '(no events yet)';
    return;
  }
  // Render as colored lines (supports existing string logs)
  logEl.innerHTML = '';
  for (const raw of lines) {
    const line = (raw || '').toString();
    const span = document.createElement('span');
    span.className = 'logline';

    const upper = line.toUpperCase();
    if (upper.includes('FOUND:')) span.classList.add('found');
    else if (upper.includes('CHECK:')) span.classList.add('check');
    else if (upper.includes('STOP')) span.classList.add('stop');
    else if (upper.includes('START')) span.classList.add('start');

    span.textContent = line;
    logEl.appendChild(span);
  }
}

function loadLog() {
  chrome.storage.local.get([LOG_KEY], (data) => {
    const lines = Array.isArray(data?.[LOG_KEY]) ? data[LOG_KEY] : [];
    renderLog(lines);
  });
}

function withActiveTab(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError || !tabs || tabs.length === 0) {
      cb(null);
      return;
    }
    cb(tabs[0]);
  });
}

function ensureContentScript(tabId, cb) {
  chrome.scripting.executeScript({ target: { tabId }, files: ['content.example.js'] }, () => {
    // Even if this fails, it may already be injected via manifest; we still try messaging.
    cb();
  });
}

function sendToTab(tabId, message, cb) {
  ensureContentScript(tabId, () => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        cb({ success: false, error: chrome.runtime.lastError.message });
      } else {
        cb(response || { success: true });
      }
    });
  });
}

// Load saved settings
chrome.storage.sync.get(['mode', 'course', 'section', 'refreshInterval'], (data) => {
  if (data.mode && modeSelect) modeSelect.value = data.mode;
  if (data.course) courseInput.value = data.course;
  if (data.section) sectionInput.value = data.section;
  if (data.refreshInterval) refreshIntervalInput.value = data.refreshInterval;
});

// Check current status
function updateStatus() {
  withActiveTab((tab) => {
    if (chrome.runtime.lastError) {
      status.innerText = "Error: " + chrome.runtime.lastError.message;
      return;
    }

    if (!tab) {
      status.innerText = "No active tab";
      return;
    }

    // Check if on correct domain
    if (!tab.url || (!tab.url.includes('rds3.northsouth.edu') && !tab.url.includes('rds4.northsouth.ac.bd'))) {
      status.innerText = "⚠️ Please navigate to rds3.northsouth.edu or rds4.northsouth.ac.bd";
      status.style.color = "#e74c3c";
      startButton.disabled = true;
      stopButton.disabled = false;
      return;
    }

    startButton.disabled = false;

    chrome.storage.local.get([STATE_KEY], (data) => {
      const st = data?.[STATE_KEY] || {};
      // Show lastFound persistently (especially for Multi mode)
      if (statusSub) {
        const foundInfo = st.foundInfo && typeof st.foundInfo === 'object' ? st.foundInfo : null;
        const foundPairs = Array.isArray(st.foundPairs) ? st.foundPairs : [];

        // Prefer foundInfo (shows seat numbers). Fallback to foundPairs list.
        const keys = foundInfo ? Object.keys(foundInfo) : foundPairs;
        if (foundInfo) {
          keys.sort((a, b) => (foundInfo[b]?.foundAt || 0) - (foundInfo[a]?.foundAt || 0));
        }

        if (keys.length > 0) {
          const lines = keys
            .slice(0, 20)
            .map((k) => {
              const info = foundInfo ? foundInfo[k] : null;
              if (!info) return `• ${k}`;
              const avail = (info.available === 0 || info.available) ? info.available : '?';
              return `• ${k} (avail: ${avail})`;
            })
            .join('\n');

          statusSub.textContent = `Seats available:\n${lines}`;
          statusSub.style.display = 'block';
        } else {
          statusSub.textContent = '';
          statusSub.style.display = 'none';
        }
      }

      if (st.state === 'found') {
        if (pill) pill.innerText = "FOUND";
        status.querySelector('.status-main').innerText = `FOUND: ${st.course}.${st.section}`;
        status.querySelector('.status-main').style.color = "#22c55e";
        startButton.disabled = false;
        stopButton.disabled = false;
        return;
      }
      if (st.state === 'running') {
        if (pill) pill.innerText = "Running";
        const q = st.queue?.total ? ` (${(st.queue.index ?? 0) + 1}/${st.queue.total})` : '';
        status.querySelector('.status-main').innerText = `Checking ${st.course}.${st.section}${q}...`;
        status.querySelector('.status-main').style.color = "#93c5fd";
        startButton.disabled = true;
        stopButton.disabled = false;
        return;
      }
      if (pill) pill.innerText = "Ready";
      status.querySelector('.status-main').style.color = "rgba(255,255,255,0.92)";

      // Fallback: ask content script
      sendToTab(tab.id, { action: "STATUS" }, (response) => {
        if (response && response.success && response.isRunning) {
          if (pill) pill.innerText = "Running";
          status.querySelector('.status-main').innerText = `Checking ${response.course}.${response.section}...`;
          status.querySelector('.status-main').style.color = "#93c5fd";
          isChecking = true;
          startButton.disabled = true;
          stopButton.disabled = false;
        } else {
          if (pill) pill.innerText = "Idle";
          status.querySelector('.status-main').innerText = "Idle";
          status.querySelector('.status-main').style.color = "rgba(255,255,255,0.92)";
          isChecking = false;
          startButton.disabled = false;
          stopButton.disabled = false;
        }
      });
    });
  });
}

if (clearStatusBtn) {
  clearStatusBtn.addEventListener('click', () => {
    chrome.storage.local.get([STATE_KEY], (data) => {
      const prev = data?.[STATE_KEY] || {};
      chrome.storage.local.set({
        [STATE_KEY]: {
          ...prev,
          foundPairs: [],
          foundInfo: {},
          lastFound: null
        }
      }, () => updateStatus());
    });
  });
}

if (clearLogBtn) {
  clearLogBtn.addEventListener('click', () => {
    chrome.storage.local.set({ [LOG_KEY]: [] }, () => loadLog());
  });
}

// Validate course format (e.g., CHE202, CSE110)
function validateCourse(course) {
  const coursePattern = /^[A-Z]{2,4}\d{3}$/;
  return coursePattern.test(course.toUpperCase());
}

// Validate section (should be a number)
function validateSection(section) {
  const sectionPattern = /^\d+$/;
  return sectionPattern.test(section.trim());
}

// Validate refresh interval (should be between 1 and 60 seconds)
function validateRefreshInterval(interval) {
  const num = parseInt(interval, 10);
  return !isNaN(num) && num >= 1 && num <= 60;
}

function parseCommaList(value) {
  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// Start button handler
startButton.addEventListener("click", () => {
  const mode = (modeSelect?.value || 'multi').toLowerCase() === 'beast' ? 'beast' : 'multi';
  const courseList = parseCommaList(courseInput.value).map(c => c.toUpperCase());
  const sectionList = parseCommaList(sectionInput.value);
  const refreshInterval = refreshIntervalInput.value.trim();

  // Validation
  if (courseList.length === 0 || sectionList.length === 0) {
    if (pill) pill.innerText = "Error";
    status.querySelector('.status-main').innerText = "Enter course & section";
    status.querySelector('.status-main').style.color = "#fca5a5";
    return;
  }

  if (courseList.length !== sectionList.length) {
    if (pill) pill.innerText = "Error";
    status.querySelector('.status-main').innerText = "Courses & sections count must match (pair-by-index)";
    status.querySelector('.status-main').style.color = "#fca5a5";
    return;
  }

  if (courseList.length > 7) {
    if (pill) pill.innerText = "Error";
    status.querySelector('.status-main').innerText = "Max 7 course-section pairs";
    status.querySelector('.status-main').style.color = "#fca5a5";
    return;
  }

  if (mode === 'beast' && courseList.length !== 1) {
    if (pill) pill.innerText = "Error";
    status.querySelector('.status-main').innerText = "Beast Mode supports only 1 course-section pair";
    status.querySelector('.status-main').style.color = "#fca5a5";
    return;
  }

  for (const c of courseList) {
    if (!validateCourse(c)) {
      if (pill) pill.innerText = "Error";
      status.querySelector('.status-main').innerText = `Invalid course: ${c}`;
      status.querySelector('.status-main').style.color = "#fca5a5";
      return;
    }
  }

  for (const s of sectionList) {
    if (!validateSection(s)) {
      if (pill) pill.innerText = "Error";
      status.querySelector('.status-main').innerText = `Invalid section: ${s}`;
      status.querySelector('.status-main').style.color = "#fca5a5";
      return;
    }
  }

  const course = courseList[0];
  const section = sectionList[0];
  const targets = courseList.map((c, idx) => ({ course: c, section: sectionList[idx] }));

  if (!validateCourse(course)) {
    if (pill) pill.innerText = "Error";
    status.querySelector('.status-main').innerText = "Invalid course format (e.g. CHE202)";
    status.querySelector('.status-main').style.color = "#fca5a5";
    return;
  }

  if (!validateSection(section)) {
    if (pill) pill.innerText = "Error";
    status.querySelector('.status-main').innerText = "Section must be a number";
    status.querySelector('.status-main').style.color = "#fca5a5";
    return;
  }

  if (!validateRefreshInterval(refreshInterval)) {
    if (pill) pill.innerText = "Error";
    status.querySelector('.status-main').innerText = "Refresh interval must be 1-60 seconds";
    status.querySelector('.status-main').style.color = "#fca5a5";
    return;
  }

  const refreshIntervalMs = parseInt(refreshInterval, 10) * 1000;

  // Save settings
  chrome.storage.sync.set({
    mode,
    course: courseInput.value.trim(),
    section: sectionInput.value.trim(),
    refreshInterval
  });

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) {
      status.innerText = "Error: " + chrome.runtime.lastError.message;
      status.style.color = "#e74c3c";
      return;
    }

    if (!tabs || tabs.length === 0) {
      status.innerText = "No active tab";
      status.style.color = "#e74c3c";
      return;
    }

    const tab = tabs[0];

    if (!tab.url || (!tab.url.includes('rds3.northsouth.edu') && !tab.url.includes('rds4.northsouth.ac.bd'))) {
      status.innerText = "⚠️ Please navigate to rds3.northsouth.edu or rds4.northsouth.ac.bd";
      status.style.color = "#e74c3c";
      return;
    }

    sendToTab(
      tab.id,
      {
        action: "START",
        mode,
        targets,
        course, // for backward compatibility
        section, // for backward compatibility
        checkInterval: 3000, // Check DOM every 3 seconds
        refreshInterval: refreshIntervalMs
      },
      (response) => {
        if (!response || !response.success) {
          if (pill) pill.innerText = "Error";
          status.querySelector('.status-main').innerText = response?.error || "Failed to start. Reload the tab once.";
          status.querySelector('.status-main').style.color = "#fca5a5";
          return;
        }

        if (pill) pill.innerText = "Running";
        status.querySelector('.status-main').innerText = mode === 'multi'
          ? `Checking ${targets.length} pairs...`
          : `Checking ${course}.${section}...`;
        status.querySelector('.status-main').style.color = "#93c5fd";
        isChecking = true;
        startButton.disabled = true;
        stopButton.disabled = false;
      }
    );
  });
});

// Stop button handler
stopButton.addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) {
      status.innerText = "Error: " + chrome.runtime.lastError.message;
      status.style.color = "#e74c3c";
      return;
    }

    if (!tabs || tabs.length === 0) {
      status.innerText = "No active tab";
      return;
    }

    // Clear storage as backup
    chrome.storage.local.remove(['isChecking', 'course', 'section', 'checkInterval', 'refreshInterval']);
    
    sendToTab(tabs[0].id, { action: "STOP" }, (response) => {
      // Always update UI even if message fails (we cleared storage)
      if (pill) pill.innerText = "Idle";
      status.querySelector('.status-main').innerText = "Stopped";
      status.querySelector('.status-main').style.color = "rgba(255,255,255,0.92)";
      isChecking = false;
      startButton.disabled = false;
      stopButton.disabled = false;
    });
  });
});

// Listen for seat found messages
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'SEAT_FOUND') {
    if (pill) pill.innerText = "FOUND";
    status.querySelector('.status-main').innerText = `FOUND: ${message.course}.${message.section}`;
    status.querySelector('.status-main').style.color = "#22c55e";
    isChecking = false;
    startButton.disabled = false;
    stopButton.disabled = false;
  }
});

// React to storage updates (so popup shows FOUND even if it was closed)
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes[STATE_KEY]) updateStatus();
  if (changes[LOG_KEY]) loadLog();
});

// Update status on popup open
updateStatus();
loadLog();

// Update status periodically
setInterval(updateStatus, 1000);
