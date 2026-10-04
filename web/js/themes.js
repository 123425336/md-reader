// 墨阅 · 主题与排版
import { store } from './store.js';

// 可编辑的主题颜色项：[键, 名称, CSS 变量]
export const COLOR_KEYS = [
  ['bg', '页面背景', '--bg'],
  ['bgSide', '侧栏背景', '--bg-side'],
  ['surface', '浮层与卡片', '--surface'],
  ['surface2', '次级表面', '--surface-2'],
  ['border', '分隔线', '--border'],
  ['text', '正文文字', '--text'],
  ['text2', '次要文字', '--text-2'],
  ['text3', '辅助文字', '--text-3'],
  ['heading', '标题文字', '--heading'],
  ['accent', '强调色', '--accent'],
  ['accentFg', '强调色上的文字', '--accent-fg'],
  ['link', '链接', '--link'],
  ['codeBg', '代码背景', '--code-bg'],
  ['codeText', '行内代码文字', '--code-text'],
  ['quoteBar', '引用竖线', '--quote-bar'],
];

// 内置主题
export const BUILTIN_THEMES = [
  {
    id: 'claude-light', name: '陶土', dark: false,
    colors: { bg: '#FAF9F5', bgSide: '#F3F1EA', surface: '#FFFFFF', surface2: '#F0EEE6', border: '#E5E1D5', text: '#2B2923', text2: '#6C695F', text3: '#9A968A', heading: '#191814', accent: '#C96442', accentFg: '#FFFFFF', link: '#A94F2E', codeBg: '#F0EEE6', codeText: '#B0462A', quoteBar: '#D9D4C6' },
  },
  {
    id: 'claude-dark', name: '夜墨', dark: true,
    colors: { bg: '#262624', bgSide: '#1F1E1D', surface: '#30302E', surface2: '#2C2B28', border: '#3B3A36', text: '#E3DFD3', text2: '#A6A296', text3: '#7D796F', heading: '#F4F1E8', accent: '#D97757', accentFg: '#FFFFFF', link: '#E3967A', codeBg: '#1E1D1B', codeText: '#F0A383', quoteBar: '#4A4843' },
  },
  {
    id: 'paper', name: '宣纸', dark: false,
    colors: { bg: '#F4ECDA', bgSide: '#ECE2CB', surface: '#FBF6EA', surface2: '#EADFC7', border: '#DDD0B3', text: '#3A2F22', text2: '#76664F', text3: '#9C8C73', heading: '#2B2116', accent: '#A65A2E', accentFg: '#FFFFFF', link: '#94502A', codeBg: '#EADFC7', codeText: '#8A3E1C', quoteBar: '#CDBC98' },
  },
  {
    id: 'celadon', name: '青瓷', dark: false,
    colors: { bg: '#EAF0E6', bgSide: '#E0E8DA', surface: '#F5F8F2', surface2: '#DCE5D5', border: '#C8D5C0', text: '#24312A', text2: '#5B6C5F', text3: '#86968A', heading: '#17231C', accent: '#3E7C59', accentFg: '#FFFFFF', link: '#2E6A48', codeBg: '#DCE5D5', codeText: '#2E6A48', quoteBar: '#B4C6AB' },
  },
  {
    id: 'mist', name: '雾蓝', dark: false,
    colors: { bg: '#F6F8FB', bgSide: '#EDF1F6', surface: '#FFFFFF', surface2: '#E9EEF5', border: '#D8DFE9', text: '#1F2733', text2: '#5B6677', text3: '#8B95A4', heading: '#111926', accent: '#3A6BD1', accentFg: '#FFFFFF', link: '#2D5DBE', codeBg: '#EAEFF6', codeText: '#B03F6A', quoteBar: '#C7D2E1' },
  },
  {
    id: 'deep-sea', name: '深海', dark: true,
    colors: { bg: '#1A1F27', bgSide: '#151A21', surface: '#232A35', surface2: '#1F252F', border: '#2E3644', text: '#D3DAE4', text2: '#95A0B0', text3: '#6C7686', heading: '#EEF2F8', accent: '#6E9BEF', accentFg: '#0E1520', link: '#8AB0F3', codeBg: '#151A21', codeText: '#F0A8C4', quoteBar: '#3A4352' },
  },
  {
    id: 'ink', name: '玄夜', dark: true,
    colors: { bg: '#0D0D0C', bgSide: '#131312', surface: '#1B1B19', surface2: '#161615', border: '#2A2926', text: '#D6D3C9', text2: '#99958A', text3: '#6E6A61', heading: '#EEEBE2', accent: '#D97757', accentFg: '#FFFFFF', link: '#E39A7B', codeBg: '#171716', codeText: '#EC9F7D', quoteBar: '#36352F' },
  },
];

export function allThemes() {
  return [...BUILTIN_THEMES, ...store.data.customThemes];
}

export function findTheme(id) {
  return allThemes().find((t) => t.id === id) || null;
}

// 当前应使用的主题（考虑“跟随系统”）
const mql = window.matchMedia('(prefers-color-scheme: dark)');
export function activeThemeId() {
  const s = store.settings;
  if (s.followSystem) return mql.matches ? s.darkTheme : s.lightTheme;
  return s.theme;
}
export function onSystemSchemeChange(fn) {
  mql.addEventListener('change', fn);
}

// 应用主题颜色到页面
export function applyTheme(theme) {
  const t = theme || BUILTIN_THEMES[0];
  const root = document.documentElement;
  const base = t.dark ? BUILTIN_THEMES[1] : BUILTIN_THEMES[0];
  for (const [key, , cssVar] of COLOR_KEYS) {
    root.style.setProperty(cssVar, (t.colors && t.colors[key]) || base.colors[key]);
  }
  root.dataset.dark = t.dark ? '1' : '0';
  root.dataset.theme = t.id;
  if (t.dark) {
    root.style.setProperty('--selection', 'color-mix(in srgb, var(--accent) 36%, transparent)');
    root.style.setProperty('--mark-bg', 'rgba(236, 180, 70, .34)');
    root.style.setProperty('--mark-current', '#E8A040');
  } else {
    root.style.setProperty('--selection', 'color-mix(in srgb, var(--accent) 24%, transparent)');
    root.style.setProperty('--mark-bg', 'rgba(240, 186, 70, .42)');
    root.style.setProperty('--mark-current', '#F0A040');
  }
  return t;
}

// ───────────────────────── 字体 ─────────────────────────
export const FONT_STACKS = {
  serif: {
    name: '宋体',
    body: '"Noto Serif SC", "Source Han Serif SC", "Source Han Serif CN", "思源宋体", "Songti SC", "STZhongsong", "华文中宋", Georgia, "SimSun", serif',
    cjk: '"Noto Serif SC", "Source Han Serif SC", "Source Han Serif CN", "思源宋体", "Songti SC", "STZhongsong", "SimSun", serif',
  },
  sans: {
    name: '黑体',
    body: '"Segoe UI Variable Text", "Segoe UI", "Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif',
    cjk: '"Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif',
  },
  kai: {
    name: '楷体',
    body: 'Georgia, "LXGW WenKai", "霞鹜文楷", "KaiTi", "STKaiti", "楷体", serif',
    cjk: '"LXGW WenKai", "霞鹜文楷", "KaiTi", "STKaiti", "楷体", serif',
  },
};

function cleanFontName(name) {
  return String(name || '').replace(/["';{}<>\\]/g, '').trim().slice(0, 80);
}

export function fontStacks(s) {
  if (s.font === 'custom') {
    const f = cleanFontName(s.customFont);
    if (f) return { body: `"${f}", ${FONT_STACKS.serif.body}`, cjk: `"${f}", ${FONT_STACKS.serif.cjk}` };
    return FONT_STACKS.serif;
  }
  return FONT_STACKS[s.font] || FONT_STACKS.serif;
}

// 应用排版参数
export function applyTypography(s = store.settings) {
  const st = document.documentElement.style;
  const stacks = fontStacks(s);
  st.setProperty('--font-body', stacks.body);
  st.setProperty('--font-cjk', stacks.cjk);
  st.setProperty('--fs', s.fontSize + 'px');
  st.setProperty('--lh', String(s.lineHeight));
  st.setProperty('--content-w', s.contentWidth + 'px');
  st.setProperty('--ps', s.paraSpacing + 'em');
  st.setProperty('--indent', s.indent ? '2em' : '0em');
  st.setProperty('--align', s.justify ? 'justify' : 'start');
  st.setProperty('--autospace', s.autospace ? 'normal' : 'no-autospace');
  st.setProperty('--math-scale', s.mathScale + 'em');
  st.setProperty('--sidebar-w', s.sidebarWidth + 'px');
}

// 用户自定义样式
let customStyleEl = null;
export function applyCustomCss(css) {
  if (!customStyleEl) {
    customStyleEl = document.createElement('style');
    customStyleEl.id = 'user-css';
    document.head.append(customStyleEl);
  }
  customStyleEl.textContent = css || '';
}

// 生成新的自定义主题 id
export function newThemeId() {
  return 'custom-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 校验并规整导入的主题对象
export function normalizeTheme(obj) {
  if (!obj || typeof obj !== 'object' || !obj.colors || typeof obj.colors !== 'object') return null;
  const base = obj.dark ? BUILTIN_THEMES[1] : BUILTIN_THEMES[0];
  const colors = {};
  for (const [key] of COLOR_KEYS) {
    const v = obj.colors[key];
    colors[key] = typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim().toUpperCase() : base.colors[key];
  }
  return { id: newThemeId(), name: String(obj.name || '导入的主题').slice(0, 24), dark: !!obj.dark, colors };
}
