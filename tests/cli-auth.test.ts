const API_ENDPOINT = 'https://api.example.test';
const CONSOLE_ENDPOINT = 'https://console.example.test';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function requestUrl(input: string | URL | Request): URL {
  if (input instanceof URL) {
    return input;
  }
  if (typeof input === 'string') {
    return new URL(input);
  }
  return new URL(input.url);
}

function sessionResponse(overrides: Partial<Record<string, unknown>> = {}): Response {
  return jsonResponse(
    {
      sessionId: 'clisess_test',
      secret: 'secret_test',
      phrase: 'cosmic-otter-band',
      verificationUrl: `${CONSOLE_ENDPOINT}/authn/cli?session=clisess_test`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pollIntervalSeconds: 1,
      ...overrides,
    },
    { status: 201 },
  );
}

describe('lim login rendezvous session', () => {
  test('creates a session, opens the approval URL, polls, and writes the api key', async () => {
    const configWrites: Array<Partial<Record<string, string>>> = [];
    const openedUrls: string[] = [];
    const requests: Array<{ body: string | undefined; method: string; url: string }> = [];
    const { loginWithOptions } = await import('../packages/cli/src/lib/auth');

    const fetcher: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      requests.push({
        body: typeof init?.body === 'string' ? init.body : undefined,
        method: init?.method ?? 'GET',
        url: url.toString(),
      });
      if (url.pathname === '/authn/cli/sessions') {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return sessionResponse();
      }
      if (url.pathname === '/authn/cli/sessions/clisess_test/token') {
        expect(url.searchParams.get('secret')).toBe('secret_test');
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return jsonResponse({ apiKey: 'lim_test_key' });
      }
      return jsonResponse({ message: 'not found' }, { status: 404 });
    };

    await loginWithOptions({
      apiEndpoint: API_ENDPOINT,
      consoleEndpoint: CONSOLE_ENDPOINT,
      version: 'test',
      hostname: 'test-host',
      fetcher,
      configWriter: (partial) => {
        configWrites.push(partial);
      },
      opener: (url) => {
        openedUrls.push(url);
      },
      log: () => {},
      timeoutMs: 1_000,
    });

    expect(configWrites).toEqual([{ 'api-key': 'lim_test_key' }]);
    expect(openedUrls).toEqual([`${CONSOLE_ENDPOINT}/authn/cli?session=clisess_test`]);
    expect(requests).toEqual([
      {
        body: JSON.stringify({ hostname: 'test-host', cliVersion: 'test' }),
        method: 'POST',
        url: `${API_ENDPOINT}/authn/cli/sessions`,
      },
      {
        method: 'GET',
        url: `${API_ENDPOINT}/authn/cli/sessions/clisess_test/token?secret=secret_test`,
      },
    ]);
  });

  test('falls back to console endpoint when the backend omits verificationUrl', async () => {
    const openedUrls: string[] = [];
    const { loginWithOptions } = await import('../packages/cli/src/lib/auth');

    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname === '/authn/cli/sessions') {
        return sessionResponse({ verificationUrl: '' });
      }
      return jsonResponse({ apiKey: 'lim_test_key' });
    };

    await loginWithOptions({
      apiEndpoint: API_ENDPOINT,
      consoleEndpoint: CONSOLE_ENDPOINT,
      version: 'test',
      fetcher,
      configWriter: () => {},
      opener: (url) => {
        openedUrls.push(url);
      },
      log: () => {},
      timeoutMs: 1_000,
    });

    expect(openedUrls).toEqual([`${CONSOLE_ENDPOINT}/authn/cli?session=clisess_test`]);
  });

  test('rejects when the browser never approves the session', async () => {
    const { loginWithOptions } = await import('../packages/cli/src/lib/auth');

    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname === '/authn/cli/sessions') {
        return sessionResponse();
      }
      return jsonResponse({ status: 'pending' }, { status: 202 });
    };

    await expect(
      loginWithOptions({
        apiEndpoint: API_ENDPOINT,
        consoleEndpoint: CONSOLE_ENDPOINT,
        version: 'test',
        fetcher,
        configWriter: () => {},
        opener: () => undefined,
        log: () => {},
          timeoutMs: 10,
      }),
    ).rejects.toThrow('Login timed out waiting for browser authorization');
  });

  test('rejects cleanly when saving the api key fails', async () => {
    const { loginWithOptions } = await import('../packages/cli/src/lib/auth');

    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname === '/authn/cli/sessions') {
        return sessionResponse();
      }
      return jsonResponse({ apiKey: 'lim_test_key' });
    };

    await expect(
      loginWithOptions({
        apiEndpoint: API_ENDPOINT,
        consoleEndpoint: CONSOLE_ENDPOINT,
        version: 'test',
        fetcher,
        configWriter: () => {
          throw new Error('disk full');
        },
        opener: () => undefined,
        log: () => {},
          timeoutMs: 1_000,
      }),
    ).rejects.toThrow('disk full');
  });

  test('sends phrase and URL through the provided logger only', async () => {
    const logs: string[] = [];
    const { loginWithOptions } = await import('../packages/cli/src/lib/auth');

    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname === '/authn/cli/sessions') {
        return sessionResponse();
      }
      return jsonResponse({ apiKey: 'lim_test_key' });
    };

    await loginWithOptions({
      apiEndpoint: API_ENDPOINT,
      consoleEndpoint: CONSOLE_ENDPOINT,
      version: 'test',
      fetcher,
      configWriter: () => {},
      opener: () => undefined,
      log: (message) => logs.push(message),
      timeoutMs: 1_000,
    });

    expect(logs).toEqual([
      '\nConfirm this phrase in your browser: cosmic-otter-band',
      `Opening this URL to log in: ${CONSOLE_ENDPOINT}/authn/cli?session=clisess_test`,
      'Waiting for you to confirm in browser...',
    ]);
  });

  test('waits for browser opening before completing login', async () => {
    const configWrites: Array<Partial<Record<string, string>>> = [];
    const { loginWithOptions } = await import('../packages/cli/src/lib/auth');
    let finishOpen!: () => void;
    const openerFinished = new Promise<void>((resolve) => {
      finishOpen = resolve;
    });

    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname === '/authn/cli/sessions') {
        return sessionResponse();
      }
      return jsonResponse({ apiKey: 'lim_test_key' });
    };

    const loginPromise = loginWithOptions({
      apiEndpoint: API_ENDPOINT,
      consoleEndpoint: CONSOLE_ENDPOINT,
      version: 'test',
      fetcher,
      configWriter: (partial) => {
        configWrites.push(partial);
      },
      opener: () => openerFinished,
      log: () => {},
      timeoutMs: 1_000,
    });

    await expect(Promise.race([loginPromise.then(() => 'done'), Promise.resolve('pending')])).resolves.toBe('pending');
    expect(configWrites).toEqual([]);

    finishOpen();
    await loginPromise;
    expect(configWrites).toEqual([{ 'api-key': 'lim_test_key' }]);
  });

  test('aborts a hung session creation at the login deadline', async () => {
    const { loginWithOptions } = await import('../packages/cli/src/lib/auth');
    const fetcher: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });

    await expect(
      loginWithOptions({
        apiEndpoint: API_ENDPOINT,
        consoleEndpoint: CONSOLE_ENDPOINT,
        version: 'test',
        fetcher,
        configWriter: () => {},
        opener: () => undefined,
        log: () => {},
          timeoutMs: 10,
      }),
    ).rejects.toThrow('Login timed out waiting for browser authorization');
  });

  test('retries transient polling failures until approval', async () => {
    const { loginWithOptions } = await import('../packages/cli/src/lib/auth');
    const configWrites: Array<Partial<Record<string, string>>> = [];
    let pollCount = 0;

    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname === '/authn/cli/sessions') {
        return sessionResponse({ pollIntervalSeconds: 0 });
      }
      pollCount += 1;
      if (pollCount === 1) {
        throw new Error('temporary network failure');
      }
      if (pollCount === 2) {
        return jsonResponse({ message: 'try again' }, { status: 503 });
      }
      return jsonResponse({ apiKey: 'lim_test_key' });
    };

    await loginWithOptions({
      apiEndpoint: API_ENDPOINT,
      consoleEndpoint: CONSOLE_ENDPOINT,
      version: 'test',
      fetcher,
      configWriter: (partial) => {
        configWrites.push(partial);
      },
      opener: () => undefined,
      log: () => {},
      timeoutMs: 3_000,
    });

    expect(pollCount).toBe(3);
    expect(configWrites).toEqual([{ 'api-key': 'lim_test_key' }]);
  });
});
