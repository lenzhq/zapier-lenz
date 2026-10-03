'use strict';

const { LenzError, LenzWebhooks } = require('lenz-io');
const { mapLenzError } = require('./errors');

// The callback actions (Verify a Claim, Review a Draft, Check Citations) hand
// Lenz a Zapier callback URL as the per-call `webhook_url`, and Lenz posts the
// finished result there, signed with the connection's webhook secret (minted
// in getAccessToken). Reading the result from that signed body needs no API
// call, so an access token that expired while the job ran cannot touch it.
// Each action falls back to reading its result by id when this says no.

// Zapier hands a callback's headers with an `Http-` prefix
// (`Http-X-Lenz-Signature`); the SDK looks `X-Lenz-Signature` up exactly, in
// lower case or in upper case. Normalise to bare lower-case names.
const callbackHeaders = (headers) => {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    out[name.toLowerCase().replace(/^http-/, '')] = String(value);
  }
  return out;
};

// The verified event, or `{ fallback: <reason> }`. The reason is logged by the
// caller, never the body, the signature or the secret.
const parseSignedCallback = (bundle) => {
  const secret = bundle.authData && bundle.authData.webhook_secret;
  const raw = bundle.rawRequest;
  const content = raw && typeof raw === 'object' ? raw.content : undefined;
  if (!secret) return { fallback: 'no webhook_secret on the connection' };
  if (typeof content !== 'string' || !content) return { fallback: 'no raw callback body' };
  try {
    return { event: new LenzWebhooks({ secret }).parse(content, callbackHeaders(raw.headers)) };
  } catch (err) {
    return { fallback: `callback rejected: ${(err && err.message) || 'unparseable'}` };
  }
};

// Editor testing (isLoadingSample) of a callback action makes the ONE call
// that costs nothing (GET /me/usage) to answer the only question a sample
// cannot: does this connection have a webhook secret? A callback action
// REQUIRES one (Lenz refuses `webhook_url` on a secret-less principal), so a
// missing one is reported now, at test time, instead of on the first live run.
// usage() also re-validates the connection for free, and is mapped like every
// other call: this is the first place a revoked connection surfaces.
//
// Strict `=== false`: an older server that does not send the field leaves it
// undefined, so the check is then a no-op.
const requireWebhookSecretWhileTesting = async (z, client, actionLabel) => {
  const usage = await client.usage().catch((err) => mapLenzError(z, err));
  if (usage && usage.has_webhook_secret === false) {
    throw new z.errors.Error(
      // Under OAuth the secret belongs to the connection (the grant), minted
      // when the account is connected; `has_webhook_secret` reports the
      // grant's (OAuthPrincipal.hmac_secret). The only fix is to reconnect.
      `${actionLabel} needs this Lenz connection to have a webhook signing secret, and it ` +
        "doesn't. Reconnect your Lenz account (Connect a new account) and try this step again. " +
        '(Assess, Extract Claims, and Ask Follow-Up work without it.)',
      'WebhookSecretMissing',
      422,
    );
  }
};

// Lenz refuses `webhook_url` on a principal with no signing secret, tagged
// `webhook_secret_missing`. HaltedError, not Error: it is a CONFIGURATION
// state, not a failed execution, and retrying cannot change it, so it must
// not count toward the error rate that turns a Zap off.
const isWebhookSecretMissing = (err) =>
  err instanceof LenzError && Boolean(err.body) && err.body.code === 'webhook_secret_missing';

const webhookSecretMissing = (z, actionLabel) =>
  new z.errors.HaltedError(
    `This Lenz connection has no webhook signing secret, so ${actionLabel} cannot ` +
      'receive its result. Reconnect your Lenz account (Connect a new account), then ' +
      'turn this Zap back on.',
  );

module.exports = {
  callbackHeaders,
  parseSignedCallback,
  requireWebhookSecretWhileTesting,
  isWebhookSecretMissing,
  webhookSecretMissing,
};
