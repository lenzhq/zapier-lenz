/* globals describe, it, expect, jest, beforeAll, afterAll, beforeEach, afterEach */

// This app asks the Lenz API for responses in the version named by
// client.js API_VERSION, and gives every Zap the outputs it gave when it read
// the earlier version (2026-05-13).
//
// Both halves run the REAL lenz-io client with only `fetch` replaced:
//
//  1. Every request names the version: the SDK's calls and the two calls
//     authentication.js makes itself.
//  2. For each recorded API response, the earlier-version body and the
//     current-version body of the SAME result give the same output: every
//     key, every value. The only differences allowed are listed in ALLOWED,
//     each with its reason: sentences the API now words differently, and
//     answers the API now gives differently on purpose.
//
// Fixtures: test/fixtures/{legacy,canonical} are the two versions of each
// read the actions make (bodies only); test/fixtures/wire/{legacy,canonical}
// hold the calls an action starts with ({ status, headers, body }): receipts
// and refusals. All are the API's recorded responses with run-specific values
// replaced.

const fs = require('fs');
const path = require('path');
const zapier = require('zapier-platform-core');

const App = require('../index');
const { API_VERSION, USER_AGENT, lenzClient } = require('../client');
const { runWire } = require('./helpers/wire');
const { AUTH } = require('./helpers/oracle');

const appTester = zapier.createAppTester(App);
const VERSION_HEADER = 'x-lenz-api-version';
const WIRE = path.join(__dirname, 'fixtures', 'wire');

// zapier-platform-core ends the process once it has made 250 runs AND its
// memory passes 450 MB (tools/memory-checker.js), a guard for long-lived
// production workers. This file makes about 300 runs, which under coverage can
// cross both marks, so the guard is shown a small figure while it runs.
let memoryUsage;
beforeAll(() => {
  const real = process.memoryUsage.bind(process);
  memoryUsage = jest.spyOn(process, 'memoryUsage').mockImplementation(() => ({ ...real(), rss: 1 }));
});
afterAll(() => memoryUsage.mockRestore());

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// ─── 1. Every request names the version ─────────────────────────────────────

describe('the API version header', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('is the dated version this app reads', () => {
    expect(API_VERSION).toBe('2026-10-11');
  });

  it('replaces the version the SDK sends rather than sending two', async () => {
    const spy = jest.fn().mockResolvedValue(json(200, { plan: 'free' }));
    globalThis.fetch = spy;
    await lenzClient({ authData: { access_token: 'lat_good' } }).usage();
    const sent = new Headers(spy.mock.calls[0][1].headers);
    expect(sent.get(VERSION_HEADER)).toBe(API_VERSION);
    expect(sent.get('user-agent')).toBe(USER_AGENT);
  });

  it('is on the token call and the webhook-secret read at connect, and on a refresh', async () => {
    const env = { ...process.env };
    process.env.CLIENT_ID = 'zapier-client';
    process.env.CLIENT_SECRET = 's3cret';
    try {
      const token = { access_token: 'lat_new', token_type: 'Bearer', expires_in: 3600, refresh_token: 'lrt_new' };
      const spy = jest
        .fn()
        .mockResolvedValueOnce(json(200, token))
        .mockResolvedValueOnce(json(200, { webhook_secret: 'whsec_1' }))
        .mockResolvedValueOnce(json(200, token));
      globalThis.fetch = spy;
      const { getAccessToken, refreshAccessToken } = App.authentication.oauth2Config;
      await appTester(getAccessToken, {
        inputData: { code: 'c', redirect_uri: 'https://zapier.com/return/', code_verifier: 'v' },
      });
      await appTester(refreshAccessToken, { authData: { refresh_token: 'lrt_old', webhook_secret: 'whsec_1' } });
      const urls = spy.mock.calls.map(([url]) => String(url));
      expect(urls).toEqual([
        'https://lenz.io/api/v1/oauth/token',
        'https://lenz.io/api/v1/me/webhook-secret',
        'https://lenz.io/api/v1/oauth/token',
      ]);
      for (const [, init] of spy.mock.calls) {
        expect(new Headers(init.headers).get(VERSION_HEADER)).toBe(API_VERSION);
      }
    } finally {
      process.env = env;
    }
  });
});

// ─── 2. The same result gives the same output in either version ─────────────

// Differences between the two versions' outputs that are expected, by
// fixture and output key. Anything not listed here must be identical.
const SENTENCE = 'a sentence for people; the API words it differently now';
const ALLOWED = {
  // The failed poll's `error` is the API's sentence about the failure.
  verify__status_cancelled_durable: { error: SENTENCE },
  verify__status_failed_durable: { error: SENTENCE },
  verify__status_failed_durable_framing: { error: SENTENCE },
  verify__status_failed_live: { error: SENTENCE },
  verify__status_failed_live_retryable: { error: SENTENCE },
  verify__status_not_a_claim: { error: SENTENCE },
  verify__status_not_a_claim_durable: { error: SENTENCE },
  verify__status_task_stuck: { error: SENTENCE },
  // An extractor answer that said "nothing checkable" while still listing a
  // claim reads `ready` now: the API no longer says both at once.
  extract__not_a_claim_beside_claims: {
    status: 'the API now answers ready when it lists a claim',
    not_a_claim: 'follows status',
  },
  // Locations the locator dropped entirely: only reachable when locations are
  // asked for, which this action never does.
  extract__locate_all_dropped: { locations: 'needs a locate request; this action never sends one' },
};

const differences = (a, b, where = '', out = []) => {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  const objects = a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b);
  if (!objects) {
    out.push(where || '(root)');
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[k], b[k], `${where}.${k}`, out);
  return out;
};

const unexpected = (legacy, canonical) => {
  const found = [];
  for (const name of Object.keys(legacy)) {
    const allowed = ALLOWED[name] || {};
    for (const at of differences(legacy[name], canonical[name])) {
      const key = at.split('.')[1];
      if (!(key in allowed)) found.push(`${name}: ${at}`);
    }
  }
  return found;
};

describe('reads: one output for one result, whichever version', () => {
  let legacy;
  let canonical;
  beforeAll(async () => {
    legacy = await runWire({ App, appTester, jest, shape: 'legacy' });
    canonical = await runWire({ App, appTester, jest, shape: 'canonical' });
  });

  it('covers every recorded response, in both versions', () => {
    expect(Object.keys(canonical.outputs).sort()).toEqual(Object.keys(legacy.outputs).sort());
    expect(Object.keys(canonical.outputs).length).toBeGreaterThan(100);
  });

  it('gives identical outputs, but for the listed differences', () => {
    // The oversized review callback carries no review: the action reads it by
    // id, compared apart below.
    const skip = (o) => {
      const { webhook__review_completed_oversized_rebuilt: _skipped, ...rest } = o;
      return rest;
    };
    expect(unexpected(skip(legacy.outputs), skip(canonical.outputs))).toEqual([]);
  });

  it('every listed difference still happens (the list is not stale)', () => {
    for (const [name, keys] of Object.entries(ALLOWED)) {
      const at = differences(legacy.outputs[name], canonical.outputs[name]).map((p) => p.split('.')[1]);
      for (const key of Object.keys(keys)) expect(`${name}: ${at.includes(key)}`).toBe(`${name}: true`);
    }
  });

  it('reads nothing back when the signed callback carries the result', () => {
    // A needs_input callback is always read from the status route, and an
    // oversized review callback carries no review: both read by id.
    const byId = ['webhook__verification_needs_input_multi_claim', 'webhook__review_completed_oversized_rebuilt'];
    for (const run of [legacy, canonical]) {
      const reads = run.calls.filter((c) => c.fixture.startsWith('webhook__') && !byId.includes(c.fixture));
      expect(reads.map((c) => c.fixture)).toEqual([]);
    }
  });

  it('reads an oversized review callback by id', () => {
    const reads = canonical.calls.filter((c) => c.fixture === 'webhook__review_completed_oversized_rebuilt');
    expect(reads.map((c) => c.url)).toEqual(['https://lenz.io/api/v1/reviews/8fdbfca6']);
  });

  it('names the version on every read', () => {
    const calls = [...legacy.calls, ...canonical.calls];
    expect(calls.length).toBeGreaterThan(50);
    expect(calls.filter((c) => c.headers.get(VERSION_HEADER) !== API_VERSION)).toEqual([]);
  });
});

// The calls an action starts with: what each returns, or the error Zapier is
// handed, must be the same for the two versions of one response.
const START = {
  assess: (App_) => [App_.creates.assess.operation.perform, { authData: AUTH, inputData: { text: 'x' } }],
  extract: (App_) => [App_.creates.extract_claims.operation.perform, { authData: AUTH, inputData: { text: 'x' } }],
  verify: (App_) => [App_.creates.verify_claim.operation.perform, { authData: AUTH, inputData: { claim: 'x' } }],
  review: (App_) => [App_.creates.review_draft.operation.perform, { authData: AUTH, inputData: { text: 'x' } }],
  citecheck: (App_) => [App_.creates.check_citations.operation.perform, { authData: AUTH, inputData: { text: 'x' } }],
  ask: (App_) => [
    App_.creates.ask.operation.perform,
    { authData: AUTH, inputData: { verificationId: 'ab12cd34', question: 'Why?' } },
  ],
  // Testing a callback action in the editor reads /me/usage for one fact:
  // whether the connection has a webhook signing secret.
  usage: (App_) => [
    App_.creates.verify_claim.operation.perform,
    { authData: AUTH, inputData: { claim: 'x' }, meta: { isLoadingSample: true } },
  ],
};

// Which action makes the call each recorded response answers.
const ACTION_FOR = {
  errors__payment_required_assess: 'assess',
  errors__payment_required_verify: 'verify',
  errors__payment_required_ask: 'ask',
  review__402_no_credits: 'review',
  citecheck__402_no_credits: 'citecheck',
  errors__rate_limited_extract: 'extract',
  review__429_review_in_flight: 'review',
  citecheck__429_citecheck_in_flight: 'citecheck',
  errors__service_unavailable_capacity: 'assess',
  errors__service_unavailable_ask: 'ask',
  review__503_capacity: 'review',
  citecheck__503_citations_unavailable: 'citecheck',
  verify__capacity_503: 'verify',
  verify__idempotency_conflict_409: 'verify',
  review__idempotency_conflict_409: 'review',
  review__idempotency_conflict_409_existing_review: 'review',
  verify__webhook_secret_missing_422: 'verify',
  review__422_webhook_secret_missing: 'review',
  citecheck__422_webhook_secret_missing: 'citecheck',
  errors__ask_failed: 'ask',
  errors__auth_insufficient_scope: 'assess',
  verify__unauthenticated_401: 'verify',
  verify__submit_202: 'verify',
  verify__implicit_dedup_200: 'verify',
  review__receipt_202: 'review',
  citecheck__receipt_202: 'citecheck',
  account__me_usage_oauth: 'usage',
};

const outcome = (err) => {
  let message = String(err.message).split('\n')[0];
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed === 'object') message = JSON.stringify(parsed);
  } catch (e) {
    // not JSON
  }
  return { __error: { name: err.name, message } };
};

describe('calls an action starts: the same answer or error, whichever version', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const names = fs
    .readdirSync(path.join(WIRE, 'canonical'))
    .map((f) => f.slice(0, -5))
    .sort();

  it('every recorded response has an action', () => {
    expect(names.filter((n) => !ACTION_FOR[n])).toEqual([]);
    expect(fs.readdirSync(path.join(WIRE, 'legacy')).sort()).toEqual(names.map((n) => `${n}.json`));
  });

  it.each(names)('%s', async (name) => {
    const run = async (shape) => {
      const rec = JSON.parse(fs.readFileSync(path.join(WIRE, shape, `${name}.json`), 'utf-8'));
      const spy = jest.fn().mockResolvedValue(json(rec.status, rec.body, rec.headers));
      globalThis.fetch = spy;
      const [fn, bundle] = START[ACTION_FOR[name]](App);
      const out = await appTester(fn, bundle).then((r) => r, outcome);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(new Headers(spy.mock.calls[0][1].headers).get(VERSION_HEADER)).toBe(API_VERSION);
      return out;
    };
    const legacyOut = await run('legacy');
    const canonicalOut = await run('canonical');
    expect(canonicalOut).toEqual(legacyOut);
  });
});
