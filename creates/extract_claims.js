'use strict';

const { mapLenzError } = require('../lib/errors');
const { lenzClient } = require('../client');

// `perform` returns the API's response untouched, so every value here has to
// be one the API actually sends — the editor builds Filter and Paths steps
// from this sample, and it is the ONLY value a user is ever shown. A sample
// that says `ok` teaches a filter on "Status = ok" which then matches nothing
// on a live run, dropping every extraction with nothing to indicate why.
//
// The contract is `ExtractOut` in lenz/api/public_authed.py. Field by field,
// because three of these shipped as values the API cannot produce:
//
//   status             `ready` (claims found) | `not_a_claim` (none). The
//                      schema also allows `no_match`, but it is reachable
//                      ONLY with a `focus` hint, which this integration does
//                      not offer yet.
//   claim              The single most check-worthy claim.
//   identified_claims  The COMPLETE ordered list when more than one claim was
//                      found, `[]` when only one was. A ONE-ELEMENT list is
//                      unreachable — `texts if len(texts) > 1 else []`. This
//                      sample is therefore deliberately a two-claim
//                      extraction, so the field shows the only shape in which
//                      it is ever populated and stays mappable in the editor.
//   domain             One of eight capitalised values (Health, Science,
//                      Politics, Finance, Tech, History, Legal, General) or
//                      `''` when the extractor produced none.
//   key_entities       `{name, type}` here. The trigger's `entities` are
//                      `{name, qid}` — different surfaces, different shape.
//   presumed_intent    FREE TEXT, one sentence. Not an enum, so it must not
//                      look like one: a filter cannot be built on it.
const SAMPLE = {
  status: 'ready',
  claim: 'The Eiffel Tower is 330 metres tall.',
  identified_claims: [
    'The Eiffel Tower is 330 metres tall.',
    'The Eiffel Tower was completed in 1889.',
  ],
  candidate_claims: [],
  domain: 'Science',
  key_entities: [{ name: 'Eiffel Tower', type: 'place' }],
  presumed_intent: 'Sharing factual details about a landmark.',
  original_input:
    'Did you know the Eiffel Tower is 330 metres tall? It was completed in 1889.',
};

// Free — pulls the verifiable factual claims out of a block of text without
// checking them. Useful as a first step before running Assess or Verify on
// each claim individually. Extract itself costs no credits (a daily fair-use
// cap only), but editor testing (isLoadingSample) still returns stubbed sample
// data and makes no real call — consistent with the other creates, and it
// keeps test clicks off that cap. Auth is validated at connect time.
const perform = (z, bundle) => {
  if (bundle.meta && bundle.meta.isLoadingSample) {
    // Copied, not returned by reference — see the same note in
    // creates/assess.js and creates/verify_claim.js.
    return Promise.resolve({ ...SAMPLE });
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
    // The Status vocabulary belongs here because output fields cannot carry
    // helpText — PlainOutputFieldSchema rejects the property outright and
    // fails `zapier validate` (see #8) — and the editor renders them as bare
    // labels. This description is the only place a user building a Filter on
    // Status can learn what to compare against.
    description:
      'Pulls the verifiable factual claims out of a block of text without checking them. Status is "ready" when claims were found, or "not_a_claim" when none were.',
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
