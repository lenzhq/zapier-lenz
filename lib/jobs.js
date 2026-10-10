'use strict';

// Pieces the callback actions share (Verify a Claim, Review a Draft, Check
// Citations), so their outputs cannot drift apart.

const { readFailure, outputCode } = require('./shapes');

// The failure fields as they read when nothing failed. Spread into every
// branch: Zapier's Filter treats a MISSING field and an EMPTY one as different
// conditions, and the editor builds filters from the sample, which has them.
const NO_FAILURE = { error: '', failure_reason: '', failure_class: '', retryable: null };

const isTerminal = (status) => status === 'completed' || status === 'failed';

// A terminal failure's block (`failure` on a failed review or citation check,
// lenz/review/projection.py): `failure_class` is a closed set and `retryable`
// is true only for a transient cause, so a Paths step can branch on WHY.
// A failed job with no block still reads as failed.
//
// Read in either shape (`code` + `detail`, or `failure_reason`). The output
// keeps the earlier vocabulary: a review that found nothing checkable still
// reports `failure_reason: no_claim`.
// The hint the earlier shape gave, from a block in the newer shape. The two
// agree but for two cases. An `assessment_failed` review's earlier hint opened
// with the sentence the newer shape moved to `detail`, which is put back. A
// review that found nothing checkable in a draft kept under zero retention had
// no hint in the earlier shape (so the error read `no_claim`); the newer shape
// gives it the standard hint, and nothing in the body says which it was, so
// that error now reads the hint.
const earlierHint = (failure, f) => {
  const newer = failure && typeof failure === 'object' && 'code' in failure && !('failure_reason' in failure);
  if (newer && f.code === 'assessment_failed') return [f.detail, f.hint].filter(Boolean).join(' ');
  return f.hint;
};

const shapeJobFailure = (failure) => {
  const f = readFailure({ failure: failure || {} });
  const code = outputCode(f.code, 'no_claim');
  return {
    // The hint, else the code, as this output has always read. The newer
    // shape's `detail` sentence is not used on its own, so a failure with no
    // hint still reads as its code.
    error: earlierHint(failure, f) || code || 'The job failed.',
    failure_reason: code,
    failure_class: f.failureClass,
    retryable: failure ? f.retryable : null,
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
