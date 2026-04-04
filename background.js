chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "copy-yt-transcript",
    title: "📋 Скопировать транскрипт",
    contexts: ["page"],
    documentUrlPatterns: ["https://www.youtube.com/*"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "copy-yt-transcript") {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    }).then(() => {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => { if (typeof extractAndCopy === "function") extractAndCopy(); }
      });
    }).catch(err => console.error("Inject failed:", err));
  }
});
