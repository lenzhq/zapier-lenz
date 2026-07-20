'use strict';

const { Lenz } = require('lenz-io');

const SAMPLE = {
  // Explicit sample label (mirrors verify_claim.js's executive_summary): this
  // is the follow-up "answer" a user typically maps into an email body, so it
  // must never be mistaken for a real, mismatched answer during a chained
  // editor test. The real API answer replaces this on any live run and on a
  // standalone test with a real verification_id.
  answer:
    'Sample answer shown while testing in the Zap editor — a live, turned-on Zap returns the real answer, grounded in the verification’s sources.',
};

// Asks a question grounded in the full research behind a completed
// Verify a Claim result. Requires the verification_id that create returns —
// not usable standalone.
//
// Editor testing (isLoadingSample) returns stubbed sample data and makes NO
// real call, so a user never spends an ask exchange just for clicking "Test
// step." This also cleanly handles the chained case (Ask Follow-Up right
// after Verify a Claim), where the only verification_id available in the
// editor is Verify a Claim's canned placeholder — which isn't real and would
// only ever 404. Auth is validated at connect time; the real answer comes
// back on any live run.
const perform = async (z, bundle) => {
  if (bundle.meta && bundle.meta.isLoadingSample) {
    return SAMPLE;
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
