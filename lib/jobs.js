'use strict';

// Pieces the callback actions share (Verify a Claim, Review a Draft, Check
// Citations), so their outputs cannot drift apart.

// The failure fields as they read when nothing failed. Spread into every
// branch: Zapier's Filter treats a MISSING field and an EMPTY one as different
// conditions, and the editor builds filters from the sample, which has them.
const NO_FAILURE = { error: '', failure_reason: '', failure_class: '', retryable: null };

const isTerminal = (status) => status === 'completed' || status === 'failed';

// A terminal failure's block (`failure` on a failed review or citation check,
// lenz/review/projection.py): `failure_class` is a closed set and `retryable`
// is true only for a transient cause, so a Paths step can branch on WHY.
// A failed job with no block still reads as failed.
const shapeJobFailure = (failure) => {
  const f = failure || {};
  return {
    error: f.hint || f.failure_reason || 'The job failed.',
    failure_reason: f.failure_reason || '',
    failure_class: f.failure_class || '',
    retryable: failure ? (f.retryable ?? null) : null,
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

module.exports = { NO_FAILURE, isTerminal, shapeJobFailure, optionalInteger, positiveInteger };
