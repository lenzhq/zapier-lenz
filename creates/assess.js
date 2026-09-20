'use strict';

const { mapLenzError, DEFAULT_THROTTLE_DELAY } = require('../lib/errors');
const { lenzClient, CALL_TIMEOUT_MS } = require('../client');
const { languageField } = require('../lib/languages');

function isPassingVerdict(verdict) {
  return verdict === 'True' || verdict === 'Mostly True';
}

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
const NO_ERROR = { message: '', candidate_claims: [] };

// Every per-row key, present on every row. A verdict row has the verdict
// fields filled and the error fields empty; an Error row (`verdict: "Error"`)
// is the other way round. Both shapes carry every key, so a Filter built
// against the sample sees the same fields on a live run whichever kind of row
// comes back.
const NO_ROW_ERROR = { error_code: '', hint: '', identified_claims: [] };

// The row causes that resolve on their own. The other two documented causes
// are answers about the input — `no_claim` wants different text and
// `framing_failed` is deterministic — so they stay as rows. Kept as a set
// rather than a negation because `error_code` is an OPEN set: a cause added
// in a minor version should land as a row, not as a replay.
const TRANSIENT_ROW_CODES = new Set(['upstream_unavailable', 'timeout']);

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
      ...NO_ROW_ERROR,
    },
  ],
};

const shapeRow = (c) => ({
  claim: c.claim || '',
  verdict: c.verdict || null,
  confidence: c.confidence || null,
  passed: isPassingVerdict(c.verdict),
  // Null on all but one path. The API only fills this when the verdict
  // came from an existing full verification it can serve to this caller
  // (lenz/api/public_authed.py:1559) — a fresh panel result has no page to
  // link. So a Zap must handle it being empty; it is not a bug.
  verification_url: c.verification_url || null,
  // The language this verdict is written in, echoed per claim.
  language: c.language || '',
  // A reviewer's reasoning, not a checked source — the SDK is explicit that
  // sourced evidence means `verify`. `dissent` is set only when a reviewer
  // landed far from the panel's verdict, so a non-empty value is itself a
  // signal worth branching on.
  rationale: c.rationale || '',
  dissent: c.dissent || '',
  // Set only on an Error row: WHY it has no verdict. An open set — the SDK
  // types it `string` and says new causes may arrive in a minor version — so
  // branch on the ones you know and let the rest fall through. Today:
  // `no_claim`, `framing_failed`, `upstream_unavailable`, `timeout`. Error
  // rows are free.
  error_code: c.error_code || '',
  // One sentence on what to send next. On every Error row, and on a verdict
  // row whose input held more claims than the one assessed.
  hint: c.hint || '',
  // The OTHER claims found in this input that were not assessed — a compound
  // input is assessed on its main claim. Send these as their own steps to
  // check the rest.
  identified_claims: Array.isArray(c.identified_claims) ? c.identified_claims : [],
});

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
    .catch((err) => mapLenzError(z, err));

  if (!result.claims || result.claims.length === 0) {
    return {
      status: 'no_claim',
      message: result.error || 'No verifiable factual claim was detected.',
      // Deprecated on the API, always empty; see NO_ERROR.
      candidate_claims: [],
      claims: [],
    };
  }

  const rows = result.claims.map(shapeRow);

  // A transient failure can arrive INSIDE a 200, as rows: `upstream_unavailable`
  // (a provider was down) and `timeout` (the call ran out of budget before this
  // item), both of which the SDK says are "worth resending as-is". Returned as
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
  if (rows.every((r) => r.verdict === 'Error' && TRANSIENT_ROW_CODES.has(r.error_code))) {
    const delay = DEFAULT_THROTTLE_DELAY;
    throw new z.errors.ThrottledError(
      `Lenz could not check this claim right now (${rows[0].error_code}) — nothing was charged. ` +
        `Retrying in ${delay}s.`,
      delay,
    );
  }

  return {
    status: 'ok',
    ...NO_ERROR,
    claims: rows,
  };
};

module.exports = {
  key: 'assess',
  noun: 'Assessment',
  display: {
    label: 'Assess (Fast)',
    description:
      'Checks a claim and returns a verdict for it, in about 10 seconds. Several claims in one input are each assessed separately. A claim that could not be checked comes back as an "Error" row with an Error Code saying why and a Hint saying what to send instead.',
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
      languageField(),
    ],
    perform,
    sample: SAMPLE,
    outputFields: [
      { key: 'status', label: 'Status' },
      { key: 'message', label: 'Message' },
      // Declared because it is still emitted (always empty) and a Zap built
      // before the API retired it may map it. Dropping the declaration
      // would not break that Zap, but declaring it keeps the sample and the
      // field list honest with each other.
      { key: 'candidate_claims', label: 'Candidate Claims (always empty)', list: true },
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
          { key: 'dissent', label: 'Reviewer Dissent' },
          { key: 'error_code', label: 'Error Code' },
          { key: 'hint', label: 'Hint' },
          { key: 'identified_claims', label: 'Other Claims Found', list: true },
        ],
      },
    ],
  },
};
