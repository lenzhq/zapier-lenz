/* globals describe, it, expect, jest, beforeAll, afterAll, beforeEach, afterEach */

// This app asks the Lenz API for responses in the version named by
// client.js API_VERSION (`2026-10-11`) and reads only that version's shape,
// into the outputs it has always given.
//
// Both halves run the REAL lenz-io client with only `fetch` replaced:
//
//  1. Every request names the version: the SDK's calls and the two calls
//     authentication.js makes itself.
//  2. Every recorded API response gives exactly the output recorded in
//     test/fixtures/oracle/outputs.json (`reads` and `starts`) before the app
//     stopped reading the earlier (`2026-05-13`) shape: every key, in order,
//     every value.
//
// Fixtures: test/fixtures/canonical holds the bodies of each read the actions
// make; test/fixtures/wire/canonical the calls an action starts with
// ({ status, headers, body }): receipts and refusals. All are the API's
// recorded responses with run-specific values replaced.

const fs = require('fs');
const path = require('path');
const zapier = require('zapier-platform-core');

const App = require('../index');
const { API_VERSION, USER_AGENT, lenzClient } = require('../client');
const { runWire } = require('./helpers/wire');
const { AUTH, loadOracle, normalize } = require('./helpers/oracle');

const appTester = zapier.createAppTester(App);
const VERSION_HEADER = 'x-lenz-api-version';
const WIRE = path.join(__dirname, 'fixtures', 'wire', 'canonical');
const ORACLE = loadOracle();

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

// ─── 2. Every recorded response gives the output it always has ──────────────

const mismatched = (expected, got) =>
  Object.keys(expected).filter((name) => JSON.stringify(normalize(got[name])) !== JSON.stringify(expected[name]));

describe('reads: the output each recorded response has always given', () => {
  let run;
  beforeAll(async () => {
    run = await runWire({ App, appTester, jest });
  });

  it('covers every recorded response', () => {
    expect(Object.keys(run.outputs).sort()).toEqual(Object.keys(ORACLE.reads).sort());
    expect(Object.keys(run.outputs).length).toBeGreaterThan(100);
  });

  it('gives the recorded outputs, serialized (key order included)', () => {
    expect(mismatched(ORACLE.reads, run.outputs)).toEqual([]);
  });

  it('reads nothing back when the signed callback carries the result', () => {
    // A needs_input callback is always read from the status route, and an
    // oversized review callback carries no review: both read by id.
    const byId = ['webhook__verification_needs_input_multi_claim', 'webhook__review_completed_oversized_rebuilt'];
    const reads = run.calls.filter((c) => c.fixture.startsWith('webhook__') && !byId.includes(c.fixture));
    expect(reads.map((c) => c.fixture)).toEqual([]);
  });

  it('reads an oversized review callback by id', () => {
    const reads = run.calls.filter((c) => c.fixture === 'webhook__review_completed_oversized_rebuilt');
    expect(reads.map((c) => c.url)).toEqual(['https://lenz.io/api/v1/reviews/8fdbfca6']);
  });

  it('every read reached the network, signed in', () => {
    const reads = Object.keys(run.outputs).filter((n) => !n.startsWith('webhook__'));
    const fetched = new Set(run.calls.map((c) => c.fixture));
    expect(reads.filter((n) => !fetched.has(n))).toEqual([]);
    expect(reads.filter((n) => run.outputs[n].__error)).toEqual([]);
    expect(run.calls.filter((c) => c.headers.get('authorization') !== `Bearer ${AUTH.access_token}`)).toEqual([]);
    expect(Object.keys(run.outputs).filter((n) => /^(review|citecheck)__get/.test(n)).length).toBeGreaterThan(30);
  });

  it('names the version on every read', () => {
    expect(run.calls.length).toBeGreaterThan(50);
    expect(run.calls.filter((c) => c.headers.get(VERSION_HEADER) !== API_VERSION)).toEqual([]);
  });
});

// The calls an action starts with: what each returns, or the error Zapier is
// handed, must be what it has always been.
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
  review__402_no_credits_exhausted: 'review',
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

describe('calls an action starts: the answer or error each has always given', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const names = fs
    .readdirSync(WIRE)
    .map((f) => f.slice(0, -5))
    .sort();

  it('every recorded response has an action and a recorded output', () => {
    expect(names.filter((n) => !ACTION_FOR[n])).toEqual([]);
    expect(names).toEqual(Object.keys(ORACLE.starts).sort());
  });

  it.each(names)('%s', async (name) => {
    const rec = JSON.parse(fs.readFileSync(path.join(WIRE, `${name}.json`), 'utf-8'));
    const spy = jest.fn().mockResolvedValue(json(rec.status, rec.body, rec.headers));
    globalThis.fetch = spy;
    const [fn, bundle] = START[ACTION_FOR[name]](App);
    const out = await appTester(fn, bundle).then((r) => r, outcome);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(new Headers(spy.mock.calls[0][1].headers).get(VERSION_HEADER)).toBe(API_VERSION);
    expect(JSON.stringify(normalize(out))).toBe(JSON.stringify(ORACLE.starts[name]));
  });
});

// Targeted cases the recorded responses do not cover.
describe('values the API carries differently from the output', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // A citation refusal can state the balance only as `remaining`, counted in
  // credits on these two calls.
  it.each([
    ['review', 'review_draft'],
    ['citecheck', 'check_citations'],
  ])('%s: an out-of-credits refusal still names the balance', async (_label, key) => {
    globalThis.fetch = jest.fn().mockResolvedValue(
      json(402, {
        detail: 'No remaining credits for citation checks.',
        code: 'no_credits',
        docs_url: 'https://lenz.io/docs/errors#quota',
        upgrade_url: 'https://lenz.io/plans',
        remaining: 7,
        cost: 9,
      }),
    );
    const err = await appTester(App.creates[key].operation.perform, { authData: AUTH, inputData: { text: 'x' } }).then(
      () => null,
      (e) => e,
    );
    expect(err.name).toBe('HaltedError');
    expect(err.message).toContain('This call costs 9 credits and you have 7 left.');
  });

  it('a verify refusal does not read `remaining` (checks, not credits) as the balance', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(json(402, { detail: 'No remaining claim checks.', code: 'no_credits', remaining: 3, cost: 10 }));
    const err = await appTester(App.creates.verify_claim.operation.perform, {
      authData: AUTH,
      inputData: { claim: 'x' },
    }).then(
      () => null,
      (e) => e,
    );
    expect(err.message).toContain('This call costs 10 credits.');
    expect(err.message).not.toContain('left');
  });

  describe('a failed review or citation check reads its error as it always has', () => {
    const { shapeJobFailure } = require('../lib/jobs');
    const block = (over) => ({
      code: 'timeout',
      detail: 'The check did not finish inside its time budget.',
      hint: null,
      failure_class: 'upstream_unavailable',
      retryable: true,
      docs_url: 'https://lenz.io/docs/errors#upstream-unavailable',
      ...over,
    });

    it('no hint: the code', () => {
      expect(shapeJobFailure(block({})).error).toBe('timeout');
    });

    it('a hint: the hint', () => {
      expect(shapeJobFailure(block({ hint: 'Retry.' })).error).toBe('Retry.');
    });

    it('assessment_failed: the sentence the earlier hint opened with, then the hint', () => {
      const f = block({ code: 'assessment_failed', detail: 'No claim could be assessed.', hint: 'Retry it.' });
      expect(shapeJobFailure(f).error).toBe('No claim could be assessed. Retry it.');
      expect(shapeJobFailure({ ...f, hint: null }).error).toBe('No claim could be assessed.');
    });
  });
});

// One place that lists every endpoint this app calls and holds each to the
// version: the reads, the calls each action starts with, and the two calls
// authentication.js makes itself (the token endpoint and the webhook-secret
// read), each through the same fetch.
describe('every endpoint the app calls sends the version', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends X-Lenz-API-Version: 2026-10-11 on every call', async () => {
    const seen = [];
    const record = (reply) =>
      jest.fn(async (url, init = {}) => {
        const u = new URL(String(url));
        const route = u.pathname.replace(/\/[0-9a-f]{8,32}(?=\/|$)/g, '/{id}');
        seen.push({ call: `${init.method || 'GET'} ${route}`, version: new Headers(init.headers || {}).get(VERSION_HEADER) });
        return reply();
      });

    // Every action's first call, from the recorded receipts and refusals.
    for (const f of fs.readdirSync(WIRE).sort()) {
      const name = f.slice(0, -5);
      const rec = JSON.parse(fs.readFileSync(path.join(WIRE, f), 'utf-8'));
      globalThis.fetch = record(() => json(rec.status, rec.body, rec.headers));
      const [fn, bundle] = START[ACTION_FOR[name]](App);
      await appTester(fn, bundle).catch(() => null);
    }
    // Every read: polls, reads by id, the trigger's list.
    const run = await runWire({ App, appTester, jest });
    for (const c of run.calls) {
      const route = new URL(c.url).pathname.replace(/\/[0-9a-f]{8,32}(?=\/|$)/g, '/{id}');
      seen.push({ call: `${c.method} ${route}`, version: c.headers.get(VERSION_HEADER) });
    }
    // Connect and refresh.
    const env = { ...process.env };
    process.env.CLIENT_ID = 'zapier-client';
    process.env.CLIENT_SECRET = 's3cret';
    try {
      const token = { access_token: 'lat_new', token_type: 'Bearer', expires_in: 3600, refresh_token: 'lrt_new' };
      const replies = [token, { webhook_secret: 'whsec_1' }, token];
      globalThis.fetch = record(() => json(200, replies.shift()));
      const { getAccessToken, refreshAccessToken } = App.authentication.oauth2Config;
      await appTester(getAccessToken, {
        inputData: { code: 'c', redirect_uri: 'https://zapier.com/return/', code_verifier: 'v' },
      });
      await appTester(refreshAccessToken, { authData: { refresh_token: 'lrt_old', webhook_secret: 'whsec_1' } });
    } finally {
      process.env = env;
    }

    const calls = [...new Set(seen.map((s) => s.call))].sort();
    // Exactly these: a new endpoint joins the list when the app starts calling it.
    expect(calls).toEqual([
      'GET /api/v1/citechecks/{id}',
      'GET /api/v1/me/usage',
      'GET /api/v1/me/webhook-secret',
      'GET /api/v1/reviews/{id}',
      'GET /api/v1/verifications',
      'GET /api/v1/verify/status/{id}',
      'POST /api/v1/ask/{id}',
      'POST /api/v1/assess',
      'POST /api/v1/citecheck',
      'POST /api/v1/extract',
      'POST /api/v1/oauth/token',
      'POST /api/v1/review',
      'POST /api/v1/verify',
    ]);
    expect(seen.filter((s) => s.version !== API_VERSION)).toEqual([]);
  });
});
