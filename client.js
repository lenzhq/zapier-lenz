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

// Single construction point for the SDK client. Every action and trigger goes
// through this so a new one can't silently ship without the Zapier
// User-Agent — the attribution above only holds if it's applied everywhere.
const lenzClient = (bundle) =>
  new Lenz({ apiKey: bundle.authData.apiKey, fetch: fetchAsZapier });

module.exports = { lenzClient, fetchAsZapier, USER_AGENT };
