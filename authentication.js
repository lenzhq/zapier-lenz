'use strict';

const { lenzClient } = require('./client');
const { mapLenzError } = require('./lib/errors');

// Zapier calls this once when a user connects (or reconnects) their account.
// Throwing here surfaces as a failed connection with the error's message shown
// to the user.
//
// Mapped like every other call. This is the FIRST place a bad or revoked key
// shows up, so it is the last place that should surface a raw SDK message
// instead of the reconnect prompt an ExpiredAuthError produces — and a
// connect-time network blip should read as "could not reach Lenz", not as a
// rejected key.
const test = async (z, bundle) => {
  const client = lenzClient(bundle);
  return client.usage().catch((err) => mapLenzError(z, err));
};

module.exports = {
  // "custom" is the catch-all auth type: the user supplies a value (here,
  // just the API key) and Zapier makes authenticated requests with it.
  type: 'custom',

  fields: [
    {
      key: 'apiKey',
      label: 'API Key',
      type: 'password',
      required: true,
      helpText:
        'Your Lenz API key (starts with `lenz_`). Get one at [lenz.io/api-credentials](https://lenz.io/api-credentials).' +
        ' If you plan to use "Verify a Claim," also generate a webhook secret there first (one-time, in your API key settings) — otherwise that action will fail on its first run.',
    },
  ],

  test,

  // No connectionLabel on purpose. Zapier renders it unredacted wherever
  // connections are listed, so it must not carry account state — app review
  // (2026-08-20) rejected `{{bundle.inputData.plan}} plan` on that ground. The
  // sanctioned alternatives are an account name or email, and the auth test's
  // payload (/me/usage) carries neither today; unset means Zapier numbers the
  // connections itself. If we want a real label later, `APIKey.name` is the
  // candidate — it also distinguishes two keys on one account, which `plan`
  // never did.
};
