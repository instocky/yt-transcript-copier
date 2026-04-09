# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.4.0] — TBD

### Added

- Segment-based transcript extraction (structured segments instead of plain text)
- Optional timestamps in Markdown export

### Changed

- Internal transcript pipeline refactored:
  - v1.3: plain text
  - v1.4: structured segments

---

## [1.3.0] — 2026-04-09

### Added

- Export transcript as Markdown file via context menu ("⬇️ Сохранить как Markdown")
- Filename generation with deterministic pattern:
  - `yt_{author}_{slug}_{yyyy-mm-dd}.md`
- YAML frontmatter metadata (title, author, url, date, video_id)
- Chrome Downloads API integration (silent save to Downloads folder)

### Improved

- Filename normalization:
  - transliteration (Cyrillic → Latin)
  - safe character filtering for cross-platform compatibility

### Notes

- No changes to existing clipboard functionality
- Export reuses the same extraction pipeline (no duplication)

---

## [1.2.0] — 2025-04-05

### Added

- Video metadata prepended to copied transcript: clean video title (` - YouTube` suffix stripped) and page URL, separated from transcript body by a blank line

---

## [1.1.0] — 2025-04-05

### Added

- Support for new YouTube DOM layout (`transcript-segment-view-model` /
  `yt-core-attributed-string`) introduced in 2024 redesign
- Paragraph formatting: each transcript segment is now separated by `\n\n`
  for readable output when pasting into editors, Notion, ChatGPT, etc.

### Fixed

- Timestamps leaking into copied text (e.g. "26 минут 6 секунд", "7 секунд") —
  now explicitly removed via `[class*='Timestamp']` and `[aria-hidden='true']`
  selectors on cloned DOM nodes
- Fallback `cleanText()` no longer double-joins with `\n\n` (was breaking
  single-line fallback output)

---

## [1.0.0] — 2025-04-04

### Added

- Context menu item "📋 Скопировать транскрипт" on all `youtube.com` pages
- `grabText()` — extracts transcript from `.ytSectionListRendererContents` /
  `ytd-transcript-segment-renderer` with 4 fallback selectors
- `autoOpenTranscript()` — 4-strategy auto-open chain: direct button search,
  description expand + retry, `...` more-actions menu,
  `ytd-video-description-transcript-section-renderer`
- `waitForText()` — polling every 400ms up to 5s after auto-open
- < 10 words threshold: treats suspiciously short result as empty and
  re-triggers auto-open chain
- Toast notification with word count on success / error messages
- Clipboard fallback via `execCommand('copy')` for older Chrome versions
- Fixed "Receiving end does not exist" — switched from `sendMessage` to
  `scripting.executeScript` for cold-start tab compatibility
