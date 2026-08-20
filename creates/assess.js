'use strict';

const { mapLenzError } = require('../lib/errors');
const { lenzClient } = require('../client');

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
// text. Well under Zapier's 30s action timeout, so a live run is a plain
// sync call. Editor testing (isLoadingSample) returns stubbed sample data
// and makes NO real call, so a user never spends an assess credit just for
// clicking "Test step" while building their Zap. Auth is already validated
// at connection time.
const perform = async (z, bundle) => {
  if (bundle.meta && bundle.meta.isLoadingSample) {
    return SAMPLE;
  }

  const client = lenzClient(bundle);
  const result = await client
    .assess({
      text: bundle.inputData.text,
      language: bundle.inputData.language || undefined,
    })
    .catch((err) => mapLenzError(z, err));

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
      'Checks every claim in a block of text and returns a verdict for each, in about 5-10 seconds.',
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
