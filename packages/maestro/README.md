# Limrun Maestro

Limrun integration helpers for running upstream Maestro against Limrun remote
iOS simulators.

This package owns the Limrun-specific lifecycle around Maestro:

- installing the Limrun-compatible Maestro XCTest runner from Limrun App Store,
- launching the runner with the expected simulator environment,
- proxying Maestro's local driver port to the remote runner,
- providing a scoped `xcrun` shim only to the spawned Maestro process.

The package intentionally runs the upstream `maestro` binary. Flow YAML and
Maestro assertions stay unchanged.

For a runnable Expo Go example, see `examples/maestro-ios` in the
`limrun-inc/typescript-sdk` repository.

## Runner Asset Contract

By default the package derives the runner asset from the installed Maestro CLI
version:

```text
appstore/maestro-ios-runner-<maestro-version>.tar.gz
```

The runner is installed without launch mode, then launched after the package
sets `PORT=22087` in the simulator environment. Supported Limrun images provide
`USE_IP`; the patched runner reads `USE_IP` and `PORT`, then the package verifies
`/status` through Limrun `targetHttpPort`.

For local/example validation before the public App Store asset exists, the
package bundles the matching runner archive and idempotently seeds a regular
organization asset with the same name minus the reserved prefix, for example
`maestro-ios-runner-2.5.1.tar.gz`.

## v1 Caveats

The local `xcrun` shim is scoped to the spawned Maestro process and supports the
commands needed for normal iOS flows: device discovery, app listing, local `.app`
installation via `syncApp`, `openurl`, `launch`, `terminate`, `uninstall`,
`privacy`, `location`, `status_bar`, and `spawn`.

Commands that require local simulator filesystem paths or special media handling
are intentionally rejected in v1, including `get_app_container`, `keychain`,
`io recordVideo`, `push`, and `addmedia`.
