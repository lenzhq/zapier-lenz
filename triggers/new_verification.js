'use strict';

const { Lenz } = require('lenz-io');
const { mapLenzError } = require('../lib/errors');

// Polling trigger: Claim rows are only persisted once the pipeline reaches a
// terminal state, so every item on this page is already "completed" — no
// status filter needed. The endpoint is already newest-first
// (order_by('-created_at')) and scoped to the connected key's own claims.
// Zapier dedupes on `id`, so verification_id is aliased to it.
const perform = async (z, bundle) => {
  const client = new Lenz({ apiKey: bundle.authData.apiKey });
  // A polling trigger fires on every Zap, so an unmapped failure here is the
  // fastest way to accumulate errors against the user's account.
  const result = await client.verifications
    .list({ page: 1 })
    .catch((err) => mapLenzError(z, err));
  return result.items.map((item) => ({ id: item.verification_id, ...item }));
};

module.exports = {
  key: 'new_verification',
  noun: 'Verification',
  display: {
    label: 'New Verification Completed',
    description: 'Triggers when a claim submitted with this API key finishes fact-checking.',
  },
  operation: {
    type: 'polling',
    perform,
    sample: {
      id: 'ab12cd34',
      verification_id: 'ab12cd34',
      claim: 'The Eiffel Tower is 330 metres tall.',
      domain: 'science',
      verdict: 'True',
      confidence: 'high',
      lenz_score: 9,
      executive_summary: 'Confirmed by multiple official sources.',
      created_at: '2026-07-14T12:00:00Z',
      modified_at: null,
      language: 'en',
    },
    outputFields: [
      { key: 'id', label: 'ID' },
      { key: 'verification_id', label: 'Verification ID' },
      { key: 'claim', label: 'Claim' },
      { key: 'verdict', label: 'Verdict' },
      { key: 'confidence', label: 'Confidence' },
      { key: 'lenz_score', label: 'Lenz Score', type: 'integer' },
      { key: 'executive_summary', label: 'Executive Summary' },
      { key: 'created_at', label: 'Created At', type: 'datetime' },
    ],
  },
};
