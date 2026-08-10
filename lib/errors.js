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
// Zapier caps how far out a replay can be scheduled; asking for a full day
// would be rejected, and the /extract cap can be that far away.
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
    const delay = Math.min(
      Math.max(Number(err.retryAfter) || DEFAULT_THROTTLE_DELAY, 1),
      MAX_THROTTLE_DELAY,
    );
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
