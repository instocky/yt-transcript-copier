// Popup window for context-menu batch trigger.
// Lives at chrome-extension://<id>/batch.html, opened from
// background.js::openBatchPopup when the user clicks the
// "📥 Загрузить URLs (batch)" context-menu item on a YouTube page.

const $ = (id) => document.getElementById(id);
const fileInput = $('file-input');
const fileName = $('file-name');
const urlsInput = $('urls-input');
const startBtn = $('start-btn');
const cancelBtn = $('cancel-btn');
const closeBtn = $('close-btn');
const statusText = $('status-text');
const progressBar = $('progress-bar');
const results = $('results');

let running = false;

const parseUrls = (text) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

const countUrls = () => parseUrls(urlsInput.value).length;

const refresh = () => {
  const n = countUrls();
  if (running) {
    startBtn.disabled = true;
    fileInput.disabled = true;
    cancelBtn.disabled = false;
    statusText.textContent = 'Идёт обработка...';
  } else {
    fileInput.disabled = false;
    cancelBtn.disabled = true;
    startBtn.disabled = n === 0;
    statusText.textContent = n > 0 ? `Готово к запуску (${n} URL)` : 'Готово к запуску';
  }
};

const addResult = (cls, text) => {
  const li = document.createElement('li');
  li.className = cls;
  li.textContent = text;
  results.appendChild(li);
  results.scrollTop = results.scrollHeight;
};

fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  fileName.textContent = file.name;
  const reader = new FileReader();
  reader.onload = (e) => {
    urlsInput.value = String((e.target && e.target.result) || '');
    refresh();
  };
  reader.onerror = () => {
    fileName.textContent = `${file.name} (ошибка чтения)`;
  };
  reader.readAsText(file);
});

urlsInput.addEventListener('input', () => {
  if (fileInput.files && fileInput.files[0]) {
    fileInput.value = '';
    fileName.textContent = 'файл не выбран';
  }
  refresh();
});

startBtn.addEventListener('click', async () => {
  const urls = parseUrls(urlsInput.value);
  if (urls.length === 0) return;
  running = true;
  results.innerHTML = '';
  progressBar.value = 0;
  progressBar.max = urls.length;
  refresh();
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'BATCH_START', urls });
    if (reply && reply.skipped) {
      addResult('skip', '⚠ уже идёт другой batch — этот запрос пропущен');
      running = false;
      refresh();
    }
  } catch (err) {
    addResult('error', `Не удалось отправить запрос: ${err && err.message ? err.message : err}`);
    running = false;
    refresh();
  }
});

cancelBtn.addEventListener('click', async () => {
  cancelBtn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'BATCH_CANCEL' });
  } catch (_e) {
    // ignore — SW may have already finished
  }
});

closeBtn.addEventListener('click', () => window.close());

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'BATCH_PROGRESS') {
    const { done, total, current, status, filename, error } = msg;
    progressBar.value = done;
    progressBar.max = total || 1;
    statusText.textContent = `${done}/${total} — ${current}`;
    if (status === 'done') {
      addResult('done', `✓ ${current} → ${filename || ''}`);
    } else if (status === 'error') {
      const errMsg = (error && error.message) || 'error';
      addResult('error', `✗ ${current} → ${errMsg}`);
    }
  } else if (msg.type === 'BATCH_FINISHED') {
    running = false;
    const { done, total, failed, cancelled } = msg;
    const tail = cancelled ? ' (отменено)' : '';
    statusText.textContent = `Завершено: ${done}/${total} (ошибок: ${failed})${tail}`;
    refresh();
  }
});

refresh();
