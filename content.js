async function extractAndCopy() {
  const artifact = await extractTranscriptArtifact();

  if (!artifact.ok) {
    showToast(artifact.error?.message || 'Не удалось получить транскрипт');
    return artifact;
  }

  const textWithMeta = `${artifact.meta.title}\n${artifact.meta.url}\n\n${artifact.transcript}`;

  await copyToClipboard(textWithMeta);
  const wordCount = artifact.transcript.split(/\s+/).filter(Boolean).length;
  showToast(`Скопировано! (~${wordCount} слов)`, 'success');
  return artifact;
}

async function extractAndSaveMarkdown() {
  const artifact = await extractTranscriptArtifact();

  if (!artifact.ok) {
    showToast(artifact.error?.message || 'Транскрипт не найден');
    return artifact;
  }

  chrome.runtime.sendMessage({
    type: 'DOWNLOAD_MD',
    payload: {
      filename: artifact.filename,
      content: artifact.markdown,
    },
  });

  showToast(`Сохранено: ${artifact.filename}`, 'success');
  return artifact;
}

async function extractForBatch(expectedVideoId = null) {
  return extractTranscriptArtifact(expectedVideoId);
}

async function extractTranscriptArtifact(expectedVideoId = null) {
  if (expectedVideoId) {
    const ready = await waitForVideoContext(expectedVideoId);
    if (!ready) {
      return buildErrorResult(
        'PAGE_NOT_READY',
        'Страница видео не успела перейти в ожидаемое состояние',
        true
      );
    }
  }

  let text = grabText();

  if (!text || text.split(/\s+/).filter(Boolean).length < 10) {
    showToast('Открываю транскрипт...');

    const opened = await autoOpenTranscript();
    if (!opened) {
      return buildErrorResult(
        'NO_TRANSCRIPT',
        'Не удалось открыть панель транскрипта',
        false
      );
    }

    text = await waitForText();
  }

  if (!text) {
    return buildErrorResult('NO_TRANSCRIPT', 'Транскрипт не найден', false);
  }

  const meta = buildMetadata();
  const filename = buildFilename(meta);
  const markdown = buildMarkdown(meta, text);

  return {
    ok: true,
    filename,
    markdown,
    transcript: text,
    meta,
    error: null,
  };
}

function buildErrorResult(type, message, retryable) {
  return {
    ok: false,
    filename: null,
    markdown: null,
    transcript: null,
    meta: buildMetadata(),
    error: {
      type,
      message,
      retryable,
    },
  };
}

async function waitForVideoContext(expectedVideoId, maxWait = 15000) {
  const step = 500;
  let waited = 0;

  while (waited < maxWait) {
    const currentVideoId = getCurrentVideoId();
    const watchReady = Boolean(
      document.querySelector('ytd-watch-flexy, ytd-watch-grid')
    );
    const titleReady = Boolean(document.title && document.title !== 'YouTube');

    if (currentVideoId === expectedVideoId && watchReady && titleReady) {
      await sleep(1200);
      return true;
    }

    await sleep(step);
    waited += step;
  }

  return false;
}

async function autoOpenTranscript() {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (await clickButtonByText(/показать текст|show transcript/i)) return true;

    const expandBtn = document.querySelector(
      'tp-yt-paper-button#expand, ytd-text-inline-expander #expand, #description-inline-expander #expand'
    );
    if (expandBtn) {
      expandBtn.click();
      await sleep(700);
      if (await clickButtonByText(/показать текст|show transcript/i)) return true;
    }

    const moreBtn = document.querySelector(
      'ytd-menu-renderer yt-icon-button#button button, #above-the-fold ytd-button-renderer button'
    );
    if (moreBtn) {
      moreBtn.click();
      await sleep(700);
      if (await clickButtonByText(/transcript|расшифров|текст видео/i)) {
        return true;
      }
    }

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
        await sleep(900);
        return true;
      }
    }

    await sleep(1200 * attempt);
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
  const newSegments = document.querySelectorAll(
    'transcript-segment-view-model'
  );
  if (newSegments.length > 0) {
    return Array.from(newSegments)
      .map(seg => {
        const textEl = seg.querySelector(
          "yt-core-attributed-string, [class*='SegmentText'], span[role='text']"
        );
        if (textEl) {
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

  const panel = document.querySelector(
    "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-searchable-transcript']"
  );
  if (panel) return cleanText(panel.innerText);

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
  return new Promise(resolve => setTimeout(resolve, ms));
}

function showToast(message, type = 'default') {
  const existing = document.getElementById('yt-transcript-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'yt-transcript-toast';
  toast.innerText = message;
  const isSuccess = type === 'success';
  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '32px',
    right: '32px',
    background: isSuccess ? '#16a34a' : '#0f0f0f',
    color: '#fff',
    padding: '12px 20px',
    borderRadius: '8px',
    fontSize: '14px',
    fontFamily: 'Roboto, sans-serif',
    zIndex: '999999',
    boxShadow: isSuccess
      ? '0 4px 16px rgba(22,163,74,0.35)'
      : '0 4px 16px rgba(0,0,0,0.4)',
    transition: 'opacity 0.4s',
    opacity: '1',
  });

  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 400);
  }, 3000);
}

function buildMetadata() {
  const title = document.title.replace(/ - YouTube$/, '').trim();
  const url = location.href;
  const video_id = new URL(url).searchParams.get('v') || 'unknown';
  const channelEl = document.querySelector('ytd-channel-name a');
  const channel = channelEl ? channelEl.innerText.trim() : 'unknown';
  const date = new Date().toISOString().slice(0, 10);

  return {
    title,
    channel,
    url,
    video_id,
    date,
  };
}

function getCurrentVideoId() {
  try {
    return new URL(location.href).searchParams.get('v') || 'unknown';
  } catch (_error) {
    return 'unknown';
  }
}

function transliterate(str) {
  const map = {
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'g',
    д: 'd',
    е: 'e',
    ё: 'e',
    ж: 'zh',
    з: 'z',
    и: 'i',
    й: 'y',
    к: 'k',
    л: 'l',
    м: 'm',
    н: 'n',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    у: 'u',
    ф: 'f',
    х: 'kh',
    ц: 'ts',
    ч: 'ch',
    ш: 'sh',
    щ: 'shch',
    ы: 'y',
    э: 'e',
    ю: 'yu',
    я: 'ya',
  };

  return str
    .toLowerCase()
    .split('')
    .map(ch => map[ch] || ch)
    .join('');
}

function buildFilename(meta) {
  const normalize = (str, maxLen) =>
    transliterate(str)
      .toLowerCase()
      .replace(/[^a-z0-9 -]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, maxLen);

  const author = normalize(meta.channel || 'unknown', 50);
  const slug = normalize(meta.title || `video-${meta.video_id}`, 80);

  return `yt_${author}_${slug}_${meta.date}.md`;
}

function buildMarkdown(meta, text) {
  return `---
title: "${meta.title}"
source: "youtube"
author: "${meta.channel}"
url: "${meta.url}"
date: "${meta.date}"
video_id: "${meta.video_id}"
---

# ${meta.title}

## Summary

## Transcript

${text}
`;
}

window.extractAndCopy = extractAndCopy;
window.extractAndSaveMarkdown = extractAndSaveMarkdown;
window.extractForBatch = extractForBatch;

// ============================================================================
// LTS (Local Transcription Service) polling — ADR-0006 / TASK-LTS
// ============================================================================
//
// content script is the polling host (per ADR-0006 §1) — it stays alive while
// the YouTube tab is open and is not subject to MV3 SW lifetime constraints.
// On `{type: 'lts-start', jobId}` from SW, kicks off a 5s setInterval that
// asks SW for job status. On `done`/`failed`, stops polling and tells SW
// to handle the terminal state. Content script does NOT touch clipboard —
// gesture is lost on async messaging in MV3 (ADR-0006 §2).
//
// UI feedback: green arrow SVG injected next to the YouTube title on
// lts-start, flashes 0.5s on each successful poll tick, replaced with a
// green checkmark on `done` or red cross on `failed`.

const LTS_POLL_INTERVAL_MS = 5000;
const LTS_FLASH_DURATION_MS = 500;
let ltsPollHandle = null;
let ltsActiveJobId = null;
let ltsFlashTimer = null;

function ltsStopPolling() {
  if (ltsPollHandle !== null) {
    clearInterval(ltsPollHandle);
    ltsPollHandle = null;
  }
  if (ltsFlashTimer !== null) {
    clearTimeout(ltsFlashTimer);
    ltsFlashTimer = null;
  }
  ltsActiveJobId = null;
}

function ltsFindTitle() {
  // YouTube watch-page title selectors — primary + fallback for SPA re-renders.
  return (
    document.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
    document.querySelector('#title h1 yt-formatted-string') ||
    document.querySelector('h1 yt-formatted-string')
  );
}

function ltsRemoveIndicator() {
  const title = ltsFindTitle();
  if (!title) return null;
  const existing = title.parentElement?.querySelector('.lts-arrow');
  if (existing) existing.remove();
  return title;
}

function ltsMakeSVG(pathD, stroke, opacity) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.classList.add('lts-arrow');
  svg.setAttribute(
    'style',
    `vertical-align: middle; margin-left: 8px; opacity: ${opacity}; transition: opacity 0.5s ease-in-out;`
  );
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathD);
  path.setAttribute('stroke', stroke);
  path.setAttribute('stroke-width', '2.5');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

// SVG path data: right-pointing arrow (→)
const LTS_ARROW_PATH = 'M4 12h14M14 6l6 6-6 6';
// SVG path data: checkmark (✓)
const LTS_CHECK_PATH = 'M5 13l4 4L19 7';
// SVG path data: cross (✗)
const LTS_CROSS_PATH = 'M6 6l12 12M18 6L6 18';

function ltsShowInTitle(state /* 'processing' | 'done' | 'failed' */) {
  const title = ltsRemoveIndicator();
  if (!title) {
    console.warn('[lts] UI: YouTube title not found, cannot inject indicator');
    return;
  }
  let svg;
  if (state === 'processing') {
    // Arrow starts hidden, will be flashed on each tick
    svg = ltsMakeSVG(LTS_ARROW_PATH, '#00C853', 0);
  } else if (state === 'done') {
    svg = ltsMakeSVG(LTS_CHECK_PATH, '#00C853', 1);
    svg.setAttribute('style', 'vertical-align: middle; margin-left: 8px;');
  } else if (state === 'failed') {
    svg = ltsMakeSVG(LTS_CROSS_PATH, '#D50000', 1);
    svg.setAttribute('style', 'vertical-align: middle; margin-left: 8px;');
  } else {
    return;
  }
  title.parentElement.appendChild(svg);
  console.log('[lts] UI: indicator injected, state=', state);
}

function ltsFlash() {
  const title = ltsFindTitle();
  if (!title) return;
  const arrow = title.parentElement.querySelector('.lts-arrow');
  if (!arrow) return;
  arrow.style.opacity = '1';
  if (ltsFlashTimer !== null) clearTimeout(ltsFlashTimer);
  ltsFlashTimer = setTimeout(() => {
    arrow.style.opacity = '0';
    ltsFlashTimer = null;
  }, LTS_FLASH_DURATION_MS);
}

async function ltsTick(jobId) {
  console.log('[lts] poll tick: jobId=', jobId);
  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ type: 'lts-poll', jobId });
  } catch (err) {
    console.warn('[lts] poll: sendMessage error:', err);
    ltsStopPolling();
    return;
  }
  if (!reply || !reply.ok) {
    console.warn('[lts] poll: error, reply=', reply);
    ltsStopPolling();
    return;
  }
  console.log('[lts] poll: status=', reply.status, 'jobId=', jobId);
  if (reply.status === 'done') {
    ltsStopPolling();
    ltsShowInTitle('done');
    console.log('[lts] poll: done -> send lts-result-ready, jobId=', jobId);
    chrome.runtime.sendMessage({ type: 'lts-result-ready', jobId }).catch(err => {
      console.warn('[lts] poll: send lts-result-ready failed:', err);
    });
  } else if (reply.status === 'failed') {
    ltsStopPolling();
    ltsShowInTitle('failed');
    console.log('[lts] poll: failed -> send lts-failed, jobId=', jobId);
    chrome.runtime.sendMessage({ type: 'lts-failed', jobId }).catch(err => {
      console.warn('[lts] poll: send lts-failed failed:', err);
    });
  } else {
    // queued / claimed / processing — flash indicator
    ltsFlash();
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'lts-clipboard-done' && typeof msg.wordCount === 'number') {
    showToast(`Скопировано! (~${msg.wordCount} слов)`, 'success');
    return false;
  }
  if (msg?.type === 'lts-clipboard-failed') {
    showToast('Ошибка LTS транскрипции', 'default');
    return false;
  }
  if (msg?.type !== 'lts-start' || typeof msg.jobId !== 'string') {
    return false;
  }
  console.log('[lts] received lts-start, jobId=', msg.jobId, 'interval=', LTS_POLL_INTERVAL_MS, 'ms');
  ltsStopPolling(); // defensive — kill any prior polling on this tab
  ltsShowInTitle('processing');
  ltsActiveJobId = msg.jobId;
  ltsPollHandle = setInterval(() => ltsTick(msg.jobId), LTS_POLL_INTERVAL_MS);
  // Fire first tick immediately so user sees feedback faster.
  ltsTick(msg.jobId);
  sendResponse({ accepted: true });
  return false; // sync response
});

window.addEventListener('beforeunload', () => {
  if (ltsPollHandle !== null) {
    console.log('[lts] beforeunload: stop polling, jobId=', ltsActiveJobId);
    ltsStopPolling();
  }
});

// URL change watcher — YouTube is an SPA, so navigating to a related video
// does NOT trigger a full page reload and the content-script instance
// survives. Without this, the green checkmark from the previous LTS job
// would sit next to the new title indefinitely. Three signal sources cover
// all SPA navigation paths:
//   - history.pushState/replaceState patch — YouTube's own navigation calls
//   - popstate — browser back/forward
//   - yt-navigate-finish — YouTube custom event, fires after DOM stabilizes
function watchLtsUrlChanges() {
  let lastUrl = location.href;
  const onUrlChange = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    console.log('[lts] URL changed, removing indicator, newUrl=', lastUrl);
    ltsRemoveIndicator();
  };
  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);
  history.pushState = function (...args) {
    const r = origPush(...args);
    onUrlChange();
    return r;
  };
  history.replaceState = function (...args) {
    const r = origReplace(...args);
    onUrlChange();
    return r;
  };
  window.addEventListener('popstate', onUrlChange);
  window.addEventListener('yt-navigate-finish', onUrlChange);
}
watchLtsUrlChanges();
