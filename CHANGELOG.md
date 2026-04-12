# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
