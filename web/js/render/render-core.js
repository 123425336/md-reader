/*
 * 墨阅 · 渲染核心
 * 经典脚本：把 Markdown 文本解析、排版为分块 HTML，同时产出目录、统计信息和布局估算参数。
 * 运行环境：渲染 Worker（首选）或主线程（回退）。依赖全局对象：markdownit、katex、hljs、markdownitFootnote、MdPlugins。
 */
(function (root) {
  'use strict';

  const CHUNK_TARGET = 2600;          // 每个分块的目标“权重”（约等于全角字数）
  const MATH_CACHE_LIMIT = 8000;      // 公式渲染缓存上限
  const HIGHLIGHT_LIMIT = 200000;     // 超过此长度的代码块不做语法高亮

  const mdCache = new Map();          // 按选项缓存解析器实例
  const mathCache = new Map();        // 公式渲染结果缓存（同一文件重复渲染时极快）
  let macros = {};                    // 当前文档中定义的公式宏
  let macrosDirty = false;            // 文档定义过宏后，后续公式不再走缓存

  // ───────────────────────── 工具函数 ─────────────────────────
  const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => HTML_ESC[c]);
  }

  function now() {
    return (root.performance && root.performance.now) ? root.performance.now() : Date.now();
  }

  // 生成标题锚点：保留中日韩文字、字母数字、连字符和下划线
  function slugify(text) {
    return String(text).trim().toLowerCase()
      .replace(/[\s　]+/g, '-')
      .replace(/[!-,./:-@\[-\^`{-~ -¿ -⁯、-〃〈-】〔-〟！-／：-＠［-｀｛-･]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // 规整路径中的 . 与 ..（统一使用正斜杠）
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

  // 本地绝对路径 → 宿主文件通道地址
  function fsUrl(absPath) {
    const norm = normalizePath(String(absPath).replace(/\\/g, '/'));
    return '/@fs/' + encodeURIComponent(norm).replace(/%2F/gi, '/').replace(/%3A/gi, ':');
  }

  // 把文档中的相对地址（图片等）解析为可加载的地址
  function resolveLocal(url, env) {
    if (!url) return url;
    if (/^(https?:|data:|blob:|mailto:|tel:|#|\/@fs\/)/i.test(url)) return url;
    let p = url;
    if (/^file:/i.test(p)) p = p.replace(/^file:\/*/i, '');
    try { p = decodeURIComponent(p); } catch (_) { /* 保持原样 */ }
    p = p.replace(/[?#].*$/, '');
    const base = (env && env.baseDir) || '';
    let abs;
    if (/^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]{2}/.test(p)) abs = p;
    else if (/^[\\/]/.test(p)) abs = base.slice(0, 2) + p;
    else abs = base + p;
    return fsUrl(abs);
  }

  // ───────────────────────── 公式渲染 ─────────────────────────
  function mathTrust(ctx) {
    // 仅允许公式中的网址链接使用安全协议
    return (ctx.command === '\\href' || ctx.command === '\\url') && /^(https?|mailto)$/i.test(ctx.protocol || '');
  }

  function renderMath(tex, display) {
    const key = (display ? 'D\u0001' : 'I\u0001') + tex;
    const useCache = !macrosDirty;
    if (useCache) {
      const hit = mathCache.get(key);
      if (hit !== undefined) return hit;
    }
    const before = Object.keys(macros).length;
    let html;
    try {
      html = root.katex.renderToString(tex, {
        displayMode: display,
        throwOnError: true,
        output: 'html',
        strict: 'ignore',
        trust: mathTrust,
        macros,
        globalGroup: true,
        maxExpand: 3000,
      });
      // 注入公式源码，便于复制公式
      const attr = ' data-tex="' + escapeHtml(tex) + '"';
      html = display
        ? html.replace('<span class="katex-display"', '<span class="katex-display"' + attr)
        : html.replace('<span class="katex"', '<span class="katex"' + attr);
    } catch (err) {
      const msg = String((err && err.message) || err);
      const cls = display ? 'math-error math-error-block' : 'math-error';
      html = '<span class="' + cls + '" title="' + escapeHtml('公式无法排版：' + msg) + '" data-tex="' + escapeHtml(tex) + '">'
        + escapeHtml(display ? tex : tex) + '</span>';
    }
    if (Object.keys(macros).length !== before) macrosDirty = true;
    if (useCache && !macrosDirty) {
      if (mathCache.size >= MATH_CACHE_LIMIT) mathCache.clear();
      mathCache.set(key, html);
    }
    return html;
  }

  // ───────────────────────── 代码高亮 ─────────────────────────
  function highlight(code, lang) {
    const hl = root.hljs;
    if (lang && hl && code.length <= HIGHLIGHT_LIMIT) {
      const alias = { 'c++': 'cpp', 'c#': 'csharp', 'sh': 'bash', 'shell': 'bash', 'ps1': 'powershell', 'yml': 'yaml', 'vue': 'xml', 'html': 'xml' }[lang] || lang;
      if (hl.getLanguage(alias)) {
        try { return hl.highlight(code, { language: alias, ignoreIllegals: true }).value; } catch (_) { /* 回退为纯文本 */ }
      }
    }
    return escapeHtml(code);
  }

  // ───────────────────────── 渲染规则 ─────────────────────────
  function installRenderers(md) {
    const rules = md.renderer.rules;
    const unescapeAll = md.utils.unescapeAll;

    rules.math_inline = (tokens, idx) => renderMath(tokens[idx].content, false);
    rules.math_inline_display = (tokens, idx) => renderMath(tokens[idx].content, true);
    rules.math_block = (tokens, idx) => {
      const t = tokens[idx];
      return '<div class="math-block" data-line="' + (t.map ? t.map[0] : '') + '">' + renderMath(t.content, true) + '</div>\n';
    };

    function codeBlockHtml(content, lang, line) {
      const lower = (lang || '').toLowerCase();
      const body = highlight(content.replace(/\n$/, ''), lower);
      const label = lang ? escapeHtml(lang) : 'text';
      return '<div class="code-block" data-line="' + line + '"><div class="code-head"><span class="code-lang">' + label
        + '</span><button type="button" class="code-copy" title="复制代码">复制</button></div><pre><code class="hljs'
        + (lower ? ' language-' + escapeHtml(lower) : '') + '">' + body + '</code></pre></div>\n';
    }

    rules.fence = (tokens, idx) => {
      const t = tokens[idx];
      const info = t.info ? unescapeAll(t.info).trim() : '';
      const lang = info ? info.split(/\s+/)[0] : '';
      const line = t.map ? t.map[0] : '';
      const lower = lang.toLowerCase();
      if (lower === 'math' || lower === 'katex') {
        return '<div class="math-block" data-line="' + line + '">' + renderMath(t.content, true) + '</div>\n';
      }
      return codeBlockHtml(t.content, lang, line);
    };

    rules.code_block = (tokens, idx) => {
      const t = tokens[idx];
      return codeBlockHtml(t.content, '', t.map ? t.map[0] : '');
    };

    rules.front_matter = (tokens, idx) => {
      const t = tokens[idx];
      return '<details class="front-matter" data-line="' + (t.map ? t.map[0] : 0) + '"><summary>文档属性</summary><pre><code>'
        + escapeHtml(t.content) + '</code></pre></details>\n';
    };

    rules.table_open = (tokens, idx, options, env, slf) => '<div class="table-wrap">' + slf.renderToken(tokens, idx, options);
    rules.table_close = (tokens, idx, options, env, slf) => slf.renderToken(tokens, idx, options) + '</div>\n';

    const defaultImage = rules.image;
    rules.image = (tokens, idx, options, env, slf) => {
      const t = tokens[idx];
      t.attrSet('src', resolveLocal(t.attrGet('src'), env));
      t.attrSet('loading', 'lazy');
      t.attrSet('decoding', 'async');
      return defaultImage(tokens, idx, options, env, slf);
    };

    // 任务列表的复选框
    rules.list_item_open = (tokens, idx, options, env, slf) => {
      const t = tokens[idx];
      let html = slf.renderToken(tokens, idx, options);
      if (t.meta && t.meta.task) {
        html += '<input class="task-box" type="checkbox" disabled' + (t.meta.task === 'done' ? ' checked' : '') + '> ';
      }
      return html;
    };

    // 提示块标题
    rules.blockquote_open = (tokens, idx, options, env, slf) => {
      const t = tokens[idx];
      const html = slf.renderToken(tokens, idx, options);
      if (t.meta && t.meta.alert) {
        return html + '<p class="alert-title">' + escapeHtml(t.meta.alertTitle || '') + '</p>\n';
      }
      return html;
    };
  }

  // 获取（或创建）解析器实例
  function getMd(opts) {
    const key = opts.breaks ? 'breaks' : 'normal';
    let md = mdCache.get(key);
    if (md) return md;
    md = root.markdownit({ html: true, linkify: true, typographer: false, breaks: !!opts.breaks });
    md.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
    if (root.markdownitFootnote) md.use(root.markdownitFootnote);
    root.MdPlugins.install(md);
    installRenderers(md);
    mdCache.set(key, md);
    return md;
  }

  // ───────────────────────── 文本与度量 ─────────────────────────
  // 统计一段文字的全角字符数与半角字符数（用于估算排版高度和阅读时长）
  function countChars(s, m) {
    let wide = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0x2E80 && !(c >= 0xD800 && c <= 0xDFFF)) wide++;
    }
    m.wide += wide;
    m.narrow += s.length - wide;
  }

  function newMetrics() {
    return {
      wide: 0, narrow: 0, blocks: 0, h1: 0, h2: 0, h3: 0, h4: 0, dmath: 0, dmathRows: 0, imath: 0, codes: 0, codeLines: 0,
      trows: 0, imgs: 0, hrs: 0, htmlLines: 0, quotes: 0, items: 0,
      tables: 0, rows: [], cellWide: 0, cellNarrow: 0,   // 表格：rows 依次存放 [列数, 最长单元格字宽] 对
    };
  }

  function measureInline(children, m) {
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      switch (c.type) {
        case 'text': case 'code_inline': countChars(c.content, m); break;
        case 'math_inline': m.imath++; m.narrow += Math.min(c.content.length, 60) * 0.55; break;
        case 'math_inline_display': m.dmath++; m.dmathRows += 1 + (c.content.match(/\\\\/g) || []).length; break;
        case 'image': m.imgs++; break;
        case 'hardbreak': m.blocks += 0.5; break;
        default: break;
      }
    }
  }

  function measureRange(tokens, a, b, m) {
    let inTable = 0;
    let rowCols = 0;
    let rowMax = 0;
    const cell = { wide: 0, narrow: 0, blocks: 0, imath: 0, dmath: 0, dmathRows: 0, imgs: 0 };
    for (let k = a; k < b; k++) {
      const t = tokens[k];
      if (inTable) {
        // 表格单元格并排排列，行高取决于最长的单元格，单独统计
        if (t.type === 'table_close') { inTable--; continue; }
        if (t.type === 'tr_open') { m.trows++; rowCols = 0; rowMax = 0; continue; }
        if (t.type === 'tr_close') { m.rows.push(rowCols || 1, rowMax); continue; }
        if (t.type === 'inline') {
          cell.wide = 0; cell.narrow = 0;
          measureInline(t.children, cell);
          rowCols++;
          rowMax = Math.max(rowMax, cell.wide + cell.narrow * 0.53);
          m.cellWide += cell.wide;
          m.cellNarrow += cell.narrow;
        }
        continue;
      }
      switch (t.type) {
        case 'table_open': inTable++; m.tables++; break;
        case 'inline': measureInline(t.children, m); m.blocks++; break;
        case 'heading_open': {
          const lv = +t.tag.slice(1);
          if (lv === 1) m.h1++; else if (lv === 2) m.h2++; else if (lv === 3) m.h3++; else m.h4++;
          break;
        }
        case 'math_block': m.dmath++; m.dmathRows += 1 + (t.content.match(/\\\\/g) || []).length; break;
        case 'fence': case 'code_block': m.codes++; m.codeLines += t.content.split('\n').length; break;
        case 'hr': m.hrs++; break;
        case 'html_block': m.htmlLines += t.content.split('\n').length; break;
        case 'blockquote_open': m.quotes++; break;
        case 'list_item_open': m.items++; break;
        case 'front_matter': m.codes++; break;
        default: break;
      }
    }
  }

  // 分块的文字“质量”（全角字数 + 半角字数的一半），用于控制分块大小
  function mass(m) {
    return m.wide + m.cellWide + (m.narrow + m.cellNarrow) * 0.5;
  }

  // 粗略统计原始 HTML 中块级标签的开闭平衡，避免把 <details> 等结构切到两个分块里
  function htmlBalance(content) {
    let bal = 0;
    const re = /<(\/?)(details|div|section|table|blockquote|ul|ol|dl|figure|center|article|aside|nav|header|footer|main)\b[^>]*?(\/?)>/gi;
    let m;
    while ((m = re.exec(content))) {
      if (m[3]) continue;
      bal += m[1] ? -1 : 1;
    }
    return bal;
  }

  // 目录用的行内 HTML：去掉链接、脚注引用和图片，只保留文字与公式
  function tocInlineHtml(md, inline, env) {
    if (!inline || !inline.children) return '';
    const kept = inline.children.filter((c) => c.type !== 'link_open' && c.type !== 'link_close' && c.type !== 'footnote_ref' && c.type !== 'image');
    return md.renderer.renderInline(kept, md.options, env);
  }

  function inlinePlain(inline) {
    if (!inline || !inline.children) return inline ? inline.content : '';
    let s = '';
    for (const c of inline.children) {
      if (c.type === 'text' || c.type === 'code_inline') s += c.content;
      else if (c.type === 'math_inline' || c.type === 'math_inline_display') s += c.content;
      else if (c.type === 'image') s += c.content || '';
      else if (c.type === 'softbreak' || c.type === 'hardbreak') s += ' ';
    }
    return s;
  }

  // ───────────────────────── 主流程 ─────────────────────────
  function render(text, opts) {
    opts = opts || {};
    const t0 = now();
    const md = getMd(opts);
    macros = {};
    macrosDirty = false;
    const env = { baseDir: opts.baseDir || '' };
    const tokens = md.parse(text, env);
    const t1 = now();

    // 标题锚点与行号标记
    const headings = [];
    const slugCount = new Map();
    let title = '';
    let frontTitle = '';
    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      if (tk.type === 'heading_open') {
        const inline = tokens[i + 1];
        const plain = inlinePlain(inline).trim();
        let base = slugify(plain) || 'section';
        let id = base;
        const n = slugCount.get(base) || 0;
        if (n) id = base + '-' + n;
        slugCount.set(base, n + 1);
        tk.attrSet('id', id);
        const level = +tk.tag.slice(1);
        if (!title && level === 1) title = plain;
        headings.push({ level, text: plain, html: '', id, line: tk.map ? tk.map[0] : 0, chunk: -1, inlineIdx: i + 1 });
      } else if (tk.type === 'front_matter') {
        const m = /^title\s*:\s*["']?(.+?)["']?\s*$/m.exec(tk.content);
        if (m) frontTitle = m[1];
      }
      if (tk.map && tk.block && tk.nesting >= 0 && tk.type !== 'inline') tk.attrSet('data-line', String(tk.map[0]));
    }

    // 按顶层块切分
    const chunks = [];
    let cur = null;
    let balance = 0;
    let headingPtr = 0;
    let lastLine = 0;
    const flush = () => {
      if (!cur) return;
      cur.html = md.renderer.render(tokens.slice(cur.a, cur.b), md.options, env);
      delete cur.a; delete cur.b;
      chunks.push(cur);
      cur = null;
    };
    let i = 0;
    while (i < tokens.length) {
      const tk = tokens[i];
      let j = i + 1;
      if (tk.nesting === 1) {
        let depth = 0;
        for (j = i; j < tokens.length; j++) {
          depth += tokens[j].nesting;
          if (depth <= 0) { j++; break; }
        }
      }
      const isHeading = tk.type === 'heading_open';
      const level = isHeading ? +tk.tag.slice(1) : 9;
      if (cur && balance <= 0) {
        const w = cur.weight;
        if ((isHeading && level <= 2 && w >= CHUNK_TARGET * 0.45)
          || (isHeading && level <= 4 && w >= CHUNK_TARGET)
          || w >= CHUNK_TARGET * 2.2) {
          flush();
        }
      }
      if (!cur) {
        const startLine = tk.map ? tk.map[0] : lastLine;
        cur = { a: i, b: i, line0: startLine, line1: startLine, m: newMetrics(), weight: 0, hasHtml: false, heads: [] };
      }
      // 累计度量
      const before = mass(cur.m);
      measureRange(tokens, i, j, cur.m);
      let extra = 0;
      for (let k = i; k < j; k++) {
        const t = tokens[k];
        if (t.type === 'html_block') { cur.hasHtml = true; balance += htmlBalance(t.content); extra += 40; }
        else if (t.type === 'inline' && t.children) {
          for (const c of t.children) if (c.type === 'html_inline') { cur.hasHtml = true; break; }
        } else if (t.type === 'math_block') extra += 120;
        else if (t.type === 'tr_open') extra += 30;
        else if (t.type === 'fence' || t.type === 'code_block') extra += 30 * t.content.split('\n').length;
        else if (t.type === 'heading_open') {
          // 记录该标题所在的分块（用于目录定位和阅读位置追踪）
          while (headingPtr < headings.length && headings[headingPtr].inlineIdx < k + 1) headingPtr++;
          if (headingPtr < headings.length && headings[headingPtr].inlineIdx === k + 1) {
            headings[headingPtr].chunk = chunks.length;
            cur.heads.push(headingPtr);
            headingPtr++;
          }
          extra += 60;
        }
        if (t.map) lastLine = Math.max(lastLine, t.map[1]);
      }
      cur.weight += (mass(cur.m) - before) + extra;
      cur.line1 = lastLine;
      cur.b = j;
      i = j;
    }
    flush();
    const t2 = now();

    // 目录 HTML（含公式等行内格式）
    for (const h of headings) {
      h.html = tocInlineHtml(md, tokens[h.inlineIdx], env);
      delete h.inlineIdx;
    }

    // 统计信息
    const stats = { wide: 0, narrow: 0, formulas: 0, displayFormulas: 0, tables: 0, images: 0, codes: 0, headings: headings.length };
    for (const c of chunks) {
      stats.wide += c.m.wide + c.m.cellWide;
      stats.narrow += c.m.narrow + c.m.cellNarrow;
      stats.formulas += c.m.imath + c.m.dmath;
      stats.displayFormulas += c.m.dmath;
      stats.images += c.m.imgs;
      stats.codes += c.m.codes;
    }
    for (const tk of tokens) if (tk.type === 'table_open') stats.tables++;

    return {
      chunks,
      headings,
      stats,
      title: title || frontTitle || '',
      timing: { parse: Math.round(t1 - t0), render: Math.round(t2 - t1), total: Math.round(now() - t0) },
    };
  }

  root.MdRender = { render, slugify, fsUrl, normalizePath };
})(typeof self !== 'undefined' ? self : this);
