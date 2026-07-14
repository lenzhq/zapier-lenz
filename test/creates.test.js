/* globals describe, it, expect, jest */

const zapier = require('zapier-platform-core');

jest.mock('lenz-io', () => {
  const actual = jest.requireActual('lenz-io');
  return { ...actual, Lenz: jest.fn() };
});

const { Lenz: LenzClient } = require('lenz-io');
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
});
