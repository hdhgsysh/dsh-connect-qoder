/**
 * The plugin's own sign-in, for the selected edition.
 *
 * This is the card half of the third credential source: the plugin's own
 * refreshable token, obtained by approving a code in a browser, for the machines
 * where there is no Qoder desktop client to read a login out of. It is reported
 * BESIDE the account row's state, never merged into it — the application's
 * sign-in and the plugin's token are two credentials with two lifetimes, and a
 * region can be signed out of the application while this token works fine.
 *
 * Two components, deliberately:
 *
 * - the outer gate calls NO hooks, so it can return `null` before any state
 *   exists (the `composer-usage-pill.tsx` pattern, and for the same reason: an
 *   early return above a hook changes the hook count between renders).
 * - the inner component holds every hook and is only mounted once there is a
 *   region and a `device` entry to talk about.
 *
 * Absent `device` means the host did not report one — a build older than the
 * routes below. It renders NOTHING rather than "not signed in", because that
 * sentence would be a claim this card cannot make.
 *
 * Every failure names itself. The start POST, each poll, and the sign-out each
 * carry the host's own reason into a paragraph, and the waiting state keeps a
 * plain link to the authorization page for the case where the popup was blocked.
 * A sign-in button that quietly does nothing is the exact shape this repo's
 * first red line forbids.
 */
import * as react from "react"
import type { CardDeviceEntry, TranslateFn } from "./card-model.ts"
import { describeThrown, deviceLoginHasToken, deviceLoginNotice } from "./card-model.ts"
import {
	QODER_DEVICE_LOGIN_CANCEL_PATH,
	QODER_DEVICE_LOGIN_POLL_PATH,
	QODER_DEVICE_LOGIN_SIGNOUT_PATH,
	QODER_DEVICE_LOGIN_START_PATH,
} from "./paths.ts"
import { getJson, postJson } from "./http.ts"

/** How often a pending approval is checked. The host's own attempt lives 5 minutes. */
const POLL_MS = 2000

/** Props for {@link QoderDeviceLoginPanel}. */
interface QoderDeviceLoginPanelProps {
	t: TranslateFn
	/** The edition this block acts on. Nothing renders without one. */
	region?: string | undefined
	/** What the account route reported for that edition's plugin token. */
	device?: CardDeviceEntry | undefined
	/** Called once a sign-in or sign-out has landed, so the account panel re-reads. */
	onChanged?: (() => void) | undefined
}

/** Which of the three requests is in flight, if any. */
type Busy = "idle" | "starting" | "waiting" | "signing-out"

/**
 * The gate. No hooks here, so returning `null` is safe.
 *
 * `region` is required as well as `device`: the three routes below are all
 * addressed by region, and a block with a button that cannot name its target
 * would be worse than no block.
 */
function QoderDeviceLoginPanel({ t, region, device, onChanged }: QoderDeviceLoginPanelProps) {
	if (region === undefined || device === undefined) return null
	return <ActiveDeviceLogin t={t} region={region} device={device} onChanged={onChanged} />
}

function ActiveDeviceLogin({
	t,
	region,
	device,
	onChanged,
}: {
	t: TranslateFn
	region: string
	device: CardDeviceEntry
	onChanged?: (() => void) | undefined
}) {
	const [busy, setBusy] = react.useState<Busy>("idle")
	const [authUrl, setAuthUrl] = react.useState<string | undefined>(undefined)
	const [problem, setProblem] = react.useState<string | undefined>(undefined)

	// `t` and `onChanged` both arrive as fresh closures from the parent, and the
	// poll effect below must NOT list them: restarting a two-second timer on
	// every parent render (a keystroke in the model search box is enough) would
	// both reset the countdown forever and fire overlapping requests. Held in
	// refs instead, which is what the effect actually needs — the latest values,
	// not a new subscription.
	const translate = react.useRef(t)
	translate.current = t
	const changed = react.useRef(onChanged)
	changed.current = onChanged

	// Read at unmount only, so the cleanup can abandon an attempt without being
	// re-subscribed on every state change.
	const live = react.useRef({ busy, region })
	live.current = { busy, region }

	react.useEffect(() => {
		// Unmount only: a teardown while still waiting leaves the host holding an
		// approval nobody is watching for, so the attempt is abandoned. The write
		// is best-effort on purpose — the panel is gone, there is nobody left to
		// tell, and the host's own five-minute TTL is the backstop. A busy flip
		// (authorized, failed, expired) must NOT cancel: those attempts are already
		// gone on the host side, or were never going to be approved.
		return () => {
			const current = live.current
			if (current.busy !== "waiting") return
			void postJson(QODER_DEVICE_LOGIN_CANCEL_PATH, { region: current.region }).catch((): undefined => undefined)
		}
	}, [])

	// One poll in flight at a time, chained rather than interval-driven: a slow
	// answer must delay the next check, not stack up behind it. The loop dies
	// with the attempt (`busy` leaves `waiting`) or with the region switch.
	react.useEffect(() => {
		if (busy !== "waiting") return
		let alive = true
		let timer: number | undefined
		const tick = async (): Promise<void> => {
			try {
				const value = await getJson<{ state?: unknown; reason?: unknown }>(
					`${QODER_DEVICE_LOGIN_POLL_PATH}?region=${encodeURIComponent(region)}`,
				)
				if (!alive) return
				const state = typeof value?.state === "string" ? value.state : ""
				if (state === "pending") {
					// Still waiting for the approval: the only state that loops.
				} else if (state === "authorized") {
					setBusy("idle")
					setAuthUrl(undefined)
					setProblem(undefined)
					changed.current?.()
					return
				} else if (state === "expired") {
					setBusy("idle")
					setAuthUrl(undefined)
					setProblem(translate.current("device.loginExpired"))
					return
				} else if (state === "idle") {
					// The host has no attempt for this region any more — the card is
					// polling something that is gone. Distinct from `expired`, which is
					// the one worth a sentence about the clock.
					setBusy("idle")
					setAuthUrl(undefined)
					setProblem(translate.current("device.loginLost"))
					return
				} else {
					const reason = typeof value?.reason === "string" ? value.reason : "";
					setBusy("idle")
					setAuthUrl(undefined)
					setProblem(translate.current("device.loginFailed", { reason }))
					return
				}
			} catch (error) {
				if (!alive) return
				setBusy("idle")
				setAuthUrl(undefined)
				setProblem(translate.current("device.loginFailed", { reason: describeThrown(error) }))
				return
			}
			timer = window.setTimeout(() => {
				void tick()
			}, POLL_MS)
		}
		void tick()
		return () => {
			alive = false
			if (timer !== undefined) window.clearTimeout(timer)
		}
	}, [busy, region])

	const start = react.useCallback(async (): Promise<void> => {
		setBusy("starting")
		setProblem(undefined)
		try {
			const value = await postJson<{ authUrl?: unknown }>(QODER_DEVICE_LOGIN_START_PATH, { region })
			const url = typeof value?.authUrl === "string" ? value.authUrl : "";
			// A 200 without a URL is not a started sign-in. Treating it as one would
			// leave the panel "waiting" for a browser tab that never opened.
			if (url === "") throw new Error(translate.current("device.startFailed", { detail: "" }));
			setAuthUrl(url)
			setBusy("waiting")
			window.open(url, "_blank", "noopener,noreferrer")
		} catch (error) {
			setBusy("idle")
			setProblem(translate.current("device.startFailed", { detail: describeThrown(error) }))
		}
	}, [region])

	const signOut = react.useCallback(async (): Promise<void> => {
		setBusy("signing-out")
		setProblem(undefined)
		try {
			await postJson(QODER_DEVICE_LOGIN_SIGNOUT_PATH, { region })
			setBusy("idle")
			changed.current?.()
		} catch (error) {
			// The host refuses this with a 500 when the file is still on disk, and
			// that refusal has to read as a failure: a cheerful "signed out" over a
			// token the next request would pick straight back up is a false
			// confirmation, not a convenience.
			setBusy("idle")
			setProblem(translate.current("device.signOutFailed", { detail: describeThrown(error) }))
		}
	}, [region])

	const notice = deviceLoginNotice(device)
	// Unreachable via the gate, but `deviceLoginNotice` returning `undefined` is
	// the "say nothing" answer, and honouring it here keeps that contract in one
	// place rather than assuming the gate covered it.
	if (notice === undefined) return null
	const hasToken = deviceLoginHasToken(device)
	const note = t(notice.key, { reason: notice.detail ?? "" })
	const busyLabel = busy === "starting" ? t("device.starting") : t("device.signIn")

	return (
		<div className="dsm-qoder-device">
			<div className="dsm-qoder-account-row">
				<span className="dsm-qoder-account-id">
					<span className="dsm-qoder-account-name">{t("device.title")}</span>
				</span>
				<span className="dsm-qoder-usage-spacer" />
				{/* Offered while `waiting` too: the popup may have been blocked, and this
				    button is then the only way back to the authorization page. */}
				<button
					type="button"
					className="dsm-qoder-button"
					disabled={busy === "starting" || busy === "signing-out"}
					onClick={() => {
						void start()
					}}
				>
					{busyLabel}
				</button>
				{hasToken ? (
					<button
						type="button"
						className="dsm-qoder-button"
						disabled={busy !== "idle"}
						onClick={() => {
							void signOut()
						}}
					>
						{busy === "signing-out" ? t("device.signingOut") : t("device.signOut")}
					</button>
				) : null}
			</div>
			<p className={`dsm-qoder-account-note${notice.kind === "error" ? " dsm-qoder-account-note-error" : ""}`}>
				{note}
			</p>
			{problem !== undefined ? (
				<p className="dsm-qoder-account-note dsm-qoder-account-note-error">{problem}</p>
			) : null}
			{busy === "waiting" ? (
				<p className="dsm-qoder-account-note">
					<span>{t("device.waiting")}</span>
					{authUrl !== undefined ? (
						<react.Fragment>
							{" · "}
							<a href={authUrl} target="_blank" rel="noreferrer" title={authUrl}>
								{t("device.reopen")}
							</a>
						</react.Fragment>
					) : null}
				</p>
			) : null}
			<p className="dsm-qoder-account-note">{hasToken ? t("device.signOutNote") : t("device.available")}</p>
		</div>
	)
}

export { QoderDeviceLoginPanel }
export type { QoderDeviceLoginPanelProps }
