// 墨阅 · 阅读器核心
// 负责：读取并解码文件、调度渲染、挂载分块、估算与测量分块高度、阅读位置的捕获/保存/恢复、目录追踪。
import * as host from './host.js';
import { store } from './store.js';
import { clamp, nextFrame, escapeHtml } from './ui.js';

// 渲染所需脚本（拼接后在 Worker 中运行）
const RENDER_SOURCES = [
  'vendor/markdown-it.min.js',
  'vendor/markdown-it-footnote.min.js',
  'vendor/katex/katex.min.js',
  'vendor/highlight.min.js',
  'js/render/md-plugins.js',
  'js/render/render-core.js',
];
const WORKER_BOOT = 'js/render/worker-boot.js';

export const READ_OFFSET = 64;          // 阅读基准线：距阅读区顶部的距离（位于顶栏下方）
export const MD_EXT = /\.(md|markdown|mdown|mkd|mkdn|mdx|txt)$/i;
const SAVE_DELAY = 350;                 // 停止滚动多久后保存进度
const SAVE_MAX_INTERVAL = 3000;         // 持续滚动时至少每隔多久保存一次

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── 路径工具 ─────────────────────────
export function dirOf(path) {
  const p = String(path).replace(/\\/g, '/');
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i + 1) : '';
}
export function baseName(path) {
  const p = String(path).replace(/\\/g, '/');
  return p.slice(p.lastIndexOf('/') + 1);
}
function normalizePath(p) {
  const unc = p.startsWith('//');
  const parts = p.split('/');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (seg === '' && i > 0 && i < parts.length - 1) continue;
    if (seg === '.') continue;
    if (seg === '..') {
      if (out.length > 1 || (out.length === 1 && !/^[a-zA-Z]:$/.test(out[0]))) out.pop();
      continue;
    }
    out.push(seg);
  }
  let res = out.join('/');
  if (unc && !res.startsWith('//')) res = '//' + res.replace(/^\/+/, '');
  return res;
}
// 把文档中的相对路径解析为本地绝对路径（Windows 风格）
export function resolvePath(baseDir, rel) {
  let p = rel;
  try { p = decodeURIComponent(p); } catch (_) { /* 保持原样 */ }
  p = p.replace(/^file:\/*/i, '').replace(/\\/g, '/');
  let abs;
  if (/^[a-zA-Z]:\//.test(p) || p.startsWith('//')) abs = p;
  else if (p.startsWith('/')) abs = baseDir.slice(0, 2) + p;
  else abs = baseDir + p;
  return normalizePath(abs).replace(/\//g, '\\');
}
function assetUrl(baseDir, url) {
  if (!url || /^(https?:|data:image\/|blob:|#|\/@fs\/)/i.test(url)) return url;
  return host.fileUrl(resolvePath(baseDir, url.replace(/[?#].*$/, '')));
}

// ───────────────────────── 文本解码 ─────────────────────────
// 依次识别 BOM、严格 UTF-8、GB18030，保证中文旧文件也能正确显示
export function decodeText(buf) {
  const u8 = new Uint8Array(buf);
  if (u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) {
    return { text: new TextDecoder('utf-8').decode(u8.subarray(3)), encoding: 'UTF-8 (带 BOM)' };
  }
  if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(u8.subarray(2)), encoding: 'UTF-16 LE' };
  if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(u8.subarray(2)), encoding: 'UTF-16 BE' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(u8), encoding: 'UTF-8' };
  } catch (_) { /* 不是合法 UTF-8 */ }
  try {
    return { text: new TextDecoder('gb18030').decode(u8), encoding: 'GB18030 (GBK)' };
  } catch (_) {
    return { text: new TextDecoder('utf-8').decode(u8), encoding: 'UTF-8 (含无效字节)' };
  }
}

// ───────────────────────── 原始 HTML 净化 ─────────────────────────
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'BASE', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET', 'FORM', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'PORTAL', 'FOREIGNOBJECT', 'TEXTAREA', 'SELECT', 'BUTTON', 'DIALOG']);
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'background', 'srcset', 'data', 'ping']);

function sanitizeInto(container, html, baseDir) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_ELEMENT);
  const drop = [];
  let node;
  while ((node = walker.nextNode())) {
    const tag = node.tagName.toUpperCase();
    if (DROP_TAGS.has(tag)) { drop.push(node); continue; }
    if (tag === 'INPUT' && (node.getAttribute('type') || '').toLowerCase() !== 'checkbox') { drop.push(node); continue; }
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction') { node.removeAttribute(attr.name); continue; }
      if (URL_ATTRS.has(name)) {
        const v = attr.value.replace(/[\s\u0000-\u001f]/g, '');
        if (/^(javascript|vbscript|data:text)/i.test(v)) { node.removeAttribute(attr.name); continue; }
        if (name === 'src' && /^(IMG|SOURCE|VIDEO|AUDIO)$/.test(tag)) node.setAttribute('src', assetUrl(baseDir, attr.value.trim()));
        if (name === 'srcset') node.removeAttribute(attr.name);
      }
    }
    if (node.style && node.style.position) node.style.removeProperty('position');
    if (tag === 'INPUT') node.setAttribute('disabled', '');
    if (tag === 'IMG') node.setAttribute('loading', 'lazy');
  }
  for (const n of drop) n.remove();
  container.append(tpl.content);
}

// ───────────────────────── 渲染调度 ─────────────────────────
class RenderService {
  constructor() {
    this.worker = null;
    this.boot = null;
    this.pending = new Map();
    this.seq = 0;
    this.inlineReady = null;
  }

  // 启动渲染 Worker：拉取脚本文本，拼成一个 Blob 运行，避免 Worker 内再发网络请求
  ensureWorker() {
    if (this.boot) return this.boot;
    this.boot = (async () => {
      if (typeof Worker === 'undefined') throw new Error('当前环境不支持 Worker');
      const texts = await Promise.all([...RENDER_SOURCES, WORKER_BOOT].map(async (src) => {
        const r = await fetch(src, { cache: 'no-cache' });
        if (!r.ok) throw new Error('无法加载 ' + src);
        return r.text();
      }));
      const url = URL.createObjectURL(new Blob([texts.join('\n;\n')], { type: 'text/javascript' }));
      const w = new Worker(url, { name: 'md-render' });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('渲染线程启动超时')), 10000);
        w.onmessage = (e) => { if (e.data && e.data.type === 'boot') { clearTimeout(timer); resolve(); } };
        w.onerror = (e) => { clearTimeout(timer); reject(new Error(e.message || '渲染线程启动失败')); };
      });
      w.onmessage = (e) => this._onMessage(e.data);
      w.onerror = (e) => {
        console.error('渲染线程异常：', e.message);
        this._failAll(new Error(e.message || '渲染线程异常'));
        this.worker = null;
        this.boot = null;
      };
      this.worker = w;
      return w;
    })().catch((err) => {
      console.warn('渲染线程不可用，改用主线程渲染：', err);
      this.boot = Promise.resolve(null);
      return null;
    });
    return this.boot;
  }

  _onMessage(msg) {
    if (!msg) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === 'result') p.resolve(msg);
    else p.reject(new Error(msg.message || '渲染失败'));
  }

  _failAll(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  async render(text, opts) {
    const w = await this.ensureWorker();
    if (w) {
      try {
        return await new Promise((resolve, reject) => {
          const id = ++this.seq;
          this.pending.set(id, { resolve, reject });
          w.postMessage({ type: 'render', id, text, opts });
        });
      } catch (err) {
        console.warn('Worker 渲染失败，改用主线程：', err);
      }
    }
    await this._loadInline();
    return window.MdRender.render(text, opts);
  }

  // 回退方案：在主线程按顺序加载同一套渲染脚本
  _loadInline() {
    if (window.MdRender) return Promise.resolve();
    if (this.inlineReady) return this.inlineReady;
    this.inlineReady = RENDER_SOURCES.reduce((p, src) => p.then(() => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('无法加载 ' + src));
      document.head.append(s);
    })), Promise.resolve());
    return this.inlineReady;
  }
}

// 渲染彻底失败时的兜底：按原文分段显示纯文本，保证内容总能被阅读
function plainResult(text) {
  const lines = text.split('\n');
  const chunks = [];
  for (let i = 0; i < lines.length; i += 300) {
    const part = lines.slice(i, i + 300);
    const m = { wide: 0, narrow: 0, blocks: 1, h1: 0, h2: 0, h3: 0, h4: 0, dmath: 0, dmathRows: 0, imath: 0, codes: 1, codeLines: part.length, trows: 0, imgs: 0, hrs: 0, htmlLines: 0, quotes: 0, items: 0, tables: 0, rows: [], cellWide: 0, cellNarrow: 0 };
    chunks.push({ html: `<pre class="plain-text" data-line="${i}" style="white-space:pre-wrap">${escapeHtml(part.join('\n'))}</pre>`, line0: i, line1: Math.min(lines.length, i + 300), m, weight: 0, hasHtml: false, heads: [] });
  }
  return { chunks, headings: [], stats: { wide: text.length, narrow: 0, formulas: 0, displayFormulas: 0, tables: 0, images: 0, codes: 0, headings: 0 }, title: '', timing: {} };
}

// ───────────────────────── 高度估算 ─────────────────────────
// 估算系数（以真实排版数据拟合得到，单位见各项注释）
const EST = {
  text: 0.99,        // 每行正文 × 行高
  blockLine: 0.36,   // 每个段落末行平均占用 × 行高
  blockGap: 0.74,    // 每个段落的段间距 × 段距
  h1: 6.5, h2: 5.6, h3: 3.88, h4: 3.11,   // 标题（含上下间距）× 字号，按样式规则直接算出
  mathRow: 2.17,     // 独立公式每行 × 字号 × 公式缩放
  math: 2.09,        // 每个独立公式的额外间距 × 字号
  tableLine: 1.27,   // 表格每行文字 × 表格字号
  tableRow: 1.47,    // 表格每行内边距 × 表格字号
  table: 4.6,        // 每个表格外边距 × 字号
  item: 0.43,        // 每个列表项额外间距 × 字号
  quote: 2.85,       // 每个引用块额外间距 × 字号
};
const WARMUP_ALL_LIMIT = 400;   // 分块数不超过此值时，空闲时测量全部分块
const WARMUP_NEAR = 60;         // 超大文档只测量当前位置前后各若干分块，避免占用过多内存

// 依据分块中的文字量、标题、公式、表格等估算排版高度，供屏幕外的分块占位使用
function estimateHeight(m, L) {
  const lineH = L.fs * L.lh;
  const perLine = Math.max(8, L.cw / L.fs);
  const tfs = L.fs * 0.9;
  let h = ((m.wide + m.narrow * 0.53) / perLine) * lineH * EST.text;
  h += m.blocks * (EST.blockLine * lineH + EST.blockGap * L.ps);
  h += (m.h1 * EST.h1 + m.h2 * EST.h2 + m.h3 * EST.h3 + m.h4 * EST.h4) * L.fs;
  h += m.dmathRows * L.fs * L.math * EST.mathRow + m.dmath * L.fs * EST.math;
  if (m.rows && m.rows.length) {
    // 表格：每行高度取决于最长单元格折行后的行数
    let lines = 0;
    for (let k = 0; k < m.rows.length; k += 2) {
      const cellChars = Math.max(4, L.cw / m.rows[k] / tfs - 1.9);
      lines += Math.max(1, m.rows[k + 1] / (cellChars * 1.15));
    }
    h += lines * tfs * EST.tableLine + m.trows * (tfs * EST.tableRow + 1) + (m.tables || 0) * (L.fs * EST.table + 2);
  }
  h += m.codeLines * L.fs * 0.84 * 1.6 + m.codes * 70;
  h += m.imgs * 280 + m.hrs * L.fs * 4.6 + m.htmlLines * lineH;
  h += m.quotes * L.fs * EST.quote + m.items * L.fs * EST.item;
  return Math.max(24, Math.round(h));
}

// 行指纹：用于文件被修改后重新找到原来的位置
function fpOf(lines, line) {
  return (lines[line] || '').trim().slice(0, 60);
}
function findFp(lines, fp, near) {
  if (!fp) return -1;
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length < fp.length) continue;
    if (lines[i].trim().slice(0, 60) === fp) {
      const d = Math.abs(i - near);
      if (d < bestDist) { best = i; bestDist = d; }
    }
  }
  return best;
}

// ───────────────────────── 阅读器 ─────────────────────────
export class Reader {
  constructor({ scroller, article, callbacks }) {
    this.scroller = scroller;
    this.article = article;
    this.cb = callbacks || {};
    this.renderer = new RenderService();
    this.doc = null;
    this.chunkEls = [];
    this.headingEls = [];
    this.openSeq = 0;
    this.restoring = 0;
    this.history = [];
    this.future = [];
    this._raf = 0;
    this._lastPct = -1;
    this._lastHeading = -2;
    this._saveTimer = 0;
    this._lastSaveAt = 0;
    this._lastScrollTop = 0;
    this._warmHandle = 0;
    this._warmQueue = [];
    this._articleWidth = 0;
    this._resizeTimer = 0;

    scroller.addEventListener('scroll', () => this._onScroll(), { passive: true });
    this.chunkRO = new ResizeObserver((entries) => this._onChunkResize(entries));
    new ResizeObserver(() => this._onScrollerResize()).observe(scroller);
    article.addEventListener('click', (e) => this._onClick(e));
    document.addEventListener('copy', (e) => this._onCopy(e));

    // 预先启动渲染线程，打开文件时无需等待
    setTimeout(() => this.renderer.ensureWorker(), 0);
  }

  // ───── 打开 / 重新载入 ─────
  async open(path, opts = {}) {
    const seq = ++this.openSeq;
    const isReload = !!(opts.reload && this.doc && this.doc.path === path);
    if (this.doc && !isReload) this.saveProgress();
    const keepAnchor = opts.anchor || (isReload ? this.captureAnchor() : null);
    let loadTimer = 0;
    if (!opts.silent) loadTimer = setTimeout(() => this.cb.onLoading && this.cb.onLoading(true), 120);
    try {
      let buf;
      let mtime = 0;
      if (opts.file) {
        buf = await opts.file.arrayBuffer();
        mtime = opts.file.lastModified || 0;
      } else {
        const res = await fetch(host.fileUrl(path), { cache: 'no-store' });
        if (!res.ok) throw new Error(res.status === 404 ? '找不到这个文件，它可能已被移动、重命名或删除。' : `读取文件失败（错误码 ${res.status}）。`);
        buf = await res.arrayBuffer();
        mtime = Date.parse(res.headers.get('Last-Modified') || '') || 0;
      }
      if (seq !== this.openSeq) return false;
      const { text, encoding } = decodeText(buf);
      const norm = text.replace(/\r\n?/g, '\n');
      const dir = dirOf(path);
      let result;
      let renderError = null;
      try {
        result = await this.renderer.render(norm, { baseDir: dir, breaks: !!store.settings.breaks });
      } catch (err) {
        console.error('渲染失败，改为纯文本显示：', err);
        renderError = err;
        result = plainResult(norm);
      }
      if (seq !== this.openSeq) return false;
      const doc = {
        path, name: baseName(path), dir, text: norm, encoding, size: buf.byteLength, mtime,
        renderError, virtual: !!opts.file,
      };
      await this._mount(doc, result, { anchor: keepAnchor, isReload });
      return true;
    } catch (err) {
      if (seq === this.openSeq) this.cb.onError && this.cb.onError(path, err);
      return false;
    } finally {
      clearTimeout(loadTimer);
      if (seq === this.openSeq) this.cb.onLoading && this.cb.onLoading(false);
    }
  }

  reload(opts = {}) {
    if (!this.doc || this.doc.virtual) return Promise.resolve(false);
    return this.open(this.doc.path, { reload: true, silent: !!opts.silent });
  }

  close() {
    if (this.doc) this.saveProgress();
    this.openSeq++;
    this._cancelWarmup();
    this.chunkRO.disconnect();
    this.doc = null;
    this.chunkEls = [];
    this.headingEls = [];
    this.article.innerHTML = '';
  }

  // ───── 挂载渲染结果 ─────
  async _mount(doc, result, { anchor, isReload }) {
    this._cancelWarmup();
    this.chunkRO.disconnect();

    // 行偏移表：用于按字符计算阅读进度
    const lines = doc.text.split('\n');
    const offs = new Float64Array(lines.length + 1);
    let acc = 0;
    for (let i = 0; i < lines.length; i++) { offs[i] = acc; acc += lines[i].length + 1; }
    offs[lines.length] = acc;
    doc.lines = lines;
    doc.lineOffsets = offs;
    doc.totalChars = Math.max(1, acc);
    doc.chunks = result.chunks;
    doc.headings = result.headings;
    doc.stats = result.stats;
    doc.timing = result.timing;
    doc.title = result.title || doc.name.replace(/\.[^.]+$/, '');

    // 先让阅读区可见（以便测量），再生成分块
    this.cb.onBeforeMount && this.cb.onBeforeMount(doc);
    const L = this._layoutParams();
    let prevHeading = -1;
    let html = '';
    const htmlChunks = [];
    for (let i = 0; i < doc.chunks.length; i++) {
      const c = doc.chunks[i];
      c.c0 = offs[Math.min(c.line0, lines.length)];
      c.c1 = offs[Math.min(Math.max(c.line1, c.line0), lines.length)];
      c.prevHeading = prevHeading;
      if (c.heads.length) prevHeading = c.heads[c.heads.length - 1];
      c.est = estimateHeight(c.m, L);
      c.size = c.est;
      c.measured = false;
      if (c.hasHtml) {
        htmlChunks.push(i);
        html += `<section class="chunk" data-c="${i}" style="contain-intrinsic-size:${c.est}px"></section>`;
      } else {
        html += `<section class="chunk" data-c="${i}" style="contain-intrinsic-size:${c.est}px">${c.html}</section>`;
      }
    }
    this.article.innerHTML = html || '<p class="empty-doc">这是一份空文档。</p>';
    this.chunkEls = html ? Array.from(this.article.children) : [];
    for (const i of htmlChunks) sanitizeInto(this.chunkEls[i], doc.chunks[i].html, doc.dir);
    for (const c of doc.chunks) c.html = null; // 释放字符串内存
    this.headingEls = this._mapHeadings(doc.headings);
    for (const sec of this.chunkEls) this.chunkRO.observe(sec);
    this._articleWidth = this.article.clientWidth;

    this.doc = doc;
    if (!isReload) { this.history = []; this.future = []; }
    this._lastPct = -1;
    this._lastHeading = -2;
    this.cb.onMount && this.cb.onMount(doc, { isReload });

    // 恢复阅读位置
    const entry = store.file(doc.path);
    const target = anchor || (store.settings.restoreProgress && entry && entry.pos) || null;
    if (target) await this.restoreAnchor(target, { fonts: true });
    else this.scroller.scrollTop = 0;
    if (this.doc !== doc) return;

    this._lastScrollTop = this.scroller.scrollTop;
    this._update(true);
    if (!doc.virtual) {
      store.updateFile(doc.path, { title: doc.title, size: doc.size, read: Date.now() });
      store.touchRecent(doc.path);
      this.saveProgress();
    }
    this.cb.onRestored && this.cb.onRestored(doc, { restored: !!target && !isReload, entry });
    this._startWarmup();
  }

  _mapHeadings(headings) {
    const out = new Array(headings.length).fill(null);
    let j = 0;
    for (const el of this.article.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      if (j < headings.length && el.id === headings[j].id) out[j++] = el;
    }
    for (let k = 0; k < headings.length; k++) {
      if (!out[k]) out[k] = this.article.querySelector(`[id="${CSS.escape(headings[k].id)}"]`);
    }
    return out;
  }

  _layoutParams() {
    const s = store.settings;
    const cw = this.article.clientWidth || s.contentWidth;
    return { cw, fs: s.fontSize, lh: s.lineHeight, ps: s.paraSpacing * s.fontSize, math: s.mathScale };
  }

  // ───── 分块定位 ─────
  _chunkAtArticleY(y) {
    const cs = this.chunkEls;
    let lo = 0;
    let hi = cs.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cs[mid].offsetTop <= y) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  _chunkForLine(line) {
    const ch = this.doc.chunks;
    let lo = 0;
    let hi = ch.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ch[mid].line0 <= line) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  _readLineY() {
    return this.scroller.getBoundingClientRect().top + READ_OFFSET;
  }

  // ───── 阅读位置：捕获 ─────
  // 记录基准线所在的最深层块元素（源码行号 + 块内比例 + 文本指纹 + 百分比）
  captureAnchor() {
    if (!this.doc || !this.chunkEls.length) return null;
    const y = this._readLineY();
    const at = this.article.getBoundingClientRect().top;
    const ci = this._chunkAtArticleY(y - at);
    const sec = this.chunkEls[ci];
    let best = null;
    let bestRect = null;
    for (const el of sec.querySelectorAll('[data-line]')) {
      const r = el.getBoundingClientRect();
      if (r.height <= 0) continue;
      if (r.top <= y + 0.5) { best = el; bestRect = r; } else break;
    }
    const pct = +this._computePct().toFixed(5);
    if (!best) {
      const r = sec.getBoundingClientRect();
      const c = this.doc.chunks[ci];
      return { line: c.line0, ratio: +((y - r.top) / Math.max(1, r.height)).toFixed(4), tag: 'SECTION', fp: fpOf(this.doc.lines, c.line0), pct };
    }
    const line = +best.dataset.line;
    return { line, ratio: +((y - bestRect.top) / Math.max(1, bestRect.height)).toFixed(4), tag: best.tagName, fp: fpOf(this.doc.lines, line), pct };
  }

  // ───── 阅读位置：恢复 ─────
  _resolveAnchor(a) {
    if (!a || !this.doc) return null;
    if (a.el) return { el: a.el, ratio: a.ratio || 0 };
    const lines = this.doc.lines;
    let line = Number.isFinite(a.line) ? a.line : -1;
    if (line >= 0 && a.fp && fpOf(lines, line) !== a.fp) line = findFp(lines, a.fp, line);
    if (line >= 0 && line < lines.length) {
      const el = a.tag === 'SECTION' ? this.chunkEls[this._chunkForLine(line)] : this._elementForLine(line, a.tag);
      if (el) return { el, ratio: clamp(+a.ratio || 0, -5, 80) };
    }
    if (Number.isFinite(a.pct)) return { pct: clamp(a.pct, 0, 1) };
    return null;
  }

  _elementForLine(line, tag) {
    const sec = this.chunkEls[this._chunkForLine(line)];
    if (!sec) return null;
    const exact = sec.querySelectorAll(`[data-line="${line}"]`);
    if (exact.length) {
      if (tag) for (const e of exact) if (e.tagName === tag) return e;
      return exact[exact.length - 1];
    }
    let best = null;
    for (const e of sec.querySelectorAll('[data-line]')) {
      if (+e.dataset.line <= line) best = e; else break;
    }
    return best || sec;
  }

  _alignElement(el, ratio) {
    const r = el.getBoundingClientRect();
    const delta = (r.top + ratio * r.height) - this._readLineY();
    if (Math.abs(delta) < 1) return false;
    const before = this.scroller.scrollTop;
    this.scroller.scrollTop = before + delta;
    return Math.abs(this.scroller.scrollTop - before) >= 1;
  }

  _alignPct(p) {
    const s = this.scroller;
    if (p >= 0.9995) { s.scrollTop = s.scrollHeight; return false; }
    if (p <= 0 || !this.chunkEls.length) { s.scrollTop = 0; return false; }
    const target = p * this.doc.totalChars;
    const ch = this.doc.chunks;
    let lo = 0;
    let hi = ch.length - 1;
    let i = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ch[mid].c0 <= target) { i = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const c = ch[i];
    const frac = clamp((target - c.c0) / Math.max(1, c.c1 - c.c0), 0, 1);
    return this._alignElement(this.chunkEls[i], frac);
  }

  // 恢复到某个位置；会在数帧内反复校正，抵消屏幕外分块高度估算误差
  async restoreAnchor(anchor, opts = {}) {
    const target = this._resolveAnchor(anchor);
    if (!target) return false;
    const doc = this.doc;
    this.restoring++;
    try {
      const align = () => (target.el ? this._alignElement(target.el, target.ratio) : this._alignPct(target.pct));
      align();
      for (let i = 0; i < 8; i++) {
        await nextFrame();
        if (this.doc !== doc) return false;
        if (!align() && i >= 1) break;
      }
      if (opts.fonts && document.fonts && document.fonts.status !== 'loaded') {
        await Promise.race([document.fonts.ready, sleep(600)]);
        if (this.doc !== doc) return false;
        align();
        await nextFrame();
        align();
      }
      return true;
    } finally {
      this.restoring--;
      this._lastScrollTop = this.scroller.scrollTop;
    }
  }

  // ───── 跳转（带返回历史） ─────
  _pushHistory() {
    const a = this.captureAnchor();
    if (!a) return;
    const last = this.history[this.history.length - 1];
    if (last && last.line === a.line && Math.abs(last.ratio - a.ratio) < 0.05) return;
    this.history.push(a);
    if (this.history.length > 60) this.history.shift();
    this.future = [];
  }

  back() {
    const a = this.history.pop();
    if (!a) return false;
    const cur = this.captureAnchor();
    if (cur) this.future.push(cur);
    this.restoreAnchor(a).then(() => this._afterJump());
    return true;
  }

  forward() {
    const a = this.future.pop();
    if (!a) return false;
    const cur = this.captureAnchor();
    if (cur) this.history.push(cur);
    this.restoreAnchor(a).then(() => this._afterJump());
    return true;
  }

  async jumpToElement(el, { flash = false, ratio = 0, history = true } = {}) {
    if (!el || !this.doc) return;
    if (history) this._pushHistory();
    await this.restoreAnchor({ el, ratio });
    if (flash) {
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1500);
    }
    this._afterJump();
  }

  jumpToHeading(i, opts = {}) {
    return this.jumpToElement(this.headingEls[i], opts);
  }

  async jumpToPct(p) {
    if (!this.doc) return;
    this._pushHistory();
    await this.restoreAnchor({ pct: clamp(p, 0, 1) });
    this._afterJump();
  }

  async jumpToAnchor(a) {
    if (!this.doc || !a) return;
    this._pushHistory();
    await this.restoreAnchor(a);
    this._afterJump();
  }

  jumpToId(id) {
    if (!this.doc) return false;
    let el = this.article.querySelector(`[id="${CSS.escape(id)}"]`);
    if (!el) {
      // 兼容直接用标题文字作为锚点的写法
      const slug = String(id).trim().toLowerCase().replace(/\s+/g, '-');
      const idx = this.doc.headings.findIndex((h) => h.id === slug || h.text === id);
      if (idx >= 0) el = this.headingEls[idx];
    }
    if (!el) return false;
    this.jumpToElement(el, { flash: true });
    return true;
  }

  // 相邻章节（按指定级别及以上的标题）
  jumpChapter(dir) {
    if (!this.doc || !this.doc.headings.length) return;
    const hs = this.doc.headings;
    const minLevel = Math.min(...hs.map((h) => h.level));
    const maxLevel = Math.min(minLevel + 1, 6);
    const cur = this._currentHeading();
    if (dir > 0) {
      for (let i = cur + 1; i < hs.length; i++) if (hs[i].level <= maxLevel) return this.jumpToHeading(i);
    } else {
      // 若当前标题离基准线较远，先回到本章开头
      for (let i = cur; i >= 0; i--) {
        if (hs[i].level > maxLevel) continue;
        const el = this.headingEls[i];
        if (i === cur && el && this._readLineY() - el.getBoundingClientRect().top > 80) return this.jumpToHeading(i);
        if (i < cur) return this.jumpToHeading(i);
      }
      this.jumpToPct(0);
    }
  }

  _afterJump() {
    this._lastScrollTop = this.scroller.scrollTop;
    this._update(true);
    this.saveProgress();
    // 超大文档只预热局部：远距离跳转后在新位置附近重新预热
    if (this.doc && this.doc.chunks.length > WARMUP_ALL_LIMIT) this._startWarmup();
  }

  // ───── 滚动处理 ─────
  _onScroll() {
    if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this._update(false); });
    if (!this.restoring && this.doc) this._scheduleSave();
  }

  _update(force) {
    if (!this.doc) return;
    if (!this.chunkEls.length) {
      // 空文档：进度与章节归零
      if (force) {
        this._lastPct = 0;
        this._lastHeading = -1;
        this.cb.onProgress && this.cb.onProgress(0);
        this.cb.onHeading && this.cb.onHeading(-1);
      }
      return;
    }
    const st = this.scroller.scrollTop;
    const dy = st - this._lastScrollTop;
    this._lastScrollTop = st;
    if (!this.restoring && this.cb.onScrollDelta) this.cb.onScrollDelta(dy, st);
    const pct = this._computePct();
    if (force || Math.abs(pct - this._lastPct) > 0.0002) {
      this._lastPct = pct;
      this.cb.onProgress && this.cb.onProgress(pct);
    }
    const hi = this._currentHeading();
    if (force || hi !== this._lastHeading) {
      this._lastHeading = hi;
      this.cb.onHeading && this.cb.onHeading(hi);
    }
  }

  _computePct() {
    const s = this.scroller;
    const max = s.scrollHeight - s.clientHeight;
    if (max <= 2 || s.scrollTop >= max - 2) return 1;
    const y = this._readLineY() - this.article.getBoundingClientRect().top;
    const ci = this._chunkAtArticleY(y);
    const sec = this.chunkEls[ci];
    const c = this.doc.chunks[ci];
    const frac = clamp((y - sec.offsetTop) / Math.max(1, sec.offsetHeight), 0, 1);
    return clamp((c.c0 + frac * (c.c1 - c.c0)) / this.doc.totalChars, 0, 1);
  }

  get progress() { return this._lastPct < 0 ? 0 : this._lastPct; }
  get currentHeading() { return this._lastHeading; }

  // 当前章节：标题进入阅读区上方约五分之一时即视为开始阅读该章节
  _currentHeading() {
    if (!this.doc || !this.chunkEls.length) return -1;
    const y = this._readLineY() + Math.min(160, this.scroller.clientHeight * 0.2);
    const ci = this._chunkAtArticleY(y - this.article.getBoundingClientRect().top);
    const c = this.doc.chunks[ci];
    let cur = c.prevHeading;
    for (const hi of c.heads) {
      const el = this.headingEls[hi];
      if (el && el.getBoundingClientRect().top <= y) cur = hi; else break;
    }
    return cur;
  }

  // ───── 进度保存 ─────
  _scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveProgress(), SAVE_DELAY);
    if (Date.now() - this._lastSaveAt > SAVE_MAX_INTERVAL) this.saveProgress();
  }

  // 记录当前阅读位置并立即写盘
  saveProgress(write = true) {
    clearTimeout(this._saveTimer);
    if (!this.doc || this.doc.virtual || this.restoring) return null;
    const a = this.captureAnchor();
    if (!a) return null;
    this._lastSaveAt = Date.now();
    const hi = this._currentHeading();
    const h = hi >= 0 ? this.doc.headings[hi] : null;
    store.updateFile(this.doc.path, { pos: a, pct: a.pct, chapter: h ? h.text : '', title: this.doc.title, read: Date.now(), size: this.doc.size });
    if (write) store.save(true);
    return a;
  }

  // ───── 分块尺寸：测量与预热 ─────
  _setChunkSize(i, h) {
    const c = this.doc.chunks[i];
    c.measured = true;
    if (Math.abs(c.size - h) < 0.5) return;
    c.size = h;
    this.chunkEls[i].style.containIntrinsicSize = h + 'px';
  }

  _onChunkResize(entries) {
    if (!this.doc) return;
    for (const e of entries) {
      const i = +e.target.dataset.c;
      const c = this.doc.chunks[i];
      if (!c) continue;
      const h = e.borderBoxSize && e.borderBoxSize[0] ? e.borderBoxSize[0].blockSize : e.target.offsetHeight;
      // 屏幕外分块的尺寸恒等于占位值，只有真实排版才会与之不同
      if (Math.abs(h - c.size) >= 0.5) this._setChunkSize(i, h);
    }
  }

  _measureChunk(i) {
    const c = this.doc.chunks[i];
    if (!c || c.measured) return;
    const sec = this.chunkEls[i];
    sec.style.contentVisibility = 'visible';
    const h = sec.getBoundingClientRect().height;
    sec.style.contentVisibility = '';
    this._setChunkSize(i, h);
  }

  // 空闲时由近及远逐个测量屏幕外分块的真实高度，让滚动条与跳转越来越精确
  _startWarmup() {
    this._cancelWarmup();
    if (!this.doc) return;
    const n = this.doc.chunks.length;
    const start = this._chunkAtArticleY(this._readLineY() - this.article.getBoundingClientRect().top);
    const reach = n <= WARMUP_ALL_LIMIT ? n : WARMUP_NEAR;
    const q = [];
    for (let d = 0; d < reach; d++) {
      if (start + d < n) q.push(start + d);
      if (d && start - d >= 0) q.push(start - d);
    }
    this._warmQueue = q;
    const ric = window.requestIdleCallback
      ? (fn) => window.requestIdleCallback(fn, { timeout: 1200 })
      : (fn) => setTimeout(() => fn({ timeRemaining: () => 6, didTimeout: false }), 40);
    const step = (deadline) => {
      this._warmHandle = 0;
      if (!this.doc || this.restoring) {
        if (this.doc) this._warmHandle = ric(step);
        return;
      }
      do {
        const i = this._warmQueue.shift();
        if (i !== undefined) this._measureChunk(i);
      } while (this._warmQueue.length && deadline.timeRemaining() > 4);
      if (this._warmQueue.length) this._warmHandle = ric(step);
      else this.cb.onWarmupDone && this.cb.onWarmupDone();
    };
    this._warmHandle = ric(step);
  }

  _cancelWarmup() {
    if (this._warmHandle) {
      if (window.cancelIdleCallback) window.cancelIdleCallback(this._warmHandle);
      clearTimeout(this._warmHandle);
    }
    this._warmHandle = 0;
    this._warmQueue = [];
  }

  // 排版参数改变（字号、宽度等）：保持当前阅读位置，重新估算并测量
  relayout(applyFn) {
    if (!this.doc) { if (applyFn) applyFn(); return Promise.resolve(); }
    const a = this.restoring ? null : this.captureAnchor();
    if (applyFn) applyFn();
    this._cancelWarmup();
    const L = this._layoutParams();
    this._articleWidth = this.article.clientWidth;
    for (let i = 0; i < this.doc.chunks.length; i++) {
      const c = this.doc.chunks[i];
      c.est = estimateHeight(c.m, L);
      c.size = c.est;
      c.measured = false;
      this.chunkEls[i].style.containIntrinsicSize = c.est + 'px';
    }
    const p = a ? this.restoreAnchor(a) : Promise.resolve();
    return p.then(() => { this._update(true); this._startWarmup(); });
  }

  _onScrollerResize() {
    if (!this.doc) return;
    clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => {
      if (this.doc && this.article.clientWidth !== this._articleWidth) this.relayout();
      else this._update(true);
    }, 180);
  }

  // ───── 点击：链接、代码复制、图片 ─────
  _onClick(e) {
    const copyBtn = e.target.closest('.code-copy');
    if (copyBtn) {
      const code = copyBtn.closest('.code-block')?.querySelector('pre code');
      if (code) this.cb.onCopyCode && this.cb.onCopyCode(code.textContent, copyBtn);
      return;
    }
    const a = e.target.closest('a');
    if (!a) {
      const img = e.target.closest('img');
      if (img && this.cb.onImage) this.cb.onImage(img);
      return;
    }
    e.preventDefault();
    const href = (a.getAttribute('href') || '').trim();
    if (!href) return;
    if (href.startsWith('#')) {
      let id = href.slice(1);
      try { id = decodeURIComponent(id); } catch (_) { /* 保持原样 */ }
      if (!this.jumpToId(id)) this.cb.onNotice && this.cb.onNotice('文档中没有找到这个锚点');
      return;
    }
    if (/^(https?:|mailto:)/i.test(href)) { host.openExternal(href); return; }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[a-zA-Z]:[\\/]/.test(href) && !/^file:/i.test(href)) return;
    if (!this.doc || this.doc.virtual) return;
    const hashIdx = href.indexOf('#');
    const pathPart = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
    const hash = hashIdx >= 0 ? href.slice(hashIdx + 1) : '';
    const abs = resolvePath(this.doc.dir, pathPart.replace(/\?.*$/, ''));
    if (MD_EXT.test(abs)) this.cb.onOpenLink && this.cb.onOpenLink(abs, hash);
    else host.reveal(abs);
  }

  // ───── 复制：公式以源码形式进入剪贴板 ─────
  _onCopy(e) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!this.article.contains(range.commonAncestorContainer)) return;
    const frag = range.cloneContents();
    if (!frag.querySelector('[data-tex]')) return;
    frag.querySelectorAll('.katex-display[data-tex]').forEach((el) => el.replaceWith('$$' + el.dataset.tex + '$$'));
    frag.querySelectorAll('[data-tex]').forEach((el) => el.replaceWith('$' + el.dataset.tex + '$'));
    frag.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,blockquote,tr,pre,.math-block,div').forEach((el) => el.append('\n'));
    frag.querySelectorAll('td,th').forEach((el) => el.append('\t'));
    const text = frag.textContent.replace(/\n{3,}/g, '\n\n').trim();
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
  }

  // 获取指定元素对应的公式源码（右键菜单用）
  texAt(target) {
    const el = target && target.closest && target.closest('[data-tex]');
    return el ? el.dataset.tex : null;
  }
}
