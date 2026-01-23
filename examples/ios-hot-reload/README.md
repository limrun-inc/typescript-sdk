# Hot Reload for iOS Apps

This example shows how to use our `syncApp` function to sync an app folder
continuously with file patches so that it transfers only the necessary bits
over the network when files change and reopen the app. It also streams your
app's log lines from the simulator while running, similar to XCode bottom
right log panel.

For example, a native Swift app with a 25mb binary has a string change, the
only chunk sent is that changed 1kb and our server applies that patch which
happens in milliseconds.

Under the hood, it uses `xdelta3` algorithm for diff-ing and OS-specific
functionality for watching changes.

Pre-requisite:
```bash
brew install xdelta
```

## Build your app

You can build your app for simulator with the following command:
```bash
export XCODEPROJ_NAME=sample-native-app.xcodeproj
export XCODE_TARGET_NAME=sample-native-app

xcodebuild -project ${XCODEPROJ_NAME} \
  -scheme ${XCODE_TARGET_NAME} \
  -sdk iphonesimulator \
  -configuration Debug \
  -derivedDataPath build \
  build

export APP_DIR=$(pwd)/build/Build/Products/Debug-iphonesimulator/${XCODE_TARGET_NAME}.app
```

## Start sync

```bash
export LIM_API_KEY=<lim token from Console>
```

The following will set up the sync and print a link for you to access the iOS simulator. It will
also stream the logs from your app for 30 seconds and then stream the syslogs for 30 seconds
as example to show how you can see the logs that XCode shows when you run it locally.

Every time you run `xcodebuild`, it will calculate the byte diff, send patches and reopen the app,
similar to hot reload.
```bash
yarn install

# One-time sync (no watching)
yarn run start

# Continuous sync on changes
yarn run start --watch ${APP_DIR}

# Click on the instance link to connect!
```
