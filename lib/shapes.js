'use strict';

// Readers for the Lenz API response shape this app asks for (client.js
// API_VERSION, `2026-10-11`). Every action reads the API's body here or beside
// the read, and builds its output from it.
//
// What an action OUTPUTS keeps the vocabulary it has always had. A saved Zap
// maps and filters on those keys and values, so the output says `no_claim`,
// `not_a_claim` and `Error` wherever the API says something else.

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const text = (v) => (typeof v === 'string' ? v : '');

// The code the API uses for "nothing here can be checked".
const NO_CHECKABLE_CLAIM = 'no_checkable_claim';

// A failure code as the output has always spelled it. "Nothing checkable" is
// `not_a_claim` on a verification and an extraction and `no_claim` on an
// assessment and a review; `family` names which word this output uses. Every
// other code passes through.
const outputCode = (code, family) => (code === NO_CHECKABLE_CLAIM ? family : text(code));

// A failure block, `{ code, detail, hint, failure_class, retryable }`, as the
// pieces the actions read. `detail` is the sentence; `code` is the machine
// word, in the API's own spelling. No block, or absent parts, read as '' (and
// `retryable` as null).
const readFailure = (block) => {
  const b = isObject(block) ? block : {};
  return {
    code: text(b.code),
    detail: text(b.detail),
    hint: text(b.hint),
    failureClass: text(b.failure_class),
    retryable: typeof b.retryable === 'boolean' ? b.retryable : null,
  };
};

// `modified_at` for a verification-shaped item, from its `completed_at`: null
// unless the completion falls on a later UTC calendar day than creation, which
// is the rule this output's `modified_at` has always followed. Read as
// instants, so an offset other than UTC still lands on its UTC day.
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

// The wording this output has always had for two values the API carries
// differently, so an output keeps the text it has always had:
// - the sentence of an Assess answer that found no claim at all;
// - the hint on an Assess row whose input held more claims than the one
//   assessed (the API lists them in `more_claims` with no hint).
const ASSESS_NO_CLAIM_MESSAGE = 'No verifiable claim detected';
const ASSESS_COMPOUND_HINT =
  'Assessed the main claim only. Send identified_claims as their own items to check the rest.';

module.exports = {
  isObject,
  NO_CHECKABLE_CLAIM,
  outputCode,
  readFailure,
  modifiedAtFrom,
  ASSESS_NO_CLAIM_MESSAGE,
  ASSESS_COMPOUND_HINT,
};
