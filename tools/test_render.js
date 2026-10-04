// 开发自测：在 Node 中加载渲染核心，渲染指定 Markdown 文件并输出统计与校验结果
// 用法：node tools/test_render.js <文件路径> [--dump 输出HTML路径]
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const webDir = path.join(__dirname, '..', 'web');
const files = [
  'vendor/markdown-it.min.js',
  'vendor/markdown-it-footnote.min.js',
  'vendor/katex/katex.min.js',
  'vendor/highlight.min.js',
  'js/render/md-plugins.js',
  'js/render/render-core.js',
];

// 模拟浏览器 Worker 的全局环境
const ctx = { console, performance, setTimeout, clearTimeout, atob, btoa, TextDecoder, TextEncoder, URL };
ctx.self = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of files) {
  const code = fs.readFileSync(path.join(webDir, f), 'utf8');
  try {
    vm.runInContext(code, ctx, { filename: f });
  } catch (e) {
    console.error('加载失败:', f, String(e && e.message).slice(0, 300));
    process.exit(2);
  }
}

const target = process.argv[2];
if (!target) { console.error('请提供 Markdown 文件路径'); process.exit(1); }
const text = fs.readFileSync(target, 'utf8').replace(/^﻿/, '');
const baseDir = path.dirname(path.resolve(target)).replace(/\\/g, '/') + '/';

let res;
for (let round = 1; round <= 3; round++) {
  const t0 = performance.now();
  res = ctx.MdRender.render(text, { baseDir });
  console.log(`第${round}轮 渲染用时 ${Math.round(performance.now() - t0)}ms`, res.timing);
}

const html = res.chunks.map((c) => c.html).join('\n');
console.log('分块数:', res.chunks.length, ' 标题数:', res.headings.length, ' 标题:', res.title);
console.log('统计:', res.stats);
const weights = res.chunks.map((c) => Math.round(c.weight));
console.log('分块权重 最小/最大/平均:', Math.min(...weights), Math.max(...weights), Math.round(weights.reduce((a, b) => a + b, 0) / weights.length));
console.log('HTML 总长度:', html.length);
console.log('公式数量(katex 节点):', (html.match(/class="katex"/g) || []).length, ' 显示公式:', (html.match(/class="katex-display"/g) || []).length);
console.log('公式错误数:', (html.match(/class="math-error/g) || []).length);
// 渲染后的正文中不应残留未解析的公式定界符
const stripped = html.replace(/<span class="katex[\s\S]*?<\/span>/g, '').replace(/data-tex="[^"]*"/g, '');
const leftovers = [];
const re = /\\\(|\\\)|\$\$/g;
let m;
while ((m = re.exec(stripped)) && leftovers.length < 10) leftovers.push(stripped.slice(Math.max(0, m.index - 40), m.index + 40));
console.log('残留定界符数:', leftovers.length, leftovers);
console.log('表格数:', (html.match(/<table/g) || []).length);
console.log('未标行号的顶层元素样例:', (html.match(/<(p|h[1-6]|ul|ol|blockquote|li)>/g) || []).slice(0, 5));
console.log('标题所在分块缺失数:', res.headings.filter((h) => h.chunk < 0).length);
const dumpIdx = process.argv.indexOf('--dump');
if (dumpIdx > 0) {
  fs.writeFileSync(process.argv[dumpIdx + 1], html, 'utf8');
  console.log('已输出 HTML 到', process.argv[dumpIdx + 1]);
}
