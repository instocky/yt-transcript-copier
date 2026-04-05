# YT Transcript Copier

Chrome extension that copies the full YouTube transcript to clipboard via context menu — one right-click, no manual steps.

## Features

- Right-click anywhere on a YouTube video page → **"📋 Скопировать транскрипт"**
- Auto-opens the transcript panel if it's closed
- Strips timestamps, copies clean text only
- Preserves paragraph structure from the transcript panel
- Toast notification with word count on success
- Works with Russian and English YouTube UI

## Installation

1. Download and unzip the archive
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** → select the `yt-transcript-ext` folder

## Usage

1. Open any YouTube video
2. Right-click anywhere on the page
3. Select **"📋 Скопировать транскрипт"**
4. The full transcript is now in your clipboard

> If the transcript panel isn't open, the extension will attempt to open it automatically before copying.

## How it works

- `background.js` — registers the context menu item; on click, injects `content.js` into the active tab via `chrome.scripting.executeScript`
- `content.js` — finds transcript segments, strips timestamps, copies to clipboard with paragraph breaks

**DOM support:**

- New YouTube layout: `transcript-segment-view-model` → `yt-core-attributed-string`
- Legacy layout: `.ytSectionListRendererContents` → `ytd-transcript-segment-renderer`

**Auto-open chain** (triggered when transcript is missing or < 10 words):

1. Look for "Показать текст видео" / "Show transcript" button
2. Expand video description, retry button search
3. Open `...` more-actions menu, look for transcript item
4. Wait up to 5s for DOM to populate

## Requirements

- Google Chrome (or any Chromium-based browser)
- Manifest V3 compatible

## Permissions

| Permission                      | Reason                            |
| ------------------------------- | --------------------------------- |
| `contextMenus`                  | Register right-click menu item    |
| `scripting`                     | Inject content script on demand   |
| `clipboardWrite`                | Copy transcript text to clipboard |
| `host_permissions: youtube.com` | Access YouTube page DOM           |

## Known limitations

- Transcript must be available for the video (not all videos have one)
- Auto-open may not work if YouTube changes its DOM structure
- Does not scroll/load lazy-rendered transcript segments (works on visible content)

## License

MIT
