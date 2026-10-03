// A session shorter than this never really started, however it was reported.
const SHORT_SESSION_MS = 15_000;
const MAX_FAILURES = 5;
const MAX_BACKOFF_MS = 15_000;

/**
 * What an always-on voice does when a session ends. There is no stop button,
 * so every ending is decided here:
 *   reconnect  open another session after delayMs
 *   rest       nobody spoke for a whole session; wait until someone is back
 *   wait       a person has to fix or retry something; keep the message up
 *   none       the page itself closed the session
 * `failures` is the count to pass back in next time.
 */
export function afterVoiceClose({ reason = 'user', retry = true, heardUser = false, livedMs = 0, failures = 0 } = {}) {
  if (reason === 'user') return { action: 'none', failures: 0 };
  const established = livedMs >= SHORT_SESSION_MS;
  if (reason === 'error' || !established) {
    if (!retry) return { action: 'wait', failures: 0 };
    const count = (established ? 0 : failures) + 1;
    // Back off rather than hammer a provider that keeps refusing.
    if (count > MAX_FAILURES) return { action: 'wait', failures: 0 };
    return { action: 'reconnect', delayMs: Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (count - 1)), failures: count };
  }
  // The provider ended a healthy session, usually at its time limit. A silent
  // one means nobody is there, and an unattended tab should stop paying for one.
  return heardUser ? { action: 'reconnect', delayMs: 600, failures: 0 } : { action: 'rest', failures: 0 };
}
