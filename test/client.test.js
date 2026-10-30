/* globals describe, it, expect, jest, beforeEach, afterEach */

// These tests deliberately use the REAL lenz-io (no jest.mock) — the whole
// point is that the SDK honors our injected fetch and that our User-Agent
// survives all the way to the network layer.
const { Lenz, VERSION: SDK_VERSION } = require('lenz-io');

const { lenzClient, fetchAsZapier, USER_AGENT, CALL_TIMEOUT_MS } = require('../client');
const { mapLenzError } = require('../lib/errors');

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

    const client = lenzClient({ authData: { access_token: 'lenz_test' } });
    await client.usage();

    expect(spy).toHaveBeenCalled();
    const sent = new Headers(spy.mock.calls[0][1].headers);
    expect(parseClient(sent.get('user-agent')).name).toBe('lenz-zapier');
    // The connected key still authenticates normally.
    expect(sent.get('authorization')).toBe('Bearer lenz_test');
  });

  it('returns a real Lenz instance', () => {
    expect(lenzClient({ authData: { access_token: 'lenz_test' } })).toBeInstanceOf(Lenz);
  });
});

// Zapier kills a `perform` at ~30s. On the SDK's defaults (timeoutMs 30s PER
// ATTEMPT, maxRetries 3, backoff 1+2+4s, and a stated Retry-After up to 60s
// slept through in-process) one call could occupy over two minutes — so the
// user got Zapier's own timeout, a hard error counting toward auto-disable,
// instead of anything lib/errors.js would have mapped.
//
// These run the REAL SDK against a stubbed fetch, so they measure the retry
// loop itself rather than our belief about it.
describe('retry budget fits inside Zapier’s run budget', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // A minimal stand-in for Zapier's `z.errors`. Deliberately not appTester:
  // what is under test is the SDK's timing plus our mapping, not the
  // platform's error serialisation (covered in test/errors.test.js).
  const zStub = {
    errors: {
      Error: class ZError extends Error {},
      HaltedError: class HaltedError extends Error {},
      ExpiredAuthError: class ExpiredAuthError extends Error {},
      ThrottledError: class ThrottledError extends Error {
        constructor(message, delay) {
          super(message);
          this.name = 'ThrottledError';
          this.delay = delay;
        }
      },
    },
  };

  it('surfaces a 429 with a stated 45s wait immediately, instead of sleeping it', async () => {
    const spy = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Rate limited' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'Retry-After': '45' },
      }),
    );
    globalThis.fetch = spy;

    const client = lenzClient({ authData: { access_token: 'lenz_test' } });
    const startedAt = Date.now();
    const err = await client.usage().then(
      () => null,
      (e) => e,
    );
    const elapsedMs = Date.now() - startedAt;

    // 45 is under the SDK's 60s sleep ceiling, so on the old defaults this
    // slept 45s in-process and Zapier killed the run first.
    expect(elapsedMs).toBeLessThan(5000);
    expect(spy).toHaveBeenCalledTimes(1);

    // And the wait survives to Zapier, which does the waiting for us.
    const mapped = (() => {
      try {
        return mapLenzError(zStub, err);
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(mapped.name).toBe('ThrottledError');
    expect(mapped.delay).toBe(45);
  });

  it('makes exactly one attempt on a transport failure', async () => {
    // Four attempts plus 1+2+4s of backoff before this change.
    const spy = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    globalThis.fetch = spy;

    const client = lenzClient({ authData: { access_token: 'lenz_test' } });
    const startedAt = Date.now();
    await client.usage().catch(() => {});

    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('makes exactly one attempt on a 5xx', async () => {
    const spy = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Bad gateway' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = spy;

    const client = lenzClient({ authData: { access_token: 'lenz_test' } });
    await client.usage().catch(() => {});

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('leaves the per-call timeout just under Zapier’s limit, not well under it', () => {
    // With one attempt this is the WHOLE budget, so the floor matters as much
    // as the ceiling. /extract takes up to 50,000 characters with no
    // server-side wall-clock deadline, so a large document can legitimately
    // land in the 25-30s band; cutting the timeout to "be safe" fails calls
    // that succeed today. Everything after the abort is synchronous, so 2s of
    // headroom is plenty.
    expect(CALL_TIMEOUT_MS).toBeLessThan(30000);
    expect(CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(28000);
  });
});

// The wire→app seam (#23). Every create test mocks `lenz-io` wholesale and
// feeds `mapLenzError` hand-built errors, so nothing there proves a REAL
// response becomes the right Zapier outcome. These run the real SDK against a
// stubbed fetch whose bodies are the ones the server builds in the 2026-10-11
// shape the app asks for (lenz/api/quota_errors.py `quota_exceeded`,
// lenz/api/service_errors.py `service_unavailable`). The outcomes pinned here
// decide a user's Zap: a 402 must HALT (no error-rate count, so a spent
// balance never auto-disables the Zap) and a typed 503 must THROTTLE with the
// server's wait. If a future SDK renamed a field, the hand-built tests would
// stay green while these fail.
describe('real wire errors reach the right Zapier outcome', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const zStub = {
    errors: {
      Error: class ZError extends Error {},
      HaltedError: class HaltedError extends Error {},
      ExpiredAuthError: class ExpiredAuthError extends Error {},
      RefreshAuthError: class RefreshAuthError extends Error {},
      ThrottledError: class ThrottledError extends Error {
        constructor(message, delay) {
          super(message);
          this.delay = delay;
        }
      },
    },
  };

  const respond = (status, body, headers = {}) => {
    globalThis.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
    );
  };

  // The SDK error from one real call, run through the app's mapping.
  const outcomeOf = async (call, options) => {
    const client = lenzClient({ authData: { access_token: 'lat_test' } });
    const err = await call(client).then(
      () => null,
      (e) => e,
    );
    expect(err).not.toBeNull();
    try {
      mapLenzError(zStub, err, options);
    } catch (thrown) {
      return thrown;
    }
    throw new Error('mapLenzError returned instead of throwing');
  };

  const QUOTA = {
    detail: 'Not enough credits for this call.',
    code: 'no_credits',
    docs_url: 'https://lenz.io/docs/errors#quota',
    upgrade_url: 'https://lenz.io/plans?wall=w1',
  };

  it('402 with cost and balance: halts, quoting both and the upgrade link', async () => {
    respond(402, { ...QUOTA, cost: 10, credits_remaining: 4, resets_at: '2026-11-01T00:00:00Z' });

    const out = await outcomeOf((c) => c.usage());

    expect(out).toBeInstanceOf(zStub.errors.HaltedError);
    expect(out.message).toContain('This call costs 10 credits and you have 4 left.');
    expect(out.message).toContain('https://lenz.io/plans?wall=w1');
    expect(out.message).toContain('wait for the reset at 2026-11-01T00:00:00Z');
  });

  it('402 with the cost alone (no balance resolved): halts, quoting only the cost', async () => {
    // The server omits credits_remaining when it is unresolvable, never null.
    respond(402, { ...QUOTA, cost: 10 });

    const out = await outcomeOf((c) => c.usage());

    expect(out).toBeInstanceOf(zStub.errors.HaltedError);
    expect(out.message).toContain('This call costs 10 credits.');
    expect(out.message).not.toMatch(/left\./);
    expect(out.message).toContain('wait for the monthly reset');
  });

  it('402 on a citation check: reads the balance from `remaining`, which the server sends in credits there', async () => {
    // A citation costs one credit, so the canonical body drops
    // credits_remaining and keeps `remaining` (quota_errors.py).
    respond(402, { ...QUOTA, cost: 3, remaining: 2 });

    const out = await outcomeOf((c) => c.citecheck({ text: 'A draft with [a link](https://example.com).' }), {
      remainingIsCredits: true,
    });

    expect(out).toBeInstanceOf(zStub.errors.HaltedError);
    expect(out.message).toContain('This call costs 3 credits and you have 2 left.');
  });

  it('402 on a call that costs nothing: halts without sizing a top-up', async () => {
    respond(402, { ...QUOTA, code: 'plan_required', cost: 0, credits_remaining: 0 });

    const out = await outcomeOf((c) => c.usage());

    expect(out).toBeInstanceOf(zStub.errors.HaltedError);
    expect(out.message).not.toMatch(/costs|left\./);
  });

  it('503 capacity: throttles with the wait the server stated, in one attempt', async () => {
    respond(
      503,
      {
        detail: 'Lenz is at capacity. Please retry shortly.',
        code: 'capacity',
        retry_after: 95,
        docs_url: 'https://lenz.io/docs/errors#unavailable',
      },
      { 'Retry-After': '95' },
    );

    const out = await outcomeOf((c) => c.usage());

    expect(out).toBeInstanceOf(zStub.errors.ThrottledError);
    expect(out.delay).toBe(95);
    expect(out.message).toContain('Lenz is at capacity right now');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('503 capacity with the header stripped by a proxy: still throttles with the body’s wait', async () => {
    respond(503, { detail: 'At capacity.', code: 'capacity', retry_after: 95 });

    const out = await outcomeOf((c) => c.usage());

    expect(out).toBeInstanceOf(zStub.errors.ThrottledError);
    expect(out.delay).toBe(95);
  });

  it('an untyped 502: throttles as a temporary failure', async () => {
    respond(502, { detail: 'Bad gateway' });

    const out = await outcomeOf((c) => c.usage());

    expect(out).toBeInstanceOf(zStub.errors.ThrottledError);
    expect(out.message).toContain('temporary 502');
  });
});
