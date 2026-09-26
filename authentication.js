'use strict';

const { lenzClient, fetchAsZapier } = require('./client');
const { mapLenzError } = require('./lib/errors');

// OAuth 2.0 against Lenz's own issuer (Lenz#873). A user connects by signing in
// to Lenz and approving the app, instead of pasting an API key.
//
//   authorize  https://lenz.io/oauth2/authorize        (consent every time, by design)
//   token      https://lenz.io/api/v1/oauth/token      (code + refresh grants)
//
// Three server facts shape this file (issuer metadata and Lenz PRs #840/#843):
//
// - The token endpoint takes client credentials ONLY as HTTP Basic
//   (`token_endpoint_auth_methods_supported: client_secret_basic, none`). A
//   client_id/secret in the form body is refused.
// - Access tokens live an hour; refresh tokens ROTATE. A refresh replayed
//   inside 60 s returns the same pair, so Zapier's parallel refreshes are safe.
// - A grant has no webhook signing secret until `GET /me/webhook-secret` is
//   called. Until then `/verify` with a `webhook_url` is refused 422
//   `webhook_secret_missing`. So the secret is minted here, at connect time.

const TOKEN_URL = 'https://lenz.io/api/v1/oauth/token';
const WEBHOOK_SECRET_URL = 'https://lenz.io/api/v1/me/webhook-secret';

// Exactly the routes this app calls. No `history:write`: the app has no delete
// action, so it never asks for the permission. `offline_access` is not an API
// scope (it is absent from `scopes_supported`), but it is what makes the issuer
// hand out a refresh token at all.
const SCOPES = [
  'assess',
  'verify',
  'ask',
  'ask:read',
  'extract',
  'history:read',
  'usage:read',
  'webhooks:manage',
  'offline_access',
];

const basicAuth = () =>
  'Basic ' +
  Buffer.from(`${process.env.CLIENT_ID || ''}:${process.env.CLIENT_SECRET || ''}`).toString('base64');

// NOT z.request, on purpose. With `autoRefresh: true`, zapier-platform-core
// puts `throwForStaleAuth` on every z.request response, and it throws a bare
// RefreshAuthError on ANY 401 before the app sees the body —
// `skipThrowForStatus` does not stop it (create-app-request-client.js). The
// token endpoint answers a wrong client secret with 401 `invalid_client`, so
// through z.request that would surface as a "refresh" error at connect time,
// and as a refresh-inside-a-refresh during refreshAccessToken. `fetchAsZapier`
// is plain fetch with this app's User-Agent (the same one the SDK uses), so
// every status reaches tokenResponse and its OAuth `error` code survives. A
// side effect worth keeping: neither the token nor the webhook secret is
// written to Zapier's HTTP request log.
//
// Every attempt has its own deadline. Plain fetch waits minutes for a server
// that accepted the connection and never answers, far past the ~30 s Zapier
// gives a step, so without one the step would be killed by the platform and
// the `transport_error` handling below would never run. The budget is sized
// for the worst sequence, connect: one code exchange (never retried) plus the
// secret mint (retried once) = 3 x 9 s = 27 s.
//
// `retry` is opt-in per call, and only where repeating is harmless (as
// lenz-mcp's `_post` retries one dropped connection):
//   - a REFRESH: the issuer's 60 s reuse grace hands a replayed refresh token
//     the same pair, so a repeat right away cannot revoke anything;
//   - the webhook-secret GET: minted once and kept, so re-reading is a no-op.
// NOT the authorization-code exchange: a code is single-use. If the first POST
// reached Lenz and only the response was lost, a repeat is `invalid_grant` —
// and RFC 6749 lets the issuer revoke the tokens that code already minted.
//
// A failure with no response (dropped, refused, deadline hit) comes back as
// status 0, `transport_error`.
const ATTEMPT_TIMEOUT_MS = 9000;

const fetchJson = async (url, init, { retry = false } = {}) => {
  let response;
  const attempts = retry ? 2 : 1;
  for (let attempt = 0; attempt < attempts && !response; attempt += 1) {
    try {
      response = await fetchAsZapier(url, { ...init, signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
    } catch (_err) {
      response = undefined;
    }
  }
  if (!response) return { status: 0, json: { error: 'transport_error' }, retryAfter: null };
  let json = {};
  try {
    json = await response.json();
  } catch (_err) {
    json = {};
  }
  return {
    status: response.status,
    json: json && typeof json === 'object' ? json : {},
    retryAfter: response.headers && response.headers.get ? response.headers.get('retry-after') : null,
  };
};

const postToken = (form) =>
  fetchJson(
    TOKEN_URL,
    {
      method: 'POST',
      headers: {
        Authorization: basicAuth(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(form).toString(),
    },
    { retry: form.grant_type === 'refresh_token' },
  );

// Token-endpoint failures are mapped by the OAuth `error` CODE, never the
// HTTP status — ported from lenz-mcp (src/lenz_mcp/exchange.py `_failure`), the
// other Lenz OAuth client, so both behave alike (plan D7).
//
// Which Zapier error is thrown decides what the USER is told:
//
//   invalid_grant          the grant is dead (revoked, expired, replayed)
//     refresh  → ExpiredAuthError: Zapier asks the user to reconnect. Right,
//                because reconnecting is the only fix.
//   invalid_client, invalid_request, unsupported_grant_type,
//   unauthorized_client, invalid_target, invalid_scope
//     both     → a plain Error, logged loudly, NO reconnect prompt. These mean
//                THIS APP is misconfigured (e.g. a rotated client secret);
//                emailing every user to reconnect would not fix it.
//   a malformed 200, no response (dropped, refused, deadline)
//     refresh  → ThrottledError in 15 s. The server may already have rotated
//                the token; a replay inside its 60 s grace gets the same pair
//                (see LOST_RESPONSE_REPLAY_S).
//   temporarily_unavailable, slow_down, server_error, 429, 5xx
//     refresh  → ThrottledError with the stated wait: Zapier replays the run.
//
// At connect time (getAccessToken) every failure is a plain Error: the user is
// watching the connect dialog, and there is no run to replay.
const OPERATIONAL_ERRORS = new Set([
  'invalid_client',
  'invalid_request',
  'unsupported_grant_type',
  'unauthorized_client',
  'invalid_target',
  'invalid_scope',
]);
const BUSY_ERRORS = new Set(['temporarily_unavailable', 'slow_down', 'server_error', 'transport_error']);
const DEFAULT_RETRY_AFTER_S = 60;

// When a REFRESH may already have been rotated on the server but we never read
// the answer — a 200 we could not parse (a body cut off mid-read reads as
// `{}`), or no response at all — the replay must land inside the issuer's
// 60 s reuse grace. There it is handed the SAME new pair; after it, the old
// refresh token counts as replayed and the issuer revokes the whole grant,
// forcing a reconnect over a network blip. So those two replay in 15 s, not
// the default 60.
const LOST_RESPONSE_REPLAY_S = 15;

const retryAfterSeconds = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : DEFAULT_RETRY_AFTER_S;
};

// A 200 is trusted only when it is a well-formed Bearer grant; anything else is
// treated as an outage on the issuer's side, not as a dead connection.
const isWellFormed = (body) =>
  typeof body.access_token === 'string' &&
  body.access_token.length > 0 &&
  typeof body.token_type === 'string' &&
  body.token_type.toLowerCase() === 'bearer';

// `phase` is 'connect' (getAccessToken) or 'refresh' (refreshAccessToken).
const tokenResponse = (z, response, phase) => {
  const body = response.json || {};
  if (response.status === 200 && isWellFormed(body)) return body;

  const status = response.status;
  const code = response.status === 200 ? 'malformed_response' : typeof body.error === 'string' ? body.error : '';
  const label = code || `http_${status}`;
  const detail = typeof body.error_description === 'string' ? ` ${body.error_description}` : '';

  if (phase === 'connect') {
    throw new z.errors.Error(
      `Lenz could not complete the connection (${label}).${detail} Try connecting again; ` +
        'if it keeps failing, contact Lenz support and quote this code.',
      'OAuthConnectFailed',
      status || 502,
    );
  }

  if (code === 'invalid_grant') {
    throw new z.errors.ExpiredAuthError(
      'Your Lenz connection is no longer valid (it may have been disconnected at lenz.io). ' +
        'Reconnect your Lenz account.',
    );
  }
  if (code === 'malformed_response' || status === 0) {
    throw new z.errors.ThrottledError(
      `Lenz's answer to the sign-in refresh did not arrive intact (${label}). ` +
        `Retrying in ${LOST_RESPONSE_REPLAY_S}s.`,
      LOST_RESPONSE_REPLAY_S,
    );
  }
  if (OPERATIONAL_ERRORS.has(code)) {
    // Loud on purpose: only an operator can fix it, and every refresh for
    // every user fails until then.
    z.console.error(`Lenz OAuth refresh refused as misconfigured: ${label} (HTTP ${status})`);
    throw new z.errors.Error(
      `Lenz rejected this integration's credentials (${label}). This is not a problem with ` +
        'your connection and reconnecting will not help; Lenz has been notified by the error ' +
        'logs. Try again later.',
      'OAuthMisconfigured',
      status || 502,
    );
  }
  if (BUSY_ERRORS.has(code) || status === 429 || status >= 500) {
    const delay = retryAfterSeconds(response.retryAfter);
    throw new z.errors.ThrottledError(
      `Lenz could not refresh your sign-in right now (${label}). Retrying in ${delay}s.`,
      delay,
    );
  }
  z.console.error(`Lenz OAuth refresh failed unexpectedly: ${label} (HTTP ${status})`);
  throw new z.errors.Error(`Lenz could not refresh your sign-in (${label}).${detail}`, 'OAuthRefreshFailed', status || 502);
};

// Minted once per grant and kept by the server; re-reading it returns the
// same value. Failing here fails the CONNECTION, visibly, instead of a later
// Verify run.
const mintWebhookSecret = async (z, accessToken) => {
  const response = await fetchJson(
    WEBHOOK_SECRET_URL,
    { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } },
    { retry: true },
  );
  const secret = response.json && response.json.webhook_secret;
  if (response.status !== 200 || typeof secret !== 'string' || !secret) {
    throw new z.errors.Error(
      `Lenz did not return a webhook signing secret (HTTP ${response.status}). ` +
        'Verify a Claim needs it to receive its result. Try connecting again.',
      'WebhookSecretMintFailed',
      response.status || 502,
    );
  }
  return secret;
};

const getAccessToken = async (z, bundle) => {
  const form = {
    grant_type: 'authorization_code',
    code: bundle.inputData.code,
    redirect_uri: bundle.inputData.redirect_uri,
  };
  // PKCE (`enablePkce: true`): Zapier generates the verifier and passes it
  // here. The issuer requires S256 PKCE for every client, so a missing
  // verifier is refused there with `invalid_request` rather than guessed at.
  if (bundle.inputData.code_verifier) {
    form.code_verifier = bundle.inputData.code_verifier;
  }
  const body = tokenResponse(z, await postToken(form), 'connect');
  const webhookSecret = await mintWebhookSecret(z, body.access_token);
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    webhook_secret: webhookSecret,
  };
};

const refreshAccessToken = async (z, bundle) => {
  const body = tokenResponse(
    z,
    await postToken({
      grant_type: 'refresh_token',
      refresh_token: bundle.authData.refresh_token,
    }),
    'refresh',
  );
  return {
    access_token: body.access_token,
    // Rotated on every refresh: storing the new one is what keeps the next
    // refresh from being a replay, which revokes the grant after 60 s.
    refresh_token: body.refresh_token || bundle.authData.refresh_token,
    // Carried forward explicitly, so a refresh can never drop it.
    webhook_secret: bundle.authData.webhook_secret,
  };
};

// Zapier runs this at connect time and when it re-checks a connection.
// Mapped like every other call.
const test = async (z, bundle) => {
  const client = lenzClient(bundle);
  return client.usage().catch((err) => mapLenzError(z, err));
};

module.exports = {
  type: 'oauth2',

  oauth2Config: {
    authorizeUrl: {
      url: 'https://lenz.io/oauth2/authorize',
      params: {
        client_id: '{{process.env.CLIENT_ID}}',
        state: '{{bundle.inputData.state}}',
        redirect_uri: '{{bundle.inputData.redirect_uri}}',
        response_type: 'code',
      },
    },
    getAccessToken,
    refreshAccessToken,
    scope: SCOPES.join(' '),
    autoRefresh: true,
    enablePkce: true,
  },

  test,

  // No connectionLabel on purpose. Zapier renders it unredacted wherever
  // connections are listed, so it must not carry account state — app review
  // (2026-08-20) rejected `{{bundle.inputData.plan}} plan` on that ground. The
  // auth test's payload (/me/usage) carries no account name or email.
};
