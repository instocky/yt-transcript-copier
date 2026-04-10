const API_BASE = 'http://127.0.0.1:8765';
const ALARM_NAME = 'ytt-batch-poll';
const STORAGE_KEY = 'batchRunnerState';
const PAGE_LOAD_TIMEOUT_MS = 45000;
const EXECUTION_TIMEOUT_MS = 90000;
const DOWNLOAD_TIMEOUT_MS = 30000;
const ALARM_PERIOD_MINUTES = 0.5;
const FALLBACK_INTER_JOB_DELAY_MS = 7000;

chrome.runtime.onInstalled.addListener(async () => {
  await ensureContextMenus();
  await ensureAlarm();
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
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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

  return false;
});

async function bootstrapBackground() {
  await ensureContextMenus();
  await ensureAlarm();

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

