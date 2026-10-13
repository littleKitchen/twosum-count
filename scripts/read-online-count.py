#!/usr/bin/env python3
"""Read one fresh LeetCode Two Sum online count in GitHub Actions.

The documented curl_cffi `impersonate="chrome"` option selects its
Chrome-compatible TLS transport. Browser identity headers are disabled; the
request identifies this collector honestly. No credentials, imported cookies,
challenge handling, redirects, proxies, or retries are used.

Docs: https://curl-cffi.readthedocs.io/en/latest/websockets.html
Dependency: curl_cffi==0.16.3 (Python >=3.10).
The release's async API supports bounded receives and message-size limits;
its synchronous API does not support those options.
"""

import asyncio
from datetime import datetime, timezone
import json
import os
import re
import sys
import time


ENDPOINT = "wss://collaboration-ws.leetcode.com/problems/two-sum"
SOURCE = "https://leetcode.com/problems/two-sum/description/"
MAX_SAFE_INTEGER = 9007199254740991


def parse_count(payload):
    """Accept only the exact numeric text protocol, never HTML or JSON bodies."""
    if isinstance(payload, bytes):
        try:
            payload = payload.decode("ascii")
        except UnicodeDecodeError:
            return None
    if not isinstance(payload, str) or not re.fullmatch(r"[0-9]{1,16}", payload):
        return None
    count = int(payload)
    return count if 0 <= count <= MAX_SAFE_INTEGER else None


def safe_failure(error):
    """Retain fixed error categories and numeric codes, never error contents."""
    known_types = {
        "TimeoutError", "WebSocketTimeout", "WebSocketClosed", "WebSocketError",
        "CurlError", "RequestException", "RequestsError", "SSLError",
        "ConnectionError", "HTTPError", "TypeError", "ModuleNotFoundError",
        "ImportError", "RuntimeError",
    }
    error_type = type(error).__name__
    result = {"error": error_type if error_type in known_types else "ProbeError"}
    response = getattr(error, "response", None)
    status = getattr(response, "status_code", None)
    if not isinstance(status, int) or not 100 <= status <= 599:
        # libcurl may expose a refused upgrade status only in its fixed error
        # message. Extract that number and discard the entire original text.
        match = re.search(
            r"(?:HTTP(?: response)?(?: code| status)?[: ]+|"
            r"Unexpected response code[: ]+|Refused WebSockets? upgrade[: ]+)([1-5][0-9]{2})\b",
            str(error), re.IGNORECASE,
        )
        status = int(match.group(1)) if match else None
    result["httpStatus"] = status
    code = getattr(error, "code", None)
    result["transportCode"] = int(code) if isinstance(code, int) and 0 <= code <= 999 else None
    return result


async def read_count():
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("CloudOnly")

    # Import only after the guard; importing this file for offline parser checks
    # does not require the package and can never establish a source connection.
    from curl_cffi import AsyncSession, CurlOpt, CurlWsFlag, WebSocketRetryStrategy

    session = None
    socket = None
    deadline = time.monotonic() + 30.0
    try:
        session = AsyncSession(verify=True, trust_env=False, max_clients=1, retry=0)
        socket = await session.ws_connect(
            ENDPOINT,
            impersonate="chrome",
            default_headers=False,
            headers={
                "Origin": "https://leetcode.com",
                "User-Agent": "TwoSumHourly/1.0 (+https://github.com/littleKitchen/twosum-count)",
            },
            verify=True,
            allow_redirects=False,
            timeout=15.0,
            max_message_size=1024,
            ws_retry=WebSocketRetryStrategy(retry=False, count=0),
            # Explicitly disable libcurl's environment proxy lookup. In 0.16.3,
            # the WebSocket path does not apply the session's trust_env flag.
            curl_options={CurlOpt.PROXY: ""},
        )
        while time.monotonic() < deadline:
            payload, flags = await socket.recv(timeout=max(0.001, deadline - time.monotonic()))
            captured_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            if not flags & CurlWsFlag.TEXT:
                continue
            count = parse_count(payload)
            if count is not None:
                return {"count": count, "capturedAt": captured_at, "source": SOURCE}
        raise TimeoutError("No numeric counter frame received")
    finally:
        # Cleanup cannot replace a genuine measurement or the original failure.
        if socket is not None:
            try:
                await socket.close(code=4000, message=b"Hourly sample complete", timeout=1.0)
            except Exception:
                try:
                    socket.terminate()
                except Exception:
                    pass
        if session is not None:
            try:
                await asyncio.wait_for(session.close(), timeout=2.0)
            except Exception:
                pass


def main():
    if os.environ.get("GITHUB_ACTIONS") != "true":
        print(json.dumps({"error": "CloudOnly"}))
        return 1
    try:
        result = asyncio.run(read_count())
    except Exception as error:
        print(json.dumps(safe_failure(error), separators=(",", ":")))
        return 1
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
