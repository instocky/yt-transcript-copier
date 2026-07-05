# ADR-0006 — Интеграция меню «🎙 Транскрибировать (LTS)» с local-transcription-service

## Status

**Accepted** (2026-07-05).

### Блокирующая зависимость

ADR-0006 ссылается на ADR-012 как на upstream-контракт (`X-Auth-Token`, 4 endpoint'а, polling cadence, state machine). ADR-012 был в статусе `Proposed` (`Deciders: TBD`, `docs/adr/ADR-012-local-transcription-pipeline.md:5-8`) на момент написания ADR-0006.

**2026-07-05 update**: ADR-012 в репозитории сервиса принят Tech Lead'ом; vendored-копия в этом репо синхронизирована со статусом `Accepted`. **Блокирующая зависимость снята.**

ADR-0006 **остаётся в `Proposed`** до прохождения acceptance gate на clipboard (см. ниже). Task-doc и имплементация начинаются параллельно — smoke на acceptance gate прогоняется на готовой имплементации, после чего ADR-0006 переводится в `Accepted`.

**2026-07-05 acceptance gate PASS** (см. «Acceptance gate для clipboard» ниже). ADR-0006 переведён в `Accepted`.

### Acceptance gate для clipboard

§2 «Clipboard UX» опирается на следующую архитектурную предпосылку, которую необходимо проверить до перевода ADR-0006 в `Accepted`:

**Цепочка вызовов в реализации** (см. §2 и поток выполнения):

1. User click на пункте меню → `chrome.contextMenus.onClicked` (gesture есть в SW-handler). SW делает `POST /jobs`, получает `job_id`, badge `⏳`.
2. SW шлёт `chrome.tabs.sendMessage` content-скрипту `{type: 'lts-start', jobId}`. **Gesture уже теряется** на этой границе — `chrome.tabs.sendMessage` не наследует gesture в MV3.
3. Content script запускает `setInterval(5000)`. На каждой итерации шлёт SW `{type: 'lts-poll', jobId}`.
4. SW poll handler (новый message event) делает `GET /jobs/{jobId}` → status. Возвращает content'у.
5. Когда `status === 'done'`, content шлёт SW `{type: 'lts-result-ready', jobId}`. **Это новый event в SW — gesture от onClicked давно истёк (10-60 секунд polling'а).**
6. SW result-ready handler делает `GET /jobs/{jobId}/result` → text.
7. SW создаёт offscreen document через `chrome.offscreen.createDocument({url: 'offscreen.html', reasons: ['CLIPBOARD'], justification: '...'})` (если ещё не создан — Chrome кэширует).
8. SW шлёт offscreen'у `chrome.runtime.sendMessage({type: 'lts-copy', text})`.
9. **Внутри offscreen** вызывается `navigator.clipboard.writeText(text)`. **Этот API не требует user gesture в offscreen-контексте с reason `'CLIPBOARD'`** — документированное поведение MV3 для этого reason.
10. Offscreen возвращает `{ok: true/false}`. SW: если `true` → badge `✓`, делает ack; если `false` → badge `⚠`, не делает ack (файл остаётся на диске, retry возможен).
11. SW делает `POST /jobs/{jobId}/ack` (cleanup).

**Что проверяется в smoke-тесте**:

1. На YouTube-видео без транскрипта в Chrome ≥ 100 пройти полный цикл submit → done → clipboard и убедиться, что `navigator.clipboard.writeText()` в offscreen **реально записал текст** (вставить в любую другую вкладку и увидеть результат). Длительность smoke — не более часа.
2. Проверить, что `chrome.offscreen.createDocument` не падает на `reason: 'CLIPBOARD'` и не возвращает ошибку про missing permission.
3. Проверить lifecycle: offscreen создаётся on-demand, переиспользуется для повторных операций, закрывается через `chrome.offscreen.closeDocument()` когда не нужен.
4. Если `writeText` бросил или вернул `false` — попробовать `document.execCommand('copy')` внутри offscreen как fallback (offscreen тоже имеет DOM API, gesture не требуется для legacy API в любом контексте).
5. Если и fallback не работает — ADR-0006 пересматривается: либо добавляется §X «textarea overlay с user-triggered copy button» (требует второго клика от пользователя, не «сразу»), либо пересматривается §1 (polling в SW через async-loop + offscreen создаётся сразу в onClicked handler и живёт до готовности). Без подтверждённого clipboard-пути ADR-0006 **не может быть принят**.

**Результат smoke-теста 2026-07-05**:

- Пункт 1 — **PASS через fallback**: `navigator.clipboard.writeText()` в offscreen вернул ошибку (focus/permission policy в этой версии Chrome); fallback `document.execCommand('copy')` сработал успешно; transcript (20097 символов) реально оказался в clipboard (подтверждено через `Ctrl+V` в другой вкладке).
- Пункт 2 — **PASS**: `chrome.offscreen.createDocument({reasons: ['CLIPBOARD']})` создал документ без ошибок.
- Пункт 3 — **PASS** (только создание, не закрытие): offscreen создан on-demand при первом `lts-result-ready`, переиспользован (в логах только одно `creating offscreen document` за всю сессию).
- Пункт 4 — **PASS**: fallback отработал штатно, см. `offscreen.js`.
- Пункт 5 — **N/A**: fallback сработал, пересмотр не требуется.

**Эмпирическое наблюдение**: `navigator.clipboard.writeText()` в offscreen с reason `'CLIPBOARD'` может падать в некоторых Chrome-версиях (focus-policy / permission-policy в offscreen context не считается 'focused document'). Fallback `document.execCommand('copy')` через временный `<textarea>` работает стабильно. Это **известное расхождение** с документацией, рекомендуется **всегда** реализовывать двухуровневый fallback в offscreen clipboard-паттерне. Заложено в `offscreen.js`.

ADR-0006 переведён в `Accepted` на основании положительного результата smoke-теста. Основная предпосылка (offscreen document как единственный надёжный путь для clipboard из MV3 SW) подтверждена; необходимость двухуровневого fallback — уточнение, не противоречие.

---

## Контекст

Текущее расширение извлекает транскрипт YouTube через DOM-манипуляции внутри уже открытой вкладки. Это быстро и бесплатно, но имеет принципиальное ограничение: работает только для видео, у которых **уже есть YouTube-транскрипт** (auto-generated или загруженный автором). Видео без транскрипта, регионально-заблокированные, либо с отключёнными субтитрами — расширение возвращает ошибку `NO_TRANSCRIPT` (или эквивалент), и пользователь остаётся без результата.

Параллельно в инфраструктуре уже развёрнут локальный сервис STT — `local-transcription-service` (см. ADR-012, vendored в `docs/adr/ADR-012-local-transcription-pipeline.md`). Сервис работает на Mac Mini (LAN `192.168.0.99:8766`), использует `whisper.cpp` за `LiteLLM Proxy`, принимает YouTube URL, прогоняет через yt-dlp → ffmpeg → STT, возвращает готовый транскрипт.

Сервис уже отвечает требованиям к контракту (см. `docs/api-contract.md` в репо сервиса), но **ни одно расширение к нему сейчас не подключено** — это первый интеграционный клиент.

Целевой сценарий:

- пользователь на странице YouTube-видео без встроенного транскрипта
- правая кнопка → контекстное меню → «🎙 Транскрибировать (LTS)»
- расширение отправляет URL в локальный сервис, ожидает готовности, копирует результат в буфер обмена
- пользователь вставляет результат туда, куда ему нужно

Ограничения и вводные:

- расширение публикуется в публичном git-репозитории — токены коммитить **нельзя**
- расширение работает на MV3 — service worker спит, `chrome.alarms` имеет минимальный период 30 секунд
- существующая интеграция с localhost API (ADR-0005, `127.0.0.1:8765`) — отдельный сервис для batch-оркестрации, не пересекается по контракту и по endpoint'ам
- сервис STT использует `X-Auth-Token` shared secret (≥16 chars), trust model зафиксирован в HLD сервиса §14

---

## Решение

Добавить в `chrome.contextMenus` пункт **«🎙 Транскрибировать (LTS)»**, который для активной YouTube-вкладки запускает полный цикл локальной транскрипции:

```
submit URL → poll (5s) → fetch result → copy to clipboard → ack
```

Архитектурно — это **четырёхсторонняя** схема (content script ↔ service worker ↔ offscreen document ↔ local-transcription-service), где:

- **Service worker** (`background.js`) делает HTTP-вызовы к сервису, маршрутизирует сообщения, создаёт offscreen document для clipboard write и делает ack. Не держит долгих таймеров.
- **Content script** (`content.js`, уже инжектится на `https://www.youtube.com/*`) крутит polling-loop с интервалом 5 секунд. **Не делает clipboard write** — gesture теряется на async message chain в MV3.
- **Offscreen document** (`offscreen.html`) — специальный MV3-контекст для операций, требующих DOM API без user gesture. Создаётся SW on-demand для записи transcript в clipboard через `navigator.clipboard.writeText()`. Документированный паттерн для clipboard в MV3.
- **Auth token** живёт в файле `auth.json` в корне расширения, файл `.gitignore`'нут. Service worker читает его один раз при старте через `chrome.runtime.getURL('auth.json')` и кэширует в module-scope.

Это решение выбрано вместо (а) полностью сервер-side polling, (б) popup-based UI, (в) token в `chrome.storage.local` через options page, (г) clipboard через `chrome.scripting.executeScript` от SW message-handler — обоснование см. в «Рассмотренные альтернативы».

---

## Архитектура

```text
┌─────────────────────────────┐
│ YouTube tab (MV3 page)      │
│ ┌─────────────────────────┐ │
│ │ content.js              │ │
│ │  • setInterval 5000ms   │ │
│ │  • polling host only    │ │
│ │    (no clipboard)       │ │
│ └──────────▲──────────────┘ │
│            │ sendMessage    │
│            │ (start/poll/   │
│            │  result-ready) │
└────────────┼────────────────┘
             │
             ▼
┌─────────────────────────────┐         ┌──────────────────────────────┐
│ background.js (SW, MV3)     │  HTTPS  │ local-transcription-service  │
│  • POST /jobs               │ ──────▶ │ http://192.168.0.99:8766      │
│  • GET  /jobs/{id}          │  X-Auth │  /health, /ready, /jobs,      │
│  • GET  /jobs/{id}/result   │  Token  │  /jobs/{id}, /jobs/{id}/result│
│  • POST /jobs/{id}/ack      │ ◀────── │  /jobs/{id}/ack               │
│  • chrome.action badge      │  JSON   └──────────────────────────────┘
│  • chrome.offscreen.*       │
└──────────┬──────────────────┘
           │ createDocument
           │ + sendMessage
           ▼
┌─────────────────────────────┐
│ offscreen.html (MV3)        │
│  • navigator.clipboard      │
│    .writeText(text)         │
│  • no user gesture needed   │
│  • reason: 'CLIPBOARD'      │
└─────────────────────────────┘
             ▲
             │ auth.json
             │ (gitignored, chrome.runtime.getURL)
             │
   ┌─────────┴──────────┐
   │ auth.json          │
   │ {LTS_AUTH_TOKEN}   │
   └────────────────────┘
```

Поток выполнения для одного клика по пункту меню:

1. **SW onClicked**: валидирует URL активной вкладки (должен быть YouTube host), `POST /jobs` с `{video_url}`, получает `job_id`, обновляет `chrome.action.setBadgeText({text: "⏳"})`, отправляет в content `chrome.tabs.sendMessage(tabId, {type: 'lts-start', jobId})`.
2. **content start**: запускает `setInterval(5000)`, в каждой итерации шлёт SW `{type: 'lts-poll', jobId}`.
3. **SW poll**: `GET /jobs/{jobId}`, возвращает content'у `{status, transcript?, error?}`. **Не** делает `GET /jobs/{id}/result` — только статус.
4. **content poll**: если `status === 'done'` → останавливает interval, шлёт SW `{type: 'lts-result-ready', jobId}`. Если `status === 'failed'` → останавливает interval, шлёт SW `{type: 'lts-failed', jobId}` для badge update. **Content script не делает clipboard write.**
5. **SW result-ready** (новый message event — **gesture от onClicked уже утрачен**): делает `GET /jobs/{jobId}/result` → text. Создаёт offscreen document через `chrome.offscreen.createDocument({url: 'offscreen.html', reasons: ['CLIPBOARD'], justification: 'Write LTS transcript to clipboard'})` (если уже не создан). Шлёт offscreen'у `chrome.runtime.sendMessage({target: 'offscreen', type: 'lts-copy', text})`. Дожидается ответа `ok: true/false`. Если `false` — badge `⚠`, лог, **не** делаем ack (файл остаётся на диске, можно retry). Если `true` → badge `✓`, делаем ack. **Закрываем offscreen** через `chrome.offscreen.closeDocument()` если не планируем ещё операций в ближайшее время.
6. **SW ack**: `POST /jobs/{jobId}/ack`. Cleanup.

Cleanup state при `onStartup` / `onInstalled`: сбрасывает badge в пустую строку, закрывает offscreen если открыт.

---

## Дизайн решения

### 1. Где живёт polling

**Решение**: polling в `content.js` через `setInterval(5000)`.

**Почему не SW**:

- `chrome.alarms` имеет минимальный период 30 секунд (`periodInMinutes: 0.5`). Polling 5 секунд через alarms **невозможен**.
- Async-loop внутри SW-handler (`await new Promise(r => setTimeout(r, 5000))`) — серая зона MV3. Пока есть pending promise, SW не уснёт, но после ~30 секунд бездействия Chrome может убить процесс. Для коротких видео (10-30s) работает, для длинных — рискованно.

**Почему не popup**:

- Пользователь хочет «сразу копировать», без отдельного UI.
- Popup живёт пока открыт, но требует второго клика после context menu.

Content script уже инжектится на `https://www.youtube.com/*` и стабильно живёт пока вкладка открыта. Это **самый дешёвый и надёжный** хост для 5-секундного polling.

### 2. Clipboard UX

**Решение**: Service worker создаёт **offscreen document** через `chrome.offscreen.createDocument({url: 'offscreen.html', reasons: ['CLIPBOARD'], justification: 'Write LTS transcript to clipboard from MV3 service worker'})` и шлёт ему `chrome.runtime.sendMessage({type: 'lts-copy', text})`. Внутри offscreen вызывается `navigator.clipboard.writeText(text)` — этот API **не требует user gesture** в offscreen-контексте с reason `'CLIPBOARD'`. Это документированный MV3-паттерн именно для clipboard-операций из service worker.

**Почему не `navigator.clipboard.writeText()` из content script**:

Content script статически инжектится через `manifest.json:content_scripts.matches`, не через `chrome.scripting.executeScript`. К моменту, когда content script получил бы сообщение через `chrome.runtime.onMessage` и вызвал `navigator.clipboard.writeText(text)`, user gesture от context menu click уже **потерян** по двум причинам:

1. `chrome.tabs.sendMessage` в MV3 не наследует gesture в принимающий context (флаг `userGesture` убран из MV3 API surface; в MV2 был deprecated, в MV3 удалён).
2. Сам async-handler `chrome.runtime.onMessage` в content script выполняется вне оригинального gesture scope — gesture живёт только в `chrome.contextMenus.onClicked` handler в SW, и только в течение ~5 секунд после оригинального клика, без «нескольких async-границ».

Это значит, что `navigator.clipboard.writeText()` из content script через эту цепочку **гарантированно** вернёт `NotAllowedError` в Chrome ≥ 100 — не «может не сработать», а «не сработает». Это блокирующее ограничение MV3 для статически-инжектированных content scripts.

**Почему не `chrome.scripting.executeScript` от SW message-handler**:

Предыдущая итерация ADR-0006 опиралась на `chrome.scripting.executeScript({target: {tabId}, func: copyToClipboard})` из SW `chrome.runtime.onMessage` handler'а, ссылаясь на «может наследоваться в пределах ~5s». Это было ошибочное утверждение: `chrome.runtime.onMessage` в SW — это **новый event**, спустя произвольное время (polling 5s × N итераций). Оригинальный gesture от `chrome.contextMenus.onClicked` истёк задолго до того, как `executeScript` был бы вызван. Документация Chrome про «may inherit within ~5s» относится к случаю, когда `executeScript` вызывается **синхронно из того же handler chain**, а не из отдельного message event'а.

**Почему offscreen document**:

- `chrome.offscreen.createDocument` с reason `'CLIPBOARD'` — **специально** созданный MV3 API для clipboard-операций из service worker.
- `navigator.clipboard.writeText()` внутри offscreen **не требует user gesture** — это документированное поведение для reason `'CLIPBOARD'`.
- Lifecycle: создаём offscreen on-demand, закрываем после использования. Если уже создан — переиспользуем (Chrome кэширует до closeDocument).
- Manifest permission: добавить `"offscreen"` в `permissions` массив.
- Стоимость: +30-40 строк boilerplate (offscreen.html + lifecycle в SW), одно дополнительное manifest permission. Это **единственный** надёжный путь в MV3.

**Почему не deprecated `document.execCommand('copy')` через executeScript от onClicked**:

Предыдущая итерация ADR-0006 предлагала `document.execCommand('copy')` через `chrome.scripting.executeScript`. Это работает только если `executeScript` вызывается **синхронно из `chrome.contextMenus.onClicked`** до потери gesture. Но в нашем flow `executeScript` вызывается **позже**, в отдельном `chrome.runtime.onMessage` handler'е, после polling и готовности transcript — gesture давно утрачен. Вариант требовал бы переноса polling в SW (что отклонено в §1), и даже тогда не давал 100% гарантии. Offscreen document — документированный и предсказуемый путь.

**Почему не `chrome.clipboard.set()` (новый Clipboard API для extensions)**: экспериментальный, требует дополнительных permissions, не даёт преимуществ перед offscreen для нашего use case.

Подтверждение работы offscreen-пути — acceptance gate в начале документа. Без положительного smoke-теста ADR-0006 остаётся в `Proposed`.

### 3. Token storage — `auth.json`

**Решение**: файл `auth.json` в корне расширения, `.gitignore`'нут.

```json
{
  "LTS_AUTH_TOKEN": "<shared-secret-min-16-chars>"
}
```

Service worker читает через `fetch(chrome.runtime.getURL('auth.json'))` при старте, кэширует в module-scope. Если файл отсутствует — SW логирует ошибку и badge показывает `⚠`, пункт меню возвращает `undefined` (no-op).

В репозиторий коммитится **только** `auth.json.example` как шаблон с placeholder-значением.

**Обязательные guardrails** (часть change-list будущего task-doc, без них ADR не считается реализованным):

- В `.gitignore` добавить правило `auth.json` — единственная строка, никаких glob-ов (файл всегда в корне).
- Создать `auth.json.example` в корне репозитория с placeholder-значением и комментарием «скопируйте в `auth.json` и подставьте реальный токен».
- В README расширения отдельная секция «First-time setup» с командами копирования.
- В CI / pre-commit hook — НЕ добавляем (текущий проект не имеет CI; добавление hook'а выходит за scope этого ADR и должно идти отдельным решением).

**Почему не `chrome.storage.local`**: требует setup-UI (options page или lazy popup) для первичного ввода. Это +50 строк UI без выгоды.

**Почему не `manifest.json`**: репозиторий публичный.

**Почему не build-step injection**: overengineering для internal tool.

### 4. `host_permissions` и `permissions`

Добавить в `manifest.json`:

```json
"host_permissions": [
  "https://www.youtube.com/*",
  "http://127.0.0.1:8765/*",
  "http://127.0.0.1:8766/*",
  "http://192.168.0.99:8766/*"
],
"permissions": [
  "contextMenus",
  "clipboardWrite",
  "scripting",
  "downloads",
  "alarms",
  "storage",
  "tabs",
  "offscreen"
]
```

Два адреса для `local-transcription-service` (`127.0.0.1:8766` и `192.168.0.99:8766`) — на случай loopback-режима разработки (`LTS_BIND_HOST=127.0.0.1`) и продового LAN-режима (default `LTS_BIND_HOST=192.168.0.99` per HLD сервиса §14). Оба прописываются сразу, чтобы не релизить manifest при первом переключении режима.

`offscreen` — обязательный permission для `chrome.offscreen.createDocument` (см. §2). `clipboardWrite` уже есть в текущем манифесте, оставлен для будущих use-кейсов (например, content-script clipboard через user gesture, если потребуется fallback).

### 5. Base URL

Хардкод в `background.js`:

```js
const LTS_BASE_URL = 'http://192.168.0.99:8766';
```

Не выносим в `auth.json` и не делаем options page — base URL это не секрет, он совпадает с default `LTS_BIND_HOST` сервиса. Если адрес поменяется — правим в одном месте.

### 6. Badge feedback

Использовать `chrome.action.setBadgeText()` / `setBadgeBackgroundColor()` для статуса:

| Состояние | Badge text | Цвет фона |
| --- | --- | --- |
| submit отправлен | `⏳` | синий |
| transcript готов, скопирован | `✓` | зелёный |
| job failed | `✗` | красный |
| token / config error | `⚠` | жёлтый |
| idle | `''` | (пусто) |

Badge сбрасывается в пустую строку при `chrome.runtime.onStartup` и `chrome.runtime.onInstalled` — иначе будет висеть вечно после рестарта браузера.

### 7. Контракт с сервисом

Используем только четыре endpoint'а из `docs/api-contract.md` сервиса:

- `POST /jobs` — submit
- `GET /jobs/{job_id}` — poll
- `GET /jobs/{job_id}/result` — fetch text
- `POST /jobs/{job_id}/ack` — cleanup

Все требуют `X-Auth-Token`. Validation contract:

- `video_url` host ∈ {`youtube.com`, `www.youtube.com`, `m.youtube.com`, `youtu.be`} — иначе 422.
- `extra = "forbid"` — payload строго `{video_url}`.
- Poll cadence ~5s (рекомендация HLD §8).
- `POST /ack` только для `done`; на `failed` → 409 → просто игнорируем.

### 8. Error handling

Внутренний error envelope от сервиса — `{code, message, retryable}`. FastAPI 422 envelope — `{detail: [...]}`. Парсер должен различать оба:

- 4xx/5xx с JSON-телом, в котором есть `code` → наш формат
- 4xx/5xx с JSON-телом, в котором есть `detail` → FastAPI, не пытаемся парсить как наш
- 4xx/5xx без JSON-тела → generic `{code: 'HTTP_<status>', message: <statusText>}`

Все ошибки логируются в `console.error` с префиксом `[lts]` и проброшены в badge как `⚠` или `✗` в зависимости от фазы.

---

## Связь с существующими ADR

### ADR-0005 (localhost-api-orchestration)

Не пересекается функционально:

| | ADR-0005 | ADR-0006 |
| --- | --- | --- |
| Сервис | `127.0.0.1:8765` (`batch_server.py`) | `192.168.0.99:8766` (`local-transcription-service`) |
| Назначение | batch-оркестрация экспорта | локальный STT fallback |
| Endpoint'ы | `/jobs`, `/next`, `/report`, `/health` | `/jobs`, `/jobs/{id}`, `/jobs/{id}/result`, `/jobs/{id}/ack`, `/health`, `/ready` |
| Auth | нет | `X-Auth-Token` |
| State host | SW (alarm-based) | content script (setInterval) |

Оба используют `http://127.0.0.1:8765/*` / `http://192.168.0.99:8766/*` в `host_permissions` — дополняют друг друга, конфликта нет.

### ADR-012 (local-transcription-pipeline, vendored)

Подчинённое отношение с блокирующей зависимостью (см. «Блокирующая зависимость» в начале документа). ADR-012 описывает (предложено к принятию, статус `Proposed`):

- trust model (`X-Auth-Token` shared secret)
- контракт API (4 endpoint'а выше)
- polling cadence (~5s)
- state machine (`queued → claimed → processing → done | failed`)

ADR-0006 **не пересматривает** ни одно из этих решений, только описывает extension-side клиента. Любое изменение trust model или контракта должно идти через новый сервис-side ADR, после чего vendored-копия в этом репо обновляется, и ADR-0006 пересматривается на совместимость.

---

## Последствия

### Плюсы

- Расширение получает **универсальный** transcript fallback — работает для видео без YouTube-субтитров
- Polling в content script стабилен (не зависит от MV3 SW lifetime)
- Token storage невидим для git, прост для ротации (правка файла + reload расширения)
- Архитектура минимально invasive: добавляется один пункт меню, два manifest-разрешения, ~150 строк кода в `background.js` + `content.js`
- Не ломает существующие пункты меню (DOM-extraction) и ADR-0005 (batch-оркестрацию)

### Минусы

- Зависимость от доступности LAN-сервиса `192.168.0.99:8766` — если Mac Mini выключен, badge показывает `⚠` после клика, пользователь разочарован. Это сознательный trade-off (см. альтернативы).
- Hardcoded IP в manifest — при смене Mac Mini придётся релизить новую версию расширения. Приемлемо для single-LAN-deployment.
- Token в `auth.json` означает: пользователь должен вручную создать файл при первом клоне. Документируем в README + commit-message шаблона.
- Решение clipboard требует offscreen document (`chrome.offscreen.createDocument` с reason `'CLIPBOARD'`). Это +30-40 строк boilerplate (offscreen.html + lifecycle в SW), одно дополнительное manifest permission (`offscreen`), и отдельный управляемый lifecycle (создание on-demand, переиспользование, закрытие). Это **единственный** надёжный путь в MV3, не зависящий от user gesture inheritance.

### Operational

- Деплой расширения: `git pull` → создать `auth.json` (один раз) → reload в `chrome://extensions`
- Ротация токена: править `auth.json` + `sudo launchctl kickstart` на сервисной стороне + reload расширения
- Диагностика: `chrome://extensions` → service worker → Console (фильтр `[lts]`) + badge на icon

---

## Рассмотренные альтернативы

### 1. Token в `manifest.json`

Отклонено: репозиторий публичный, токен утечёт в git history навсегда. Даже с `git filter-repo` постфактум — все форки и архивы уже будут содержать.

### 2. Token в `chrome.storage.local` через options page

Отклонено: требует полноценной options page в manifest (минимум +50 строк UI). Для single-secret single-purpose интеграции — overengineering. Если в будущем добавятся другие настройки — пересмотрим.

### 3. Token в `chrome.storage.local` через lazy popup

Отклонено: требует transient UI при первом запуске, что ломает «сразу копировать» UX. Пользователь не хочет popup, он хочет menu click → clipboard.

### 4. Polling в service worker (через async loop)

Отклонено: серая зона MV3, не гарантировано для длинных видео (60s+). См. §1 «Дизайна решения».

### 5. Polling в chrome.alarms

Отклонено: `periodInMinutes: 0.5` = 30 секунд, не соответствует требованию 5 секунд.

### 6. Polling в popup-странице

Отклонено: пользователь не хочет popup. См. §1.

### 7. Cloud STT вместо local (cloud fallback)

Не рассматривается: ADR-012 уже зафиксировал отказ от облачных STT-альтернатив. Это архитектурное решение, не пересматривается на уровне extension-клиента.

### 8. Content script polling + chrome.notifications вместо clipboard

Отклонено: пользователь хочет clipboard. Notification — это fallback, который имеет смысл только если clipboard не сработает.

### 9. Clipboard через content script + `navigator.clipboard.writeText()`

Отклонено по двум причинам:

1. Content script статически инжектится через `manifest.json:content_scripts.matches`, не через `chrome.scripting.executeScript`. Поэтому у него нет inherited gesture по построению.
2. `chrome.tabs.sendMessage` в MV3 не наследует gesture в принимающий context (флаг `userGesture` убран из MV3 API surface). К моменту, когда content script получил бы `{type: 'lts-result', text}` и вызвал `navigator.clipboard.writeText(text)`, gesture от context menu click уже потерян.

Это значит, что `navigator.clipboard.writeText()` из content script через цепочку polling → `chrome.runtime.sendMessage` → content.onMessage **гарантированно** вернёт `NotAllowedError` в Chrome ≥ 100. Это не «может не сработать», это «не сработает».

### 10. Clipboard через `chrome.scripting.executeScript` от SW message-handler (предыдущая итерация ADR-0006)

Отклонено после ревью: `chrome.runtime.onMessage` в SW — это **новый event**, не продолжение оригинального `chrome.contextMenus.onClicked` handler chain. К моменту, когда `executeScript` был бы вызван, прошло 10-60 секунд polling'а, оригинальный gesture давно истёк. Документация Chrome про «may inherit within ~5s» относится к случаю, когда `executeScript` вызывается синхронно из того же handler, а не из отдельного message event'а спустя произвольное время.

Это была ошибочная предпосылка предыдущей версии этого ADR. Текущее решение (§2) — offscreen document, который **не зависит** от gesture inheritance.

### 11. Clipboard через textarea overlay на странице + user-triggered copy button

Не рассматривается как основной путь: пользователь хочет «сразу копировать», overlay требует второго клика. Однако остаётся как **fallback в acceptance gate** — если `navigator.clipboard.writeText()` в offscreen не сработает по неожиданной причине, можно показать на странице небольшой `<textarea>` с transcript и кнопкой «Copy», которая вызывает `navigator.clipboard.writeText()` в user-triggered handler (это работает в MV3).

---

## Дальнейшее развитие

- **CWS-публикация**: если расширение когда-то понадобится в Chrome Web Store, потребуется миграция с `auth.json` на `chrome.storage.local` + options page. CWS публикует extension как opaque bundle, доступный пользователю после установки — встроить секрет в bundle небезопасно (любой инспектор расширений увидит значение после unpack), поэтому токен придётся вводить через UI при первом запуске.
- **Long-poll на сервисе**: если polling 5s станет узким местом (массовое использование, мобильные клиенты) — добавить `?wait=NN` на стороне сервиса, polling 30s через alarms станет достаточным.
- **Job history UI**: показать последние N задач с их статусом, transcript-path, ack-state. Полезно, но не в этой итерации.
- **Per-video language override**: сейчас сервис автодетектит язык. Если понадобится `&lang=ru` query param — добавим в `SubmitJobRequest` и пробросим из menu (sub-menu или content-script overlay).

---

## Итог

Минимально-инвазивная интеграция local-transcription-service в существующее расширение через один пункт контекстного меню. Trust model (token в файле вне git) и polling architecture (content script host) — главные решения этого ADR; оба пересматриваются только при изменении upstream ADR-012 или при переходе на CWS-дистрибуцию.

Дальнейшие шаги — `task-doc` уровня HLD (по аналогии с Phase B/C/D в репозитории сервиса) с конкретными change-list'ами по файлам и acceptance-критериями.