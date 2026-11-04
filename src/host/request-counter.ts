/**
 * The local daily count of conversation turns this client sends upstream.
 *
 * Upstream never publishes "sent today / limit", so the count is local only:
 * this client's calls through this plugin, desktop and web counted apart. One
 * JSON file per region and local date (Asia/Shanghai) under `$DSH_HOME`,
 * written atomically; the date key is recomputed on every read/write, so a day
 * rollover starts a new file instead of accumulating. Never throws: a failed
 * read or write degrades to `count === null`; the path is injected and the name
 * components whitelist-checked, so it stays inside `$DSH_HOME` (docs/issues/01-sweep-junction-zeroing.md).
 * @module dsh-connect-qoder/request-counter
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 落盘 JSON 的版本号；与 `throttle-store.ts` 同款约定，读错版本即丢弃。 */
const COUNTER_FORMAT_VERSION = 1

// 没有 `DAY_MS`：本模块的「往前 N 天」一律用 Date 日历减法（见 `gc` 的
// setDate）。固定 24h 步进在 DST 时区会把「昨天」算到另一条日历日上——这正是
// 早期 gc 的 bug，别把它当工具常量加回来。

/**
 * 把 region / 日期各段收敛成安全文件名分量。
 *
 * 只允许 ASCII 字母数字、连字符、下划线——region 是受控枚举（`qoder-cn` /
 * `qoder`），日期是 `YYYY-MM-DD`，理论上都不需要过滤；但凡是拼进文件路径的东西
 * 都必须过一道白名单，否则一旦上游/配置里冒出 `../` 或 `:` 就变成越界写盘。
 * 含任何非法字符即返回 `null`（调用方据此放弃本次计数，不拼路径）。
 *
 * @param value - 待校验的分量。
 * @returns 安全分量，或 `null`。
 */
export function sanitizeComponent(value: string): string | null {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : null
}

/**
 * 把 epoch 毫秒拆成 Asia/Shanghai 的本地日历日 `YYYY-MM-DD`。
 *
 * 用 `Intl.DateTimeFormat` 的 `timeZone` 选项拿本地年月日，避免自己算时区偏移
 * （夏时制、历史偏移都会错）。返回 null 表示环境不支持该时区——这时放弃本地口径
 * 计数，不强行用 UTC 冒充（那会让「零点翻页」和上游的日界对不上）。
 *
 * @param ms - epoch 毫秒。
 * @param timeZone - 目标时区，默认上海。
 * @returns `YYYY-MM-DD`，或 `null`。
 */
export function localDayKey(ms: number, timeZone = 'Asia/Shanghai'): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(ms))
    const year = parts.find((p) => p.type === 'year')?.value
    const month = parts.find((p) => p.type === 'month')?.value
    const day = parts.find((p) => p.type === 'day')?.value
    if (
      typeof year !== 'string' ||
      typeof month !== 'string' ||
      typeof day !== 'string' ||
      !/^\d{4}$/.test(year) ||
      !/^\d{2}$/.test(month) ||
      !/^\d{2}$/.test(day)
    ) {
      return null
    }
    return `${year}-${month}-${day}`
  } catch {
    return null
  }
}

/** 计数器对外暴露的读数：今日计数，或 `null`（本地口径不可用）。 */
export interface RequestCountSnapshot {
  /** 今日经本客户端发出的对话轮数；不可用为 `null`。 */
  count: number | null
  /** 该读数的本地日历日（与计数文件同名），用于客户端标注「今日」语义。 */
  day: string | null
}

/** 构造选项：路径前缀 + 注入时钟 + 日志。 */
export interface RequestCounterOptions {
  /** 生成文件名前缀的函数（注入 `qoderCatalogPath`，永远落在 `$DSH_HOME` 内）。 */
  basePath: (filename: string) => string
  /** 墙钟，注入便于测试；默认 `Date.now`。 */
  now?: () => number
  /** 可选日志。 */
  logger?: { warn?: (message: string, error?: unknown) => void }
  /** 保留几天旧文件，默认 7；GC 时删除更早的按本插件命名且日期早于该窗口的文件。 */
  keepDays?: number
}

/**
 * 本客户端每日请求计数器。
 *
 * 一个 region 一个实例；文件按 `region + 本地日` 分文件，零点翻页自动切文件。
 * 所有磁盘操作吞错降级，绝不把计数失败传导到对话链路。
 */
export class RequestCounter {
  private basePath: (filename: string) => string
  private now: () => number
  private logger: { warn?: (message: string, error?: unknown) => void } | undefined
  private keepDays: number
  /** gc 的「每本地日至多一次真扫」节流标记（与 TokenCounter.lastGcDay 同款）。 */
  private lastGcDay: string | null = null

  constructor({ basePath, now = () => Date.now(), logger, keepDays = 7 }: RequestCounterOptions) {
    this.basePath = basePath
    this.now = now
    this.logger = logger
    this.keepDays = keepDays
  }

  /**
   * 当前 region + 本地日的计数文件路径；任一分量非法返回 `null`（越界防护）。
   *
   * @param region - region id（受控枚举，仍过白名单）。
   */
  private pathFor(region: string): string | null {
    const safeRegion = sanitizeComponent(region)
    if (safeRegion === null) return null
    const day = localDayKey(this.now())
    if (day === null) return null
    // 两个分量都已白名单过，join 后不可能逃出 basePath 目录。
    return this.basePath(`.qoder-request-count.${safeRegion}.${day}.json`)
  }

  /**
   * 读今日计数（不出错）。
   *
   * @param region - region id。
   * @returns 读数；文件不存在 / 损坏 / 越界 / 时区不可用 → `count: null`。
   */
  read(region: string): RequestCountSnapshot {
    const path = this.pathFor(region)
    if (path === null) return { count: null, day: null }
    const day = localDayKey(this.now())
    if (!existsSync(path)) return { count: null, day }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      const record = parsed as { version?: unknown; count?: unknown }
      if (record?.version !== COUNTER_FORMAT_VERSION) return { count: null, day }
      const count = Number(record.count)
      if (!Number.isFinite(count) || count < 0) return { count: null, day }
      return { count: Math.floor(count), day }
    } catch {
      return { count: null, day }
    }
  }

  /**
   * 今日 +1，返回 +1 后的读数（不出错）。
   *
   * 与 `read` 不同：bump 是用户真正关心的「发了一发」的落盘，所以即使读失败也
   * 尝试以 `count: 1` 起写（而非静默丢数）。写失败则降级 `count: null`——这发
   * 请求已经发生，只是本插件没记下，客户端会显示「本地口径不可用」而不是假 0。
   *
   * @param region - region id。
   */
  bump(region: string): RequestCountSnapshot {
    return this.write(region, (prev) => Math.floor(prev) + 1)
  }

  /**
   * 标记今日「本地判定额度疑似用尽」。
   *
   * 由 shim 在收到上游 `daily_limit_exceeded` 时调用。这**不是**上游给的官方状态
   * —— 上游只报「用完了」，从不给剩余/上限；本插件据此在本地记一个标记，供卡片
   * 诚实标注「今日额度疑似已用尽（本地统计，仅供参考）」。零点翻页到新文件后该标记
   * 自然消失（每个本地日一个文件）。写失败只降级、不阻塞对话（红线 1）。
   *
   * @param region - region id。
   */
  markExhausted(region: string): void {
    this.write(region, (prev) => prev, true)
  }

  /**
   * 读今日是否已被本地标记为「额度疑似用尽」。
   *
   * @param region - region id。
   * @returns 标记状态；文件不可用 / 越界 → `false`（宁可漏标也不误报）。
   */
  readExhausted(region: string): boolean {
    const path = this.pathFor(region)
    if (path === null) return false
    if (!existsSync(path)) return false
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      const record = parsed as { version?: unknown; dailyLimitHit?: unknown }
      if (record?.version !== COUNTER_FORMAT_VERSION) return false
      return record.dailyLimitHit === true
    } catch {
      return false
    }
  }

  /**
   * 计数 + 标记的底层落盘：读旧值 → 套用 `nextCount` 得到新计数 → 合并
   * `dailyLimitHit` → 原子写。读失败以 `1`/`false` 起写（不丢数、不裸抛）。
   *
   * @param region - region id。
   * @param nextCount - 由旧计数算新计数的函数（旧值已 clamp 为非负整数）。
   * @param dailyLimitHit - 是否把今日标记为已撞每日限流（默认沿用旧值）。
   */
  private write(
    region: string,
    nextCount: (prev: number) => number,
    dailyLimitHit?: boolean,
  ): RequestCountSnapshot {
    const path = this.pathFor(region)
    if (path === null) return { count: null, day: null }
    const day = localDayKey(this.now())
    // 基准为 0：文件不存在时 nextCount(0)=1（首发改写 1），存在时 nextCount(prev)
    // = prev+1；不能再预设 1，否则首发改写会算成 2（双计）。
    let count = 0
    let hit = false
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
        const record = parsed as { version?: unknown; count?: unknown; dailyLimitHit?: unknown }
        if (record?.version === COUNTER_FORMAT_VERSION) {
          const prev = Number(record.count)
          if (Number.isFinite(prev) && prev >= 0) count = Math.floor(prev)
          if (record.dailyLimitHit === true) hit = true
        }
      } catch {
        // 损坏文件：以 1 起写覆盖，不要因为旧文件坏了就丢这发计数。
      }
    }
    count = nextCount(count)
    if (dailyLimitHit !== undefined) hit = dailyLimitHit
    const tmp = `${path}.tmp`
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(
        tmp,
        JSON.stringify({ version: COUNTER_FORMAT_VERSION, count, day, dailyLimitHit: hit }, null, 2),
        'utf8',
      )
      renameSync(tmp, path)
      return { count, day }
    } catch (error) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        // 残留临时文件由 GC 回收；此处不裸抛。
      }
      this.logger?.warn?.(`dsh-connect-qoder: could not persist request count ${path}`, error)
      return { count: null, day }
    }
  }

  /**
   * 清理过期旧文件（GC）。
   *
   * 只删除**本插件命名且日期早于保留窗口**的计数文件，绝不碰目录里其它文件
   * （越界防护）。扫描以 basePath 目录为单位，按文件名日期分量判断——日期分量
   * 白名单过，非本插件格式的文件名（缺 `.qoder-request-count.` 前缀或分量非法）
   * 一律跳过，杜绝误删目录外/目录内无关文件。
   *
   * 窗口语义：`keepDays: 7` 保留今天与过去 6 天，删除第 7 天之前的文件——与
   * `readHistory(region, 7)` 的扫描范围逐日对齐。早期实现用 `-keepDays` 天做
   * cutoff（`keepDays=1` 时连昨天的文件都删），历史窗口比读路径短一天。这里取
   * `-(keepDays - 1)`：`keepDays=1` 只留今天，`keepDays=7` 留今天起 7 天。
   * 用 Date 日历减法（setDate）而非固定 24h 步进，避免 DST 时区错位（与
   * `token-counter.ts` 的 gc 同一套算法，两计数器行为一致）。
   *
   * @param now - 基准时间；默认用构造时钟。
   */
  gc(now: number = this.now()): void {
    const dir = dirname(this.basePath('x'))
    if (!existsSync(dir)) return
    const keepDays = this.keepDays
    if (keepDays < 1) return
    // 「每本地日至多一次真扫」节流：gc 挂在 usage 轮询热路径上（客户端每 5 分钟
    // 敲一次 handlers.ts），扫目录是同步 IO；而过期文件只在「某日过期」的第二天
    // 起才存在，当日首扫完成后不会有新活。key 取传入 now 的日（非 this.now()），
    // 测试可确定性驱动。todayKey 为 null（时区不可用）时不短路——照旧走后面的
    // cutoffDay null 降级分支。与 TokenCounter.gc 同一套节流（见 token-counter.ts）。
    const todayKey = localDayKey(now)
    if (todayKey !== null && todayKey === this.lastGcDay) return
    // Use calendar subtraction (setDate) instead of 24h step, consistent with readHistory.
    const cutoffDate = new Date(now)
    cutoffDate.setDate(cutoffDate.getDate() - (keepDays - 1))
    const cutoffDay = localDayKey(cutoffDate.getTime())
    if (cutoffDay === null) return
    // 用同步 readdir 以便测试可控；目录通常只有个位数本插件文件。
    let names: string[]
    try {
      names = readDirFiltered(dir)
    } catch (error) {
      this.logger?.warn?.(`dsh-connect-qoder: could not scan request-count dir ${dir}`, error)
      return
    }
    // 今日扫描完成 → 同日后续调用短路。readdir 失败不打标记（上面已 warn + return），
    // 下次轮询照试——best-effort 语义不变，没有新增静默分支。
    this.lastGcDay = todayKey
    for (const name of names) {
      const match = /^\.qoder-request-count\.([A-Za-z0-9_-]+)\.(\d{4}-\d{2}-\d{2})\.json(\.tmp)?$/.exec(name)
      if (match === null) continue
      const fileDay = match[2] as string
      if (fileDay < cutoffDay) {
        try {
          unlinkSync(`${dir}/${name}`)
        } catch (error) {
          this.logger?.warn?.(`dsh-connect-qoder: could not remove stale request-count ${name}`, error)
        }
      }
    }
  }
}

/**
 * 列出目录内**普通文件**（仅文件名），跳过目录/符号链接，越界读即抛由调用方处理。
 *
 * 通过 `withFileTypes` 只取普通文件，避免把子目录当文件删（越界防护的一环）。
 *
 * @param dir - 目录路径。
 * @returns 文件名数组。
 */
function readDirFiltered(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
}
