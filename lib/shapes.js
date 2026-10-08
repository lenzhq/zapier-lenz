'use strict';

// Readers for the two response shapes the Lenz API can send. Every read in
// this app goes through here (or through a `??` fallback beside the read) so
// the same code works whichever shape arrives: the dated shape names are read
// first and the earlier names are the fallback.
//
// What an action OUTPUTS never changes with the shape it read. A saved Zap
// maps and filters on those keys and values, so the output keeps the earlier
// vocabulary (`no_claim`, `not_a_claim`, `Error`) wherever the API now says
// something else.

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const text = (v) => (typeof v === 'string' ? v : '');

// The code the API now uses for "nothing here can be checked".
const NO_CHECKABLE_CLAIM = 'no_checkable_claim';

// A failure code as the output has always spelled it. The API's one code for
// "nothing checkable" was `not_a_claim` on a verification and an extraction
// and `no_claim` on an assessment and a review; `family` names which word this
// output used. Every other code is unchanged.
const outputCode = (code, family) => (code === NO_CHECKABLE_CLAIM ? family : text(code));

// True when a code (either spelling) says nothing in the input can be checked.
const isNothingCheckable = (code) =>
  code === NO_CHECKABLE_CLAIM || code === 'not_a_claim' || code === 'no_claim';

// The failure of a body, in either shape:
//   dated:    { failure: { code, detail, hint, failure_class, retryable } }
//   earlier:  { failure_reason | error_code, error, hint, failure_class, retryable }
//             (a review keeps its block under `failure.failure_reason`)
// `detail` is the sentence; `code` is the machine word, in the API's own
// spelling. Absent parts read as '' (and `retryable` as null).
const readFailure = (body) => {
  const b = isObject(body) ? body : {};
  const block = isObject(b.failure) ? b.failure : null;
  const source = block || b;
  const retryable = source.retryable;
  return {
    code: text(block ? (block.code ?? block.failure_reason) : (b.failure_reason ?? b.error_code)),
    // On a body without a block, `error` is the sentence (a poll) — a webhook
    // that carries only a code in `error` is read apart, see verify_claim.
    detail: text(block ? block.detail : b.error),
    hint: text(source.hint),
    failureClass: text(source.failure_class),
    retryable: typeof retryable === 'boolean' ? retryable : null,
  };
};

// The earlier shape's `modified_at` for a verification-shaped item that
// carries `completed_at` instead: null unless the completion falls on a later
// UTC calendar day than creation, which is the rule the earlier field followed.
// Read as instants, so an offset other than UTC still lands on its UTC day.
const utcDay = (iso) => {
  if (typeof iso !== 'string' || !iso) return '';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
};

const modifiedAtFrom = (item) => {
  const completed = item.completed_at;
  const done = utcDay(completed);
  const made = utcDay(item.created_at);
  return done && made && done > made ? completed : null;
};

// The earlier shape's wording for two values the newer shape carries
// differently, so an output keeps the text it has always had:
// - the sentence of an Assess answer that found no claim at all;
// - the hint on an Assess row whose input held more claims than the one
//   assessed (the newer shape lists them in `more_claims` with no hint).
const ASSESS_NO_CLAIM_MESSAGE = 'No verifiable claim detected';
const ASSESS_COMPOUND_HINT =
  'Assessed the main claim only. Send identified_claims as their own items to check the rest.';

module.exports = {
  isObject,
  NO_CHECKABLE_CLAIM,
  outputCode,
  isNothingCheckable,
  readFailure,
  modifiedAtFrom,
  ASSESS_NO_CLAIM_MESSAGE,
  ASSESS_COMPOUND_HINT,
};
