// 开发自测：通过调试端口在桌面版页面中执行脚本并打印结果
// 用法：node tools/cdp.js "<表达式>"   （需以调试端口启动程序，默认 9222）
'use strict';

const port = process.env.CDP_PORT || 9222;
const hostName = process.env.CDP_HOST || '[::1]';
const expr = process.argv[2] || 'document.title';

(async () => {
  const list = await (await fetch(`http://${hostName}:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.startsWith('https://app.local/'));
  if (!page) { console.error('未找到页面'); process.exit(2); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id !== 1) return;
    const r = m.result || {};
    if (r.exceptionDetails) console.log('脚本异常：', JSON.stringify(r.exceptionDetails, null, 2));
    else console.log(JSON.stringify(r.result && 'value' in r.result ? r.result.value : r.result, null, 2));
    ws.close();
    process.exit(0);
  };
})().catch((err) => { console.error(err.message || err); process.exit(1); });
