# limrun

Control [Limrun](https://limrun.com) iOS simulators and Android emulators from Python: tap, type, screenshots, element trees, app logs, and recordings.

This package adds device control on top of [`limrun-api`](https://pypi.org/project/limrun-api/), the REST client that creates, lists, and deletes instances.

```sh
pip install limrun
```

## Example

```python
import asyncio
import base64
from pathlib import Path

from limrun import ios_instance


async def main():
    # Creates a simulator, connects to it, and deletes it on exit. Reads LIM_API_KEY.
    async with ios_instance() as (instance, ios):
        await ios.launch_app("com.apple.Preferences")
        await ios.tap_element({"AXLabel": "General"})
        tree = await ios.element_tree()
        shot = await ios.screenshot()
        Path("screen.jpg").write_bytes(base64.b64decode(shot["base64"]))


asyncio.run(main())
```

Use `android_instance()` and `AndroidClient` the same way for Android. Arguments to `ios_instance()` and `android_instance()` go to `ios_instances.create()` and `android_instances.create()` in `limrun-api`.

To connect to an instance that you manage yourself:

```python
from limrun import IosClient
from limrun_api import AsyncLimrun

instance = await AsyncLimrun().ios_instances.get("ios_...")
async with IosClient(instance.status.api_url, instance.status.token) as ios:
    await ios.tap(100, 200)
```

## Methods

The methods use the names and parameters of the TypeScript `@limrun/api` client, in snake_case. All methods are async.

| `IosClient`                                                 | `AndroidClient`                                       |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| `screenshot(format=None, size=None)`                        | `screenshot()`                                        |
| `element_tree(point=None)`                                  | `get_element_tree(wait_for_idle_timeout_ms=None)`     |
| `tap(x, y)`                                                 | `tap({"x": .., "y": ..} or {"selector": {...}})`      |
| `tap_element(selector, activate=None, timeout_ms=...)`      | `find_element(selector, limit=20)`                    |
| `type_text(text, press_enter=None, require_focus=True)`     | `set_text(target, text)`                              |
| `press_key(key, modifiers=None)`                            | `press_key(key, modifiers=None)`                      |
| `scroll(direction, pixels, coordinate=None, momentum=None)` | `scroll_screen(direction, amount=6)`                  |
| `open_url(url)`                                             | `open_url(url)`                                       |
| `list_apps()`                                               | `list_apps()`                                         |
| `launch_app(bundle_id, mode=None, env=None)`                | `launch_app(package_name, mode=None)`                 |
| `terminate_app(bundle_id)`                                  | `terminate_app(package_name)`                         |
| `app_log_tail(bundle_id, lines)`                            |                                                       |
| `start_recording(quality=None)`                             | `start_recording(quality=None)`                       |
| `stop_recording(local_path=None, presigned_url=None)`       | `stop_recording(local_path=None, presigned_url=None)` |

A request that the device rejects raises `limrun.DeviceError`.

## Development

```sh
uv sync
uv run pytest
uv run ruff check . && uv run ruff format --check .
```
