# Appium with iOS

This example demonstrates how you can automate iOS instances from Limrun
using Appium, including native app and Safari actions.

It also shows how to get an iOS instance from Limrun and drive it from a
GitHub Actions job with Linux runner - a first in the ecosystem!

## Get Started

It creates an iOS instance where `WebDriverAgent` is pre-installed
and launched and then starts running the automation commands.

Install our custom driver that's based on upstream:
```bash
appium driver install --source npm @limrun/appium-xcuitest-driver@10.11.0-lim.1
```

Start Appium server in a separate terminal:
```bash
appium
```

Export your Limrun API key:
```bash
# Acquire from your Organization Settings -> API Keys
export LIM_API_KEY=lim_...
```

Start the example test:
```bash
yarn install
yarn run start
```

You'll see that it will navigate to HackerNews and browse it!

### Why fork XCUITest driver?

Appium iOS testing requires a test runner app to be installed called `WebDriverAgent`
and a driver to talk with the XCUITest context that `WebDriverAgent` holds. All of
our patches to `WebDriverAgent` are merged so we use the upstream version as is.

The upstream `appium-xcuitest-driver` assumes that the iOS simulator is running
locally since there is no other vendor yet that provides remote iOS simulator
automation.

The summary of our patches is as following:
* To manage simulators, the driver makes `xcrun simctl` calls assuming it's on
  the same host.
  * We forward those calls to our macOS host running the iOS
    simulator under isolation and disable some of them, such as booting and termination
    as they are managed through Limrun API.
* To seed files, it simply copies to the corresponding directory in the host it is running on.
  * We upload the file and our internal server places it on the target location.
* To automate Safari, it scans the list of open UNIX sockets by Simulator usually under `/tmp/`
  and connects to them directly.
  * We create a tunnel through the Limrun API to expose those UNIX sockets locally over TCP.

Important to make clear that these are simply implementation details of the driver;
your test code is not affected in anyway, the same code would work with local iOS simulator
running on macOS, too.

We're aiming to have them all merged in the upstream but the protocols are Limrun-specific,
so there will be a while till we land on a vendor-neutral protocol.

Enjoy driving iOS from any setup!
