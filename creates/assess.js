'use strict';

const { Lenz } = require('lenz-io');

function isPassingVerdict(verdict) {
  return verdict === 'True' || verdict === 'Mostly True';
}

const SAMPLE = {
  status: 'ok',
  claims: [
    {
      claim: 'The Eiffel Tower is 330 metres tall.',
      verdict: 'True',
      confidence: 'high',
      passed: true,
      verification_url: 'https://lenz.io/c/eiffel-tower-height-ab12cd34',
    },
  ],
};

// Fast 3-model panel verdict (~5-10s) — one entry per claim found in the
// text. Well under Zapier's 30s action timeout, so this is a plain sync call.
//
// Deliberately always makes the real call, including while testing in the
// editor — a prior version skipped it to save a quota-metered call, but that
// also hid real errors (bad auth, no quota) behind a fake "success". There's
// no async-wait problem here to justify faking it (unlike Verify a Claim),
// so there's no good reason to trade away real error-catching for it.
const perform = async (z, bundle) => {
  const client = new Lenz({ apiKey: bundle.authData.apiKey });
  const result = await client.assess({
    text: bundle.inputData.text,
    language: bundle.inputData.language || undefined,
  });

  if (!result.claims || result.claims.length === 0) {
    return {
      status: result.error_code === 'ambiguous' ? 'ambiguous' : 'no_claim',
      message: result.error || 'No verifiable factual claim was detected.',
      candidate_claims: result.candidate_claims || [],
      claims: [],
    };
  }

  return {
    status: 'ok',
    claims: result.claims.map((c) => ({
      claim: c.claim || '',
      verdict: c.verdict || null,
      confidence: c.confidence || null,
      passed: isPassingVerdict(c.verdict),
      verification_url: c.verification_url || null,
    })),
  };
};

module.exports = {
  key: 'assess',
  noun: 'Assessment',
  display: {
    label: 'Assess (Fast)',
    description:
      'Fast 3-model panel verdict (~5-10s), one entry per claim identified in the text. Good default for lower-stakes checks — escalate to Verify a Claim for citations and a full audit trail.',
  },
  operation: {
    inputFields: [
      {
        key: 'text',
        label: 'Text',
        type: 'text',
        required: true,
        helpText: 'The text to check. If it contains several claims, each is assessed separately.',
      },
      {
        key: 'language',
        label: 'Language',
        type: 'string',
        required: false,
        helpText: 'Optional ISO 639-1 response language code (e.g. "es"). Defaults to English.',
      },
    ],
    perform,
    sample: SAMPLE,
    outputFields: [
      { key: 'status', label: 'Status' },
      { key: 'message', label: 'Message' },
    ],
  },
};
