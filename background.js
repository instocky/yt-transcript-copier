const API_BASE = 'http://127.0.0.1:8765';
const ALARM_NAME = 'ytt-batch-poll';
const STORAGE_KEY = 'batchRunnerState';
const PAGE_LOAD_TIMEOUT_MS = 45000;
const EXECUTION_TIMEOUT_MS = 90000;
const DOWNLOAD_TIMEOUT_MS = 30000;
const ALARM_PERIOD_MINUTES = 0.5;
const FALLBACK_INTER_JOB_DELAY_MS = 7000;

// --- LTS (Local Transcription Service) integration (ADR-0006, TASK-LTS) ---
const LTS_BASE_URL = 'http://192.168.0.99:8766';
const LTS_YT_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
]);
const LTS_BADGE = {
  PROCESSING: '⏳',
  DONE: '✓',
  FAILED: '✗',
  AUTH_ERROR: '⚠',
};
const LTS_MIN_TOKEN_LEN = 16;

// Module-scope cached token. Loaded once at onInstalled/onStartup.
// null means "auth.json missing or invalid" — menu item becomes no-op.
let LTS_AUTH_TOKEN = null;

// Snapshot of tab.title + tab.url captured at lts-transcribe click time.
// Used by handleLtsResultReady so the clipboard payload matches the format
// of the DOM-extract "Скопировать транскрипт" path:
//   {title}\n{url}\n\n{transcript}
// Cleared on terminal state (done/failed) and on tab.onRemoved.
const ltsSubmitMeta = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  await ensureContextMenus();
  await ensureAlarm();
  await loadAuthToken();
  await clearLtsBadge();
  void processBatchQueue();
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrapBackground();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) {
    void processBatchQueue();
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;

  if (info.menuItemId === 'copy-yt-transcript') {
    void runNamedActionOnTab(tab.id, 'extractAndCopy');
  }

  if (info.menuItemId === 'save-yt-markdown') {
    void runNamedActionOnTab(tab.id, 'extractAndSaveMarkdown');
  }

  if (info.menuItemId === 'lts-transcribe') {
    void handleLtsTranscribeClick(tab.id, tab.url);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'DOWNLOAD_MD') {
    void downloadMarkdown(msg.payload.filename, msg.payload.content)
      .then(result => sendResponse(result))
      .catch(error => {
        sendResponse({
          ok: false,
          error: serializeError(error, 'DOWNLOAD_ERROR', true),
        });
      });
    return true;
  }

  if (msg?.type === 'lts-poll' && typeof msg.jobId === 'string') {
    console.log('[lts] onMessage: lts-poll, jobId=', msg.jobId, 'from tabId=', sender?.tab?.id);
    void ltsGetJobStatus(msg.jobId)
      .then(state => {
        console.log('[lts] onMessage: lts-poll reply, jobId=', msg.jobId, 'status=', state.status);
        sendResponse({ ok: true, status: state.status, error: state.error });
      })
      .catch(error => {
        console.error('[lts] onMessage: lts-poll failed,', error);
        sendResponse({ ok: false, error: String(error) });
      });
    return true;
  }

  if (msg?.type === 'lts-result-ready' && typeof msg.jobId === 'string') {
    const tabId = sender?.tab?.id;
    console.log('[lts] onMessage: lts-result-ready, jobId=', msg.jobId, 'tabId=', tabId);
    void handleLtsResultReady(tabId, msg.jobId)
      .then(ok => {
        console.log('[lts] onMessage: lts-result-ready reply, ok=', ok);
        sendResponse({ ok });
      })
      .catch(error => {
        console.error('[lts] result handling failed:', error);
        sendResponse({ ok: false, error: String(error) });
      });
    return true;
  }

  if (msg?.type === 'lts-failed' && typeof msg.jobId === 'string') {
    const tabId = sender?.tab?.id;
    console.log('[lts] onMessage: lts-failed, jobId=', msg.jobId, 'tabId=', tabId);
    void setLtsBadge(tabId, LTS_BADGE.FAILED);
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

// Safety net: if the user closes the YouTube tab while LTS is polling,
// drop the snapshot so the Map doesn't grow unbounded. handleLtsResultReady
// already deletes on terminal state, this covers the case where polling
// never finishes because the tab is gone.
chrome.tabs.onRemoved.addListener(tabId => {
  if (ltsSubmitMeta.has(tabId)) {
    console.log('[lts] tab removed: dropping snapshot, tabId=', tabId);
    ltsSubmitMeta.delete(tabId);
  }
});

async function bootstrapBackground() {
  await ensureContextMenus();
  await ensureAlarm();
  await loadAuthToken();
  await clearLtsBadge();

  const state = await getRunnerState();
  if (state.processing) {
    await patchRunnerState({ processing: false, workerLock: null });
  }

  void processBatchQueue();
}

async function ensureContextMenus() {
  await chrome.contextMenus.removeAll();

  chrome.contextMenus.create({
    id: 'copy-yt-transcript',
    title: '📋 Скопировать транскрипт',
    contexts: ['page'],
    documentUrlPatterns: ['https://www.youtube.com/*'],
  });

  chrome.contextMenus.create({
    id: 'save-yt-markdown',
    title: '⬇️ Сохранить как Markdown',
    contexts: ['page'],
    documentUrlPatterns: ['https://www.youtube.com/*'],
  });

  // ADR-0006 / TASK-LTS — local STT fallback for videos without built-in transcript.
  chrome.contextMenus.create({
    id: 'lts-transcribe',
    title: '🎙 Транскрибировать (LTS)',
    contexts: ['page'],
    documentUrlPatterns: ['https://www.youtube.com/*'],
  });
}

async function ensureAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: ALARM_PERIOD_MINUTES,
  });
}

async function processBatchQueue() {
  const lockId = await acquireSingleFlight();
  if (!lockId) return;

  try {
    const health = await fetchHealth();
    if (!health.ok) {
      return;
    }

    while (true) {
      const job = await fetchNextJob();
      if (!job) {
        break;
      }

      const startedAt = new Date().toISOString();
      await setActiveJob({
        ...job,
        started_at: startedAt,
      });

      await reportStatus(job, {
        status: 'in_progress',
        started_at: startedAt,
      });

      const completed = await executeJob(job, startedAt);
      await reportStatus(job, completed.reportPayload);
      await clearActiveJob(completed.statePatch);
      await sleep(job.inter_job_delay_ms || FALLBACK_INTER_JOB_DELAY_MS);
    }
  } catch (error) {
    console.error('Batch processing loop failed:', error);
  } finally {
    await releaseSingleFlight(lockId);
  }
}

async function executeJob(job, startedAt) {
  const startTime = Date.now();

  try {
    const tabId = await openManagedTab(job.url);
    await updateActiveJob({ tabId });
    await waitForTabComplete(tabId, PAGE_LOAD_TIMEOUT_MS);

    const artifact = await withTimeout(
      runBatchExtraction(tabId, getVideoIdFromUrl(job.url)),
      EXECUTION_TIMEOUT_MS,
      () => createError('TIMEOUT', 'Истек execution timeout', true)
    );

    if (!artifact?.ok) {
      throw createErrorFromPayload(
        artifact?.error,
        'DOM_ERROR',
        'Не удалось извлечь транскрипт',
        true
      );
    }

    const download = await downloadMarkdown(artifact.filename, artifact.markdown);
    if (!download.ok) {
      throw createErrorFromPayload(
        download.error,
        'DOWNLOAD_ERROR',
        'Не удалось сохранить Markdown',
        true
      );
    }

    const finishedAt = new Date().toISOString();
    return {
      reportPayload: {
        status: 'done',
        filename: artifact.filename,
        result: {
          title: artifact.meta?.title || null,
          video_id: artifact.meta?.video_id || null,
          url: artifact.meta?.url || job.url,
          markdown: artifact.markdown,
          transcript: artifact.transcript,
        },
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: Date.now() - startTime,
        error: null,
      },
      statePatch: {
        lastResult: {
          job_id: job.job_id,
          status: 'done',
          finished_at: finishedAt,
        },
      },
    };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    return {
      reportPayload: {
        status: 'error',
        filename: null,
        result: null,
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: Date.now() - startTime,
        error: serializeError(error, 'UNKNOWN', true),
      },
      statePatch: {
        lastResult: {
          job_id: job.job_id,
          status: 'error',
          finished_at: finishedAt,
          error: serializeError(error, 'UNKNOWN', true),
        },
      },
    };
  }
}

async function openManagedTab(url) {
  const state = await getRunnerState();
  const existingTabId = state.managedTabId;

  if (existingTabId) {
    try {
      await chrome.tabs.update(existingTabId, { url, active: true });
      return existingTabId;
    } catch (error) {
      console.warn('Managed tab is unavailable, creating a new one:', error);
    }
  }

  const tab = await chrome.tabs.create({ url, active: true });
  await patchRunnerState({ managedTabId: tab.id });
  return tab.id;
}

async function waitForTabComplete(tabId, timeoutMs) {
  const existing = await chrome.tabs.get(tabId);
  if (existing.status === 'complete') {
    return;
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(createError('TIMEOUT', 'Страница YouTube не загрузилась вовремя', true));
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function runNamedActionOnTab(tabId, fnName) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  });

  await chrome.scripting.executeScript({
    target: { tabId },
    func: name => {
      if (typeof window[name] === 'function') {
        window[name]();
      }
    },
    args: [fnName],
  });
}

async function runBatchExtraction(tabId, expectedVideoId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  });

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async videoId => {
      if (typeof window.extractForBatch === 'function') {
        return window.extractForBatch(videoId);
      }

      return {
        ok: false,
        error: {
          type: 'DOM_ERROR',
          message: 'Batch extractor is unavailable',
          retryable: true,
        },
      };
    },
    args: [expectedVideoId],
  });

  return result?.result;
}

async function downloadMarkdown(filename, content) {
  return new Promise(resolve => {
    const dataUrl =
      'data:text/markdown;charset=utf-8,' + encodeURIComponent(content);

    chrome.downloads.download(
      {
        url: dataUrl,
        filename,
        conflictAction: 'uniquify',
        saveAs: false,
      },
      downloadId => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            error: {
              type: 'DOWNLOAD_ERROR',
              message: chrome.runtime.lastError.message,
              retryable: true,
            },
          });
          return;
        }

        const timer = setTimeout(() => {
          chrome.downloads.onChanged.removeListener(listener);
          resolve({
            ok: false,
            error: {
              type: 'TIMEOUT',
              message: 'Истек timeout ожидания завершения download',
              retryable: true,
            },
          });
        }, DOWNLOAD_TIMEOUT_MS);

        const listener = delta => {
          if (delta.id !== downloadId || !delta.state?.current) {
            return;
          }

          if (delta.state.current === 'complete') {
            clearTimeout(timer);
            chrome.downloads.onChanged.removeListener(listener);
            resolve({ ok: true, downloadId, filename });
          }

          if (delta.state.current === 'interrupted') {
            clearTimeout(timer);
            chrome.downloads.onChanged.removeListener(listener);
            resolve({
              ok: false,
              error: {
                type: 'DOWNLOAD_ERROR',
                message: 'Загрузка была прервана',
                retryable: true,
              },
            });
          }
        };

        chrome.downloads.onChanged.addListener(listener);
      }
    );
  });
}

async function fetchHealth() {
  try {
    const response = await fetch(`${API_BASE}/health`);
    return {
      ok: response.ok,
      status: response.status,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error,
    };
  }
}

async function fetchNextJob() {
  const response = await fetch(`${API_BASE}/next`);
  if (response.status === 204) {
    return null;
  }

  if (!response.ok) {
    throw createError('NETWORK', `Локальный API вернул ${response.status}`, true);
  }

  return response.json();
}

async function reportStatus(job, payload) {
  try {
    await fetch(`${API_BASE}/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        batch_id: job.batch_id,
        job_id: job.job_id,
        url: job.url,
        attempt: job.attempt,
        ...payload,
      }),
    });
  } catch (error) {
    console.warn('Failed to report batch job status:', error);
  }
}

async function acquireSingleFlight() {
  const state = await getRunnerState();
  if (state.processing) {
    return null;
  }

  const lockId = `lock-${Date.now()}`;
  await patchRunnerState({
    processing: true,
    workerLock: {
      id: lockId,
      acquiredAt: new Date().toISOString(),
    },
  });

  return lockId;
}

async function releaseSingleFlight(lockId) {
  const state = await getRunnerState();
  if (state.workerLock?.id !== lockId) {
    return;
  }

  await patchRunnerState({
    processing: false,
    workerLock: null,
  });
}

async function setActiveJob(job) {
  await patchRunnerState({
    activeJob: job,
  });
}

async function updateActiveJob(patch) {
  const state = await getRunnerState();
  if (!state.activeJob) return;

  await patchRunnerState({
    activeJob: {
      ...state.activeJob,
      ...patch,
    },
  });
}

async function clearActiveJob(extraPatch = {}) {
  await patchRunnerState({
    activeJob: null,
    ...extraPatch,
  });
}

async function getRunnerState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return (
    stored[STORAGE_KEY] || {
      processing: false,
      workerLock: null,
      activeJob: null,
      managedTabId: null,
      lastResult: null,
    }
  );
}

async function patchRunnerState(patch) {
  const current = await getRunnerState();
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      ...current,
      ...patch,
    },
  });
}

function withTimeout(promise, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        reject(onTimeout());
      } catch (error) {
        reject(error);
      }
    }, timeoutMs);

    promise
      .then(result => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch(error => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function createError(type, message, retryable) {
  return { type, message, retryable };
}

function createErrorFromPayload(payload, fallbackType, fallbackMessage, retryable) {
  if (payload?.type && payload?.message) {
    return {
      type: payload.type,
      message: payload.message,
      retryable: payload.retryable ?? retryable,
    };
  }

  return createError(fallbackType, fallbackMessage, retryable);
}

function serializeError(error, fallbackType, retryable) {
  if (!error) {
    return createError(fallbackType, 'Unknown error', retryable);
  }

  if (error.type && error.message) {
    return {
      type: error.type,
      message: error.message,
      retryable: error.retryable ?? retryable,
    };
  }

  if (error instanceof Error) {
    return {
      type: fallbackType,
      message: error.message,
      retryable,
    };
  }

  return {
    type: fallbackType,
    message: String(error),
    retryable,
  };
}

function getVideoIdFromUrl(url) {
  try {
    return new URL(url).searchParams.get('v') || 'unknown';
  } catch (_error) {
    return 'unknown';
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// LTS (Local Transcription Service) integration — ADR-0006 / TASK-LTS
// ============================================================================
//
// Architecture (see ADR-0006 §0):
//   - content script polls job status every 5s via `lts-poll` messages
//   - on done, content sends `lts-result-ready`; SW fetches transcript text,
//     writes it to clipboard via an offscreen document (navigator.clipboard
//     works without user gesture in offscreen reason='CLIPBOARD' context),
//     then fires `POST /ack`
//   - on failed, content sends `lts-failed`; SW just paints badge ✗
//
// Token storage: `auth.json` (gitignored) at extension root, read once via
// fetch on `chrome.runtime.getURL('auth.json')` and cached in LTS_AUTH_TOKEN
// (module scope). MV3 SW supports fetch() to chrome-extension:// URLs
// (same-origin extension resources), but XMLHttpRequest is NOT defined in
// SW context — must use fetch.
// If absent/invalid, LTS_AUTH_TOKEN stays null and the menu item
// becomes a no-op with badge ⚠.
//
// All LTS operations log to console with `[lts]` prefix for debugging.
// Filter in DevTools console: `[lts]`.

async function loadAuthToken() {
  const url = chrome.runtime.getURL('auth.json');
  console.log('[lts] loadAuthToken: start, url=', url);
  try {
    const resp = await fetch(url);
    console.log('[lts] loadAuthToken: fetch resolved, status=', resp.status, 'ok=', resp.ok);
    if (!resp.ok) {
      throw new Error(`auth.json HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const token = data?.LTS_AUTH_TOKEN;
    if (typeof token !== 'string' || token.length < LTS_MIN_TOKEN_LEN) {
      throw new Error(
        `LTS_AUTH_TOKEN missing or shorter than ${LTS_MIN_TOKEN_LEN} chars (got type=${typeof token}, len=${token?.length})`
      );
    }
    LTS_AUTH_TOKEN = token;
    console.log('[lts] loadAuthToken: token loaded, length=', token.length);
  } catch (err) {
    console.error('[lts] failed to load auth.json:', err);
    LTS_AUTH_TOKEN = null;
  }
}

async function ensureOffscreen() {
  const alreadyExists = await chrome.offscreen.hasDocument();
  console.log('[lts] ensureOffscreen: hasDocument=', alreadyExists);
  if (alreadyExists) return;
  console.log('[lts] ensureOffscreen: creating offscreen document');
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['CLIPBOARD'],
    justification: 'Write LTS transcript to clipboard from MV3 SW context',
  });
  console.log('[lts] ensureOffscreen: created');
}

async function setLtsBadge(tabId, text) {
  console.log('[lts] badge: tabId=', tabId, 'text=', JSON.stringify(text));
  if (typeof tabId === 'number') {
    await chrome.action.setBadgeText({ tabId, text });
  } else {
    await chrome.action.setBadgeText({ text });
  }
}

async function clearLtsBadge() {
  console.log('[lts] badge: clear (global)');
  await chrome.action.setBadgeText({ text: '' });
}

function isYouTubeHost(urlString) {
  try {
    const host = new URL(urlString).host;
    return LTS_YT_HOSTS.has(host);
  } catch (_error) {
    return false;
  }
}

async function ltsFetch(path, init = {}) {
  if (!LTS_AUTH_TOKEN) {
    throw new Error('LTS_AUTH_TOKEN not loaded — auth.json missing or invalid');
  }
  const headers = {
    'X-Auth-Token': LTS_AUTH_TOKEN,
    ...(init.headers || {}),
  };
  if (init.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const url = `${LTS_BASE_URL}${path}`;
  const method = init.method || 'GET';
  console.log('[lts] fetch:', method, url);
  const resp = await fetch(url, { ...init, headers });
  console.log('[lts] fetch:', method, url, '->', resp.status);
  return resp;
}

async function ltsSubmit(videoUrl) {
  console.log('[lts] submit: videoUrl=', videoUrl);
  const resp = await ltsFetch('/jobs', {
    method: 'POST',
    body: JSON.stringify({ video_url: videoUrl }),
  });
  if (!resp.ok) {
    const errBody = await safeReadJson(resp);
    const errMsg = `POST /jobs ${resp.status}: ${errBody?.message || errBody?.detail || resp.statusText}`;
    console.error('[lts] submit: failed,', errMsg, 'body=', errBody);
    throw new Error(errMsg);
  }
  const data = await resp.json();
  if (typeof data.job_id !== 'string') {
    console.error('[lts] submit: no job_id in response, body=', data);
    throw new Error('POST /jobs returned no job_id');
  }
  console.log('[lts] submit: ok, job_id=', data.job_id, 'status=', data.status, 'poll_url=', data.poll_url);
  return data.job_id;
}

async function ltsGetJobStatus(jobId) {
  const resp = await ltsFetch(`/jobs/${jobId}`);
  if (!resp.ok) {
    console.error('[lts] getJobStatus: failed,', resp.status);
    throw new Error(`GET /jobs/{id} ${resp.status}`);
  }
  const state = await resp.json();
  console.log('[lts] getJobStatus: job_id=', jobId, 'status=', state.status, 'attempt=', state.attempt);
  return state;
}

async function ltsGetTranscript(jobId) {
  const resp = await ltsFetch(`/jobs/${jobId}/result`);
  if (!resp.ok) {
    console.error('[lts] getTranscript: failed,', resp.status);
    throw new Error(`GET /jobs/{id}/result ${resp.status}`);
  }
  const text = await resp.text();
  console.log('[lts] getTranscript: job_id=', jobId, 'text length=', text.length, 'preview=', JSON.stringify(text.slice(0, 80)));
  return text;
}

async function ltsAck(jobId) {
  console.log('[lts] ack: POST /jobs/', jobId, '/ack (fire-and-forget)');
  try {
    const resp = await ltsFetch(`/jobs/${jobId}/ack`, { method: 'POST' });
    if (!resp.ok) {
      console.warn(`[lts] ack HTTP ${resp.status} for job ${jobId}`);
    } else {
      console.log('[lts] ack: ok, job_id=', jobId);
    }
  } catch (err) {
    console.warn(`[lts] ack failed for job ${jobId}:`, err);
  }
}

async function ltsWriteClipboard(text) {
  console.log('[lts] clipboard: ensureOffscreen, send lts-copy to offscreen, text length=', text.length);
  await ensureOffscreen();
  const reply = await chrome.runtime.sendMessage({ type: 'lts-copy', text });
  console.log('[lts] clipboard: offscreen reply=', reply);
  if (!reply || typeof reply.ok !== 'boolean') {
    throw new Error('offscreen did not reply');
  }
  if (!reply.ok) {
    throw new Error(reply.error || 'clipboard write failed');
  }
  return reply;
}

async function safeReadJson(resp) {
  try {
    return await resp.json();
  } catch (_error) {
    return null;
  }
}

async function sendLtsStartToContent(tabId, jobId) {
  // Race condition guard: if extension was reloaded but YouTube tab was not,
  // content script on the tab is stale (no lts-start listener). sendMessage
  // fails with "Could not establish connection". Inject content.js, give
  // the listener a moment to register, then retry.
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'lts-start', jobId });
    console.log('[lts] sendLtsStartToContent: sent on first try');
    return;
  } catch (firstErr) {
    console.warn(
      '[lts] sendLtsStartToContent: first attempt failed, injecting content.js:',
      firstErr.message
    );
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch (injectErr) {
    console.error('[lts] sendLtsStartToContent: inject failed:', injectErr);
    throw injectErr;
  }
  // Small delay so the injected script can register its onMessage listener.
  await new Promise(r => setTimeout(r, 150));
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'lts-start', jobId });
    console.log('[lts] sendLtsStartToContent: sent after inject');
  } catch (secondErr) {
    console.error(
      '[lts] sendLtsStartToContent: retry after inject failed:',
      secondErr
    );
    throw secondErr;
  }
}

async function handleLtsTranscribeClick(tabId, tabUrl) {
  console.log('[lts] menu click: tabId=', tabId, 'url=', tabUrl);
  if (!LTS_AUTH_TOKEN) {
    await setLtsBadge(tabId, LTS_BADGE.AUTH_ERROR);
    console.warn('[lts] menu click: auth token missing — click ignored');
    return;
  }
  if (!isYouTubeHost(tabUrl)) {
    console.warn('[lts] menu click: not a YouTube host, ignored');
    return;
  }
  // Snapshot tab.title at click time so the eventual clipboard payload matches
  // what "Скопировать транскрипт" would have produced (DOM-extract reads title
  // on click). If the user changes the video mid-poll we still report the
  // title they actually clicked on. Best-effort: if tab lookup fails (closed
  // before snapshot), fall back to url-only.
  try {
    const tab = await chrome.tabs.get(tabId);
    ltsSubmitMeta.set(tabId, {
      title: (tab?.title || '').replace(/ - YouTube$/, '').trim(),
      url: tabUrl || tab?.url || '',
    });
    console.log('[lts] menu click: snapshot title=', ltsSubmitMeta.get(tabId).title);
  } catch (snapErr) {
    console.warn('[lts] menu click: tab snapshot failed (closed?):', snapErr?.message || snapErr);
    ltsSubmitMeta.set(tabId, { title: '', url: tabUrl || '' });
  }
  let jobId = null;
  try {
    await setLtsBadge(tabId, LTS_BADGE.PROCESSING);
    jobId = await ltsSubmit(tabUrl);
    console.log('[lts] menu click: send lts-start to content, job_id=', jobId);
    await sendLtsStartToContent(tabId, jobId);
  } catch (err) {
    console.error('[lts] menu click: submit/notify failed:', err);
    if (jobId) {
      console.error(
        '[lts] menu click: job_id=', jobId,
        'created server-side but content script did not pick it up. Transcript may be stuck.',
        'User should reload YouTube tab and re-trigger, or wait for ack timeout.'
      );
    }
    await setLtsBadge(tabId, LTS_BADGE.FAILED);
    chrome.tabs
      .sendMessage(tabId, { type: 'lts-clipboard-failed' })
      .catch(() => {});
  }
}

async function handleLtsResultReady(tabId, jobId) {
  console.log('[lts] result-ready: tabId=', tabId, 'job_id=', jobId);
  try {
    const text = await ltsGetTranscript(jobId);
    const payload = await ltsFormatTranscript(tabId, text);
    await ltsWriteClipboard(payload);
    await setLtsBadge(tabId, LTS_BADGE.DONE);
    await ltsAck(jobId);
    // Fire-and-forget toast signal — content shows "Скопировано! (~NN слов)"
    // matching the DOM-extract path. sendMessage rejects if tab is gone
    // or content script is stale; either way the user is not on the page,
    // so silent failure is the correct outcome.
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    chrome.tabs
      .sendMessage(tabId, { type: 'lts-clipboard-done', wordCount })
      .catch(err =>
        console.warn('[lts] toast: send failed (tab closed?):', err?.message || err)
      );
    console.log('[lts] result-ready: completed ok, job_id=', jobId, 'bytes=', payload.length, 'words=', wordCount);
    return true;
  } catch (err) {
    console.error('[lts] result-ready: failed,', err);
    await setLtsBadge(tabId, LTS_BADGE.AUTH_ERROR);
    chrome.tabs
      .sendMessage(tabId, { type: 'lts-clipboard-failed' })
      .catch(() => {});
    return false;
  }
}

// Prepend {title}\n{url}\n to the raw transcript so LTS clipboard format
// matches the DOM-extract "Скопировать транскрипт" path. Snapshot was
// captured at click time in handleLtsTranscribeClick. If the tab is gone or
// snapshot is empty (closed before snapshot, no title, no url), fall back
// to the raw transcript — user waited for it, don't lose the result.
async function ltsFormatTranscript(tabId, text) {
  const meta = ltsSubmitMeta.get(tabId);
  if (meta) ltsSubmitMeta.delete(tabId);
  const lines = [meta?.title, meta?.url].filter(Boolean);
  if (lines.length === 0) {
    console.log('[lts] format: no snapshot meta, transcript only, length=', text.length);
    return text;
  }
  console.log('[lts] format: title=', lines[0], 'has_url=', Boolean(lines[1]));
  return `${lines.join('\n')}\n\n${text}`;
}

