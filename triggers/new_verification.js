'use strict';

const { mapLenzError } = require('../lib/errors');
const { lenzClient } = require('../client');

// Polling trigger: Claim rows are only persisted once the pipeline reaches a
// terminal state, so every item on this page is already "completed" — no
// status filter needed. The endpoint is already newest-first
// (order_by('-created_at')) and scoped to the connected key's own claims.
// Zapier dedupes on `id`, so verification_id is aliased to it.
const perform = async (z, bundle) => {
  const client = lenzClient(bundle);
  // A polling trigger fires on every Zap, so an unmapped failure here is the
  // fastest way to accumulate errors against the user's account.
  const result = await client.verifications
    .list({ page: 1 })
    .catch((err) => mapLenzError(z, err));
  // key_finding is normalized to '' to match what the Verify a Claim action
  // emits (creates/verify_claim.js). The API always sends the field, so this
  // only bites if a future/older server omits it — but a field that is ''
  // on one surface and undefined on the other silently breaks a Zap that
  // maps it.
  return result.items.map((item) => ({
    id: item.verification_id,
    ...item,
    key_finding: item.key_finding || '',
  }));
};

module.exports = {
  key: 'new_verification',
  noun: 'Verification',
  display: {
    label: 'New Verification Completed',
    description: 'Triggers when a fact-check finishes.',
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
      key_finding: 'Official Eiffel Tower figures confirm a current height of 330 metres.',
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
      // One declarative sentence stating the finding; '' on claims that
      // pre-date the field. Carried through by the `...item` spread above.
      { key: 'key_finding', label: 'Key Finding' },
      { key: 'executive_summary', label: 'Executive Summary' },
      { key: 'created_at', label: 'Created At', type: 'datetime' },
    ],
  },
};
