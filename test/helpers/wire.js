'use strict';

// Runs every action over the recorded API responses with the REAL lenz-io
// client: only `fetch` is replaced, so whatever the SDK does to a body on its
// way to the action (defaults it fills, webhook parsing) is part of what is
// measured. Each call the app makes is recorded with its headers.

const path = require('path');
const { fixtureNames, loadFixture, signed, AUTH, TASK_ID } = require('./oracle');

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// A read that must not happen: the signed callback should have been enough.
// A 404 is final (never retried or replayed), so a fallback read shows up as
// an error in the output instead of passing silently.
const NOT_EXPECTED = { detail: 'Not found.', code: 'not_found' };

// The action, its bundle, and the body the network returns, per fixture family.
const plan = (App, name, body) => {
  const ops = App.creates;
  if (name.startsWith('assess__')) {
    return { fn: ops.assess.operation.perform, bundle: { authData: AUTH, inputData: { text: 'x' } }, reply: body };
  }
  if (name.startsWith('extract__')) {
    return { fn: ops.extract_claims.operation.perform, bundle: { authData: AUTH, inputData: { text: 'x' } }, reply: body };
  }
  if (name.startsWith('verify__status')) {
    return {
      fn: ops.verify_claim.operation.performResume,
      bundle: { authData: AUTH, outputData: { task_id: body.task_id || TASK_ID } },
      reply: body,
    };
  }
  if (name.startsWith('verify__list')) {
    return { fn: App.triggers.new_verification.operation.perform, bundle: { authData: AUTH }, reply: body };
  }
  if (name.startsWith('review__get')) {
    return {
      fn: ops.review_draft.operation.performResume,
      bundle: { authData: AUTH, outputData: { review_id: body.review_id } },
      reply: body,
    };
  }
  if (name.startsWith('citecheck__get')) {
    return {
      fn: ops.check_citations.operation.performResume,
      bundle: { authData: AUTH, outputData: { citecheck_id: body.citecheck_id } },
      reply: body,
    };
  }
  if (name.startsWith('webhook__verification')) {
    // A needs_input callback is always read from the status route; it reads
    // the recorded needs_input poll.
    const needsInput = name.includes('needs_input');
    return {
      fn: ops.verify_claim.operation.performResume,
      bundle: { authData: AUTH, outputData: { task_id: body.task_id }, rawRequest: signed(body) },
      reply: needsInput ? { ...loadFixture('verify__status_needs_input'), task_id: body.task_id } : null,
    };
  }
  if (name.startsWith('webhook__review')) {
    return {
      fn: ops.review_draft.operation.performResume,
      bundle: { authData: AUTH, outputData: { review_id: body.review_id }, rawRequest: signed(body) },
      reply: null,
    };
  }
  if (name.startsWith('webhook__citecheck')) {
    return {
      fn: ops.check_citations.operation.performResume,
      bundle: { authData: AUTH, outputData: { citecheck_id: body.citecheck_id }, rawRequest: signed(body) },
      reply: null,
    };
  }
  return null;
};

const describeError = (err) => ({ __error: { name: err.name, message: String(err.message).split('\n')[0] } });

// -> { outputs: { [fixture]: output }, calls: [{ url, headers }] }
const runWire = async ({ App, appTester, jest }) => {
  const outputs = {};
  const calls = [];
  const original = globalThis.fetch;
  try {
    for (const name of fixtureNames()) {
      const body = loadFixture(name);
      const p = plan(App, name, body);
      if (!p) continue;
      globalThis.fetch = jest.fn(async (url, init = {}) => {
        calls.push({ fixture: name, method: init.method || 'GET', url: String(url), headers: new Headers(init.headers || {}) });
        return p.reply ? json(200, p.reply) : json(404, NOT_EXPECTED);
      });
      try {
        outputs[name] = await appTester(p.fn, p.bundle);
      } catch (err) {
        outputs[name] = describeError(err);
      }
      // A read that never reached the network compared nothing: every
      // fixture that answers a read must have been fetched.
      if (p.reply && !calls.some((c) => c.fixture === name)) {
        throw new Error(`${name}: the action never made its read`);
      }
    }
  } finally {
    globalThis.fetch = original;
  }
  return { outputs, calls };
};

module.exports = { runWire, FIXTURES: path.join(__dirname, '..', 'fixtures') };
