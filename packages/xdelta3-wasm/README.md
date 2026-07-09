# @limrun/xdelta3-wasm

Streaming xdelta3/VCDIFF encoder backed by WebAssembly.

This package wraps upstream xdelta3's streaming encoder API rather than the
one-shot `xd3_encode_memory` helper, so callers can encode large files without
copying the whole source, target, and maximum patch output into WASM memory.

## API

```ts
import { encode } from '@limrun/xdelta3-wasm';

const source = {
  size,
  async read(offset: number, into: Uint8Array) {
    // Fill `into` with bytes from source at offset.
    return bytesRead;
  },
};

for await (const chunk of encode(targetChunks, source)) {
  // Write patch chunk.
}
```

The output is a plain VCDIFF stream accepted by `xdelta3 -d`.

## Build

From a fresh checkout of `typescript-sdk`, install JavaScript dependencies and
initialize the upstream xdelta submodule:

```sh
yarn install
git submodule update --init --recursive packages/xdelta3-wasm/native/xdelta
```

Install and activate Emscripten before rebuilding the WASM module. One local
setup option is:

```sh
git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
~/emsdk/emsdk install latest
~/emsdk/emsdk activate latest
source ~/emsdk/emsdk_env.sh
```

If Emscripten is installed elsewhere, either make `emcc` available on `PATH` or
set `EMCC=/path/to/emcc`.

Then build the package:

```sh
cd packages/xdelta3-wasm
npm run build:wasm
```

`build:wasm` compiles `native/xdelta/xdelta3/xdelta3.c` and `native/xd3w.c`
into `native/build/xdelta3-stream.wasm`, embeds that WASM into
`src/wasm-embedded.ts`, and runs `tsc` to produce `dist/`. The
`native/build/` directory is generated and ignored; `src/wasm-embedded.ts` is
the source file consumed by the TypeScript package.

For a TypeScript-only rebuild that uses the already embedded WASM, run:

```sh
npm run build
```

## xdelta submodule

The upstream xdelta repository is checked out as a git submodule under
`native/xdelta` for maintainable rebuilds without copying upstream source into
this repository.

After cloning the SDK, initialize submodules before rebuilding the WASM module:

```sh
git submodule update --init --recursive
```

See `native/README.md` for the upstream URL, branch, commit, and
update procedure.
