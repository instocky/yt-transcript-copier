# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.6.2] - 2026-10-12

### Fixed

- **Three real-world bugs surfaced by the 1.6.1 retry loop on a 6-URL batch run** (3 of 6 transcripts came back as 327 / 478 / 366-byte files — basically just the YAML frontmatter — and the `chrome://extensions` error page showed a `SyntaxError: Identifier 'CLIPBOARD_SUMMARY_SUFFIX' has already been declared`).

  **Bug A — `content.js::grabText()` returned description text as the transcript.** The old function had two fallback paths that returned `cleanText(container.innerText)` / `cleanText(descSection.innerText)` when no real transcript segments were on the page. The page's description tab text ("В этом видео Эпизоды Расшифровка видео" — 6 words) passed the `< 10` word gate at `content.js:75`, so `autoOpenTranscript()` was never called and the description was persisted as the transcript. **Fix**: removed the two fallback paths entirely; `grabText()` now only returns text when it actually came from `transcript-segment-view-model`, `ytd-transcript-segment-renderer` inside the transcript container, or the `engagement-panel-searchable-transcript` engagement panel with at least one segment child. The engagement-panel path is also gated on segment presence so a freshly-opened but still-loading panel does not return an empty/short innerText. If no real transcript is on the page, `grabText()` returns `null` and the existing `autoOpenTranscript()` + `waitForText()` flow takes over.

  **Bug B — `runBatchExtraction` re-injected `content.js` on a tab that already had it.** `chrome.scripting.executeScript({files: ['content.js']})` re-evaluates the file in the tab's content-script isolated world, and the top-level `const CLIPBOARD_SUMMARY_SUFFIX` declaration in `content.js` throws `SyntaxError: Identifier ... has already been declared` on second evaluation. The error doesn't break the call (bindings from the manifest's auto-injection are still in place), but it spams the `chrome://extensions` error page. The 1.6.1 retry loop made it 3× per URL and visible to the user. **Fix**: probe `typeof window.extractForBatch === 'function'` first and only re-inject `content.js` when the function is missing (which should never happen in practice on a YouTube tab, but the probe is the right defensive shape).

  **Bug C — SW retry loop didn't reject a short final artifact.** The loop in `runEphemeralJob` set `lastError = {type: 'TRANSCRIPT_TOO_SHORT', ...}` on each short attempt, but the post-loop check was only `if (!artifact?.ok)`. An `ok: true` artifact with 6 words slipped through and was downloaded. **Fix**: added a final `if (finalWordCount < TRANSCRIPT_MIN_WORDS) return { status: 'error', error: lastError }` after the loop, so the existing `TRANSCRIPT_MIN_WORDS` check is the binding contract regardless of how many attempts produced short transcripts.

### Notes

- **Why bugs A and C are different fixes for the same symptom.** Bug A is the root cause: the content script is grabbing the wrong DOM. Bug C is defence-in-depth: the SW should not trust an `ok: true` result without verifying its quality, because the content-script world can change (DOM selectors, YouTube layout changes) in ways the SW doesn't predict. Both are necessary; A fixes the visible failure today, C prevents the same class of bug from silently shipping next time the DOM moves.
- **Why the SyntaxError from Bug B was never caught in earlier releases.** `runBatchExtraction` (in `processBatchQueue` since 1.4.0) has always re-injected `content.js`. The `localhost` API batch is run rarely (Python script), the previous single-shot call logged one error per URL into the SW console, and the user only opens `chrome://extensions` to read the error page when something is visibly broken. The 1.6.1 retry loop multiplied the noise 3× and made it the loudest line in the error pane, which is how it surfaced here. The fix is the right shape for the underlying issue regardless of visibility.
- **No new permissions, no new files, no manifest changes** beyond the version bump. The content-script public surface (`window.extractForBatch`, `window.extractAndCopy`, `window.extractAndSaveMarkdown`) is unchanged, so all single-video and LTS paths continue to work as before.
- **Manual regression check after upgrade**: pick a YouTube video with a Russian-language description and an English transcript (e.g. a recent interview). Right-click → "Сохранить как Markdown". The file should contain the transcript, not the description. Previously this would silently produce a small description-only file in some cases.

---

## [1.6.1] - 2026-10-12

### Fixed

- **Context-menu batch: race between `tab.status === 'complete'` and the YouTube SPA finishing the transcript render.** In 1.6.0 two failure modes were visible in real runs:
  1. `extractForBatch` returned `ok: false` with type `PAGE_NOT_READY` ("Страница видео не успела перейти в ожидаемое состояние") when `waitForVideoContext` polled for 15 s and never saw the expected `video_id` in the URL.
  2. `extractForBatch` returned `ok: true` with a transcript of 10–50 words — the page was "ready" by `video_id` but the transcript panel itself was still empty / mid-render. `content.js`'s own `if (text.length < 10)` gate (content.js:75) is intentionally lax so it can fall through to `autoOpenTranscript`; a 20-word snippet slips past that gate and gets persisted as a 300-byte "transcript" file (basically just the YAML frontmatter).
- **Both modes are now caught in the service worker by a retry loop in `runEphemeralJob`**: up to `BATCH_MAX_ATTEMPTS = 3` attempts, with `BATCH_RETRY_DELAY_MS = 4000` between them. The retry re-injects `content.js` and re-calls `window.extractForBatch(videoId)`, which re-runs the full `waitForVideoContext` + `autoOpenTranscript` + `waitForText` sequence inside the content script. The cancellation flag is checked between attempts so a Cancel click during the retry window still aborts cleanly. After 3 failed attempts the SW returns the last error (either `PAGE_NOT_READY` or a new `TRANSCRIPT_TOO_SHORT` with the actual word count) so the popup shows a real diagnostic instead of a silently-empty file.
- **`FALLBACK_INTER_JOB_DELAY_MS` bumped `7000 → 10500` (×1.5)** per request. Gives YouTube more time to release the previous tab's resources before the next `tabs.create`. The bump is global — affects both the context-menu batch path and the localhost API path (`processBatchQueue` uses the same constant as a default when the job does not specify `inter_job_delay_ms`).

### Notes

- **Why retry in SW, not content.js**: the threshold for "this is a usable transcript" is a user-visible quality contract, not a parsing detail. The content script's job is "extract whatever is on the page" (so it can fall through to `autoOpenTranscript` on a near-empty read); the SW's job is "decide if what we got is worth saving". Mixing the two creates the kind of "10 words is enough" bugs that produced the 327 / 366-byte files in the 1.6.0 test run.
- **`TRANSCRIPT_MIN_WORDS = 100` is conservative on purpose.** Most real YouTube transcripts are hundreds to thousands of words. 100 is well below the "obviously truncated" line and well above the "spurious 10-word snippet" line. If real-world runs show legitimate short transcripts (<100 words) being rejected, lower the constant — it is a single line in `background.js`.
- **Total per-URL budget** with the new retry: up to `3 × EXECUTION_TIMEOUT_MS (90s) + 2 × BATCH_RETRY_DELAY_MS (4s)` ≈ 278 s in the worst case (extraction timeout on every attempt). Realistic budget on a healthy page: ~10–20 s × 1 attempt. For a 50-URL batch this adds ~10 min of headroom in the catastrophic case — still well within Task Scheduler budgets, and the `Done/Error` markers in the popup let the user know what's happening.
- **No `content.js` changes** in this release. The retry loop is fully contained in the context-menu batch path; the existing `extractForBatch` contract and the existing DOM-watching helpers are untouched, so the context-menu / single-click / LTS paths are unaffected.
- **Files changed**: `background.js` (constants, `runEphemeralJob` rewrite), `manifest.json` (1.6.0 → 1.6.1). No new permissions, no new files.

---

## [1.6.0] - 2026-10-12

### Added

- **📥 Загрузить URLs (batch)** context-menu item on `youtube.com` pages — opens a small popup window (`batch.html`) with a file picker and a textarea. The user selects a `.txt` file (or pastes URLs), clicks **Start**, and the extension processes the list sequentially: each URL opens in a fresh background tab (`active: false`), the transcript is extracted, the Markdown file is saved through the existing `chrome.downloads` path, and the tab is closed via `chrome.tabs.remove`. No Python, no `batch_server.py`, no `127.0.0.1:8765` API.
- **Live progress in the popup** — per-URL status (green ✓ on success, red ✗ on error with the error message), a progress bar, a running `done / total` counter, and a **Cancel** button. Closing the popup mid-run does not stop the batch — the worker keeps going in the service worker; re-opening the popup via the context menu does not re-attach to the running batch (planned for a later release).
- **Cancellation** — clicking **✕ Cancel** sets a `contextMenuBatchCancelRequested` flag in the SW; the loop checks the flag between jobs and after the per-job `sleep`. The currently running job always finishes (it is mid-flight on a real tab); only the next URL is skipped.

### Changed

- `background.js` — added a `Context-menu batch` section at the bottom of the file: `openBatchPopup`, `runContextMenuBatch` / `_runContextMenuBatch`, `cancelContextMenuBatch`, `runEphemeralJob`, `broadcastBatch`. Two new `chrome.runtime.onMessage` branches for `BATCH_START` (with the URL array) and `BATCH_CANCEL`. The new menu item is registered in `ensureContextMenus` alongside the existing three; the click handler dispatches `openBatchPopup()` for `batch-from-urls`.
- `manifest.json` — version bumped 1.5.4 → 1.6.0. Description updated to mention the context-menu batch. No new permissions, no new `host_permissions`, no `web_accessible_resources` entry required (`batch.html` is loaded as an extension page via `chrome.windows.create({url: chrome.runtime.getURL('batch.html'), type: 'popup'})`, not from a web page).
- `README.md` — new **Batch usage via context menu (recommended)** section above the existing localhost section; existing **Batch usage via localhost API** is now framed as an alternative. URL-list format, cancellation, and the relationship between the two batch paths are documented.

### Notes

- **Reuse, not duplication**: the new flow calls into the existing `runBatchExtraction` → `downloadMarkdown` chain and reuses `waitForTabComplete`, `withTimeout`, `createError`, `createErrorFromPayload`, `serializeError`, `getVideoIdFromUrl`, `sleep`, and `FALLBACK_INTER_JOB_DELAY_MS`. The only new extraction-flow logic is `runEphemeralJob`, which wraps the same calls in a `tabs.create` + `tabs.remove` envelope.
- **Tab lifecycle**: each job gets its own tab, opened with `active: false` so the user's current YouTube tab is not stolen. The tab is closed in a `finally` block regardless of success/failure so a failed extraction does not leak zombie tabs. `tabs.remove` errors (tab already gone) are silently swallowed.
- **Why not popup from the toolbar action**: the action button is intentionally passive in this extension (no `default_popup`); the user wants the trigger on the context menu. `chrome.windows.create({type: 'popup'})` is the right MV3 primitive for "open a small window from a user-gesture handler without putting UI in the toolbar".
- **No retries per URL** — matches the user's stated flow ("go through the list"). Failures are reported in the popup and the loop continues. If retries are needed later, the same `runEphemeralJob` shape can be wrapped in an N-attempt loop, or a unified queue with the localhost `processBatchQueue` retry/reclaim logic.
- **Known gap**: the popup does not re-attach to a running batch if it is closed and re-opened. The popup is a view, not a controller — re-opening it after a closed run starts a new run from scratch. Persisting batch state in `chrome.storage.local` and rehydrating on popup open is tracked for a future minor release.
- **Files added**: `batch.html` (popup markup), `batch.js` (popup controller, ~115 lines), `batch.css` (popup styling, light + dark via `prefers-color-scheme`).

---

## [1.5.4] - 2026-07-26

### Changed

- **Clipboard copy payload now appends a fixed Russian summary prompt.** Both copy-style menu items ? the built-in `Скопировать транскрипт` action and the `🎙 Транскрибировать (LTS)` fallback ? now append the same postscript after the transcript body. The postscript is separated from the transcript by **two empty lines** and contains strict formatting instructions for a Russian summary plus `#summary` tags. This makes the copied payload immediately ready for downstream LLM prompting without manual paste-time editing.

### Fixed

- **Documentation updated for the new clipboard behavior.** `README.md` now documents the appended summary prompt, the exact clipboard payload shape, and the fact that both copy-style menu items produce the same final payload.
- **Version metadata bumped to 1.5.4.** `manifest.json` now reflects the release that adds the clipboard summary postscript.

### Notes

- **Scope**: Markdown export remains unchanged. The summary postscript is added only to clipboard-oriented flows.
- **Implementation**: `content.js` now builds the standard copy payload through a helper, and `background.js` applies the same suffix to the LTS clipboard path so both menu items stay byte-for-byte aligned.
- **Encoding audit**: ADR markdown files were verified as valid UTF-8 content; the previously observed mojibake came from terminal rendering, not broken repository bytes.

---

## [1.5.3] - 2026-07-05

### Fixed

- **Stale in-title indicator after SPA navigation.** When the user clicked a related video (or any SPA navigation — back / forward, watch-page → search → watch, watch-page → channel → watch), the green checkmark (✓) or red cross (✗) from the previous LTS job remained next to the new video's title. YouTube is a single-page app, so navigation does not trigger a full page reload and the content-script instance — including the injected `.lts-arrow` SVG — survived across navigations. The indicator visually belonged to the previous job but appeared to be the new job's state, which is misleading.

### Notes

- **Fix location**: `content.js` — added `watchLtsUrlChanges()` (~25 lines) called once at content-script load. Three signal sources cover all SPA navigation paths:
  - `history.pushState` patch — YouTube uses this for forward navigation (related-video clicks, watch-page → search).
  - `history.replaceState` patch — YouTube uses this for in-place updates (e.g., `t=` parameter changes without a full nav).
  - `popstate` listener — browser back / forward.
  - `yt-navigate-finish` listener — YouTube custom event fired after SPA navigation completes and the new watch-page DOM has stabilised. Acts as a fallback in case a future YouTube update overrides the `pushState` / `replaceState` patches.
- **Cleanup action**: on any URL change, the existing `ltsRemoveIndicator()` helper is called — it locates the title via the same fallback selector chain used by `ltsFindTitle()` and removes any `.lts-arrow` element from its parent. No state mutation, no polling stop (polling is already stopped on terminal state — `ltsStopPolling()` is called inside the `ltsTick` handler on `done` and `failed`).
- **Idempotent**: `ltsRemoveIndicator()` is a no-op when no `.lts-arrow` exists, so re-firing the cleanup on overlapping signals (e.g., `popstate` immediately followed by `yt-navigate-finish`) does not throw.
- **No new permissions** for this release — relies on the same `tabs` permission and YouTube `host_permissions` already declared in 1.5.0. Version bumped 1.5.2 → 1.5.3.

---

## [1.5.2] - 2026-07-05

### Added

- **Toast notifications for the LTS menu item** — the `🎙 Транскрибировать (LTS)` flow now shows the same in-page toast that the DOM-extract copy path has used since 1.0.0: a green pill in the bottom-right corner on success (`Скопировано! (~NN слов)`) and a dark pill on failure (`Ошибка LTS транскрипции`). Previously LTS completion was signalled only via the toolbar badge (`✓` / `✗`) and the in-title indicator — adding the toast brings LTS UX to full parity with the built-in copy action.

### Notes

- **Signal pattern**: background sends `chrome.tabs.sendMessage(tabId, {type: 'lts-clipboard-done' | 'lts-clipboard-failed', wordCount?})` to the content script after `ltsWriteClipboard` returns (success path) or after `setLtsBadge(AUTH_ERROR | FAILED)` (two failure paths — `/result` HTTP error and submit/notify error in `handleLtsTranscribeClick`). Content script's existing `chrome.runtime.onMessage` listener picks it up and calls `showToast(...)`. Three send sites, two listener branches.
- **Word count** is computed in the background (`text.split(/\s+/).filter(Boolean).length`) so the raw transcript does not have to round-trip back to content for a single integer.
- **Failure coverage**:
  - `/jobs/{id}/result` HTTP error or auth failure during `handleLtsResultReady` → toast `Ошибка LTS транскрипции` + badge `⚠`.
  - Submit/network failure in `handleLtsTranscribeClick` → toast `Ошибка LTS транскрипции` + badge `✗` + SW log.
- **Silent degradation**: every `chrome.tabs.sendMessage` is wrapped in `.catch(...)`. If the YouTube tab was closed between terminal state and the toast signal, or the content script listener is stale (MV3 reload edge case), the sendMessage rejects and we log at `console.warn` — no exception escapes to the SW lifecycle.
- **No new permissions** for this release — relies on the same `tabs` / YouTube `host_permissions` already declared in 1.5.0. Version bumped 1.5.1 → 1.5.2.

---

## [1.5.1] - 2026-07-05

### Changed

- **LTS clipboard format now matches the DOM-extract copy path.** Previously the `🎙 Транскрибировать (LTS)` menu item copied only the raw transcript body returned by the STT service. Both copy-style menu items now produce the same payload shape: `{title}\n{url}\n\n{transcript}` — title has the ` - YouTube` suffix stripped, URL is the watch URL captured at click time. Result: pasted output is identical regardless of which menu item generated it, so downstream consumers (notes apps, chat prompts, batch archive tooling) do not need to special-case the LTS source.

### Notes

- **Snapshot timing**: title and URL are captured at click time (`chrome.tabs.get(tabId)` inside `handleLtsTranscribeClick`) and stored in a module-scope `ltsSubmitMeta` Map keyed by tabId. If the user navigates to a different video while polling is in progress, the original click-time title is preserved — matches the DOM-extract behaviour where the title is read on click.
- **Edge cases**:
  - Tab closed before snapshot: snapshot falls back to `{title:'', url: tabUrl}`; URL is preserved if known.
  - Tab closed during polling: `chrome.tabs.onRemoved` listener cleans the Map entry. `ltsFormatTranscript` then receives no meta and copies the raw transcript only — user waited for the result, no silent data loss.
  - Tab navigated away from YouTube: snapshot already captured → correct title and original URL.
  - Snapshot empty (no title, no URL): filter collapses to empty list → raw transcript only.
- **No manifest changes** for this release — `"tabs"` permission and YouTube `host_permissions` were already declared in 1.5.0, which is what the snapshot lookup relies on. Version bumped 1.5.0 → 1.5.1.

---

## [1.5.0] - 2026-07-05

### Added

- **🎙 Транскрибировать (LTS)** context-menu item on `youtube.com` pages — submits the current video URL to the local `local-transcription-service` (whisper.cpp STT on Mac Mini) and copies the resulting transcript to clipboard. Works for videos without built-in YouTube transcripts where the existing DOM-extraction path returns `NO_TRANSCRIPT`.
- **In-title UI feedback** — green arrow SVG injected next to the YouTube title during polling (flashes 0.5s on each successful poll tick), replaced with a green ✓ checkmark on `done` or a red ✗ cross on `failed`. Visible from the watch page itself, no need to switch to extension popup.
- **Offscreen document clipboard path** — `chrome.offscreen.createDocument({reasons: ['CLIPBOARD']})` used as the clipboard-write host from the MV3 service worker, where `navigator.clipboard.writeText()` is not reliably available (focus-policy / permission-policy limitations in offscreen). Two-level fallback inside the offscreen: `navigator.clipboard.writeText` → `document.execCommand('copy')` via temporary `<textarea>` (documented to be the only working path on tested Chrome build).
- **MV3 reload race-condition guard** — `sendLtsStartToContent()` in the service worker retries `chrome.tabs.sendMessage` after `chrome.scripting.executeScript({target: {tabId}, files: ['content.js']})` when the content script on the target tab is stale (extension reloaded in `chrome://extensions` while the tab remained open). Eliminates the manual «reload YouTube tab» step previously required after every extension reload.
- `auth.json` token-storage convention — gitignored JSON file in extension root, read via `chrome.runtime.getURL('auth.json')` and cached in module-scope. `auth.json.example` template committed.
- `docs/backlog.md` — open follow-ups register (`BLG-001` and future).
- `docs/tasks/TASK-LTS-Local-Transcription-Menu.md` — implementation-level task-doc with change-list, 12 acceptance criteria, 5 manual smoke scenarios.
- `docs/adr/ADR-0006-lts-whisper-menu-integration.md` — architectural decision (Accepted 2026-07-05 after smoke gate PASS).
- `docs/adr/ADR-012-local-transcription-pipeline.md` — vendored copy synced to `Accepted` (was `Proposed` until Tech Lead accepted upstream in service repo).

### Changed

- `manifest.json` — added `offscreen` permission, `http://127.0.0.1:8766/*` and `http://192.168.0.99:8766/*` host_permissions (loopback + LAN modes for `local-transcription-service`), explicit `action` block (was missing — caused `Cannot read properties of undefined (reading 'setBadgeText')` until added). Version bumped 1.4.1 → 1.5.0.
- `background.js` — added LTS module (~270 lines): token load via `fetch(chrome.runtime.getURL('auth.json'))`, offscreen lifecycle (`ensureOffscreen` with `hasDocument` check), `ltsFetch`/`ltsSubmit`/`ltsGetJobStatus`/`ltsGetTranscript`/`ltsAck`/`ltsWriteClipboard` helpers, `handleLtsTranscribeClick`/`handleLtsResultReady` entry points, dispatch on `onClicked` and `onMessage`. Service-worker polling event handlers added for `lts-poll` / `lts-result-ready` / `lts-failed`.
- `content.js` — added LTS polling section (~80 lines): `chrome.runtime.onMessage` listener for `{type: 'lts-start', jobId}` that starts `setInterval(5000)`, sends `lts-poll` to SW, on `done` sends `lts-result-ready`, on `failed` sends `lts-failed`; in-title SVG injection (`ltsFindTitle` / `ltsMakeSVG` / `ltsShowInTitle` / `ltsFlash`) wired into the poll lifecycle.
- `README.md` — added 🎙 Транскрибировать (LTS) bullet to Features, new `First-time setup` section with `cp auth.json.example auth.json` instructions and warning about token length / no-op on missing file.
- `.gitignore` — added `auth.json` rule so the real token never commits.

### Improved

- Polling cadence now matches the contractually-recommended 5s interval (previously impossible because polling host was not yet wired).
- UI feedback is now colocated with the content (in-title), so the user does not need to switch tabs or watch the extension icon to see job progress.
- Lifecycle management for offscreen document reuses an existing instance on subsequent jobs (`chrome.offscreen.hasDocument()` check), avoiding repeated `createDocument` calls.

### Notes

- ADR-0006 acceptance gate passed via the `execCommand` fallback path on the tested Chrome build. The primary `navigator.clipboard.writeText()` path inside offscreen was documented as the intent, but the fallback proved to be the actual working path in practice. Two-level fallback is now mandatory in the offscreen clipboard pattern.
- Debug logging (`[lts]` prefix, ~30 statements across `background.js` and `content.js`) intentionally retained in 1.5.0 for first-deploy diagnostics. Cleanup is tracked as `BLG-001` in `docs/backlog.md` for a future minor release.
- Service-side job lifecycle: jobs created by extension clicks are persisted in the service's SQLite queue until `POST /jobs/{id}/ack` is called. The race-condition guard above ensures ack happens reliably; if a stale-content-script path still somehow causes a job to be orphaned (submit OK, content never polls), the transcript remains on disk until manual operator cleanup — no silent data loss.

---

## [1.4.1] - 2026-04-12

### Changed

- Success toast notifications for transcript copy and Markdown export now use a green visual style

### Notes

- Informational and error toast notifications keep the existing dark style

---

## [1.4.0] - 2026-04-10

### Added

- Localhost batch orchestration via `batch_server.py`
- Sequential job execution from the extension background worker
- `job_id` and `batch_id` support for batch processing
- Retry policy with lease reclaim, max attempts, and backoff
- Single-flight guard and persisted worker state in `chrome.storage`
- Structured result reporting from `content.js` back to the background worker

### Changed

- `content.js` now exposes a reusable extraction contract for manual and batch flows
- `background.js` now manages downloads, reporting, polling, and reliability logic
- `manifest.json` now includes `alarms`, `storage`, `tabs`, and localhost host permissions

### Improved

- Batch extraction now waits for the expected YouTube `video_id` before starting transcript parsing
- Transcript auto-open flow now retries multiple times before returning `NO_TRANSCRIPT`
- Batch processing now applies a default delay between URLs to reduce race conditions on reused tabs
- Console batch summary now prints only a short Markdown preview instead of the full exported document

---

## [1.3.0] - 2026-04-09

### Added

- Export transcript as Markdown file via context menu ("Сохранить как Markdown")
- Filename generation with deterministic pattern:
  - `yt_{author}_{slug}_{yyyy-mm-dd}.md`
- YAML frontmatter metadata (title, author, url, date, video_id)
- Chrome Downloads API integration (silent save to Downloads folder)

### Improved

- Filename normalization:
  - transliteration (Cyrillic -> Latin)
  - safe character filtering for cross-platform compatibility

### Notes

- No changes to existing clipboard functionality
- Export reuses the same extraction pipeline (no duplication)

---

## [1.2.0] - 2025-04-05

### Added

- Video metadata prepended to copied transcript: clean video title (` - YouTube` suffix stripped) and page URL, separated from transcript body by a blank line

---

## [1.1.0] - 2025-04-05

### Added

- Support for new YouTube DOM layout (`transcript-segment-view-model` / `yt-core-attributed-string`) introduced in 2024 redesign
- Paragraph formatting: each transcript segment is now separated by `\n\n` for readable output when pasting into editors, Notion, ChatGPT, etc.

### Fixed

- Timestamps leaking into copied text are now explicitly removed via `[class*='Timestamp']` and `[aria-hidden='true']` selectors on cloned DOM nodes
- Fallback `cleanText()` no longer double-joins with `\n\n`

---

## [1.0.0] - 2025-04-04

### Added

- Context menu item `Скопировать транскрипт` on all `youtube.com` pages
- `grabText()` extracts transcript from `.ytSectionListRendererContents` / `ytd-transcript-segment-renderer` with fallback selectors
- `autoOpenTranscript()` implements a multi-step transcript opening strategy
- `waitForText()` polls every 400ms up to 5s after auto-open
- Toast notifications for success and error states
- Clipboard fallback via `execCommand('copy')` for older Chrome versions
