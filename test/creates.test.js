/* globals describe, it, expect, jest */

const zapier = require('zapier-platform-core');

jest.mock('lenz-io', () => {
  const actual = jest.requireActual('lenz-io');
  return { ...actual, Lenz: jest.fn() };
});

const { Lenz: LenzClient, LenzValidationError } = require('lenz-io');
const App = require('../index');

const appTester = zapier.createAppTester(App);

function mockClient(overrides = {}) {
  return {
    verify: jest.fn(),
    getStatus: jest.fn(),
    assess: jest.fn(),
    extract: jest.fn(),
    ask: { send: jest.fn() },
    usage: jest.fn(),
    ...overrides,
  };
}

describe('creates.verify_claim', () => {
  it('perform submits with a Zapier callback URL and returns the task_id', async () => {
    const client = mockClient({
      verify: jest.fn().mockResolvedValue({ task_id: 'task_123' }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = {
      authData: { apiKey: 'lenz_good' },
      inputData: { claim: 'The Eiffel Tower is 330 metres tall.' },
    };
    const result = await appTester(App.creates.verify_claim.operation.perform, bundle);

    expect(result).toMatchObject({ task_id: 'task_123', status: 'processing' });
    // appTester hardcodes callback_url to Zapier's staging echo server; in
    // production Zapier's platform injects a real per-Zap callback URL here.
    expect(client.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        claim: 'The Eiffel Tower is 330 metres tall.',
        webhookUrl: 'https://auth-json-server.zapier-staging.com/echo',
      }),
    );
  });

  it('while loading a sample: makes only the free usage() check (never verify) and stubs when the key has a webhook secret', async () => {
    const client = mockClient({
      verify: jest.fn(),
      usage: jest.fn().mockResolvedValue({ plan: 'plus', has_webhook_secret: true }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = {
      authData: { apiKey: 'lenz_good' },
      inputData: { claim: 'A different claim.' },
      meta: { isLoadingSample: true },
    };
    const result = await appTester(App.creates.verify_claim.operation.perform, bundle);

    // Fully canned Eiffel-Tower example — the real input claim is NOT spliced
    // in, so a chained test reads as obvious example data, not a mismatch.
    expect(result).toMatchObject({
      status: 'completed',
      verification_id: 'ab12cd34',
      claim: expect.stringContaining('Eiffel Tower'),
    });
    // Free usage() call only; NO credit-spending verify submission.
    expect(client.usage).toHaveBeenCalled();
    expect(client.verify).not.toHaveBeenCalled();
  });

  it('while loading a sample: warns at test time when the key has no webhook secret (has_webhook_secret === false)', async () => {
    const client = mockClient({
      verify: jest.fn(),
      usage: jest.fn().mockResolvedValue({ plan: 'plus', has_webhook_secret: false }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = {
      authData: { apiKey: 'lenz_nosecret' },
      inputData: { claim: 'A claim.' },
      meta: { isLoadingSample: true },
    };

    await expect(appTester(App.creates.verify_claim.operation.perform, bundle)).rejects.toThrow(
      /webhook secret/i,
    );
    expect(client.verify).not.toHaveBeenCalled();
  });

  it('while loading a sample: degrades gracefully on an older server that omits has_webhook_secret (no false warning)', async () => {
    const client = mockClient({
      verify: jest.fn(),
      // Old server: field absent → undefined → strict === false check is a no-op.
      usage: jest.fn().mockResolvedValue({ plan: 'plus' }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = {
      authData: { apiKey: 'lenz_good' },
      inputData: { claim: 'A claim.' },
      meta: { isLoadingSample: true },
    };
    const result = await appTester(App.creates.verify_claim.operation.perform, bundle);

    expect(result).toMatchObject({ status: 'completed', verification_id: 'ab12cd34' });
    expect(client.verify).not.toHaveBeenCalled();
  });

  it('perform surfaces a clear, actionable message when the key has no webhook secret yet (live run)', async () => {
    const apiError = new LenzValidationError({
      message: 'webhook_url was supplied but this API key has no HMAC secret. Generate one at https://lenz.io/api-integration.',
      statusCode: 422,
      body: { detail: 'webhook_url was supplied but this API key has no HMAC secret.', code: 'webhook_secret_missing' },
    });
    const client = mockClient({ verify: jest.fn().mockRejectedValue(apiError) });
    LenzClient.mockImplementation(() => client);

    const bundle = {
      authData: { apiKey: 'lenz_good' },
      inputData: { claim: 'The Eiffel Tower is 330 metres tall.' },
    };

    await expect(appTester(App.creates.verify_claim.operation.perform, bundle)).rejects.toThrow(
      /generate webhook secret/i,
    );
  });

  it('perform re-throws any other error unchanged', async () => {
    const apiError = new LenzValidationError({ message: 'Text is required.', statusCode: 422, body: { detail: 'Text is required.' } });
    const client = mockClient({ verify: jest.fn().mockRejectedValue(apiError) });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' }, inputData: { claim: '' } };

    await expect(appTester(App.creates.verify_claim.operation.perform, bundle)).rejects.toThrow('Text is required.');
  });

  it('performResume fetches the terminal status and shapes a completed verdict', async () => {
    const client = mockClient({
      getStatus: jest.fn().mockResolvedValue({
        status: 'completed',
        result: {
          verification_id: 'ab12cd34',
          claim: 'The Eiffel Tower is 330 metres tall.',
          verdict: 'True',
          confidence: 'high',
          lenz_score: 9,
          executive_summary: 'Confirmed by multiple official sources.',
          sources: [{ title: 'Official site', url: 'https://www.toureiffel.paris' }],
        },
      }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = {
      authData: { apiKey: 'lenz_good' },
      outputData: { task_id: 'task_123', status: 'processing' },
    };
    const result = await appTester(App.creates.verify_claim.operation.performResume, bundle);

    expect(result).toMatchObject({
      task_id: 'task_123',
      status: 'completed',
      passed: true,
      verification_id: 'ab12cd34',
      verdict: 'True',
    });
    expect(client.getStatus).toHaveBeenCalledWith('task_123');
  });

  it('performResume surfaces a needs_input pause without throwing', async () => {
    const client = mockClient({
      getStatus: jest.fn().mockResolvedValue({ status: 'needs_input', reason: 'multi_claim' }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' }, outputData: { task_id: 'task_123' } };
    const result = await appTester(App.creates.verify_claim.operation.performResume, bundle);

    expect(result).toMatchObject({ status: 'needs_input', reason: 'multi_claim' });
  });

  it('performResume surfaces a failed pipeline', async () => {
    const client = mockClient({
      getStatus: jest.fn().mockResolvedValue({ status: 'failed', error: 'boom' }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' }, outputData: { task_id: 'task_123' } };
    const result = await appTester(App.creates.verify_claim.operation.performResume, bundle);

    expect(result).toMatchObject({ status: 'failed', error: 'boom' });
  });
});

describe('creates.assess', () => {
  it('derives passed=true/false per claim', async () => {
    const client = mockClient({
      assess: jest.fn().mockResolvedValue({
        claims: [
          { claim: 'A', verdict: 'True', confidence: 'high', verification_url: null },
          { claim: 'B', verdict: 'False', confidence: 'high', verification_url: null },
        ],
      }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' }, inputData: { text: 'A and B' } };
    const result = await appTester(App.creates.assess.operation.perform, bundle);

    expect(result.status).toBe('ok');
    expect(result.claims).toEqual([
      expect.objectContaining({ claim: 'A', passed: true }),
      expect.objectContaining({ claim: 'B', passed: false }),
    ]);
  });

  it('surfaces error_code when no claim is found', async () => {
    const client = mockClient({
      assess: jest.fn().mockResolvedValue({ claims: [], error: 'No claim found.', error_code: 'no_claim' }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' }, inputData: { text: 'huh?' } };
    const result = await appTester(App.creates.assess.operation.perform, bundle);

    expect(result).toMatchObject({ status: 'no_claim', message: 'No claim found.' });
  });

  it('stubs sample data and makes NO real call while loading a sample (no assess credit spent on a test click)', async () => {
    const client = mockClient({ assess: jest.fn() });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' }, inputData: { text: 'A' }, meta: { isLoadingSample: true } };
    const result = await appTester(App.creates.assess.operation.perform, bundle);

    expect(result.status).toBe('ok');
    expect(client.assess).not.toHaveBeenCalled();
  });
});

describe('creates.extract_claims', () => {
  it('passes the raw extraction result through', async () => {
    const client = mockClient({
      extract: jest.fn().mockResolvedValue({ status: 'ok', claim: 'A', identified_claims: ['A'] }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' }, inputData: { text: 'A' } };
    const result = await appTester(App.creates.extract_claims.operation.perform, bundle);

    expect(result).toMatchObject({ status: 'ok', claim: 'A' });
  });

  it('stubs sample data and makes NO real call while loading a sample (consistent with the other creates)', async () => {
    const client = mockClient({ extract: jest.fn() });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' }, inputData: { text: 'A' }, meta: { isLoadingSample: true } };
    const result = await appTester(App.creates.extract_claims.operation.perform, bundle);

    expect(result.status).toBe('ok');
    expect(Array.isArray(result.identified_claims)).toBe(true);
    expect(client.extract).not.toHaveBeenCalled();
  });
});

describe('creates.ask', () => {
  it('returns the reply content as answer', async () => {
    const client = mockClient({
      ask: { send: jest.fn().mockResolvedValue({ role: 'expert', content: 'Because sources say so.' }) },
    });
    LenzClient.mockImplementation(() => client);

    const bundle = {
      authData: { apiKey: 'lenz_good' },
      inputData: { verificationId: 'ab12cd34', question: 'Why?' },
    };
    const result = await appTester(App.creates.ask.operation.perform, bundle);

    expect(result).toEqual({ answer: 'Because sources say so.' });
    expect(client.ask.send).toHaveBeenCalledWith('ab12cd34', expect.objectContaining({ message: 'Why?' }));
  });

  it('stubs sample data and makes NO real call while loading a sample (no ask exchange spent; also handles the chained placeholder ID)', async () => {
    const client = mockClient({ ask: { send: jest.fn() } });
    LenzClient.mockImplementation(() => client);

    const bundle = {
      authData: { apiKey: 'lenz_good' },
      inputData: { verificationId: 'ab12cd34', question: 'Why?' },
      meta: { isLoadingSample: true },
    };
    const result = await appTester(App.creates.ask.operation.perform, bundle);

    expect(result.answer).toBeTruthy();
    expect(client.ask.send).not.toHaveBeenCalled();
  });
});
