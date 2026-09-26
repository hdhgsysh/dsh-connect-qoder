/**
 * Round-trip tests for the OSCrypt blob decoder.
 *
 * Run: node --test test/oscrypt.test.js
 *
 * `decryptOscrypt` is the one function in this module that decides whether the
 * plugin can read a credential at all, and it had no coverage. It is a pure
 * function, so the fixtures here are built with the real AES-256-GCM rather
 * than checked in as opaque blobs: a test that only fed it one captured sample
 * would pass even if the nonce, tag or prefix offset were wrong, as long as the
 * one sample happened to line up.
 *
 * Every fixture is produced by the same construction the Chromium/VS Code store
 * uses — `"v10" || nonce(12) || ciphertext || tag(16)`.
 *
 * One thing is NOT asserted here, deliberately: that the explicit
 * `blob.length < 3 + 12 + 16` guard runs, rather than a short blob being
 * rejected further down by `createDecipheriv` throwing on a truncated nonce.
 * Both paths return `undefined`, so the two are indistinguishable from outside,
 * and a test claiming to tell them apart would be asserting an implementation
 * detail it cannot actually see. Deleting the guard was measured to leave this
 * file green.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { decryptOscrypt } from '../lib/credentials.js'

const KEY = crypto.randomBytes(32)

/** Build an OSCrypt blob the way the app's store writes one. */
function seal(plaintext, key = KEY, prefix = 'v10') {
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from(prefix, 'latin1'), nonce, ciphertext, cipher.getAuthTag()])
}

test('a blob written by the store decodes back to its plaintext', () => {
  const plaintext = JSON.stringify({
    schemaVersion: 1,
    token: 'dt-secret',
    user: { id: 'u-1', name: 'Tester', email: 't@example.test' },
  })
  assert.strictEqual(decryptOscrypt(seal(plaintext), KEY), plaintext)
})

test('the empty string round-trips', () => {
  // AES-GCM produces a tag even for zero-length plaintext, so this is a real
  // edge: the length guard must not reject a 3+12+16 byte blob outright.
  assert.strictEqual(decryptOscrypt(seal(''), KEY), '')
})

test('non-ASCII plaintext survives as UTF-8', () => {
  const plaintext = '{"name":"张三","note":"emoji 🎉 and ünïcode"}'
  assert.strictEqual(decryptOscrypt(seal(plaintext), KEY), plaintext)
})

test('a wrong key does not decode', () => {
  // GCM must authenticate: a wrong key has to fail rather than return garbage
  // that would then be JSON.parsed into a nonsense credential.
  const blob = seal('{"token":"real"}')
  const result = decryptOscrypt(blob, crypto.randomBytes(32))
  assert.strictEqual(result, undefined, 'a wrong key must not produce plaintext')
})

test('a tampered ciphertext does not decode', () => {
  const blob = seal('{"token":"real"}')
  blob[blob.length - 20] ^= 0xff
  assert.strictEqual(decryptOscrypt(blob, KEY), undefined, 'GCM must reject a modified body')
})

test('a tampered authentication tag does not decode', () => {
  const blob = seal('{"token":"real"}')
  blob[blob.length - 1] ^= 0x01
  assert.strictEqual(decryptOscrypt(blob, KEY), undefined)
})

test('a wrong prefix is rejected before any decryption is attempted', () => {
  // The store has used more than one prefix over the years. Anything that is
  // not `v10` is not ours to interpret, and guessing would mean handing an
  // unverified string to JSON.parse.
  for (const prefix of ['v11', 'v20', 'xxx', 'V10']) {
    assert.strictEqual(decryptOscrypt(seal('{"a":1}', KEY, prefix), KEY), undefined, `prefix ${prefix}`)
  }
})

test('a truncated blob is rejected rather than throwing', () => {
  const blob = seal('{"token":"real"}')
  // Shorter than v10 + nonce + tag: there is no ciphertext at all.
  assert.strictEqual(decryptOscrypt(blob.subarray(0, 30), KEY), undefined)
  assert.strictEqual(decryptOscrypt(Buffer.alloc(0), KEY), undefined)
  assert.strictEqual(decryptOscrypt(Buffer.from('v10'), KEY), undefined)
  // Exactly the header, with no body.
  assert.strictEqual(decryptOscrypt(Buffer.concat([Buffer.from('v10'), crypto.randomBytes(12)]), KEY), undefined)
  // Every length from 0 to 30, so no short input can throw.
  for (let length = 0; length < 31; length++) {
    assert.doesNotThrow(() => decryptOscrypt(crypto.randomBytes(length), KEY), `length ${length}`)
  }
  // A blob of exactly the minimum size is a header with an empty ciphertext.
  const minimum = Buffer.concat([Buffer.from('v10'), crypto.randomBytes(12), crypto.randomBytes(16)])
  assert.strictEqual(minimum.length, 31)
  assert.strictEqual(decryptOscrypt(minimum, KEY), undefined)
})

test('a key of the wrong length is rejected without throwing', () => {
  // createDecipheriv throws on a bad key size; that must not escape the decoder,
  // because every caller treats this function as total — it answers undefined
  // rather than failing, so a corrupt key cannot crash region startup.
  const blob = seal('{"a":1}')
  for (const bad of [crypto.randomBytes(16), crypto.randomBytes(24), crypto.randomBytes(64)]) {
    assert.doesNotThrow(() => decryptOscrypt(blob, bad))
    assert.strictEqual(decryptOscrypt(blob, bad), undefined)
  }
})

test('random noise is almost never mistaken for a valid blob', () => {
  // Guards against the decoder accepting arbitrary bytes. One case in ~2^24 per
  // attempt can legitimately pass, so this asserts "nearly always", not "never".
  let decoded = 0
  for (let i = 0; i < 200; i++) {
    const noise = crypto.randomBytes(40)
    if (decryptOscrypt(noise, KEY) !== undefined) decoded++
  }
  assert.ok(decoded <= 2, `random input decoded ${decoded} times out of 200; the decoder is too permissive`)
})
