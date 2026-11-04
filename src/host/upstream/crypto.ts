/**
 * The Qoder wire protocol.
 *
 * Qoder is not an OpenAI-compatible endpoint, so three separate mechanisms have
 * to be reproduced to talk to it:
 *
 * 1. **COSY signed headers.** Every gateway request carries a set of `Cosy-*`
 *    headers plus an `Authorization: Bearer COSY.<payload>.<sig>` value. The
 *    signature is an MD5 over the base64 payload, the RSA-wrapped AES key, the
 *    timestamp, the request body, and the signature path.
 * 2. **A permuted base64 body.** The `Encode=1` query flag means the JSON body
 *    is base64-encoded, its alphabet is permuted, and the resulting string's
 *    characters are rotated by thirds.
 * 3. **Doubly-wrapped SSE.** Each `data:` frame is an envelope object whose
 *    `body` field is *itself* a JSON string holding an OpenAI-style chunk.
 *
 * The constants below are protocol facts recovered from the client; they are
 * not configuration.
 *
 * @module dsh-connect-qoder/upstream
 */
/**
 * 2026-10-17 拆分：上面这段协议事实注释自 upstream.ts 文件头原文整体搬迁，
 * 未改一字。它描述的三个机制现在分布在这些文件里：
 *
 * - COSY 签名头组装与 Authorization 值 → `upstream/cosy-sign.ts`
 * - 置换字母表 base64（`Encode=1`）→ 本文件
 * - 双层包裹 SSE 解码 → `upstream/sse.ts`
 */

import crypto from 'node:crypto'

/** Public key the gateway expects the per-request AES key to be wrapped with. */
export const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

/** Permuted base64 alphabet used when `Encode=1` is in effect. */
export const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
/** Standard base64 alphabet, positionally mapped onto the custom one. */
export const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// The alphabets are exported so a test can rebuild the permutation itself and
// check `encodeBody` against an independent implementation of the documented
// transform. A test that copied the lookup table would only prove the copy
// agrees with itself.

/**
 * Positional translation table from standard to custom alphabet.
 *
 * A `Uint8Array` of exactly 256 entries, so every read below is in bounds by
 * construction — but the TYPE cannot know that (`noUncheckedIndexedAccess` is
 * on, which is why the reads go through `encodeByteAt` below rather than
 * straight at the table). The table maps a character code to its replacement
 * code, which is what makes a byte-for-byte translation of the base64 string
 * possible without building a new string character by character.
 */
const ENCODE_TABLE = (() => {
  const table = new Uint8Array(256)
  for (let i = 0; i < table.length; i++) table[i] = i
  for (let i = 0; i < STD_ALPHABET.length; i++) {
    table[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i)
  }
  table['='.charCodeAt(0)] = '$'.charCodeAt(0)
  return table
})()

/**
 * The translation for one already-validated byte.
 *
 * The `?? byte` is unreachable given a 256-entry table and a byte in 0..255,
 * and it is spelled as a fallback rather than a `!` so that the TOTAL
 * behaviour is defined: an identity translation is the correct answer for a
 * byte the table does not name, whereas a non-null assertion would be a
 * promise this function cannot keep if the table ever shrank.
 */
function encodeByteAt(byte: number): number {
  return ENCODE_TABLE[byte] ?? byte
}

/**
 * Encode a request body the way the `Encode=1` flag requires.
 *
 * The transform is: base64 the bytes, translate each character through the
 * permuted alphabet, then rotate the string so the last third comes first and
 * the first third goes last.
 *
 * @param plaintext - the JSON body bytes.
 * @returns the encoded bytes to send as the request body.
 */
export function encodeBody(plaintext: Buffer | string): Buffer {
  const bytes = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext)
  const std = bytes.toString('base64')
  const n = std.length
  const third = Math.floor(n / 3)
  const out = Buffer.allocUnsafe(n)
  let dst = 0
  for (let i = n - third; i < n; i++) out[dst++] = encodeByteAt(std.charCodeAt(i))
  for (let i = third; i < n - third; i++) out[dst++] = encodeByteAt(std.charCodeAt(i))
  for (let i = 0; i < third; i++) out[dst++] = encodeByteAt(std.charCodeAt(i))
  return out
}

/** AES-128-CBC encrypt with the key doubling as the IV, base64-encoded. */
export function aesEncryptCBCBase64(plaintext: string, keyString: string): string {
  const key = Buffer.from(keyString)
  const cipher = crypto.createCipheriv('aes-128-cbc', key, key)
  return cipher.update(plaintext, 'utf8', 'base64') + cipher.final('base64')
}
