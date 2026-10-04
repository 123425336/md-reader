// 开发自测：通过调试端口截取桌面版页面画面
// 用法：node tools/cdp_shot.js <输出.png>
'use strict';
const fs = require('fs');

const port = process.env.CDP_PORT || 9222;
const hostName = process.env.CDP_HOST || '[::1]';
const out = process.argv[2] || 'shot.png';

(async () => {
  const list = await (await fetch(`http://${hostName}:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.startsWith('https://app.local/'));
  if (!page) { console.error('未找到页面'); process.exit(2); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png', captureBeyondViewport: false } }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id !== 1) return;
    if (!m.result) { console.error(JSON.stringify(m)); process.exit(1); }
    fs.writeFileSync(out, Buffer.from(m.result.data, 'base64'));
    console.log('已保存', out);
    ws.close();
    process.exit(0);
  };
})().catch((err) => { console.error(err.message || err); process.exit(1); });
