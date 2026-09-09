'use strict';

const { Lenz, VERSION: SDK_VERSION } = require('lenz-io');

const APP_VERSION = require('./package.json').version;

// Zapier reaches the Lenz API *through* the lenz-io SDK, and the SDK sends its
// own hardcoded `lenz-io-node/<ver>` User-Agent. Left alone, every Zap is
// logged server-side as a plain Node-SDK call — indistinguishable from a
// hand-written script — so neither the APICallLog admin nor the Discord
// #key-user-events ping can tell Zap traffic apart from anything else.
//
// Lenz attributes a client from the LEADING User-Agent token
// (lenz/api/client_detection.py maps `lenz-zapier` -> the `zapier` source), so
// overriding it files this app under its own name while the parenthetical
// keeps the SDK version readable for debugging.
//
// The SDK exposes no header option, but `fetch` is a documented constructor
// option — wrapping it is the supported way in, with no patching of the
// installed package.
const USER_AGENT = `lenz-zapier/${APP_VERSION} (lenz-io-node ${SDK_VERSION})`;

// `Headers` normalizes whatever the SDK passes (today a plain object) and is
// case-insensitive, so `set` replaces the SDK's own User-Agent rather than
// sending it twice.
const fetchAsZapier = (url, init = {}) => {
  const headers = new Headers(init.headers || {});
  headers.set('User-Agent', USER_AGENT);
  return fetch(url, { ...init, headers });
};

// Zapier kills a `perform` at about 30 seconds. Left on its defaults the SDK
// budgets far more than that for ONE call: `timeoutMs` (30s) applies per
// ATTEMPT, `maxRetries: 3` means four attempts, the backoff ladder adds
// 1+2+4s, and a stated `Retry-After` up to the SDK's 60s ceiling is slept
// through IN-PROCESS. Worst case is over two minutes inside a call the
// platform abandoned long before.
//
// When the two budgets collide the user gets ZAPIER's timeout — a hard error
// counting toward auto-disabling their Zap — instead of whatever
// lib/errors.js would have mapped. A `429 Retry-After: 45` is the clearest
// case: 45 is under the SDK's sleep ceiling, so it sleeps, is killed at 30s,
// and the ThrottledError branch written for exactly that case never runs.
//
// `maxRetries: 0` is the lever, not merely a smaller timeout: both the
// backoff and the Retry-After sleep are gated on `attempt < maxRetries`, and
// that sleep sits OUTSIDE the AbortController `timeoutMs` drives, so capping
// the timeout alone would not bound it.
//
// Retrying is the platform's job. With one attempt every failure reaches
// lib/errors.js, which decides whether Zapier should replay
// (ThrottledError), halt, or fail — and a Zapier replay does not spend our
// 30 seconds. This only works alongside the transient-failure mapping in
// lib/errors.js: on its own it would convert failures the SDK used to hide
// by retrying into hard errors, which is the opposite of the goal.
//
// 28s, and deliberately not less. With a single attempt this is the WHOLE
// budget, so every second cut here is a second taken off calls that would
// otherwise have succeeded. `/extract` is the exposed one: it accepts 50,000
// characters, has no wall-clock deadline of its own server-side, and is
// bounded only by the provider timeouts in lenz/constants.py
// (ANTHROPIC_TIMEOUT 45, OPENAI_TIMEOUT 60) — so a large document really can
// land in the 25-30s band. An earlier draft used 25s and would have failed
// exactly those calls, which succeed today.
//
// 2s of headroom is enough because everything after the abort is synchronous:
// mapLenzError does no I/O, so it costs microseconds. Going nearer 30s buys
// nothing and risks Zapier ending the step before our error is recorded.
//
// Past ~29s no value helps — the platform ceiling ends the step regardless, so
// an extraction slower than that cannot run synchronously in a Zap at all.
// That is a limit of the surface, not a number to tune.
const CALL_TIMEOUT_MS = 28000;

// Single construction point for the SDK client. Every action and trigger goes
// through this so a new one can't silently ship without the Zapier
// User-Agent — the attribution above only holds if it's applied everywhere.
const lenzClient = (bundle) =>
  new Lenz({
    apiKey: bundle.authData.apiKey,
    fetch: fetchAsZapier,
    maxRetries: 0,
    timeoutMs: CALL_TIMEOUT_MS,
  });

module.exports = { lenzClient, fetchAsZapier, USER_AGENT, CALL_TIMEOUT_MS };
