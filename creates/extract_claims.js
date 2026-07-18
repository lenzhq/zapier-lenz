'use strict';

const { Lenz } = require('lenz-io');

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
// each claim individually.
const perform = (z, bundle) => {
  // Same reasoning as the other creates — skip the real call while someone's
  // just testing in the editor, so e.g. a downstream Looping step always has
  // a real (if fake) identified_claims array to map against.
  if (bundle.meta && bundle.meta.isLoadingSample) {
    return Promise.resolve(SAMPLE);
  }

  const client = new Lenz({ apiKey: bundle.authData.apiKey });
  return client.extract({
    text: bundle.inputData.text,
    language: bundle.inputData.language || undefined,
  });
};

module.exports = {
  key: 'extract_claims',
  noun: 'Extraction',
  display: {
    label: 'Extract Claims',
    description: 'Pulls verifiable factual claims out of text (free) — checks nothing yet.',
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
