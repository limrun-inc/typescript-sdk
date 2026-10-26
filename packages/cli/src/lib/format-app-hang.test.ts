import { formatAppHang } from './format-app-hang';

const stackTrace = [
  'Main Thread:',
  '0   libsystem_kernel.dylib  0x0000000000020020  __semwait_signal + 8',
  '1   App  0x0000000000001010  App.Feed.load() + 52',
  '2   UIKitCore  0x0000000000009010  UIKitCore + 16',
  '',
  'Binary Images:',
  '0x1000 App arm64 <A> /x/App.app/App',
].join('\n');

describe('formatAppHang', () => {
  it('formats a sample with what the main thread did and the top of its stack', () => {
    const out = formatAppHang(
      'com.example.app',
      {
        bundleId: 'com.example.app',
        pid: 42,
        hangId: 3,
        ended: false,
        durationMs: 1200,
        mainThreadState: 'waiting',
        mainThreadCpuMs: 4,
        mainThreadKernelMs: 1,
        appCpuMs: 30,
        pageIns: 0,
        footprintBytes: 412 * 2 ** 20,
        stackTrace,
      },
      2,
    );
    expect(out).toBe(
      [
        'com.example.app main thread unresponsive for 1200 ms (hang 3, pid 42, waiting, main thread cpu 4 ms (1 ms in kernel), app cpu 30 ms, page-ins 0, footprint 412 MB)',
        '  0   libsystem_kernel.dylib  0x0000000000020020  __semwait_signal + 8',
        '  1   App  0x0000000000001010  App.Feed.load() + 52',
      ].join('\n'),
    );
  });

  it('leaves out what the app could not read and stops before the binary images', () => {
    const out = formatAppHang('com.example.app', {
      bundleId: 'com.example.app',
      pid: 42,
      hangId: 3,
      ended: false,
      durationMs: 1200,
      stackTrace,
    });
    expect(out.split('\n')[0]).toBe('com.example.app main thread unresponsive for 1200 ms (hang 3, pid 42)');
    expect(out).not.toContain('Binary Images');
    expect(out.split('\n')).toHaveLength(4);
  });

  it('formats a hang end on one line', () => {
    const out = formatAppHang('com.example.app', {
      bundleId: 'com.example.app',
      pid: 42,
      hangId: 3,
      ended: true,
      durationMs: 4500,
    });
    expect(out).toBe('com.example.app main thread hang ended after 4500 ms (hang 3, pid 42)');
  });
});
