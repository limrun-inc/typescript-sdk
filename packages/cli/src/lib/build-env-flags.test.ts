import { Interfaces, Parser } from '@oclif/core';
import GradleBuild from '../commands/gradle/build';
import XcodeBuild from '../commands/xcode/build';
import { webhookConfigFromFlags, type WebhookFlagValues } from './webhook-options';

// Lives under lib/ rather than beside the commands because test files compile
// into dist/, where oclif would pick up dist/commands/*.test.js as a command.

type BuildFlagValues = WebhookFlagValues & {
  detach?: boolean;
  upload?: string;
  'signed-upload-url'?: string;
};

const VARS = ['LIM_WEBHOOK_URL', 'LIM_WEBHOOK_HEADERS', 'LIM_SIGNED_UPLOAD_URL'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

async function parseFlags(flags: Interfaces.FlagInput, argv: string[]): Promise<BuildFlagValues> {
  const { flags: parsed } = await Parser.parse(argv, { flags, strict: false });
  return parsed as BuildFlagValues;
}

describe.each([
  { name: 'xcode build', flags: XcodeBuild.flags as Interfaces.FlagInput },
  { name: 'gradle build', flags: GradleBuild.flags as Interfaces.FlagInput },
])('$name captures build flags from the environment', ({ flags }) => {
  it('takes the webhook from the environment, and lets an explicit flag replace it', async () => {
    process.env['LIM_WEBHOOK_HEADERS'] = 'Authorization=Bearer ambient,X-Trace=abc';
    const headersOnly = await parseFlags(flags, []);
    expect(() => webhookConfigFromFlags(headersOnly)).toThrow('--webhook-header requires --webhook-url.');

    process.env['LIM_WEBHOOK_URL'] = 'https://ambient.example.com/hooks';
    expect(webhookConfigFromFlags(await parseFlags(flags, []))).toEqual({
      url: 'https://ambient.example.com/hooks',
      headers: { Authorization: 'Bearer ambient', 'X-Trace': 'abc' },
    });

    // Argv replaces the variable outright rather than merging with it.
    const typed = await parseFlags(flags, [
      '--webhook-url',
      'https://typed.example.com/hooks',
      '--webhook-header',
      'Authorization=Bearer typed',
    ]);
    expect(webhookConfigFromFlags(typed)).toEqual({
      url: 'https://typed.example.com/hooks',
      headers: { Authorization: 'Bearer typed' },
    });
  });

  it('satisfies the --detach guard with a webhook URL from the environment', async () => {
    process.env['LIM_WEBHOOK_URL'] = 'https://ci.example.com/hooks/limrun';
    const parsed = await parseFlags(flags, ['--detach']);
    // The guard both commands run is `flags.detach && !flags['webhook-url']`.
    expect(parsed.detach).toBe(true);
    expect(parsed['webhook-url']).toBe('https://ci.example.com/hooks/limrun');
  });

  it('withholds the ambient signed upload URL when --upload names a destination', async () => {
    process.env['LIM_SIGNED_UPLOAD_URL'] = 'https://storage.example.com/put?sig=ambient';
    expect((await parseFlags(flags, []))['signed-upload-url']).toBe(
      'https://storage.example.com/put?sig=ambient',
    );

    // Never reaches the parsed flags, so the commands' "not both" guard sees
    // only the destination the caller actually asked for.
    expect((await parseFlags(flags, ['--upload', 'myapp-build']))['signed-upload-url']).toBeUndefined();

    // Two explicit flags do still contradict each other, and both survive
    // parsing so the guard can reject them.
    const typed = await parseFlags(flags, [
      '--upload',
      'myapp-build',
      '--signed-upload-url',
      'https://storage.example.com/put?sig=typed',
    ]);
    expect(typed.upload).toBe('myapp-build');
    expect(typed['signed-upload-url']).toBe('https://storage.example.com/put?sig=typed');
  });
});
