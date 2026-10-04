# -*- coding: utf-8 -*-
"""
墨阅 · 开发用本地服务器
提供 web 目录的静态文件，以及 /@fs/<绝对路径> 本地文件读取通道，模拟桌面宿主的行为，
便于在普通浏览器中调试前端界面。仅监听 127.0.0.1。
用法：python tools/dev_server.py [端口]
"""
import http.server
import os
import socketserver
import sys
import urllib.parse

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web'))

# 明确指定类型，避免系统注册表把 .js 映射成 text/plain
MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return MIME.get(ext, 'application/octet-stream')

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # 保持控制台安静

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith('/@fs/'):
            # 本地文件通道：/@fs/D:/dir/file.md
            raw = urllib.parse.unquote(parsed.path[len('/@fs/'):])
            fp = os.path.normpath(raw.replace('/', os.sep))
            if not os.path.isabs(fp) or not os.path.isfile(fp):
                self.send_error(404, 'Not Found')
                return
            try:
                with open(fp, 'rb') as f:
                    data = f.read()
            except OSError:
                self.send_error(403, 'Forbidden')
                return
            self.send_response(200)
            self.send_header('Content-Type', self.guess_type(fp))
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5178
    with Server(('127.0.0.1', port), Handler) as httpd:
        print(f'开发服务器已启动：http://127.0.0.1:{port}/  (web 目录：{ROOT})', flush=True)
        httpd.serve_forever()


if __name__ == '__main__':
    main()
