// LTS offscreen document.
//
// Created on-demand by background.js via:
//   chrome.offscreen.createDocument({url: 'offscreen.html', reasons: ['CLIPBOARD']})
//
// Single responsibility: write text to clipboard from MV3 service-worker context
// where navigator.clipboard.writeText does NOT require user gesture (documented
// MV3 behaviour for reason 'CLIPBOARD').
//
// See ADR-0006 §2 (Clipboard UX) and TASK-LTS §2.3.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'lts-copy' || typeof msg.text !== 'string') {
    return false;
  }

  (async () => {
    try {
      await navigator.clipboard.writeText(msg.text);
      sendResponse({ ok: true });
      return;
    } catch (clipboardErr) {
      // Fallback per ADR-0006 acceptance gate §5.4: legacy API inside offscreen.
      // document.execCommand is synchronous and works in offscreen context.
      try {
        const ta = document.createElement('textarea');
        ta.value = msg.text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        sendResponse({
          ok,
          fallback: 'execCommand',
          error: ok ? null : String(clipboardErr),
        });
      } catch (fallbackErr) {
        sendResponse({ ok: false, error: String(fallbackErr) });
      }
    }
  })();

  return true; // async response
});