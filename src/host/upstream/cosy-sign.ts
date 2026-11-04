/**
 * cosy-sign — 自 src/host/upstream.ts 原文搬迁，未改逻辑
 *
 * 拆分依据 docs/issues/22-upstream-split.md；本文件代码逐字来自拆分前的
 * upstream.ts（见 git 历史里拆分前的那一版），只做 import/export 整理与
 * 文件头标注。协议事实的原文注释在 crypto.ts 头部。
 */

import crypto from 'node:crypto'
import { COSY_VERSION, CLIENT_TYPE, MACHINE_TYPE, DATA_POLICY, LOGIN_VERSION, MACHINE_OS } from './client-constants.ts'
import { QODER_RSA_PUBLIC_KEY, aesEncryptCBCBase64 } from './crypto.ts'
import { signaturePath } from './sign.ts'
import type { QoderCredential } from '../domain.ts'

/**
 * Build the full authenticated header set for one gateway request.
 *
 * @param body - the exact bytes that will be sent (already encoded).
 * @param url - the absolute request URL.
 * @param credential - `{ userID, token, name, email, machineID }`.
 * @returns the headers to merge into the request.
 */
export function authHeaders(
  body: Buffer,
  url: string,
  credential: QoderCredential,
): Record<string, string> {
  const aesKey = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const infoB64 = aesEncryptCBCBase64(
    JSON.stringify({
      uid: credential.userID,
      security_oauth_token: credential.token,
      name: credential.name ?? '',
      aid: '',
      email: credential.email ?? '',
    }),
    aesKey,
  )
  const cosyKey = crypto
    .publicEncrypt(
      { key: QODER_RSA_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(aesKey),
    )
    .toString('base64')

  const timestamp = Math.floor(Date.now() / 1000).toString()
  const payloadB64 = Buffer.from(
    JSON.stringify({
      version: 'v1',
      requestId: crypto.randomUUID(),
      info: infoB64,
      cosyVersion: COSY_VERSION,
      ideVersion: '',
    }),
  ).toString('base64')

  const path = signaturePath(url)
  const bodyBytes = body ?? Buffer.alloc(0)
  const sig = crypto
    .createHash('md5')
    .update(payloadB64)
    .update('\n')
    .update(cosyKey)
    .update('\n')
    .update(timestamp)
    .update('\n')
    .update(bodyBytes)
    .update('\n')
    .update(path)
    .digest('hex')

  // Sent as the empty string when absent, which is what `QoderCredential`
  // documents: the machine fingerprint is not a thing to fail a request over.
  // (Before this was spelled out, an absent fingerprint reached `fetch` as
  // `undefined`, and the header came out as the literal text "undefined".)
  const machineID = credential.machineID ?? ''
  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    'Cosy-Key': cosyKey,
    'Cosy-User': credential.userID,
    'Cosy-Date': timestamp,
    'Cosy-Version': COSY_VERSION,
    'Cosy-Machineid': machineID,
    'Cosy-Machinetoken': machineID,
    'Cosy-Machinetype': MACHINE_TYPE,
    'Cosy-Machineos': MACHINE_OS,
    'Cosy-Clienttype': CLIENT_TYPE,
    'Cosy-Clientip': '127.0.0.1',
    'Cosy-Bodyhash': crypto.createHash('md5').update(bodyBytes).digest('hex'),
    'Cosy-Bodylength': String(bodyBytes.length),
    'Cosy-Sigpath': path,
    'Cosy-Data-Policy': DATA_POLICY,
    'Cosy-Organization-Id': '',
    'Cosy-Organization-Tags': '',
    'Login-Version': LOGIN_VERSION,
    'X-Request-Id': crypto.randomUUID(),
  }
}
