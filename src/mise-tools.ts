export function parseToolRequests(requests: string[]): Record<string, string> {
  const tools: Record<string, string> = {};
  for (const request of requests) {
    const at = request.lastIndexOf('@');
    if (at <= 0 || !request.slice(at + 1).trim())
      throw new Error(`Expected tool@version, received ${JSON.stringify(request)}.`);
    const name = request.slice(0, at);
    if (!/^[A-Za-z0-9][A-Za-z0-9:_./-]*$/.test(name))
      throw new Error(`Invalid tool name ${JSON.stringify(name)}.`);
    tools[name] = request.slice(at + 1);
  }
  return tools;
}
