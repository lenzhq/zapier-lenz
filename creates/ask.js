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

// Verify a Claim's own sample data (creates/verify_claim.js) is the only
// source of this placeholder ID — importing it (rather than duplicating the
// literal) guarantees this never silently drifts out of sync with it.
const { verification_id: PLACEHOLDER_VERIFICATION_ID } = require('./verify_claim').operation.sample;

// Asks a question grounded in the full research behind a completed
// Verify a Claim result. Requires the verification_id that create returns —
// not usable standalone.
//
// Always makes the real call — including in the editor — UNLESS the
// verificationId is specifically Verify a Claim's own known placeholder ID,
// which can never be real (it only ever comes from that step's test-mode
// output, never from a live run). Calling the real API with that exact,
// known-fake value would never teach us anything — it would just 404 every
// time, purely because the two steps were chained during editor testing,
// not because of a real problem. Any other value (a real ID typed in, or a
// wrong one) still makes the real call and still surfaces real errors —
// this is a narrow, targeted exception, not a return to broadly hiding
// errors behind bundle.meta.isLoadingSample.
const perform = async (z, bundle) => {
  if (bundle.meta && bundle.meta.isLoadingSample && bundle.inputData.verificationId === PLACEHOLDER_VERIFICATION_ID) {
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
