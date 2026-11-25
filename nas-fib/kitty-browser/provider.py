import itertools
import json
import os
import re
import signal
import socket
import stat
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from socketserver import UnixStreamServer
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from websockets.sync.client import connect


CDP = 'http://127.0.0.1:9222'
PORTAL = 'https://kitty.fo'
USER_AGENT = 'mihomo/1.19.33'
MAX_BYTES = 2 * 1024 * 1024
SUBSCRIPTION_HOSTS = frozenset(
    host.strip().lower()
    for host in os.getenv('KITTY_SUBSCRIPTION_HOSTS', 'm1.tohno-2.top').split(',')
    if host.strip()
)
DIRECT = build_opener(ProxyHandler({}))

PAGE_STATE = r"""
(() => {
  const state = {
    origin: location.origin,
    path: location.pathname.replace(/\/$/u, ''),
    timeOrigin: performance.timeOrigin,
    loaded: document.readyState === 'complete'
  };
  if (state.origin !== 'https://kitty.fo' || state.path !== '/dashboard') return state;
  const values = Array.from(document.querySelectorAll('body *'))
    .filter(element => element.getClientRects().length)
    .flatMap(element => [
      element.value,
      element.getAttribute('aria-valuetext'),
      element.tagName === 'A' && element.getAttribute('href'),
      element.childElementCount === 0 && element.textContent
    ])
    .filter(value => typeof value === 'string' && /^https:\/\/\S+$/u.test(value.trim()));
  return { ...state, values: [...new Set(values)] };
})()
"""


class ProviderError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class BrowserCommandError(Exception):
    pass


def allowed_subscription(value):
    if not isinstance(value, str) or not re.fullmatch(r'https://\S+', value):
        return False
    try:
        url = urlsplit(value)
        return (url.hostname in SUBSCRIPTION_HOSTS and url.port in (None, 443)
                and not url.username and not url.password and bool(url.path.strip('/')))
    except ValueError:
        return False


class ProviderRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not allowed_subscription(newurl) or urlsplit(req.full_url).hostname != urlsplit(newurl).hostname:
            raise ProviderError(502, 'Kitty returned an unexpected redirect')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def call(peer, request_id, method, params=None):
    peer.send(json.dumps({'id': request_id, 'method': method, 'params': params or {}}))
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        reply = json.loads(peer.recv(timeout=max(0.05, deadline - time.monotonic())))
        if reply.get('id') == request_id:
            if 'error' in reply:
                raise BrowserCommandError(method)
            return reply['result']
    raise BrowserCommandError(method)


def unique_subscription(values):
    matches = {value.strip() for value in values if isinstance(value, str)
               and allowed_subscription(value.strip())}
    if len(matches) > 1:
        raise ProviderError(502, 'Kitty dashboard exposed multiple subscription addresses')
    return next(iter(matches), None)


def read_subscription():
    with DIRECT.open(CDP + '/json/list', timeout=4) as response:
        tabs = [tab for tab in json.load(response) if tab.get('type') == 'page'
                and urlsplit(tab.get('url', '')).netloc == 'kitty.fo']
    dashboard = next((tab for tab in tabs if urlsplit(tab['url']).path.rstrip('/') == '/dashboard'), None)
    if dashboard is None:
        if any(urlsplit(tab['url']).path == '/login' for tab in tabs):
            raise ProviderError(401, 'Kitty sign-in is required')
        raise ProviderError(502, 'The Kitty browser dashboard is not open')

    calls = itertools.count(1)
    with connect(dashboard['webSocketDebuggerUrl'], open_timeout=4, close_timeout=2,
                 max_size=2 * 1024 * 1024) as page:
        previous = call(page, next(calls), 'Runtime.evaluate', {
            'expression': 'performance.timeOrigin', 'returnByValue': True
        })['result']['value']
        call(page, next(calls), 'Page.reload', {'ignoreCache': True})
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                result = call(page, next(calls), 'Runtime.evaluate', {
                    'expression': PAGE_STATE, 'returnByValue': True
                })['result'].get('value', {})
            except BrowserCommandError:
                time.sleep(0.25)
                continue
            if result.get('timeOrigin') != previous and result.get('origin') == PORTAL:
                if result.get('path') == '/login' and result.get('loaded'):
                    raise ProviderError(401, 'Kitty sign-in is required')
                if result.get('path') == '/dashboard':
                    url = unique_subscription(result.get('values', []))
                    if url is None:
                        tree = call(page, next(calls), 'Accessibility.getFullAXTree')
                        url = unique_subscription(
                            node.get(field, {}).get('value') for node in tree.get('nodes', [])
                            if not node.get('ignored') for field in ('name', 'value')
                        )
                    if url:
                        return url
            time.sleep(0.35)
    raise ProviderError(502, 'Kitty dashboard did not return a subscription address')


def download_subscription():
    url = read_subscription()
    opener = build_opener(ProxyHandler({}), ProviderRedirect())
    request = Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'application/yaml,text/yaml,text/plain,*/*'})
    try:
        with opener.open(request, timeout=12) as response:
            body = response.read(MAX_BYTES + 1)
            usage = response.headers.get('Subscription-Userinfo', '')
    except HTTPError as error:
        raise ProviderError(502, f'Kitty subscription endpoint returned HTTP {error.code}') from None
    if not body or len(body) > MAX_BYTES:
        raise ProviderError(502, 'Kitty returned an empty or oversized subscription')
    return body, usage if re.fullmatch(r'[a-zA-Z0-9=; ]{1,256}', usage) else None


class ProviderHandler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, _format, *args):
        pass

    def do_GET(self):
        if self.path != '/subscription':
            self.send_error(404)
            return
        try:
            body, usage = download_subscription()
        except ProviderError as error:
            self.send_error(error.status, str(error))
            return
        except Exception:
            self.send_error(502, 'Kitty browser or subscription request unavailable')
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/yaml; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        if usage:
            self.send_header('Subscription-Userinfo', usage)
        self.end_headers()
        self.wfile.write(body)


def remove_stale_socket(path):
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(mode):
        raise RuntimeError('Kitty provider path is not a socket')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
        probe.settimeout(1)
        try:
            probe.connect(str(path))
        except ConnectionRefusedError:
            path.unlink()
            return
    raise RuntimeError('Kitty provider socket is already in use')


def stop(_signum, _frame):
    raise SystemExit(0)


def main():
    path = Path(os.environ.get('KITTY_SOCKET_PATH', '/run/kitty/subscription.sock'))
    os.umask(0o077)
    remove_stale_socket(path)
    signal.signal(signal.SIGTERM, stop)
    with UnixStreamServer(str(path), ProviderHandler) as server:
        path.chmod(0o600)
        try:
            server.serve_forever()
        finally:
            path.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
