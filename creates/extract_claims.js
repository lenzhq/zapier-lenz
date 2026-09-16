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
//   status             `ready` (claims found) | `not_a_claim` (none) |
//                      `no_match` (claims found, none within the Focus).
//                      `no_match` became reachable when Focus was added; it
//                      is impossible without one.
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
  // Empty on every path except `no_match`, where it says why the list is
  // empty. Present here because outputFields declares it.
  message: '',
};

// Free — pulls the verifiable factual claims out of a block of text without
// checking them. Useful as a first step before running Assess or Verify on
// each claim individually. Extract itself costs no credits (a daily fair-use
// cap only), but editor testing (isLoadingSample) still returns stubbed sample
// data and makes no real call — consistent with the other creates, and it
// keeps test clicks off that cap. Auth is validated at connect time.
// Server-side cap on the Focus hint. Measured AFTER collapsing whitespace,
// the way the API measures it (lenz-io types.ts: "At most 300 characters — a
// longer focus is rejected with a 422, never truncated"). Measuring the raw
// string instead would refuse a focus the server would have accepted.
const MAX_FOCUS_CHARS = 300;

// Collapse runs of whitespace to single spaces and trim, so the length we
// check is the length the server checks, and so two spellings of the same
// focus are one string.
const normaliseFocus = (raw) => String(raw || '').replace(/\s+/g, ' ').trim();

const perform = (z, bundle) => {
  if (bundle.meta && bundle.meta.isLoadingSample) {
    // Copied, not returned by reference — see the same note in
    // creates/assess.js and creates/verify_claim.js.
    return Promise.resolve({ ...SAMPLE });
  }

  // Refuse an over-long focus HERE rather than letting it 422. The server
  // never truncates, and a silently shortened focus would return a subset of
  // the claims with nothing to indicate it happened — so the failure has to
  // be loud and say the real number.
  const focus = normaliseFocus(bundle.inputData.focus);
  if (focus.length > MAX_FOCUS_CHARS) {
    throw new z.errors.Error(
      `Focus is ${focus.length} characters and the limit is ${MAX_FOCUS_CHARS}. ` +
        'Shorten it — it is a hint about which claims you want, not a description of the text.',
      'FocusTooLong',
      422,
    );
  }

  const client = lenzClient(bundle);
  return client
    .extract({
      text: bundle.inputData.text,
      language: bundle.inputData.language || undefined,
      focus: focus || undefined,
    })
    .then((result) => {
      // `no_match` means claims WERE found and the focus excluded all of
      // them. The unfocused list is deliberately never substituted, so an
      // empty result here is a real answer rather than a failure — but it
      // looks identical to "nothing here" unless it is named.
      //
      // `message` is set on EVERY path, empty when there is nothing to say:
      // it is declared in outputFields, so omitting it on the other paths
      // would be the missing-vs-empty trap again (a Filter treats "does not
      // exist" and "is empty" as different conditions).
      const message =
        result && result.status === 'no_match'
          ? 'Claims were found, but none of them fall within your Focus. Widen or reword it ' +
            'and run again — the unfocused claims are deliberately not substituted.'
          : '';
      return { ...result, message };
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
      'Pulls the verifiable factual claims out of a block of text, or out of a public web page given its URL, without checking them. Status is "ready" when claims were found, "not_a_claim" when none were, or "no_match" when a Focus excluded all of them.',
  },
  operation: {
    inputFields: [
      {
        key: 'text',
        label: 'Text',
        type: 'text',
        required: true,
        helpText:
          "The text to pull claims from, or a single public web page URL. Lenz reads the page, or a YouTube video's transcript, and extracts the claims from its first 50,000 characters; pages behind a login can't be read. A Zap step has 30 seconds and a page read can take longer, so for a long page send its text instead.",
      },
      {
        key: 'language',
        label: 'Language',
        type: 'string',
        required: false,
        helpText: 'Optional ISO 639-1 response language code (e.g. "es"). Defaults to English.',
      },
      {
        key: 'focus',
        label: 'Focus',
        type: 'string',
        required: false,
        helpText:
          'Optional hint that narrows the result to the claims it describes, e.g. "pricing and headcount". At most 300 characters, and it costs nothing extra. It only SELECTS from the claims Lenz already found — it cannot add a claim, reword one, or change what counts as a claim. When nothing matches, Status comes back as "no_match" with an empty list; the unfocused claims are never substituted.',
      },
    ],
    perform,
    sample: SAMPLE,
    outputFields: [
      { key: 'status', label: 'Status' },
      { key: 'claim', label: 'Primary Claim' },
      { key: 'domain', label: 'Domain' },
      // Set only on `no_match`, to say why the list is empty. Absent on every
      // other path, which is why it is declared: an undeclared field is not
      // offerable in the editor at all.
      { key: 'message', label: 'Message' },
    ],
  },
};
