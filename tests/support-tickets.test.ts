import Limrun from '@limrun/api';

test.each([undefined, '54d8ef51-614e-4568-8275-b358cdcf262f'])(
  'preserves the ticket idempotency key across a transport retry (%s)',
  async (idempotencyKey) => {
    const attempts: Headers[] = [];
    const client = new Limrun({
      apiKey: 'test',
      baseURL: 'https://api.example.test',
      fetch: async (_url, init) => {
        attempts.push(new Headers(init?.headers));
        if (attempts.length === 1)
          return new Response('', { status: 503, headers: { 'retry-after-ms': '1' } });
        return Response.json({ id: 'ticket_test' });
      },
    });
    const ticket = await client.supportTickets.create(
      'org_test',
      { kind: 'ticket', subject: 'Build failed', message: 'Signing failed.' },
      idempotencyKey ? { idempotencyKey } : undefined,
    );
    expect(ticket.id).toBe('ticket_test');
    const keys = attempts.map((headers) => headers.get('Idempotency-Key'));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(keys[1]).toEqual(idempotencyKey ?? keys[0]);
  },
);
