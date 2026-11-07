# Vendored js-srp

Source: `@foxt/js-srp@0.0.3-patch2`, published from
https://github.com/foxt/js-srp-gsa. The upstream ISC license is in `LICENSE`
and is included in the published package's `THIRD_PARTY_NOTICES`.

The npm tarball integrity is
`sha512-mCjMIf+/mwmuzSGr8CWWQDjDUqMBnw9TBnzfcBUTR2ySPoXcg6Pfb4/WPklY1TwY3Pe3f3r8q6hzWvvogInuug==`.

SHA-256 of the original source files before local changes:

- `src/index.ts`: `907950a434f359d31d5ccc8874290fb34a018754a6aff9808590f70cd6e046ea`
- `src/srp.ts`: `cd7d9ab073034aeabc96670746526883b02f5f2b992c89f61e2c424222de68b6`
- `src/util.ts`: `1fa5c3e62218967309c49f1db6b2027f5a6d7c35a7cbefbf76d58988f4ad73fb`

Local changes:

- Route hashing and randomness through `runtimeCrypto` so browsers and Node
  use their own Web Crypto implementation without changing globals.
- Make the internal random-byte helper asynchronous and await its two callers.
- Accept typed-array hash inputs and copy them to an ArrayBuffer for current
  TypeScript DOM declarations. Use the same conversion for hash interleaving.
- Apply repository formatting and use local extensionless imports.
- Mark the license comment for preservation in built bundles.

The SRP algorithms, GSA behavior, and prime groups are unchanged.
`gsa-vectors.json` records deterministic output from the original npm package's
Node entry point before removing the dependency. The inputs are synthetic.
