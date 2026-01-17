// Background service worker for handling notifications

// Set up notification click handlers once
chrome.notifications.onButtonClicked.addListener((notifId, buttonIndex) => {
  if (buttonIndex === 0) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs.length > 0) {
        chrome.tabs.update(tabs[0].id, { active: true });
        chrome.windows.update(tabs[0].windowId, { focused: true });
      }
    });
  }
  chrome.notifications.clear(notifId);
});

chrome.notifications.onClicked.addListener((notifId) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true });
      chrome.windows.update(tabs[0].windowId, { focused: true });
    }
  });
  chrome.notifications.clear(notifId);
});

async function ensureOffscreen() {
  if (!chrome.offscreen) return;
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Play a short alert sound when a seat is found in Beast Mode.'
  });
}

let lastBeepKey = null;
let lastTtsKey = null;

function speakTtsOnce(key, text) {
  if (!chrome.tts || key === lastTtsKey) return;
  lastTtsKey = key;
  try {
    chrome.tts.speak(text, {
      rate: 1.0,
      pitch: 1.0,
      volume: 1.0,
      enqueue: false
    });
  } catch (e) {
    // ignore
  }
}

// Handle messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    if (message.action === 'SEAT_FOUND' && message.course && message.section) {
      const LOG_KEY = 'nsuSeatCheckerLog';
      const logLine = `[${new Date().toLocaleTimeString()}] FOUND: ${message.course}.${message.section} (avail: ${message.available ?? '?'})`;

      chrome.storage.local.get([LOG_KEY], (data) => {
        const prev = Array.isArray(data?.[LOG_KEY]) ? data[LOG_KEY] : [];
        const next = [logLine, ...prev].slice(0, 100);
        chrome.storage.local.set({ [LOG_KEY]: next });
      });

      // Persist last-found:
      // - Beast Mode: state=found
      // - Multi Mode: keep state as-is (running), only update lastFound
      chrome.storage.local.get(['nsuSeatCheckerState'], (data) => {
        const prev = data?.nsuSeatCheckerState || {};
        const now = Date.now();
        const lastFound = {
          course: message.course,
          section: message.section,
          foundAt: now,
          foundUrl: message.foundUrl || (sender?.tab?.url || null),
          details: {
            available: message.available ?? null,
            taken: message.taken ?? null,
            total: message.total ?? null
          }
        };

        if (message.mode === 'beast') {
          chrome.storage.local.set({
            nsuSeatCheckerState: {
              ...prev,
              state: 'found',
              course: message.course,
              section: message.section,
              foundAt: now,
              foundUrl: lastFound.foundUrl,
              details: lastFound.details,
              lastFound
            }
          });
        } else {
          chrome.storage.local.set({
            nsuSeatCheckerState: {
              ...prev,
              lastFound
            }
          });
        }
      });

      // Beast Mode only: focus the tab and reveal/filter the page for the user.
      if (message.mode === 'beast' && sender?.tab?.id) {
        chrome.tabs.update(sender.tab.id, { active: true });
        if (sender.tab.windowId) chrome.windows.update(sender.tab.windowId, { focused: true });
        chrome.tabs.sendMessage(sender.tab.id, {
          action: 'FOCUS_COURSE',
          course: message.course,
          section: message.section,
          reveal: true
        });
      }

      // Beast Mode only: play a single beep reliably (offscreen document).
      if (message.mode === 'beast') {
        const key = `${message.course}.${message.section}-${message.foundUrl || ''}`;
        if (key !== lastBeepKey) {
          lastBeepKey = key;
          ensureOffscreen()
            .then(() => chrome.runtime.sendMessage({ action: 'PLAY_BEEP' }))
            .catch(() => {
              // Edge may not support/allow offscreen audio reliably; fallback to TTS
              speakTtsOnce(key, `Seat available for ${message.course} section ${message.section}`);
            });

          // Extra safety: if offscreen exists but still no sound, TTS once after short delay
          setTimeout(() => {
            speakTtsOnce(key, `Seat available for ${message.course} section ${message.section}`);
          }, 400);
        }
      }

      const notificationId = `seat-available-${Date.now()}`;
      const available = (message.available ?? (message.total - message.taken)) ?? 0;
      
      const notificationOptions = {
        type: 'basic',
        title: '🎉 Seat Available!',
        message: `${message.course}.${message.section}\n${message.taken}/${message.total} seats\n${available} seat(s) available!`,
        priority: 2,
        buttons: [
          { title: 'Open Page' }
        ]
      };

      // Chrome will automatically use a default icon if iconUrl is not provided
      
      chrome.notifications.create(notificationId, notificationOptions, (createdId) => {
        if (chrome.runtime.lastError) {
          console.error('Notification error:', chrome.runtime.lastError);
          // Notification permission might not be granted, but that's okay
        }
      });
    }
  } catch (error) {
    console.error('Error in background script:', error);
  }
  
  return true;
});
