# YT Transcript Copier

Chrome extension that copies the full YouTube transcript to clipboard or exports it as Markdown. Clipboard copy modes also append a fixed Russian summary prompt for downstream LLM workflows.

## Features

- Right-click anywhere on a YouTube video page -> copy transcript to clipboard (formatted as `title` + URL + blank line + transcript body + two blank lines + fixed Russian summary prompt)
- Right-click anywhere on a YouTube video page -> save transcript as `.md`
- Right-click anywhere on a YouTube video page -> 📥 Загрузить URLs (batch) — opens a popup window with file picker, runs a URL list sequentially with one tab per video, closes each tab after the Markdown download completes. No Python or localhost server required.
- Right-click anywhere on a YouTube video page -> 🎙 Транскрибировать (LTS) for videos without built-in transcript (uses local STT service on Mac Mini) — clipboard payload uses the same `title` + URL + transcript + summary-prompt format as the built-in copy action, so paste output is identical regardless of which menu item generated it; shows the same green in-page toast as the built-in copy action when transcription completes (`Скопировано! (~NN слов)`)
- Auto-opens the transcript panel if it's closed
- Strips timestamps and preserves paragraph structure
- Works with Russian and English YouTube UI
- Generates deterministic Markdown filenames
- Uses green success toasts for copy/export completion and dark toasts for info/error states
- Supports localhost batch orchestration through a short-lived Python server

## Clipboard payload format

Both copy-style menu items produce the same header + transcript + fixed postscript:

```
{title}
{url}

{transcript}


Дайте Саммари на русском
## Важно
- это готовый законченный документ
- не требуется никаких вступлений, в стиле "Автор сравнивает..."

В конце: #summary
3–5 тематических тегов
• на английском
• ровно два слова
• lower case
• с #

##пример тегов

#summary
#mini pc
```

- `title` has the ` - YouTube` suffix stripped (matches `document.title` after YouTube's own trimming).
- `url` is the watch URL captured at the moment the menu item was clicked, so changing videos while a job is in flight does not alter the clipboard header.
- The summary prompt is appended after the transcript with **two empty lines** between them.
- For the DOM-extract path the header is read on click (sync). For the LTS path the header is snapshotted via `chrome.tabs.get(tabId)` on click and replayed when the job reaches `done`.

If the YouTube tab was closed before the snapshot could be taken, or the tab navigated away and the snapshot ended up empty, the extension falls back to copying the raw transcript body plus the same summary prompt ? the user waited for it, so the result is still delivered.

## First-time setup (LTS menu)

The 🎙 Транскрибировать (LTS) menu item uses a local STT service
(`local-transcription-service`, see `../_Others/0703_local-transcription-service/README.md`).
Without one-time setup the menu item is a no-op and the extension badge shows `⚠`.

1. Copy the template: `cp auth.json.example auth.json`
2. Substitute the real `LTS_AUTH_TOKEN` value from `$HOME/.lts-env` on the Mac Mini
   (the `LTS_AUTH_TOKEN` variable, length ≥16 chars).
3. Reload the extension in `chrome://extensions`.

The `auth.json` file is in `.gitignore` — it must not be committed. The
`auth.json.example` template in the repo contains only a placeholder.
If `auth.json` is missing or the token is too short, the menu click is a
no-op and the SW console logs `[lts] failed to load auth.json`.

## Installation

1. Download and unzip the archive.
2. Open Chrome -> `chrome://extensions/`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this folder.
5. Reload the extension after manifest changes.

## Interactive usage

1. Open any YouTube video.
2. Right-click anywhere on the page.
3. Select one of the actions:
   - `Скопировать транскрипт`
   - `Сохранить как Markdown`

## Batch usage via context menu (recommended)

The fastest way to process a list of YouTube URLs — no Python, no server, no alarm-poll latency.

### Flow

1. Right-click anywhere on a YouTube page.
2. Select **📥 Загрузить URLs (batch)**.
3. In the popup window, pick a `.txt` file with one URL per line (or paste URLs into the textarea).
4. Click **▶ Start**.
5. The popup shows live progress (`done / total`, per-URL status, errors). The extension processes the queue sequentially: each URL opens in a fresh background tab, the transcript is extracted, the Markdown file is saved, and the tab is closed.
6. You can close the popup mid-run — the batch continues in the background. Re-open via the context menu to see current progress.

### URL list format

- One URL per line, blank lines and `#`-prefixed comments are ignored.
- Standard `youtube.com/watch?v=…` and `youtu.be/…` URLs work; non-YouTube URLs fail the extraction step and are reported as errors in the popup.
- Example: see `urls.txt` in this repo.

### Cancellation

Click **✕ Cancel** in the popup. The currently running job finishes, then the batch stops before the next URL.

### Reliability

The batch runner is defensive against two distinct races between `chrome.tabs.onUpdated.status === 'complete'` and the YouTube SPA finishing the transcript render.

- **Per-URL retry loop** — up to 3 attempts per URL, with 4 s between them. Re-injects `content.js` and re-runs the full `extractForBatch` flow on each attempt.
- **Two failure modes trigger a retry**:
  1. `extractForBatch` returns `ok: false` with `retryable: true` (e.g. `PAGE_NOT_READY` — the expected `video_id` did not appear in the URL within 15 s).
  2. `extractForBatch` returns `ok: true` but the transcript is fewer than `TRANSCRIPT_MIN_WORDS` (100) words. This catches the case where the page was "ready" by `video_id` but the transcript panel was still empty / mid-render — a 20-word snippet used to slip past the content-script's own `< 10` word gate and be persisted as a 300-byte YAML-frontmatter-only `.md` file.
- **Non-retryable errors fail fast** — `NO_TRANSCRIPT` (the video truly has no transcript) is returned immediately without retry, the popup shows "Транскрипт не найден".
- **Final defence-in-depth check** — even if every attempt returned `ok: true` with a short transcript, the SW rejects the artifact before calling `chrome.downloads.download` if the final word count is below `TRANSCRIPT_MIN_WORDS`.
- **Inter-URL delay** — `FALLBACK_INTER_JOB_DELAY_MS = 10500` (10.5 s) between URLs gives YouTube time to release the previous tab's resources before the next `tabs.create`.

Files that fail all attempts are **not** downloaded; the popup shows the error and moves to the next URL. Final summary lists `done / total` plus an error count.

## Batch usage via localhost API (alternative)

The localhost API path is intended for headless / scripted runs (e.g. cron, CI) and is unchanged from 1.4.0.

### Flow

1. Start Chrome with the unpacked extension loaded.
2. Prepare a text file with one YouTube URL per line.
3. Run:

```powershell
python .\batch_server.py .\urls.txt
```

4. The Python process starts a short-lived API on `127.0.0.1:8765`.
5. The extension polls the API, opens videos sequentially, extracts the transcript, saves Markdown, and reports results back.
6. When the queue is complete, the server exits and prints a summary.

### Batch stability improvements

- the extension waits for the expected `video_id` before extraction starts
- the transcript open flow retries multiple times before returning `NO_TRANSCRIPT`
- a default 7-second delay is applied between URLs
- the final console summary prints only a short Markdown preview instead of the full exported text

### Reliability model

- `batch_id` groups one run
- `job_id` identifies each URL
- explicit states: `queued -> in_progress -> done | error`
- lease-based reclaim on expired jobs
- max 3 attempts with backoff
- single-flight processing inside the extension
- execution timeout per job
- download plus structured report payload back to Python

## Files

- `background.js` - context menu actions, localhost orchestration, retries, downloads, context-menu batch trigger
- `content.js` - transcript extraction and Markdown rendering
- `batch.html` / `batch.js` / `batch.css` - popup window for the context-menu batch flow
- `batch_server.py` - local coordinator API for sequential batch processing via the localhost flow

## Requirements

- Google Chrome or another Chromium-based browser
- Python 3.10+
- Manifest V3 compatible browser

## Known limitations

- Transcript must be available for the video
- YouTube DOM changes may break extraction
- MV3 background polling can introduce up to 30 seconds of idle-start latency (only affects the localhost API path; the context-menu batch path starts on click)
- The extension still depends on Chrome Downloads API for the file save path
- **LTS in-title indicator cleanup**: the green arrow / checkmark / cross is removed automatically on SPA navigation (related-video clicks, back/forward, watch-page transitions) via `watchLtsUrlChanges()` in `content.js`. A full page reload is not required between consecutive LTS jobs on the same tab — the previous job's indicator is cleared when the URL changes.
- **Context-menu batch vs localhost batch**: the two batch paths do not share a queue or a worker lock. Running both at the same time is not recommended — they will compete for tabs and the same download directory. The context-menu path is interactive and the localhost path is cron-style, so in practice they are not run simultaneously.

## License

MIT
