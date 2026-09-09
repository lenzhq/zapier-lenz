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
 * they top up, or when their monthly credits reset.
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
 * Append the API's request id to a mapped message when there is one.
 *
 * This app reaches the API through the SDK rather than `z.request`, so
 * Zapier's per-request log tab is EMPTY for this integration — the id is the
 * only handle support has for tracing one specific failed run. Every SDK
 * error subclass carries `requestId` (the `X-Request-ID` response header),
 * defaulting to `''` when the failure happened before a response arrived, so
 * a network error simply doesn't get one.
 */
const withRequestId = (err, message) =>
  err && err.requestId ? `${message} (Lenz request ${err.requestId})` : message;

/** Whole seconds, floored at the default and capped, from a stated wait. */
const replayDelay = (...candidates) => {
  const stated = candidates.map(Number).find((n) => Number.isFinite(n) && n > 0);
  return Math.min(Math.ceil(stated || DEFAULT_THROTTLE_DELAY), MAX_THROTTLE_DELAY);
};

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
    // One clause, not two: "wait for the monthly reset" followed by "Credits
    // reset <timestamp>" states the same advice twice in a row.
    const resets = err.resetsAt
      ? ` or wait for the reset at ${err.resetsAt}.`
      : ' or wait for the monthly reset.';
    // Every Lenz call spends from one credit pool, at a per-endpoint weight.
    // Quoting the cost next to the balance separates "you have 4 credits and
    // this call needs 10" — one top-up away — from "you have nothing", which
    // is a plan decision.
    //
    // `creditBalance`, NOT `creditsRemaining`: the latter is a deprecated
    // alias of `remaining`, which is in the CAPABILITY's unit (verifications),
    // not credits — reading it here would print a verification count labelled
    // as credits, and emit a deprecation warning on the first such run.
    //
    // A field the server did not report reads as `null` on a current SDK and
    // as `undefined` on one too old to know about it, hence `typeof`. NOT
    // `Number.isFinite(Number(x))`: `Number(null)` is 0, which is finite, so
    // that form would invent "costs 0 credits and you have 0 left" for a
    // balance nobody reported — a plausible-looking number that is false.
    //
    // The two are reported INDEPENDENTLY: `cost` comes from the weight table
    // unconditionally, while the server resolves `credits_remaining` only when
    // the caller supplied neither `remaining` nor `resets_at`. A real 402 can
    // therefore carry the cost alone, so each half degrades on its own — an
    // all-or-nothing guard would throw away the half we actually have.
    const known = (value) => typeof value === 'number';
    const credits = (n) => `${n} credit${n === 1 ? '' : 's'}`;
    const cost = err.cost;
    const balanceLeft = err.creditBalance;
    // A refused call that costs NOTHING is not a shortfall: /extract is weight
    // 0, and a 402 on it means the plan does not cover the call. Sizing that in
    // credits sends the user to a top-up that cannot fix it, so it says nothing.
    let balance = '';
    if (known(cost) && cost > 0) {
      balance = known(balanceLeft)
        ? ` This call costs ${credits(cost)} and you have ${balanceLeft} left.`
        : ` This call costs ${credits(cost)}.`;
    } else if (!known(cost) && known(balanceLeft)) {
      balance = ` You have ${credits(balanceLeft)} left.`;
    }
    throw new z.errors.HaltedError(
      withRequestId(
        err,
        `${err.message}${balance} Retrying won't help — ` +
          `top up or upgrade at ${upgradeUrl},${resets}`,
      ),
    );
  }

  // Rate limit (today, the per-account daily /extract fair-use cap, which
  // costs no credits at all). This one does clear, so hand Zapier the wait and
  // let it replay rather than burning a run.
  if (err instanceof LenzRateLimitError) {
    // `|| DEFAULT` catches 0/NaN/undefined/unparseable. A NEGATIVE retryAfter
    // is truthy, though, so it survives that and would otherwise clamp to a
    // 1-second replay — a hot retry loop against a server that just throttled
    // us. Floor at the default instead: a malformed wait is no wait at all.
    // Integer: the platform takes whole seconds, and 1.5 is not a wait anyone
    // meant to express.
    const delay = replayDelay(err.retryAfter);
    throw new z.errors.ThrottledError(
      withRequestId(err, `${err.message} Retrying in ${delay}s.`),
      delay,
    );
  }

  // Bad or revoked key. ExpiredAuthError is what prompts the user to
  // reconnect the account, rather than leaving them to decode a 401.
  if (err instanceof LenzAuthError && err.statusCode === 401) {
    throw new z.errors.ExpiredAuthError(
      withRequestId(
        err,
        'Your Lenz API key was rejected. Reconnect this account with a current key from ' +
          'lenz.io → API credentials.',
      ),
    );
  }

  // A 403 that is NOT a credit problem: a private verification, an IP block.
  // A real failure, but the message is worth keeping intact.
  if (err instanceof LenzError && err.statusCode === 403) {
    throw new z.errors.Error(withRequestId(err, err.message), 'Forbidden', 403);
  }

  // At capacity (admission control) or every model provider down: a typed,
  // transient 503. Throttle-and-replay for the same reason 402 halts — a
  // condition that resolves itself must not count against the user's error
  // rate and get the Zap auto-disabled. Reads err.code/err.body, which the
  // current SDK already populates on 5xx (no SDK bump needed); the stated
  // wait lives in the body's `retry_after` (the header the SDK's own retry
  // loop honours is exhausted by the time the error reaches us).
  if (
    err instanceof LenzError &&
    Number(err.statusCode) >= 500 &&
    (err.code === 'capacity' || err.code === 'upstream_unavailable')
  ) {
    const delay = replayDelay(err.body && err.body.retry_after, err.retryAfter);
    const what =
      err.code === 'capacity'
        ? 'Lenz is at capacity right now'
        : "Lenz's model providers are temporarily unavailable";
    throw new z.errors.ThrottledError(
      withRequestId(err, `${what} — nothing was charged. Retrying in ${delay}s.`),
      delay,
    );
  }

  // No response at all: DNS failure, connection reset, TLS problem, or the
  // SDK's own AbortController firing on `timeoutMs`. The SDK reports every one
  // of these with `statusCode: 0`.
  //
  // These fell through as hard errors before, which was wrong twice over: the
  // condition is transient, and it is precisely the class the SDK used to hide
  // by retrying in-process. Now that client.js runs a single attempt
  // (`maxRetries: 0`) they arrive here instead — so mapping them to a bounded
  // replay is what makes capping the retry budget safe rather than a trade of
  // silent recovery for auto-disable.
  // `!(err instanceof LenzAuthError)` is insurance, not dead code. The SDK
  // defaults `statusCode` to 0 when a response never set one, and it raises
  // LenzAuthError for BOTH 401 and 403 — so an auth error that somehow
  // reached here without a status would be reported to the user as "could not
  // reach Lenz" when their key was in fact rejected. Falling through to the
  // raw error is the honest answer for that shape.
  // NOTE the message deliberately does NOT say "nothing was charged", which
  // the typed-503 branch above can say truthfully because admission control
  // sheds before doing any work. Here we genuinely do not know: `statusCode 0`
  // covers both a request that never left (DNS, connection refused — safe) and
  // our own AbortController firing at `timeoutMs` on a request the server may
  // already be executing. Claiming no charge for the second case would be a
  // confident lie in the one message the user reads about it.
  //
  // Since a ThrottledError makes Zapier REPLAY the action, a timeout that did
  // reach Lenz can run the work twice. /verify carries a per-task callback URL
  // that separates runs, but /assess has no implicit idempotency key and debits
  // before the panel runs. An explicit Idempotency-Key is the real fix and is
  // tracked in #19; capping the SDK's own retries (client.js) closes the other
  // half of the same problem.
  if (err instanceof LenzError && !(err instanceof LenzAuthError) && Number(err.statusCode) === 0) {
    const delay = replayDelay();
    throw new z.errors.ThrottledError(
      withRequestId(
        err,
        `Could not reach Lenz, or the request timed out. Retrying in ${delay}s.`,
      ),
      delay,
    );
  }

  // An untyped 5xx: a load-balancer or CDN 502/504, or a bare 500 with no Lenz
  // `code` in the body. Transient infrastructure, not a verdict on the request.
  //
  // The test is the ABSENCE of a code, not the status number, and that is the
  // whole point: the typed 502s (`framing_failed`, `extraction_failed`) are
  // deterministic answers about THIS input, so they must stay hard errors —
  // replaying them spends the run again for the same result. Typed transient
  // 503s (`capacity`, `upstream_unavailable`) are handled above with the wait
  // the server actually stated.
  //
  // Same honesty rule as the branch above: no "nothing was charged" claim. A
  // gateway 502 can be returned after the request reached the app and spent
  // credits, and we cannot tell from here.
  if (err instanceof LenzError && Number(err.statusCode) >= 500 && !err.code) {
    const delay = replayDelay(err.retryAfter);
    throw new z.errors.ThrottledError(
      withRequestId(err, `Lenz returned a temporary ${err.statusCode}. Retrying in ${delay}s.`),
      delay,
    );
  }

  throw err;
};

module.exports = { mapLenzError, withRequestId, DEFAULT_THROTTLE_DELAY, MAX_THROTTLE_DELAY };
