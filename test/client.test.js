/* globals describe, it, expect, jest, beforeEach, afterEach */

// These tests deliberately use the REAL lenz-io (no jest.mock) — the whole
// point is that the SDK honors our injected fetch and that our User-Agent
// survives all the way to the network layer.
const { Lenz, VERSION: SDK_VERSION } = require('lenz-io');

const { lenzClient, fetchAsZapier, USER_AGENT } = require('../client');

const APP_VERSION = require('../package.json').version;

// Mirrors lenz/api/client_detection.py:parse_client — Lenz attributes a client
// from the leading User-Agent token, splitting name/version on the first "/".
// Keeping a copy here means a UA change that would silently re-file Zap
// traffic as node_sdk fails in this repo, not weeks later in a Discord ping.
function parseClient(ua) {
  const token = String(ua || '').trim().split(/\s+/)[0] || '';
  const slash = token.indexOf('/');
  const name = (slash === -1 ? token : token.slice(0, slash)).toLowerCase();
  const version = slash === -1 ? '' : token.slice(slash + 1);
  return { name, version };
}

describe('User-Agent', () => {
  it('identifies the app as Zapier, not the Node SDK it wraps', () => {
    expect(USER_AGENT).toBe(`lenz-zapier/${APP_VERSION} (lenz-io-node ${SDK_VERSION})`);
  });

  it('parses server-side to the zapier source, carrying the app version', () => {
    const { name, version } = parseClient(USER_AGENT);
    expect(name).toBe('lenz-zapier');
    expect(version).toBe(APP_VERSION);
  });

  it('keeps the SDK version readable for debugging', () => {
    expect(USER_AGENT).toContain(`lenz-io-node ${SDK_VERSION}`);
  });
});

describe('fetchAsZapier', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('overrides an SDK-supplied User-Agent rather than sending both', async () => {
    const spy = jest.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = spy;

    await fetchAsZapier('https://lenz.io/api/v1/me/usage', {
      method: 'GET',
      headers: { 'User-Agent': 'lenz-io-node/9.9.9', Accept: 'application/json' },
    });

    const sent = new Headers(spy.mock.calls[0][1].headers);
    expect(sent.get('user-agent')).toBe(USER_AGENT);
    // Header names are case-insensitive, so a stray second value would show up
    // here as a comma-joined string.
    expect(sent.get('user-agent')).not.toContain(',');
  });

  it('preserves the SDK’s other headers', async () => {
    const spy = jest.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = spy;

    await fetchAsZapier('https://lenz.io/api/v1/me/usage', {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: 'Bearer lenz_test' },
    });

    const sent = new Headers(spy.mock.calls[0][1].headers);
    expect(sent.get('accept')).toBe('application/json');
    expect(sent.get('authorization')).toBe('Bearer lenz_test');
  });

  it('works when the SDK passes no headers at all', async () => {
    const spy = jest.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = spy;

    await fetchAsZapier('https://lenz.io/api/v1/me/usage', { method: 'GET' });

    const sent = new Headers(spy.mock.calls[0][1].headers);
    expect(sent.get('user-agent')).toBe(USER_AGENT);
  });
});

describe('lenzClient', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends the Zapier User-Agent through a real SDK call', async () => {
    // End-to-end over the real SDK: proves `fetch` injection is honored and
    // that our override beats the SDK's own hardcoded User-Agent.
    const spy = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ plan: 'free' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = spy;

    const client = lenzClient({ authData: { apiKey: 'lenz_test' } });
    await client.usage();

    expect(spy).toHaveBeenCalled();
    const sent = new Headers(spy.mock.calls[0][1].headers);
    expect(parseClient(sent.get('user-agent')).name).toBe('lenz-zapier');
    // The connected key still authenticates normally.
    expect(sent.get('authorization')).toBe('Bearer lenz_test');
  });

  it('returns a real Lenz instance', () => {
    expect(lenzClient({ authData: { apiKey: 'lenz_test' } })).toBeInstanceOf(Lenz);
  });
});
