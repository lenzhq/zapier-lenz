'use strict';

const { mapLenzError } = require('../lib/errors');
const { lenzClient } = require('../client');

const SAMPLE = {
  status: 'ok',
  claim: 'The Eiffel Tower is 330 metres tall.',
  identified_claims: ['The Eiffel Tower is 330 metres tall.'],
  candidate_claims: [],
  domain: 'science',
  key_entities: [{ name: 'Eiffel Tower', type: 'place' }],
  presumed_intent: 'informational',
  original_input: 'Did you know the Eiffel Tower is 330 metres tall?',
};

// Free — pulls the verifiable factual claims out of a block of text without
// checking them. Useful as a first step before running Assess or Verify on
// each claim individually. Extract itself costs no credit (daily rate limit
// only), but editor testing (isLoadingSample) still returns stubbed sample
// data and makes no real call — consistent with the other creates, and it
// keeps test clicks off the daily rate limit. Auth is validated at connect
// time.
const perform = (z, bundle) => {
  if (bundle.meta && bundle.meta.isLoadingSample) {
    return Promise.resolve(SAMPLE);
  }

  const client = lenzClient(bundle);
  return client
    .extract({
      text: bundle.inputData.text,
      language: bundle.inputData.language || undefined,
    })
    .catch((err) => mapLenzError(z, err));
};

module.exports = {
  key: 'extract_claims',
  noun: 'Extraction',
  display: {
    label: 'Extract Claims',
    description: 'Pulls the verifiable factual claims out of a block of text without checking them.',
  },
  operation: {
    inputFields: [
      {
        key: 'text',
        label: 'Text',
        type: 'text',
        required: true,
        helpText: 'The text to pull claims from.',
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
      { key: 'claim', label: 'Primary Claim' },
      { key: 'domain', label: 'Domain' },
    ],
  },
};
