from __future__ import annotations

import asyncio
import itertools
import json
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any, TypeVar
from urllib.parse import urlencode, urlsplit, urlunsplit

import httpx
from limrun_api import AsyncLimrun
from websockets.asyncio.client import ClientConnection, connect

_T = TypeVar("_T", bound="DeviceConnection")


class DeviceError(Exception):
    """The device server rejected a request."""


class DeviceConnection:
    """One WebSocket to an instance. Requests carry an `id`; the server replies with the same `id`."""

    def __init__(self, api_url: str, token: str, ws_path: str) -> None:
        self.api_url = api_url.rstrip("/")
        self.token = token
        parts = urlsplit(self.api_url)
        scheme = "wss" if parts.scheme == "https" else "ws"
        self._ws_url = urlunsplit((scheme, parts.netloc, parts.path + ws_path, urlencode({"token": token}), ""))
        self._ws: ClientConnection | None = None
        self._reader: asyncio.Task[None] | None = None
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._ids = itertools.count(1)

    async def connect(self: _T) -> _T:
        # ponytail: no reconnect; the TypeScript client retries up to 6 times. Add it when long sessions need it.
        # Screenshots and element trees exceed the 1 MiB default frame limit.
        self._ws = await connect(self._ws_url, max_size=None)
        self._reader = asyncio.create_task(self._read(self._ws))
        return self

    async def close(self) -> None:
        if self._ws is not None:
            await self._ws.close()
        if self._reader is not None:
            await self._reader

    async def __aenter__(self: _T) -> _T:
        return await self.connect()

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    def _encode(self, type: str, id: str, params: dict[str, Any]) -> dict[str, Any]:
        return {"type": type, "id": id, **params}

    def _error(self, message: dict[str, Any]) -> str | None:
        error = message.get("error")
        if isinstance(error, str):
            return error or None
        if isinstance(error, dict):
            return error.get("message") or error.get("code") or f"Server returned {message.get('type')} with an error"
        return None

    async def _request(self, type: str, params: dict[str, Any] | None = None, timeout: float = 30) -> dict[str, Any]:
        if self._ws is None:
            raise RuntimeError("Not connected. Use `async with` or call connect() first.")
        id = f"py-client-{next(self._ids)}"
        # Like JSON.stringify in the TypeScript client: unset options are left out of the message.
        compact = {k: v for k, v in (params or {}).items() if v is not None}
        future = asyncio.get_running_loop().create_future()
        self._pending[id] = future
        try:
            await self._ws.send(json.dumps(self._encode(type, id, compact)))
            return await asyncio.wait_for(future, timeout)
        except asyncio.TimeoutError:
            raise TimeoutError(f"Request {type} timed out") from None
        finally:
            self._pending.pop(id, None)

    async def _read(self, ws: ClientConnection) -> None:
        try:
            async for raw in ws:
                message = json.loads(raw)
                future = self._pending.get(message.get("id", ""))
                if future is None or future.done():
                    continue  # Notifications such as appExit, or a reply after its timeout.
                error = self._error(message)
                if error:
                    future.set_exception(DeviceError(error))
                else:
                    future.set_result(message)
        except Exception:
            pass  # The connection dropped; pending requests fail below.
        finally:
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(ConnectionError("WebSocket connection closed"))

    async def _download(self, url: str, local_path: str) -> None:
        async with httpx.AsyncClient(timeout=300) as http:
            async with http.stream("GET", url, headers={"Authorization": f"Bearer {self.token}"}) as response:
                response.raise_for_status()
                with open(local_path, "wb") as file:
                    async for chunk in response.aiter_bytes():
                        file.write(chunk)


def check_quality(quality: int | None) -> None:
    if quality is not None and quality not in range(5, 11):
        raise ValueError("quality must be one of: 5, 6, 7, 8, 9, 10")


@asynccontextmanager
async def managed_instance(
    kind: str, device_cls: Callable[[str, str], _T], client: AsyncLimrun | None, create_params: dict[str, Any]
) -> AsyncIterator[tuple[Any, _T]]:
    lim = client or AsyncLimrun()
    resource = getattr(lim, f"{kind}_instances")
    try:
        instance = await resource.create(wait=True, **create_params)
        try:
            if not instance.status.api_url:
                raise DeviceError(f"Instance {instance.metadata.id} has no apiUrl")
            async with device_cls(instance.status.api_url, instance.status.token) as device:
                yield instance, device
        finally:
            await resource.delete(instance.metadata.id)
    finally:
        if client is None:
            await lim.close()
