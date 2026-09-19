/**
 * Read a Qoder error frame and decide what it actually is.
 *
 * Two codes arrive here with very different meanings, and conflating them sent
 * the user looking at their account for what is really a queue:
 *
 * - **105 / TOKEN_EXPIRE** — the sign-in is gone. Nothing will succeed until
 *   the user signs in to the Qoder app again.
 * - **10605** — the request was queued or rate-limited. The body carries
 *   `retryAfterSeconds` and `serviceAvailable`, so it is transient and must be
 *   treated as retryable rather than as a rejection.
 */
function classifyUpstreamError(chunk, code, detail) {
  // 10605 arrives as a JSON *string* in `message`, with a queue payload.
  const text = String(detail ?? '')
  if (code === '10605' || /"queueType"|"retryAfterSeconds"|"isQueued"/.test(text)) {
    let seconds = 0
    try {
      const parsed = JSON.parse(text.startsWith('{') ? text : JSON.parse(`"${text}"`))
      if (typeof parsed === 'string') {
        const inner = JSON.parse(parsed)
        seconds = Number(inner?.retryAfterSeconds) || 0
      } else {
        seconds = Number(parsed?.retryAfterSeconds) || 0
      }
    } catch {
      // A queue error whose body will not parse is still a queue error.
    }
    return { kind: 'rate-limit', retryAfterSeconds: seconds }
  }
  if (/Login expired|TOKEN_EXPIRE|token is not active/i.test(text) || code === '105') {
    return { kind: 'sign-in-expired' }
  }
  return { kind: 'upstream' }
}

export { classifyUpstreamError }
