/* globals describe, it, expect, jest */

const zapier = require('zapier-platform-core');

jest.mock('lenz-io', () => {
  const actual = jest.requireActual('lenz-io');
  return { ...actual, Lenz: jest.fn() };
});

const { Lenz: LenzClient, LenzAuthError, LenzError } = require('lenz-io');
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

  // The connect-time test now routes through mapLenzError, so a rejected key
  // produces the reconnect prompt rather than the raw SDK message. Note the
  // fixture carries `statusCode: 401` explicitly: the SDK defaults it to 0
  // when omitted, and it raises LenzAuthError for BOTH 401 and 403, so an
  // error without a status does not represent a real rejected key.
  it('turns a rejected key into a reconnect prompt', async () => {
    const client = mockClient({
      usage: jest
        .fn()
        .mockRejectedValue(new LenzAuthError({ message: 'Unauthorized', statusCode: 401 })),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_bad' } };
    const err = await appTester(App.authentication.test, bundle).then(
      () => null,
      (e) => e,
    );

    expect(err).not.toBeNull();
    expect(err.name).toBe('ExpiredAuthError');
    expect(err.message).toMatch(/reconnect/i);
  });

  // A 403 is a different problem — a private verification or an IP block — and
  // must NOT tell the user to reconnect a key that is working fine. Same SDK
  // class as the 401, which is why the mapping keys on the status.
  it('does not tell the user to reconnect on a 403', async () => {
    const client = mockClient({
      usage: jest
        .fn()
        .mockRejectedValue(new LenzAuthError({ message: 'Forbidden', statusCode: 403 })),
    });
    LenzClient.mockImplementation(() => client);

    const err = await appTester(App.authentication.test, { authData: { apiKey: 'lenz_x' } }).then(
      () => null,
      (e) => e,
    );

    expect(err.name).not.toBe('ExpiredAuthError');
    expect(err.message).toContain('Forbidden');
  });

  // A blip while connecting is not a bad key. Before mapLenzError was wired in
  // here, this surfaced as a raw SDK message during account setup.
  it('reports a transport failure at connect time as unreachable, not as a bad key', async () => {
    const transport = new LenzError({ message: 'fetch failed' });
    const client = mockClient({ usage: jest.fn().mockRejectedValue(transport) });
    LenzClient.mockImplementation(() => client);

    const err = await appTester(App.authentication.test, { authData: { apiKey: 'lenz_x' } }).then(
      () => null,
      (e) => e,
    );

    expect(err.name).toBe('ThrottledError');
    expect(err.message).toMatch(/could not reach lenz/i);
  });
});
