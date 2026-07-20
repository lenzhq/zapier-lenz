'use strict';

const { Lenz } = require('lenz-io');

const SAMPLE = {
  answer: 'The strongest source is the official Eiffel Tower website, which states the height directly.',
};

// Asks a question grounded in the full research behind a completed
// Verify a Claim result. Requires the verification_id that create returns —
// not usable standalone.
//
// Deliberately always makes the real call, in both test and live runs — an
// earlier version skipped it during editor testing to save a quota-metered
// call, but that also hid real errors (bad auth, no quota, invalid input)
// behind a fake "success". Testing this step chained right after Verify a
// Claim's test output will genuinely 404 ("Verification not found"), since
// that placeholder ID doesn't exist for real — that's an honest signal, not
// a bug: a real verification_id only exists after Verify a Claim's actual
// ~90s pipeline finishes, which the editor can't wait through either way.
// Testing with a real, already-completed verification_id works correctly.
const perform = async (z, bundle) => {
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
