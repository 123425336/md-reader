// 开发自测：通过调试端口发送任意协议命令（用于强制回收内存等）
// 用法：node tools/cdp_cmd.js <方法名> [参数JSON]
'use strict';

const port = process.env.CDP_PORT || 9222;
const hostName = process.env.CDP_HOST || '[::1]';
const method = process.argv[2];
const params = process.argv[3] ? JSON.parse(process.argv[3]) : {};

(async () => {
  const list = await (await fetch(`http://${hostName}:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.startsWith('https://app.local/'));
  if (!page) { console.error('未找到页面'); process.exit(2); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.send(JSON.stringify({ id: 1, method, params }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id !== 1) return;
    console.log(JSON.stringify(m.result || m.error));
    ws.close();
    process.exit(0);
  };
})().catch((err) => { console.error(err.message || err); process.exit(1); });
