import { parseTunnelHeaders } from './tunnel-headers';

describe('parseTunnelHeaders', () => {
  test('returns undefined without entries', () => {
    expect(parseTunnelHeaders(undefined)).toBeUndefined();
    expect(parseTunnelHeaders([])).toBeUndefined();
  });

  test('splits at the first colon and trims the name and the value', () => {
    expect(
      parseTunnelHeaders([
        'X-Run-Id: run-4812',
        '  X-Callback :  https://ci.example.com:8443/hooks  ',
        'X-Empty:',
      ]),
    ).toEqual({
      'X-Run-Id': 'run-4812',
      'X-Callback': 'https://ci.example.com:8443/hooks',
      'X-Empty': '',
    });
  });

  test('names an entry without a colon by position instead of echoing it', () => {
    const call = () => parseTunnelHeaders(['X-Run-Id: run-4812', 'X-Token sk-live-supersecret']);
    expect(call).toThrow("--tunnel-header #2 must look like 'Name: value'.");
    expect(call).not.toThrow(/sk-live-supersecret/);
  });

  test('rejects an empty name without echoing the entry', () => {
    for (const entry of [': sk-live-supersecret', '   : sk-live-supersecret']) {
      const call = () => parseTunnelHeaders([entry]);
      expect(call).toThrow("--tunnel-header #1 must look like 'Name: value'.");
      expect(call).not.toThrow(/sk-live-supersecret/);
    }
  });

  test('rejects duplicate names regardless of case, naming the header but not the value', () => {
    const call = () => parseTunnelHeaders(['X-Run-Id: sk-live-one', 'x-run-id: sk-live-two']);
    expect(call).toThrow('Duplicate --tunnel-header name "x-run-id".');
    expect(call).not.toThrow(/sk-live/);
  });

  test('leaves reserved names and other header rules to the API', () => {
    const headers = parseTunnelHeaders(['Host: example.com', '__proto__: x']);
    expect(Object.keys(headers ?? {})).toEqual(['Host', '__proto__']);
  });
});
