/* globals describe, it, expect, jest, beforeEach, afterEach */

const zapier = require('zapier-platform-core');

jest.mock('lenz-io', () => {
  const actual = jest.requireActual('lenz-io');
  return { ...actual, Lenz: jest.fn() };
});

const { Lenz: LenzClient } = require('lenz-io');
const App = require('../index');

const appTester = zapier.createAppTester(App);

// The trigger calls `client.request` directly rather than
// `client.verifications.list`, because the SDK's list signature is `{ page }`
// only and cannot express a page size.
function mockClient(page) {
  return { request: jest.fn().mockResolvedValue(page) };
}

describe('triggers.new_verification', () => {
  it('aliases verification_id to id for Zapier dedupe', async () => {
    const client = mockClient({
      items: [
        { verification_id: 'ab12cd34', claim: 'A', verdict: 'True', created_at: '2026-07-14T12:00:00Z' },
        { verification_id: 'ef56gh78', claim: 'B', verdict: 'False', created_at: '2026-07-14T11:00:00Z' },
      ],
      total: 2,
      page: 1,
      page_size: 100,
    });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' } };
    const result = await appTester(App.triggers.new_verification.operation.perform, bundle);

    expect(result).toEqual([
      expect.objectContaining({ id: 'ab12cd34', verification_id: 'ab12cd34', claim: 'A' }),
      expect.objectContaining({ id: 'ef56gh78', verification_id: 'ef56gh78', claim: 'B' }),
    ]);
  });

  // The reason this trigger exists in its current form. Zapier polls every
  // 1-15 minutes and only reads page 1, so at the API's default of 20 an
  // account finishing more than 20 checks between polls silently loses the
  // oldest — they scroll off page 1 and the trigger never sees them. No error,
  // no gap, nothing to notice.
  it('asks for the largest page the server allows, not the default 20', async () => {
    const client = mockClient({ items: [], total: 0, page: 1, page_size: 100 });
    LenzClient.mockImplementation(() => client);

    await appTester(App.triggers.new_verification.operation.perform, {
      authData: { apiKey: 'lenz_good' },
    });

    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: '/verifications',
        query: { page: 1, page_size: 100 },
      }),
    );
  });

  it('passes key_finding through and defaults it to "" when the row omits it', async () => {
    const client = mockClient({
      items: [
        { verification_id: 'ab12cd34', claim: 'A', key_finding: 'Official figures confirm 330 metres.' },
        { verification_id: 'ef56gh78', claim: 'B' },
      ],
      total: 2,
      page: 1,
      page_size: 100,
    });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' } };
    const result = await appTester(App.triggers.new_verification.operation.perform, bundle);

    expect(result[0].key_finding).toBe('Official figures confirm 330 metres.');
    expect(result[1].key_finding).toBe('');
  });

  it('returns an empty array when there are no verifications yet', async () => {
    const client = mockClient({ items: [], total: 0, page: 1, page_size: 100 });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' } };
    const result = await appTester(App.triggers.new_verification.operation.perform, bundle);

    expect(result).toEqual([]);
  });
});

// The mocked suite above cannot prove the page size reaches the network: it
// asserts what we passed to our own mock. This runs the REAL SDK against a
// stubbed fetch, so the query string is the one the server would actually see.
describe('triggers.new_verification on the wire', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('puts page_size=100 in the request URL', async () => {
    const actual = jest.requireActual('lenz-io');
    LenzClient.mockImplementation((opts) => new actual.Lenz(opts));

    const spy = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [], total: 0, page: 1, page_size: 100 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = spy;

    await appTester(App.triggers.new_verification.operation.perform, {
      authData: { apiKey: 'lenz_good' },
    });

    expect(spy).toHaveBeenCalled();
    const url = new URL(spy.mock.calls[0][0]);
    expect(url.pathname).toContain('/verifications');
    expect(url.searchParams.get('page_size')).toBe('100');
    expect(url.searchParams.get('page')).toBe('1');
  });
});