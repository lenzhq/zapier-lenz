'use strict';

const { mapLenzError } = require('../lib/errors');
const { lenzClient } = require('../client');

function isPassingVerdict(verdict) {
  return verdict === 'True' || verdict === 'Mostly True';
}

// `status` here is BUILT by this action, not passed through from the API:
// `ok` on the happy path, `no_claim` or `ambiguous` when nothing checkable was
// found. Those three are the real vocabulary.
//
// `message` and `candidate_claims` are spread into EVERY branch, and declared
// here, because Zapier's Filter treats a MISSING field and an EMPTY one as
// different conditions ("does not exist" vs "is empty") — and the editor
// builds those filters from this sample while `outputFields` promises Message
// exists. Omit them on the happy path and a filter the user tested against
// the sample behaves differently on a live run. Same reasoning as NO_FAILURE
// in creates/verify_claim.js.
const NO_ERROR = { message: '', candidate_claims: [] };

const SAMPLE = {
  status: 'ok',
  ...NO_ERROR,
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

// Fast 3-model panel verdict (~10s) — one entry per claim found in the
// text. Well under Zapier's 30s action timeout, so a live run is a plain
// sync call. Editor testing (isLoadingSample) returns stubbed sample data and
// makes NO real call, so a user never spends credits just for clicking "Test
// step" while building their Zap. Auth is already validated at connection
// time.
const perform = async (z, bundle) => {
  if (bundle.meta && bundle.meta.isLoadingSample) {
    // Copied, not returned by reference: on a warm container the platform
    // could mutate the module-level object and every later user of that
    // container would see it. creates/verify_claim.js already does this.
    return { ...SAMPLE };
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
    ...NO_ERROR,
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
      'Checks a claim and returns a verdict for it, in about 10 seconds. Several claims in one input are each assessed separately.',
  },
  operation: {
    inputFields: [
      {
        // Labelled "Claim" — a document is text, a claim is a claim. The KEY
        // stays `text`: it is what saved Zaps persist, so renaming it would
        // break every existing Assess step.
        key: 'text',
        label: 'Claim',
        type: 'text',
        required: true,
        helpText: 'The claim to check. If it contains several claims, each is assessed separately.',
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
