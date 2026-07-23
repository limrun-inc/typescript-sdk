# AndroidInstances

Types:

- <code><a href="./src/resources/android-instances.ts">AndroidInstance</a></code>

Methods:

- <code title="post /v1/android_instances">client.androidInstances.<a href="./src/resources/android-instances.ts">create</a>({ ...params }) -> AndroidInstance</code>
- <code title="get /v1/android_instances">client.androidInstances.<a href="./src/resources/android-instances.ts">list</a>({ ...params }) -> AndroidInstancesItems</code>
- <code title="delete /v1/android_instances/{id}">client.androidInstances.<a href="./src/resources/android-instances.ts">delete</a>(id) -> void</code>
- <code title="get /v1/android_instances/{id}">client.androidInstances.<a href="./src/resources/android-instances.ts">get</a>(id) -> AndroidInstance</code>

# Assets

Types:

- <code><a href="./src/resources/assets.ts">Asset</a></code>
- <code><a href="./src/resources/assets.ts">AssetListResponse</a></code>
- <code><a href="./src/resources/assets.ts">AssetGetOrCreateResponse</a></code>

Methods:

- <code title="get /v1/assets">client.assets.<a href="./src/resources/assets.ts">list</a>({ ...params }) -> AssetListResponse</code>
- <code title="delete /v1/assets/{assetId}">client.assets.<a href="./src/resources/assets.ts">delete</a>(assetID) -> void</code>
- <code title="get /v1/assets/{assetId}">client.assets.<a href="./src/resources/assets.ts">get</a>(assetID, { ...params }) -> Asset</code>
- <code title="put /v1/assets">client.assets.<a href="./src/resources/assets.ts">getOrCreate</a>({ ...params }) -> AssetGetOrCreateResponse</code>

# IosInstances

Types:

- <code><a href="./src/resources/ios-instances.ts">IosInstance</a></code>

Methods:

- <code title="post /v1/ios_instances">client.iosInstances.<a href="./src/resources/ios-instances.ts">create</a>({ ...params }) -> IosInstance</code>
- <code title="get /v1/ios_instances">client.iosInstances.<a href="./src/resources/ios-instances.ts">list</a>({ ...params }) -> IosInstancesItems</code>
- <code title="delete /v1/ios_instances/{id}">client.iosInstances.<a href="./src/resources/ios-instances.ts">delete</a>(id) -> void</code>
- <code title="get /v1/ios_instances/{id}">client.iosInstances.<a href="./src/resources/ios-instances.ts">get</a>(id) -> IosInstance</code>

# XcodeInstances

Types:

- <code><a href="./src/resources/xcode-instances.ts">XcodeInstance</a></code>

Methods:

- <code title="post /v1/xcode_instances">client.xcodeInstances.<a href="./src/resources/xcode-instances.ts">create</a>({ ...params }) -> XcodeInstance</code>
- <code title="get /v1/xcode_instances">client.xcodeInstances.<a href="./src/resources/xcode-instances.ts">list</a>({ ...params }) -> XcodeInstancesItems</code>
- <code title="delete /v1/xcode_instances/{id}">client.xcodeInstances.<a href="./src/resources/xcode-instances.ts">delete</a>(id) -> void</code>
- <code title="get /v1/xcode_instances/{id}">client.xcodeInstances.<a href="./src/resources/xcode-instances.ts">get</a>(id) -> XcodeInstance</code>
- <code title="get /v1/xcode_instances/{id}/build_logs">client.xcodeInstances.<a href="./src/resources/xcode-instances-helpers.ts">listBuildLogs</a>(id) -> XcodeBuildLog[]</code>
- <code title="get /v1/xcode_instances/{id}/bazel_build_logs">client.xcodeInstances.<a href="./src/resources/xcode-instances-helpers.ts">listBazelBuildLogs</a>(id) -> BazelBuildLog[]</code>

# GradleInstances

Types:

- <code><a href="./src/resources/gradle-instances.ts">GradleInstance</a></code>

Methods:

- <code title="post /v1/gradle_instances">client.gradleInstances.<a href="./src/resources/gradle-instances.ts">create</a>({ ...params }) -> GradleInstance</code>
- <code title="get /v1/gradle_instances">client.gradleInstances.<a href="./src/resources/gradle-instances.ts">list</a>({ ...params }) -> GradleInstancesItems</code>
- <code title="delete /v1/gradle_instances/{id}">client.gradleInstances.<a href="./src/resources/gradle-instances.ts">delete</a>(id) -> void</code>
- <code title="get /v1/gradle_instances/{id}">client.gradleInstances.<a href="./src/resources/gradle-instances.ts">get</a>(id) -> GradleInstance</code>

# Analytics

Types:

- <code><a href="./src/resources/analytics.ts">AnalyticsInstancesResponse</a></code>
- <code><a href="./src/resources/analytics.ts">AnalyticsResponse</a></code>

Methods:

- <code title="get /v1/analytics">client.analytics.<a href="./src/resources/analytics.ts">get</a>({ ...params }) -> AnalyticsResponse</code>
- <code title="get /v1/analytics/instances">client.analytics.<a href="./src/resources/analytics.ts">getInstances</a>({ ...params }) -> AnalyticsInstancesResponse</code>

# ScopedTokens

Types:

- <code><a href="./src/resources/scoped-tokens.ts">ScopedToken</a></code>

Methods:

- <code title="post /v1/scoped_tokens">client.scopedTokens.<a href="./src/resources/scoped-tokens.ts">create</a>({ ...params }) -> ScopedToken</code>
