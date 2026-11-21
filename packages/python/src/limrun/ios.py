from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Literal, TypedDict
from urllib.parse import quote

from limrun_api import AsyncLimrun
from limrun_api.types import IosInstance

from ._connection import DeviceConnection, check_quality, managed_instance

TAP_ELEMENT_TIMEOUT_MS = 90_000


class AccessibilitySelector(TypedDict, total=False):
    """All given fields must match. Exact match unless the name ends in `Contains`."""

    AXUniqueId: str
    AXLabel: str
    AXLabelContains: str
    type: str
    title: str
    titleContains: str
    AXValue: str


class ScreenshotData(TypedDict):
    base64: str
    width: int
    height: int


class IosClient(DeviceConnection):
    """Controls an iOS simulator over its `apiUrl`. Use `async with IosClient(api_url, token) as ios:`."""

    def __init__(self, api_url: str, token: str) -> None:
        super().__init__(api_url, token, "/signaling")

    async def screenshot(
        self, format: Literal["jpeg", "png"] | None = None, size: Literal["scaled", "full"] | None = None
    ) -> ScreenshotData:
        m = await self._request("screenshot", {"format": format, "size": size})
        return {"base64": m["base64"], "width": m["width"], "height": m["height"]}

    async def element_tree(self, point: dict[str, float] | None = None) -> list[dict[str, Any]]:
        """Accessibility tree. `point={"x": .., "y": ..}` returns the element at that point."""
        m = await self._request("elementTree", {"point": point})
        return json.loads(m.get("json") or "[]")

    async def tap(self, x: float, y: float) -> None:
        await self._request("tap", {"x": x, "y": y})

    async def tap_element(
        self,
        selector: AccessibilitySelector,
        activate: Literal["touch", "ax"] | None = None,
        timeout_ms: int = TAP_ELEMENT_TIMEOUT_MS,
    ) -> dict[str, Any]:
        m = await self._request("tapElement", {"selector": selector, "activate": activate}, timeout_ms / 1000)
        return {k: m[k] for k in ("elementLabel", "elementType", "method") if k in m}

    async def type_text(self, text: str, press_enter: bool | None = None, require_focus: bool = True) -> None:
        # requireFocus is sent only when False, as in the TypeScript client.
        await self._request(
            "typeText", {"text": text, "pressEnter": press_enter, "requireFocus": False if not require_focus else None}
        )

    async def press_key(self, key: str, modifiers: list[str] | None = None) -> None:
        await self._request("pressKey", {"key": key, "modifiers": modifiers})

    async def scroll(
        self,
        direction: Literal["up", "down", "left", "right"],
        pixels: float,
        coordinate: tuple[float, float] | None = None,
        momentum: float | None = None,
    ) -> None:
        await self._request(
            "scroll", {"direction": direction, "pixels": pixels, "coordinate": coordinate, "momentum": momentum}
        )

    async def open_url(self, url: str) -> None:
        await self._request("openUrl", {"url": url})

    async def list_apps(self) -> list[dict[str, Any]]:
        m = await self._request("listApps")
        return json.loads(m.get("apps") or "[]")

    async def launch_app(
        self,
        bundle_id: str,
        mode: Literal["ForegroundIfRunning", "RelaunchIfRunning"] | None = None,
        env: dict[str, str] | None = None,
    ) -> None:
        # An environment only applies to a new process, so it implies a relaunch.
        if mode is None and env:
            mode = "RelaunchIfRunning"
        await self._request("launchApp", {"bundleId": bundle_id, "mode": mode, "env": env})

    async def terminate_app(self, bundle_id: str) -> None:
        await self._request("terminateApp", {"bundleId": bundle_id})

    async def app_log_tail(self, bundle_id: str, lines: int) -> str:
        m = await self._request("appLogTail", {"bundleId": bundle_id, "lines": lines})
        return m.get("logs") or ""

    async def start_recording(self, quality: int | None = None) -> None:
        check_quality(quality)
        await self._request("startVideoRecording", {"quality": quality})

    async def stop_recording(self, local_path: str | None = None, presigned_url: str | None = None) -> str:
        """Stops the recording. Returns a download URL that is valid while the instance runs."""
        upload = {"presignedUrl": presigned_url} if presigned_url else None
        await self._request("stopVideoRecording", {"upload": upload})
        url = f"{self.api_url}/files?name={quote('recording.mp4', safe='')}"
        if local_path:
            await self._download(url, local_path)
        return url


@asynccontextmanager
async def ios_instance(
    client: AsyncLimrun | None = None, **create_params: Any
) -> AsyncIterator[tuple[IosInstance, IosClient]]:
    """Creates an iOS instance, connects to it, and deletes it on exit.

    `create_params` go to `client.ios_instances.create()`. Without `client`, `AsyncLimrun()` reads `LIM_API_KEY`.
    """
    async with managed_instance("ios", IosClient, client, create_params) as pair:
        yield pair
