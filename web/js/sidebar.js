// 墨阅 · 侧栏：目录树（可折叠、可筛选、跟随阅读位置）与书签列表
import { store } from './store.js';
import { icon, escapeHtml, relTime, formatPct, debounce } from './ui.js';

const TWISTY = icon('right');

export class Sidebar {
  constructor(els, reader, hooks = {}) {
    this.els = els;           // { toc, bookmarks, filter, filterBox, tools, count, body, tabs }
    this.reader = reader;
    this.hooks = hooks;       // { onBookmarksChanged }
    this.headings = [];
    this.parent = null;
    this.itemEls = [];
    this.kidsEls = [];
    this.active = -1;
    this.autoOpened = new Set();
    this.tab = 'toc';
    this.filterText = '';
    this.hovering = false;

    els.toc.addEventListener('click', (e) => this._onTocClick(e));
    els.bookmarks.addEventListener('click', (e) => this._onBmClick(e));
    els.body.addEventListener('pointerenter', () => { this.hovering = true; });
    els.body.addEventListener('pointerleave', () => { this.hovering = false; });
    els.filter.addEventListener('input', debounce(() => this.setFilter(els.filter.value), 120));
    els.filter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && els.filter.value) { e.stopPropagation(); els.filter.value = ''; this.setFilter(''); }
      if (e.key === 'Enter') {
        const first = els.toc.querySelector('.toc-item');
        if (first) this.reader.jumpToHeading(+first.dataset.i);
      }
    });
    for (const t of els.tabs) t.addEventListener('click', () => this.showTab(t.dataset.tab));
  }

  showTab(tab) {
    this.tab = tab;
    for (const t of this.els.tabs) t.classList.toggle('on', t.dataset.tab === tab);
    const isToc = tab === 'toc';
    this.els.toc.hidden = !isToc;
    this.els.filterBox.hidden = !isToc;
    this.els.tools.hidden = !isToc;
    this.els.bookmarks.hidden = isToc;
    if (!isToc) this.renderBookmarks();
    else if (this.active >= 0) this._reveal(this.active, false);
  }

  // ───── 目录 ─────
  build(headings) {
    this.headings = headings;
    this.active = -1;
    this.autoOpened.clear();
    const n = headings.length;
    const parent = new Int32Array(n).fill(-1);
    const depth = new Int32Array(n);
    const kids = Array.from({ length: n }, () => []);
    const roots = [];
    const stack = [];
    for (let i = 0; i < n; i++) {
      const lv = headings[i].level;
      while (stack.length && headings[stack[stack.length - 1]].level >= lv) stack.pop();
      if (stack.length) {
        parent[i] = stack[stack.length - 1];
        kids[parent[i]].push(i);
        depth[i] = depth[parent[i]] + 1;
      } else {
        roots.push(i);
      }
      stack.push(i);
    }
    this.parent = parent;
    this.depth = depth;
    // 默认展开层级：depth < openDepth - 1 的节点展开；“自动”时标题较多则只显示第一级
    const openDepth = store.settings.tocDepth || (n > 80 ? 1 : 2);
    // 只有一个根节点（通常是书名）时，不计入层级
    const rootShift = roots.length === 1 && kids[roots[0]].length ? 1 : 0;

    const parts = [];
    const render = (i) => {
      const h = headings[i];
      const hasKids = kids[i].length > 0;
      const d = Math.max(0, depth[i] - rootShift);
      const open = hasKids && (d < openDepth - 1 || (rootShift && depth[i] === 0));
      const label = h.html && h.html.includes('katex') ? h.html : escapeHtml(h.text || '（无标题）');
      // 没有子项的条目不放折叠图标，减少节点数量
      const tw = hasKids ? `<span class="toc-tw${open ? ' open' : ''}" data-tw="${i}">${TWISTY}</span>` : '<span class="toc-tw leaf"></span>';
      parts.push(`<div class="toc-item${d === 0 ? ' top' : ''}" data-i="${i}" style="--d:${d}" title="${escapeHtml(h.text)}">${tw}<span class="toc-label">${label}</span></div>`);
      if (hasKids) {
        parts.push(`<div class="toc-kids${open ? '' : ' closed'}" data-p="${i}">`);
        for (const k of kids[i]) render(k);
        parts.push('</div>');
      }
    };
    for (const r of roots) render(r);
    this.els.toc.innerHTML = parts.join('');
    this.itemEls = new Array(n);
    this.kidsEls = new Array(n);
    for (const el of this.els.toc.querySelectorAll('.toc-item')) this.itemEls[+el.dataset.i] = el;
    for (const el of this.els.toc.querySelectorAll('.toc-kids')) this.kidsEls[+el.dataset.p] = el;
    this.els.count.textContent = n ? `${n} 个标题` : '';
    if (!n) this.els.toc.innerHTML = '<div class="sb-empty">这份文档没有标题</div>';
    if (this.filterText) this.setFilter(this.filterText);
  }

  _setOpen(i, open) {
    const kids = this.kidsEls[i];
    if (!kids) return;
    kids.classList.toggle('closed', !open);
    const tw = this.itemEls[i] && this.itemEls[i].firstElementChild;
    if (tw) tw.classList.toggle('open', open);
  }

  _onTocClick(e) {
    const tw = e.target.closest('.toc-tw');
    if (tw && !tw.classList.contains('leaf') && !this.filterText) {
      const i = +tw.dataset.tw;
      const open = this.kidsEls[i] && this.kidsEls[i].classList.contains('closed');
      this._setOpen(i, open);
      this.autoOpened.delete(i);
      return;
    }
    const item = e.target.closest('.toc-item');
    if (!item) return;
    const i = +item.dataset.i;
    this.reader.jumpToHeading(i, { flash: false });
    if (this.hooks.onNavigate) this.hooks.onNavigate(i);
  }

  expandAll(open) {
    for (let i = 0; i < this.kidsEls.length; i++) if (this.kidsEls[i]) this._setOpen(i, open);
    this.autoOpened.clear();
    if (!open && this.active >= 0) this._reveal(this.active, true);
  }

  // 标记当前章节，自动展开其所在分支，并把此前自动展开的分支收起
  setActive(i) {
    if (i === this.active || !this.itemEls.length) return;
    const prev = this.itemEls[this.active];
    if (prev) prev.classList.remove('active');
    this.active = i;
    if (i < 0 || !this.itemEls[i]) return;
    this.itemEls[i].classList.add('active');
    if (!this.filterText) this._reveal(i, false);
  }

  _reveal(i, force) {
    const keep = new Set();
    let p = this.parent ? this.parent[i] : -1;
    while (p >= 0) {
      keep.add(p);
      if (this.kidsEls[p] && this.kidsEls[p].classList.contains('closed')) {
        this._setOpen(p, true);
        this.autoOpened.add(p);
      }
      p = this.parent[p];
    }
    for (const a of [...this.autoOpened]) {
      if (!keep.has(a)) { this._setOpen(a, false); this.autoOpened.delete(a); }
    }
    if (force || !this.hovering) this._scrollIntoView(this.itemEls[i]);
  }

  locate() {
    if (this.active >= 0) {
      if (this.filterText) { this.els.filter.value = ''; this.setFilter(''); }
      this._reveal(this.active, true);
    }
  }

  _scrollIntoView(el) {
    if (!el || this.els.toc.hidden) return;
    const body = this.els.body;
    const br = body.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < br.top + 8 || r.bottom > br.bottom - 8) {
      body.scrollTop += r.top - br.top - br.height * 0.35;
    }
  }

  setFilter(q) {
    this.filterText = (q || '').trim();
    const box = this.els.toc;
    if (!this.headings.length) return;
    if (!this.filterText) {
      // 清空筛选：重建目录树并重新标记当前章节
      this.build(this.headings);
      if (this.hooks.getActive) this.setActive(this.hooks.getActive());
      return;
    }
    const needle = this.filterText.toLowerCase();
    const parts = [];
    let count = 0;
    for (let i = 0; i < this.headings.length && count < 400; i++) {
      const h = this.headings[i];
      const t = h.text || '';
      const idx = t.toLowerCase().indexOf(needle);
      if (idx < 0) continue;
      count++;
      const label = escapeHtml(t.slice(0, idx)) + '<mark>' + escapeHtml(t.slice(idx, idx + needle.length)) + '</mark>' + escapeHtml(t.slice(idx + needle.length));
      parts.push(`<div class="toc-item toc-hit${i === this.active ? ' active' : ''}" data-i="${i}" style="--d:0" title="${escapeHtml(t)}"><span class="toc-tw leaf"></span><span class="toc-label">${label}</span></div>`);
    }
    box.innerHTML = parts.length ? parts.join('') : '<div class="sb-empty">没有匹配的标题</div>';
    this.itemEls = new Array(this.headings.length);
    this.kidsEls = new Array(this.headings.length);
    for (const el of box.querySelectorAll('.toc-item')) this.itemEls[+el.dataset.i] = el;
    this.els.count.textContent = `找到 ${count}${count >= 400 ? '+' : ''} 个`;
  }

  clear() {
    this.headings = [];
    this.itemEls = [];
    this.kidsEls = [];
    this.active = -1;
    this.els.toc.innerHTML = '';
    this.els.bookmarks.innerHTML = '';
    this.els.count.textContent = '';
  }

  // ───── 书签 ─────
  renderBookmarks() {
    const doc = this.reader.doc;
    const box = this.els.bookmarks;
    if (!doc) { box.innerHTML = ''; return; }
    const f = store.file(doc.path);
    const list = (f && f.bookmarks) || [];
    if (!list.length) {
      box.innerHTML = `<div class="sb-empty">还没有书签。<br>按 <span class="kbd">Ctrl</span> + <span class="kbd">D</span> 或点击顶栏的书签按钮，<br>把当前位置记下来。</div>`;
      return;
    }
    const sorted = [...list].sort((a, b) => (a.pct || 0) - (b.pct || 0));
    box.innerHTML = sorted.map((b) => `
      <div class="bm-item" data-id="${escapeHtml(b.id)}">
        <div class="bm-title">${escapeHtml(b.title || '书签')}</div>
        ${b.snippet ? `<div class="bm-snippet">${escapeHtml(b.snippet)}</div>` : ''}
        <div class="bm-meta">${formatPct(b.pct || 0)} · ${relTime(b.created)}</div>
        <button class="icon-btn sm bm-del" data-del="${escapeHtml(b.id)}" title="删除书签">${icon('trash')}</button>
      </div>`).join('');
  }

  _onBmClick(e) {
    const doc = this.reader.doc;
    if (!doc) return;
    const f = store.file(doc.path);
    const list = (f && f.bookmarks) || [];
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      store.updateFile(doc.path, { bookmarks: list.filter((b) => b.id !== del.dataset.del) });
      store.save(true);
      this.renderBookmarks();
      this.hooks.onBookmarksChanged && this.hooks.onBookmarksChanged();
      return;
    }
    const item = e.target.closest('.bm-item');
    if (!item) return;
    const bm = list.find((b) => b.id === item.dataset.id);
    if (bm) this.reader.jumpToAnchor(bm.pos);
  }
}
