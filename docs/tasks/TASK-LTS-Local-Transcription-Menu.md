# TASK-LTS — Local Transcription Service menu integration

| Field        | Value                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| Depends on   | ADR-012 `Accepted` (vendored 2026-07-05); ADR-0006 `Proposed` (Tech Lead review passed 2026-07-05, smoke pending) |
| ADR          | ADR-0006 (`docs/adr/ADR-0006-lts-whisper-menu-integration.md`) — implementation of this ADR                       |
| Cross-refs   | ADR-0005 (`docs/adr/ADR-0005-localhost-api-orchestration.md`) — sibling localhost API, не пересекается            |
| Status       | DRAFT 2026-07-05 — pending dev dispatch                                                                          |

## 1. Goal

Реализовать в Chrome extension пункт контекстного меню **«🎙 Транскрибировать (LTS)»**, который для активной YouTube-вкладки запускает полный цикл локальной транскрипции через `local-transcription-service` (ADR-012) и копирует готовый transcript в clipboard.

ADR-0006 зафиксировал архитектуру (см. §«Решение» и §«Дизайн решения»). Этот task-doc — implementation-level спецификация: какие файлы трогаем, что в них пишем, как проверяем.

### 1.1 Что НЕ строим (decision matrix)

Эта итерация ограничена scope ADR-0006. Зафиксировано явно, чтобы следующий ревьюер не переоткрывал:

| Item | Verdict | Reason |
| --- | --- | --- |
| `chrome.storage.local` + options page для токена | **NO** | ADR-0006 §3 — overengineering для single-secret single-purpose. Token в `auth.json` файле вне git. |
| Token в `manifest.json` | **NO** | Репозиторий публичный. ADR-0006 §3. |
| Polling в service worker (chrome.alarms или async-loop) | **NO** | ADR-0006 §1 — `chrome.alarms` min period 30s (нужно 5s); async-loop в SW — серая зона MV3. |
| Polling в popup | **NO** | Пользователь хочет «сразу копировать», без UI. ADR-0006 §1. |
| Clipboard через content script + `navigator.clipboard.writeText` | **NO** | Static injection + lost gesture. Гарантированный `NotAllowedError`. ADR-0006 §2, альтернатива 9. |
| Clipboard через `chrome.scripting.executeScript` от SW message-handler | **NO** | Gesture inheritance не работает через новые events. ADR-0006 §2, альтернатива 10. |
| Clipboard через `document.execCommand('copy')` | **NO** (основной путь); **YES** (fallback внутри offscreen, см. §5) | ADR-0006 §2. |
| Textarea overlay на странице + user-triggered copy button | **NO** (основной путь); **YES** (fallback уровня acceptance gate, см. §5) | Требует второго клика, нарушает «сразу копировать». ADR-0006 §2, альтернатива 11. |
| Job history UI (последние N задач с transcript-path, ack-state) | **NO** | Не в скоупе этой итерации. ADR-0006 «Дальнейшее развитие». |
| Per-video language override | **NO** | Не в скоупе. ADR-0006 «Дальнейшее развитие». |
| CWS-публикация, миграция на options page | **NO** | Не в скоупе. ADR-0006 «Дальнейшее развитие». |
| CI / pre-commit hook для проверки `auth.json` не в git | **NO** | Выходит за scope. ADR-0006 §3 «Обязательные guardrails». |

## 2. Change-list по файлам

### 2.1 `manifest.json` (modify)

```diff
   "permissions": [
     "contextMenus",
     "clipboardWrite",
     "scripting",
     "downloads",
     "alarms",
     "storage",
-    "tabs"
+    "tabs",
+    "offscreen"
   ],
   "host_permissions": [
     "https://www.youtube.com/*",
-    "http://127.0.0.1:8765/*"
+    "http://127.0.0.1:8765/*",
+    "http://127.0.0.1:8766/*",
+    "http://192.168.0.99:8766/*"
   ]
```

**Обоснование**: `offscreen` — обязательный permission для `chrome.offscreen.createDocument` с reason `'CLIPBOARD'` (ADR-0006 §2, §4). Два host_permissions для `local-transcription-service` (`127.0.0.1:8766` loopback-режим + `192.168.0.99:8766` LAN-режим) прописываются сразу, чтобы не релизить manifest при первом переключении режима.

### 2.2 `offscreen.html` (new)

Новый файл в корне репозитория. Минимальный MV3 offscreen document, единственная задача — записать текст в clipboard через `navigator.clipboard.writeText`.

```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>LTS offscreen</title></head>
<body>
<script src="offscreen.js"></script>
</body>
</html>
```

### 2.3 `offscreen.js` (new)

```js
// LTS offscreen document. Created on-demand by background.js via
// chrome.offscreen.createDocument({url: 'offscreen.html', reasons: ['CLIPBOARD']}).
// Single responsibility: write text to clipboard from MV3 SW context
// where navigator.clipboard.writeText does NOT require user gesture.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'lts-copy') return false;

  (async () => {
    try {
      await navigator.clipboard.writeText(msg.text);
      sendResponse({ ok: true });
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
        sendResponse({ ok, fallback: 'execCommand', error: ok ? null : String(clipboardErr) });
      } catch (fallbackErr) {
        sendResponse({ ok: false, error: String(fallbackErr) });
      }
    }
  })();

  return true; // async response
});
```

### 2.4 `background.js` (modify)

Добавить:

- Чтение `auth.json` через `chrome.runtime.getURL` при `onInstalled` / `onStartup`, кэширование токена в module-scope.
- В `ensureContextMenus()` — пункт `lts-transcribe` «🎙 Транскрибировать (LTS)».
- `chrome.contextMenus.onClicked` handler для этого пункта — валидация YouTube URL, `POST /jobs`, badge update, `chrome.tabs.sendMessage` content-скрипту.
- `chrome.runtime.onMessage` listener с диспетчером по `type`: `lts-poll` → `GET /jobs/{id}`; `lts-result-ready` → `GET /jobs/{id}/result` → создать offscreen (если ещё нет) → отправить `lts-copy` в offscreen → ack; `lts-failed` → badge `✗`.
- Lifecycle offscreen: `chrome.offscreen.createDocument` лениво, переиспользование если уже создан, `chrome.offscreen.closeDocument()` не делаем (Chrome сам управляет lifecycle до перезапуска SW — лишние closeDocument/createDocument циклы хуже, чем держать offscreen постоянно).
- Badge cleanup в `onInstalled` / `onStartup` (сброс в пустую строку).

**Sketch структуры** (полная реализация — на разработчике, sketch показывает форму):

```js
const LTS_BASE_URL = 'http://192.168.0.99:8766';
const POLL_INTERVAL_MS = 5000;

let LTS_AUTH_TOKEN = null;
const activeJobs = new Map(); // tabId -> { jobId, intervalHandle }

// fetch works fine in MV3 SW for same-origin chrome-extension:// resources.
// XMLHttpRequest is NOT defined in SW context — must use fetch.
async function loadAuthToken() {
  try {
    const resp = await fetch(chrome.runtime.getURL('auth.json'));
    if (!resp.ok) {
      throw new Error(`auth.json HTTP ${resp.status}`);
    }
    const data = await resp.json();
    if (typeof data.LTS_AUTH_TOKEN !== 'string' || data.LTS_AUTH_TOKEN.length < 16) {
      throw new Error('LTS_AUTH_TOKEN missing or shorter than 16 chars');
    }
    LTS_AUTH_TOKEN = data.LTS_AUTH_TOKEN;
  } catch (err) {
    console.error('[lts] failed to load auth.json:', err);
    chrome.action.setBadgeText({ text: '⚠' });
    LTS_AUTH_TOKEN = null;
  }
}

async function ensureOffscreen() {
  // chrome.offscreen.hasDocument exists in MV3, check before creating.
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['CLIPBOARD'],
    justification: 'Write LTS transcript to clipboard from MV3 SW context',
  });
}

async function ltsSubmit(tabId, videoUrl) {
  const resp = await fetch(`${LTS_BASE_URL}/jobs`, {
    method: 'POST',
    headers: {
      'X-Auth-Token': LTS_AUTH_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ video_url: videoUrl }),
  });
  if (!resp.ok) throw new Error(`POST /jobs ${resp.status}`);
  const { job_id } = await resp.json();
  chrome.action.setBadgeText({ tabId, text: '⏳' });
  chrome.tabs.sendMessage(tabId, { type: 'lts-start', jobId: job_id });
}

async function ltsGetResult(tabId, jobId) {
  await ensureOffscreen();
  const resp = await fetch(`${LTS_BASE_URL}/jobs/${jobId}/result`, {
    headers: { 'X-Auth-Token': LTS_AUTH_TOKEN },
  });
  if (!resp.ok) throw new Error(`GET /jobs/{id}/result ${resp.status}`);
  const text = await resp.text();
  const reply = await chrome.runtime.sendMessage({ type: 'lts-copy', text });
  if (!reply?.ok) {
    chrome.action.setBadgeText({ tabId, text: '⚠' });
    console.error('[lts] clipboard write failed:', reply?.error);
    return false;
  }
  chrome.action.setBadgeText({ tabId, text: '✓' });
  // Fire-and-forget ack — failure here is logged but does not block UI feedback.
  fetch(`${LTS_BASE_URL}/jobs/${jobId}/ack`, {
    method: 'POST',
    headers: { 'X-Auth-Token': LTS_AUTH_TOKEN },
  }).catch(err => console.warn('[lts] ack failed:', err));
  return true;
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'lts-transcribe') return;
  if (!tab?.id) return;
  if (!LTS_AUTH_TOKEN) {
    chrome.action.setBadgeText({ tabId: tab.id, text: '⚠' });
    return;
  }
  // Allow-list per ADR-0006 §7 — defensive even though service validates too.
  let host;
  try { host = new URL(tab.url).host; } catch { return; }
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) {
    return;
  }
  ltsSubmit(tab.id, tab.url).catch(err => {
    console.error('[lts] submit failed:', err);
    chrome.action.setBadgeText({ tabId: tab.id, text: '✗' });
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'lts-poll') {
    fetch(`${LTS_BASE_URL}/jobs/${msg.jobId}`, {
      headers: { 'X-Auth-Token': LTS_AUTH_TOKEN },
    })
      .then(r => r.json())
      .then(state => sendResponse({ ok: true, status: state.status, error: state.error }))
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (msg?.type === 'lts-result-ready') {
    ltsGetResult(msg.senderTabId || _sender?.tab?.id, msg.jobId)
      .then(ok => sendResponse({ ok }))
      .catch(err => {
        console.error('[lts] result handling failed:', err);
        sendResponse({ ok: false, error: String(err) });
      });
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(async () => {
  await loadAuthToken();
  await ensureContextMenus();
  chrome.action.setBadgeText({ text: '' });
});

chrome.runtime.onStartup.addListener(async () => {
  await loadAuthToken();
  chrome.action.setBadgeText({ text: '' });
});
```

**Замечания к реализации**:

- `tabId` в `lts-result-ready` — content script должен передать свой `tab.id` явно, потому что `chrome.runtime.onMessage` в MV3 SW не получает `sender.tab` для всех message types (зависит от extension API surface). В sketch выше — fallback на `_sender?.tab?.id`.
- Badge text `''` означает «нет badge» (clear). Chrome `setBadgeText` с пустой строкой очищает.
- `fetch` без `await` для ack — fire-and-forget, чтобы UI feedback (`✓`) не блокировался на ack.

### 2.5 `content.js` (modify)

Добавить:

- Listener на `{type: 'lts-start', jobId}` — запуск `setInterval(5000)`, polling SW через `chrome.runtime.sendMessage({type: 'lts-poll', jobId})`.
- При получении `status: 'done'` — остановить interval, отправить SW `{type: 'lts-result-ready', jobId}`.
- При получении `status: 'failed'` — остановить interval, отправить SW `{type: 'lts-failed', jobId}`.
- Cleanup при `beforeunload` / `pageshow` — если interval активен, останавливать и уведомлять SW (best-effort, не критично).

**Sketch**:

```js
// Append to existing content.js. Coexists with current extractAndCopy
// / extractAndSaveMarkdown / extractForBatch / window functions; do not
// touch those.

let ltsPollHandle = null;

function ltsStopPolling() {
  if (ltsPollHandle !== null) {
    clearInterval(ltsPollHandle);
    ltsPollHandle = null;
  }
}

async function ltsTick(jobId) {
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'lts-poll', jobId });
    if (!reply?.ok) {
      ltsStopPolling();
      return;
    }
    if (reply.status === 'done') {
      ltsStopPolling();
      chrome.runtime.sendMessage({ type: 'lts-result-ready', jobId }).catch(() => {});
    } else if (reply.status === 'failed') {
      ltsStopPolling();
      chrome.runtime.sendMessage({ type: 'lts-failed', jobId }).catch(() => {});
    }
    // queued / claimed / processing — keep polling
  } catch (err) {
    console.warn('[lts] poll error:', err);
    ltsStopPolling();
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'lts-start' || typeof msg.jobId !== 'string') return false;
  ltsStopPolling(); // defensive — kill any prior polling on this tab
  ltsPollHandle = setInterval(() => ltsTick(msg.jobId), 5000);
  // Fire first tick immediately so user gets feedback faster.
  ltsTick(msg.jobId);
  sendResponse({ accepted: true });
  return false; // sync response
});

window.addEventListener('beforeunload', () => {
  ltsStopPolling();
});
```

### 2.6 `auth.json.example` (new)

```json
{
  "LTS_AUTH_TOKEN": "<your-token-min-16-chars>"
}
```

Один файл в корне репозитория. В README — инструкция «скопируйте в `auth.json` и подставьте реальный токен».

### 2.7 `.gitignore` (modify)

```diff
 # User
 notes.md
 content_v*.js
+auth.json
```

Единственная добавка — `auth.json`. Никаких glob'ов (файл всегда в корне).

### 2.8 `README.md` (modify)

Добавить секцию **«First-time setup»** между текущим концом файла и секцией «Requirements» (если есть). Минимум:

```markdown
## First-time setup

Это расширение использует локальный STT-сервис
[`local-transcription-service`](../_Others/0703_local-transcription-service/README.md).
Для работы пункта меню «🎙 Транскрибировать (LTS)» нужен одноразовый setup:

1. Скопируйте шаблон: `cp auth.json.example auth.json`
2. Подставьте реальный `LTS_AUTH_TOKEN` из `$HOME/.lts-env` на Mac Mini
   (значение переменной `LTS_AUTH_TOKEN`, длина ≥16 символов).
3. Reload расширения в `chrome://extensions`.

Если `auth.json` отсутствует или токен некорректный — пункт меню возвращает
no-op, badge показывает `⚠`, в console SW — ошибка `[lts] failed to load auth.json`.

## Токен НЕ коммитится

`auth.json` в `.gitignore`. В репозитории только `auth.json.example` с
placeholder-значением. При случайном коммите — `git rm --cached auth.json`
и ротация токена (BLG-003 в репо сервиса).
```

## 3. Acceptance criteria по design-решениям ADR-0006

| # | ADR-0006 § | Критерий | Как проверить |
| --- | --- | --- | --- |
| 1 | §1 polling host | Polling живёт в content.js через `setInterval(5000)`, не в SW. | Открыть DevTools → content script → console: видим `[lts] poll error` / etc. Открыть SW console: НЕ видим polling logs. |
| 2 | §2 clipboard через offscreen | **Новый LTS clipboard path** использует только `navigator.clipboard.writeText` в `offscreen.js`. Pre-existing `copyToClipboard` в `content.js` (для DOM-extraction flow, существующие пункты меню «📋 Скопировать транскрипт») остаётся как есть — он вызывается через `chrome.scripting.executeScript` из контекстного меню onClicked с user gesture в synchronous цепочке, что работает в MV3. | `grep navigator.clipboard.writeText offscreen.js` — есть. `grep navigator.clipboard.writeText background.js` — пусто. `grep navigator.clipboard.writeText content.js` — есть только в существующей `copyToClipboard` (line 274, до этой задачи). |
| 3 | §2 offscreen lifecycle | `chrome.offscreen.hasDocument()` проверяется перед `createDocument`. Повторные `POST /jobs` не создают новый offscreen. | Submit двух job'ов подряд → SW console: один `createDocument`, далее `hasDocument() === true`. |
| 4 | §3 token storage | `LTS_AUTH_TOKEN` читается из `auth.json` через `chrome.runtime.getURL`, кэшируется в module-scope. `auth.json` в `.gitignore`. | `grep auth.json .gitignore` — `auth.json` rule присутствует. `git status` после setup — `auth.json` НЕ появляется в untracked. |
| 5 | §3 example template | `auth.json.example` в репо, `auth.json` — нет. | `ls auth.json*` — оба файла. `cat .gitignore` — `auth.json` rule. |
| 6 | §4 permissions | `manifest.json` содержит `offscreen` в `permissions` и два новых `host_permissions`. | `cat manifest.json` — оба пункта присутствуют. |
| 7 | §5 base URL | `LTS_BASE_URL` хардкод в `background.js`, не в `auth.json`, не в `chrome.storage`. | `grep LTS_BASE_URL background.js` — один occurrence. `grep -r LTS_BASE_URL auth.json.example` — пусто. |
| 8 | §6 badge feedback | `⏳` после submit, `✓` после clipboard+ack, `✗` после failed, `⚠` после auth error. `''` после `onStartup`/`onInstalled`. | Manual: пройти 4 сценария (submit успешный, failed job, auth.json удалить, browser restart), смотреть badge. |
| 9 | §7 contract | `POST /jobs` body строго `{video_url: string}`, `X-Auth-Token` на каждом fetch. | `grep -E "video_url|fetch.*LTS_BASE_URL" background.js` — body shape корректный. |
| 10 | §8 error envelope | Парсер различает `{code, message}` (наш envelope) и `{detail: [...]}` (FastAPI 422). | Manual: вызвать `POST /jobs` с `{"video_url": "not-a-url"}` → badge `⚠`, console ошибка. |
| 11 | Manifest не сломан | После всех правок `manifest.json` валиден для Chrome. | Открыть `chrome://extensions` → Developer mode → Load unpacked → ошибок нет. |

## 4. Smoke-план (ручной)

**Setup**:

1. На Mac Mini: убедиться, что `local-transcription-service` запущен (`curl http://192.168.0.99:8766/health` → `200`).
2. Скопировать токен из `$HOME/.lts-env` (`grep ^LTS_AUTH_TOKEN ~/.lts-env`).
3. В репо расширения: `cp auth.json.example auth.json`, вписать токен.
4. `chrome://extensions` → Developer mode → Load unpacked → выбрать корень репозитория.

**Тест 1 — happy path** (Acceptance gate для ADR-0006 §2):

1. Открыть YouTube-видео БЕЗ встроенного транскрипта (любое с отключёнными субтитрами).
2. Правая кнопка → «🎙 Транскрибировать (LTS)».
3. Ожидание: badge `⏳` появляется на icon расширения.
4. Подождать ~10-60 секунд (зависит от длины видео).
5. Ожидание: badge → `✓`.
6. Открыть любую другую вкладку, вставить (`Ctrl+V`).
7. **Проверка**: transcript видео вставлен в clipboard. **Это acceptance gate для ADR-0006 §5.1.**

**Тест 2 — offscreen lifecycle**:

1. Повторить Тест 1 дважды подряд (дождаться `✓`, потом снова правая кнопка → меню).
2. SW console: один `createDocument`, далее `hasDocument() === true` (логировать в SW для отладки).

**Тест 3 — failed job**:

1. Открыть YouTube-видео, чей URL заведомо не обрабатывается (например, удалённое видео).
2. Правая кнопка → «🎙 Транскрибировать (LTS)».
3. Ожидание: badge → `✗` через ~30s (после `max_attempts=2`).

**Тест 4 — auth missing**:

1. `rm auth.json`.
2. Reload расширения в `chrome://extensions`.
3. Правая кнопка → «🎙 Транскрибировать (LTS)».
4. Ожидание: badge → `⚠`, SW console → `[lts] failed to load auth.json`.

**Тест 5 — browser restart**:

1. После Тест 1 (badge `✓`), закрыть Chrome.
2. Открыть Chrome.
3. Ожидание: badge пустой (cleanup в `onStartup`).

## 5. Pending: ADR-0006 acceptance gate

ADR-0006 зафиксировал жёсткий acceptance gate для clipboard (см. ADR §«Acceptance gate»). Этот gate прогоняется на Тест 1 выше. Результат:

- **PASS** → ADR-0006 переводится в `Accepted`, статус задачи → `DONE`.
- **FAIL (writeText бросил, fallback execCommand тоже не сработал)** → ADR-0006 остаётся в `Proposed`, открывается ADR-0007 «Textarea overlay fallback» (третий клик — нарушение UX, требует пересмотра).

Smoke-прогон не делается автором этого task-doc (нельзя прогнать реальный Chrome из CI/agent'а). Прогон делает разработчик после имплементации, перед merge.

## 6. Что НЕ делаем в этой итерации (для будущих task-doc'ов)

- Job history UI (ADR-0006 «Дальнейшее развитие»).
- Per-video language override.
- CWS-публикация, миграция на options page.
- CI / pre-commit hook для проверки `auth.json` не в git.
- Error envelope v2 (дополнительные коды от сервиса, например `STT_RATE_LIMITED` — ждём от сервисной команды).

## 7. References

- `docs/adr/ADR-0006-lts-whisper-menu-integration.md` — основной архитектурный документ.
- `docs/adr/ADR-012-local-transcription-pipeline.md` — vendored upstream (статус `Accepted`).
- `docs/adr/ADR-0005-localhost-api-orchestration.md` — sibling localhost API, не пересекается.
- `../_Others/0703_local-transcription-service/docs/api-contract.md` — wire contract сервиса.
- `../_Others/0703_local-transcription-service/docs/openapi.json` — OpenAPI 3.1 спек сервиса.
- `../_Others/0703_local-transcription-service/README.md` — деплой и конфиг сервиса на Mac Mini.