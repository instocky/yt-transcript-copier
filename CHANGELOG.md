# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
