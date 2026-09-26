/**
 * Contract tests for the Qoder wire protocol: body encoding, signature path,
 * and the COSY header set.
 *
 * Run: node --test test/upstream-protocol.test.js
 *
 * These functions had no coverage at all, which is uncomfortable for the part
 * of the plugin that has to agree with a remote implementation byte for byte: a
 * change to the rotation order or to the order of the MD5 inputs produces no
 * local error, only a 403 from the gateway.
 *
 * The strategy throughout is an INDEPENDENT reimplementation from the
 * documented transform, not a copy of the source. `referenceEncode` below
 * rebuilds the permutation from the two exported alphabets using string
 * operations, while `encodeBody` uses a precomputed 256-entry lookup table;
 * agreement between the two is real evidence, and a copy would only prove the
 * copy matches itself — the failure mode this file's sibling tests were written
 * to eliminate.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import {
  CUSTOM_ALPHABET,
  STD_ALPHABET,
  authHeaders,
  encodeBody,
  signaturePath,
} from '../lib/upstream.js'

/**
 * An independent implementation of the `Encode=1` transform, written from the
 * documented description: base64, then map each character positionally onto the
 * custom alphabet, then rotate by thirds (last third first, first third last).
 */
function referenceEncode(plaintext) {
  const std = Buffer.isBuffer(plaintext) ? plaintext.toString('base64') : Buffer.from(plaintext).toString('base64')
  let mapped = ''
  for (const ch of std) {
    if (ch === '=') mapped += '$'
    else mapped += CUSTOM_ALPHABET[STD_ALPHABET.indexOf(ch)]
  }
  const n = mapped.length
  const third = Math.floor(n / 3)
  return mapped.slice(n - third) + mapped.slice(third, n - third) + mapped.slice(0, third)
}

const SAMPLES = [
  Buffer.from(''),
  Buffer.from('a'),
  Buffer.from('ab'),
  Buffer.from('abc'),
  Buffer.from('abcd'),
  Buffer.from('{"stream":true}'),
  Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: '你好，世界' }] })),
  Buffer.from('x'.repeat(255)),
  Buffer.from('y'.repeat(256)),
  Buffer.from('z'.repeat(257)),
  Buffer.from([0, 1, 2, 253, 254, 255]),
]

test('encodeBody agrees with an independent implementation of the transform', () => {
  for (const sample of SAMPLES) {
    assert.strictEqual(
      encodeBody(sample).toString('latin1'),
      referenceEncode(sample),
      `encodeBody diverged from the reference on ${JSON.stringify(sample.toString('latin1').slice(0, 24))}`,
    )
  }
})

test('encodeBody is a bijection: it permutes characters, it does not drop them', () => {
  // The output length must equal the base64 length, and the character multiset
  // must be a permutation of the mapped alphabet — a dropped or duplicated
  // character would still decode to a wrong body and would be invisible to a
  // round-trip through this same function.
  for (const sample of SAMPLES) {
    const encoded = encodeBody(sample)
    const expected = referenceEncode(sample)
    assert.strictEqual(encoded.length, expected.length, 'encoded length must match base64 length')
    assert.deepStrictEqual(
      [...encoded.toString('latin1')].sort(),
      [...expected].sort(),
      'encoded characters must be a permutation of the base64 characters',
    )
  }
})

test('encodeBody never emits a raw base64 padding character', () => {
  // `=` is the one character whose mapping is not a positional swap, and it is
  // what makes the output look like base64 at a glance. A regression here would
  // send a body the gateway cannot parse, with no local symptom.
  for (const sample of SAMPLES) {
    assert.ok(!encodeBody(sample).includes(0x3d), 'a raw "=" must never survive the permutation')
  }
})

test('encodeBody output contains no byte outside the custom alphabet', () => {
  const allowed = new Set([...CUSTOM_ALPHABET, '$'])
  for (const sample of SAMPLES) {
    for (const byte of encodeBody(sample)) {
      const ch = String.fromCharCode(byte)
      assert.ok(allowed.has(ch), `unexpected character ${JSON.stringify(ch)} in encoded body`)
    }
  }
})

test('signaturePath strips the /algo prefix the gateway routes away', () => {
  // The gateway removes this prefix before verifying, so a signature computed
  // over the unstripped path is computed over a string the server never sees.
  assert.strictEqual(signaturePath('https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1'), '/api/v2/model/list')
  assert.strictEqual(signaturePath('https://api3.qoder.sh/algo/api/v1/chat'), '/api/v1/chat')
  // A path without the prefix is returned unchanged.
  assert.strictEqual(signaturePath('https://api3.qoder.sh/openapi/v1/user/info'), '/openapi/v1/user/info')
  // The query string is not part of the path, and must not leak into the
  // signature input.
  assert.strictEqual(signaturePath('https://x.test/algo/a/b?c=d'), '/a/b')
  // Only a leading /algo is stripped; an /algo later in the path is not.
  assert.strictEqual(signaturePath('https://x.test/v1/algo/b'), '/v1/algo/b')
})

test('authHeaders returns a complete, self-consistent header set', () => {
  const body = encodeBody(Buffer.from('{"stream":true}'))
  const url = 'https://gateway.qoder.com.cn/algo/api/v1/chat/completions'
  const credential = {
    userID: 'user-123',
    token: 'tok-abc',
    name: 'Tester',
    email: 't@example.test',
    machineID: 'machine-xyz',
  }
  const headers = authHeaders(body, url, credential)

  // The Authorization value must be the documented three-part envelope.
  const match = /^Bearer COSY\.([^.]+)\.([0-9a-f]{32})$/.exec(headers.Authorization)
  assert.ok(match, `Authorization is not a COSY envelope: ${headers.Authorization}`)
  const [, payloadB64, sig] = match

  // The signature must be the MD5 over payload, key, timestamp, body, path —
  // in that order, each newline-separated. This is the one thing in the plugin
  // that has to agree with the server byte for byte, so it is rebuilt here from
  // the returned fields rather than recomputed by calling the function again.
  const expected = crypto
    .createHash('md5')
    .update(payloadB64)
    .update('\n')
    .update(headers['Cosy-Key'])
    .update('\n')
    .update(headers['Cosy-Date'])
    .update('\n')
    .update(body)
    .update('\n')
    .update('/api/v1/chat/completions')
    .digest('hex')
  assert.strictEqual(sig, expected, 'the signature must cover exactly these inputs in this order')

  // The payload must decode to the documented shape.
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'))
  assert.strictEqual(payload.version, 'v1')
  assert.strictEqual(payload.cosyVersion, headers['Cosy-Version'])
  assert.ok(typeof payload.requestId === 'string' && payload.requestId.length > 0)
  // The token must not appear in the clear anywhere in the header set.
  assert.ok(!JSON.stringify(headers).includes(credential.token), 'the token must not appear in cleartext')

  // The identity headers must carry the credential's values.
  assert.strictEqual(headers['Cosy-User'], credential.userID)
  assert.strictEqual(headers['Cosy-Machineid'], credential.machineID)
  assert.strictEqual(headers['Cosy-Bodylength'], String(body.length))
  assert.strictEqual(headers['Cosy-Sigpath'], '/api/v1/chat/completions')
  assert.strictEqual(
    headers['Cosy-Bodyhash'],
    crypto.createHash('md5').update(body).digest('hex'),
  )
  // Cosy-Date is epoch seconds, not milliseconds.
  assert.match(headers['Cosy-Date'], /^\d{10}$/)
})

test('authHeaders produces a different key and signature on every call', () => {
  // The AES key is per-request and the payload carries a fresh requestId, so a
  // repeated call must not replay the same signature. A cached key would make
  // every request after the first look like a replay to the gateway.
  const body = encodeBody(Buffer.from('{"stream":true}'))
  const url = 'https://gateway.qoder.com.cn/algo/api/v1/chat/completions'
  const credential = { userID: 'u', token: 't', name: '', email: '', machineID: 'm' }
  const a = authHeaders(body, url, credential)
  const b = authHeaders(body, url, credential)
  assert.notStrictEqual(a['Cosy-Key'], b['Cosy-Key'], 'the RSA-wrapped AES key must be per-request')
  assert.notStrictEqual(a.Authorization, b.Authorization, 'the Authorization envelope must be per-request')
  assert.notStrictEqual(a['X-Request-Id'], b['X-Request-Id'], 'the request id must be per-request')
})

test('authHeaders binds the signature to the body it was given', () => {
  // If the signature did not cover the body, a tampered or stale body would
  // still verify. The length and hash headers must therefore track the exact
  // bytes that will be sent, and differ when those bytes differ.
  const url = 'https://gateway.qoder.com.cn/algo/api/v1/chat/completions'
  const credential = { userID: 'u', token: 't', name: '', email: '', machineID: 'm' }
  const short = encodeBody(Buffer.from('{"a":1}'))
  const long = encodeBody(Buffer.from('{"a":1,"padding":"a much longer body"}'))
  const a = authHeaders(short, url, credential)
  const b = authHeaders(long, url, credential)
  assert.strictEqual(a['Cosy-Bodylength'], String(short.length))
  assert.strictEqual(b['Cosy-Bodylength'], String(long.length))
  assert.notStrictEqual(a['Cosy-Bodyhash'], b['Cosy-Bodyhash'])
  // And the hash must be the MD5 of those exact bytes.
  assert.strictEqual(a['Cosy-Bodyhash'], crypto.createHash('md5').update(short).digest('hex'))
})

test('authHeaders omits a body when none is supplied', () => {
  // `body` is optional in the signature. Signing a null body as empty bytes
  // must not throw, and the length header must say zero.
  const headers = authHeaders(undefined, 'https://x.test/algo/a', {
    userID: 'u',
    token: 't',
    machineID: 'm',
  })
  assert.strictEqual(headers['Cosy-Bodylength'], '0')
  assert.match(headers.Authorization, /^Bearer COSY\.[^.]+\.[0-9a-f]{32}$/)
})
