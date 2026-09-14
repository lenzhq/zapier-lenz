'use strict';

const { mapLenzError } = require('../lib/errors');
const { lenzClient } = require('../client');

// The API defaults to 20 per page and caps at 100
// (`page_size = min(max(page_size, 1), 100)` in lenz/api/public_authed.py).
// Zapier polls this trigger every 1-15 minutes and only ever reads page 1, so
// at the default any interval producing more than 20 completions silently
// LOSES the oldest ones — they scroll off page 1 before the next poll and the
// trigger never sees them. No error, no gap, nothing to notice. 100 is the
// most the server will give in one request, which is the cheapest way to make
// that five times harder to hit.
const PAGE_SIZE = 100;

// Polling trigger: Claim rows are only persisted once the pipeline reaches a
// terminal state, so every item on this page is already "completed" — no
// status filter needed. The endpoint is already newest-first
// (order_by('-created_at')).
//
// SCOPE: this is every completed verification the ACCOUNT owns, not just the
// ones made with the connected key — `list_verifications` filters on
// `Claim.objects.filter(user=user)`. A check run from the website, the MCP
// server or another key fires this Zap too. That surprises people, so it is
// stated here and in README.md rather than left to be discovered.
//
// Zapier dedupes on `id`, so verification_id is aliased to it.
const perform = async (z, bundle) => {
  const client = lenzClient(bundle);
  // Goes through `client.request` rather than `client.verifications.list`
  // because the SDK's list signature is `{ page }` only — it cannot express a
  // page size (lenz-io 2.9.0, client.ts:250). `request` is public on the
  // client for exactly this reason, though the SDK marks it as outside the
  // documented surface; switch back to `list({ page, pageSize })` if the SDK
  // ever grows the parameter. Going through the client rather than a raw
  // fetch keeps the Zapier User-Agent attribution and the error mapping.
  //
  // A polling trigger fires on every Zap, so an unmapped failure here is the
  // fastest way to accumulate errors against the user's account.
  const result = await client
    .request({
      method: 'GET',
      path: '/verifications',
      query: { page: 1, page_size: PAGE_SIZE },
    })
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
      // Capitalised, as the API emits it: Health, Science, Politics, Finance,
      // Tech, History, Legal, General. A lowercase sample teaches a filter on
      // "Domain = science" that never matches a live row.
      domain: 'Science',
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
