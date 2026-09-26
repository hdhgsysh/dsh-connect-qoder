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
 *
 * Exact code matches decide first, so a sign-in failure is never shadowed by a
 * stray field name; the marker regex only fires as a fallback, and only when
 * at least two queue markers co-occur, so an auth error that happens to carry
 * a `retryAfterSeconds` field is not misread as a queue.
 */

/** The queue descriptor's field names; any two co-occurring mark a queue. */
const QUEUE_MARKERS = ['"queueType"', '"retryAfterSeconds"', '"isQueued"', '"serviceAvailable"']

/** How many of the queue markers appear in a payload text. */
function queueMarkerCount(text) {
  let count = 0
  for (const marker of QUEUE_MARKERS) {
    if (text.includes(marker)) count += 1
  }
  return count
}

/** Extract `retryAfterSeconds` from a queue payload, best-effort. */
function queueSeconds(text) {
  try {
    // 10605 arrives as a JSON *string* inside `message`; the text here may
    // already be that decoded string.
    const parsed = JSON.parse(text.startsWith('{') ? text : JSON.parse(`"${text}"`))
    const inner = typeof parsed === 'string' ? JSON.parse(parsed) : parsed
    return Number(inner?.retryAfterSeconds) || 0
  } catch {
    // A queue error whose body will not parse is still a queue error.
    return 0
  }
}

function classifyUpstreamError(chunk, code, detail) {
  // `code` may arrive as a JSON number from a gateway that stopped quoting it
  // (the unwrap layer normalises, but this stays defensive), so normalise
  // before comparing instead of strict-string-matching.
  const text = String(detail ?? '')
  const normalized = String(code ?? '')
  if (normalized === '10605') {
    return { kind: 'rate-limit', retryAfterSeconds: queueSeconds(text) }
  }
  if (/Login expired|TOKEN_EXPIRE|token is not active/i.test(text) || normalized === '105') {
    return { kind: 'sign-in-expired' }
  }
  if (queueMarkerCount(text) >= 2) {
    return { kind: 'rate-limit', retryAfterSeconds: queueSeconds(text) }
  }
  return { kind: 'upstream' }
}

export { classifyUpstreamError }
