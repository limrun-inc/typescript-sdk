# Credits

The photoreal 3D device models used by the `RemoteControl` 3D view
(`view="3d"`) are third-party assets from [Sketchfab](https://sketchfab.com/),
each licensed under
[Creative Commons Attribution 4.0 (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).
They are **not** covered by this package's own license — reuse them under
their CC BY 4.0 terms. Author, license, and source are also embedded in each
model file's glTF `asset.extras` metadata.

| File                                             | Model                         | Author                                      | License                                                   | Source                                                                                                      |
| ------------------------------------------------ | ----------------------------- | ------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/assets/models/iphone-15-pro-max.glb.b64.ts` | Apple iPhone 15 Pro Max Black | [polyman](https://sketchfab.com/Polyman_3D) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | [Sketchfab](https://sketchfab.com/3d-models/apple-iphone-15-pro-max-black-df17520841214c1792fb8a44c6783ee7) |
| `src/assets/models/apple-watch-s5.glb.b64.ts`    | Apple watch series 5          | [atomle](https://sketchfab.com/atomle)      | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | [Sketchfab](https://sketchfab.com/3d-models/apple-watch-series-5-16950208bdf041f193c31d3b4a0ac15a)          |

The models were optimized for the web with
[gltf-transform](https://gltf-transform.dev/) (meshopt compression, WebP
textures) and re-encoded by `scripts/encode-model-assets.mjs`; the glTF
`asset.extras` attribution metadata is preserved through that pipeline.

These models are fan-made visualizations and are not official Apple assets.
"iPhone" and "Apple Watch" are trademarks of Apple Inc. This project is not
affiliated with or endorsed by Apple Inc.
