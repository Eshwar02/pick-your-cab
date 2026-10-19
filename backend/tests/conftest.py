import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import requests


_database = tempfile.NamedTemporaryFile(prefix="zoomo-tests-", suffix=".db", delete=False)
_database.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_database.name}"
os.environ["SUPABASE_DATABASE_URL"] = ""
os.environ["TOKEN_SECRET"] = "test-only-secret-that-is-not-used-in-production"
os.environ["APP_ENV"] = "test"
os.environ["STRIPE_SECRET_KEY"] = ""
os.environ["STRIPE_WEBHOOK_SECRET"] = "whsec_test"


class MockRouteHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        payload = {
            "routes": [
                {
                    "distance": 5000,
                    "duration": 900,
                    "geometry": {"coordinates": [[77.5946, 12.9716], [77.6046, 12.9816]]},
                }
            ]
        }
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


@pytest.fixture(scope="session")
def api_base_url():
    route_server = ThreadingHTTPServer(("127.0.0.1", 0), MockRouteHandler)
    route_thread = threading.Thread(target=route_server.serve_forever, daemon=True)
    route_thread.start()
    os.environ["OSRM_URL"] = f"http://127.0.0.1:{route_server.server_port}"

    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    env = os.environ.copy()
    env["OSRM_URL"] = os.environ["OSRM_URL"]
    server = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    base_url = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if server.poll() is not None:
            raise RuntimeError(f"Test API server exited before becoming healthy: {server.stderr.read()}")
        try:
            if requests.get(f"{base_url}/api/health", timeout=0.5).status_code == 200:
                break
        except requests.RequestException:
            time.sleep(0.1)
    else:
        server.terminate()
        raise RuntimeError("Test API server did not become healthy")
    yield base_url
    server.terminate()
    try:
        server.wait(timeout=5)
    except subprocess.TimeoutExpired:
        server.kill()
    route_server.shutdown()
    route_server.server_close()


@pytest.fixture
def client(api_base_url):
    class LocalClient:
        def get(self, url, **kwargs):
            return requests.get(f"{api_base_url}{url}", **kwargs)

        def post(self, url, **kwargs):
            return requests.post(f"{api_base_url}{url}", **kwargs)

        def patch(self, url, **kwargs):
            return requests.patch(f"{api_base_url}{url}", **kwargs)

    return LocalClient()
