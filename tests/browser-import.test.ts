// A browser bundle of the SDK, such as a web console's, sees Node's built-ins as empty modules.
// Importing the SDK there must not touch them: the Node-only clients only run when called.
test('imports without the Node built-ins a browser bundle lacks', () => {
  jest.isolateModules(() => {
    jest.doMock('net', () => ({ __esModule: true, default: {} }));
    expect(() => require('../src/index')).not.toThrow();
  });
});
