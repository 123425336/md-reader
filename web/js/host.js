// 墨阅 · 宿主通信桥
// 桌面版中通过内嵌浏览器的消息通道与原生宿主通信；在普通浏览器中调试时自动降级为本地存储方案。

const wv = (window.chrome && window.chrome.webview) || null;
const SEP = '\u001f'; // 消息字段分隔符（单元分隔符，不会出现在路径和正文里）
const STORAGE_KEY = 'mdreader.state';
const handlers = new Map();

export const isNative = !!wv;

function dispatch(msg) {
  const list = handlers.get(msg.type);
  if (!list) return;
  for (const fn of [...list]) {
    try { fn(msg); } catch (err) { console.error('处理宿主消息出错：', msg.type, err); }
  }
}

if (wv) {
  wv.addEventListener('message', (e) => {
    let data = e.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (_) { return; }
    }
    if (data && data.type) dispatch(data);
  });
}

// 订阅宿主消息，返回取消函数
export function on(type, fn) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
  return () => handlers.get(type).delete(fn);
}

// 向宿主发送命令
export function send(cmd, ...args) {
  if (!wv) return false;
  wv.postMessage([cmd, ...args.map((a) => (a == null ? '' : String(a)))].join(SEP));
  return true;
}

// 等待宿主下发初始化数据
export function ready() {
  return new Promise((resolve) => {
    if (!wv) {
      let state = null;
      try { state = localStorage.getItem(STORAGE_KEY); } catch (_) { state = null; }
      const params = new URLSearchParams(location.search);
      resolve({ type: 'init', state, stateBak: null, open: params.get('open') || '', version: 'dev', native: false });
      return;
    }
    const off = on('init', (msg) => { off(); resolve(msg); });
    send('ready');
  });
}

// 持久化状态（宿主负责原子写盘）
export function saveState(json) {
  if (wv) { send('save-state', json); return; }
  try { localStorage.setItem(STORAGE_KEY, json); } catch (_) { /* 忽略 */ }
}

// 本地文件路径 → 可读取的地址
export function fileUrl(path) {
  const p = String(path).replace(/\\/g, '/');
  return '/@fs/' + encodeURIComponent(p).replace(/%2F/gi, '/').replace(/%3A/gi, ':');
}

export function openDialog() {
  if (wv) { send('open-dialog'); return true; }
  return false;
}

export function openExternal(url) {
  if (wv) send('open-external', url);
  else window.open(url, '_blank', 'noopener');
}

export function reveal(path) { send('reveal', path); }
export function setTitle(title) {
  document.title = title;
  send('set-title', title);
}
export function setTheme(bg, text, dark) { send('set-theme', bg, text, dark ? '1' : '0'); }
export function watch(path) { send('watch', path || ''); }
export function toggleFullscreen() {
  if (wv) { send('fullscreen'); return; }
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
}
export function listFonts() { return send('list-fonts'); }
export function openDevTools() { send('devtools'); }
export function openDataDir() { send('open-data-dir'); }

// 保存文本到用户选择的位置（宿主弹出保存对话框）；浏览器中退化为下载
export function saveText(suggestedName, text) {
  if (wv) { send('save-text', suggestedName, text); return; }
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// 拖入的文件交给宿主解析真实路径
export function sendDroppedFiles(files) {
  if (wv && typeof wv.postMessageWithAdditionalObjects === 'function') {
    wv.postMessageWithAdditionalObjects('open-dropped', files);
    return true;
  }
  return false;
}
