import { parseReversePortMapping } from '../packages/cli/src/lib/reverse-port-mapping';

describe('parseReversePortMapping', () => {
  test('parses a single remote port as local=remote', () => {
    expect(parseReversePortMapping('57090')).toEqual({ remotePort: 57090, localPort: 57090 });
  });

  test('parses explicit remote:local ports', () => {
    expect(parseReversePortMapping('57090:8081')).toEqual({ remotePort: 57090, localPort: 8081 });
  });

  test('rejects empty mapping halves', () => {
    expect(() => parseReversePortMapping('57090:')).toThrow('Mapping must be <remotePort> or <remotePort>:<localPort>');
    expect(() => parseReversePortMapping(':8081')).toThrow('Mapping must be <remotePort> or <remotePort>:<localPort>');
  });

  test('rejects mappings with more than two parts', () => {
    expect(() => parseReversePortMapping('57090:8081:3000')).toThrow(
      'Mapping must be <remotePort> or <remotePort>:<localPort>',
    );
  });

  test('rejects ports below the reserved reverse tunnel range', () => {
    expect(() => parseReversePortMapping('57089')).toThrow('remotePort must be between 57090 and 57099');
  });

  test('rejects ports above the reserved reverse tunnel range', () => {
    expect(() => parseReversePortMapping('57100')).toThrow('remotePort must be between 57090 and 57099');
  });

  test('rejects non-numeric ports', () => {
    expect(() => parseReversePortMapping('abc')).toThrow('remotePort must be a number');
    expect(() => parseReversePortMapping('57090:abc')).toThrow('localPort must be a number');
  });
});
