'use strict';

// Runs every action over the recorded API responses in test/fixtures/canonical
// (the `2026-10-11` shape, the one this app asks for) and returns what each
// produced, keyed by fixture name. test/outputs.test.js compares the result
// with test/fixtures/oracle/outputs.json.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET = 'whsec_test';
const AUTH = { access_token: 'lat_good', webhook_secret: SECRET };
const TASK_ID = '2f8b2e2b6a4a4e6c9e8f9a6c3f4b2a1c';
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'canonical');
const ORACLE = path.join(__dirname, '..', 'fixtures', 'oracle', 'outputs.json');

const fixtureNames = () =>
  fs
    .readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();

const loadFixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf-8'));

// The outputs recorded before the app stopped reading the earlier response
// shape: { mocked, reads, starts }, each keyed by fixture name.
const loadOracle = () => JSON.parse(fs.readFileSync(ORACLE, 'utf-8'));

// What an output is compared as: its JSON, key order included, with the
// replay wait (which depends on the clock) left out.
const normalize = (value) =>
  JSON.parse(
    JSON.stringify(value, (key, v) => {
      if (key === 'delay') return 'N';
      return typeof v === 'string' ? v.replace(/Retrying in \d+s/g, 'Retrying in Ns') : v;
    }),
  );

const sign = (content) =>
  `sha256=${crypto.createHmac('sha256', SECRET).update(Buffer.from(content, 'utf-8')).digest('hex')}`;

// A signed callback as Zapier hands it over, stamped now (the signature check
// refuses an old one).
const signed = (payload) => {
  const content = JSON.stringify({ ...payload, delivered_at: new Date().toISOString() });
  return { content, headers: { 'Http-Content-Type': 'application/json', 'Http-X-Lenz-Signature': sign(content) } };
};

// How an error is recorded: its class and message, with the replay wait (which
// depends on the clock) left out.
const describeError = (err) => {
  let message = String(err.message).split('\n')[0];
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed === 'object') {
      delete parsed.delay;
      message = JSON.stringify(parsed);
    }
  } catch (e) {
    // not JSON: leave as is
  }
  return { __error: { name: err.name, message: message.replace(/Retrying in \d+s/g, 'Retrying in Ns') } };
};

// The call each fixture family is read by: the action function, the mocked
// client, and the bundle.
const plan = (App, name, body) => {
  const ops = App.creates;
  const rejecting = (jest) => jest.fn().mockRejectedValue(new Error('read by id'));
  if (name.startsWith('assess__')) {
    return {
      fn: ops.assess.operation.perform,
      client: (jest) => ({ assess: jest.fn().mockResolvedValue(body) }),
      bundle: { authData: AUTH, inputData: { text: 'x' } },
    };
  }
  if (name.startsWith('extract__')) {
    return {
      fn: ops.extract_claims.operation.perform,
      client: (jest) => ({ extract: jest.fn().mockResolvedValue(body) }),
      bundle: { authData: AUTH, inputData: { text: 'x' } },
    };
  }
  if (name.startsWith('verify__status')) {
    return {
      fn: ops.verify_claim.operation.performResume,
      client: (jest) => ({ getStatus: jest.fn().mockResolvedValue(body) }),
      bundle: { authData: AUTH, outputData: { task_id: body.task_id || TASK_ID } },
    };
  }
  if (name.startsWith('verify__list')) {
    return {
      fn: App.triggers.new_verification.operation.perform,
      client: (jest) => ({ request: jest.fn().mockResolvedValue(body) }),
      bundle: { authData: AUTH },
    };
  }
  if (name.startsWith('review__get')) {
    return {
      fn: ops.review_draft.operation.performResume,
      client: (jest) => ({ getReview: jest.fn().mockResolvedValue(body) }),
      bundle: { authData: {}, outputData: { review_id: body.review_id } },
    };
  }
  if (name.startsWith('citecheck__get')) {
    return {
      fn: ops.check_citations.operation.performResume,
      client: (jest) => ({ getCitecheck: jest.fn().mockResolvedValue(body) }),
      bundle: { authData: {}, outputData: { citecheck_id: body.citecheck_id } },
    };
  }
  if (name.startsWith('webhook__verification')) {
    return {
      fn: ops.verify_claim.operation.performResume,
      client: (jest) => ({ getStatus: rejecting(jest) }),
      bundle: { authData: AUTH, outputData: { task_id: body.task_id }, rawRequest: signed(body) },
    };
  }
  if (name.startsWith('webhook__review')) {
    return {
      fn: ops.review_draft.operation.performResume,
      client: (jest) => ({ getReview: rejecting(jest) }),
      bundle: { authData: AUTH, outputData: { review_id: body.review_id }, rawRequest: signed(body) },
    };
  }
  if (name.startsWith('webhook__citecheck')) {
    return {
      fn: ops.check_citations.operation.performResume,
      client: (jest) => ({ getCitecheck: rejecting(jest) }),
      bundle: { authData: AUTH, outputData: { citecheck_id: body.citecheck_id }, rawRequest: signed(body) },
    };
  }
  return null;
};

// -> { [fixture name]: output | { __error: { name, message } } }
const runAll = async ({ App, appTester, LenzClient, jest }) => {
  const out = {};
  for (const name of fixtureNames()) {
    const body = loadFixture(name);
    const p = plan(App, name, body);
    if (!p) continue;
    LenzClient.mockImplementation(() => p.client(jest));
    try {
      out[name] = await appTester(p.fn, p.bundle);
    } catch (err) {
      out[name] = describeError(err);
    }
  }
  return out;
};

module.exports = { runAll, fixtureNames, loadFixture, loadOracle, normalize, ORACLE, signed, AUTH, TASK_ID };
