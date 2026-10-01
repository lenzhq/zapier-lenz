'use strict';

const { LenzError } = require('lenz-io');
const { mapLenzError } = require('./errors');

// Review a Draft and Check Citations are callback actions: they hand Lenz a
// Zapier callback URL as the per-call `webhook_url`, which Lenz refuses on an
// API key with no webhook signing secret. The wording matches Verify a
// Claim's (creates/verify_claim.js), which has the same requirement.

// Editor testing (isLoadingSample) makes the ONE call that costs nothing
// (GET /me/usage) to answer the only question a sample cannot: does this key
// have a webhook secret? A missing one is reported at test time instead of on
// the first live run. usage() also re-validates the key for free, and is
// mapped like every other call. Strict `=== false`: a server that does not
// send the field leaves it undefined, and the check is then a no-op.
const requireWebhookSecretWhileTesting = async (z, client, actionLabel) => {
  const usage = await client.usage().catch((err) => mapLenzError(z, err));
  if (usage && usage.has_webhook_secret === false) {
    throw new z.errors.Error(
      `${actionLabel} needs a webhook secret on this API key, and this key doesn't have one yet. ` +
        'Go to lenz.io → API key settings → "Generate webhook secret" (Webhooks panel) once, then try this step again. ' +
        '(Assess, Extract Claims, and Ask Follow-Up work without it.)',
      'WebhookSecretMissing',
      422,
    );
  }
};

// Lenz's refusal of `webhook_url` on a secret-less key, tagged
// `webhook_secret_missing`. HaltedError, not Error: a CONFIGURATION state that
// retrying cannot change must not count toward the error rate that turns a
// Zap off.
const isWebhookSecretMissing = (err) =>
  err instanceof LenzError && Boolean(err.body) && err.body.code === 'webhook_secret_missing';

const webhookSecretMissing = (z) =>
  new z.errors.HaltedError(
    "This API key doesn't have a webhook secret yet. Go to lenz.io → API key " +
      'settings → "Generate webhook secret" (Webhooks panel) once, then turn this Zap ' +
      'back on.',
  );

module.exports = { requireWebhookSecretWhileTesting, isWebhookSecretMissing, webhookSecretMissing };
