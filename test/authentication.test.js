/* globals describe, it, expect, jest */

const zapier = require('zapier-platform-core');

jest.mock('lenz-io', () => {
  const actual = jest.requireActual('lenz-io');
  return { ...actual, Lenz: jest.fn() };
});

const { Lenz: LenzClient, LenzAuthError } = require('lenz-io');
const App = require('../index');

const appTester = zapier.createAppTester(App);

function mockClient(overrides = {}) {
  return { usage: jest.fn(), ...overrides };
}

describe('custom auth', () => {
  it('passes authentication and returns usage', async () => {
    const client = mockClient({
      usage: jest.fn().mockResolvedValue({
        plan: 'plus',
        quota_resets_at: null,
        verify: { quota_used: 1, quota_total: 50, quota_remaining: 49, credits: 0, remaining: 49 },
        ask: { quota_used: 0, quota_total: 20, quota_remaining: 20, credits: 0, remaining: 20 },
        assess: { quota_used: 0, quota_total: 100, quota_remaining: 100, credits: 0, remaining: 100 },
        extract: { calls_today: 0, daily_limit: 1000, unlimited: false },
      }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' } };
    const response = await appTester(App.authentication.test, bundle);

    expect(response.plan).toBe('plus');
    expect(client.usage).toHaveBeenCalledTimes(1);
  });

  it('fails on bad auth', async () => {
    const client = mockClient({
      usage: jest.fn().mockRejectedValue(new LenzAuthError({ message: 'Unauthorized' })),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_bad' } };
    await expect(appTester(App.authentication.test, bundle)).rejects.toThrow('Unauthorized');
  });
});
