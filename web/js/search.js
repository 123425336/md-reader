// 墨阅 · 文档内查找：基于文本索引匹配，使用高亮区域标注，不改动文档结构
import { debounce } from './ui.js';
import { READ_OFFSET } from './reader.js';

const MAX_HITS = 5000;
const BLOCK_SEL = 'p,li,h1,h2,h3,h4,h5,h6,td,th,pre,dt,dd,summary,blockquote,figcaption,.math-block,.code-block,.table-wrap,section';

export class Search {
  constructor(els, reader) {
    this.els = els; // { bar, input, count, prev, next, close, caseBtn }
    this.reader = reader;
    this.index = null;
    this.ranges = [];
    this.cur = -1;
    this.caseSensitive = false;
    this.supported = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';
    this.lastQuery = '';

    const run = debounce(() => this.run(), 140);
    els.input.addEventListener('input', run);
    els.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); run.cancel(); if (this.lastQuery !== els.input.value) this.run(); else this.step(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); }
    });
    els.next.addEventListener('click', () => this.step(1));
    els.prev.addEventListener('click', () => this.step(-1));
    els.close.addEventListener('click', () => this.close());
    els.caseBtn.addEventListener('click', () => {
      this.caseSensitive = !this.caseSensitive;
      els.caseBtn.classList.toggle('on', this.caseSensitive);
      this.run();
    });
  }

  get isOpen() { return !this.els.bar.hidden; }

  open(prefill) {
    if (!this.reader.doc) return;
    this.els.bar.hidden = false;
    if (prefill) this.els.input.value = prefill;
    this.els.input.focus();
    this.els.input.select();
    if (this.els.input.value) this.run();
  }

  close() {
    this.els.bar.hidden = true;
    this.clearMarks();
    this.lastQuery = '';
    this.reader.scroller.focus({ preventScroll: true });
  }

  // 文档重新渲染后索引失效
  invalidate() {
    this.index = null;
    this.ranges = [];
    this.cur = -1;
    this.clearMarks();
    if (this.isOpen && this.els.input.value) setTimeout(() => this.run(), 0);
  }

  clearMarks() {
    if (this.supported) {
      CSS.highlights.delete('search-hit');
      CSS.highlights.delete('search-current');
    }
    this.els.count.textContent = '';
    this.els.count.classList.remove('none');
  }

  // 构建文本索引：跳过公式与代码头部等非正文节点，块与块之间插入换行防止跨块匹配
  _buildIndex() {
    const root = this.reader.article;
    const nodes = [];
    const starts = [];
    let text = '';
    let lastBlock = null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 1) {
          const cl = n.classList;
          if (cl.contains('katex') || cl.contains('katex-display') || cl.contains('code-head') || cl.contains('task-box') || cl.contains('footnote-backref')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      const v = n.nodeValue;
      if (!v) continue;
      const block = n.parentElement.closest(BLOCK_SEL);
      if (block !== lastBlock) {
        text += '\n';
        lastBlock = block;
      }
      nodes.push(n);
      starts.push(text.length);
      text += v;
    }
    const lower = text.toLowerCase();
    this.index = { text, lower: lower.length === text.length ? lower : null, nodes, starts };
  }

  _nodeAt(pos) {
    const s = this.index.starts;
    let lo = 0;
    let hi = s.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid] <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  _makeRange(a, b) {
    const ia = this._nodeAt(a);
    const ib = this._nodeAt(b - 1);
    const r = document.createRange();
    r.setStart(this.index.nodes[ia], a - this.index.starts[ia]);
    r.setEnd(this.index.nodes[ib], b - this.index.starts[ib]);
    return r;
  }

  run() {
    const q = this.els.input.value;
    this.lastQuery = q;
    this.clearMarks();
    this.ranges = [];
    this.cur = -1;
    if (!q || !this.reader.doc) return;
    if (!this.index) this._buildIndex();
    const useCase = this.caseSensitive || !this.index.lower;
    const hay = useCase ? this.index.text : this.index.lower;
    const needle = useCase ? q : q.toLowerCase();
    if (!needle) return;
    let pos = 0;
    const ranges = [];
    while (ranges.length < MAX_HITS) {
      const i = hay.indexOf(needle, pos);
      if (i < 0) break;
      ranges.push(this._makeRange(i, i + needle.length));
      pos = i + needle.length;
    }
    this.ranges = ranges;
    this.capped = ranges.length >= MAX_HITS;
    if (!ranges.length) {
      this.els.count.textContent = '无结果';
      this.els.count.classList.add('none');
      return;
    }
    if (this.supported) CSS.highlights.set('search-hit', new Highlight(...ranges));
    this.cur = this._firstAfterReadingLine();
    this._showCurrent();
  }

  // 从当前阅读位置之后的第一个匹配开始
  _firstAfterReadingLine() {
    const a = this.reader.captureAnchor();
    const t = a && this.reader._resolveAnchor(a);
    if (!t || !t.el) return 0;
    const ref = document.createRange();
    ref.setStart(t.el, 0);
    let lo = 0;
    let hi = this.ranges.length - 1;
    let ans = this.ranges.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.ranges[mid].compareBoundaryPoints(Range.START_TO_START, ref) >= 0) { ans = mid; hi = mid - 1; } else lo = mid + 1;
    }
    return ans >= this.ranges.length ? 0 : ans;
  }

  step(dir) {
    if (!this.ranges.length) { if (this.els.input.value) this.run(); return; }
    this.cur = (this.cur + dir + this.ranges.length) % this.ranges.length;
    this._showCurrent();
  }

  _showCurrent() {
    const r = this.ranges[this.cur];
    if (!r) return;
    if (this.supported) CSS.highlights.set('search-current', new Highlight(r));
    this.els.count.textContent = `${this.cur + 1}/${this.ranges.length}${this.capped ? '+' : ''}`;
    this.reveal(r);
  }

  // 把匹配滚动到视野内（位于阅读区上部三分之一处）
  async reveal(range) {
    const scroller = this.reader.scroller;
    for (let i = 0; i < 4; i++) {
      const rect = range.getBoundingClientRect();
      const sr = scroller.getBoundingClientRect();
      const topLimit = sr.top + READ_OFFSET + 10;
      const bottomLimit = sr.bottom - 60;
      if (rect.height > 0 && rect.top >= topLimit && rect.bottom <= bottomLimit) break;
      scroller.scrollTop += rect.top - (sr.top + sr.height * 0.33);
      await new Promise((res) => requestAnimationFrame(res));
    }
  }
}
