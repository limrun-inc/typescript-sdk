# Changelog

## 0.11.0 (2025-10-29)

Full Changelog: [v0.10.0...v0.11.0](https://github.com/limrun-inc/typescript-sdk/compare/v0.10.0...v0.11.0)

### Features

* **api:** add explicit pagination fields ([0ef01e4](https://github.com/limrun-inc/typescript-sdk/commit/0ef01e41a5045b71803ce06344a5e523a143ec84))
* **api:** add os version clue ([5de52ba](https://github.com/limrun-inc/typescript-sdk/commit/5de52badad2747ea639059c9322578a61963fd53))
* **api:** limit pagination only to limit parameter temporarily ([22bb8df](https://github.com/limrun-inc/typescript-sdk/commit/22bb8dfcfd7f8b45ad486e6f40c867b356148f84))
* **api:** manual updates ([1c35996](https://github.com/limrun-inc/typescript-sdk/commit/1c359962d5e6f4e17405424e05ada2593acb88bf))
* **api:** manual updates ([adffa6b](https://github.com/limrun-inc/typescript-sdk/commit/adffa6b5e55140160f00526beac63f6beed1f909))
* **api:** os version description to show possible values ([c95641a](https://github.com/limrun-inc/typescript-sdk/commit/c95641af56f22bcde865e039bf42c33430cd2b05))
* **api:** osVersion clue is available only in Android yet ([d47a69e](https://github.com/limrun-inc/typescript-sdk/commit/d47a69e902a1aa15665babb30c0774f17cf53b7a))
* **api:** remaining pieces of pagionation removed temporarily ([37cf996](https://github.com/limrun-inc/typescript-sdk/commit/37cf99607223641ed256852547c6df160001205b))
* **api:** update assets and ios_instances endpoints with pagination ([e800d0b](https://github.com/limrun-inc/typescript-sdk/commit/e800d0b9ef46ca1b3831228eed4345172f2f6438))
* **api:** update stainless schema for pagination ([d931de9](https://github.com/limrun-inc/typescript-sdk/commit/d931de908d95d363b3ddaee65a1dcf7823926f59))

## 0.10.0 (2025-10-07)

Full Changelog: [v0.9.0...v0.10.0](https://github.com/limrun-inc/typescript-sdk/compare/v0.9.0...v0.10.0)

### Features

* **api:** add the new multiple apk installation options ([b1a4673](https://github.com/limrun-inc/typescript-sdk/commit/b1a4673f84bbc9ed4de55a8a458ad7ea9e9eda0e))
* **api:** mark public urls as required ([a92c622](https://github.com/limrun-inc/typescript-sdk/commit/a92c622bb1a0a1d929158dad399f1e5b6e04c734))
* **api:** revert api change ([67d8bac](https://github.com/limrun-inc/typescript-sdk/commit/67d8bac803a1dc79983e3a30e7c67aca00358098))


### Performance Improvements

* faster formatting ([e7a022f](https://github.com/limrun-inc/typescript-sdk/commit/e7a022fd1e84f3bf92b196d44164a6ee6a135a91))


### Chores

* do not install brew dependencies in ./scripts/bootstrap by default ([a543831](https://github.com/limrun-inc/typescript-sdk/commit/a543831fd8915896f3b6565864ba460003a65d9d))
* **internal:** codegen related update ([c5f3153](https://github.com/limrun-inc/typescript-sdk/commit/c5f3153c2c83b31f0aa26b491a461b60b4e73762))
* **internal:** fix incremental formatting in some cases ([0043015](https://github.com/limrun-inc/typescript-sdk/commit/00430153b9be1a8325e6cacfa9df044f5e46a129))
* **internal:** ignore .eslintcache ([4339876](https://github.com/limrun-inc/typescript-sdk/commit/433987662250c855eb8b9db9d2de5311ef3625d4))
* **internal:** remove .eslintcache ([97d80ff](https://github.com/limrun-inc/typescript-sdk/commit/97d80ff1fe59b16bbbf20b4be0398ad7a5b91c88))
* **internal:** remove deprecated `compilerOptions.baseUrl` from tsconfig.json ([55ca245](https://github.com/limrun-inc/typescript-sdk/commit/55ca2453910e5efb7852ca9fbe8db464bcf02797))
* **internal:** use npm pack for build uploads ([a081b33](https://github.com/limrun-inc/typescript-sdk/commit/a081b33aa80cf91addb1286d365955c3911020ec))
* **jsdoc:** fix [@link](https://github.com/link) annotations to refer only to parts of the package‘s public interface ([cb76432](https://github.com/limrun-inc/typescript-sdk/commit/cb764327f88eab2b87e0adf784e43df2461add02))

## 0.9.0 (2025-09-13)

Full Changelog: [v0.8.1...v0.9.0](https://github.com/limrun-inc/typescript-sdk/compare/v0.8.1...v0.9.0)

### Features

* **api:** manual updates ([36880d1](https://github.com/limrun-inc/typescript-sdk/commit/36880d1793fbb6de43013d2891c069aa941a0641))
* **api:** manual updates ([2b613d4](https://github.com/limrun-inc/typescript-sdk/commit/2b613d4fcafeb69a77b8ef5edbe0eafea96ad615))

## 0.8.1 (2025-09-11)

Full Changelog: [v0.8.0...v0.8.1](https://github.com/limrun-inc/typescript-sdk/compare/v0.8.0...v0.8.1)

### Features

* **api:** remove md5filter from list assets ([e34b33e](https://github.com/limrun-inc/typescript-sdk/commit/e34b33eb60bb37e557a4d898dfc073427fc8acd8))


### Chores

* **examples:** update to the latest @limrun/api ([4a24195](https://github.com/limrun-inc/typescript-sdk/commit/4a241955518cd9ae68bd9859e83958cb01447138))

## 0.8.0 (2025-09-09)

Full Changelog: [v0.7.0...v0.8.0](https://github.com/limrun-inc/typescript-sdk/compare/v0.7.0...v0.8.0)

### Bug Fixes

* coerce nullable values to undefined ([0b8c51a](https://github.com/limrun-inc/typescript-sdk/commit/0b8c51a581fe97fcc9c2cd7016a3cceee0700d67))


### Chores

* **api:** fix linter issues ([9b65c4f](https://github.com/limrun-inc/typescript-sdk/commit/9b65c4f773a08bd85f23fdcbf2c6e2ae727d7a08))
* **examples:** update to the latest @limrun/api ([a7e513e](https://github.com/limrun-inc/typescript-sdk/commit/a7e513e29c8948109dc0e2cb00d15a030e2cb7a3))
* **tests:** fix the import to be compatible ([40f7fab](https://github.com/limrun-inc/typescript-sdk/commit/40f7fabcf473c28b1a711a8ea524624a3a982e21))

## 0.7.0 (2025-09-08)

Full Changelog: [v0.6.2...v0.7.0](https://github.com/limrun-inc/typescript-sdk/compare/v0.6.2...v0.7.0)

### Features

* **api:** add helper for getOrCreate to use stable labels for creation ([67d5704](https://github.com/limrun-inc/typescript-sdk/commit/67d5704040efe16725e2ade021f03787c570a417))


### Chores

* **examples:** update to the latest @limrun/api ([dc06023](https://github.com/limrun-inc/typescript-sdk/commit/dc0602334afe8af257312ae5cfbd6a3710ec4872))

## 0.6.2 (2025-09-08)

Full Changelog: [v0.6.1...v0.6.2](https://github.com/limrun-inc/typescript-sdk/compare/v0.6.1...v0.6.2)

### Chores

* update SDK settings ([3073047](https://github.com/limrun-inc/typescript-sdk/commit/3073047142a387364e14634af10ebceb0fe6503e))

## 0.6.1 (2025-09-08)

Full Changelog: [v0.6.0...v0.6.1](https://github.com/limrun-inc/typescript-sdk/compare/v0.6.0...v0.6.1)

### Chores

* fix release-doctor ([9bc31f0](https://github.com/limrun-inc/typescript-sdk/commit/9bc31f06380c83f0acaf0fbd0d6a7924ec521b5b))

## 0.6.0 (2025-09-08)

Full Changelog: [v0.2.0...v0.6.0](https://github.com/limrun-inc/typescript-sdk/compare/v0.2.0...v0.6.0)

### Features

* **examples:** add tunnel example ([e174066](https://github.com/limrun-inc/typescript-sdk/commit/e174066fd66892daf58a9c9769ca41d7e3eb618f))
* **examples:** update frontend and backend to include scheduling clue ([178be4b](https://github.com/limrun-inc/typescript-sdk/commit/178be4b4e9f4e683977e17a53bb7668c0b96645f))
* **github:** add workflow to publish ui package ([e8ff97f](https://github.com/limrun-inc/typescript-sdk/commit/e8ff97fd4105a67a0e044520c062056a0939709f))


### Chores

* lint issues ([2647181](https://github.com/limrun-inc/typescript-sdk/commit/26471818e3fdbb5d9a1604cb1bd66e92aa5685dd))
* lint issues ([7c1af79](https://github.com/limrun-inc/typescript-sdk/commit/7c1af79f1c9bbcaa5a7cda911178549a81a95754))

## 0.2.0 (2025-09-08)

Full Changelog: [v0.1.0...v0.2.0](https://github.com/limrun-inc/typescript-sdk/compare/v0.1.0...v0.2.0)

### Features

* **api:** rename retrieve to get ([4b83931](https://github.com/limrun-inc/typescript-sdk/commit/4b83931741aa63ad47bd6937635c0ec28a63c763))

## 0.1.0 (2025-09-08)

Full Changelog: [v0.0.1...v0.1.0](https://github.com/limrun-inc/typescript-sdk/compare/v0.0.1...v0.1.0)

### Features

* **all:** add ui package and a full-stack example ([df431cf](https://github.com/limrun-inc/typescript-sdk/commit/df431cfc1da64b6720ef9c37b43e8267c8adf378))
* **api:** add typescript ([5854b21](https://github.com/limrun-inc/typescript-sdk/commit/5854b2103275c329f16e71076d3d351b0e3a6f1a))
* **tunnel:** add a separate package for tunnel ([db0bca7](https://github.com/limrun-inc/typescript-sdk/commit/db0bca77d5ce7187b55932be06d742dca7d224fd))
* **tunnel:** merge tunnel into helpers ([423aca4](https://github.com/limrun-inc/typescript-sdk/commit/423aca4097855c0951f191621a4306d27617fc30))


### Chores

* configure new SDK language ([c3f866c](https://github.com/limrun-inc/typescript-sdk/commit/c3f866cf68d0b38c563e468829cda6b5696e5969))
* lint issues ([24ad8a6](https://github.com/limrun-inc/typescript-sdk/commit/24ad8a6bf638cfadb9814b917b1ce850cdcab218))
* update SDK settings ([4cbc8cd](https://github.com/limrun-inc/typescript-sdk/commit/4cbc8cd834e79b91452d19c7a1b813d1da5d94cf))
