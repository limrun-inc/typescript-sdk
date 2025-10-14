# Asset Example

This example demonstrates how you can upload your iOS Simulator build to Limrun Asset Storage
and have an iOS Simulator created with that app installed.

Run the example:
```bash
export LIM_TOKEN=<lim token from Console>
yarn install
yarn run start

# Click on the instance link to connect!
```

To make it more concrete, we use Expo Go iOS Simulator build. The Limrun instance expects
a `.zip` file that contains the `.app` folder, but Expo Go is distributed with a `tar.gz` that
contains the build so example contains unarchive & zip steps that may not be necessary in your
case.
