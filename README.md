# YT Transcript Copier

Chrome extension that copies the full YouTube transcript to clipboard or exports it as Markdown.

## Features

- Right-click anywhere on a YouTube video page -> copy transcript to clipboard
- Right-click anywhere on a YouTube video page -> save transcript as `.md`
- Right-click anywhere on a YouTube video page -> 🎙 Транскрибировать (LTS) for videos without built-in transcript (uses local STT service on Mac Mini)
- Auto-opens the transcript panel if it's closed
- Strips timestamps and preserves paragraph structure
- Works with Russian and English YouTube UI
- Generates deterministic Markdown filenames
- Uses green success toasts for copy/export completion and dark toasts for info/error states
- Supports localhost batch orchestration through a short-lived Python server

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

## Batch usage via localhost API

The batch mode is designed for a small daily queue without Selenium or Playwright.

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

- `background.js` - context menu actions, localhost orchestration, retries, downloads
- `content.js` - transcript extraction and Markdown rendering
- `batch_server.py` - local coordinator API for sequential batch processing

## Requirements

- Google Chrome or another Chromium-based browser
- Python 3.10+
- Manifest V3 compatible browser

## Known limitations

- Transcript must be available for the video
- YouTube DOM changes may break extraction
- MV3 background polling can introduce up to 30 seconds of idle-start latency
- The extension still depends on Chrome Downloads API for the file save path

## License

MIT
