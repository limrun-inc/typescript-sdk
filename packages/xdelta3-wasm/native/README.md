# xdelta Submodule

The upstream xdelta repository is checked out at `native/xdelta` as a git
submodule.

- Upstream: https://github.com/jmacd/xdelta
- Branch: `release3_1_apl`
- Commit: `7508fd2a823443b1f0173ca361620f21d62a7d37`
- Local changes: none

The `release3_1_apl` branch is the Apache-2.0 relicensed xdelta3 line. It
matches the branch used by Limdroid's on-device xdelta3 build.

## Checkout

After cloning the SDK repository, initialize the submodule:

```sh
git submodule update --init --recursive
```

## Update Procedure

1. Fetch upstream in `native/xdelta`.
2. Check out the desired upstream commit.
3. Update this file with the new commit and any branch/provenance changes.
4. Rebuild `@limrun/xdelta3-wasm` with `npm run build:wasm`.
5. Commit the updated submodule gitlink and this provenance file.
