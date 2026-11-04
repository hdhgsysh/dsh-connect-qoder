/**
 * The chat stream READER — and specifically its LAST frame.
 *
 * Run: node --test test/chat-stream-reader.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * `readFrames` (src/host/upstream/sse.ts) splits the gateway's SSE body on
 * newlines. The buffer that holds a partial line was only ever drained by
 * finding a '\n' in it, and the loop ended the moment the body ended:
 *
 *   const { done, value } = await reader.read()
 *   if (done) break
 *
 * So a final frame that arrived WITHOUT a trailing newline was never parsed
 * and never yielded — the tail of the answer simply did not exist as far as
 * DSH was concerned. There was no error, no empty response, no drift verdict:
 * the user read a complete-looking reply that was missing its last sentence,
 * and nothing anywhere said so. A gateway whose last write is flushed
 * without a trailing newline (or a proxy that trims it) is enough to cause
 * it — and the shape of the defect is "looks fine", which is the worst kind.
 *
 * The reader also holds a `TextDecoder` in streaming mode, so a multi-byte
 * character split across the last two chunks is only completed by the
 * decoder's final flush — which the old code never called.
 *
 * The cases below pin three things:
 *
 *  1. a last frame without a trailing newline is still delivered;
 *  2. a frame split across two network chunks is reassembled (the buffer's
 *     other job, which the fix must not break);
 *  3. a `[DONE]` terminator that IS newline-terminated still ends the turn
 *     without waiting for the body to close — the end of the body is not the
 *     only way a turn may end, and the fix must not turn the reader into one
 *     that waits for the socket.
 *
 * The stub drives `streamChat` through `globalThis.fetch`, the way
 * `chat-protocol-drift.test.js` does: no gateway, no install, deterministic.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { streamChat } from '../src/host/upstream.ts'

/** @type {import('../src/host/domain.ts').Region} */
const REGION = {
  id: 'qoder',
  mode: 'global',
  displayName: 'Qoder',
  appNames: ['Qoder'],
  baseUrl: 'https://gateway.example/',
  openApiUrl: 'https://openapi.example/',
  centerUrl: 'https://center.example/',
  manageUrl: 'https://manage.example/',
  downloadUrl: 'https://download.example/',
  patEnvNames: [],
}
const CREDENTIAL = { userID: 'u-test', token: 'tok-test', name: 'n', email: 'e@x', machineID: 'm' }
const REQUEST = {
  model: 'model-key',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  maxTokens: undefined,
  enableThinking: false,
  alwaysThinking: false,
  reasoningEffort: undefined,
  sessionId: 's-test',
}

/**
 * One SSE response: the body is the given text, sent in the given chunks.
 * @param {string[]} chunks
 * @param {string} [contentType]
 */
function sseResponse(chunks, contentType = 'text/event-stream') {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': contentType } })
}

/**
 * One SSE response whose body stays open after the given chunks.
 * @param {string[]} chunks
 */
function openSseResponse(chunks) {
  /** @type {ReadableStreamDefaultController<Uint8Array> | undefined} */
  let controller
  const stream = new ReadableStream({
    start(c) {
      controller = c
    },
  })
  const open = controller
  for (const chunk of chunks) {
    if (open) open.enqueue(new TextEncoder().encode(chunk))
  }
  const response = new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  return {
    response,
    close: () => {
      try {
        open?.close()
      } catch {
        // Already closed.
      }
    },
  }
}

/**
 * Pull a chat generator to settlement, keeping the chunks and the thrown error.
 * @param {AsyncIterator<any>} iterator
 */
async function drain(iterator) {
  const chunks = []
  let error
  for (;;) {
    let step
    try {
      step = await iterator.next()
    } catch (thrown) {
      error = thrown
      break
    }
    if (step.done) break
    chunks.push(step.value)
  }
  try {
    await iterator.return?.()
  } catch {
    // Already settled by the error path.
  }
  return { chunks, error }
}

/**
 * Fail instead of hanging when a turn never ends.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} what
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${what}`)), ms)
    }),
  ])
}

/**
 * @param {typeof globalThis.fetch} handler
 */
function stubFetch(handler) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  return () => {
    globalThis.fetch = original
  }
}

/**
 * The text of the answer, in the order the frames carried it.
 * @param {any[]} chunks
 */
function textOf(chunks) {
  return chunks
    .map((chunk) => chunk?.choices?.[0]?.delta?.content ?? '')
    .join('')
}

/**
 * One answer frame, as the gateway sends it.
 * @param {string} text
 */
function frame(text) {
  return `data: ${JSON.stringify({ body: { choices: [{ index: 0, delta: { content: text } }] } })}\n`
}

test('a last frame without a trailing newline is still delivered', async () => {
  // The gateway's final write carries no newline. The reader used to break on
  // the end of the body and drop whatever was still in the buffer, so the last
  // sentence of the answer never reached the user.
  const restore = stubFetch(async () => sseResponse([`${frame('hi')}data: ${JSON.stringify({ body: { choices: [{ index: 0, delta: { content: 'tail' } }] } })}`]))
  const { chunks, error } = await drain(streamChat(REGION, CREDENTIAL, REQUEST))
  restore()
  assert.equal(error, undefined, `the turn must not fail: ${error}`)
  assert.equal(textOf(chunks), 'hitail', 'the tail of the answer must not be truncated')
})

test('a frame split across two network chunks is reassembled', async () => {
  // The buffer's other job, which the end-of-stream handling must not break:
  // a frame that arrives in two pieces is one frame.
  const restore = stubFetch(async () => sseResponse([frame('hi'), 'data: {"body":{"choices":[{"index":0,"delta":{"content":"tail"}}]}}']))
  const { chunks, error } = await drain(streamChat(REGION, CREDENTIAL, REQUEST))
  restore()
  assert.equal(error, undefined, `the turn must not fail: ${error}`)
  assert.equal(textOf(chunks), 'hitail', 'a frame split across chunks is one frame')
})

test('a terminator that is newline-terminated ends the turn without waiting for the body to close', async () => {
  // The end of the body is not the only way a turn may end. The reader must
  // still stop at a `[DONE]` it has read, without waiting for the socket.
  const body = openSseResponse([`${frame('hi')}data: [DONE]\n`])
  const restore = stubFetch(async () => body.response)
  const { chunks, error } = await withTimeout(drain(streamChat(REGION, CREDENTIAL, REQUEST)), 2000, 'the turn must end at [DONE]')
  restore()
  body.close()
  assert.equal(error, undefined, `the turn must not fail: ${error}`)
  assert.equal(textOf(chunks), 'hi', 'the answer must be complete')
})
