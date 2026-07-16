'use strict';

const { Lenz } = require('lenz-io');

// Zapier calls this once when a user connects (or reconnects) their account.
// Throwing here — lenz-io throws a typed LenzAuthError on a 401 — surfaces
// as a failed connection with the error's message shown to the user.
const test = async (z, bundle) => {
  const client = new Lenz({ apiKey: bundle.authData.apiKey });
  return client.usage();
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
        'Your Lenz API key (starts with `lenz_`). Get one at [lenz.io/api-integration](https://lenz.io/api-integration).' +
        ' If you plan to use "Verify a Claim," also generate a webhook secret there first (one-time, in your API key settings) — otherwise that action will fail on its first run.',
    },
  ],

  test,

  // `test` resolves with the Usage shape ({plan, quota_resets_at, verify, ...}),
  // so `plan` is available here as `bundle.inputData.plan`.
  connectionLabel: '{{bundle.inputData.plan}} plan',
};
