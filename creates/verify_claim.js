'use strict';

const { Lenz, LenzError } = require('lenz-io');

function isPassingVerdict(verdict) {
  return verdict === 'True' || verdict === 'Mostly True';
}

const SAMPLE = {
  task_id: '2f8b2e2b6a4a4e6c9e8f9a6c3f4b2a1c',
  status: 'completed',
  passed: true,
  verification_id: 'ab12cd34',
  claim: 'The Eiffel Tower is 330 metres tall.',
  verdict: 'True',
  confidence: 'high',
  lenz_score: 9,
  // The prose "response" fields (executive_summary here, answer in ask.js)
  // carry an explicit sample label so a chained editor test — most visibly a
  // final "send email" step — can never be mistaken for a real, mismatched
  // result. Live runs never use SAMPLE (performResume builds from the real
  // status.result), so the label only ever shows during editor testing.
  executive_summary:
    'Sample summary shown while testing in the Zap editor — a live, turned-on Zap returns the real analysis for your claim.',
  sources: [{ title: 'Official Eiffel Tower site', url: 'https://www.toureiffel.paris' }],
};

// Kicks off the full pipeline and hands Lenz a Zapier-managed callback URL as
// the per-call webhook_url. Zapier parks the Task as "waiting" until Lenz
// posts back to that URL (see performResume) or ~90s median passes.
const perform = (z, bundle) => {
  // Editor testing (isLoadingSample) returns stubbed sample data and makes NO
  // real API call. This is Zapier's own recommended handling for a callback
  // action (the ~90s pipeline can't be waited on in the editor anyway), and
  // it means a user never spends a verify credit — nor triggers a full,
  // discarded pipeline run — just for clicking "Test step" while building
  // their Zap. Auth is already validated at connection time (GET /me/usage).
  // The one thing this can't catch at test time is a key with no webhook
  // secret yet; that's communicated up front (connection help text + the
  // action description) and still surfaces with a clear message on the first
  // live run (see the .catch below, which only runs live).
  if (bundle.meta && bundle.meta.isLoadingSample) {
    return Promise.resolve({ ...SAMPLE });
  }

  const client = new Lenz({ apiKey: bundle.authData.apiKey });
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
      throw err;
    });
};

// Lenz's webhook POST is only the wake-up signal here — the terminal result
// is fetched fresh via getStatus() so this never depends on how Zapier
// represents the raw callback body (bundle.cleanedRequest / rawRequest).
const performResume = async (z, bundle) => {
  const client = new Lenz({ apiKey: bundle.authData.apiKey });
  const status = await client.getStatus(bundle.outputData.task_id);

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
      executive_summary: result.executive_summary || '',
      sources: (result.sources || []).map((s) => ({ title: s.title || '', url: s.url || '' })),
    };
  }

  if (status.status === 'needs_input') {
    return {
      task_id: bundle.outputData.task_id,
      status: 'needs_input',
      reason: status.reason || '',
      message:
        'This claim is ambiguous or contains multiple sub-claims. Rephrase it to be more specific and re-run.',
    };
  }

  // 'failed', or a non-terminal status if the webhook somehow fired early.
  return {
    task_id: bundle.outputData.task_id,
    status: 'failed',
    error: status.error || status.failure_detail || status.failure_reason || 'Pipeline failed.',
  };
};

module.exports = {
  key: 'verify_claim',
  noun: 'Verification',
  display: {
    label: 'Verify a Claim',
    description:
      'Submits a claim to the full Lenz pipeline (research, debate, adjudication) and waits for the sourced verdict (~90s median). Reserve for high-stakes claims — use Assess for a faster check.' +
      ' **Requires a one-time setup step**: your API key needs a webhook secret generated before this action will work — go to lenz.io → API key settings → "Generate webhook secret" once, then come back and try again.',
  },
  operation: {
    inputFields: [
      {
        key: 'claim',
        label: 'Claim',
        type: 'text',
        required: true,
        helpText: 'The claim to investigate in depth.',
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
      { key: 'executive_summary', label: 'Executive Summary' },
    ],
  },
};
