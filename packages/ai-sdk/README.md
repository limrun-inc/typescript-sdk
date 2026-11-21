# @limrun/ai-sdk

Limrun tools for the [Vercel AI SDK](https://ai-sdk.dev). They let a model create cloud iOS simulators and Android emulators, look at the screen, drive the UI, and delete the devices when it is done.

The tool names and input schemas match the [Limrun remote MCP server](https://docs.limrun.com/docs/agents/remote-mcp), so prompts written for one work with the other.

## Install

```sh
npm install @limrun/ai-sdk ai zod
```

Set `LIM_API_KEY` to an API key from the Limrun console (**Settings**, **API Keys**), or pass `apiKey` to `limrunTools()`.

## Example

```ts
import { generateText, stepCountIs } from 'ai';
import { limrunTools } from '@limrun/ai-sdk';

const { text } = await generateText({
  model: 'anthropic/claude-sonnet-5.5',
  tools: limrunTools(),
  stopWhen: stepCountIs(20),
  prompt:
    'Create an iOS simulator, open https://lim.run in Safari, ' +
    'tell me what the page heading says, then delete the simulator.',
});

console.log(text);
```

## Tools

| Tool                                              | What it does                                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `create-ios-simulator`, `create-android-emulator` | Create a device and wait until it is ready. Optional `apps` (asset names or public URLs), `inactivityTimeout`, and `tunnel`. |
| `list-instances`                                  | List the ready iOS simulators and Android emulators of the organization.                                                     |
| `get-instance-status`                             | Get the state and error message of one instance.                                                                             |
| `delete-instance`                                 | Delete an instance. This is the only destructive tool.                                                                       |
| `list-apps`                                       | List the app asset names for a platform.                                                                                     |
| `install-app`                                     | Install an app asset on a running instance. iOS installs also launch the app.                                                |
| `ios-screenshot-and-element-tree`                 | Screenshot (sent to the model as an image) and accessibility tree.                                                           |
| `ios-use`                                         | Batched taps, typing, scrolling, keys, buttons, and raw touches.                                                             |
| `ios-open-url`, `ios-app`, `ios-logs`             | Open a URL or deeplink, list/launch/terminate apps, read app logs.                                                           |
| `android-screenshot-and-element-tree`             | Screenshot (sent to the model as an image) and UIAutomator XML.                                                              |
| `android-use`                                     | Taps, text, keys, scrolling, and element search. Returns a screenshot.                                                       |
| `android-open-url`                                | Open a URL or deeplink.                                                                                                      |

Each device tool takes the `instanceId` that a create tool returned, and opens a new connection to the device for each call. Instances created by these tools have the label `created-by: ai-sdk`.

The remote MCP server has some tools that this package does not include: `stream-device` and the other MCP UI tools, `get-agent-skill`, and the recording and StoreKit actions of `ios-use` and `android-use`. To build apps or upload local files, use the [`lim` CLI](https://docs.limrun.com/docs/agents/cli).
