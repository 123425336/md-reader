// 墨阅 · 状态存储：设置、自定义主题、每个文件的阅读进度与书签、最近文件
import * as host from './host.js';

// 默认设置
export const DEFAULT_SETTINGS = {
  theme: 'claude-light',     // 当前主题（不跟随系统时使用）
  followSystem: false,       // 跟随系统浅色/深色
  lightTheme: 'claude-light',
  darkTheme: 'claude-dark',
  font: 'serif',             // 正文字体：serif 宋体 | sans 黑体 | kai 楷体 | custom 自选
  customFont: '',
  fontSize: 17,
  lineHeight: 1.85,
  contentWidth: 760,
  paraSpacing: 0.9,
  indent: false,             // 段首缩进两字
  justify: true,             // 两端对齐
  autospace: true,           // 中西文之间自动留白
  mathScale: 1.1,            // 公式相对字号
  sidebar: true,
  sidebarWidth: 288,
  tocDepth: 0,               // 目录默认展开到第几级（0 为自动：标题很多时只展开当前章节）
  autoHideTopbar: true,      // 向下阅读时自动隐藏顶栏
  showProgress: true,        // 顶部阅读进度线
  autoReload: true,          // 文件被修改后自动重新载入
  reopenLast: true,          // 启动时打开上次阅读的文件
  restoreProgress: true,     // 打开文件时恢复阅读位置
  breaks: false,             // 单个换行视为换行
  customCss: '',
};

const MAX_FILES = 500;   // 阅读记录上限，超出后淘汰最久未读的
const MAX_RECENT = 40;   // 最近文件列表上限

// 文件记录的键：统一分隔符并忽略大小写（Windows 路径不区分大小写）
export function keyOf(path) {
  return String(path || '').replace(/\//g, '\\').toLowerCase();
}

class Store {
  constructor() {
    this.data = this._empty();
    this.listeners = new Set();
    this._timer = 0;
    this._dirty = false;
  }

  _empty() {
    return { v: 1, settings: { ...DEFAULT_SETTINGS }, customThemes: [], files: {}, recent: [], last: '' };
  }

  // 载入宿主保存的状态；主文件损坏时使用备份
  load(json, backup) {
    let parsed = null;
    for (const src of [json, backup]) {
      if (!src) continue;
      try {
        const p = JSON.parse(src);
        if (p && typeof p === 'object') { parsed = p; break; }
      } catch (_) { /* 尝试下一个来源 */ }
    }
    const d = this._empty();
    if (parsed) {
      if (parsed.settings && typeof parsed.settings === 'object') Object.assign(d.settings, parsed.settings);
      if (Array.isArray(parsed.customThemes)) d.customThemes = parsed.customThemes.filter((t) => t && t.id && t.colors);
      if (parsed.files && typeof parsed.files === 'object') d.files = parsed.files;
      if (Array.isArray(parsed.recent)) d.recent = parsed.recent.filter((k) => typeof k === 'string' && d.files[k]);
      if (typeof parsed.last === 'string') d.last = parsed.last;
    }
    // 设置项类型校验，异常值回退为默认
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      if (typeof d.settings[k] !== typeof v) d.settings[k] = v;
    }
    this.data = d;
    return !!parsed;
  }

  get settings() { return this.data.settings; }

  set(key, value) {
    if (this.data.settings[key] === value) return;
    this.data.settings[key] = value;
    this._emit(key, value);
    this.save();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(key, value) {
    for (const fn of this.listeners) {
      try { fn(key, value); } catch (err) { console.error(err); }
    }
  }

  serialize() { return JSON.stringify(this.data); }

  // 保存：默认合并 400ms 内的多次修改；immediate 为真时立即写盘
  save(immediate = false) {
    this._dirty = true;
    clearTimeout(this._timer);
    if (immediate) this._write();
    else this._timer = setTimeout(() => this._write(), 400);
  }

  _write() {
    clearTimeout(this._timer);
    if (!this._dirty) return;
    this._dirty = false;
    try { host.saveState(this.serialize()); } catch (err) { console.error('保存状态失败：', err); }
  }

  // 供宿主在关闭窗口时调用：返回最新状态，由宿主同步写盘
  flush() {
    clearTimeout(this._timer);
    this._dirty = false;
    return this.serialize();
  }

  // ───── 文件记录 ─────
  file(path) { return this.data.files[keyOf(path)] || null; }

  updateFile(path, patch) {
    const k = keyOf(path);
    let f = this.data.files[k];
    if (!f) f = this.data.files[k] = { path, created: Date.now() };
    Object.assign(f, patch);
    f.path = path;
    return f;
  }

  touchRecent(path) {
    const k = keyOf(path);
    this.data.recent = [k, ...this.data.recent.filter((x) => x !== k)].slice(0, MAX_RECENT);
    this.data.last = k;
    this._prune();
  }

  removeRecent(path) {
    const k = keyOf(path);
    this.data.recent = this.data.recent.filter((x) => x !== k);
    if (this.data.last === k) this.data.last = '';
    this.save();
  }

  clearRecent() {
    this.data.recent = [];
    this.data.last = '';
    this.save();
  }

  recentFiles() {
    return this.data.recent.map((k) => this.data.files[k]).filter(Boolean);
  }

  lastFile() {
    const f = this.data.files[this.data.last];
    return f ? f.path : '';
  }

  clearAllProgress() {
    this.data.files = {};
    this.data.recent = [];
    this.data.last = '';
    this.save(true);
  }

  _prune() {
    const keys = Object.keys(this.data.files);
    if (keys.length <= MAX_FILES) return;
    const keep = new Set(this.data.recent);
    keys.sort((a, b) => (this.data.files[a].read || this.data.files[a].created || 0) - (this.data.files[b].read || this.data.files[b].created || 0));
    for (const k of keys) {
      if (Object.keys(this.data.files).length <= MAX_FILES) break;
      if (!keep.has(k)) delete this.data.files[k];
    }
  }
}

export const store = new Store();
