// Public placeholder content script (no seat-check logic).
// To get the real `content.js`, contact the repository owner (see README).
//
// This file exists so the extension can be loaded from the public repo without
// shipping the private checker implementation.

if (!globalThis.__NSU_SEAT_CHECKER_PLACEHOLDER_LOADED__) {
  globalThis.__NSU_SEAT_CHECKER_PLACEHOLDER_LOADED__ = true;

  let running = false;
  let lastTargets = [];
  let lastMode = 'multi';

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const respond = (response) => {
      try {
        sendResponse?.(response);
      } catch (_) {
        // ignore
      }
    };

    if (!msg?.action) {
      respond({ success: false, error: 'Invalid message' });
      return true;
    }

    if (msg.action === 'PING') {
      respond({
        success: true,
        ready: true,
        placeholder: true,
        domain: window.location.hostname
      });
      return true;
    }

    if (msg.action === 'STATUS') {
      respond({
        success: true,
        isRunning: running,
        mode: lastMode,
        totalTargets: Array.isArray(lastTargets) ? lastTargets.length : 0,
        placeholder: true
      });
      return true;
    }

    if (msg.action === 'STOP') {
      running = false;
      lastTargets = [];
      respond({ success: true, message: 'Stopped (placeholder script)', placeholder: true });
      return true;
    }

    if (msg.action === 'START') {
      lastMode = msg.mode === 'beast' ? 'beast' : 'multi';
      lastTargets = Array.isArray(msg.targets) ? msg.targets : [];
      running = false;
      respond({
        success: false,
        placeholder: true,
        error:
          'This public repo ships a placeholder content script only. ' +
          'To enable seat checking, get the private `content.js` from the owner and replace this file.'
      });
      return true;
    }

    if (msg.action === 'FOCUS_COURSE') {
      respond({ success: false, placeholder: true, error: 'Not supported in placeholder script' });
      return true;
    }

    respond({ success: false, placeholder: true, error: `Unknown action: ${msg.action}` });
    return true;
  });
}
