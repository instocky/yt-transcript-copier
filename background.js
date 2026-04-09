chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'copy-yt-transcript',
    title: '📋 Скопировать транскрипт',
    contexts: ['page'],
    documentUrlPatterns: ['https://www.youtube.com/*'],
  });

  // NEW
  chrome.contextMenus.create({
    id: 'save-yt-markdown',
    title: '⬇️ Сохранить как Markdown',
    contexts: ['page'],
    documentUrlPatterns: ['https://www.youtube.com/*'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const exec = fnName => {
    chrome.scripting
      .executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      })
      .then(() => {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: name => {
            if (typeof window[name] === 'function') {
              window[name]();
            }
          },
          args: [fnName],
        });
      })
      .catch(err => console.error('Inject failed:', err));
  };

  if (info.menuItemId === 'copy-yt-transcript') {
    exec('extractAndCopy');
  }

  // NEW
  if (info.menuItemId === 'save-yt-markdown') {
    exec('extractAndSaveMarkdown');
  }
});

// NEW — listener для скачивания
chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === 'DOWNLOAD_MD') {
    const { filename, content } = msg.payload;

    const url =
      'data:text/markdown;charset=utf-8,' + encodeURIComponent(content);

    chrome.downloads.download(
      {
        url,
        filename,
        conflictAction: 'uniquify',
        saveAs: false,
      },
      id => {
        if (chrome.runtime.lastError) {
          console.error('Download failed:', chrome.runtime.lastError);
        } else {
          console.log('Downloaded:', id);
        }
      }
    );
  }
});
