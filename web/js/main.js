// 墨阅 · 入口：初始化各模块并连接界面交互
import * as host from './host.js';
import { store, keyOf, DEFAULT_SETTINGS } from './store.js';
import { applyTheme, applyTypography, applyCustomCss, findTheme, activeThemeId, onSystemSchemeChange, BUILTIN_THEMES } from './themes.js';
import { hydrateIcons, icon, h, toast, menu, modal, closePopover, escapeHtml, relTime, formatPct, formatBytes, formatMinutes, copyText, lightbox, clamp } from './ui.js';
import { Reader, MD_EXT, baseName } from './reader.js';
import { Sidebar } from './sidebar.js';
import { Search } from './search.js';
import { Settings, stepSetting } from './settings.js';

const VERSION = '1.0.0';
const $ = (id) => document.getElementById(id);

// 启动时一次性缓存界面元素（文档标题的锚点可能与界面元素同名，之后不再按 id 查找）
const els = {
  app: $('app'),
  sidebar: $('sidebar'),
  sbBody: $('sb-body'),
  sbFoot: $('sb-foot'),
  sbResizer: $('sb-resizer'),
  toc: $('toc'),
  bookmarks: $('bookmarks'),
  tocFilter: $('toc-filter'),
  tocFilterBox: $('toc-filter-box'),
  tocTools: $('toc-tools'),
  tocCount: $('toc-count'),
  main: $('main'),
  topbar: $('topbar'),
  tbDoc: $('tb-doc'),
  tbSep: $('tb-sep'),
  tbChapter: $('tb-chapter'),
  tbPct: $('tb-pct'),
  progressBar: $('progress-line').firstElementChild,
  reader: $('reader'),
  doc: $('doc'),
  notice: $('notice'),
  welcome: $('welcome'),
  recentList: $('recent-list'),
  loading: $('loading'),
  loadingText: $('loading-text'),
  searchBar: $('search-bar'),
  fileInput: $('file-input'),
  btn: {
    sidebar: $('btn-sidebar'),
    sbClose: $('btn-sb-close'),
    search: $('btn-search'),
    bookmark: $('btn-bookmark'),
    appearance: $('btn-appearance'),
    menu: $('btn-menu'),
    open: $('btn-open'),
    clearRecent: $('btn-clear-recent'),
    tocLocate: $('btn-toc-locate'),
    tocExpand: $('btn-toc-expand'),
    tocCollapse: $('btn-toc-collapse'),
  },
};

let reader;
let sidebar;
let search;
let settings;
let topbarHidden = false;
let fullscreenOn = false;
let scrollAccum = 0;
let lastFootMinute = -1;
let rootTitle = -1;

// ───────────────────────── 主题与排版 ─────────────────────────
function applyCurrentTheme(animate) {
  const t = findTheme(activeThemeId()) || BUILTIN_THEMES[0];
  const run = () => {
    applyTheme(t);
    host.setTheme(t.colors.bg, t.colors.text, t.dark);
  };
  if (animate && document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.startViewTransition(run);
  } else {
    run();
  }
}

function toggleDark() {
  const cur = findTheme(activeThemeId()) || BUILTIN_THEMES[0];
  const s = store.settings;
  const target = cur.dark ? (findTheme(s.lightTheme) ? s.lightTheme : 'claude-light') : (findTheme(s.darkTheme) ? s.darkTheme : 'claude-dark');
  store.set('followSystem', false);
  store.set('theme', target);
}

function applySidebar() {
  els.app.classList.toggle('sidebar-hidden', !store.settings.sidebar);
  els.btn.sidebar.classList.toggle('on', !!store.settings.sidebar && !!reader?.doc);
}

function toggleSidebar(force) {
  const v = typeof force === 'boolean' ? force : !store.settings.sidebar;
  store.set('sidebar', v);
}

const LAYOUT_KEYS = new Set(['font', 'customFont', 'fontSize', 'lineHeight', 'contentWidth', 'paraSpacing', 'indent', 'justify', 'autospace', 'mathScale']);

function onSettingChanged(key, value) {
  if (key === 'theme' || key === 'followSystem' || key === 'lightTheme' || key === 'darkTheme') applyCurrentTheme(true);
  else if (LAYOUT_KEYS.has(key)) reader.relayout(() => applyTypography());
  else if (key === 'sidebarWidth') applyTypography();
  else if (key === 'customCss') reader.relayout(() => applyCustomCss(value));
  else if (key === 'showProgress') els.app.classList.toggle('hide-progress', !value);
  else if (key === 'autoHideTopbar') { if (!value) showTopbar(); }
  else if (key === 'breaks') { if (reader.doc) reader.reload({ silent: true }); }
  else if (key === 'tocDepth') { if (reader.doc) { sidebar.build(reader.doc.headings); sidebar.setActive(reader.currentHeading); } }
  else if (key === 'sidebar') applySidebar();
}

// ───────────────────────── 视图状态 ─────────────────────────
function setView(hasDoc) {
  els.app.classList.toggle('no-doc', !hasDoc);
  els.welcome.hidden = hasDoc;
  els.reader.hidden = !hasDoc;
  els.tbPct.hidden = !hasDoc;
  els.btn.search.hidden = !hasDoc;
  els.btn.bookmark.hidden = !hasDoc;
  els.btn.sidebar.hidden = !hasDoc;
  if (!hasDoc) {
    els.tbDoc.textContent = '';
    els.tbChapter.textContent = '';
    els.tbSep.hidden = true;
    els.notice.hidden = true;
    showTopbar();
    renderWelcome();
    host.setTitle('墨阅');
  }
  applySidebar();
}

function renderWelcome() {
  const list = store.recentFiles();
  els.btn.clearRecent.hidden = !list.length;
  if (!list.length) {
    els.recentList.innerHTML = '<div class="wl-empty">还没有阅读记录。打开过的文件会出现在这里，并记住你读到了哪儿。</div>';
    return;
  }
  els.recentList.innerHTML = list.slice(0, 12).map((f) => {
    const pct = f.pct || 0;
    return `<div class="recent-card" data-path="${escapeHtml(f.path)}" title="${escapeHtml(f.path)}">
      <div class="recent-ico">${icon('file')}</div>
      <div class="recent-main">
        <div class="recent-name">${escapeHtml(f.title || baseName(f.path))}</div>
        <div class="recent-path">${escapeHtml(f.path)}</div>
        <div class="recent-prog"><div class="recent-bar"><i style="width:${(pct * 100).toFixed(1)}%"></i></div><span class="recent-meta">${formatPct(pct)}${f.chapter ? ' · ' + escapeHtml(f.chapter) : ''} · ${relTime(f.read)}</span></div>
      </div>
      <button class="icon-btn sm recent-del" data-del="${escapeHtml(f.path)}" title="从列表中移除">${icon('close')}</button>
    </div>`;
  }).join('');
}

// ───────────────────────── 打开文件 ─────────────────────────
async function openPath(path, opts = {}) {
  if (!path) return false;
  closePopover();
  const ok = await reader.open(path, opts);
  if (ok && reader.doc) {
    if (!reader.doc.virtual) host.watch(reader.doc.path);
    if (opts.hash) {
      let id = opts.hash;
      try { id = decodeURIComponent(id); } catch (_) { /* 保持原样 */ }
      reader.jumpToId(id);
    }
  } else if (!reader.doc) {
    setView(false);
  }
  return ok;
}

function openDialog() {
  if (!host.openDialog()) els.fileInput.click();
}

function closeDoc() {
  reader.close();
  host.watch('');
  sidebar.clear();
  search.close();
  setView(false);
}

function onOpenError(path, err) {
  const inRecent = store.data.recent.includes(keyOf(path));
  toast(`无法打开“${baseName(path)}”：${err.message || err}`, inRecent ? {
    action: '从列表移除',
    onAction: () => { store.removeRecent(path); if (!reader.doc) renderWelcome(); },
  } : {});
}

// ───────────────────────── 进度与章节显示 ─────────────────────────
function readMinutes(stats) {
  return stats.wide / 380 + stats.narrow / 5.5 / 220;
}

function formatCount(stats) {
  const n = stats.wide + Math.round(stats.narrow / 5.5);
  return n >= 10000 ? (n / 10000).toFixed(1) + ' 万字' : n + ' 字';
}

function updateFoot(p) {
  const d = reader.doc;
  if (!d) { els.sbFoot.textContent = ''; return; }
  const total = readMinutes(d.stats);
  const left = Math.max(0, Math.round(total * (1 - p)));
  if (left === lastFootMinute && els.sbFoot.childElementCount) return;
  lastFootMinute = left;
  els.sbFoot.innerHTML = `<span>${formatCount(d.stats)}</span><span>${p >= 0.9995 ? '已读完' : '剩余约 ' + formatMinutes(left)}</span>`;
}

function updateProgressUI(p) {
  els.progressBar.style.transform = `scaleX(${p.toFixed(4)})`;
  els.tbPct.textContent = formatPct(p);
  updateFoot(p);
}

function updateHeadingUI(i) {
  sidebar.setActive(i);
  const d = reader.doc;
  if (!d || i < 0 || i === rootTitle) {
    els.tbChapter.textContent = '';
    els.tbSep.hidden = true;
    return;
  }
  const hs = d.headings;
  const parent = sidebar.parent ? sidebar.parent[i] : -1;
  let text = hs[i].text;
  if (parent >= 0 && parent !== rootTitle) text = hs[parent].text + ' › ' + text;
  els.tbChapter.textContent = text;
  els.tbSep.hidden = false;
}

// ───────────────────────── 顶栏自动隐藏 ─────────────────────────
function hideTopbar() {
  if (topbarHidden) return;
  topbarHidden = true;
  els.topbar.classList.add('concealed');
}
function showTopbar() {
  if (!topbarHidden) return;
  topbarHidden = false;
  els.topbar.classList.remove('concealed');
}
function onScrollDelta(dy, st) {
  els.topbar.classList.toggle('scrolled', st > 8);
  if (!store.settings.autoHideTopbar) return;
  if (search.isOpen || document.querySelector('.popover') || st < 80) { scrollAccum = 0; showTopbar(); return; }
  if (dy > 0) {
    scrollAccum = Math.max(0, scrollAccum) + dy;
    if (scrollAccum > 30) hideTopbar();
  } else if (dy < 0) {
    scrollAccum = Math.min(0, scrollAccum) + dy;
    if (scrollAccum < -30) showTopbar();
  }
}

// ───────────────────────── 书签 ─────────────────────────
function snippetAt(doc, line) {
  for (let i = line; i < Math.min(doc.lines.length, line + 8); i++) {
    const s = doc.lines[i]
      .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+|\|)/, '')
      .replace(/\\\(|\\\)|\$\$?|[*_`~|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (s) return s.slice(0, 120);
  }
  return '';
}

function addBookmark() {
  const doc = reader.doc;
  if (!doc) return;
  if (doc.virtual) { toast('临时打开的文件无法保存书签'); return; }
  const a = reader.saveProgress(false) || reader.captureAnchor();
  if (!a) return;
  const f = store.file(doc.path) || store.updateFile(doc.path, {});
  const list = (f.bookmarks || []).slice();
  if (list.some((b) => b.pos && b.pos.line === a.line && Math.abs((b.pos.ratio || 0) - a.ratio) < 0.35)) {
    toast('这里已经有一个书签了');
    return;
  }
  const hi = reader.currentHeading;
  list.push({
    id: 'bm' + Date.now().toString(36),
    pos: a,
    pct: a.pct,
    title: hi >= 0 ? doc.headings[hi].text : doc.title,
    snippet: snippetAt(doc, a.line),
    created: Date.now(),
  });
  store.updateFile(doc.path, { bookmarks: list });
  store.save(true);
  if (sidebar.tab === 'bookmarks') sidebar.renderBookmarks();
  toast('已添加书签', { action: '查看', onAction: () => { toggleSidebar(true); sidebar.showTab('bookmarks'); } });
}

// ───────────────────────── 对话框 ─────────────────────────
function showDocInfo() {
  const d = reader.doc;
  if (!d) return;
  const s = d.stats;
  const dl = h('dl', { class: 'kv' });
  const add = (k, v) => dl.append(h('dt', null, k), h('dd', null, v));
  add('文件', d.virtual ? d.name : d.path);
  add('大小', formatBytes(d.size));
  add('编码', d.encoding);
  add('行数', d.lines.length.toLocaleString());
  add('字数', formatCount(s));
  add('标题', s.headings + ' 个');
  add('公式', `${s.formulas} 个（独立公式 ${s.displayFormulas} 个）`);
  add('表格', s.tables + ' 个');
  if (s.images) add('图片', s.images + ' 张');
  if (s.codes) add('代码块', s.codes + ' 个');
  add('预计阅读', formatMinutes(readMinutes(s)));
  add('当前进度', formatPct(reader.progress));
  if (d.timing && d.timing.total != null) add('排版耗时', `${d.timing.total} 毫秒（${d.chunks.length} 个分块）`);
  modal({ title: '文档信息', body: dl, width: 560 });
}

function showGoto() {
  if (!reader.doc) return;
  const input = h('input', { class: 'text-input', type: 'number', min: 0, max: 100, step: 'any', value: Math.round(reader.progress * 1000) / 10, style: { width: '120px' } });
  const go = () => {
    const v = parseFloat(input.value);
    if (Number.isNaN(v)) return false;
    reader.jumpToPct(clamp(v, 0, 100) / 100);
    return true;
  };
  const m = modal({
    title: '跳转到进度',
    body: h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, h('span', null, '跳转到'), input, h('span', null, '%')),
    actions: [{ label: '取消' }, { label: '跳转', primary: true, onClick: go }],
    width: 380,
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (go()) m.close(); } });
  setTimeout(() => { input.focus(); input.select(); }, 30);
}

function showShortcuts() {
  const rows = [
    ['打开文件', 'Ctrl + O'],
    ['在文档中查找', 'Ctrl + F'],
    ['下一个 / 上一个结果', 'Enter / Shift + Enter，F3'],
    ['显示或隐藏侧栏', 'Ctrl + B'],
    ['添加书签', 'Ctrl + D'],
    ['跳转到进度', 'Ctrl + G'],
    ['上一章 / 下一章', '[ / ]'],
    ['返回 / 前进（跳转之后）', 'Alt + ← / Alt + →'],
    ['翻页', '空格 / Shift + 空格'],
    ['回到开头 / 跳到结尾', 'Home / End'],
    ['放大 / 缩小 / 还原字号', 'Ctrl + = / Ctrl + - / Ctrl + 0'],
    ['切换浅色 / 深色', 'Ctrl + Shift + L'],
    ['重新载入文件', 'F5'],
    ['全屏', 'F11'],
    ['设置', 'Ctrl + ,'],
    ['打印 / 导出 PDF', 'Ctrl + P'],
  ];
  const grid = h('div', { class: 'keys' });
  for (const [k, v] of rows) grid.append(h('span', null, k), h('span', { class: 'k' }, ...v.split(/(\s*[/+，]\s*)/).map((part) => (/^\s*[/+，]\s*$/.test(part) || !part.trim() ? part : h('span', { class: 'kbd' }, part.trim())))));
  modal({ title: '快捷键', body: grid, width: 520 });
}

function showAbout() {
  const body = h('div', null,
    h('p', { style: { margin: '0 0 10px', fontFamily: 'var(--font-body)', fontSize: '16px', color: 'var(--heading)' } }, `墨阅 ${VERSION}`),
    h('p', { style: { margin: '0 0 10px', color: 'var(--text-2)' } }, '一个轻量的 Markdown 阅读器：舒适的排版、完整的公式与表格支持、可自定义的主题，以及可靠的阅读进度记忆。'),
    h('p', { style: { margin: 0, color: 'var(--text-3)', fontSize: '12.5px' } }, host.isNative ? '阅读进度会在停止滚动后立即写入磁盘，并在关闭窗口时再次保存。' : '当前运行于浏览器调试模式，进度保存在浏览器本地存储中。'));
  modal({ title: '关于', body, width: 460 });
}

function printDoc() {
  if (!reader.doc) return;
  els.doc.classList.add('printing');
  window.addEventListener('afterprint', () => els.doc.classList.remove('printing'), { once: true });
  setTimeout(() => window.print(), 50);
}

// 去掉菜单中多余的分隔线
function tidy(items) {
  const out = [];
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep' && (!out.length || out[out.length - 1] === 'sep')) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1] === 'sep') out.pop();
  return out;
}

function openMainMenu(anchor) {
  const doc = reader.doc;
  const recent = store.recentFiles().filter((f) => !doc || keyOf(f.path) !== keyOf(doc.path)).slice(0, 8);
  menu(anchor, tidy([
    { label: '打开文件…', icon: 'folder', key: 'Ctrl+O', onClick: openDialog },
    recent.length ? { title: '最近阅读' } : null,
    ...recent.map((f) => ({ label: f.title || baseName(f.path), tip: f.path, icon: 'file', key: formatPct(f.pct || 0), onClick: () => openPath(f.path) })),
    'sep',
    doc && !doc.virtual ? { label: '重新载入', icon: 'refresh', key: 'F5', onClick: () => reader.reload() } : null,
    doc && !doc.virtual && host.isNative ? { label: '在资源管理器中显示', icon: 'reveal', onClick: () => host.reveal(doc.path) } : null,
    doc ? { label: '跳转到进度…', icon: 'jump', key: 'Ctrl+G', onClick: showGoto } : null,
    doc ? { label: '文档信息', icon: 'info', onClick: showDocInfo } : null,
    doc ? { label: '打印 / 导出 PDF', icon: 'print', key: 'Ctrl+P', onClick: printDoc } : null,
    doc ? { label: '关闭文档', icon: 'close', onClick: closeDoc } : null,
    'sep',
    { label: '切换浅色 / 深色', icon: 'moon', key: 'Ctrl+Shift+L', onClick: toggleDark },
    { label: '全屏', icon: 'fullscreen', key: 'F11', onClick: () => host.toggleFullscreen() },
    { label: '设置', icon: 'settings', key: 'Ctrl+,', onClick: () => settings.openDrawer() },
    { label: '快捷键', icon: 'keyboard', onClick: showShortcuts },
  ]));
}

function selectedText() {
  const sel = window.getSelection();
  const t = sel && !sel.isCollapsed ? sel.toString().trim() : '';
  return t.length <= 80 && !t.includes('\n') ? t : '';
}

// ───────────────────────── 事件绑定 ─────────────────────────
function bindUi() {
  els.btn.open.addEventListener('click', openDialog);
  els.btn.sidebar.addEventListener('click', () => toggleSidebar());
  els.btn.sbClose.addEventListener('click', () => toggleSidebar(false));
  els.btn.search.addEventListener('click', () => (search.isOpen ? search.close() : search.open(selectedText())));
  els.btn.bookmark.addEventListener('click', addBookmark);
  els.btn.appearance.addEventListener('click', () => settings.openQuick(els.btn.appearance));
  els.btn.menu.addEventListener('click', () => openMainMenu(els.btn.menu));
  els.btn.clearRecent.addEventListener('click', () => { store.clearRecent(); renderWelcome(); });
  els.btn.tocLocate.addEventListener('click', () => sidebar.locate());
  els.btn.tocExpand.addEventListener('click', () => sidebar.expandAll(true));
  els.btn.tocCollapse.addEventListener('click', () => sidebar.expandAll(false));
  els.tbPct.addEventListener('click', showGoto);

  els.recentList.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); store.removeRecent(del.dataset.del); renderWelcome(); return; }
    const card = e.target.closest('.recent-card');
    if (card) openPath(card.dataset.path);
  });

  // 浏览器调试模式下的文件选择
  els.fileInput.addEventListener('change', () => {
    const f = els.fileInput.files && els.fileInput.files[0];
    if (f) reader.open(f.name, { file: f }).then((ok) => { if (!ok && !reader.doc) setView(false); });
    els.fileInput.value = '';
  });

  // 鼠标靠近顶部时显示顶栏
  els.main.addEventListener('pointermove', (e) => {
    if (topbarHidden && e.clientY - els.main.getBoundingClientRect().top < 60) showTopbar();
  }, { passive: true });

  // 侧栏宽度拖动
  els.sbResizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = store.settings.sidebarWidth;
    const target = els.sbResizer;
    target.classList.add('dragging');
    target.setPointerCapture(e.pointerId);
    const widthAt = (x) => Math.round(clamp(startW + x - startX, 200, 520));
    const move = (ev) => document.documentElement.style.setProperty('--sidebar-w', widthAt(ev.clientX) + 'px');
    const up = (ev) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.classList.remove('dragging');
      store.set('sidebarWidth', widthAt(ev.clientX));
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  });

  // 窄窗口下，点击正文收起浮层式侧栏
  els.reader.addEventListener('pointerdown', () => {
    if (window.innerWidth <= 860 && store.settings.sidebar) toggleSidebar(false);
  });

  // Ctrl + 滚轮调整字号
  let wheelAcc = 0;
  els.main.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) >= 50) {
      stepSetting('fontSize', wheelAcc < 0 ? 1 : -1);
      wheelAcc = 0;
    }
  }, { passive: false });

  // 鼠标侧键：返回 / 前进
  const onAux = (e) => {
    if (e.button === 3 || e.button === 4) {
      e.preventDefault();
      if (e.type === 'mouseup') { if (e.button === 3) reader.back(); else reader.forward(); }
    }
  };
  window.addEventListener('mousedown', onAux);
  window.addEventListener('mouseup', onAux);

  // 右键菜单
  els.main.addEventListener('contextmenu', (e) => {
    if (e.target.closest('input, textarea')) return;
    e.preventDefault();
    const doc = reader.doc;
    const sel = window.getSelection();
    const text = sel && !sel.isCollapsed ? sel.toString().trim() : '';
    const tex = reader.texAt(e.target);
    const link = e.target.closest('a[href]');
    const img = e.target.closest('img');
    const items = [];
    if (text) {
      items.push({ label: '复制', icon: 'copy', key: 'Ctrl+C', onClick: () => document.execCommand('copy') });
      if (doc) items.push({ label: `查找“${text.length > 14 ? text.slice(0, 14) + '…' : text}”`, icon: 'search', onClick: () => search.open(text.split('\n')[0].slice(0, 80)) });
    }
    if (tex) items.push({ label: '复制公式源码', icon: 'sigma', onClick: () => copyText(tex).then((ok) => toast(ok ? '已复制公式源码' : '复制失败')) });
    if (link) items.push({ label: '复制链接地址', icon: 'copy', onClick: () => copyText(link.getAttribute('href')).then(() => toast('已复制链接')) });
    if (img) items.push({ label: '查看大图', icon: 'external', onClick: () => lightbox(img.currentSrc || img.src) });
    if (doc) {
      items.push('sep');
      items.push({ label: '为当前位置添加书签', icon: 'bookmark', key: 'Ctrl+D', onClick: addBookmark });
      if (reader.history.length) items.push({ label: '返回跳转前的位置', icon: 'back', key: 'Alt+←', onClick: () => reader.back() });
      items.push({ label: '跳转到进度…', icon: 'jump', key: 'Ctrl+G', onClick: showGoto });
      items.push({ label: '全选正文', onClick: () => { const r = document.createRange(); r.selectNodeContents(els.doc); sel.removeAllRanges(); sel.addRange(r); } });
    } else {
      items.push({ label: '打开文件…', icon: 'folder', key: 'Ctrl+O', onClick: openDialog });
    }
    menu({ x: e.clientX, y: e.clientY }, tidy(items));
  });

  // 拖放打开
  let dragDepth = 0;
  let veil = null;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  const showVeil = () => { if (!veil) { veil = h('div', { class: 'drop-veil' }, '松开鼠标，打开这份文档'); document.body.append(veil); } };
  const hideVeil = () => { if (veil) { veil.remove(); veil = null; } };
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; showVeil(); });
  window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) hideVeil(); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    hideVeil();
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])].filter((f) => MD_EXT.test(f.name));
    if (!files.length) { if (e.dataTransfer && e.dataTransfer.files.length) toast('只能打开 Markdown 或纯文本文件'); return; }
    if (host.isNative && host.sendDroppedFiles(files.slice(0, 1))) return;
    reader.open(files[0].name, { file: files[0] });
  });

  // 键盘
  document.addEventListener('keydown', onKeyDown);

  // 离开窗口、隐藏时立即保存
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') reader.saveProgress(); });
  window.addEventListener('blur', () => reader.saveProgress());
  window.addEventListener('pagehide', () => reader.saveProgress());
}

function onKeyDown(e) {
  const t = e.target;
  const tag = (t && t.tagName ? t.tagName : '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable);
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key;
  const lower = k.length === 1 ? k.toLowerCase() : k;

  if (ctrl && !e.altKey && !e.shiftKey) {
    switch (lower) {
      case 'o': e.preventDefault(); openDialog(); return;
      case 'f': e.preventDefault(); if (reader.doc) search.open(selectedText()); return;
      case 'b': case '\\': e.preventDefault(); if (reader.doc) toggleSidebar(); return;
      case ',': e.preventDefault(); settings.openDrawer(); return;
      case '=': case '+': e.preventDefault(); stepSetting('fontSize', 1); return;
      case '-': case '_': e.preventDefault(); stepSetting('fontSize', -1); return;
      case '0': e.preventDefault(); store.set('fontSize', DEFAULT_SETTINGS.fontSize); return;
      case 'd': e.preventDefault(); addBookmark(); return;
      case 'g': e.preventDefault(); showGoto(); return;
      case 'p': e.preventDefault(); printDoc(); return;
      case 'r': e.preventDefault(); reader.reload(); return;
      default: break;
    }
  }
  if (ctrl && e.shiftKey && lower === 'i') { e.preventDefault(); host.openDevTools(); return; }
  if (ctrl && e.shiftKey && lower === 'l') { e.preventDefault(); toggleDark(); return; }
  if (k === 'F12') { e.preventDefault(); host.openDevTools(); return; }
  if (k === 'F11') { e.preventDefault(); host.toggleFullscreen(); return; }
  if (k === 'F5') { e.preventDefault(); reader.reload(); return; }
  if (k === 'F3') {
    e.preventDefault();
    if (!reader.doc) return;
    if (!search.isOpen) search.open(selectedText()); else search.step(e.shiftKey ? -1 : 1);
    return;
  }
  if (e.altKey && k === 'ArrowLeft') { e.preventDefault(); reader.back(); return; }
  if (e.altKey && k === 'ArrowRight') { e.preventDefault(); reader.forward(); return; }
  if (typing) return;
  if (k === 'Escape') {
    if (search.isOpen) { search.close(); return; }
    if (document.querySelector('.popover')) { closePopover(); return; }
    if (fullscreenOn) host.toggleFullscreen();
    return;
  }
  if (!reader.doc || ctrl || e.altKey) return;
  if (k === '[') { e.preventDefault(); reader.jumpChapter(-1); return; }
  if (k === ']') { e.preventDefault(); reader.jumpChapter(1); return; }
  if (k === '?') { e.preventDefault(); showShortcuts(); return; }

  // 焦点不在阅读区时，接管翻页类按键
  const sc = els.reader;
  if (document.activeElement !== sc && !sc.contains(document.activeElement)) {
    const page = sc.clientHeight - 90;
    let dy = null;
    switch (k) {
      case ' ': dy = e.shiftKey ? -page : page; break;
      case 'PageDown': dy = page; break;
      case 'PageUp': dy = -page; break;
      case 'ArrowDown': dy = 64; break;
      case 'ArrowUp': dy = -64; break;
      case 'Home': e.preventDefault(); sc.scrollTop = 0; sc.focus({ preventScroll: true }); return;
      case 'End': e.preventDefault(); sc.scrollTop = sc.scrollHeight; sc.focus({ preventScroll: true }); return;
      default: break;
    }
    if (dy != null) {
      e.preventDefault();
      sc.scrollBy({ top: dy, behavior: 'smooth' });
      sc.focus({ preventScroll: true });
    }
  }
}

function bindHost() {
  host.on('open', (m) => { if (m.path) openPath(m.path); });
  host.on('file-changed', (m) => {
    if (!reader.doc || keyOf(m.path) !== keyOf(reader.doc.path)) return;
    if (store.settings.autoReload) {
      reader.reload({ silent: true }).then((ok) => { if (ok) toast('文件已更新，已保持位置重新载入'); });
    } else {
      toast('文件已在外部被修改', { action: '重新载入', onAction: () => reader.reload() });
    }
  });
  host.on('fonts', (m) => settings.setFonts(m.list || []));
  host.on('fullscreen', (m) => { fullscreenOn = !!m.on; });
  host.on('saved', (m) => toast('已保存：' + (m.path || '')));
  host.on('toast', (m) => toast(m.message || ''));
}

// ───────────────────────── 启动 ─────────────────────────
async function boot() {
  hydrateIcons();
  const init = await host.ready();
  store.load(init.state, init.stateBak);
  applyCurrentTheme(false);
  applyTypography();
  applyCustomCss(store.settings.customCss);
  els.app.classList.toggle('hide-progress', !store.settings.showProgress);
  onSystemSchemeChange(() => { if (store.settings.followSystem) applyCurrentTheme(true); });

  reader = new Reader({
    scroller: els.reader,
    article: els.doc,
    callbacks: {
      onLoading(on) {
        els.loading.hidden = !on;
        if (on) els.welcome.hidden = true;
      },
      onBeforeMount() {
        setView(true);
        els.notice.hidden = true;
      },
      onMount(doc) {
        els.tbDoc.textContent = doc.title;
        host.setTitle(`${doc.name} - 墨阅`);
        const hs = doc.headings;
        rootTitle = hs.length && hs[0].level === 1 && hs.filter((x) => x.level === 1).length === 1 ? 0 : -1;
        sidebar.build(hs);
        if (sidebar.tab === 'bookmarks') sidebar.renderBookmarks();
        search.invalidate();
        lastFootMinute = -1;
        applySidebar();
        if (doc.renderError) {
          els.notice.hidden = false;
          els.notice.textContent = '排版时遇到问题，已改为纯文本显示：' + doc.renderError.message;
        }
      },
      onRestored(doc, { restored, entry }) {
        if (restored && entry && entry.pct > 0.002 && entry.pct < 0.9995) {
          toast(`已回到上次读到的位置 · ${formatPct(entry.pct)}`, { action: '从头开始', onAction: () => reader.jumpToPct(0) });
        }
        els.reader.focus({ preventScroll: true });
      },
      onError: onOpenError,
      onProgress: updateProgressUI,
      onHeading: updateHeadingUI,
      onScrollDelta,
      onOpenLink: (path, hash) => openPath(path, { hash }),
      onImage: (img) => lightbox(img.currentSrc || img.src),
      onCopyCode: (text, btn) => copyText(text).then((ok) => {
        btn.textContent = ok ? '已复制' : '复制失败';
        setTimeout(() => { btn.textContent = '复制'; }, 1400);
      }),
      onNotice: (msg) => toast(msg),
    },
  });

  sidebar = new Sidebar({
    toc: els.toc,
    bookmarks: els.bookmarks,
    filter: els.tocFilter,
    filterBox: els.tocFilterBox,
    tools: els.tocTools,
    count: els.tocCount,
    body: els.sbBody,
    tabs: [...els.sidebar.querySelectorAll('.sb-tab')],
  }, reader, {
    getActive: () => reader.currentHeading,
    onNavigate: () => { if (window.innerWidth <= 860) toggleSidebar(false); },
  });

  search = new Search({
    bar: els.searchBar,
    input: $('search-input'),
    count: $('search-count'),
    prev: $('search-prev'),
    next: $('search-next'),
    close: $('search-close'),
    caseBtn: $('search-case'),
  }, reader);

  settings = new Settings({
    previewTheme: (t) => { applyTheme(t); host.setTheme(t.colors.bg, t.colors.text, t.dark); },
    restoreTheme: () => applyCurrentTheme(false),
    showShortcuts,
    showAbout,
    clearProgress: () => { store.clearAllProgress(); if (reader.doc) reader.saveProgress(); toast('阅读记录已清除'); if (!reader.doc) renderWelcome(); },
  });

  store.onChange(onSettingChanged);
  bindUi();
  bindHost();

  // 调试入口（开发者工具中使用）
  window.__mdreader = { reader, store, sidebar, search, settings };

  // 宿主关闭窗口前调用：返回最新状态，由宿主同步写盘
  window.__mdreaderFlush = () => {
    try { reader.saveProgress(false); } catch (_) { /* 忽略 */ }
    return store.flush();
  };

  const startPath = init.open || (store.settings.reopenLast ? store.lastFile() : '');
  if (startPath) {
    els.welcome.hidden = true;
    els.loading.hidden = false;
    const ok = await openPath(startPath);
    if (!ok && !reader.doc) setView(false);
  } else {
    setView(false);
  }
  els.loading.hidden = true;
  if (host.isNative) host.send('app-ready');
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<div style="position:fixed;inset:auto 20px 20px;padding:14px 18px;border-radius:12px;background:#fee;color:#900;font:14px sans-serif;z-index:999">启动失败：${escapeHtml(err && err.message)}</div>`);
});
