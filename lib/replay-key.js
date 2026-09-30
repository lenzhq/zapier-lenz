'use strict';

/**
 * An `Idempotency-Key` that survives a Zapier replay (#19, Lenz#425).
 *
 * The problem: when our 28 s abort fires on a request the server had already
 * accepted, lib/errors.js maps it to ThrottledError and Zapier REPLAYS the
 * step — a fresh process and a fresh SDK client. A key the SDK generates is
 * random per call, so it does not survive; the server sees a new request and
 * charges again.
 *
 * What a key needs to be: stable across the replay of ONE run, and different
 * for every other run. Zapier exposes no run id, so the key is derived from
 * what a replay shares with its original — the Zap, the input, and (near
 * enough) the time — and hashed, so the header carries no user text.
 *
 * The time bucket is the deliberate compromise, and each caller picks its own
 * width. A purely content-derived key would replay the first answer for the
 * server's whole 24 h window; the bucket cuts that to about the window a
 * replay lives in. The cost is that one Zap sending the same input twice ON
 * PURPOSE inside one bucket gets the first answer twice. A replay that
 * straddles a bucket boundary gets a new key and can still double-run:
 * accepted rather than closed, because the SDK sends one key and carrying two
 * would mean two requests. A narrower bucket trades fewer deliberate repeats
 * collapsing for more straddled replays.
 *
 *   caller                 window   why
 *   creates/assess.js      1 h      the same claim re-checked within an hour
 *                                   is almost always a replay
 *   creates/ask.js         10 min   asking the same question again is NORMAL
 *                                   on /ask (the answer depends on the
 *                                   conversation so far), so the window stays
 *                                   just wide enough to cover a replay
 *
 * `bundle.meta.zap.id` is `@deprecated` in zapier-platform-core's types and
 * absent from the current bundle docs, so it may be missing on a live run.
 * The key then falls back to the input and the time alone rather than to
 * nothing: the server scopes keys per credential already, so the collision
 * that admits is the same account sending the same input in the same bucket
 * from two Zaps.
 *
 * `'utf8'` is not optional. `z.hash` defaults its INPUT encoding to `'binary'`
 * (latin1), which keeps only the low byte of each UTF-16 unit — so `一`
 * (U+4E00) and `伀` (U+4F00) would hash identically.
 */

const { DEFAULT_THROTTLE_DELAY, MAX_THROTTLE_DELAY } = require('./errors');

const HOUR_MS = 60 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;

const bucketOf = (windowMs, now = Date.now()) => Math.floor(now / windowMs);

/**
 * The key for this run. `parts` are the request's own inputs, in a fixed
 * order; missing values count as ''.
 */
const replayKey = (z, bundle, parts, windowMs) => {
  const zapId = (bundle.meta && bundle.meta.zap && bundle.meta.zap.id) || '';
  const fields = [zapId, bucketOf(windowMs), ...parts.map((p) => (p == null ? '' : p))];
  return z.hash('sha256', fields.join('|'), 'hex', 'utf8');
};

/**
 * Seconds until the NEXT bucket begins, plus a margin so a replay scheduled for
 * then lands inside it rather than on the boundary. Floored at the default
 * replay delay so it stays a real wait, capped at lib/errors.js's ceiling.
 * For a replay that must NOT reuse the current key (see creates/assess.js).
 */
const secondsToNextBucket = (windowMs, now = Date.now()) => {
  const next = (bucketOf(windowMs, now) + 1) * windowMs;
  const seconds = Math.ceil((next - now) / 1000) + 5;
  return Math.min(Math.max(seconds, DEFAULT_THROTTLE_DELAY), MAX_THROTTLE_DELAY);
};

module.exports = { replayKey, secondsToNextBucket, HOUR_MS, TEN_MINUTES_MS };
