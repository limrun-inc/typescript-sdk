# Maestro with iOS

This example demonstrates how to run a Maestro black-box flow against a Limrun
iOS simulator using `@limrun/maestro-ios`.

It is intentionally closer to the `appium-ios` example than the Detox example:
Maestro and Appium are black-box UI automation frameworks, while Detox is a
gray-box React Native test framework.

Clone this repo and enter this example folder:

```bash
git clone https://github.com/limrun-inc/typescript-sdk.git
cd typescript-sdk/examples/maestro-ios
```

## Get Started

Export your Limrun API key:

```bash
# Acquire from your Organization Settings -> API Keys
export LIM_API_KEY=lim_...
```

Requirements:

- Java 17 or newer available as `java` on `PATH`
- No Gradle, Kotlin, Maestro CLI, `JAVA_HOME`, or `GRADLE_CMD` is required at runtime

The package itself expects an existing Limrun iOS target:

```bash
export LIMRUN_IOS_API_URL=https://...
export LIMRUN_IOS_TOKEN=lim_...
npx @limrun/maestro-ios test flows/hacker-news.yaml
```

To choose the Maestro-style artifact location:

```bash
npx @limrun/maestro-ios test --test-output-dir artifacts/limrun-maestro flows/hacker-news.yaml
```

The example script owns the Limrun instance lifecycle, similar to the
`appium-ios` example: it creates a simulator, passes its API URL and token to
`@limrun/maestro-ios`, then deletes the simulator. In a repo checkout, the
example `start` script first builds the local `packages/maestro-ios` package so
the gitignored `dist/` files and packaged runner JAR exist.

```bash
npm install
npm start
```

For staging:

```bash
lim-env -stg
npm start
```

## What The Example Does

1. Creates a remote iOS simulator from the example script.
2. Prints the signed stream URL that you can click and watch.
3. Starts the local Limrun-to-Maestro bridge from `@limrun/maestro-ios`.
4. Runs the packaged Maestro 2.5.1 JVM runner with `java -jar`.
5. Opens Hacker News in Safari.
6. Drives the page with Maestro: asserts content, scrolls the page, and captures
   screenshots.
7. Writes screenshots and `summary.json` under the Maestro test output directory.
8. Deletes the remote iOS simulator from the example script.

The default flow lives in `flows/hacker-news.yaml`.
