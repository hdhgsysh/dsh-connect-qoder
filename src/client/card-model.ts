/**
 * The card's browser-free decision layer.
 *
 * This module holds the pure rules the `QoderPluginCard` JSX reads — the
 * off-peak gate, the per-row rate, the context-window label, the refresh
 * verdict and the formatting helpers — plus the view-model type vocabulary the
 * card receives over HTTP. It imports nothing from React, nothing touches the
 * DOM, and it performs no `fetch`. That is deliberate, and it is the point of
 * the split:
 *
 *   - these functions can be imported into a plain Node test (strip types
 *     only) and asserted against the real implementation, instead of against
 *     a hand-written mirror that would pass even if the source drifted;
 *   - `scripts/build-client.mjs` still bundles them into `lib/client.js`, so
 *     the artifact-level guards (`test/client-bundle.test.js`,
 *     `test/protocol-shape-card.test.js`) keep reading the shipped bundle and
 *     stay meaningful — moving the source here changes nothing about what the
 *     bundle contains.
 *
 * The motivation traces to the same pain `dsh-connect-sensenova-token-plan`
 * solved by hoisting its snapshot decision logic into a Node-importable
 * `snapshot.ts`: a rule that lives only inside the browser bundle can be
 * pinned only by scraping the artifact or by mirroring it in a test, and both
 * drift. See `docs/KNOWN_GAPS.md`.
 *
 * `describeThrown` lives here, next to the other display helpers, not in
 * `card.tsx` as it used to. It is a browser-free formatting rule (no React, no
 * DOM) shared by every card `catch` block that shows a failure reason, and the
 * panel containers (`account-panel.tsx` / `usage-panel.tsx`) and the editable
 * state machine (`controller.ts`) import it from this module — which imports
 * nothing client-side — instead of reaching back into `card.tsx`, which would
 * close two circular-import pairs around the assembly module. `controller.ts`
 * had its own private twin until it was merged here; the client now holds one
 * copy. Duplicating `host/errors.ts#describeThrown` is still on purpose: no
 * client file imports from `src/host/`, and hoisting a two-line narrowing into
 * the generated `lib/client.js` is not worth that coupling.
 */

/** One model row as the models route serves it. */
export interface CardModelRow {
	id: string
	region?: string
	name?: string
	contextWindowLabel?: string
	contextOptions?: unknown[]
	defaultContextWindow?: number
	priceFactor?: number
	/** Normalized by `upstream.normalizePromotion`; see `Promotion` in domain.ts. */
	promotion?: CardPromotion | null
	[key: string]: unknown
}

/** The time-of-day discount block, as the card reads it. */
export interface CardPromotion {
	active?: boolean
	windowStart?: string
	windowEnd?: string
	timezone?: string
	beforePromotionPriceFactor?: number
	discountFactor?: number
	[key: string]: unknown
}

/** A per-region usage block on the usage route's answer. */
export interface CardUsageRegion {
	region?: string
	regionName?: string
	displayName?: string
	available?: boolean
	expiresAt?: number
	userQuota?: CardQuota
	addOnQuota?: CardQuota
	dedicatedPackages?: CardQuota[]
	campaigns?: CardCampaign[]
	/**
	 * Why the campaign list is missing, when the host says the read failed.
	 *
	 * Campaigns are supplementary, so the quota bars above still render — but
	 * "no offers today" and "the offers could not be read" used to look
	 * identical, which is the silent-failure shape (red line 1). The host now
	 * sends the reason and this card prints it, like `checkin` does for the
	 * machine-identity hint.
	 */
	campaignsError?: string
	/**
	 * Whether the campaigns half failed as a protocol-shape change rather than
	 * a transport failure. The remedy differs — one heals on its own, the other
	 * needs a plugin update — so the card says which, instead of printing the
	 * host's raw sentence for both.
	 */
	campaignsShapeChanged?: boolean
	/**
	 * Why the region's usage read failed, when the host names it.
	 *
	 * `protocol-shape-changed` means the upstream answer no longer has the
	 * shape this plugin reads; `read-failed` (or a missing field, from a host
	 * older than this) degrades to the generic copy.
	 */
	unavailableReason?: string
	checkin?: CardCheckin
	/**
	 * 本地口径：今日经本客户端发出的对话轮数，由本插件本地自计（上游不给上限，
	 * 只报「用完了」）。总是数字（`0` 表示今日还没发过请求）；当计数器根本没接入
	 * 时为 `undefined`——此时 `requestsUnavailable` 为 `true`。
	 */
	requestsToday?: number
	/**
	 * 本地计数未接入：宿主未挂载 `requestCounter`（旧宿主 / 未启用）。与
	 * `requestsToday === 0` 区分——后者是有数据只是今天还没发，前者是真的没接上。
	 */
	requestsUnavailable?: boolean
	/**
	 * 本地推断：今日是否撞到每日限流（shim 收到 `daily_limit_exceeded` 时标记）。
	 * 这是本插件的本地估计，非上游官方状态；true 时卡片诚实标注「仅供参考」。
	 */
	requestsExhausted?: boolean
	/**
	 * 本地口径：今日经本客户端累计消耗的 token 总数——上游每轮对话明确下发的
	 * `total_tokens` 之和，本地聚合。总是数字（`0` 表示今日还没消耗过）；当计数器
	 * 未接入（旧宿主）时为 `undefined`，此时不渲染这一行。
	 */
	tokensToday?: number
	/**
	 * 本地口径：今日经本客户端累计命中的缓存 token 数（上游 `cached_tokens` 之和）。
	 * 仅 `>0` 时下发，作为 `tokensToday` 的补充注。
	 */
	tokensCachedToday?: number
	/**
	 * 本地口径：过去若干天每日 token 消耗历史，按 day 升序排列。供客户端渲染
	 * 柱状图、计算窗口总量与日均。
	 *
	 * **只含真实有数据的日子**：host 的 `readHistory` 不给缺失日补 0，所以
	 * `length` 本身就是「有数据的天数」，客户端算总量/日均/趋势时直接按它分
	 * 母。早期版本 host 侧补 0，新用户前 6 天会被摊薄成当日值的 1/7——那时
	 * 这里的注释还写着「过去 7 天」，两个口径并不一致。
	 */
	tokensHistory?: TokenDayRecord[]
	[key: string]: unknown
}

/**
 * 一天的 token 消耗记录（多日历史用）。
 *
 * **跨进程契约，一处定义、两端消费**：host 侧 `src/host/token-counter.ts` 与
 * 本接口字段必须一致。双 region 纪律下 client 不许 import `src/host/`
 * （card-model.ts 头部的 import 注释写着这条），所以这里是唯一声明处，host 侧
 * 各写各的。`test/token-history-contract.test.js` 把两边的形状钉在一起：
 * host 增删字段而 client 没跟上（或反之）会直接红，而不是等到用户看到 NaN。
 */
export interface TokenDayRecord {
	/** 本地日历日（YYYY-MM-DD）。 */
	day: string
	/** 当日经本客户端累计消耗的 token 总数。 */
	total: number
	/** 当日经本客户端累计命中的缓存 token 数。 */
	cached: number
}

/**
 * 两个 YYYY-MM-DD 是否恰好相差一个日历日（跨月/跨年/闰年边界都算对）。
 *
 * **纯 UTC 日序差，绝不读本地时区**：host 侧（`token-counter.ts` 的 readHistory/gc、
 * `request-counter.ts`）已整体改用 `setDate` 日历步进、认定固定 24h 在 DST 切换日
 * 是错的（相邻日会差 23h/25h）；客户端这条渲染链曾把 `Date.parse('...T00:00:00')`
 * （本地午夜）+ `=== 24h` 方程用回来过——那会让趋势箭头在 DST 日每年静默消失一天。
 * 回归钉在 `test/token-adjacent-days.test.js`（含强制 DST 时区的边界对）。
 */
export function areAdjacentDays(a: string, b: string): boolean {
	const da = dayOrdinal(a)
	const db = dayOrdinal(b)
	if (da === null || db === null) return false
	return Math.abs(db - da) === 1
}

/** YYYY-MM-DD → UTC 日序数；非法返回 null。Date.UTC 会把越界分量归一化
 *  （2026-02-30 变成 03-02），所以必须读回校验各日历字段原位，否则坏日期
 *  会被算成合法相邻日。年份 0099 之类同样被这层挡住（Date.UTC 把 0-99 映射到 1900+）。 */
function dayOrdinal(day: string): number | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
	if (match === null) return null
	const year = Number(match[1])
	const month = Number(match[2])
	const date = Number(match[3])
	const ms = Date.UTC(year, month - 1, date)
	if (Number.isNaN(ms)) return null
	const back = new Date(ms)
	if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== date) return null
	return ms / 86_400_000
}

/** One quota bucket, in either the base or the add-on slot. */
export interface CardQuota {
	used?: number
	total?: number
	remaining?: number
	unit?: string
	percentage?: number
	[key: string]: unknown
}

/** One promotional campaign row. */
export interface CardCampaign {
	id?: string
	badge?: string
	description?: string
	endsAt?: number
	[key: string]: unknown
}

/**
 * The daily check-in block, as the host's `checkinStateFrom` answers it.
 *
 * `active` says upstream has a round running, `todayCheckedIn` says this
 * account already collected it, and `amount` is the round's worth — taken from
 * the live campaign's benefit, so it is a fact the host resolved rather than a
 * number this card worked out. It is present whether or not the round has been
 * claimed, which is what lets the card keep showing what today is worth after
 * the button flips to "今日已签到".
 */
export interface CardCheckin {
	active?: boolean
	todayCheckedIn?: boolean
	amount?: number
	[key: string]: unknown
}

/** One account row as the account route serves it. */
export interface CardAccountEntry {
	region?: string
	regionName?: string
	appName?: string
	displayName?: string
	state?: string
	detail?: string
	downloadUrl?: string
	source?: string
	/** The provider switch, as the route resolved it (absent = offered). */
	enabled?: boolean
	identity?: { name?: string; email?: string; expiresAt?: number } | null
	/**
	 * This region's plugin-owned credential, when the host reports one.
	 *
	 * Reported BESIDE `state`, never merged into it: the desktop application's
	 * sign-in and the plugin's own token are two credentials with two lifetimes,
	 * and a region can be `signed-out` of the application while the plugin's
	 * token is perfectly usable. Absent means the host has no device source to
	 * report — an older build — which is why the panel renders nothing at all
	 * rather than a "not signed in" that would be a claim it cannot make.
	 */
	device?: CardDeviceEntry
	/**
	 * Which credential path is serving this region, as the HOST resolved it.
	 *
	 * The host knows the answer — it is the one that resolved the credential —
	 * so it says it: `desktop` for the desktop application's own sign-in,
	 * `device` for the credential this plugin obtained itself, `env` for a PAT
	 * from the environment. Absent means the host has resolved nothing yet (or
	 * is an older build that does not report it), and the card then falls back
	 * to what it can infer from `state` and `source`.
	 */
	credentialKind?: CardCredentialKind
	[key: string]: unknown
}

/** The three credential paths, named the way the host reports them. */
export type CardCredentialKind = "desktop" | "device" | "env"

/** One region's plugin-owned credential, as the account route reports it. */
export interface CardDeviceEntry {
	/** `none` | `ok` | `expired` | `refresh-failed` | `save-failed` | `unreadable`. */
	state?: string
	/** Why, when the state is one the user has to act on. */
	reason?: string
}

/**
 * Which credential path is serving this region, as the host reported it.
 *
 * `undefined` when the host named none — an older build, or a host that has
 * resolved no credential yet. The callers then fall back to what the panel can
 * infer, which is a guess; the host's answer is not.
 */
export function credentialKindOf(entry: CardAccountEntry): CardCredentialKind | undefined {
	const kind = entry.credentialKind;
	return kind === "desktop" || kind === "device" || kind === "env" ? kind : undefined;
}

/**
 * Whether the DESKTOP application's credential is the one serving this region.
 *
 * The host resolves credentials in one order — the desktop store, then the
 * plugin's own, then the PAT (see `src/host/credential-cache.ts`) — and the card
 * has to answer about the credential that order actually picks. When the host
 * names the kind, that is the answer; otherwise the panel's own inference is
 * used: a region that reads the desktop store says `ok` and keeps saying so.
 */
export function desktopCredentialInUse(entry: CardAccountEntry): boolean {
	const kind = credentialKindOf(entry);
	if (kind !== undefined) return kind === "desktop";
	return entry.state === "ok" && (entry.source === "app" || entry.source === undefined);
}

/**
 * The EFFECTIVE sign-in state of one region.
 *
 * The card has to answer ONE question — "am I signed in for this edition?" —
 * and on a machine that cannot read the desktop app's keychain the answer is
 * yes whenever the plugin's own credential is the one in use. Without this, a
 * macOS user who signed in through the browser read "Unreadable" in the state
 * label and "Signed in to the plugin" two lines below.
 */
export function effectiveAccountStateOf(entry: CardAccountEntry): string {
	const kind = credentialKindOf(entry);
	if (kind === "device") return "device";
	if (kind !== undefined) return String(entry.state);
	return entry.device?.state === "ok" && !desktopCredentialInUse(entry) ? "device" : String(entry.state);
}

/**
 * Which source chip this region's credential deserves.
 *
 * ONE chip, because two of them at once ("from Qoder · from the plugin's own
 * sign-in") reads as a contradiction. The host's kind decides it when it is
 * there; otherwise the panel falls back to the source it was told about.
 */
export function credentialChipOf(entry: CardAccountEntry): "device" | "env" | "app" | undefined {
	const kind = credentialKindOf(entry);
	if (kind === "device") return "device";
	if (kind === "env") return "env";
	if (kind === "desktop") return "app";
	if (effectiveAccountStateOf(entry) === "device") return "device";
	if (entry.source === "env-pat") return "env";
	// The app chip names where the credential CAME FROM, so it may only appear
	// when a credential was actually read. In the `needs-app` state the host
	// reports the app DIRECTORY's name — it found Qoder installed but could not
	// read a sign-in out of it — so "from Qoder" there claims a sign-in this
	// machine does not have.
	const appCredentialRead =
		entry.source === "app" ||
		(entry.source === undefined && (entry.state === "ok" || entry.state === "expired"));
	return appCredentialRead ? "app" : undefined;
}

/** The translation function the host injects. */
export type TranslateFn = (key: string, params?: Record<string, string | number>) => string

/**
 * Browser event shapes the card's handlers actually read.
 *
 * Not `unknown`, and not the DOM's own `Event` either — the JSX shim declares
 * `JSX.IntrinsicElements` only as an index signature, so there is no element
 * type for `jsx()` to propagate into a handler. What the code needs is narrow
 * and worth stating: a checkbox handler reads `target.checked`, a select or
 * text input reads `target.value`. Naming the two separately means each call
 * site says which one it is, and a `checked` read on a `value` handler is a
 * compile error rather than `undefined` at runtime.
 */
export interface CheckboxEvent {
	target: { checked: boolean }
}
export interface ValueEvent {
	target: { value: string }
}

/** A browser event handler, as the JSX shim's `jsx()` sees it. */
export type EventHandler = (event: unknown) => void

/** Fill a `{date}` placeholder in a translated string. */
export function withDate(template: string, at: number | undefined): string {
	if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return "";
	const date = new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "numeric", day: "numeric" });
	return template.replace("{date}", date);
}

/**
 * The credit multiplier as a short label.
 *
 * A zero multiplier is a free model, which is worth naming rather than
 * rendering as "x0.00"; a model whose catalog entry carries no multiplier
 * shows nothing at all. This mirrors how the host decorates the picker
 * name, so the card and the picker never disagree.
 */
export function rateLabelOf(t: TranslateFn, factor: unknown): string | undefined {
	const value = Number(factor);
	if (!Number.isFinite(value)) return undefined;
	return value <= 0 ? t("row.rateFree") : `x${value.toFixed(2)}`;
}

/** Seconds past local midnight in `timezone`, or undefined when unusable. */
export function localSecondsOf(date: Date, timezone: string): number | undefined {
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			hour12: false,
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit"
		}).formatToParts(date);
		const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
		const hour = read("hour") % 24;
		const minute = read("minute");
		const second = read("second");
		if (![hour, minute, second].every(Number.isFinite)) return undefined;
		return hour * 3600 + minute * 60 + second;
	} catch {
		return undefined;
	}
}

/** Parse `HH:MM` into seconds past midnight, or undefined. */
export function parseClock(text: unknown): number | undefined {
	const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(text ?? "").trim());
	if (match === null) return undefined;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	const second = Number(match[3] ?? 0);
	if (hour > 23 || minute > 59 || second > 59) return undefined;
	return hour * 3600 + minute * 60 + second;
}

/**
 * The off-peak window state for one model at a given instant.
 *
 * The window is evaluated in the browser rather than taken from the
 * server's answer so the card can flip the rate and tick the countdown on
 * its own — a rate that silently changed at 22:00 only after a manual
 * refresh would look broken. `end` not after `start` means the window
 * crosses midnight (`22:00`-`08:00` is the case Qoder uses), so the test
 * is a disjunction.
 *
 * The `active` gate is load-bearing and must match the host's own rule
 * (`isOffPeakActive` in lib/offpeak.js, reached here through
 * `projectModelRow`). Qoder keeps the window fields populated on a
 * promotion it has switched off, and `upstream.normalizePromotion` carries
 * `active` and `windowStart`/`windowEnd` independently, so a window alone
 * is NOT evidence that the discount is live. Without this check a model
 * whose promotion is off was rendered at the discounted rate during its
 * own hours — showing the user a price they are not charged — and the two
 * surfaces (card and picker) disagreed, because the host was correctly
 * showing the `before` rate for that same model.
 *
 * The bug needs a mixed catalog to appear: the ticking clock is installed
 * when ANY model has `active === true` (see the `hasActiveWindow` gate),
 * and from then on every row re-resolves through this function.
 *
 * SYNC CONSTRAINT: this mirrors lib/offpeak.js. The card runs in the browser
 * and cannot be imported into a Node test, so the rule is pinned twice:
 * test/model-row.test.js specifies it, test/client-bundle.test.js executes
 * the shipped bundle — see docs/KNOWN_GAPS.md item 3（客户端卡片的门控表达式）.
 *
 * @returns `{ active, remainingSeconds }`, or undefined when the model
 *   carries no usable window or its promotion is not active.
 */
export function offPeakState(model: CardModelRow, now: Date): { active: boolean; remainingSeconds: number } | undefined {
	const promo = model.promotion;
	if (promo === null || typeof promo !== "object") return undefined;
	if (promo.active !== true) return undefined;
	const start = parseClock(promo.windowStart);
	const end = parseClock(promo.windowEnd);
	if (start === undefined || end === undefined || start === end) return undefined;
	const seconds = localSecondsOf(now, typeof promo.timezone === "string" ? promo.timezone : "Asia/Shanghai");
	if (seconds === undefined) return undefined;
	const active = start < end ? seconds >= start && seconds < end : seconds >= start || seconds < end;
	const target = active ? end : start;
	const remainingSeconds = target >= seconds ? target - seconds : 86400 - seconds + target;
	return { active, remainingSeconds };
}

/** `HH:MM:SS` from a second count, matching the Qoder client's countdown. */
export function formatCountdown(seconds: unknown): string {
	const total = Math.max(0, Math.floor(Number(seconds) || 0));
	const pad = (value: number) => String(value).padStart(2, "0");
	return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60].map(pad).join(":");
}

/**
 * A short label for a raw context-window token count, matching the
 * catalog's own naming (`1M` / `200K` / `128K`).
 */
export function formatContextWindowForUi(tokens: unknown): string {
	const n = Number(tokens)
	if (!Number.isFinite(n) || n <= 0) return "";
	if (n >= 1000000) return `${Math.round(n / 1000000)}M`;
	if (n >= 1000) return `${Math.round(n / 1000)}K`;
	return String(n);
}

/**
 * A short label for a raw daily token count: 15441 → "15.4k", 1500000 → "1.5m".
 * Uses the same K/M style as `formatContextWindowForUi` but keeps one decimal
 * for precision (a daily total, not a model spec). Below 10 000 the comma
 * separator stays — 1 500 is more legible than 1.5k.
 */
export function formatTokenCount(n: unknown): string {
	const v = Math.max(0, Math.floor(Number(n) || 0));
	if (v >= 1_000_000) return `${abbr(v / 1_000_000)}m`;
	if (v >= 10_000) return `${abbr(v / 1_000)}k`;
	return v.toLocaleString("en-US");
}

/** Truncate one decimal without round-up: 999.999 → "999.9", 15.0 → "15". */
function abbr(x: number): string {
	const int = Math.floor(x);
	const dec = Math.floor((x - int) * 10);
	return dec === 0 ? String(int) : `${int}.${dec}`;
}

/**
 * The window label for one model row.
 *
 * The host already computes this — `contextWindowLabel` on every row it serves
 * — and this used to recompute it from `contextOptions` /
 * `defaultContextWindow`. The two copies had drifted: the host shows a label
 * only when upstream published BOTH a non-empty `contextOptions` and a
 * positive `defaultContextWindow`, while this one showed a label for any
 * non-empty `contextOptions` and fell back to the widest offered window. For a
 * model whose `context_config` lists windows but marks none as default, the
 * card showed a size and the picker showed none (test/card-host-parity.test.js
 * pins that state).
 *
 * So this reads the host's answer. The remaining local work is one thing the
 * host cannot do: the per-row toggle, which flips between the default and the
 * widest at click time, before any refresh has happened. Both choices are
 * therefore derived from the shipped `contextOptions` — and the guard is
 * deliberately the HOST's rule (a default must exist), not the old
 * options-only one, so the two screens cannot diverge again.
 */
export function windowLabelOf(model: CardModelRow, preferMax: boolean): string {
	const hostLabel = model.contextWindowLabel;
	const options = Array.isArray(model.contextOptions) ? model.contextOptions.filter((n): n is number => Number(n) > 0) : [];
	// Nothing offered, or nothing marked as the default: no label, which is the
	// host's `contextWindowIsReal` rule.
	if (options.length === 0 || !(Number(model.defaultContextWindow) > 0)) return "";
	// The toggled state, which no host field can express, is the widest offered
	// window; otherwise the host's own label already says it.
	if (preferMax) return formatContextWindowForUi(Math.max(...options.map(Number)));
	return typeof hostLabel === "string" ? hostLabel : formatContextWindowForUi(Number(model.defaultContextWindow));
}

/**
 * The multiplier that applies at `now`.
 *
 * Mirrors the host's resolution: `priceFactor` is Qoder's *discounted*
 * price, and `beforePromotionPriceFactor` is what applies outside the
 * window — the two are related by exactly `before x discount`. Reading
 * `priceFactor` alone understates the cost for most of the day.
 */
export function rateAt(model: CardModelRow, now: Date): number | undefined {
	const base = Number(model.priceFactor);
	const promo = model.promotion;
	if (promo === null || typeof promo !== "object") return Number.isFinite(base) ? base : undefined;
	const before = Number(promo.beforePromotionPriceFactor);
	const discount = Number(promo.discountFactor);
	const state = offPeakState(model, now);
	if (state?.active === true) {
		if (Number.isFinite(before) && Number.isFinite(discount)) return before * discount;
		return Number.isFinite(base) ? base : undefined;
	}
	if (Number.isFinite(before)) return before;
	return Number.isFinite(base) ? base : undefined;
}

/**
 * The one refresh verdict this card should show, from the host's report.
 *
 * The host sends `{ refreshedAt, refreshFailures }`; five outcomes, kept apart
 * on purpose:
 *
 * - **no failure** → `null`: the rows are the last upstream answer, and the
 *   "已更新（time）" stamp is honest.
 * - **a transient failure** (`fetch` / `credential` / `no-credential`) → the
 *   stamp still shows, marked stale: the rows on screen are real, just old.
 * - **`daily-limit`** → the rows are just as real, but retrying cannot help, so
 *   it names the allowance and its reset instead of reusing the stale wording
 *   (docs/issues/24).
 * - **`persist`** → the rows are the newest answer but the disk write was
 *   swallowed, so only their durability is wrong; it gets its own wording.
 * - **`protocol-shape-changed`** → the envelope moved and the plugin is out of
 *   date; the copy points at a plugin update, never at a re-sign.
 *
 * The protocol verdict wins over a transient one (it cannot resolve on its own);
 * `persist` and `daily-limit` each outrank a transient one.
 */
export function refreshNoticeKey(value: unknown): string | null {
	const failures = Array.isArray((value as { refreshFailures?: unknown } | null | undefined)?.refreshFailures) ? (value as { refreshFailures: unknown[] }).refreshFailures : [];
	if (failures.length === 0) return null;
	if (failures.some((f) => (f as { reason?: string } | null | undefined)?.reason === "protocol-shape-changed")) return "protocol-shape-changed";
	if (failures.some((f) => (f as { reason?: string } | null | undefined)?.reason === "persist")) return "persist";
	if (failures.some((f) => (f as { reason?: string } | null | undefined)?.reason === "daily-limit")) return "daily-limit";
	return "transient";
}

/**
 * The copy key for a region whose usage the host could not read.
 *
 * A protocol-shape change is NOT "try again later": only an update fixes it,
 * and a spent daily allowance cannot be retried either (docs/issues/24).
 * Reusing the generic "unavailable" wording would leave the user retrying a
 * read that cannot succeed — the same split `refreshNoticeKey` already makes
 * for the model list. A host older than the `unavailableReason` field degrades
 * to the old copy.
 */
export function usageUnavailableKey(entry: CardUsageRegion | null | undefined): string {
	if (entry?.unavailableReason === "protocol-shape-changed") return "usage.protocolChanged";
	if (entry?.unavailableReason === "daily-limit") return "usage.dailyLimit";
	return "usage.unavailable";
}

/**
 * The copy key for the offers line, when the campaigns read failed.
 *
 * Same split as {@link usageUnavailableKey}: a shape change needs the update
 * wording, a transport failure keeps the host's own reason. `null` means there
 * is nothing to say (no failure, or a rendered campaign wins over the note).
 */
export function campaignsNoticeKey(entry: CardUsageRegion | null | undefined): string | null {
	if (entry?.campaignsShapeChanged === true) return "usage.promotionsProtocolChanged";
	return typeof entry?.campaignsError === "string" && entry.campaignsError !== "" ? "usage.promotionsUnavailable" : null;
}

/**
 * The provider-registration failure the models envelope carried, or `null`.
 *
 * The card's half of the fact the host publishes on `QODER_STATUS_PATH`: since
 * docs/issues/20 a failed registration no longer unwinds activation, so every
 * card route mounts and the roster arrives normally.
 *
 * `null` covers BOTH "registration succeeded" and "this payload does not report
 * it" — a host from before this field sends no `providerRegistration` at all,
 * and inventing a warning out of a missing field would be the false-alarm twin
 * of the silent failure this closes. Only an explicit `{ ok: false }` warns.
 *
 * The name is never empty: a missing or non-string name narrows to `'Error'`.
 *
 * @param value - the parsed models payload.
 * @returns the host's non-empty error name, or `null` when there is nothing
 *   trustworthy to warn about.
 */
export function providerRegistrationFailure(value: unknown): string | null {
	const registration = (value as { providerRegistration?: unknown } | null | undefined)?.providerRegistration;
	if (registration === null || typeof registration !== "object") return null;
	const record = registration as { ok?: unknown; errorName?: unknown };
	if (record.ok !== false) return null;
	return typeof record.errorName === "string" && record.errorName !== "" ? record.errorName : "Error";
}

/**
 * What to say about a region's plugin-owned credential, or nothing at all.
 *
 * React-free on purpose: this is the whole decision table (which state means
 * which sentence, and which of them the user must act on) and it touches no DOM
 * and no React state, so it belongs here rather than inside the panel, where a
 * DOM test would be the only thing able to reach it.
 *
 * `undefined` means "say nothing", and it covers exactly one case: a host that
 * did not report a device entry at all. That is NOT the same as `none` — `none`
 * is the host stating that this machine has no plugin token, which is what the
 * sign-in button exists for. Collapsing them would put a "not signed in" claim
 * on a panel whose host never looked.
 *
 * An unrecognised state reads as unknown rather than falling through to a
 * reassuring sentence: a newer host that grew a state this build does not know
 * must not be rendered as `ok`.
 */
export function deviceLoginNotice(
	device: CardDeviceEntry | undefined,
): { key: string; kind: "note" | "error"; detail?: string } | undefined {
	if (device === undefined || device === null) return undefined;
	const reason = typeof device.reason === "string" ? device.reason : "";
	switch (device.state) {
		case "none":
			return { key: "device.state.none", kind: "note" };
		case "ok":
			return { key: "device.state.ok", kind: "note" };
		case "expired":
			return { key: "device.state.expired", kind: "error" };
		case "refresh-failed":
			return { key: "device.renewFailed", kind: "error", detail: reason };
		case "save-failed":
			// Renewed in hand, refused by the disk: the session works NOW and
			// dies at the next restart — a different sentence from both "ok"
			// and "renewal refused", and it must not be smoothed into either.
			return { key: "device.saveFailed", kind: "error", detail: reason };
		case "unreadable":
			return { key: "device.unreadable", kind: "error", detail: reason };
		default:
			return { key: "device.state.unknown", kind: "note" };
	}
}

/**
 * Whether the panel should offer to sign out of the plugin's own credential.
 *
 * True whenever a token exists in any form — including one that has expired or
 * whose renewal was refused. Those are exactly the states a user wants to be
 * able to clear: leaving them with only a "sign in again" button would strand a
 * token on disk that they can see and cannot remove.
 */
export function deviceLoginHasToken(device: CardDeviceEntry | undefined): boolean {
	return (
		device?.state === "ok" ||
		device?.state === "expired" ||
		device?.state === "refresh-failed" ||
		// The file on disk is stale but present: signing out of it is exactly
		// what the user can still do about a credential that will not survive.
		device?.state === "save-failed"
	);
}

/**
 * A readable description of a thrown value, for the card's `catch` blocks
 * that show a failure reason to the user.
 *
 * A catch binding is `unknown` (`useUnknownInCatchVariables`), so `.message`
 * is not readable without narrowing. The spelling this replaces —
 * `error instanceof Error ? error.message : String(error)` — leaves a
 * non-`Error` throw (a bare object, a rejection carrying only a code)
 * rendering as `[object Object]`, and a thrown `undefined` rendering as the
 * literal text `"undefined"`: a failure message that says nothing at all.
 *
 * This is the ONE client-side copy: `card.tsx`, both panels and `controller.ts`
 * (whose private twin was merged into this one) all import it. It is still a
 * deliberate LOCAL copy of `host/errors.ts#describeThrown`. The card is a
 * separate bundle built by `scripts/build-client.mjs`, and no client file
 * imports from `src/host/`, so sharing one implementation would mean either
 * bundling host code into the browser card or hoisting this helper into the
 * generated `lib/client.js`. Two lines of narrowing against a stable language
 * rule is worth less than that coupling.
 */
export function describeThrown(error: unknown): string {
	const message = (error as { message?: unknown } | null | undefined)?.message;
	if (typeof message === "string" && message !== "") return message;
	if (typeof error === "string") return error;
	return String(error);
}
