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
// One retry on a TRANSPORT failure (no response at all), as lenz-mcp's
// `_post` does: a dropped connection is the common transient, and a token
// request is idempotent enough to repeat once — the server's 60 s reuse grace
// hands a replayed refresh the same pair. A second failure is reported as
// `transport_error` with status 0.
const fetchJson = async (url, init) => {
  let response;
  for (let attempt = 0; attempt < 2 && !response; attempt += 1) {
    try {
      response = await fetchAsZapier(url, init);
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
  fetchJson(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(form).toString(),
  });

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
//   unauthorized_client, invalid_target, invalid_scope, a malformed 200
//     both     → a plain Error, logged loudly, NO reconnect prompt. These mean
//                THIS APP is misconfigured (e.g. a rotated client secret);
//                emailing every user to reconnect would not fix it.
//   temporarily_unavailable, slow_down, server_error, 429, 5xx, no response
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
  if (OPERATIONAL_ERRORS.has(code) || code === 'malformed_response') {
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
  if (BUSY_ERRORS.has(code) || status === 429 || status >= 500 || status === 0) {
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
  const response = await fetchJson(WEBHOOK_SECRET_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
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
