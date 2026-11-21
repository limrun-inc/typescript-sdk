import asyncio
import json

import pytest
from websockets.asyncio.server import serve

from limrun import AndroidClient, DeviceError, IosClient


@pytest.fixture
async def server():
    """A fake instance server. Set `state["handle"]` to a function `(requests) -> replies` that runs on each request."""
    state = {"requests": [], "paths": [], "handle": lambda requests: []}

    async def handler(ws):
        state["paths"].append(ws.request.path)
        async for raw in ws:
            state["requests"].append(json.loads(raw))
            for reply in state["handle"](state["requests"]):
                if reply == "close":
                    await ws.close()
                    return
                await ws.send(json.dumps(reply))

    async with serve(handler, "127.0.0.1", 0) as srv:
        state["url"] = f"http://127.0.0.1:{srv.sockets[0].getsockname()[1]}"
        yield state


def without_ids(requests):
    return [{k: v for k, v in r.items() if k != "id"} for r in requests]


async def test_ios_encodes_requests_and_parses_element_tree(server):
    tree = [{"type": "Button", "AXLabel": "Sign in", "frame": {"x": 1, "y": 2, "width": 3, "height": 4}}]

    def handle(requests):
        r = requests[-1]
        if r["type"] == "elementTree":
            return [{"type": "elementTreeResult", "id": r["id"], "json": json.dumps(tree)}]
        return [{"type": f"{r['type']}Result", "id": r["id"]}]

    server["handle"] = handle
    async with IosClient(server["url"], "tok/en") as ios:
        assert await ios.element_tree() == tree
        await ios.type_text("hi", require_focus=False)
        await ios.type_text("hi")

    assert server["paths"] == ["/signaling?token=tok%2Fen"]
    # Unset options are left out; requireFocus is sent only when False.
    assert without_ids(server["requests"]) == [
        {"type": "elementTree"},
        {"type": "typeText", "text": "hi", "requireFocus": False},
        {"type": "typeText", "text": "hi"},
    ]


async def test_android_sends_payload_and_unwraps_result(server):
    def handle(requests):
        r = requests[-1]
        if r["type"] == "screenshot":
            return [{"type": "screenshotResult", "id": r["id"], "payload": {"dataUri": "data:image/png;base64,AA"}}]
        return [{"type": "pressKeyResult", "id": r["id"], "error": {"code": "UNKNOWN_KEY"}}]

    server["handle"] = handle
    async with AndroidClient(server["url"] + "/", "t") as android:
        assert await android.screenshot() == {"dataUri": "data:image/png;base64,AA"}
        with pytest.raises(DeviceError, match="UNKNOWN_KEY"):
            await android.press_key("NOPE")

    assert server["paths"] == ["/ws?token=t"]
    assert without_ids(server["requests"]) == [
        {"type": "screenshot"},
        {"type": "pressKey", "keyName": "NOPE", "payload": {"keyName": "NOPE"}},
    ]


async def test_ios_server_error_raises(server):
    server["handle"] = lambda rs: [{"type": "tapElementResult", "id": rs[-1]["id"], "error": "matched nothing"}]
    async with IosClient(server["url"], "t") as ios:
        with pytest.raises(DeviceError, match="matched nothing"):
            await ios.tap_element({"AXLabel": "Missing"})


async def test_replies_out_of_order_reach_their_request(server):
    def handle(requests):
        if len(requests) < 2:
            return []
        return [{"type": "openUrlResult", "id": r["id"], "payload": {"url": r["url"]}} for r in reversed(requests)]

    server["handle"] = handle
    async with AndroidClient(server["url"], "t") as android:
        results = await asyncio.gather(android.open_url("a://1"), android.open_url("b://2"))
    assert results == [{"url": "a://1"}, {"url": "b://2"}]


async def test_closed_connection_fails_pending_request(server):
    server["handle"] = lambda requests: ["close"]
    async with IosClient(server["url"], "t") as ios:
        with pytest.raises(ConnectionError):
            await ios.tap(1, 2)
