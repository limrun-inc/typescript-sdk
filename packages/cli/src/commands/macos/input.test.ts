import { Parser } from '@oclif/core';
import MacosTap from './tap';
import MacosType from './type';
import MacosPressKey from './press-key';
import MacosScroll from './scroll';
import MacosDrag from './drag';

type Command = { run(): Promise<void> };

function setup<T extends Command>(
  Cmd: { prototype: T },
  args: Record<string, unknown>,
  flags: Record<string, unknown>,
) {
  const client = {
    tap: jest.fn().mockResolvedValue(undefined),
    typeText: jest.fn().mockResolvedValue(undefined),
    pressKey: jest.fn().mockResolvedValue(undefined),
    scroll: jest.fn().mockResolvedValue(undefined),
    drag: jest.fn().mockResolvedValue(undefined),
  };
  const resolveMacosClient = jest.fn(async () => ({ id: 'macos_test', client }));
  const outputResult = jest.fn();
  const command: T = Object.assign(Object.create(Cmd.prototype), {
    parse: async () => ({ args, flags }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveMacosClient,
    outputResult,
  });
  return { command, client, resolveMacosClient, outputResult };
}

test('tap clicks with the left button at the point', async () => {
  const { command, client, outputResult } = setup(MacosTap, { x: 640, y: 360 }, { right: false });
  await command.run();
  expect(client.tap).toHaveBeenCalledWith({ x: 640, y: 360 }, undefined);
  expect(outputResult).toHaveBeenCalledWith(
    { ok: true, instanceId: 'macos_test', x: 640, y: 360, button: 'left' },
    'Clicked at (640, 360)',
  );
});

test('tap --right clicks with the right button', async () => {
  const { command, client } = setup(MacosTap, { x: 1, y: 2 }, { right: true });
  await command.run();
  expect(client.tap).toHaveBeenCalledWith({ x: 1, y: 2 }, { button: 'right' });
});

test.each([
  [false, 'hello'],
  [true, 'hello\n'],
])('type with --enter=%s types %j', async (enter, typed) => {
  const { command, client, outputResult } = setup(MacosType, { text: 'hello' }, { enter });
  await command.run();
  expect(client.typeText).toHaveBeenCalledWith(typed);
  expect(outputResult).toHaveBeenCalledWith(
    { ok: true, instanceId: 'macos_test', characters: 5, enter },
    'Typed 5 characters',
  );
});

test('press-key holds every modifier', async () => {
  const { command, client, outputResult } = setup(
    MacosPressKey,
    { key: 'q' },
    { modifier: ['command', 'shift'] },
  );
  await command.run();
  expect(client.pressKey).toHaveBeenCalledWith('q', ['command', 'shift']);
  expect(outputResult).toHaveBeenCalledWith(
    { ok: true, instanceId: 'macos_test', key: 'q', modifiers: ['command', 'shift'] },
    'Pressed command+shift+q',
  );
});

test('press-key accepts only the modifiers the guest knows', async () => {
  await expect(
    Parser.parse(['a', '--modifier', 'alt'], { args: MacosPressKey.args, flags: MacosPressKey.flags }),
  ).rejects.toThrow(/Expected --modifier=alt to be one of/);
});

test.each([
  ['down', { dy: 300 }],
  ['up', { dy: -300 }],
  ['right', { dx: 300 }],
  ['left', { dx: -300 }],
])('scroll %s moves by %j', async (direction, delta) => {
  const { command, client } = setup(MacosScroll, { direction }, { amount: 300 });
  await command.run();
  expect(client.scroll).toHaveBeenCalledWith(delta);
});

test('scroll --coordinate scrolls over that point', async () => {
  const { command, client } = setup(
    MacosScroll,
    { direction: 'down' },
    { amount: 600, coordinate: '640,400' },
  );
  await command.run();
  expect(client.scroll).toHaveBeenCalledWith({ dy: 600, at: { x: 640, y: 400 } });
});

test('drag presses, moves over the duration and releases', async () => {
  const { command, client, outputResult } = setup(
    MacosDrag,
    {},
    { from: '200,300', to: '600,300', duration: 800 },
  );
  await command.run();
  expect(client.drag).toHaveBeenCalledWith({ x: 200, y: 300 }, { x: 600, y: 300 }, { durationMs: 800 });
  expect(outputResult).toHaveBeenCalledWith(
    { ok: true, instanceId: 'macos_test', from: [200, 300], to: [600, 300], durationMs: 800 },
    'Dragged from (200, 300) to (600, 300)',
  );
});

test('drag rejects a malformed point before reaching the instance', async () => {
  const { command, resolveMacosClient } = setup(MacosDrag, {}, { from: '200', to: '600,300', duration: 300 });
  await expect(command.run()).rejects.toThrow(/--from/);
  expect(resolveMacosClient).not.toHaveBeenCalled();
});

test('swipe is the iOS name for drag', () => {
  expect(MacosDrag.aliases).toContain('macos:swipe');
});
