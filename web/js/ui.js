// 墨阅 · 通用界面工具：图标、元素构建、提示条、弹出面板、菜单、对话框

// ───────────────────────── 图标（手绘线性图标） ─────────────────────────
const ICONS = {
  panel: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M9.5 4.5v15"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  bookmark: '<path d="M7.2 3.5h9.6c.7 0 1.2.5 1.2 1.2V20l-6-4.2L6 20V4.7c0-.7.5-1.2 1.2-1.2z"/>',
  bookmarkFill: '<path fill="currentColor" d="M7.2 3.5h9.6c.7 0 1.2.5 1.2 1.2V20l-6-4.2L6 20V4.7c0-.7.5-1.2 1.2-1.2z"/>',
  type: '<path d="M3.5 18.5 8.6 5.5h.8l5.1 13M5.4 14h7.2"/><path d="M16.2 12.4c.5-.9 1.4-1.4 2.4-1.4 1.6 0 2.4 1 2.4 2.5v5M21 15.3c-2.9-.2-4.8.6-4.8 2 0 1 .8 1.5 1.9 1.5 1.5 0 2.9-1.1 2.9-2.6"/>',
  more: '<circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  up: '<path d="m6.5 14.5 5.5-5.5 5.5 5.5"/>',
  down: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
  right: '<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>',
  left: '<path d="m14.5 6.5-5.5 5.5 5.5 5.5"/>',
  folder: '<path d="M3.5 7.5c0-1.1.9-2 2-2h3.8l2.2 2.3h7c1.1 0 2 .9 2 2V17c0 1.1-.9 2-2 2h-13c-1.1 0-2-.9-2-2z"/>',
  file: '<path d="M7 3.5h6.8l4.7 4.7V19.5c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1v-15c0-.6.4-1 1-1z"/><path d="M13.5 3.5v5h5M9 13h6.5M9 16.5h6.5"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
  locate: '<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>',
  expand: '<path d="m7.5 14.5 4.5 4.5 4.5-4.5M7.5 9.5 12 5l4.5 4.5"/>',
  collapse: '<path d="m7.5 19.5 4.5-4.5 4.5 4.5M7.5 4.5 12 9l4.5-4.5"/>',
  case: '<path d="M3 17.5 7 6.5h.6l4 11M4.5 13.6h5.6"/><path d="M14.2 11.8c.4-.8 1.2-1.2 2.1-1.2 1.4 0 2.1.9 2.1 2.2v4.7M18.4 14.3c-2.5-.2-4.2.5-4.2 1.8 0 .9.7 1.4 1.7 1.4 1.3 0 2.5-1 2.5-2.3"/>',
  trash: '<path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l.9 11.6c.1 1 .9 1.9 2 1.9h5.2c1.1 0 1.9-.8 2-1.9L17.5 7M9.5 7V4.5h5V7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5.5 12.5 4 4 9-9.5"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5c0-1.1-.9-2-2-2h-7c-1.1 0-2 .9-2 2v7c0 1.1.9 2 2 2h2"/>',
  refresh: '<path d="M19.5 11.5A7.5 7.5 0 1 0 17.3 17M19.5 5v6.5H13"/>',
  external: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13M17.5 14v3.5c0 1.1-.9 2-2 2h-9c-1.1 0-2-.9-2-2v-9c0-1.1.9-2 2-2H10"/>',
  fullscreen: '<path d="M4.5 9V4.5H9M19.5 9V4.5H15M4.5 15v4.5H9M19.5 15v4.5H15"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.4"/>',
  keyboard: '<rect x="3" y="6" width="18" height="12" rx="2.5"/><path d="M7 10h.01M10.5 10h.01M14 10h.01M17.5 10h.01M7.5 14h9"/>',
  print: '<path d="M7 8.5v-5h10v5M7 17H5.5c-1.1 0-2-.9-2-2v-4.5c0-1.1.9-2 2-2h13c1.1 0 2 .9 2 2V15c0 1.1-.9 2-2 2H17"/><rect x="7" y="13.5" width="10" height="7" rx="1"/>',
  back: '<path d="M19 12H5.5M11 6l-6 6 6 6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M5.5 18.5l1.4-1.4M17.1 6.9l1.4-1.4"/>',
  moon: '<path d="M19.5 14.6A7.8 7.8 0 0 1 9.4 4.5a7.8 7.8 0 1 0 10.1 10.1z"/>',
  edit: '<path d="M4.5 19.5h3.8L19 8.8 15.2 5 4.5 15.7z"/><path d="m13.5 6.7 3.8 3.8"/>',
  download: '<path d="M12 4.5v10.5M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  upload: '<path d="M12 15V4.5M7.5 9 12 4.5 16.5 9M5 19.5h14"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.1 0 1.7-.8 1.7-1.6 0-.5-.2-.8-.5-1.1-.3-.3-.5-.7-.5-1.1 0-.9.8-1.6 1.7-1.6h2a4.1 4.1 0 0 0 4.1-4.1c0-4.1-3.8-7.5-8.5-7.5z"/><circle cx="7.6" cy="11" r="1" fill="currentColor"/><circle cx="10.4" cy="7.6" r="1" fill="currentColor"/><circle cx="14.6" cy="7.6" r="1" fill="currentColor"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>',
  jump: '<path d="M5 12h13.5M13 6.5l5.5 5.5-5.5 5.5"/>',
  reveal: '<path d="M3.5 7.5c0-1.1.9-2 2-2h3.8l2.2 2.3h7c1.1 0 2 .9 2 2V12"/><path d="M3.5 7.5V17c0 1.1.9 2 2 2H11"/><circle cx="16.5" cy="16.5" r="3"/><path d="m18.8 18.8 1.9 1.9"/>',
  sigma: '<path d="M17.5 5.5h-11l6 6.5-6 6.5h11"/>',
};

export function icon(name, cls = '') {
  const body = ICONS[name];
  if (!body) return '';
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

// 把页面中 data-icon 占位元素替换为图标
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    const svg = icon(el.dataset.icon);
    if (el.tagName === 'SPAN' && !el.childElementCount && !el.textContent) {
      el.outerHTML = svg;
    } else {
      el.insertAdjacentHTML('afterbegin', svg);
    }
  });
}

// ───────────────────────── 基础工具 ─────────────────────────
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

// 简易元素构建：h('div', {class: 'x', onclick}, child1, 'text')
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// 等待下一帧；窗口被节流或最小化时以定时器兜底，避免流程卡住
export const nextFrame = () => new Promise((r) => {
  let done = false;
  const finish = () => { if (!done) { done = true; r(); } };
  requestAnimationFrame(finish);
  setTimeout(finish, 120);
});

export function debounce(fn, ms) {
  let t = 0;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

// 相对时间：刚刚 / 5 分钟前 / 3 小时前 / 昨天 / 2025-01-02
export function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
  if (d < 2 * 86400e3) return '昨天';
  if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + ' 天前';
  const t = new Date(ts);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

export function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

export function formatPct(p) {
  if (p == null || isNaN(p)) return '';
  if (p >= 0.9995) return '100%';
  if (p < 0.0005) return '0%';
  if (p < 0.1) return (p * 100).toFixed(1) + '%';
  return Math.floor(p * 100) + '%';
}

export function formatMinutes(min) {
  if (min < 1) return '不到 1 分钟';
  if (min < 60) return Math.round(min) + ' 分钟';
  const hr = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${hr} 小时 ${m} 分钟` : `${hr} 小时`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0', top: '0', left: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.remove();
    return ok;
  }
}

// ───────────────────────── 提示条 ─────────────────────────
export function toast(message, opts = {}) {
  const hostEl = document.getElementById('toast-host');
  const el = h('div', { class: 'toast', role: 'status' }, h('span', null, message));
  let timer = 0;
  const close = () => {
    clearTimeout(timer);
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  };
  if (opts.action) {
    el.append(h('button', {
      type: 'button',
      onclick: () => { close(); opts.onAction && opts.onAction(); },
    }, opts.action));
  }
  hostEl.append(el);
  while (hostEl.children.length > 3) hostEl.firstElementChild.remove();
  timer = setTimeout(close, opts.duration ?? (opts.action ? 6000 : 2600));
  return close;
}

// ───────────────────────── 弹出面板 ─────────────────────────
let activePopover = null;

export function closePopover() {
  if (activePopover) {
    const p = activePopover;
    activePopover = null;
    p.close();
  }
}

// anchor：元素或 {x, y} 坐标；content：元素
export function popover(anchor, content, opts = {}) {
  closePopover();
  const el = h('div', { class: 'popover ' + (opts.className || ''), role: opts.role || 'dialog' });
  el.append(content);
  document.body.append(el);

  // 定位：优先显示在锚点下方，靠右对齐
  const pw = el.offsetWidth;
  const ph = el.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x, y;
  if (anchor instanceof Element) {
    const r = anchor.getBoundingClientRect();
    x = opts.align === 'left' ? r.left : r.right - pw;
    y = r.bottom + 6;
    if (y + ph > vh - 8) y = Math.max(8, r.top - ph - 6);
  } else {
    x = anchor.x;
    y = anchor.y;
    if (y + ph > vh - 8) y = Math.max(8, y - ph);
  }
  x = clamp(x, 8, vw - pw - 8);
  y = clamp(y, 8, vh - ph - 8);
  el.style.left = x + 'px';
  el.style.top = y + 'px';

  const onDown = (e) => { if (!el.contains(e.target) && !(anchor instanceof Element && anchor.contains(e.target))) closePopover(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); } };
  const onBlur = () => closePopover();
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', onBlur);
  }, 0);
  document.addEventListener('keydown', onKey, true);

  const handle = {
    el,
    close() {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      el.remove();
      opts.onClose && opts.onClose();
      if (activePopover === handle) activePopover = null;
    },
  };
  activePopover = handle;
  return handle;
}

// 菜单：items 为 {label, icon, key, onClick, disabled} / 'sep' / {title}
export function menu(anchor, items, opts = {}) {
  const box = h('div', { role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep') { box.append(h('div', { class: 'menu-sep' })); continue; }
    if (it.title) { box.append(h('div', { class: 'menu-title' }, it.title)); continue; }
    const btn = h('button', { class: 'menu-item', type: 'button', role: 'menuitem', disabled: !!it.disabled, title: it.tip || null });
    btn.innerHTML = (it.icon ? icon(it.icon) : '<svg viewBox="0 0 24 24"></svg>')
      + `<span class="mi-label">${escapeHtml(it.label)}</span>`
      + (it.key ? `<span class="mi-key">${escapeHtml(it.key)}</span>` : '');
    btn.addEventListener('click', () => { closePopover(); it.onClick && it.onClick(); });
    box.append(btn);
  }
  // 键盘上下选择
  box.addEventListener('keydown', (e) => {
    const list = [...box.querySelectorAll('.menu-item:not(:disabled)')];
    const idx = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); (list[idx + 1] || list[0])?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (list[idx - 1] || list[list.length - 1])?.focus(); }
  });
  const p = popover(anchor, box, { role: 'menu', ...opts });
  return p;
}

// ───────────────────────── 对话框 ─────────────────────────
export function modal({ title, body, actions = [], width, onClose }) {
  const veil = h('div', { class: 'modal-veil' });
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', style: width ? { width: `min(${width}px, 100%)` } : null });
  const closeBtn = h('button', { class: 'icon-btn sm', type: 'button', title: '关闭', html: icon('close') });
  box.append(h('div', { class: 'modal-head' }, h('h2', null, title), closeBtn));
  const bodyEl = h('div', { class: 'modal-body' });
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
  box.append(bodyEl);
  if (actions.length) {
    const foot = h('div', { class: 'modal-foot' });
    for (const a of actions) {
      foot.append(h('button', {
        class: 'btn ' + (a.primary ? 'primary' : '') + (a.danger ? ' danger' : ''),
        type: 'button',
        onclick: () => { if (a.onClick && a.onClick() === false) return; close(); },
      }, a.label));
    }
    box.append(foot);
  }
  veil.append(box);
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  function close() {
    document.removeEventListener('keydown', onKey, true);
    veil.remove();
    onClose && onClose();
  }
  closeBtn.addEventListener('click', close);
  veil.addEventListener('pointerdown', (e) => { if (e.target === veil) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(veil);
  const focusable = box.querySelector('.modal-foot .btn.primary') || closeBtn;
  setTimeout(() => focusable.focus(), 0);
  return { close, body: bodyEl, box };
}

export function confirmDialog(title, message, okLabel = '确定', danger = false) {
  return new Promise((resolve) => {
    let ok = false;
    modal({
      title,
      body: h('p', { style: { margin: '0', color: 'var(--text-2)' } }, message),
      actions: [
        { label: '取消' },
        { label: okLabel, primary: !danger, danger, onClick: () => { ok = true; } },
      ],
      onClose: () => resolve(ok),
    });
  });
}

// 图片放大查看
export function lightbox(src) {
  const veil = h('div', { class: 'lightbox' }, h('img', { src, alt: '' }));
  const close = () => { veil.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  veil.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  document.body.append(veil);
}
