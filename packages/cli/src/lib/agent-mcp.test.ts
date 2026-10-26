import { mergeMcpServerJson } from './agent-mcp';

describe('MCP config merge', () => {
  const entry = { url: 'https://mcp.limrun.com/mcp' };

  it('adds limrun and keeps the other servers and settings', () => {
    const existing = JSON.stringify({
      theme: 'dark',
      mcpServers: { github: { command: 'gh-mcp', env: { TOKEN: 'x' } } },
    });

    const merged = mergeMcpServerJson(existing, 'limrun', entry);

    expect(merged.changed).toBe(true);
    expect(JSON.parse(merged.text)).toEqual({
      theme: 'dark',
      mcpServers: { github: { command: 'gh-mcp', env: { TOKEN: 'x' } }, limrun: entry },
    });
  });

  it('keeps an existing limrun entry as the user wrote it', () => {
    const existing = JSON.stringify({ mcpServers: { limrun: { url: entry.url, headers: { A: 'b' } } } });

    expect(mergeMcpServerJson(existing, 'limrun', entry)).toEqual({ text: existing, changed: false });
  });

  it('creates the config from a missing or empty file', () => {
    expect(JSON.parse(mergeMcpServerJson(undefined, 'limrun', entry).text)).toEqual({
      mcpServers: { limrun: entry },
    });
    expect(mergeMcpServerJson('  \n', 'limrun', entry).changed).toBe(true);
  });

  it('refuses content it cannot merge instead of replacing it', () => {
    expect(() => mergeMcpServerJson('{ "mcpServers": { // comment', 'limrun', entry)).toThrow();
    expect(() => mergeMcpServerJson('[]', 'limrun', entry)).toThrow('not a JSON object');
    expect(() => mergeMcpServerJson('{"mcpServers": []}', 'limrun', entry)).toThrow('"mcpServers"');
  });
});
