'use strict';

// Pieces the callback actions share (Verify a Claim, Review a Draft, Check
// Citations), so their outputs cannot drift apart.

const { readFailure, outputCode } = require('./shapes');

// The failure fields as they read when nothing failed. Spread into every
// branch: Zapier's Filter treats a MISSING field and an EMPTY one as different
// conditions, and the editor builds filters from the sample, which has them.
const NO_FAILURE = { error: '', failure_reason: '', failure_class: '', retryable: null };

const isTerminal = (status) => status === 'completed' || status === 'failed';

// A terminal failure's block (`failure` on a failed review or citation check):
// `failure_class` is a closed set and `retryable` is true only for a transient
// cause, so a Paths step can branch on WHY. A failed job with no block still
// reads as failed.
//
// The output keeps its own vocabulary: a review that found nothing checkable
// reports `failure_reason: no_claim`.
//
// `error` is the hint, else the code, as this output has always read; the
// `detail` sentence is not used on its own, so a failure with no hint reads
// as its code. One exception: an `assessment_failed` review's error has always
// opened with the sentence the API gives as `detail`, so it is put in front of
// the hint.
const failureError = (f) => {
  if (f.code === 'assessment_failed') return [f.detail, f.hint].filter(Boolean).join(' ');
  return f.hint;
};

const shapeJobFailure = (failure) => {
  const f = readFailure(failure);
  const code = outputCode(f.code, 'no_claim');
  return {
    error: failureError(f) || code || 'The job failed.',
    failure_reason: code,
    failure_class: f.failureClass,
    retryable: f.retryable,
  };
};

// A number field's value, or undefined to leave it to the server's default.
// Blank is "use the default", never 0; a value that is not a number is too.
const optionalInteger = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
};

// For fields where the server's range starts at 1 (max_citations): 0 or less
// is treated as blank. /citecheck refuses 0 with a 422, and on Review a Draft
// 0 means "do not check citations", which is what leaving it out does.
const positiveInteger = (value) => {
  const n = optionalInteger(value);
  return n > 0 ? n : undefined;
};

// The most citations one review or check takes (max_citations on /citecheck,
// escalate.max_citations on /review: le=20 on the server).
const MAX_CITATIONS = 20;

// "Maximum Citations to Check": blank, 0 or less is "use the default", and a
// number above the server's ceiling is taken as the ceiling. Typing 50 or 100
// is how a person asks for "all of them"; sent as is, it was a 422 that
// failed the step.
const citationLimit = (value) => {
  const n = positiveInteger(value);
  return n === undefined ? undefined : Math.min(n, MAX_CITATIONS);
};

module.exports = {
  NO_FAILURE,
  isTerminal,
  shapeJobFailure,
  optionalInteger,
  positiveInteger,
  citationLimit,
  MAX_CITATIONS,
};
