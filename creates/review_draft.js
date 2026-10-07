'use strict';

const { mapLenzError } = require('../lib/errors');
const { lenzClient } = require('../client');
const { languageField } = require('../lib/languages');
const { replayKey, HOUR_MS } = require('../lib/replay-key');
const {
  parseSignedCallback,
  requireWebhookSecretWhileTesting,
  isWebhookSecretMissing,
  webhookSecretMissing,
} = require('../lib/signed-callback');
const { shapeCitationIssue, CITATION_ISSUE_CHILDREN } = require('../lib/citations');
const { NO_FAILURE, isTerminal, shapeJobFailure, optionalInteger, citationLimit } = require('../lib/jobs');

// Review a Draft: POST /review reads a whole draft, quick-checks every claim
// in it, deep-checks the ones that look wrong or uncertain, and (when asked)
// checks its citations. It takes two to four minutes, far past Zapier's ~30 s
// step limit, so it is a callback action exactly like Verify a Claim: perform
// submits with a Zapier callback URL as `webhook_url`, and performResume reads
// the signed `review.completed` / `review.failed` body Lenz posts there, which
// carries the full review. A Zap would otherwise have to chain Extract,
// Assess and Verify over a list of claims, which Zapier cannot loop cleanly.

const ACTION_LABEL = 'Review a Draft';

// Every key on every branch, so a Filter built on the sample behaves the same
// on a live run whichever way the review ends (see test/schema.test.js).
const EMPTY_RESULT = {
  outcome: '',
  clean: false,
  issue_count: 0,
  issues: [],
  citation_issue_count: 0,
  citation_issues: [],
  citations_checked: 0,
  citations_unchecked: 0,
  citations_skipped: '',
  claims_checked: 0,
  deep_checks: 0,
  unchecked_claims: 0,
  input_truncated: false,
  credits_charged: 0,
  language: '',
  created_at: '',
  completed_at: '',
  message: '',
};

// Realistic and internally coherent (from a recorded review), so a chained
// test step reads as example data. The "this is a test sample" signal sits in
// the prose fields a user is likely to map on their own.
const SAMPLE = {
  review_id: '442b6aa9',
  status: 'completed',
  outcome: 'issues_found',
  clean: false,
  issue_count: 1,
  issues: [
    {
      claim: 'The EU AI Act entered into force in March 2024.',
      verdict: 'False',
      confidence: 'high',
      source: 'verification',
      key_finding:
        'Sample finding shown while testing in the Zap editor — a live, turned-on Zap returns the real findings for your draft.',
      rationale:
        'Sample rationale shown while testing in the Zap editor. The regulation was published on 12 July 2024 and entered into force on 1 August 2024.',
      suggested_rewrite: 'The EU AI Act entered into force on 1 August 2024.',
      url: 'https://lenz.io/c/eu-ai-act-entry-into-force-march-2024-c9b769e1',
      verification_id: 'c9b769e1',
    },
  ],
  citation_issue_count: 0,
  citation_issues: [],
  citations_checked: 0,
  citations_unchecked: 0,
  citations_skipped: '',
  claims_checked: 4,
  deep_checks: 2,
  unchecked_claims: 0,
  input_truncated: false,
  credits_charged: 14,
  language: 'en',
  created_at: '2026-09-27T19:20:11Z',
  completed_at: '2026-09-27T19:23:02Z',
  message: '',
  ...NO_FAILURE,
};

// The issue rows (`issues[]`): only the claims Lenz found a problem with. A
// row comes from the quick check (`source: assessment`) or from a deep check
// (`source: verification`, with a key finding and a lenz.io page). The
// suggested rewrite is the findings' correction of the claim and has NOT
// been verified itself.
const shapeIssue = (row) => ({
  claim: row.claim || '',
  verdict: row.verdict || '',
  confidence: row.confidence || '',
  source: row.source || '',
  key_finding: row.key_finding || '',
  rationale: row.rationale || '',
  suggested_rewrite: row.suggested_rewrite || '',
  url: row.url || '',
  verification_id: row.verification_id || '',
});

// One shaper for the signed callback (`review`, view=full) and the read by id
// (getReview): the server builds both with the same projection.
const shapeReview = (reviewId, review) => {
  const r = review || {};
  const summary = r.summary || {};
  const citationCounts = summary.citation_checks || {};
  const issues = (r.issues || []).map(shapeIssue);
  const citationIssues = (r.citation_issues || []).map(shapeCitationIssue);
  const status = r.status || 'queued';
  return {
    review_id: r.review_id || reviewId,
    status,
    // clean | issues_found | incomplete | unchecked, once the review ends.
    outcome: r.outcome || '',
    clean: r.outcome === 'clean',
    issue_count: issues.length,
    issues,
    citation_issue_count: citationIssues.length,
    citation_issues: citationIssues,
    citations_checked: citationCounts.checked ?? 0,
    // Unreadable or failed citations are refunded; they are not issues.
    citations_unchecked: (citationCounts.unchecked ?? 0) + (citationCounts.failed ?? 0),
    // Why citations were asked for and NOT checked: url_input, switched_off
    // or insufficient_credits. The review still completes without them, and
    // its outcome then says nothing about citations, so Clean alone cannot
    // tell a draft whose citations passed from one whose were never read.
    citations_skipped: summary.citations_skipped || '',
    // Quick checks that completed (`summary.claims_selected` also counts the
    // ones that failed).
    claims_checked: (summary.assessments && summary.assessments.completed) ?? 0,
    deep_checks: (summary.verifications && summary.verifications.completed) ?? 0,
    // Claims whose quick check failed, so Lenz has no verdict on them: a
    // review with these and no issues is `incomplete`, not clean.
    // `failures[]` also holds claims whose DEEP check failed after a quick
    // verdict (stage `verification`); those were checked.
    unchecked_claims: (r.failures || []).filter((f) => f.stage !== 'verification').length,
    // Past 50,000 characters the draft is cut, not refused.
    input_truncated: summary.input_truncated === true,
    credits_charged: (r.credits && r.credits.charged) ?? 0,
    language: r.language || '',
    created_at: r.created_at || '',
    completed_at: r.completed_at || '',
    ...(status === 'failed' ? shapeJobFailure(r.failure) : NO_FAILURE),
    // A review that has not ended yet is NOT a failure: Lenz posted to the
    // callback before the review finished (see fromSignedReview). Say so,
    // rather than send failure fields about a job that will most likely
    // complete.
    message: isTerminal(status)
      ? ''
      : `This review was still running when Zapier resumed the step. It will finish in Lenz; its Review ID is ${r.review_id || reviewId}.`,
  };
};

// The shaped output from the signed callback, or `{ fallback: <reason> }`.
//
// Only `review.completed` / `review.failed` finish the step. A review's own
// deep checks are told to post to the review's `webhook_url` too, and while
// their `verification.*` events are suppressed, a warranty-covered one still
// sends `certificate.timestamped` there (lenz/webhooks/lifecycle.py). Zapier
// resumes on the FIRST post to the callback URL and only once, so that event
// must not be read as the review's result: it falls back to reading the
// review by id.
const fromSignedReview = (bundle) => {
  const parsed = parseSignedCallback(bundle);
  if (!parsed.event) return parsed;
  const event = parsed.event;
  const reviewId = bundle.outputData && bundle.outputData.review_id;
  if (event.event !== 'review.completed' && event.event !== 'review.failed') {
    return { fallback: `event ${event.event || 'unknown'} is not the review's result` };
  }
  if (!reviewId || event.reviewId !== reviewId) {
    return { fallback: 'callback is for a different review' };
  }
  if (!event.review || typeof event.review !== 'object' || !event.review.status) {
    return { fallback: 'callback carried no review' };
  }
  return { output: shapeReview(reviewId, event.review) };
};

const reviewInput = (bundle) => {
  const input = bundle.inputData || {};
  return {
    text: input.text,
    language: input.language || undefined,
    depth: input.depth || undefined,
    // 0 is a real setting here (quick checks only), unlike blank.
    maxVerifications: optionalInteger(input.maxVerifications),
    // 0 and blank both mean "do not check citations".
    maxCitations: citationLimit(input.maxCitations),
    visibility: input.visibility || undefined,
  };
};

// The replay-stable Idempotency-Key (lib/replay-key.js). Review is the most
// expensive call this app makes, so a Zapier replay of the submit must get
// the first review back, not start (and charge for) a second one.
//
// The callback URL is part of the key, and has to be: the server binds the
// key to the whole body, `webhook_url` included (review_idempotency_body in
// lenz/api/review.py). A new run of the same draft carries a new callback
// URL; under the same key it would be refused (422 idempotency_body_mismatch),
// and even if it were not, the review it returned would have called back to
// the FIRST run's URL, leaving this one waiting for a callback that never
// comes. A replay of the same run carries the same URL and gets the first
// review.
const reviewKey = (z, bundle, input, callbackUrl) =>
  replayKey(
    z,
    bundle,
    [
      'review',
      callbackUrl,
      input.text,
      input.language,
      input.depth,
      input.maxVerifications,
      input.maxCitations,
      input.visibility,
    ],
    HOUR_MS,
  );

const perform = async (z, bundle) => {
  const client = lenzClient(bundle);

  // Editor testing never runs a real two-to-four-minute review and never
  // spends credits: only the free webhook-secret check, then the sample.
  if (bundle.meta && bundle.meta.isLoadingSample) {
    await requireWebhookSecretWhileTesting(z, client, ACTION_LABEL);
    return { ...SAMPLE };
  }

  const input = reviewInput(bundle);
  const callbackUrl = z.generateCallbackUrl();
  return client
    .review({
      ...input,
      webhookUrl: callbackUrl,
      idempotencyKey: reviewKey(z, bundle, input, callbackUrl),
    })
    // What Zapier parks as outputData and, if the callback never arrives,
    // what the user sees.
    .then((accepted) => ({
      ...EMPTY_RESULT,
      ...NO_FAILURE,
      review_id: accepted.review_id,
      status: accepted.status || 'queued',
    }))
    .catch((err) => {
      if (isWebhookSecretMissing(err)) throw webhookSecretMissing(z, ACTION_LABEL);
      return mapLenzError(z, err);
    });
};

const performResume = async (z, bundle) => {
  const signed = fromSignedReview(bundle);
  if (signed.output) {
    z.console.log('Review read from the signed Lenz callback (no API call).');
    return signed.output;
  }
  z.console.log(`Review read by id: ${signed.fallback}.`);
  const reviewId = bundle.outputData.review_id;
  const review = await lenzClient(bundle)
    .getReview(reviewId)
    .catch((err) => mapLenzError(z, err));
  return shapeReview(reviewId, review);
};

module.exports = {
  key: 'review_draft',
  noun: 'Review',
  display: {
    label: 'Review a Draft',
    description:
      'Checks every factual claim in a draft, researches the ones that look wrong or uncertain, and returns the problems with suggested fixes. Takes two to four minutes.',
  },
  operation: {
    inputFields: [
      {
        key: 'text',
        label: 'Draft',
        type: 'text',
        required: true,
        helpText:
          'The text to review, such as an AI-written answer, an article or an email. Up to 50,000 characters; longer text is cut and the Input Truncated output says so. Clicking Test shows an example review so you can map the output fields; a turned-on Zap reviews this draft.',
      },
      languageField(),
      {
        key: 'maxVerifications',
        label: 'Deep Checks',
        type: 'integer',
        required: false,
        helpText:
          'The most claims to research in depth, from 0 to 20. Leave blank for 5. Every claim is quick-checked first (1 credit each, up to 20 claims); the ones that look wrong or uncertain are then deep-checked at 10 credits each, or 5 at Low depth. 0 runs the quick checks only. With the defaults a review costs at most 70 credits, and the Credits Charged output says what it actually cost.',
      },
      {
        // See creates/verify_claim.js for what Low cuts. `sample` duplicates
        // `value` because FieldChoiceWithLabelSchema requires it.
        key: 'depth',
        label: 'Deep Check Depth',
        type: 'string',
        required: false,
        choices: [
          { value: 'standard', sample: 'standard', label: 'Standard — full research (10 credits each)' },
          { value: 'low', sample: 'low', label: 'Low — fewer sources, half the credits (5 each)' },
        ],
        helpText: 'How much research each deep check does. Leave blank for Standard.',
      },
      {
        key: 'maxCitations',
        // Off unless asked, unlike Check Citations: here blank skips them.
        label: 'Maximum Citations to Check',
        type: 'integer',
        required: false,
        placeholder: '0',
        helpText:
          'Also check that the sources the draft links to say what it claims they say. Leave blank or 0 to skip. Enter a number to check up to that many, the first ones in the draft: 20 at most, and a larger number counts as 20. A draft with more citations than that has the rest left unchecked; a link used twice counts twice. 1 credit per checked citation. For a citation check on its own, use Check Citations.',
      },
      {
        key: 'visibility',
        label: 'Visibility',
        type: 'string',
        required: false,
        choices: [
          { value: 'private', sample: 'private', label: 'Private — only you can see it' },
          { value: 'unlisted', sample: 'unlisted', label: 'Unlisted — anyone with the link' },
        ],
        helpText:
          'Who can open the deep checks this review creates. Leave blank for Private. Unlisted makes their lenz.io pages readable by anyone with the link, never listed publicly.',
      },
    ],
    perform,
    performResume,
    sample: SAMPLE,
    outputFields: [
      { key: 'review_id', label: 'Review ID' },
      { key: 'status', label: 'Status' },
      { key: 'outcome', label: 'Outcome' },
      { key: 'clean', label: 'Clean', type: 'boolean' },
      { key: 'issue_count', label: 'Issue Count', type: 'integer' },
      {
        key: 'issues',
        label: 'Issues',
        list: true,
        children: [
          { key: 'claim', label: 'Claim' },
          { key: 'verdict', label: 'Verdict' },
          { key: 'confidence', label: 'Confidence' },
          { key: 'source', label: 'Checked By' },
          { key: 'key_finding', label: 'Key Finding' },
          { key: 'rationale', label: 'Rationale' },
          { key: 'suggested_rewrite', label: 'Suggested Rewrite (not verified)' },
          { key: 'url', label: 'Lenz Page' },
          { key: 'verification_id', label: 'Verification ID' },
        ],
      },
      { key: 'citation_issue_count', label: 'Citation Issue Count', type: 'integer' },
      { key: 'citation_issues', label: 'Citation Issues', list: true, children: CITATION_ISSUE_CHILDREN },
      { key: 'citations_checked', label: 'Citations Checked', type: 'integer' },
      { key: 'citations_unchecked', label: 'Citations Not Checked', type: 'integer' },
      { key: 'citations_skipped', label: 'Citations Skipped Because' },
      { key: 'claims_checked', label: 'Claims Checked', type: 'integer' },
      { key: 'deep_checks', label: 'Deep Checks Run', type: 'integer' },
      { key: 'unchecked_claims', label: 'Claims Not Checked', type: 'integer' },
      { key: 'input_truncated', label: 'Input Truncated', type: 'boolean' },
      { key: 'credits_charged', label: 'Credits Charged', type: 'integer' },
      { key: 'language', label: 'Language' },
      { key: 'created_at', label: 'Created At', type: 'datetime' },
      { key: 'completed_at', label: 'Completed At', type: 'datetime' },
      { key: 'message', label: 'Message' },
      { key: 'error', label: 'Error' },
      { key: 'failure_reason', label: 'Failure Reason' },
      { key: 'failure_class', label: 'Failure Class' },
      { key: 'retryable', label: 'Retryable', type: 'boolean' },
    ],
  },
};
