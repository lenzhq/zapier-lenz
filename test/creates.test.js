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

  it('perform still makes the real submission while loading a sample, so a missing webhook secret still surfaces during testing', async () => {
    const client = mockClient({ verify: jest.fn().mockResolvedValue({ task_id: 'task_123' }) });
    LenzClient.mockImplementation(() => client);

    const bundle = {
      authData: { apiKey: 'lenz_good' },
      inputData: { claim: 'A different claim.' },
      meta: { isLoadingSample: true },
    };
    const result = await appTester(App.creates.verify_claim.operation.perform, bundle);

    // Real task_id from the real submission, merged with placeholder verdict
    // data (since the ~90s wait for the real verdict can't happen in a test).
    expect(result).toMatchObject({
      task_id: 'task_123',
      status: 'completed',
      verification_id: 'ab12cd34',
      claim: 'A different claim.',
    });
    expect(client.verify).toHaveBeenCalled();
  });

  it('perform surfaces the webhook-secret-missing error even while loading a sample (not just in a live run)', async () => {
    const apiError = new LenzValidationError({
      message: 'webhook_url was supplied but this API key has no HMAC secret.',
      statusCode: 422,
      body: { detail: 'webhook_url was supplied but this API key has no HMAC secret.', code: 'webhook_secret_missing' },
    });
    const client = mockClient({ verify: jest.fn().mockRejectedValue(apiError) });
    LenzClient.mockImplementation(() => client);

    const bundle = {
      authData: { apiKey: 'lenz_good' },
      inputData: { claim: 'The Eiffel Tower is 330 metres tall.' },
      meta: { isLoadingSample: true },
    };

    await expect(appTester(App.creates.verify_claim.operation.perform, bundle)).rejects.toThrow(
      /generate webhook secret/i,
    );
  });

  it('perform surfaces a clear, actionable message when the key has no webhook secret yet', async () => {
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

  it('still makes the real call while loading a sample — no async-wait problem to justify faking it', async () => {
    const client = mockClient({
      assess: jest.fn().mockResolvedValue({ claims: [{ claim: 'A', verdict: 'True', confidence: 'high' }] }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' }, inputData: { text: 'A' }, meta: { isLoadingSample: true } };
    const result = await appTester(App.creates.assess.operation.perform, bundle);

    expect(result.status).toBe('ok');
    expect(client.assess).toHaveBeenCalled();
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

  it('still makes the real call while loading a sample — it is free and has no async-wait problem', async () => {
    const client = mockClient({
      extract: jest.fn().mockResolvedValue({ status: 'ok', claim: 'A', identified_claims: ['A'] }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' }, inputData: { text: 'A' }, meta: { isLoadingSample: true } };
    const result = await appTester(App.creates.extract_claims.operation.perform, bundle);

    expect(result.status).toBe('ok');
    expect(Array.isArray(result.identified_claims)).toBe(true);
    expect(client.extract).toHaveBeenCalled();
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

  it('still makes the real call while loading a sample for a non-placeholder ID, so a bad ID or auth error surfaces during testing too', async () => {
    const client = mockClient({
      ask: { send: jest.fn().mockResolvedValue({ role: 'expert', content: 'Because sources say so.' }) },
    });
    LenzClient.mockImplementation(() => client);

    const bundle = {
      authData: { apiKey: 'lenz_good' },
      // A real (non-placeholder) ID a user typed in manually — must still
      // hit the real API even while isLoadingSample is true.
      inputData: { verificationId: 'a-real-verification-id', question: 'Why?' },
      meta: { isLoadingSample: true },
    };
    const result = await appTester(App.creates.ask.operation.perform, bundle);

    expect(result.answer).toBeTruthy();
    expect(client.ask.send).toHaveBeenCalledWith('a-real-verification-id', expect.anything());
  });

  it('short-circuits only for Verify a Claim’s exact known placeholder ID during sample loading', async () => {
    const client = mockClient({ ask: { send: jest.fn() } });
    LenzClient.mockImplementation(() => client);

    const bundle = {
      authData: { apiKey: 'lenz_good' },
      // ab12cd34 is verify_claim.js's own sample verification_id — chaining
      // the two steps in the editor always produces exactly this value.
      inputData: { verificationId: 'ab12cd34', question: 'Why?' },
      meta: { isLoadingSample: true },
    };
    const result = await appTester(App.creates.ask.operation.perform, bundle);

    expect(result.answer).toBeTruthy();
    expect(client.ask.send).not.toHaveBeenCalled();
  });
});
