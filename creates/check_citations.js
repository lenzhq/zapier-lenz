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
const { shapeCitation, shapeCitationIssue, CITATION_CHILDREN, CITATION_ISSUE_CHILDREN } = require('../lib/citations');
const { NO_FAILURE, isTerminal, shapeJobFailure, citationLimit } = require('../lib/jobs');

// Check Citations: POST /citecheck reads each source a draft cites and checks
// whether it says what the draft attributes to it. Usually seconds, but the
// checks share a 120 s budget server-side, which is past Zapier's ~30 s step
// limit, so it is a callback action like Verify a Claim and Review a Draft:
// the signed `citecheck.completed` / `citecheck.failed` body carries the full
// check.
//
// Text only. The API also takes up to 20 explicit statement/URL pairs, which
// a Zap step cannot express well; a draft with its links is what a Zap holds.

const ACTION_LABEL = 'Check Citations';

const EMPTY_RESULT = {
  outcome: '',
  clean: false,
  citations_checked: 0,
  citations_unchecked: 0,
  citation_issue_count: 0,
  citation_issues: [],
  citations: [],
  citation_limit_reached: false,
  credits_charged: 0,
  created_at: '',
  completed_at: '',
  message: '',
};

// From the recorded check in Lenz's citation docs (one supported, one
// contradicted). The test-sample signal is in the rationales.
const SAMPLE = {
  citecheck_id: '217c8a01',
  status: 'completed',
  outcome: 'issues_found',
  clean: false,
  citations_checked: 2,
  citations_unchecked: 0,
  citation_issue_count: 1,
  citation_issues: [
    {
      reference: 'https://en.wikipedia.org/wiki/Mount_Everest',
      cited_url: 'https://en.wikipedia.org/wiki/Mount_Everest',
      doi: '',
      statement: 'Mount Everest is 7,000 metres high.',
      finding: 'contradicted',
      rationale:
        'Sample rationale shown while testing in the Zap editor — a live, turned-on Zap checks the citations in your draft. The source gives 8,848.86 metres.',
      snippet: 'Its height was most recently measured in 2020 ... as 8,848.86 m (29,031 ft 8 1/2 in).',
      page_title: 'Mount Everest - Wikipedia',
    },
  ],
  citations: [
    {
      reference: 'https://en.wikipedia.org/wiki/Eiffel_Tower',
      cited_url: 'https://en.wikipedia.org/wiki/Eiffel_Tower',
      doi: '',
      statement: 'The Eiffel Tower was completed in 1889.',
      finding: 'supported',
      is_issue: false,
      rationale: 'Sample rationale shown while testing in the Zap editor. The infobox gives 31 March 1889.',
      snippet: 'Completed | 31 March 1889',
      page_title: 'Eiffel Tower - Wikipedia',
    },
    {
      reference: 'https://en.wikipedia.org/wiki/Mount_Everest',
      cited_url: 'https://en.wikipedia.org/wiki/Mount_Everest',
      doi: '',
      statement: 'Mount Everest is 7,000 metres high.',
      finding: 'contradicted',
      is_issue: true,
      rationale: 'Sample rationale shown while testing in the Zap editor. The source gives 8,848.86 metres.',
      snippet: 'Its height was most recently measured in 2020 ... as 8,848.86 m (29,031 ft 8 1/2 in).',
      page_title: 'Mount Everest - Wikipedia',
    },
  ],
  citation_limit_reached: false,
  credits_charged: 2,
  created_at: '2026-09-27T19:24:05Z',
  completed_at: '2026-09-27T19:24:08Z',
  message: '',
  ...NO_FAILURE,
};

// One shaper for the signed callback and the read by id (getCitecheck).
const shapeCitecheck = (citecheckId, check) => {
  const c = check || {};
  const summary = c.summary || {};
  const counts = summary.citation_checks || {};
  const issues = (c.citation_issues || []).map(shapeCitationIssue);
  const status = c.status || 'queued';
  return {
    citecheck_id: c.citecheck_id || citecheckId,
    status,
    outcome: c.outcome || '',
    clean: c.outcome === 'clean',
    citations_checked: counts.checked ?? 0,
    // Unreadable or failed citations are refunded; they are not issues.
    citations_unchecked: (counts.unchecked ?? 0) + (counts.failed ?? 0),
    citation_issue_count: issues.length,
    citation_issues: issues,
    citations: (c.citations || []).map(shapeCitation),
    // The draft cited more sources than Citations to Check allowed.
    citation_limit_reached: summary.citation_limit_reached === true,
    credits_charged: (c.credits && c.credits.charged) ?? 0,
    created_at: c.created_at || '',
    completed_at: c.completed_at || '',
    ...(status === 'failed' ? shapeJobFailure(c.failure) : NO_FAILURE),
    message: isTerminal(status)
      ? ''
      : `This citation check was still running when Zapier resumed the step. It will finish in Lenz; its Citation Check ID is ${c.citecheck_id || citecheckId}.`,
  };
};

const fromSignedCitecheck = (bundle) => {
  const parsed = parseSignedCallback(bundle);
  if (!parsed.event) return parsed;
  const event = parsed.event;
  const citecheckId = bundle.outputData && bundle.outputData.citecheck_id;
  if (event.event !== 'citecheck.completed' && event.event !== 'citecheck.failed') {
    return { fallback: `event ${event.event || 'unknown'} is not the citation check's result` };
  }
  if (!citecheckId || event.citecheckId !== citecheckId) {
    return { fallback: 'callback is for a different citation check' };
  }
  if (!event.citecheck || typeof event.citecheck !== 'object' || !event.citecheck.status) {
    return { fallback: 'callback carried no citation check' };
  }
  return { output: shapeCitecheck(citecheckId, event.citecheck) };
};

const citecheckInput = (bundle) => {
  const input = bundle.inputData || {};
  return {
    text: input.text,
    // 1 to 20 on the server: 0 or blank is the default (20), more is 20.
    maxCitations: citationLimit(input.maxCitations),
    language: input.language || undefined,
  };
};

// Replay-stable (lib/replay-key.js): every checked citation costs a credit,
// so a replayed submit must return the first check. The callback URL is in
// the key for the reason given in creates/review_draft.js: the server binds
// the key to a body that includes `webhook_url` (check_idempotency_body in
// lenz/api/citecheck.py).
const citecheckKey = (z, bundle, input, callbackUrl) =>
  replayKey(z, bundle, ['citecheck', callbackUrl, input.text, input.maxCitations, input.language], HOUR_MS);

const perform = async (z, bundle) => {
  const client = lenzClient(bundle);

  if (bundle.meta && bundle.meta.isLoadingSample) {
    await requireWebhookSecretWhileTesting(z, client, ACTION_LABEL);
    return { ...SAMPLE };
  }

  const input = citecheckInput(bundle);
  const callbackUrl = z.generateCallbackUrl();
  return client
    .citecheck({
      ...input,
      webhookUrl: callbackUrl,
      idempotencyKey: citecheckKey(z, bundle, input, callbackUrl),
    })
    .then((accepted) => ({
      ...EMPTY_RESULT,
      ...NO_FAILURE,
      citecheck_id: accepted.citecheck_id,
      status: accepted.status || 'queued',
    }))
    .catch((err) => {
      if (isWebhookSecretMissing(err)) throw webhookSecretMissing(z, ACTION_LABEL);
      return mapLenzError(z, err);
    });
};

const performResume = async (z, bundle) => {
  const signed = fromSignedCitecheck(bundle);
  if (signed.output) {
    z.console.log('Citation check read from the signed Lenz callback (no API call).');
    return signed.output;
  }
  z.console.log(`Citation check read by id: ${signed.fallback}.`);
  const citecheckId = bundle.outputData.citecheck_id;
  const check = await lenzClient(bundle)
    .getCitecheck(citecheckId)
    .catch((err) => mapLenzError(z, err));
  return shapeCitecheck(citecheckId, check);
};

module.exports = {
  key: 'check_citations',
  noun: 'Citation Check',
  display: {
    label: 'Check Citations',
    description:
      'Reads each source a draft links to and checks that it says what the draft claims it says.',
  },
  operation: {
    inputFields: [
      {
        key: 'text',
        label: 'Draft',
        type: 'text',
        required: true,
        helpText:
          'A draft with its sources: markdown links, bare URLs, DOIs (doi: or doi.org) or [1]-style markers with a reference list. Up to 50,000 characters; a longer draft is refused, not cut. Clicking Test shows an example check so you can map the output fields; a turned-on Zap checks this draft.',
      },
      {
        key: 'maxCitations',
        // A maximum, and blank is "all of them": the label says so, because
        // "Citations to Check" read as a field that had to be filled in.
        // 20 is the API's per-request ceiling (max_citations), not ours.
        label: 'Maximum Citations to Check',
        type: 'integer',
        required: false,
        placeholder: '20',
        helpText:
          'Leave blank to check up to 20 citations, the most one check takes; a larger number counts as 20. Enter a smaller number to check only the first ones in the draft. A link used twice counts twice. If the draft has more citations than this number, Citation Limit Reached is true and the rest are not checked. Each checked citation costs 1 credit; one Lenz could not read is not charged.',
      },
      languageField(),
    ],
    perform,
    performResume,
    sample: SAMPLE,
    outputFields: [
      { key: 'citecheck_id', label: 'Citation Check ID' },
      { key: 'status', label: 'Status' },
      { key: 'outcome', label: 'Outcome' },
      { key: 'clean', label: 'Clean', type: 'boolean' },
      { key: 'citations_checked', label: 'Citations Checked', type: 'integer' },
      { key: 'citations_unchecked', label: 'Citations Not Checked', type: 'integer' },
      { key: 'citation_issue_count', label: 'Citation Issue Count', type: 'integer' },
      { key: 'citation_issues', label: 'Citation Issues', list: true, children: CITATION_ISSUE_CHILDREN },
      { key: 'citations', label: 'Citations', list: true, children: CITATION_CHILDREN },
      { key: 'citation_limit_reached', label: 'Citation Limit Reached', type: 'boolean' },
      { key: 'credits_charged', label: 'Credits Charged', type: 'integer' },
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
