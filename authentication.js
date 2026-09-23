'use strict';

const { lenzClient, USER_AGENT } = require('./client');
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

const postToken = (z, form) =>
  z.request({
    url: TOKEN_URL,
    method: 'POST',
    headers: {
      Authorization: basicAuth(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: new URLSearchParams(form).toString(),
    // Read the OAuth `error` code ourselves rather than letting a 4xx throw a
    // generic HTTP error — see tokenResponse.
    skipThrowForStatus: true,
  });

// SPIKE: the error mapping here is the minimal one. The reviewed plan (D7,
// ported from lenz-mcp's exchange.py) maps refresh failures by OAuth `error`
// code so a misconfiguration on our side never mass-emails users to
// reconnect; that lands after the spike confirms Zapier honours it.
const tokenResponse = (response) => {
  const body = response.json || {};
  if (response.status === 200 && typeof body.access_token === 'string' && body.access_token) {
    return body;
  }
  const code = typeof body.error === 'string' ? body.error : `http_${response.status}`;
  const detail = typeof body.error_description === 'string' ? `: ${body.error_description}` : '';
  throw new Error(`Lenz refused the token request (${code})${detail}`);
};

// Minted once per grant and kept by the server; re-reading it returns the
// same value. Failing here fails the CONNECTION, visibly, instead of a later
// Verify run.
const mintWebhookSecret = async (z, accessToken) => {
  const response = await z.request({
    url: WEBHOOK_SECRET_URL,
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': USER_AGENT },
    skipThrowForStatus: true,
  });
  const secret = response.json && response.json.webhook_secret;
  if (response.status !== 200 || typeof secret !== 'string' || !secret) {
    throw new Error(
      `Lenz did not return a webhook signing secret (HTTP ${response.status}). ` +
        'Verify a Claim needs it to receive its result. Try connecting again.',
    );
  }
  return secret;
};

const getAccessToken = async (z, bundle) => {
  // SPIKE diagnostic: whether Zapier hands us the PKCE verifier, and under
  // which name. Logs presence only, never the value.
  z.console.log(
    `[spike] getAccessToken inputData keys: ${Object.keys(bundle.inputData || {}).sort().join(',')}`,
  );
  const form = {
    grant_type: 'authorization_code',
    code: bundle.inputData.code,
    redirect_uri: bundle.inputData.redirect_uri,
  };
  if (bundle.inputData.code_verifier) {
    form.code_verifier = bundle.inputData.code_verifier;
  }
  const body = tokenResponse(await postToken(z, form));
  const webhookSecret = await mintWebhookSecret(z, body.access_token);
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    webhook_secret: webhookSecret,
  };
};

const refreshAccessToken = async (z, bundle) => {
  const body = tokenResponse(
    await postToken(z, {
      grant_type: 'refresh_token',
      refresh_token: bundle.authData.refresh_token,
    }),
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
