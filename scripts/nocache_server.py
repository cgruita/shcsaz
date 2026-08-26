"""Local preview server that disables caching, so every reload gets the latest files."""

import http.server
import os

os.chdir(os.path.join(os.path.dirname(__file__), ".."))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        super().end_headers()


if __name__ == "__main__":
    http.server.test(HandlerClass=NoCacheHandler, port=8000)
