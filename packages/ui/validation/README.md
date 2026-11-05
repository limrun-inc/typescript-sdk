# Customer rendering regression checks

These checks render the production Duo components with deterministic video sources in Chromium. They need no customer account, application, or recording.

From `packages/ui`, install dependencies and Chromium, then run:

```sh
yarn install
yarn playwright install chromium
DUO_MODEL=/absolute/path/to/limrun/console/src/assets/duo-star-white.glb yarn test:visual
```

`DUO_MODEL` is optional; omitting it tests the procedural appearance only. Results and screenshots go to `validation-output/` in the current directory; set `VALIDATION_OUTPUT` to choose another location. Do not commit generated results or instance credentials.

The hinge check uses real MSAA rendering across four pixel ratios, five viewports, and four oblique camera angles. It compares the screen against a render without the chassis, excluding silhouette antialiasing. A darkening above 12/255 fails. The pre-fix procedural model failed 50 of 80 cases on SwiftShader; the supplied GLB passed its 80 cases. Imported bezel material settings also have unit coverage.

Sizing compares visible video bounds before and after switching from 2D to 3D, with a two-pixel rasterization tolerance. It waits for camera settlement and covers both fold endpoints in portrait and landscape. Motion checks exercise both fold directions and verify that live video returns after the animation.

The default ANGLE backend is `swiftshader`, which reproduced the hinge defect independently of physical GPU hardware. On macOS, repeat with `VALIDATION_ANGLE=metal`. Use `VALIDATION_PHASE=hinge`, `sizing`, or `motion` to isolate a check. `VALIDATION_ORIENTATIONS=portrait,pud,landscape-left,landscape-right` expands the orientation matrix.

For an optional live iPhone 16 Pro receiver check, create a disposable simulator using the authenticated Limrun CLI and save its JSON response outside the repository. Then run:

```sh
VALIDATION_INSTANCE=/absolute/path/to/private-instance.json yarn test:stream-ratio
```

This rotates that simulator and records received WebRTC dimensions. It requires a deployed server containing the stream fix to validate that fix. The native adapter regression lives in the server repository's `StreamingGeometryTests.swift`; the browser check alone does not prove that every encoder or adaptive quality level preserves the ratio.
