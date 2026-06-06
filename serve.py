"""Tiny static server for the Voyaging 2126 scene.

Sends `Cache-Control: no-store` so the browser always fetches the latest
main.js / style.css during development (the ES-module import otherwise gets
cached aggressively and reloads show stale code).
"""
import http.server
import socketserver

PORT = 5173


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()


with socketserver.TCPServer(("", PORT), NoCacheHandler) as httpd:
    print(f"Serving Voyaging 2126 on http://localhost:{PORT} (no-store)")
    httpd.serve_forever()
