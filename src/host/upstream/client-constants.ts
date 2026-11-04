/**
 * client-constants — 自 src/host/upstream.ts 原文搬迁，未改逻辑
 *
 * 拆分依据 docs/issues/22-upstream-split.md；本文件代码逐字来自拆分前的
 * upstream.ts（见 git 历史里拆分前的那一版），只做 import/export 整理与
 * 文件头标注。协议事实的原文注释在 crypto.ts 头部。
 */

/** COSY protocol revision the gateway is currently serving. */
export const COSY_VERSION = '1.1.38'
/** Client type magic the gateway expects from a CLI client. */
export const CLIENT_TYPE = '5'
/** Machine type magic the gateway expects. */
export const MACHINE_TYPE = '5'
/** Data-policy value a non-consenting client sends. */
export const DATA_POLICY = 'disagree'

/** Login protocol revision. */
export const LOGIN_VERSION = 'v2'

/**
 * Machine OS string, spelled the way the gateway expects.
 *
 * The darwin arm was the one PLAN P1-4 (protocol drift) wanted: the whole
 * suite had zero references to this constant, so a macOS host silently
 * announced itself as `x86_64_linux` and nobody could tell whether the gateway
 * cared. Measured, not assumed: `probe/machineos-probe.mjs` sends this exact
 * request with only `Cosy-Machineos` varied, and the gateway answers 200 with a
 * byte-identical `chat` group for `x86_64_linux`, `aarch64_linux`,
 * `x86_64_darwin` and `aarch64_darwin` on both regions — so naming the real
 * platform is safe, and a macOS user no longer lies to the gateway about it.
 *
 * Note the cost of that answer: the gateway does not gate on this field, so it
 * cannot be used to detect a wrong-platform bug. It stays a correctness
 * statement about what this host is, not a lever.
 */
export const MACHINE_OS =
  process.platform === 'win32'
    ? process.arch === 'arm64'
      ? 'aarch64_windows'
      : 'x86_64_windows'
    : process.platform === 'darwin'
      ? process.arch === 'arm64'
        ? 'aarch64_darwin'
        : 'x86_64_darwin'
      : process.arch === 'arm64'
        ? 'aarch64_linux'
        : 'x86_64_linux'
