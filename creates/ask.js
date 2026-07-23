'use strict';

const { Lenz } = require('lenz-io');

const SAMPLE = {
  // Realistic, representative example answer, coherent with Verify's Eiffel
  // sample — Zapier's build guidelines want representative sample values, not
  // placeholder text. The "this is a test sample" signal lives in the action
  // description and the Question help text, not in a fake answer. The real API
  // answer replaces this on any live run (and on a standalone test with a real
  // verification_id).
  answer:
    'The 330-metre figure includes the broadcast antennas at the top; the structure alone is about 300 metres. Both are confirmed by the tower’s official operator and independent surveys.',
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
    description:
      'Asks a grounded follow-up question about a completed Verify a Claim result.' +
      ' **Testing shows example output**: clicking Test returns an example answer so you can map the output fields — a turned-on Zap returns the real answer for your question.',
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
        helpText:
          'The follow-up question, answered from the verification’s full research and evidence. Clicking Test shows an example answer so you can map the output fields — a turned-on Zap answers this question for real.',
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
