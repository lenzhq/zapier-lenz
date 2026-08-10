'use strict';

/**
 * Map Lenz SDK errors onto Zapier's error taxonomy.
 *
 * Which Zapier error class you throw is not cosmetic — it decides what
 * happens to the user's Zap:
 *
 *   - `z.errors.Error`      → the run FAILS. Counts toward the account's
 *                             error rate, and enough of them gets the Zap
 *                             turned off automatically.
 *   - `z.errors.HaltedError`→ the run stops and is marked halted. Does NOT
 *                             count as an error, does NOT threaten the Zap.
 *   - `z.errors.ThrottledError(msg, delay)`
 *                           → Zapier re-queues and replays after `delay`
 *                             seconds.
 *   - `z.errors.ExpiredAuthError`
 *                           → the user is prompted to reconnect the account.
 *
 * Before this existed, every failure was a plain throw, so a customer who
 * simply ran out of Lenz credits accumulated hard errors and could have their
 * automation disabled — for a billing state that resolves itself the moment
 * they top up, or when the monthly quota resets.
 */

const { LenzError, LenzQuotaExceededError, LenzRateLimitError, LenzAuthError } = require('lenz-io');

/** Seconds Zapier should wait before replaying a throttled run. */
const DEFAULT_THROTTLE_DELAY = 60;

/**
 * Ceiling on a replay delay, in seconds.
 *
 * NOT because Zapier rejects longer ones — the platform documents no maximum,
 * and an earlier version of this comment claimed otherwise without evidence.
 * It's a bound on how long a single Zap run may sit queued. The trade is
 * explicit: the `/extract` cap is daily, so a wait clamped from ~24h to 1h
 * means the run replays hourly until the cap actually resets, rather than
 * occupying a queue slot for a day. Those replays are cheap (they 429
 * immediately) but they are not free — revisit if they ever show up as noise.
 */
const MAX_THROTTLE_DELAY = 60 * 60;

/**
 * Translate an error from a Lenz SDK call into the right Zapier error, and
 * throw it. Re-throws anything it doesn't recognise, unchanged.
 *
 * Usage: `.catch((err) => mapLenzError(z, err))` — it always throws, so the
 * catch block needs nothing after it.
 */
const mapLenzError = (z, err) => {
  // Out of credits, or the plan doesn't cover this call. HTTP 402.
  // HaltedError so a spent balance stops the run without counting against
  // the user's error rate — running out of credits must not disable a Zap.
  if (err instanceof LenzQuotaExceededError) {
    const upgradeUrl = err.upgradeUrl || 'https://lenz.io/plans';
    const resets = err.resetsAt ? ` Quota resets ${err.resetsAt}.` : '';
    throw new z.errors.HaltedError(
      `${err.message} Retrying won't help — top up or upgrade at ${upgradeUrl}, ` +
        `or wait for the period reset.${resets}`,
    );
  }

  // Per-key rate limit (today, the daily /extract cap). This one does clear,
  // so hand Zapier the wait and let it replay rather than burning a run.
  if (err instanceof LenzRateLimitError) {
    // `|| DEFAULT` catches 0/NaN/undefined/unparseable. A NEGATIVE retryAfter
    // is truthy, though, so it survives that and would otherwise clamp to a
    // 1-second replay — a hot retry loop against a server that just throttled
    // us. Floor at the default instead: a malformed wait is no wait at all.
    const stated = Number(err.retryAfter);
    const seconds = Number.isFinite(stated) && stated > 0 ? stated : DEFAULT_THROTTLE_DELAY;
    // Integer: the platform takes whole seconds, and 1.5 is not a wait anyone
    // meant to express.
    const delay = Math.min(Math.ceil(seconds), MAX_THROTTLE_DELAY);
    throw new z.errors.ThrottledError(`${err.message} Retrying in ${delay}s.`, delay);
  }

  // Bad or revoked key. ExpiredAuthError is what prompts the user to
  // reconnect the account, rather than leaving them to decode a 401.
  if (err instanceof LenzAuthError && err.statusCode === 401) {
    throw new z.errors.ExpiredAuthError(
      'Your Lenz API key was rejected. Reconnect this account with a current key from ' +
        'lenz.io → API keys.',
    );
  }

  // A 403 that is NOT a quota problem: a private verification, an IP block.
  // A real failure, but the message is worth keeping intact.
  if (err instanceof LenzError && err.statusCode === 403) {
    throw new z.errors.Error(err.message, 'Forbidden', 403);
  }

  throw err;
};

module.exports = { mapLenzError, DEFAULT_THROTTLE_DELAY, MAX_THROTTLE_DELAY };
