/* globals describe, it, expect, jest, beforeEach, afterEach */

// OAuth (Lenz#873). Two halves:
//
// - The token requests (getAccessToken / refreshAccessToken / the webhook
//   secret mint). They go through plain `fetch` (see authentication.js for why
//   not z.request), so global fetch is stubbed at the boundary and the tests
//   assert what actually goes on the wire: the Basic header, the form body.
// - Verify's finishing step (performResume) reading the SIGNED callback, and
//   every way it falls back to the status route.

const crypto = require('crypto');
const zapier = require('zapier-platform-core');

jest.mock('lenz-io', () => {
  const actual = jest.requireActual('lenz-io');
  return { ...actual, Lenz: jest.fn() };
});

const { Lenz: LenzClient } = require('lenz-io');
const App = require('../index');
const { USER_AGENT } = require('../client');

const appTester = zapier.createAppTester(App);
const { getAccessToken, refreshAccessToken } = App.authentication.oauth2Config;

const capture = (fn, bundle) =>
  appTester(fn, bundle).then(
    () => null,
    (e) => e,
  );

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const TOKEN_OK = { access_token: 'lat_new', token_type: 'Bearer', expires_in: 3600, scope: 'verify', refresh_token: 'lrt_new' };

describe('OAuth token requests', () => {
  let originalFetch;
  let originalEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = { ...process.env };
    process.env.CLIENT_ID = 'zapier-client';
    process.env.CLIENT_SECRET = 's3cret';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  const connectBundle = {
    inputData: { code: 'code-1', redirect_uri: 'https://zapier.com/return/', code_verifier: 'verifier-1' },
  };

  describe('getAccessToken (connect)', () => {
    it('sends client credentials as HTTP Basic, never in the body — the issuer accepts nothing else', async () => {
      const spy = jest
        .fn()
        .mockResolvedValueOnce(json(TOKEN_OK))
        .mockResolvedValueOnce(json({ webhook_secret: 'whsec_1' }));
      globalThis.fetch = spy;

      await appTester(getAccessToken, connectBundle);

      const [url, init] = spy.mock.calls[0];
      expect(url).toBe('https://lenz.io/api/v1/oauth/token');
      expect(init.method).toBe('POST');
      const headers = new Headers(init.headers);
      expect(headers.get('Authorization')).toBe(`Basic ${Buffer.from('zapier-client:s3cret').toString('base64')}`);
      expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
      expect(headers.get('User-Agent')).toBe(USER_AGENT);

      const form = new URLSearchParams(init.body);
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('code')).toBe('code-1');
      expect(form.get('redirect_uri')).toBe('https://zapier.com/return/');
      expect(form.get('code_verifier')).toBe('verifier-1');
      expect(form.has('client_id')).toBe(false);
      expect(form.has('client_secret')).toBe(false);
    });

    // A grant has no webhook secret until it is fetched, and without one
    // `/verify` refuses a webhook_url. Minting at connect makes a failure
    // visible HERE, not on a later Verify run.
    it('mints the webhook secret with the new token and stores it with the connection', async () => {
      const spy = jest
        .fn()
        .mockResolvedValueOnce(json(TOKEN_OK))
        .mockResolvedValueOnce(json({ webhook_secret: 'whsec_1' }));
      globalThis.fetch = spy;

      const authData = await appTester(getAccessToken, connectBundle);

      const [url, init] = spy.mock.calls[1];
      expect(url).toBe('https://lenz.io/api/v1/me/webhook-secret');
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer lat_new');
      expect(authData).toEqual({ access_token: 'lat_new', refresh_token: 'lrt_new', webhook_secret: 'whsec_1' });
    });

    it('fails the CONNECTION when the secret cannot be minted', async () => {
      globalThis.fetch = jest
        .fn()
        .mockResolvedValueOnce(json(TOKEN_OK))
        .mockResolvedValueOnce(json({ detail: 'boom' }, 500));

      const err = await capture(getAccessToken, connectBundle);

      expect(err.name).toBe('AppError');
      expect(err.message).toMatch(/webhook signing secret/);
    });

    // Through z.request a 401 here would have become a bare RefreshAuthError
    // (Zapier's stale-auth middleware runs before the app sees the body). The
    // connect dialog must show Lenz's real reason instead.
    it('surfaces the OAuth error code on a refused exchange, not a refresh error', async () => {
      globalThis.fetch = jest.fn().mockResolvedValueOnce(json({ error: 'invalid_client' }, 401));

      const err = await capture(getAccessToken, connectBundle);

      expect(err.name).toBe('AppError');
      expect(err.message).toContain('invalid_client');
    });
  });

  describe('refreshAccessToken', () => {
    const refreshBundle = { authData: { access_token: 'lat_old', refresh_token: 'lrt_old', webhook_secret: 'whsec_1' } };

    it('stores the ROTATED refresh token and carries the webhook secret forward', async () => {
      const spy = jest.fn().mockResolvedValueOnce(json(TOKEN_OK));
      globalThis.fetch = spy;

      const authData = await appTester(refreshAccessToken, refreshBundle);

      const form = new URLSearchParams(spy.mock.calls[0][1].body);
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('refresh_token')).toBe('lrt_old');
      expect(authData).toEqual({ access_token: 'lat_new', refresh_token: 'lrt_new', webhook_secret: 'whsec_1' });
    });

    it('keeps the old refresh token when the response carries none', async () => {
      const { refresh_token, ...noRefresh } = TOKEN_OK; // eslint-disable-line no-unused-vars
      globalThis.fetch = jest.fn().mockResolvedValueOnce(json(noRefresh));

      const authData = await appTester(refreshAccessToken, refreshBundle);

      expect(authData.refresh_token).toBe('lrt_old');
    });

    // The mapping below is lenz-mcp's (exchange.py `_failure`): by OAuth error
    // code, never by HTTP status.
    it('asks the user to reconnect on invalid_grant — the grant is really dead', async () => {
      globalThis.fetch = jest.fn().mockResolvedValueOnce(json({ error: 'invalid_grant' }, 400));

      const err = await capture(refreshAccessToken, refreshBundle);

      expect(err.name).toBe('ExpiredAuthError');
      expect(err.message).toMatch(/reconnect/i);
    });

    it.each(['invalid_client', 'invalid_request', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope'])(
      'does NOT ask users to reconnect on %s — that is this app misconfigured, and reconnecting cannot fix it',
      async (code) => {
        globalThis.fetch = jest.fn().mockResolvedValueOnce(json({ error: code }, code === 'invalid_client' ? 401 : 400));

        const err = await capture(refreshAccessToken, refreshBundle);

        expect(err.name).toBe('AppError');
        expect(err.name).not.toBe('ExpiredAuthError');
        expect(err.message).toContain(code);
        expect(err.message).toMatch(/reconnecting will not help/);
      },
    );

    it('treats a malformed 200 as an issuer problem, not a dead connection', async () => {
      globalThis.fetch = jest.fn().mockResolvedValueOnce(json({ token_type: 'Bearer' }));

      const err = await capture(refreshAccessToken, refreshBundle);

      expect(err.name).toBe('AppError');
      expect(err.message).toContain('malformed_response');
    });

    it('replays after the stated wait when the issuer is busy', async () => {
      globalThis.fetch = jest
        .fn()
        .mockResolvedValueOnce(json({ error: 'temporarily_unavailable' }, 503, { 'Retry-After': '30' }));

      const err = await capture(refreshAccessToken, refreshBundle);

      expect(err.name).toBe('ThrottledError');
      expect(JSON.parse(err.message).delay).toBe(30);
    });

    it('replays after 60s on a 5xx with no stated wait', async () => {
      globalThis.fetch = jest.fn().mockResolvedValueOnce(json({}, 502));

      const err = await capture(refreshAccessToken, refreshBundle);

      expect(err.name).toBe('ThrottledError');
      expect(JSON.parse(err.message).delay).toBe(60);
    });

    it('retries one dropped connection, then succeeds', async () => {
      const spy = jest.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(json(TOKEN_OK));
      globalThis.fetch = spy;

      const authData = await appTester(refreshAccessToken, refreshBundle);

      expect(spy).toHaveBeenCalledTimes(2);
      expect(authData.access_token).toBe('lat_new');
    });

    it('replays when the connection drops twice', async () => {
      globalThis.fetch = jest.fn().mockRejectedValue(new TypeError('fetch failed'));

      const err = await capture(refreshAccessToken, refreshBundle);

      expect(err.name).toBe('ThrottledError');
    });
  });

  describe('configuration', () => {
    const cfg = App.authentication.oauth2Config;

    it('is OAuth 2 with PKCE and auto-refresh', () => {
      expect(App.authentication.type).toBe('oauth2');
      expect(cfg.enablePkce).toBe(true);
      expect(cfg.autoRefresh).toBe(true);
    });

    // No history:write: the app has no delete action, so it never asks for
    // the permission. offline_access is what makes the issuer issue a refresh
    // token at all.
    it('asks for exactly the scopes the app uses, plus offline_access', () => {
      expect(cfg.scope.split(' ').sort()).toEqual(
        ['ask', 'ask:read', 'assess', 'extract', 'history:read', 'offline_access', 'usage:read', 'verify', 'webhooks:manage'].sort(),
      );
      expect(cfg.scope).not.toContain('history:write');
    });

    it('authorizes at lenz.io with the code flow', () => {
      expect(cfg.authorizeUrl.url).toBe('https://lenz.io/oauth2/authorize');
      expect(cfg.authorizeUrl.params.response_type).toBe('code');
    });
  });
});

// ─── Verify's finishing step: the signed callback ─────────────────────────────

const SECRET = 'whsec_test';
const TASK = 'task_123';

const sign = (body, secret = SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(Buffer.from(body, 'utf-8')).digest('hex')}`;

const RESULT = {
  verification_id: 'ab12cd34',
  claim: 'The Eiffel Tower is 330 metres tall.',
  verdict: 'True',
  confidence: 'high',
  lenz_score: 9,
  key_finding: 'Official figures confirm 330 metres.',
  executive_summary: 'Confirmed.',
  sources: [{ title: 'Official site', url: 'https://www.toureiffel.paris' }],
};

const callback = (payload, { secret = SECRET, headerName = 'Http-X-Lenz-Signature', signature } = {}) => {
  const content = JSON.stringify(payload);
  return {
    content,
    headers: { 'Http-Content-Type': 'application/json', [headerName]: signature || sign(content, secret) },
  };
};

const completed = (over = {}) => ({
  event: 'verification.completed',
  task_id: TASK,
  status: 'completed',
  delivered_at: new Date().toISOString(),
  verification_id: 'ab12cd34',
  result: RESULT,
  ...over,
});

describe('performResume reads the signed callback', () => {
  const resumeBundle = (rawRequest, over = {}) => ({
    authData: { access_token: 'lat_expired', webhook_secret: SECRET },
    outputData: { task_id: TASK, status: 'processing' },
    rawRequest,
    ...over,
  });

  // The client is mocked; if the callback path is taken it must never be
  // called — that is the whole point: no token is needed.
  const mockStatusClient = (status) => {
    const client = { getStatus: jest.fn().mockResolvedValue(status) };
    LenzClient.mockImplementation(() => client);
    return client;
  };

  it('returns the result from a valid signed callback without calling the API', async () => {
    const client = mockStatusClient({ status: 'processing' });

    const out = await appTester(App.creates.verify_claim.operation.performResume, resumeBundle(callback(completed())));

    expect(client.getStatus).not.toHaveBeenCalled();
    expect(out).toMatchObject({ task_id: TASK, status: 'completed', passed: true, verdict: 'True', verification_id: 'ab12cd34' });
  });

  it('reads the signature whatever case Zapier gives the header', async () => {
    const client = mockStatusClient({ status: 'processing' });

    const out = await appTester(
      App.creates.verify_claim.operation.performResume,
      resumeBundle(callback(completed(), { headerName: 'x-lenz-signature' })),
    );

    expect(client.getStatus).not.toHaveBeenCalled();
    expect(out.status).toBe('completed');
  });

  it('shapes a failed callback the same way the status route does', async () => {
    const client = mockStatusClient({ status: 'processing' });
    const failed = {
      event: 'verification.failed',
      task_id: TASK,
      status: 'failed',
      delivered_at: new Date().toISOString(),
      error: 'No sources found.',
      failure_reason: 'research',
      failure_class: 'insufficient_evidence',
      retryable: false,
    };

    const out = await appTester(App.creates.verify_claim.operation.performResume, resumeBundle(callback(failed)));

    expect(client.getStatus).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      status: 'failed',
      error: 'No sources found.',
      failure_reason: 'research',
      failure_class: 'insufficient_evidence',
      retryable: false,
      verdict: null,
    });
  });

  // Every one of these must fall back to getStatus — exactly what this step
  // did before OAuth — and never shape a result from an untrusted body.
  const fallbacks = [
    ['the signature is wrong', () => callback(completed(), { secret: 'someone-else' })],
    ['the signature header is missing', () => ({ content: JSON.stringify(completed()), headers: {} })],
    ['the body is older than the 300 s replay window', () => callback(completed({ delivered_at: new Date(Date.now() - 600000).toISOString() }))],
    // The secret is per CONNECTION, not per Verify: a genuine signed body for
    // another Verify must never become this one's answer.
    ['the callback is for a different task', () => callback(completed({ task_id: 'task_other' }))],
    ['the completed callback carries no result', () => callback(completed({ result: {} }))],
    ['it is a needs_input event (read from the status route)', () => callback({ event: 'verification.needs_input', task_id: TASK, status: 'needs_input', delivered_at: new Date().toISOString(), needs_input: {} })],
    ['there is no raw body at all', () => undefined],
  ];

  it.each(fallbacks)('falls back to getStatus when %s', async (_why, raw) => {
    const client = mockStatusClient({ status: 'completed', result: RESULT });

    const out = await appTester(App.creates.verify_claim.operation.performResume, resumeBundle(raw()));

    expect(client.getStatus).toHaveBeenCalledWith(TASK);
    expect(out).toMatchObject({ status: 'completed', verdict: 'True' });
  });

  it('falls back when the connection has no webhook secret', async () => {
    const client = mockStatusClient({ status: 'completed', result: RESULT });

    await appTester(
      App.creates.verify_claim.operation.performResume,
      resumeBundle(callback(completed()), { authData: { access_token: 'lat' } }),
    );

    expect(client.getStatus).toHaveBeenCalledWith(TASK);
  });
});
