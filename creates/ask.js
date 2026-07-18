'use strict';

const { Lenz } = require('lenz-io');

const SAMPLE = {
  answer: 'The strongest source is the official Eiffel Tower website, which states the height directly.',
};

// Asks a question grounded in the full research behind a completed
// Verify a Claim result. Requires the verification_id that create returns —
// not usable standalone.
const perform = async (z, bundle) => {
  // The verificationId here is very likely Verify a Claim's own placeholder
  // sample ID (since that step also short-circuits during editor testing),
  // which doesn't exist in Lenz's real system — calling the real API with it
  // would 404 ("Verification not found") every time someone tests this step
  // right after Verify a Claim. Skip the real call during sample loading.
  if (bundle.meta && bundle.meta.isLoadingSample) {
    return Promise.resolve(SAMPLE);
  }

  const client = new Lenz({ apiKey: bundle.authData.apiKey });
  const reply = await client.ask.send(bundle.inputData.verificationId, {
    message: bundle.inputData.question,
    language: bundle.inputData.language || undefined,
  });
  return { answer: reply.content || '' };
};

module.exports = {
  key: 'ask',
  noun: 'Answer',
  display: {
    label: 'Ask Follow-Up',
    description: 'Asks a grounded follow-up question about a completed Verify a Claim result.',
  },
  operation: {
    inputFields: [
      {
        key: 'verificationId',
        label: 'Verification ID',
        type: 'string',
        required: true,
        helpText: 'The verification_id from a completed Verify a Claim result (not a task_id).',
      },
      {
        key: 'question',
        label: 'Question',
        type: 'string',
        required: true,
        helpText: 'The follow-up question, answered from the verification full research and evidence.',
      },
      {
        key: 'language',
        label: 'Language',
        type: 'string',
        required: false,
        helpText: 'Optional ISO 639-1 response language code. Defaults to the claim’s stored language.',
      },
    ],
    perform,
    sample: SAMPLE,
    outputFields: [{ key: 'answer', label: 'Answer' }],
  },
};
