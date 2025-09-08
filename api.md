# AndroidInstances

Types:

- <code><a href="./src/resources/android-instances.ts">AndroidInstance</a></code>
- <code><a href="./src/resources/android-instances.ts">AndroidInstanceListResponse</a></code>

Methods:

- <code title="post /v1/android_instances">client.androidInstances.<a href="./src/resources/android-instances.ts">create</a>({ ...params }) -> AndroidInstance</code>
- <code title="get /v1/android_instances/{id}">client.androidInstances.<a href="./src/resources/android-instances.ts">retrieve</a>(id) -> AndroidInstance</code>
- <code title="get /v1/android_instances">client.androidInstances.<a href="./src/resources/android-instances.ts">list</a>({ ...params }) -> AndroidInstanceListResponse</code>
- <code title="delete /v1/android_instances/{id}">client.androidInstances.<a href="./src/resources/android-instances.ts">delete</a>(id) -> void</code>

# Assets

Types:

- <code><a href="./src/resources/assets.ts">Asset</a></code>
- <code><a href="./src/resources/assets.ts">AssetListResponse</a></code>
- <code><a href="./src/resources/assets.ts">AssetGetOrCreateResponse</a></code>

Methods:

- <code title="get /v1/assets/{assetId}">client.assets.<a href="./src/resources/assets.ts">retrieve</a>(assetID, { ...params }) -> Asset</code>
- <code title="get /v1/assets">client.assets.<a href="./src/resources/assets.ts">list</a>({ ...params }) -> AssetListResponse</code>
- <code title="put /v1/assets">client.assets.<a href="./src/resources/assets.ts">getOrCreate</a>({ ...params }) -> AssetGetOrCreateResponse</code>
