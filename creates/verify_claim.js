'use strict';

const { LenzError } = require('lenz-io');
const { mapLenzError } = require('../lib/errors');
const { lenzClient } = require('../client');

function isPassingVerdict(verdict) {
  return verdict === 'True' || verdict === 'Mostly True';
}

// Realistic, internally coherent example (Eiffel Tower) — Zapier's build
// guidelines want representative sample values ("'Bob', not 'string'"), not
// placeholder text, for public review. The "this is a test sample" signal
// lives in the action description (shown above the fields) and in the two
// prose fields a user is likely to map into a downstream step on its own —
// key_finding and executive_summary — NOT in the structured field values. A
// coherent example also means a chained editor test (e.g. a final "send
// email" step) reads as example data, never a mismatched real result; that
// is why key_finding carries the marker too rather than a bare factual
// sentence, since outputFields points users at it as the short form of the
// summary. Live runs never use SAMPLE (performResume builds from the real
// status.result), so this only shows while testing.
const SAMPLE = {
  task_id: '2f8b2e2b6a4a4e6c9e8f9a6c3f4b2a1c',
  status: 'completed',
  passed: true,
  verification_id: 'ab12cd34',
  claim: 'The Eiffel Tower is 330 metres tall.',
  verdict: 'True',
  confidence: 'high',
  lenz_score: 9,
  key_finding:
    'Sample finding shown while testing in the Zap editor — a live, turned-on Zap returns the real finding for your claim.',
  executive_summary:
    'Sample summary shown while testing in the Zap editor — a live, turned-on Zap returns the real analysis for your claim.',
  sources: [{ title: 'Official Eiffel Tower site', url: 'https://www.toureiffel.paris' }],
  // Failure fields — empty on this happy-path sample; populated when a live
  // verification ends in status: 'failed'.
  error: '',
  failure_reason: '',
  failure_class: '',
  retryable: null,
};

// The failure fields as they read when nothing failed. Spread into EVERY
// non-failed branch, because Zapier's Filter treats a MISSING field and an
// EMPTY one as different conditions ("does not exist" vs "is empty") — and the
// Zap editor builds those filters from SAMPLE, which promises all four. Omit
// them on the success path and a filter the user tested against the sample
// behaves differently on a live run.
const NO_FAILURE = { error: '', failure_reason: '', failure_class: '', retryable: null };

// Kicks off the full pipeline and hands Lenz a Zapier-managed callback URL as
// the per-call webhook_url. Zapier parks the Task as "waiting" until Lenz
// posts back to that URL (see performResume) or ~90s median passes.
const perform = async (z, bundle) => {
  const client = lenzClient(bundle);

  // Editor testing (isLoadingSample) never runs the real ~90s pipeline and
  // never spends a verify credit — Zapier's recommended handling for a
  // callback action. But rather than stubbing blindly, we make the ONE free
  // call that costs nothing (GET /me/usage — no credit) to answer the only
  // question the stub otherwise can't: does this key have a webhook secret?
  // Verify a Claim REQUIRES one (it always sends a callback webhook_url, which
  // Lenz refuses on a secret-less key). If it's missing, warn NOW at test time
  // instead of showing a false "accepted" and only failing on the first live
  // run. usage() also re-validates auth for free.
  //
  // Strict `=== false`: older servers that don't yet return the field leave it
  // undefined, so the check is a no-op there (plain stub) — the backend field
  // and this check can deploy in any order.
  if (bundle.meta && bundle.meta.isLoadingSample) {
    // Mapped like every other call: this is the FIRST place a revoked key
    // surfaces (the user clicking Test in the editor), so it's the last place
    // that should throw a raw SDK error instead of an ExpiredAuthError.
    const usage = await client.usage().catch((err) => mapLenzError(z, err));
    if (usage && usage.has_webhook_secret === false) {
      throw new z.errors.Error(
        'Verify a Claim needs a webhook secret on this API key, and this key doesn\'t have one yet. ' +
          'Go to lenz.io → API key settings → "Generate webhook secret" (Webhooks panel) once, then try this step again. ' +
          '(Assess, Extract Claims, and Ask Follow-Up work without a secret.)',
        'WebhookSecretMissing',
        422,
      );
    }
    return { ...SAMPLE };
  }

  const callbackUrl = z.generateCallbackUrl();

  return client
    .verify({
      claim: bundle.inputData.claim,
      sourceUrl: bundle.inputData.sourceUrl || undefined,
      language: bundle.inputData.language || undefined,
      webhookUrl: callbackUrl,
    })
    .then((accepted) => ({ task_id: accepted.task_id, status: 'processing' }))
    .catch((err) => {
      // Lenz rejects webhook_url on a key with no signing secret yet, tagged
      // with this machine-readable code (public_authed.py) — turn it into a
      // precise, actionable message instead of the raw API error text.
      if (err instanceof LenzError && err.body && err.body.code === 'webhook_secret_missing') {
        throw new z.errors.Error(
          'This API key doesn\'t have a webhook secret yet. Go to lenz.io → API key ' +
            'settings → "Generate webhook secret" (Webhooks panel) once, then try this step again.',
          'WebhookSecretMissing',
          422,
        );
      }
      return mapLenzError(z, err);
    });
};

// Lenz's webhook POST is only the wake-up signal here — the terminal result
// is fetched fresh via getStatus() so this never depends on how Zapier
// represents the raw callback body (bundle.cleanedRequest / rawRequest).
const performResume = async (z, bundle) => {
  const client = lenzClient(bundle);
  const status = await client
    .getStatus(bundle.outputData.task_id)
    .catch((err) => mapLenzError(z, err));

  if (status.status === 'completed' && status.result) {
    const result = status.result;
    return {
      task_id: bundle.outputData.task_id,
      status: 'completed',
      passed: isPassingVerdict(result.verdict),
      verification_id: result.verification_id || null,
      claim: result.claim || '',
      verdict: result.verdict || null,
      confidence: result.confidence || null,
      lenz_score: result.lenz_score ?? null,
      key_finding: result.key_finding || '',
      executive_summary: result.executive_summary || '',
      sources: (result.sources || []).map((s) => ({ title: s.title || '', url: s.url || '' })),
      ...NO_FAILURE,
    };
  }

  if (status.status === 'needs_input') {
    return {
      task_id: bundle.outputData.task_id,
      status: 'needs_input',
      reason: status.reason || '',
      message:
        'This claim is ambiguous or contains multiple sub-claims. Rephrase it to be more specific and re-run.',
      ...NO_FAILURE,
    };
  }

  // A terminal failure. failure_class is a closed set (upstream_unavailable |
  // insufficient_evidence | invalid_input | cancelled | internal); retryable is
  // true only for upstream_unavailable. Both are absent on verifications older
  // than 2026-08 — explicit fields so a Filter/Paths step can branch on WHY,
  // not parse prose.
  if (status.status === 'failed') {
    return {
      task_id: bundle.outputData.task_id,
      status: 'failed',
      error: status.error || status.failure_detail || status.failure_reason || 'Pipeline failed.',
      failure_reason: status.failure_reason || '',
      failure_class: status.failure_class || '',
      retryable: status.retryable ?? null,
    };
  }

  // Anything else: Lenz's callback fired before the pipeline reached a terminal
  // state. This is NOT a failure — the task is still running and will most
  // likely complete. Reporting it as 'failed' would send retryable: null, which
  // asserts "re-running this will not help" about a live task, so a Zap
  // branching on that field raises a false alarm on a verification that is
  // about to succeed. Surface the real status and leave the failure fields
  // empty; a Zap gating on `status is completed` still correctly skips it.
  return {
    task_id: bundle.outputData.task_id,
    status: status.status || 'processing',
    message:
      'Lenz signalled before this verification reached a terminal state — it is still ' +
      'running. Look it up by Task ID in Lenz, or re-run this Zap.',
    ...NO_FAILURE,
  };
};

module.exports = {
  key: 'verify_claim',
  noun: 'Verification',
  display: {
    label: 'Verify a Claim',
    // Zapier's build guidelines: concise, opens with a singular third-person
    // verb, ends with a period, and carries no platform name. The
    // webhook-secret requirement and the "Test returns a sample" note used to
    // sit here; both moved to help text, which is where Zapier asks for extra
    // detail and the only place Markdown is documented to render.
    description:
      'Runs the full fact-checking pipeline on one claim — research, debate, and panel review — and returns a sourced verdict with score and citations. Takes about 90 seconds.',
  },
  operation: {
    inputFields: [
      {
        key: 'claim',
        label: 'Claim',
        type: 'text',
        required: true,
        helpText:
          'The claim to investigate in depth. This action needs a webhook secret on your Lenz API key — generate it once under API key settings → Webhooks. Clicking Test shows an example verdict so you can map the output fields; a turned-on Zap verifies this claim and returns the real result.',
      },
      {
        key: 'sourceUrl',
        label: 'Source URL',
        type: 'string',
        required: false,
        helpText: 'Optional URL the claim was found on.',
      },
      {
        key: 'language',
        label: 'Language',
        type: 'string',
        required: false,
        helpText: 'Optional ISO 639-1 response language code (e.g. "es"). Defaults to English.',
      },
    ],
    perform,
    performResume,
    sample: SAMPLE,
    outputFields: [
      { key: 'task_id', label: 'Task ID' },
      { key: 'status', label: 'Status' },
      { key: 'passed', label: 'Passed', type: 'boolean' },
      { key: 'verification_id', label: 'Verification ID' },
      { key: 'claim', label: 'Claim' },
      { key: 'verdict', label: 'Verdict' },
      { key: 'confidence', label: 'Confidence' },
      { key: 'lenz_score', label: 'Lenz Score', type: 'integer' },
      // One declarative sentence stating the finding — the short form to map
      // into a Slack/email step when the full summary is too long. Empty on
      // claims that pre-date the field.
      { key: 'key_finding', label: 'Key Finding' },
      { key: 'executive_summary', label: 'Executive Summary' },
      // Failure fields — populated only when Status is 'failed', so a
      // Filter/Paths step can branch on WHY instead of parsing prose.
      { key: 'error', label: 'Error', helpText: 'Human-readable failure message. Empty on success.' },
      {
        key: 'failure_reason',
        label: 'Failure Reason',
        helpText: 'Where the pipeline stopped (e.g. "research_empty"). Empty on success.',
      },
      {
        key: 'failure_class',
        label: 'Failure Class',
        helpText:
          'Why it failed, from a closed set: upstream_unavailable, insufficient_evidence, ' +
          'invalid_input, cancelled, internal. Empty on success and on verifications older than 2026-08.',
      },
      {
        key: 'retryable',
        label: 'Retryable',
        type: 'boolean',
        helpText:
          'True only for upstream_unavailable — re-running the same claim later can succeed. ' +
          'For every other failure class, retrying the same input will not help.',
      },
    ],
  },
};
