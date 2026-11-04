/**
 * 迷你柱状图 — 7 天 token 消耗趋势。
 *
 * SVG 手绘（DSH 的 UI 组件库没有图表组件）。柱高按当天 token 数占窗口内最大值的比例，
 * 颜色按消耗量分三档：低（绿）、中（蓝）、高（橙）。底部标注窗口总量与日均。
 *
 * 数据源：`tokensHistory`（host 下发的每日记录，按 day 升序，只含真实有数据的日子）。
 *
 * ## 约束
 *
 * - **只信传入的 `history`**：缺失的日子 host 不会补 0（见
 *   `src/host/token-counter.ts` 的 `readHistory`），所以这里的「总量 / 日均 / 趋势」
 *   全部按 `history.length` 这一**实际有数据的天数**计算。早期实现 host 侧补 0，
 *   新用户前 6 天都被摊薄成当日值的 1/7；现在没有补 0，口径自然对齐。
 * - **保持宽高比**：`preserveAspectRatio="none"` 会把柱子按容器宽度横向拉伸，
 *   圆角（rx）在非等比缩放下变成椭圆。这里改用 `xMidYMid` + 固定 viewBox 宽度，
 *   容器宽于图表时两端留白、窄于图表时整体缩放，形状不走样。
 *
 * 无障碍：SVG role="img" + aria-label；每根柱子带 <title>（日期 + 数值），
 * 供鼠标 hover 与读屏软件逐柱朗读；另外附一份可见的数据表格（仅读屏可见），
 * 因为 <title> 在不同读屏/浏览器组合下并不可靠。
 */
import { areAdjacentDays, formatTokenCount, type TokenDayRecord } from './card-model.ts'

export interface TokenHistoryChartProps {
  history: TokenDayRecord[]
  t: (key: string, vars?: Record<string, string | number>) => string
}

/** 柱子颜色阈值：按窗口内最大值的比例分三档。 */
function barColorForRatio(ratio: number): string {
  if (ratio >= 0.75) return 'var(--dsw-alias-state-warn-primary, #e8850c)'
  // 中档用 business-primary（deepseek 蓝）。曾误用 `state-info-*`——宿主主题里
  // **不存在**这一族（alias 只有 business/error/idle/success/warn 五族，已对
  // app.asar 取证），拼错名字不报错、只会静默落 fallback。
  if (ratio >= 0.4) return 'var(--dsw-alias-state-business-primary, #3b82f6)'
  return 'var(--dsw-alias-state-success-primary, #22c55e)'
}

/** 窗口内总量求和。 */
function weeklyTotal(history: TokenDayRecord[]): number {
  return history.reduce((sum, r) => sum + r.total, 0)
}

/** 日均（按实际有数据的天数，不是固定 7 天）。 */
function dailyAverage(history: TokenDayRecord[]): number {
  if (history.length === 0) return 0
  return Math.round(weeklyTotal(history) / history.length)
}

/** 趋势箭头：最后一天 vs 前一天（仅当两者日历连续时才成立）。 */
function trendArrow(history: TokenDayRecord[]): 'up' | 'down' | 'flat' | null {
  if (history.length < 2) return null
  const yesterday = history[history.length - 2]
  const today = history[history.length - 1]
  if (!yesterday || !today) return null
  // 没有补 0 之后，「最后一天 vs 前一天」可能是隔着好几天的两天（比如只在
  // 10-12 和 10-18 用过）。这种情况的「差值百分比」对用户是误导——它读起来像
  // 「较昨日」，其实是一周的差。所以只在相邻日历日才比较，否则不画趋势。
  if (!areAdjacentDays(yesterday.day, today.day)) return null
  if (today.total === 0 && yesterday.total === 0) return 'flat'
  const diff = today.total - yesterday.total
  if (diff === 0) return 'flat'
  return diff > 0 ? 'up' : 'down'
}

/** 趋势百分比。前一天为 0 或不相邻时不编造百分比，返回 null。 */
function trendPercent(history: TokenDayRecord[]): number | null {
  if (history.length < 2) return null
  const yesterday = history[history.length - 2]
  const today = history[history.length - 1]
  if (!yesterday || !today) return null
  if (!areAdjacentDays(yesterday.day, today.day)) return null
  if (yesterday.total === 0) return null
  const diff = today.total - yesterday.total
  return Math.round((diff / yesterday.total) * 100)
}

export function TokenHistoryChart({ history, t }: TokenHistoryChartProps) {
  if (history.length === 0) return null

  const max = Math.max(...history.map((r) => r.total), 1)
  const total = weeklyTotal(history)
  const avg = dailyAverage(history)
  const trend = trendArrow(history)
  const trendPct = trendPercent(history)

  const chartHeight = 24
  const barWidth = 14
  const barGap = 4
  const chartWidth = history.length * (barWidth + barGap) - barGap

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, opacity: 0.7 }}>{t('usage.tokensHistoryTitle')}</span>
        <span style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
          {trend === 'up' ? (
            <span style={{ color: 'var(--dsw-alias-state-warn-primary, #e8850c)' }}>
              {trendPct !== null ? t('usage.tokensTrendUp', { pct: trendPct }) : '↑'}
            </span>
          ) : trend === 'down' ? (
            <span style={{ color: 'var(--dsw-alias-state-success-primary, #22c55e)' }}>
              {trendPct !== null ? t('usage.tokensTrendDown', { pct: Math.abs(trendPct) }) : '↓'}
            </span>
          ) : trend === 'flat' ? (
            <span style={{ opacity: 0.5 }}>{t('usage.tokensTrendFlat')}</span>
          ) : null}
        </span>
      </div>
      {/*
        viewBox 宽度按柱子数算，容器更宽时用 xMidYMid 居中留白（不拉伸）；
        容器更窄时才整体等比缩小。柱子数与 barGap 决定图表窄边，最坏 7 根 =
        14*7+4*6-4 = 118px，塞得进 240px 的卡片窄栏。
      */}
      <svg
        width="100%"
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        height={chartHeight}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={t('usage.tokensHistoryTitle')}
        style={{ display: 'block' }}
      >
        {history.map((r, i) => {
          const ratio = r.total / max
          const barHeight = Math.max(2, ratio * chartHeight)
          const x = i * (barWidth + barGap)
          const y = chartHeight - barHeight
          return (
            <rect
              key={r.day}
              x={x}
              y={y}
              width={barWidth}
              height={barHeight}
              rx={2}
              fill={barColorForRatio(ratio)}
            >
              <title>{t('usage.tokensDayTooltip', { day: r.day, total: formatTokenCount(r.total) })}</title>
            </rect>
          )
        })}
      </svg>
      {/*
        数据表格（读屏可见、视觉隐藏）。<title> 只在 hover/焦点时才被部分读屏
        软件朗读，纯图形 + aria-label 又拿不到逐日数值——补一份语义表格，
        让键盘/读屏用户能真正「读到」这 7 天的数，而不是只听到一个总标题。
      */}
      <table
        className="dsm-qoder-visually-hidden"
        style={{ borderCollapse: 'collapse' }}
        aria-label={t('usage.tokensHistoryTitle')}
      >
        <thead>
          <tr>
            <th scope="col">{t('usage.tokensHistoryTitle')}</th>
          </tr>
        </thead>
        <tbody>
          {history.map((r) => (
            <tr key={r.day}>
              <th scope="row">{r.day}</th>
              <td>{formatTokenCount(r.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, opacity: 0.6 }}>
        <span>{t('usage.tokensWeeklyTotal', { total: formatTokenCount(total) })}</span>
        <span>{t('usage.tokensDailyAvg', { avg: formatTokenCount(avg) })}</span>
      </div>
    </div>
  )
}
