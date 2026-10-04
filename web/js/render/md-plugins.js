/*
 * 墨阅 · Markdown 语法扩展
 * 经典脚本：可在渲染 Worker 中运行，也可在主线程作为回退方案运行。
 * 提供：数学公式（$…$、$$…$$、\(…\)、\[…\]）、提示块、任务列表、前置元数据、==高亮==。
 */
(function (root) {
  'use strict';

  // 判断是否为空白字符（空格、制表、换行）
  function isSpace(code) {
    return code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0D;
  }

  // ───────────────────────── 行内公式 ─────────────────────────
  // 支持 \( … \)、$$ … $$（段落内的显示公式）、$ … $（按常见规则防误判）
  function mathInline(state, silent) {
    const src = state.src;
    const pos = state.pos;
    const max = state.posMax;
    const ch = src.charCodeAt(pos);

    // \( … \)
    if (ch === 0x5C /* \ */) {
      if (pos + 1 >= max || src.charCodeAt(pos + 1) !== 0x28 /* ( */) return false;
      let i = pos + 2;
      let end = -1;
      while (i < max) {
        const c = src.charCodeAt(i);
        if (c === 0x5C) {
          if (i + 1 < max && src.charCodeAt(i + 1) === 0x29 /* ) */) { end = i; break; }
          i += 2; // 跳过转义字符（例如 \\、\{）
          continue;
        }
        i++;
      }
      if (end < 0) return false;
      const content = src.slice(pos + 2, end);
      if (!content.trim()) return false;
      if (!silent) {
        const token = state.push('math_inline', 'math', 0);
        token.content = content;
        token.markup = '\\(';
      }
      state.pos = end + 2;
      return true;
    }

    if (ch !== 0x24 /* $ */) return false;

    // $$ … $$ 出现在段落中间时，按显示公式处理
    if (pos + 1 < max && src.charCodeAt(pos + 1) === 0x24) {
      let i = pos + 2;
      let end = -1;
      while (i < max) {
        const c = src.charCodeAt(i);
        if (c === 0x5C) { i += 2; continue; }
        if (c === 0x24 && i + 1 < max && src.charCodeAt(i + 1) === 0x24) { end = i; break; }
        i++;
      }
      if (end < 0) return false;
      const content = src.slice(pos + 2, end);
      if (!content.trim()) return false;
      if (!silent) {
        const token = state.push('math_inline_display', 'math', 0);
        token.content = content;
        token.markup = '$$';
      }
      state.pos = end + 2;
      return true;
    }

    // $ … $：开头 $ 右侧不能是空白；结尾 $ 左侧不能是空白，且右侧不能紧跟数字。
    // 中途遇到不满足结尾条件的 $（如 "$5 和 $10"）说明是金额写法，直接放弃，不当作公式。
    if (pos + 1 >= max || isSpace(src.charCodeAt(pos + 1))) return false;
    let i = pos + 1;
    let end = -1;
    while (i < max) {
      const c = src.charCodeAt(i);
      if (c === 0x5C) { i += 2; continue; }
      if (c === 0x24) {
        const prev = src.charCodeAt(i - 1);
        const after = i + 1 < max ? src.charCodeAt(i + 1) : -1;
        if (!isSpace(prev) && !(after >= 0x30 && after <= 0x39)) end = i;
        break;
      }
      i++;
    }
    if (end < 0) return false;
    const content = src.slice(pos + 1, end);
    if (looksLikePlainText(content)) return false;
    if (!silent) {
      const token = state.push('math_inline', 'math', 0);
      token.content = content;
      token.markup = '$';
    }
    state.pos = end + 1;
    return true;
  }

  // 单个 $ 包裹的内容若在文字命令之外含有汉字，多半是普通行文（例如金额），不当作公式
  const TEXT_GROUP = /\\(?:text|textrm|textbf|textit|mbox|mathrm|operatorname|mathbf|mathsf)\s*\{[^{}]*\}/g;
  const CJK = /[　-〿㐀-鿿＀-￯]/;
  function looksLikePlainText(content) {
    if (!CJK.test(content)) return false;
    return CJK.test(content.replace(TEXT_GROUP, ''));
  }

  // ───────────────────────── 块级公式 ─────────────────────────
  // 支持多行 $$ … $$ 与 \[ … \]，也支持单行 $$ … $$
  function mathBlock(state, startLine, endLine, silent) {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false; // 缩进代码块优先
    const src = state.src;
    const pos = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    if (pos + 2 > max) return false;

    let open, close;
    const c0 = src.charCodeAt(pos);
    const c1 = src.charCodeAt(pos + 1);
    if (c0 === 0x24 && c1 === 0x24) { open = '$$'; close = '$$'; }
    else if (c0 === 0x5C && c1 === 0x5B) { open = '\\['; close = '\\]'; }
    else return false;

    const firstTrim = src.slice(pos + 2, max).trim();
    let content;
    let lastLine = startLine;

    if (firstTrim.length >= close.length && firstTrim.endsWith(close)) {
      // 单行形式
      content = firstTrim.slice(0, firstTrim.length - close.length);
      if (!content.trim() || content.indexOf(close) !== -1) return false;
    } else {
      // 首行中途出现闭合符且后面还有文字：交给行内规则
      if (firstTrim.indexOf(close) !== -1) return false;
      let found = false;
      const limit = Math.min(endLine, startLine + 500);
      for (lastLine = startLine + 1; lastLine < limit; lastLine++) {
        const lp = state.bMarks[lastLine] + state.tShift[lastLine];
        const lm = state.eMarks[lastLine];
        if (lp < lm && state.sCount[lastLine] < state.blkIndent) break; // 离开了所在容器（如列表项）
        const lineText = src.slice(lp, lm).trim();
        if (lineText.endsWith(close)) { found = true; break; }
      }
      if (!found) return false;
      if (silent) return true;
      const lp = state.bMarks[lastLine] + state.tShift[lastLine];
      const lastTrim = src.slice(lp, state.eMarks[lastLine]).trim();
      const tail = lastTrim.slice(0, lastTrim.length - close.length);
      const parts = [];
      if (firstTrim) parts.push(firstTrim);
      if (lastLine > startLine + 1) parts.push(state.getLines(startLine + 1, lastLine, state.sCount[startLine], false));
      if (tail.trim()) parts.push(tail);
      content = parts.join('\n');
      if (!content.trim()) return false;
    }
    if (silent) return true;

    state.line = lastLine + 1;
    const token = state.push('math_block', 'math', 0);
    token.block = true;
    token.content = content;
    token.map = [startLine, state.line];
    token.markup = open;
    return true;
  }

  // ───────────────────────── 前置元数据 ─────────────────────────
  // 文档开头的 --- … --- 区块（键值对形式），渲染为可折叠的“文档属性”
  function frontMatter(state, startLine, endLine, silent) {
    if (startLine !== 0 || state.blkIndent !== 0) return false;
    const src = state.src;
    const firstText = src.slice(state.bMarks[0], state.eMarks[0]).trimEnd();
    if (firstText !== '---') return false;
    const limit = Math.min(endLine, 400);
    let line = 1;
    let firstContent = '';
    for (; line < limit; line++) {
      const t = src.slice(state.bMarks[line], state.eMarks[line]).trimEnd();
      if (t === '---' || t === '...') break;
      if (!firstContent && t.trim()) firstContent = t.trim();
    }
    if (line >= limit) return false;
    if (!/^[\w\u4e00-\u9fff-]+\s*:/.test(firstContent)) return false; // 必须像“键: 值”
    if (silent) return true;
    const token = state.push('front_matter', '', 0);
    token.block = true;
    token.content = state.getLines(1, line, 0, false);
    token.map = [0, line + 1];
    state.line = line + 1;
    return true;
  }

  // ───────────────────────── ==高亮== ─────────────────────────
  function markTokenize(state, silent) {
    const start = state.pos;
    const marker = state.src.charCodeAt(start);
    if (silent || marker !== 0x3D /* = */) return false;
    const scanned = state.scanDelims(state.pos, true);
    let len = scanned.length;
    if (len < 2) return false;
    if (len % 2) {
      const token = state.push('text', '', 0);
      token.content = '=';
      len--;
    }
    for (let i = 0; i < len; i += 2) {
      const token = state.push('text', '', 0);
      token.content = '==';
      state.delimiters.push({
        marker, length: 0, token: state.tokens.length - 1, end: -1,
        open: scanned.can_open, close: scanned.can_close,
      });
    }
    state.pos += scanned.length;
    return true;
  }

  function markPostProcess(state, delimiters) {
    const loneMarkers = [];
    for (let i = 0; i < delimiters.length; i++) {
      const startDelim = delimiters[i];
      if (startDelim.marker !== 0x3D || startDelim.end === -1) continue;
      const endDelim = delimiters[startDelim.end];
      let token = state.tokens[startDelim.token];
      token.type = 'mark_open'; token.tag = 'mark'; token.nesting = 1; token.markup = '=='; token.content = '';
      token = state.tokens[endDelim.token];
      token.type = 'mark_close'; token.tag = 'mark'; token.nesting = -1; token.markup = '=='; token.content = '';
      const prev = state.tokens[endDelim.token - 1];
      if (prev.type === 'text' && prev.content === '=') loneMarkers.push(endDelim.token - 1);
    }
    // 把落单的 "=" 移到闭合标记之后，保证嵌套正确
    while (loneMarkers.length) {
      const i = loneMarkers.pop();
      let j = i + 1;
      while (j < state.tokens.length && state.tokens[j].type === 'mark_close') j++;
      j--;
      if (i !== j) {
        const tmp = state.tokens[j];
        state.tokens[j] = state.tokens[i];
        state.tokens[i] = tmp;
      }
    }
  }

  // ───────────────────────── 提示块 ─────────────────────────
  // > [!NOTE] 标题（可选）
  const ALERT_KIND = {
    note: 'note', info: 'note', abstract: 'note', summary: 'note', tldr: 'note', example: 'note', quote: 'note', cite: 'note', todo: 'note',
    tip: 'tip', hint: 'tip', success: 'tip', check: 'tip', done: 'tip',
    important: 'important',
    warning: 'warning', attention: 'warning', question: 'warning', help: 'warning', faq: 'warning',
    caution: 'caution', danger: 'caution', error: 'caution', failure: 'caution', fail: 'caution', missing: 'caution', bug: 'caution',
  };
  const ALERT_TITLE = { note: '注意', tip: '提示', important: '重要', warning: '警告', caution: '小心' };

  function alertsRule(state) {
    const tokens = state.tokens;
    for (let i = 0; i + 2 < tokens.length; i++) {
      if (tokens[i].type !== 'blockquote_open') continue;
      const p = tokens[i + 1];
      const inline = tokens[i + 2];
      if (p.type !== 'paragraph_open' || inline.type !== 'inline') continue;
      const m = /^\[!([A-Za-z]+)\][+-]?[ \t]*([^\n]*)(?:\n|$)/.exec(inline.content);
      if (!m) continue;
      const kind = ALERT_KIND[m[1].toLowerCase()];
      if (!kind) continue;
      tokens[i].attrJoin('class', 'alert alert-' + kind);
      tokens[i].meta = Object.assign({}, tokens[i].meta, { alert: kind, alertTitle: m[2].trim() || ALERT_TITLE[kind] });
      inline.content = inline.content.slice(m[0].length);
      if (!inline.content.trim()) {
        inline.content = '';
        p.hidden = true;
        if (tokens[i + 3] && tokens[i + 3].type === 'paragraph_close') tokens[i + 3].hidden = true;
      }
    }
  }

  // ───────────────────────── 任务列表 ─────────────────────────
  function tasksRule(state) {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i];
      if (inline.type !== 'inline') continue;
      if (tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
      const m = /^\[([ xX])\](?:[ \t]+|$)/.exec(inline.content);
      if (!m) continue;
      inline.content = inline.content.slice(m[0].length);
      const li = tokens[i - 2];
      li.attrJoin('class', 'task-item');
      li.meta = Object.assign({}, li.meta, { task: m[1] === ' ' ? 'todo' : 'done' });
      for (let j = i - 3; j >= 0; j--) {
        const t = tokens[j];
        if ((t.type === 'bullet_list_open' || t.type === 'ordered_list_open') && t.level === li.level - 1) {
          if (!(t.attrGet('class') || '').includes('task-list')) t.attrJoin('class', 'task-list');
          break;
        }
      }
    }
  }

  // 安装全部语法扩展
  function install(md) {
    md.inline.ruler.before('escape', 'math_inline', mathInline);
    md.block.ruler.before('fence', 'math_block', mathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
    md.block.ruler.before('table', 'front_matter', frontMatter);
    md.inline.ruler.before('emphasis', 'mark', markTokenize);
    md.inline.ruler2.before('emphasis', 'mark', function (state) {
      markPostProcess(state, state.delimiters);
      const meta = state.tokens_meta || [];
      for (let k = 0; k < meta.length; k++) {
        if (meta[k] && meta[k].delimiters) markPostProcess(state, meta[k].delimiters);
      }
      return true;
    });
    md.core.ruler.after('block', 'md_alerts', alertsRule);
    md.core.ruler.after('block', 'md_tasks', tasksRule);
  }

  root.MdPlugins = { install, ALERT_TITLE };
})(typeof self !== 'undefined' ? self : this);
