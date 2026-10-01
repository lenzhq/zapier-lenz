'use strict';

// Citation rows are built by one server projection for both /review (when it
// checks citations) and /citecheck (lenz/review/projection.py), so one shaper
// serves Review a Draft and Check Citations.
//
// Every value is normalised to a string so a Zap mapping a field never meets
// `null` on one row and '' on the next.

// One problem citation (`citation_issues[]`): the cited source does not say
// what the draft attributes to it, or could not be found. `finding` is the
// server's word for which (contradicted, unsupported, not_found,
// metadata_mismatch, ...). Use `citation_issues` for "is this a problem", not
// the finding name: `partly_supported` stopped being an issue in 2026-09
// (lenz/api/schemas/review.py, is_issue), and the SDK's doc comment still
// lists it as one.
const shapeCitationIssue = (row) => ({
  reference: row.reference || '',
  cited_url: row.cited_url || '',
  doi: row.doi || '',
  statement: row.statement || '',
  finding: row.finding || '',
  rationale: row.rationale || '',
  snippet: row.snippet || '',
  page_title: row.page_title || '',
});

// Every checked citation (`citations[]`), issue or not. The check details sit
// one level down (`check`), the verdict in `result`.
const shapeCitation = (row) => {
  const result = row.result || {};
  const check = row.check || {};
  return {
    reference: row.reference || '',
    cited_url: row.cited_url || '',
    doi: row.doi || '',
    statement: row.statement || '',
    finding: result.finding || '',
    is_issue: result.is_issue === true,
    rationale: check.rationale || '',
    snippet: check.snippet || '',
    page_title: check.page_title || '',
  };
};

const CITATION_ISSUE_CHILDREN = [
  { key: 'reference', label: 'Reference' },
  { key: 'cited_url', label: 'Cited URL' },
  { key: 'doi', label: 'DOI' },
  { key: 'statement', label: 'Statement' },
  { key: 'finding', label: 'Finding' },
  { key: 'rationale', label: 'Rationale' },
  { key: 'snippet', label: 'Source Snippet' },
  { key: 'page_title', label: 'Page Title' },
];

const CITATION_CHILDREN = [
  { key: 'reference', label: 'Reference' },
  { key: 'cited_url', label: 'Cited URL' },
  { key: 'doi', label: 'DOI' },
  { key: 'statement', label: 'Statement' },
  { key: 'finding', label: 'Finding' },
  { key: 'is_issue', label: 'Is Issue', type: 'boolean' },
  { key: 'rationale', label: 'Rationale' },
  { key: 'snippet', label: 'Source Snippet' },
  { key: 'page_title', label: 'Page Title' },
];

// A terminal failure's block (`failure` on a failed review or check):
// `failure_class` is a closed set and `retryable` is true only for a
// transient cause, so a Paths step can branch on WHY.
const shapeJobFailure = (failure) => {
  const f = failure || {};
  return {
    error: f.hint || f.failure_reason || (failure ? 'The job failed.' : ''),
    failure_reason: f.failure_reason || '',
    failure_class: f.failure_class || '',
    retryable: failure ? (f.retryable ?? null) : null,
  };
};

module.exports = {
  shapeCitationIssue,
  shapeCitation,
  shapeJobFailure,
  CITATION_ISSUE_CHILDREN,
  CITATION_CHILDREN,
};
