'use strict';

const { mapLenzError, isNoResponse } = require('../lib/errors');
const { replayKey, secondsToNextBucket, HOUR_MS } = require('../lib/replay-key');
const { lenzClient, CALL_TIMEOUT_MS } = require('../client');
const { languageField, LANGUAGE_HELP_TEXT_AUTO } = require('../lib/languages');
const {
  isObject,
  NO_CHECKABLE_CLAIM,
  outputCode,
  isNothingCheckable,
  readFailure,
  passedFrom,
  ASSESS_NO_CLAIM_MESSAGE,
  ASSESS_COMPOUND_HINT,
  searchedPages,
} = require('../lib/shapes');

// `status` here is BUILT by this action, not passed through from the API:
// `ok` when the API returned at least one row, `no_claim` when it returned
// none. Those two are the whole vocabulary.
//
// `ambiguous` used to be a third value. The API retired it on 2026-09-12 — a
// vague input is now checked on its most likely reading instead of being
// bounced back with candidate readings — so the branch that produced it could
// never run again, and a Paths step with an `ambiguous` branch had one leg
// that would never fire. lenz-io ≥ 2.13.0 documents the retirement.
//
// `message` and `candidate_claims` are spread into EVERY branch, and declared
// here, because Zapier's Filter treats a MISSING field and an EMPTY one as
// different conditions ("does not exist" vs "is empty") — and the editor
// builds those filters from this sample while `outputFields` promises Message
// exists. Omit them on the happy path and a filter the user tested against
// the sample behaves differently on a live run. Same reasoning as NO_FAILURE
// in creates/verify_claim.js.
//
// `candidate_claims` is kept, always empty, for the same reason in reverse:
// it is a declared output that existing Zaps may map, and the server still
// sends the key. Removing it would be a breaking change for a field that
// costs nothing to carry.
//
// `not_a_claim` is true when the API says nothing in the input can be checked:
// no rows at all, or (either shape) every row has no checkable claim. It sits
// beside `status`, which keeps its own values.
//
// `more_claims` is the claims in the input that this call did not assess: past
// the per-call limit the API checks the most check-worthy ones and hands the
// rest back at the TOP level of its answer, free, to send on. It is a different
// thing from a row's own `identified_claims` (the other claims inside the one
// claim that row assessed), so it has its own key.
const NO_ERROR = { message: '', not_a_claim: false, candidate_claims: [], more_claims: [] };

// Every per-row key, present on every row. A verdict row has the verdict
// fields filled and the error fields empty; an Error row (`verdict: "Error"`)
// is the other way round. Both shapes carry every key, so a Filter built
// against the sample sees the same fields on a live run whichever kind of row
// comes back.
const NO_ROW_ERROR = { error_code: '', hint: '', identified_claims: [] };

// A failed row resolves on its own when its failure's class says so
// (`retryable`: a provider was down, or the call ran out of its time budget).
// The class decides, never a list of codes: `error_code` is an OPEN set, and a
// cause added later should land correctly. The answers about the input
// (`no_claim`) and our own failures (`internal`) are not retryable, so they
// stay as rows.
//
// A row in the earlier shape carries no class, only a code; for that shape
// alone the two codes it used for a transient cause stay the rule.
const EARLIER_TRANSIENT_CODES = new Set(['upstream_unavailable', 'timeout']);

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
      language: 'en',
      rationale:
        'Sample reviewer note shown while testing in the Zap editor — a live, turned-on Zap returns the real reasoning for your claim.',
      dissent: '',
      searched_pages: [
        { title: 'Sample page title shown while testing in the Zap editor', url: 'https://example.org/sample-page' },
      ],
      ...NO_ROW_ERROR,
    },
  ],
};

// A row with no verdict, in either shape: `status: failed` with a null verdict
// and a `failure` block, or `verdict: "Error"` with `error_code` and `hint`.
const isFailedRow = (c) => c.status === 'failed' || c.verdict === 'Error';

// The cause of a failed row, spelled as this output always has: `no_claim`
// for "nothing checkable". An open set; new causes pass through.
const rowErrorCode = (c) => {
  const f = readFailure({ failure: isObject(c.failure) ? c.failure : null });
  return outputCode(f.code || c.error_code || '', 'no_claim');
};

// Whether the same request can succeed on a retry: the failure block's
// `retryable`, else its class, else (an earlier-shape row, which has neither)
// the code.
const rowRetryable = (c) => {
  const f = readFailure({ failure: isObject(c.failure) ? c.failure : null });
  if (f.retryable !== null) return f.retryable;
  if (f.failureClass) return f.failureClass === 'upstream_unavailable';
  return EARLIER_TRANSIENT_CODES.has(rowErrorCode(c));
};

const moreClaims = (c) =>
  Array.isArray(c.more_claims) ? c.more_claims : Array.isArray(c.identified_claims) ? c.identified_claims : [];

// A row in the newer shape: it says `status` and never `error_code`.
const isStatusRow = (c) => typeof c.status === 'string' && !('error_code' in c);

// What a row's hint has always read: the failure's hint on a failed row; on a
// verdict row whose input held more claims, the sentence pointing at them.
// Earlier-shape rows carry their own `hint` and are read as sent.
const rowHint = (c) => {
  if (!isStatusRow(c)) return c.hint || '';
  if (isObject(c.failure)) return c.failure.hint || '';
  return moreClaims(c).length > 0 ? ASSESS_COMPOUND_HINT : '';
};

const shapeRow = (c) => ({
  claim: c.claim || '',
  // A failed row (`status: failed`, no verdict) reads `verdict: "Error"` and
  // `confidence: "low"`, the values a failed row has always had in this
  // output. Earlier-shape rows are read exactly as sent.
  verdict: c.status === 'failed' && !c.verdict ? 'Error' : c.verdict || null,
  confidence: c.status === 'failed' && !c.verdict ? 'low' : c.confidence || null,
  passed: passedFrom(c.verdict),
  // Null on all but one path. The API only fills this when the verdict
  // came from an existing full verification it can serve to this caller
  // (lenz/api/public_authed.py:1559) — a fresh panel result has no page to
  // link. So a Zap must handle it being empty; it is not a bug.
  verification_url: c.verification_url || null,
  // The language this verdict is written in, echoed per claim.
  language: c.language || '',
  // A reviewer's reasoning, not a checked source — the SDK is explicit that
  // sourced evidence means `verify`. `dissent` is deprecated: the Lenz API no
  // longer returns it (it is always null), so this is always ''. The key stays
  // so existing Zaps that map it keep working.
  rationale: c.rationale || '',
  dissent: c.dissent || '',
  // The pages the reviewers looked at, [{ title, url }]: pages to look at,
  // not checked sources (for those, run Verify a Claim). Filtered, and [] when
  // there are none, on an Error row, and from an API that predates the field.
  searched_pages: searchedPages(c.searched_pages),
  // Set only on an Error row: WHY it has no verdict. An open set — the SDK
  // types it `string` and says new causes may arrive in a minor version — so
  // branch on the ones you know and let the rest fall through. Today:
  // `no_claim`, `internal`, `upstream_unavailable`; a response in the earlier
  // shape can also say `framing_failed` or `timeout`. Error rows are free.
  error_code: rowErrorCode(c),
  // One sentence on what to send next. On every Error row, and on a verdict
  // row whose input held more claims than the one assessed.
  hint: rowHint(c),
  // The OTHER claims found in this input that were not assessed — a compound
  // input is assessed on its main claim. Send these as their own steps to
  // check the rest. `more_claims` is the newer name for `identified_claims`.
  identified_claims: moreClaims(c),
});

// The replay-stable Idempotency-Key (#19). Shared with creates/ask.js; the
// reasoning, and why Assess uses a one-hour window, is in lib/replay-key.js.
const assessKey = (z, bundle) =>
  replayKey(z, bundle, [(bundle.inputData || {}).language, (bundle.inputData || {}).text], HOUR_MS);

// What a Test shows when the check ran out of the call budget. Zapier gives a
// test step 30 s and a long text with many claims can take longer (about one in
// five with four or more claims), so the call is abandoned at CALL_TIMEOUT_MS.
// A live run replays; a person testing in the editor is shown the example,
// marked, and told why, rather than an error. The server may still finish the
// check and charge for it, and a Test and a live run share one Idempotency-Key
// (see assessKey), so clicking Test again in the same hour can be answered from
// the stored result; a different text, or a new hour, is a new check.
const EDITOR_TIMEOUT_MESSAGE =
  "This test did not get a result within Zapier's 30 seconds, so this is a sample, not a result for " +
  'your claim. The check may still finish and use credits. Click Test again within the hour to get ' +
  'its stored answer, or try a shorter text (a different text is a new check).';

const EDITOR_TIMED_OUT = Symbol('editor test ran out of the call budget');

const editorTimeoutSample = () => {
  const sample = structuredClone(SAMPLE);
  sample.message = EDITOR_TIMEOUT_MESSAGE;
  for (const c of sample.claims) c.claim = `SAMPLE, not a result for your claim: ${c.claim}`;
  return sample;
};

// Our abort fires at CALL_TIMEOUT_MS and the SDK reports it as a no-response
// failure like a DNS error or a reset, but its message names what happened:
// `AbortError` when the request was aborted, "timed out reading the response
// body" when the body read was. A reset says `fetch failed`. Both the message
// and the elapsed time must say timeout, a second under the budget for clock
// slack, so a reset 27 s in is still an error.
const TIMEOUT_MESSAGE = /AbortError|timed out reading the response body/;
const ranOutOfBudget = (err, startedAt) =>
  isNoResponse(err) && TIMEOUT_MESSAGE.test(String(err.message)) && Date.now() - startedAt >= CALL_TIMEOUT_MS - 1000;

// Fast 3-model panel verdict (~15s) — one entry per claim found in the
// text. Well under Zapier's 30s action timeout, so a live run is a plain
// sync call.
//
// Editor testing (isLoadingSample) checks the mapped text for real, like a live
// run: about 15 s against the editor's 30 s (the 28 s call budget stays), and
// one credit per claim assessed. The same Zap sending the same text again in
// the same hour bucket gets the stored answer back, free (see assessKey; a Test
// and a live run share that key). It used to return a canned Eiffel Tower
// verdict, which read as a wrong answer for whatever the user had mapped. Only
// a test with no text mapped yet gets the example, because there is nothing to
// check. Only a string counts as mapped text: a number or an object is not
// something the field produces.
const perform = async (z, bundle) => {
  const rawText = (bundle.inputData || {}).text;
  const mappedText = typeof rawText === 'string' ? rawText.trim() : '';
  if (bundle.meta && bundle.meta.isLoadingSample && !mappedText) {
    // Copied, not returned by reference: on a warm container the platform
    // could mutate the module-level object and every later user of that
    // container would see it. creates/verify_claim.js already does this.
    return structuredClone(SAMPLE);
  }

  const client = lenzClient(bundle);
  const isEditorTest = Boolean(bundle.meta && bundle.meta.isLoadingSample);
  const startedAt = Date.now();
  const result = await client
    .assess({
      text: bundle.inputData.text,
      language: bundle.inputData.language || undefined,
      // Stable across a Zapier replay of THIS run, different for the next
      // one. See replayKey for why it is built the way it is. `undefined`
      // lets the SDK fall back to its own random per-invocation key.
      idempotencyKey: assessKey(z, bundle),
      // Pinned per call, NOT left to the client-wide value. Since lenz-io
      // 2.12.0 `assess` waits `max(client timeoutMs, 45s)` unless the call
      // says otherwise — a floor chosen for scripts, where a slow panel is
      // better waited for than re-run. Here it would carry the call straight
      // past Zapier's ~30s step limit and undo the whole budget client.js
      // sets: the step is killed by the platform, counted as a failure, and
      // lib/errors.js never gets to map it. `extract` has the same floor at
      // 90s; creates/extract_claims.js pins it the same way.
      timeoutMs: CALL_TIMEOUT_MS,
    })
    .catch((err) => {
      if (isEditorTest && ranOutOfBudget(err, startedAt)) return EDITOR_TIMED_OUT;
      return mapLenzError(z, err);
    });

  if (result === EDITOR_TIMED_OUT) return editorTimeoutSample();

  if (!result.claims || result.claims.length === 0) {
    // The earlier shape says why in `error`; the newer one in a `failure`
    // block, whose answer to "no claim at all" this output has always worded
    // as ASSESS_NO_CLAIM_MESSAGE.
    return {
      status: 'no_claim',
      message:
        result.error ||
        (isObject(result.failure) ? ASSESS_NO_CLAIM_MESSAGE : '') ||
        'No verifiable factual claim was detected.',
      not_a_claim: true,
      // Deprecated on the API, always empty; see NO_ERROR.
      candidate_claims: [],
      more_claims: moreClaims(result),
      claims: [],
    };
  }

  const rows = result.claims.map(shapeRow);
  const nothingCheckable =
    result.status === NO_CHECKABLE_CLAIM ||
    result.status === 'not_a_claim' ||
    rows.every((r) => r.verdict === 'Error' && isNothingCheckable(r.error_code));

  // A transient failure can arrive INSIDE a 200, as rows: a provider was down,
  // or the call ran out of budget before this item (both `upstream_unavailable`
  // now; the earlier shape also said `timeout`), which the SDK says are "worth
  // resending as-is". An unresolved panel is the same kind of row. Returned as
  // rows they would read as `status: ok, passed: false` — and a Zap branching
  // on `passed` would fire its "claim failed fact-check" leg for a claim that
  // was never assessed, with nothing replaying. The SAME condition delivered
  // as a thrown 503 is mapped to ThrottledError by lib/errors.js and replayed,
  // so the two paths must agree.
  //
  // EVERY row, not any: Error rows are free but verdict rows are charged, so a
  // mixed result has spent credits that a replay would spend again. There the
  // honest answer is to return the rows — each transient one carries its
  // `error_code`, so a Zap can still tell "checked and failed" from "never
  // checked" — and let the user decide about the leftovers.
  //
  // "Nothing was charged" is safe to say here for the reason it is safe on the
  // typed-503 branch: the server produced these rows, and it produces an Error
  // row instead of charging.
  if (result.claims.every((c) => isFailedRow(c) && rowRetryable(c))) {
    // Into the NEXT hour bucket, not the default 60s — because of the key.
    // The server stores every 200 under its Idempotency-Key for 24h, and
    // this all-Error response IS a 200. A replay 60s later would carry the
    // same key (same Zap, same input, same hour) and be handed the stored
    // error rows straight back — then land here again, and again, every 60s
    // until the hour ticked over. Waiting for the next bucket means the
    // replay sends a new key and the server actually runs the panel.
    //
    // The price is a wait of up to an hour on a transient outage, where 60s
    // would do if the server did not persist an uncharged all-Error body.
    // That is the server's call to make (a short TTL for such responses is
    // the clean fix, and `_finalize_200` already takes a per-response TTL);
    // until it does, this is the honest client-side delay.
    const delay = secondsToNextBucket(HOUR_MS);
    throw new z.errors.ThrottledError(
      `Lenz could not check this claim right now (${rows[0].error_code}) — nothing was charged. ` +
        `Retrying in ${delay}s.`,
      delay,
    );
  }

  return {
    status: 'ok',
    ...NO_ERROR,
    not_a_claim: nothingCheckable,
    more_claims: moreClaims(result),
    claims: rows,
  };
};

module.exports = {
  key: 'assess',
  noun: 'Assessment',
  display: {
    label: 'Assess (Fast)',
    description:
      'Checks a claim and returns a verdict for it, in about 15 seconds. Several claims in one input are each assessed separately. A claim that could not be checked comes back as an "Error" row with an Error Code saying why and a Hint saying what to send instead.',
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
        helpText:
          'The claim to check. If it contains several claims, each is assessed separately. Up to 10,000 characters; longer input is cut off without warning, so send a long document to Extract Claims first. Clicking Test checks this claim for real and uses 1 credit per claim assessed, like a turned-on Zap.',
      },
      languageField(LANGUAGE_HELP_TEXT_AUTO),
    ],
    perform,
    sample: SAMPLE,
    outputFields: [
      { key: 'status', label: 'Status' },
      { key: 'message', label: 'Message' },
      // True when nothing in the input can be checked (no rows, or every row
      // has no checkable claim). Status is unchanged: `ok` or `no_claim`.
      { key: 'not_a_claim', label: 'Nothing Checkable', type: 'boolean' },
      // Declared because it is still emitted (always empty) and a Zap built
      // before the API retired it may map it. Dropping the declaration
      // would not break that Zap, but declaring it keeps the sample and the
      // field list honest with each other.
      { key: 'candidate_claims', label: 'Candidate Claims (always empty)', list: true },
      // Past the per-call limit: the claims this call did not assess, in the
      // API's order, to send on as their own steps. Empty when there are none.
      { key: 'more_claims', label: 'Claims Not Checked', list: true },
      // Declared as a line-item list with children, the same shape the
      // needs_input lists use in creates/verify_claim.js. Until 1.4.0
      // `outputFields` named only Status and Message, so every per-claim
      // value the action actually returns — the verdicts themselves — was
      // undiscoverable in the editor: a user could see them in a test result
      // but had nothing to map into the next step (#22).
      //
      // `passed` is the field to branch on. `verdict` is prose from a closed
      // set and `confidence` is low/medium/high, but `passed` is already
      // derived from the verdict by this action, so a Filter does not have to
      // enumerate the verdict vocabulary. `error_code` is the field to branch
      // on when `passed` is false and you need to know whether the claim
      // failed or was never checked.
      {
        key: 'claims',
        label: 'Claims',
        list: true,
        children: [
          { key: 'claim', label: 'Claim' },
          { key: 'verdict', label: 'Verdict' },
          { key: 'confidence', label: 'Confidence' },
          { key: 'passed', label: 'Passed', type: 'boolean' },
          { key: 'verification_url', label: 'Verification URL' },
          { key: 'language', label: 'Language' },
          { key: 'rationale', label: 'Reviewer Rationale' },
          { key: 'dissent', label: 'Reviewer Dissent (deprecated, always empty)' },
          {
            key: 'searched_pages',
            label: 'Pages the Reviewers Looked At',
            list: true,
            children: [
              { key: 'title', label: 'Title' },
              { key: 'url', label: 'URL' },
            ],
          },
          { key: 'error_code', label: 'Error Code' },
          { key: 'hint', label: 'Hint' },
          { key: 'identified_claims', label: 'Other Claims Found', list: true },
        ],
      },
    ],
  },
};
