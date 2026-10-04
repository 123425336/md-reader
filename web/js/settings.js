// 墨阅 · 设置：快速外观面板、设置抽屉、自定义主题编辑器
import { store } from './store.js';
import { allThemes, findTheme, BUILTIN_THEMES, COLOR_KEYS, applyTheme, newThemeId, normalizeTheme, activeThemeId } from './themes.js';
import { h, icon, popover, closePopover, confirmDialog, toast, debounce } from './ui.js';
import * as host from './host.js';

const FONT_OPTIONS = [['serif', '宋体'], ['sans', '黑体'], ['kai', '楷体'], ['custom', '自选']];

// 数值设置的范围
const RANGES = {
  fontSize: { min: 13, max: 28, step: 1, fmt: (v) => v + ' px' },
  lineHeight: { min: 1.3, max: 2.6, step: 0.05, fmt: (v) => v.toFixed(2) },
  contentWidth: { min: 480, max: 1400, step: 20, fmt: (v) => v + ' px' },
  paraSpacing: { min: 0, max: 2.4, step: 0.1, fmt: (v) => v.toFixed(1) + ' 字' },
  mathScale: { min: 0.9, max: 1.5, step: 0.05, fmt: (v) => Math.round(v * 100) + '%' },
};

function roundTo(v, step) {
  const d = String(step).includes('.') ? String(step).split('.')[1].length : 0;
  return +(Math.round(v / step) * step).toFixed(d);
}

export function stepSetting(key, dir) {
  const r = RANGES[key];
  const v = roundTo(Math.min(r.max, Math.max(r.min, store.settings[key] + dir * r.step)), r.step);
  store.set(key, v);
  return v;
}

function seg(options, value, onPick) {
  const box = h('div', { class: 'seg' });
  for (const [v, label] of options) {
    const b = h('button', { type: 'button', class: v === value ? 'on' : '' }, label);
    b.addEventListener('click', () => {
      box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      onPick(v);
    });
    box.append(b);
  }
  return box;
}

function switchEl(checked, onChange) {
  const input = h('input', { type: 'checkbox' });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('span', { class: 'switch' }, input, h('i'));
}

function setRangeFill(input) {
  const p = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--p', p + '%');
}

export class Settings {
  constructor(hooks) {
    this.hooks = hooks; // { previewTheme(theme), restoreTheme(), showShortcuts(), clearProgress(), showAbout() }
    this.fonts = [];
    this.drawer = null;
    this.veil = null;
    this.body = null;
    this.fontList = h('datalist', { id: 'font-list' });
    document.body.append(this.fontList);
  }

  setFonts(list) {
    this.fonts = list || [];
    this.fontList.innerHTML = '';
    for (const f of this.fonts) this.fontList.append(h('option', { value: f }));
  }

  // ───────────── 快速外观面板 ─────────────
  openQuick(anchor) {
    const s = store.settings;
    const box = h('div', { class: 'quick' });
    const row = (label, el, extra) => h('div', { class: 'quick-row' }, h('div', { class: 'quick-label' }, h('span', null, label), extra || null), el);

    const sw = h('div', { class: 'swatches' });
    const curId = activeThemeId();
    for (const t of allThemes()) {
      const b = h('button', {
        type: 'button',
        class: 'swatch' + (t.id === curId ? ' on' : ''),
        title: t.name,
        style: { background: t.colors.bg, color: t.colors.text },
      }, '文');
      b.style.setProperty('box-shadow', t.id === curId ? '' : `inset 0 -5px 0 -2px ${t.colors.accent}`);
      b.addEventListener('click', () => {
        this.selectTheme(t.id);
        sw.querySelectorAll('.swatch').forEach((x) => {
          x.classList.toggle('on', x === b);
        });
      });
      sw.append(b);
    }
    box.append(row('主题', sw));

    box.append(row('字体', seg(FONT_OPTIONS.slice(0, 3), s.font, (v) => store.set('font', v))));

    const stepper = (key) => {
      const val = h('span', { class: 'val' }, RANGES[key].fmt(store.settings[key]));
      const dec = h('button', { type: 'button', class: 'btn sm', title: '减小' }, '−');
      const inc = h('button', { type: 'button', class: 'btn sm', title: '增大' }, '+');
      dec.addEventListener('click', () => { val.textContent = RANGES[key].fmt(stepSetting(key, -1)); });
      inc.addEventListener('click', () => { val.textContent = RANGES[key].fmt(stepSetting(key, 1)); });
      return h('div', { class: 'stepper' }, dec, val, inc);
    };
    box.append(row('字号', stepper('fontSize')));
    box.append(row('行距', stepper('lineHeight')));
    box.append(row('版心宽度', stepper('contentWidth')));

    const more = h('button', { type: 'button', class: 'btn ghost sm', style: { width: '100%' } }, '更多设置…');
    more.addEventListener('click', () => { closePopover(); this.openDrawer(); });
    box.append(h('div', { class: 'quick-row' }, more));
    popover(anchor, box);
  }

  selectTheme(id) {
    store.set('followSystem', false);
    store.set('theme', id);
  }

  // ───────────── 设置抽屉 ─────────────
  openDrawer() {
    if (this.drawer) return;
    this.veil = h('div', { class: 'drawer-veil' });
    this.veil.addEventListener('pointerdown', () => this.closeDrawer());
    const closeBtn = h('button', { class: 'icon-btn', type: 'button', title: '关闭 (Esc)', html: icon('close') });
    closeBtn.addEventListener('click', () => this.closeDrawer());
    this.titleEl = h('h2', null, '设置');
    this.backBtn = h('button', { class: 'icon-btn', type: 'button', title: '返回', html: icon('back'), hidden: true });
    this.backBtn.addEventListener('click', () => this._cancelEditor());
    this.body = h('div', { class: 'drawer-body' });
    this.drawer = h('aside', { class: 'drawer', role: 'dialog', 'aria-label': '设置' },
      h('div', { class: 'drawer-head' }, this.backBtn, this.titleEl, closeBtn),
      this.body);
    this._onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (this.editing) this._cancelEditor(); else this.closeDrawer();
      }
    };
    document.addEventListener('keydown', this._onKey, true);
    document.body.append(this.veil, this.drawer);
    this._renderMain();
  }

  closeDrawer() {
    if (!this.drawer) return;
    if (this.editing) this._cancelEditor(true);
    document.removeEventListener('keydown', this._onKey, true);
    this.drawer.remove();
    this.veil.remove();
    this.drawer = null;
    this.veil = null;
  }

  refresh() {
    if (this.drawer && !this.editing) {
      const top = this.body.scrollTop;
      this._renderMain();
      this.body.scrollTop = top;
    }
  }

  _renderMain() {
    this.editing = null;
    this.titleEl.textContent = '设置';
    this.backBtn.hidden = true;
    const s = store.settings;
    const b = this.body;
    b.innerHTML = '';

    const section = (title, ...rows) => h('section', { class: 'set-section' }, h('h3', null, title), ...rows);
    const rowSwitch = (label, key, desc, after) => h('div', { class: 'set-row' },
      h('label', null, label, desc ? h('span', { class: 'set-desc' }, desc) : null),
      switchEl(s[key], (v) => { store.set(key, v); after && after(v); }));
    const rowRange = (label, key) => {
      const r = RANGES[key];
      const val = h('span', { class: 'set-val' }, r.fmt(s[key]));
      const input = h('input', { type: 'range', class: 'range', min: r.min, max: r.max, step: r.step, value: s[key] });
      setRangeFill(input);
      const apply = debounce(() => store.set(key, roundTo(+input.value, r.step)), 60);
      input.addEventListener('input', () => { val.textContent = r.fmt(+input.value); setRangeFill(input); apply(); });
      return h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, label), input, val);
    };

    // —— 主题 ——
    const grid = h('div', { class: 'theme-grid' });
    const cur = activeThemeId();
    for (const t of allThemes()) {
      const isCustom = !BUILTIN_THEMES.some((x) => x.id === t.id);
      const card = h('button', { type: 'button', class: 'theme-card' + (t.id === cur ? ' on' : ''), title: t.name });
      const prev = h('div', { class: 'theme-prev', style: { background: t.colors.bg } },
        h('i', { style: { background: t.colors.heading } }),
        h('i', { style: { background: t.colors.text } }),
        h('i', { style: { background: t.colors.text } }),
        h('b', { style: { background: t.colors.accent } }));
      card.append(prev, h('div', { class: 'theme-name' }, t.name + (t.dark ? ' · 深' : '')));
      const edit = h('span', { class: 'icon-btn sm tc-edit', title: isCustom ? '编辑主题' : '以此为基础新建', html: icon(isCustom ? 'edit' : 'plus') });
      edit.addEventListener('click', (e) => { e.stopPropagation(); this._openEditor(t, isCustom); });
      card.append(edit);
      card.addEventListener('click', () => { this.selectTheme(t.id); this.refresh(); });
      grid.append(card);
    }
    const add = h('button', { type: 'button', class: 'theme-card theme-add', html: icon('plus') + '<span>新建主题</span>' });
    add.addEventListener('click', () => this._openEditor(findTheme(cur) || BUILTIN_THEMES[0], false));
    grid.append(add);

    const followRows = [];
    if (s.followSystem) {
      const opts = (dark) => allThemes().filter((t) => !!t.dark === dark);
      const sel = (key, dark) => {
        const el = h('select', { class: 'select' });
        for (const t of opts(dark)) el.append(h('option', { value: t.id, selected: t.id === s[key] }, t.name));
        el.addEventListener('change', () => store.set(key, el.value));
        return el;
      };
      followRows.push(h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, '浅色时使用'), sel('lightTheme', false)));
      followRows.push(h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, '深色时使用'), sel('darkTheme', true)));
    }
    b.append(section('主题',
      grid,
      h('div', { style: { height: '10px' } }),
      rowSwitch('跟随系统浅色/深色', 'followSystem', '系统切换明暗时自动换主题', () => this.refresh()),
      ...followRows));

    // —— 排版 ——
    const fontRow = h('div', { class: 'set-row col' },
      h('span', { class: 'set-label' }, '正文字体'),
      seg(FONT_OPTIONS, s.font, (v) => { store.set('font', v); this.refresh(); }));
    const typoRows = [fontRow];
    if (s.font === 'custom') {
      const input = h('input', { class: 'text-input', list: 'font-list', placeholder: '输入或选择已安装的字体', value: s.customFont, style: { flex: '1' } });
      const apply = debounce(() => store.set('customFont', input.value.trim()), 350);
      input.addEventListener('input', apply);
      typoRows.push(h('div', { class: 'set-row' }, input));
      if (!this.fonts.length) host.listFonts();
    }
    typoRows.push(
      rowRange('字号', 'fontSize'),
      rowRange('行距', 'lineHeight'),
      rowRange('版心宽度', 'contentWidth'),
      rowRange('段落间距', 'paraSpacing'),
      rowRange('公式大小', 'mathScale'),
      rowSwitch('两端对齐', 'justify'),
      rowSwitch('段首缩进两字', 'indent'),
      rowSwitch('中西文之间自动留白', 'autospace', '汉字与字母、数字之间加入细小间距'),
    );
    b.append(section('排版', ...typoRows));

    // —— 阅读 ——
    const depthSel = h('select', { class: 'select' });
    for (const [v, label] of [[0, '自动'], [1, '只显示第一级'], [2, '展开到第二级'], [3, '展开到第三级'], [9, '全部展开']]) {
      depthSel.append(h('option', { value: v, selected: s.tocDepth === v }, label));
    }
    depthSel.addEventListener('change', () => store.set('tocDepth', +depthSel.value));
    b.append(section('阅读',
      rowSwitch('启动时打开上次阅读的文件', 'reopenLast'),
      rowSwitch('打开文件时回到上次的位置', 'restoreProgress'),
      rowSwitch('文件被修改后自动重新载入', 'autoReload', '在其他编辑器里保存后，这里会保持位置刷新'),
      rowSwitch('向下阅读时隐藏顶栏', 'autoHideTopbar'),
      rowSwitch('显示顶部阅读进度线', 'showProgress'),
      rowSwitch('单个换行视为换行', 'breaks', '适合每行一句的文稿；更改后重新排版'),
      h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, '目录默认展开'), depthSel)));

    // —— 自定义样式 ——
    const css = h('textarea', { class: 'textarea', spellcheck: 'false', placeholder: '/* 例如：.markdown-body p { letter-spacing: .02em; } */' });
    css.value = s.customCss;
    css.addEventListener('input', debounce(() => store.set('customCss', css.value), 400));
    b.append(section('自定义样式', h('div', { class: 'set-row col' }, css)));

    // —— 数据 ——
    const dataBtns = h('div', { class: 'editor-actions' });
    if (host.isNative) {
      const openDir = h('button', { type: 'button', class: 'btn sm', html: icon('folder') + '打开数据目录' });
      openDir.addEventListener('click', () => host.openDataDir());
      dataBtns.append(openDir);
    }
    const clear = h('button', { type: 'button', class: 'btn sm danger', html: icon('trash') + '清除全部阅读记录' });
    clear.addEventListener('click', async () => {
      if (await confirmDialog('清除阅读记录', '所有文件的阅读进度、书签和最近列表都会被删除，设置与主题保留。确定继续吗？', '清除', true)) {
        this.hooks.clearProgress && this.hooks.clearProgress();
      }
    });
    dataBtns.append(clear);
    const keys = h('button', { type: 'button', class: 'btn sm', html: icon('keyboard') + '快捷键' });
    keys.addEventListener('click', () => this.hooks.showShortcuts && this.hooks.showShortcuts());
    const about = h('button', { type: 'button', class: 'btn sm', html: icon('info') + '关于' });
    about.addEventListener('click', () => this.hooks.showAbout && this.hooks.showAbout());
    dataBtns.append(keys, about);
    b.append(section('数据与帮助', dataBtns));
  }

  // ───────────── 主题编辑器 ─────────────
  _openEditor(baseTheme, isCustom) {
    const draft = {
      id: isCustom ? baseTheme.id : newThemeId(),
      name: isCustom ? baseTheme.name : `${baseTheme.name} · 自定义`,
      dark: !!baseTheme.dark,
      colors: { ...baseTheme.colors },
    };
    this.editing = { draft, isCustom };
    this.titleEl.textContent = isCustom ? '编辑主题' : '新建主题';
    this.backBtn.hidden = false;
    const b = this.body;
    b.innerHTML = '';
    const preview = () => this.hooks.previewTheme && this.hooks.previewTheme(draft);
    preview();

    const name = h('input', { class: 'text-input', value: draft.name, maxlength: 24, style: { flex: '1' } });
    name.addEventListener('input', () => { draft.name = name.value; });
    const rows = [h('div', { class: 'set-row' }, h('span', { class: 'set-label', style: { flex: 'none', width: '64px' } }, '名称'), name)];
    rows.push(h('div', { class: 'set-row' },
      h('label', null, '深色主题', h('span', { class: 'set-desc' }, '影响代码配色、滚动条与系统标题栏')),
      switchEl(draft.dark, (v) => { draft.dark = v; preview(); })));

    const colorBox = h('div');
    for (const [key, label] of COLOR_KEYS) {
      const picker = h('input', { type: 'color', value: draft.colors[key] });
      const hex = h('input', { class: 'text-input hex', value: draft.colors[key], maxlength: 7, spellcheck: 'false' });
      const swatch = h('span', { class: 'color-pick' }, picker);
      picker.addEventListener('input', () => {
        draft.colors[key] = picker.value.toUpperCase();
        hex.value = draft.colors[key];
        preview();
      });
      hex.addEventListener('input', () => {
        const v = hex.value.trim();
        if (/^#[0-9a-fA-F]{6}$/.test(v)) {
          draft.colors[key] = v.toUpperCase();
          picker.value = v;
          preview();
        }
      });
      colorBox.append(h('div', { class: 'color-row' }, h('label', null, label), hex, swatch));
    }

    const actions = h('div', { class: 'editor-actions' });
    const save = h('button', { type: 'button', class: 'btn primary sm', html: icon('check') + '保存并使用' });
    save.addEventListener('click', () => this._saveDraft());
    actions.append(save);
    const exp = h('button', { type: 'button', class: 'btn sm', html: icon('download') + '导出' });
    exp.addEventListener('click', () => {
      const data = { name: draft.name, dark: draft.dark, colors: draft.colors, app: 'mdreader-theme', v: 1 };
      host.saveText((draft.name || '主题').replace(/[\\/:*?"<>|]/g, '_') + '.json', JSON.stringify(data, null, 2));
    });
    const imp = h('button', { type: 'button', class: 'btn sm', html: icon('upload') + '导入' });
    imp.addEventListener('click', () => this._importTheme());
    actions.append(exp, imp);
    if (isCustom) {
      const del = h('button', { type: 'button', class: 'btn sm danger', html: icon('trash') + '删除' });
      del.addEventListener('click', async () => {
        if (!(await confirmDialog('删除主题', `确定删除“${draft.name}”吗？`, '删除', true))) return;
        store.data.customThemes = store.data.customThemes.filter((t) => t.id !== draft.id);
        for (const k of ['theme', 'lightTheme', 'darkTheme']) {
          if (store.settings[k] === draft.id) store.set(k, draft.dark ? 'claude-dark' : 'claude-light');
        }
        store.save(true);
        this.editing = null;
        this.hooks.restoreTheme && this.hooks.restoreTheme();
        this._renderMain();
      });
      actions.append(del);
    }

    b.append(
      h('section', { class: 'set-section' }, h('h3', null, '基本'), ...rows),
      h('section', { class: 'set-section' }, h('h3', null, '颜色（修改后立即预览）'), colorBox, actions),
    );
  }

  _saveDraft() {
    const { draft } = this.editing;
    draft.name = (draft.name || '').trim() || '自定义主题';
    const list = store.data.customThemes;
    const i = list.findIndex((t) => t.id === draft.id);
    const copy = { id: draft.id, name: draft.name, dark: draft.dark, colors: { ...draft.colors } };
    if (i >= 0) list[i] = copy; else list.push(copy);
    store.save(true);
    this.editing = null;
    if (store.settings.theme === copy.id && !store.settings.followSystem) this.hooks.restoreTheme && this.hooks.restoreTheme();
    else this.selectTheme(copy.id);
    toast(`已保存主题“${copy.name}”`);
    this._renderMain();
  }

  _cancelEditor(silent) {
    if (!this.editing) return;
    this.editing = null;
    this.hooks.restoreTheme && this.hooks.restoreTheme();
    if (!silent) this._renderMain();
  }

  _importTheme() {
    const input = h('input', { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      try {
        const t = normalizeTheme(JSON.parse(await f.text()));
        if (!t) throw new Error('格式不正确');
        store.data.customThemes.push(t);
        store.save(true);
        this.editing = null;
        this.selectTheme(t.id);
        toast(`已导入主题“${t.name}”`);
        this._renderMain();
      } catch (err) {
        toast('导入失败：' + err.message);
      }
    });
    input.click();
  }
}

// 主题预览用：临时应用，不写入设置
export function previewTheme(theme) {
  return applyTheme(theme);
}
