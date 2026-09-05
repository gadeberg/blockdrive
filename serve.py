#!/usr/bin/env python3
"""Static dev server for Blockdrive.

Python's stock `http.server` sends no cache headers at all, which leaves
browsers free to apply heuristic caching: edit a module, reload, and the
browser quietly serves you the old one. This sends `no-store` so a reload
always fetches what is actually on disk.

    ./serve.py                 # editing: never serves a stale file
    ./serve.py --play          # just playing: let the browser cache normally
    ./serve.py -p 9000         # another port
    ./serve.py --host 0.0.0.0  # reachable from your phone on the same network
"""

import argparse
import functools
import os
import socket
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))


class DevHandler(SimpleHTTPRequestHandler):
    # Set from --play. Off means "I am editing these files"; on means "I am
    # playing the game and would rather it loaded from cache".
    cache = False

    # ES modules are refused outright if they arrive as text/plain, and the
    # system mime table can't be relied on to map these. Pin the ones we serve.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.css': 'text/css',
        '.html': 'text/html',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.wasm': 'application/wasm',
    }

    def end_headers(self):
        if self.cache:
            self.send_header('Cache-Control', 'public, max-age=3600')
        else:
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
        super().end_headers()

    def send_head(self):
        if not self.cache:
            # Drop conditional headers so we never answer 304 Not Modified from
            # a stale validator the browser held on to.
            for header in ('If-Modified-Since', 'If-None-Match'):
                if header in self.headers:
                    del self.headers[header]
        return super().send_head()

    def log_message(self, fmt, *args):
        # One tidy line per request, and skip the successful ones — the noise
        # buries the errors that actually matter.
        status = args[1] if len(args) > 1 else ''
        if status.startswith('2') or status.startswith('3'):
            return
        sys.stderr.write('%s %s\n' % (self.address_string(), fmt % args))


def main():
    parser = argparse.ArgumentParser(
        description='Serve Blockdrive locally. Caching is off by default so edits always show up.')
    parser.add_argument('-p', '--port', type=int, default=int(os.environ.get('PORT', 8123)))
    parser.add_argument('--host', default='127.0.0.1',
                        help='bind address (default 127.0.0.1; use 0.0.0.0 for other devices)')
    parser.add_argument('--play', action='store_true',
                        help='let the browser cache files; use when playing rather than editing')
    args = parser.parse_args()

    DevHandler.cache = args.play

    handler = functools.partial(DevHandler, directory=ROOT)
    try:
        server = ThreadingHTTPServer((args.host, args.port), handler)
    except OSError as e:
        if e.errno in (48, 98):   # EADDRINUSE on macOS / Linux
            sys.exit(f'Port {args.port} is already in use. Try: ./serve.py -p {args.port + 1}')
        raise

    shown = 'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host
    mode = 'caching on' if args.play else 'caching off, edits always fresh'
    print(f'Blockdrive on http://{shown}:{args.port}  ({mode}, Ctrl+C to stop)')
    if args.host == '0.0.0.0':
        try:
            lan = socket.gethostbyname(socket.gethostname())
            print(f'On your network: http://{lan}:{args.port}')
        except OSError:
            pass

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nstopped')
        server.server_close()


if __name__ == '__main__':
    main()
