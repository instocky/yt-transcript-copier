async function extractAndCopy() {
  // Step 1: try to grab already-rendered transcript
  let text = grabText();

  // If text is missing or suspiciously short (< 10 words) — trigger auto-open
  if (!text || text.split(/\s+/).filter(Boolean).length < 10) {
    showToast('⏳ Открываю транскрипт...');

    const opened = await autoOpenTranscript();
    if (!opened) {
      showToast('❌ Не удалось открыть транскрипт');
      return;
    }

    text = await waitForText();
  }

  if (!text) {
    showToast('❌ Транскрипт не найден');
    return;
  }

  const title = document.title.replace(/ - YouTube$/, '').trim();
  const url = location.href;
  const textWithMeta = `${title}\n${url}\n\n${text}`;

  await copyToClipboard(textWithMeta);
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  showToast(`✅ Скопировано! (~${wordCount} слов)`);
}

async function autoOpenTranscript() {
  // Strategy 1: "Показать текст видео" button (visible in description area)
  if (await clickButtonByText(/показать текст|show transcript/i)) return true;

  // Strategy 2: expand description first, then find the button
  const expandBtn = document.querySelector(
    'tp-yt-paper-button#expand, ytd-text-inline-expander #expand, #description-inline-expander #expand'
  );
  if (expandBtn) {
    expandBtn.click();
    await sleep(600);
    if (await clickButtonByText(/показать текст|show transcript/i)) return true;
  }

  // Strategy 3: "..." more-actions menu under video
  const moreBtn = document.querySelector(
    'ytd-menu-renderer yt-icon-button#button button, #above-the-fold ytd-button-renderer button'
  );
  if (moreBtn) {
    moreBtn.click();
    await sleep(500);
    if (await clickButtonByText(/transcript|расшифров|текст видео/i))
      return true;
  }

  // Strategy 4: engagement panel button in top menu
  const panelBtns = document.querySelectorAll(
    'ytd-watch-metadata button, ytd-video-description-transcript-section-renderer button'
  );
  for (const btn of panelBtns) {
    if (
      /показать текст|transcript/i.test(
        btn.innerText || btn.getAttribute('aria-label') || ''
      )
    ) {
      btn.click();
      await sleep(800);
      return true;
    }
  }

  return false;
}

async function clickButtonByText(pattern) {
  const candidates = document.querySelectorAll(
    'button, tp-yt-paper-button, ytd-button-renderer button, yt-button-shape button'
  );
  for (const el of candidates) {
    const label = (el.innerText || el.getAttribute('aria-label') || '').trim();
    if (pattern.test(label)) {
      el.click();
      await sleep(800);
      return true;
    }
  }
  return false;
}

async function waitForText(maxWait = 5000) {
  const step = 400;
  let waited = 0;
  while (waited < maxWait) {
    await sleep(step);
    waited += step;
    const text = grabText();
    if (text) return text;
  }
  return null;
}

function grabText() {
  // New YT DOM (2024+): transcript-segment-view-model
  const newSegments = document.querySelectorAll(
    'transcript-segment-view-model'
  );
  if (newSegments.length > 0) {
    return Array.from(newSegments)
      .map(seg => {
        // Skip timestamp nodes explicitly
        const ts = seg.querySelector(
          ".ytwTranscriptSegmentViewModelTimestampA11yLabel, [class*='Timestamp']"
        );
        const textEl = seg.querySelector(
          "yt-core-attributed-string, [class*='SegmentText'], span[role='text']"
        );
        if (textEl) {
          // Clone and remove any nested timestamp spans before reading text
          const clone = textEl.cloneNode(true);
          clone
            .querySelectorAll("[class*='Timestamp'], [aria-hidden='true']")
            .forEach(el => el.remove());
          return clone.innerText.trim();
        }
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }

  // Legacy DOM: ytd-transcript-segment-renderer
  const container = document.querySelector('.ytSectionListRendererContents');
  if (container) {
    const segments = container.querySelectorAll(
      'ytd-transcript-segment-renderer'
    );
    if (segments.length > 0) {
      return Array.from(segments)
        .map(seg => {
          const textEl = seg.querySelector('yt-formatted-string');
          return textEl ? textEl.innerText.trim() : '';
        })
        .filter(Boolean)
        .join('\n\n');
    }
    return cleanText(container.innerText);
  }

  // Fallback: any segment on page
  const segments = document.querySelectorAll('ytd-transcript-segment-renderer');
  if (segments.length > 0) {
    return Array.from(segments)
      .map(seg => {
        const textEl = seg.querySelector('yt-formatted-string');
        return textEl ? textEl.innerText.trim() : '';
      })
      .filter(Boolean)
      .join('\n\n');
  }

  // Fallback: engagement panel
  const panel = document.querySelector(
    "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-searchable-transcript']"
  );
  if (panel) return cleanText(panel.innerText);

  // Fallback: description section with transcript
  const descSection = document.querySelector(
    'ytd-video-description-transcript-section-renderer'
  );
  if (descSection) return cleanText(descSection.innerText);

  return null;
}

function cleanText(raw) {
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !/^\d+:\d+(:\d+)?$/.test(l))
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    Object.assign(ta.style, { position: 'fixed', opacity: '0' });
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function showToast(message) {
  const existing = document.getElementById('yt-transcript-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'yt-transcript-toast';
  toast.innerText = message;
  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '32px',
    right: '32px',
    background: '#0f0f0f',
    color: '#fff',
    padding: '12px 20px',
    borderRadius: '8px',
    fontSize: '14px',
    fontFamily: 'Roboto, sans-serif',
    zIndex: '999999',
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
    transition: 'opacity 0.4s',
    opacity: '1',
  });

  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 400);
  }, 3000);
}
