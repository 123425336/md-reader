/*
 * 墨阅 · 渲染 Worker 入口
 * 主线程把依赖脚本与本文件拼接后以 Blob 方式启动 Worker，因此这里不需要再加载任何外部脚本。
 */
(function () {
  'use strict';
  self.onmessage = function (e) {
    const msg = e.data || {};
    if (msg.type !== 'render') return;
    try {
      const out = self.MdRender.render(msg.text, msg.opts || {});
      out.type = 'result';
      out.id = msg.id;
      self.postMessage(out);
    } catch (err) {
      self.postMessage({
        type: 'error',
        id: msg.id,
        message: String((err && err.message) || err),
        stack: String((err && err.stack) || ''),
      });
    }
  };
  // 通知主线程：Worker 已就绪
  self.postMessage({ type: 'boot' });
})();
