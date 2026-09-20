'use strict';

const { mapLenzError } = require('../lib/errors');
const { lenzClient } = require('../client');
const { languageField } = require('../lib/languages');

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

// CHARACTERS, not UTF-16 code units. `'🙂'.length` is 2, so `.length` would
// refuse a 200-emoji focus the server accepts, and quote a number the user
// cannot reconcile with what they typed — the opposite of the whitespace
// rule above, which exists precisely so we refuse nothing the server takes.
const focusLength = (focus) => [...focus].length;

const perform = (z, bundle) => {
  const isSample = Boolean(bundle.meta && bundle.meta.isLoadingSample);

  // Measured BEFORE the sample return, not after. Focus is a static field
  // typed once into the Zap, so a check that runs only on live runs lets the
  // editor's Test pass green and then fails every scheduled run afterwards —
  // the same reason creates/verify_claim.js pre-checks its webhook secret
  // inside the isLoadingSample branch instead of waiting for the first run.
  //
  // Refused HERE rather than left to 422: the server never truncates, and a
  // silently shortened focus would return a subset of the claims with nothing
  // to indicate it happened — so the failure has to be loud and say the real
  // number.
  // `|| {}` because this now runs BEFORE the sample return, and a bundle
  // loading a sample is not guaranteed to carry inputData at all.
  const focus = normaliseFocus((bundle.inputData || {}).focus);
  const length = focusLength(focus);
  if (length > MAX_FOCUS_CHARS) {
    const tooLong =
      `Focus is ${length} characters and the limit is ${MAX_FOCUS_CHARS}. ` +
      'Shorten it — it is a hint about which claims you want, not a description of the text.';
    // Two classes for one condition, on purpose. In the editor a hard Error
    // is what makes Test fail visibly, which is the whole point of checking
    // this early. On a live run it is a permanent CONFIGURATION state — the
    // value is fixed in the Zap and retrying cannot change it — so a hard
    // error would count toward the error rate that auto-disables the Zap on
    // every scheduled run. That is the distinction lib/errors.js draws, and
    // the one creates/verify_claim.js already makes for a missing webhook
    // secret.
    if (isSample) {
      throw new z.errors.Error(tooLong, 'FocusTooLong', 422);
    }
    throw new z.errors.HaltedError(tooLong);
  }

  if (isSample) {
    // Copied, not returned by reference — see the same note in
    // creates/assess.js and creates/verify_claim.js.
    return Promise.resolve({ ...SAMPLE });
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
      // `||` rather than an overwrite: today ExtractOut carries no `message`
      // of its own, but if the API ever adds one (say, explaining a
      // `not_a_claim`) it must not be silently blanked by the spread below.
      return { ...result, message: message || (result && result.message) || '' };
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
      languageField(),
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
      // Present on EVERY path — filled on `no_match` to say why the list is
      // empty, `''` otherwise — never absent. Declared so it is offerable in
      // the editor; emitted empty so a Filter built against the sample
      // behaves the same on a live run (missing and empty are different
      // conditions to Zapier). An earlier version of this comment said
      // "absent on every other path", which is the exact bug `perform`
      // guards against.
      { key: 'message', label: 'Message' },
    ],
  },
};
