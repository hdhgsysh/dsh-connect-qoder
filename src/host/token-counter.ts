/**
 * 本地 token 消耗累加器 — 本客户端经本插件发往上游、每轮对话上游明确下发的
 * token 数（prompt / completion / total / 缓存命中），按 region + 上海本地日
 * 在本地累加落盘。
 *
 * 与「本地请求计数器」（`request-counter.ts`）的区别与边界：
 *
 * - 请求计数上游**根本不给**每日上限，只能本地自计「发了几发」——那一条是纯粹的
 *   本地口径，不画比例条（画 N/上限 等于发明上游没公布的口径）。
 * - token 数则是**上游每轮对话都明确下发**的（见 `shim.ts` 抓 `chunk.usage`
 *   的 `total_tokens` / `prompt_tokens_details.cached_tokens` 并转发给 DSH）。
 *   所以这里做的是「本地聚合一份已经公开的数据」，不是编造——可以做、也
 *   **应该**画出来，否则用户在插件卡里看不到自己消耗了多少 token。
 * - 桌面端与 Web 端各记各的（同 request-counter 的「本客户端口径」），官方口径
 *   以 DSH 宿主侧的会话记账为准；此处只是把同样的数据在插件卡里也呈现一份。
 *
 * 落盘契约（踩红线 1 / 凭据清理那套纪律，与 `request-counter.ts` 同款）：
 *
 * - 一个 JSON 文件、按 region + 本地日期（Asia/Shanghai 日历日）命名，落在
 *   `$DSH_HOME/.qoder-token-count.<region>.<YYYY-MM-DD>.json`。沿用
 *   `throttle-store.ts` 的「写临时文件再 rename 覆盖」原子套路。
 * - 计数发生在 shim 抓到 usage 帧时（`chatCompletions` 遍历流，累加该轮的
 *   `totalTokens`），与请求计数的「发了一发 +1」同源但不互相耦合：token 数
 *   上游直接给，重试同一轮只在那一轮的统计里加一次（流内的 usage 帧也只有
 *   一个，不会重复加）。
 * - **零点翻页**：每次读/写都重新算本地日期 key，落到不同文件，旧文件按 GC 清理。
 * - **越界防护**：region / 日期分量过 `sanitizeComponent` 白名单，任何非法
 *   分量返回 `null`（不计数、不写盘），绝不拼出目录外的路径。
 * - **永不抛**：读不到 / 写失败一律降级为「不可用」（`count === null`），不
 *   阻塞对话、不给用户假的成功读数。
 * - **原子性（有边界）**：所有 fs 操作为同步，Node.js 单线程模型保证单次
 *   `addUsage` 的读-改-写在同一 tick 内完成——**同一进程内**两条并发流不会互相
 *   打断。但 web 与 desktop 两个 profile 可以同时激活、共用同一个 `$DSH_HOME`，
 *   那是两个进程读改写同一个文件，后写的 rename 会整体覆盖前一次的累加（丢更
 *   新）。这与 credential-vault 登记的跨进程缺口同类（见 `docs/KNOWN_GAPS.md`）：
 *   桌面端与 Web 端「各记各的」在本插件内的语义是**各写各的文件**才成立，而这里
 *   的文件名只按 region + 日 分段、不含 profile，所以两边会互相盖。真实用户几乎
 *   不会同时跑两个 profile，故不做进程锁（那要引依赖、要处理死锁），但**不许把
 *   注释写成「不存在并发竞态」**——那句话在读代码时会被当成已论证过的结论。
 *   `readHistory` 的 7 天窗口同理：跨进程覆盖只丢最近一天的量，历史窗口本身不坏。
 *
 * @module dsh-connect-qoder/token-counter
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { localDayKey, sanitizeComponent } from './request-counter.ts'

/** 落盘 JSON 的版本号；与 `request-counter.ts` 同约定，读错版本即丢弃。 */
const TOKEN_FORMAT_VERSION = 1

/** 计数器对外暴露的读数：今日消耗的 token 与缓存命中，或 `null`（本地口径不可用）。 */
export interface TokenCountSnapshot {
  /** 今日经本客户端累计消耗的 token 总数（上游 `total_tokens` 之和）；不可用为 `null`。 */
  total: number | null
  /** 今日经本客户端累计命中的缓存 token 数（上游 `cached_tokens` 之和）；不可用为 `null`。 */
  cached: number | null
  /** 该读数的本地日历日（与计数文件同名），用于客户端标注「今日」语义。 */
  day: string | null
}

/**
 * 一天的历史记录（多日统计用）。
 *
 * **跨进程契约，一处定义、两端消费**：client 侧 `src/client/card-model.ts` 有
 * 同形接口。client 不许 import `src/host/`（见 card-model.ts 头部注释），host 也
 * 不该 import client，所以两端各写各的；`test/token-history-contract.test.js`
 * 把两边的字段钉在一起，任何一侧增删字段而另一侧没跟上会直接红，而不是等到
 * 用户在卡片上看到 `undefined` / `NaN`。
 *
 * 语义约定（两端都按这个读）：
 * - `day` 是本地日历日 `YYYY-MM-DD`（Asia/Shanghai），与文件名同日。
 * - `total` / `cached` 是**当日实际发生的量**。`readHistory` 不给缺失日补 0，
 *   所以客户端拿到的数组长度就是「有数据的天数」——算总量/日均/趋势时按它分
 *   母，不要把窗口当成恒 7 天。
 */
export interface TokenDayRecord {
  /** 本地日历日（YYYY-MM-DD）。 */
  day: string
  /** 当日经本客户端累计消耗的 token 总数。 */
  total: number
  /** 当日经本客户端累计命中的缓存 token 数。 */
  cached: number
}

/** 构造选项：路径前缀 + 注入时钟 + 日志。 */
export interface TokenCounterOptions {
  /** 生成文件名前缀的函数（注入 `qoderCatalogPath`，永远落在 `$DSH_HOME` 内）。 */
  basePath: (filename: string) => string
  /** 墙钟，注入便于测试；默认 `Date.now`。 */
  now?: () => number
  /** 可选日志。 */
  logger?: { warn?: (message: string, error?: unknown) => void }
  /** 保留几天旧文件，默认 7；GC 时删除更早的按本插件命名且日期早于该窗口的文件。 */
  keepDays?: number
}

/** 已解析的日文件数据（内部用）。 */
interface ParsedDayFile {
  total: number
  cached: number
}

/**
 * 读取并解析单个日文件。所有读路径（read / readHistory / write）共用此函数，
 * 避免重复的 version 检查 + Number 收敛 + floor 逻辑。
 *
 * @param path - 文件绝对路径。
 * @returns 解析后的 {total, cached}；文件不存在 / 版本不符 / 损坏 / 非有限数 → `null`。
 */
function parseDayFile(path: string): ParsedDayFile | null {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    const record = parsed as { version?: unknown; total?: unknown; cached?: unknown }
    if (record?.version !== TOKEN_FORMAT_VERSION) return null
    const total = Number(record.total)
    const cached = Number(record.cached)
    if (!Number.isFinite(total) || total < 0) return null
    const cachedValue = Number.isFinite(cached) && cached >= 0 ? Math.floor(cached) : 0
    return { total: Math.floor(total), cached: cachedValue }
  } catch {
    return null
  }
}

/**
 * 把上游 usage 帧里的 token 数收敛成本累加器认识的增量。
 *
 * Qoder 的 usage 块是 OpenAI 同款 `stream_options.include_usage` 形状：
 * `{ prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details:
 * { cached_tokens } }`。只取**上游实际下发**的字段，缺则按 0 计（不编造）。
 * 任一值不是有限非负数即整体返回 `null`（该帧坏掉，宁可不加也不加错）。
 *
 * @param usage - 上游 usage 帧（任意形状，缺失字段按 0）。
 * @returns 可累加的增量，或 `null`。
 */
export function tokensFromUsage(usage: unknown): { total: number; cached: number } | null {
  if (usage === null || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>
  const total = Number(u.total_tokens)
  const cachedRaw = (u.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens
  const cached = Number(cachedRaw)
  if (!Number.isFinite(total) || total < 0) return null
  const cachedValue = Number.isFinite(cached) && cached >= 0 ? Math.floor(cached) : 0
  return { total: Math.floor(total), cached: cachedValue }
}

/**
 * 本客户端每日 token 消耗累加器。
 *
 * 一个 region 一个实例；文件按 `region + 本地日` 分文件，零点翻页自动切文件。
 * 所有磁盘操作吞错降级，绝不把计数失败传导到对话链路。
 *
 * fs 全同步，单次 addUsage 的读-改-写在同一 tick 内完成——这是**同进程内**的
 * 保证；跨进程（web / desktop 两个 profile 共用 `$DSH_HOME`）的竞态见文件头注释，
 * 此处不重复论证。
 */
export class TokenCounter {
  private basePath: (filename: string) => string
  private now: () => number
  private logger: { warn?: (message: string, error?: unknown) => void } | undefined
  private keepDays: number
  /** 本实例实际完成 gc 扫描的本地日；同日再入短路（usage 轮询热路径节流）。 */
  private lastGcDay: string | null = null

  constructor({ basePath, now = () => Date.now(), logger, keepDays = 7 }: TokenCounterOptions) {
    this.basePath = basePath
    this.now = now
    this.logger = logger
    this.keepDays = keepDays
  }

  /**
   * 当前 region + 本地日的计数文件路径与日期 key；任一分量非法返回 `null`。
   * 一次取 day，避免 read() 里两次独立调用 localDayKey 在 23:59:59.999 跨零点时
   * path 是旧日文件、返回的 day 是新日的错位。
   */
  private pathFor(region: string): { path: string; day: string } | null {
    const safeRegion = sanitizeComponent(region)
    if (safeRegion === null) return null
    const day = localDayKey(this.now())
    if (day === null) return null
    return { path: this.basePath(`.qoder-token-count.${safeRegion}.${day}.json`), day }
  }

  /**
   * 读今日 token 计数（不出错）。
   *
   * @param region - region id。
   * @returns 读数；文件不存在 / 损坏 / 越界 / 时区不可用 → 全部 `null`。
   */
  read(region: string): TokenCountSnapshot {
    const resolved = this.pathFor(region)
    if (resolved === null) return { total: null, cached: null, day: null }
    const { path, day } = resolved
    // Formal file first; fallback to tmp (crash before renameSync = today's data is in tmp).
    const parsed = parseDayFile(path) ?? parseDayFile(`${path}.tmp`)
    if (parsed === null) return { total: null, cached: null, day }
    return { total: parsed.total, cached: parsed.cached, day }
  }

  /**
   * 读取过去 N 天的 token 消耗历史（多日统计用）。
   *
   * 从 `now` 向前逐天扫描本地日历日文件（含今天自己），**只收真实存在过数据的日子**：
   * 没有文件的日期（本客户端那天没用过 / 文件已被 GC）不出现在返回值里。早期版本
   * 给缺失日补 `{total: 0}`，于是「没有数据」与「消耗为 0」在数组里不可区分——客户
   * 端把两种日子画成同一根贴地柱子，日均也按 7 天恒等分母摊薄，读出来比实际低。
   *
   * 返回值按 day 升序排列（最早在前）。
   *
   * 使用 Date 日历减法（setDate）而非固定 24h 步进，避免 DST 时区在一天扫描重复或跳过。
   *
   * @param region - region id。
   * @param days - 回溯天数，默认 7；上限由 `keepDays` 隐式决定。
   * @returns 历史记录数组（可能为空；长度 ≤ min(days, keepDays)）。
   */
  readHistory(region: string, days: number = 7): TokenDayRecord[] {
    const safeRegion = sanitizeComponent(region)
    if (safeRegion === null) return []
    const records: TokenDayRecord[] = []
    const scannedDays = Math.min(days, this.keepDays)
    const dateObj = new Date(this.now())
    for (let i = 0; i < scannedDays; i++) {
      const day = localDayKey(dateObj.getTime())
      if (day !== null) {
        const path = this.basePath(`.qoder-token-count.${safeRegion}.${day}.json`)
        const parsed = parseDayFile(path) ?? parseDayFile(`${path}.tmp`)
        // 只在文件真实存在（解析成功）时收这一天；缺失日与 0 消耗日必须可区分。
        if (parsed !== null) {
          records.push({ day, total: parsed.total, cached: parsed.cached })
        }
      }
      dateObj.setDate(dateObj.getDate() - 1)
    }
    // 按 day 升序排列（i 越大越早，所以反转）。
    return records.reverse()
  }

  /**
   * 把上游某轮的 token 增量累加进今日文件（不出错）。
   *
   * 与 `bump` 不同：这里累加的是「上游下发的真实 token 数」，缺字段按 0，坏
   * 帧整体跳过（返回 `null` 而非写脏数据）。读失败以 0 起写——这一轮的消耗
   * 已经发生，只是本插件没记下，降级即可，不丢数也不造数。
   *
   * @param region - region id。
   * @param usage - 上游 usage 帧。
   * @returns 累加后的读数；帧无效 / 越界 / 写失败 → `null`。
   */
  addUsage(region: string, usage: unknown): TokenCountSnapshot {
    const delta = tokensFromUsage(usage)
    if (delta === null) return { total: null, cached: null, day: null }
    return this.write(region, (prevTotal, prevCached) => ({
      total: prevTotal + delta.total,
      cached: prevCached + delta.cached,
    }))
  }

  /**
   * 计数累加 + 合并的底层落盘：读旧值 → 套用 `next` 得到新计数 → 原子写。读失败
   * 以 `{0,0}` 起写（不丢数、不裸抛）。失败清 tmp 不裸抛、warn 降级。
   */
  private write(
    region: string,
    next: (prevTotal: number, prevCached: number) => { total: number; cached: number },
  ): TokenCountSnapshot {
    const resolved = this.pathFor(region)
    if (resolved === null) return { total: null, cached: null, day: null }
    const { path, day } = resolved
    const prev = parseDayFile(path) ?? parseDayFile(`${path}.tmp`) ?? { total: 0, cached: 0 }
    const result = next(prev.total, prev.cached)
    const tmp = `${path}.tmp`
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(
        tmp,
        JSON.stringify(
          { version: TOKEN_FORMAT_VERSION, total: result.total, cached: result.cached, day },
          null,
          2,
        ),
        'utf8',
      )
      renameSync(tmp, path)
      return { total: result.total, cached: result.cached, day }
    } catch (error) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        // 残留临时文件由 GC 回收；此处不裸抛。
      }
      this.logger?.warn?.(`dsh-connect-qoder: could not persist token count ${path}`, error)
      return { total: null, cached: null, day }
    }
  }

  /**
   * 清理过期旧文件（GC）。只删除**本插件命名且日期早于保留窗口**的 token 文件，
   * 绝不碰目录里其它文件（越界防护）。`.tmp` 残留一并收（写崩溃时 rename 没跑到）。
   *
   * 窗口语义：`keepDays: 7` 保留今天与过去 6 天，删除第 7 天之前的文件——与
   * `readHistory(region, 7)` 的扫描范围逐日对齐。早期实现用 `-keepDays` 天做
   * cutoff，会把「昨天」这种还在窗口内的日子也算成过期（keepDays=1 时连昨天的
   * 文件都删），历史窗口比读路径短一天。这里取 `-(keepDays - 1)`：
   * `keepDays=1` 只留今天，`keepDays=7` 留今天起 7 天。
   */
  gc(now: number = this.now()): void {
    const dir = dirname(this.basePath('x'))
    if (!existsSync(dir)) return
    if (this.keepDays < 1) return
    // 「每本地日最多扫一次」节流：gc 挂在 usage 轮询热路径上（客户端每 5 分钟
    // 敲一次），扫目录是同步 IO；而过期文件只在「某日过期」的第二天起才存在，
    // 当日首扫完成后不会有新活。key 取传入 now 的日（非 this.now()），测试可
    // 确定性驱动。todayKey 为 null（时区不可用）时不短路——照旧走后面的
    // cutoffDay null 降级分支。
    const todayKey = localDayKey(now)
    if (todayKey !== null && todayKey === this.lastGcDay) return
    // Use calendar subtraction (setDate) instead of 24h step, consistent with readHistory.
    const cutoffDate = new Date(now)
    cutoffDate.setDate(cutoffDate.getDate() - (this.keepDays - 1))
    const cutoffDay = localDayKey(cutoffDate.getTime())
    if (cutoffDay === null) return
    let names: string[]
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
    } catch (error) {
      this.logger?.warn?.(`dsh-connect-qoder: could not scan token-count dir ${dir}`, error)
      return
    }
    // 今日扫描完成 → 同日后续调用短路。readdir 失败不打标记（上面已 warn + return），
    // 下次轮询照试——best-effort 语义不变，没有新增静默分支。
    this.lastGcDay = todayKey
    for (const name of names) {
      const match = /^\.qoder-token-count\.([A-Za-z0-9_-]+)\.(\d{4}-\d{2}-\d{2})\.json(\.tmp)?$/.exec(name)
      if (match === null) continue
      const fileDay = match[2] as string
      if (fileDay < cutoffDay) {
        try {
          unlinkSync(`${dir}/${name}`)
        } catch (error) {
          this.logger?.warn?.(`dsh-connect-qoder: could not remove stale token-count ${name}`, error)
        }
      }
    }
  }
}
