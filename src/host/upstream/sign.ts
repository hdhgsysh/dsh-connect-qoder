/**
 * sign — 自 src/host/upstream.ts 原文搬迁，未改逻辑
 *
 * 拆分依据 docs/issues/22-upstream-split.md；本文件代码逐字来自拆分前的
 * upstream.ts（见 git 历史里拆分前的那一版），只做 import/export 整理与
 * 文件头标注。协议事实的原文注释在 crypto.ts 头部。
 */

/**
 * The path the signature covers: the request path with a leading `/algo`
 * stripped, because the gateway routes that prefix away before verifying.
 */
export function signaturePath(url: string): string {
  let path = new URL(url).pathname
  if (path.startsWith('/algo')) path = path.slice('/algo'.length)
  return path
}
