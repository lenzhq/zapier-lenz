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
const perform = async (z, bundle) => {
  const client = new Lenz({ apiKey: bundle.authData.apiKey });

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
    const usage = await client.usage();
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
      ' **Requires a one-time setup step**: your API key needs a webhook secret generated before this action will work — go to lenz.io → API key settings → "Generate webhook secret" once, then come back and try again.' +
      ' **Testing shows example output**: clicking Test returns a fixed sample verdict so you can map the output fields — a turned-on Zap verifies the claim you actually enter.',
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
