from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Literal, TypedDict
from urllib.parse import quote

from limrun_api import AsyncLimrun
from limrun_api.types import AndroidInstance

from ._connection import DeviceConnection, check_quality, managed_instance

ScrollDirection = Literal["up", "down", "left", "right"]


class AndroidSelector(TypedDict, total=False):
    resourceId: str
    text: str
    contentDesc: str
    className: str
    packageName: str
    index: int
    clickable: bool
    enabled: bool
    focused: bool
    boundsContains: dict[str, float]


class AndroidElementTarget(TypedDict, total=False):
    """An element by `selector`, or a point by `x` and `y`."""

    selector: AndroidSelector
    x: float
    y: float


class AndroidClient(DeviceConnection):
    """Controls an Android emulator over its `apiUrl`. Use `async with AndroidClient(api_url, token) as android:`."""

    def __init__(self, api_url: str, token: str) -> None:
        super().__init__(api_url, token, "/ws")

    def _encode(self, type: str, id: str, params: dict[str, Any]) -> dict[str, Any]:
        # The server reads parameters from the top level or from `payload`; send both, like the TypeScript client.
        return {"type": type, "id": id, **params, "payload": params} if params else {"type": type, "id": id}

    def _error(self, message: dict[str, Any]) -> str | None:
        if isinstance(message.get("message"), str):
            return message["message"]
        return super()._error(message)

    async def _call(self, type: str, params: dict[str, Any] | None = None, timeout: float = 30) -> dict[str, Any]:
        m = await self._request(type, params, timeout)
        return m["payload"] if m.get("payload") is not None else m

    async def screenshot(self) -> dict[str, str]:
        """Returns `{"dataUri": "data:image/...;base64,..."}`."""
        p = await self._call("screenshot")
        if not p.get("dataUri"):
            raise ValueError("Received screenshotResult without payload.dataUri")
        return {"dataUri": p["dataUri"]}

    async def get_element_tree(self, wait_for_idle_timeout_ms: int | None = None) -> dict[str, Any]:
        """UIAutomator hierarchy as `{"xml": str, "nodes": [...]}`."""
        p = await self._call(
            "getElementTree",
            {"waitForIdleTimeoutMs": wait_for_idle_timeout_ms},
            30 + (wait_for_idle_timeout_ms or 0) / 1000,
        )
        return {"xml": p.get("xml") or "", "nodes": p.get("nodes") or []}

    async def find_element(self, selector: AndroidSelector, limit: int = 20) -> dict[str, Any]:
        p = await self._call("findElement", {"selector": selector, "limit": limit})
        elements = p.get("elements") or []
        return {"elements": elements, "count": p.get("count", len(elements))}

    async def tap(self, target: AndroidElementTarget) -> dict[str, float]:
        p = await self._call("tap", dict(target))
        return {"x": p.get("x", 0), "y": p.get("y", 0)}

    async def set_text(self, target: AndroidElementTarget | None, text: str) -> dict[str, int]:
        """Sets text on the target, or on the focused input when `target` is None."""
        p = await self._call("setText", {**(target or {}), "text": text})
        return {"textLength": p.get("textLength", len(text))}

    async def press_key(self, key: str, modifiers: list[str] | None = None) -> dict[str, str]:
        """`key` is a name like `BACK` or `ENTER`, a constant like `KEYCODE_TAB`, or a key code like `4`."""
        p = await self._call("pressKey", {"keyName": key, "modifiers": modifiers})
        return {"key": p.get("key", key)}

    async def scroll_screen(self, direction: ScrollDirection, amount: int = 6) -> dict[str, Any]:
        return await self._call("scrollScreen", {"direction": direction, "amount": amount})

    async def open_url(self, url: str) -> dict[str, str]:
        p = await self._call("openUrl", {"url": url})
        return {"url": p.get("url", url)}

    async def launch_app(
        self, package_name: str, mode: Literal["ForegroundIfRunning", "RelaunchIfRunning"] | None = None
    ) -> dict[str, str]:
        p = await self._call("launchApp", {"packageName": package_name, "mode": mode}, 60)
        return {"packageName": p.get("packageName", package_name)}

    async def terminate_app(self, package_name: str) -> None:
        await self._call("terminateApp", {"packageName": package_name})

    async def list_apps(self) -> list[dict[str, Any]]:
        p = await self._call("listApps")
        return p.get("apps") or []

    async def start_recording(self, quality: int | None = None) -> None:
        check_quality(quality)
        await self._call("startRecording", {"quality": quality})

    async def stop_recording(self, local_path: str | None = None, presigned_url: str | None = None) -> str:
        """Stops the recording. Returns a download URL that is valid while the instance runs."""
        upload = {"presignedUrl": presigned_url} if presigned_url else None
        await self._call("stopRecording", {"upload": upload})
        path = "/data/local/tmp/recordings/video_recording.mp4"
        url = f"{self.api_url}/files?path={quote(path, safe='')}"
        if local_path:
            await self._download(url, local_path)
        return url


@asynccontextmanager
async def android_instance(
    client: AsyncLimrun | None = None, **create_params: Any
) -> AsyncIterator[tuple[AndroidInstance, AndroidClient]]:
    """Creates an Android instance, connects to it, and deletes it on exit.

    `create_params` go to `client.android_instances.create()`. Without `client`, `AsyncLimrun()` reads `LIM_API_KEY`.
    """
    async with managed_instance("android", AndroidClient, client, create_params) as pair:
        yield pair
