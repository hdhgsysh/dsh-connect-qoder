/**
 * The account section container.
 *
 * The second of the two card containers that owns a `fetch` (the other is
 * `usage-panel.tsx`); both go through `./http.ts`. This panel renders TWO
 * siblings — the body's region strip and, directly below it, the framed card
 * for the SELECTED region's sign-in — and owns every account-side network call:
 * the account read, the re-read, the per-region confirm, and the provider
 * switch write. The strip is the card's convergence point; it lives ABOVE the
 * account frame because it switches the WHOLE body, not just the sign-in card
 * (the WorkBuddy layout this card is modelled on).
 *
 * `activeRegion` / `onRegionChange` are the card-level pair that drives all
 * three surfaces (account, usage, model list). `onReconciled` lets the card
 * re-pull its models and usage once a re-read or switch has landed.
 */
import * as react from "react"
import type { CardAccountEntry, TranslateFn, CheckboxEvent } from "./card-model.ts"
import { withDate, describeThrown, deviceLoginNotice, effectiveAccountStateOf, credentialChipOf } from "./card-model.ts"
import { QODER_ACCOUNT_PATH, QODER_ACCOUNT_RELOAD_PATH, QODER_ACCOUNT_CONFIRM_PATH } from "./paths.ts"
import { getJson, postJson } from "./http.ts"
import { writeSettingsField } from "./settings-write.ts"
import type { SettingsScope } from "./settings-write.ts"
import { QoderDeviceLoginPanel } from "./device-login-panel.tsx"

/** Props for {@link QoderAccountPanel}. */
interface QoderAccountPanelProps {
	t: TranslateFn
	onReconciled?: () => void
	settingsScope?: SettingsScope | undefined
	activeRegion?: string
	onRegionChange?: (regionId: string) => void
}

function QoderAccountPanel({ t, onReconciled, settingsScope, activeRegion = "qoder-cn", onRegionChange }: QoderAccountPanelProps) {
	const [accounts, setAccounts] = react.useState<CardAccountEntry[]>([]);
	const [status, setStatus] = react.useState("loading");
	const [reloading, setReloading] = react.useState(false);
	// One confirm outcome per region: `{ kind: "confirmed" |
	// "sign-in-expired" | "unavailable", detail? }`. Absent means
	// "not asked since the last re-read".
	const [confirmState, setConfirmState] = react.useState<Record<string, { kind?: string | undefined; detail?: string | undefined }>>({});
	const [confirmBusy, setConfirmBusy] = react.useState<Record<string, boolean>>({});
	// The per-region provider switch. The host answers with the fully
	// resolved map for every known region, so saving posts that whole
	// map back — a host-side per-region merge can never lose a
	// sibling region, and the scope-mirror fallback replaces a field
	// it always holds in full.
	const [enabledRegions, setEnabledRegions] = react.useState<Record<string, boolean>>({});
	const [toggling, setToggling] = react.useState(false);
	const [offerError, setOfferError] = react.useState<string | undefined>(undefined);
	const mounted = react.useRef(true);
	react.useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	// Guards the account read against its own earlier response, the way
	// `usage-panel.tsx` already does. `load` has two concurrent entry points —
	// the mount effect and `reload()` (which the tab strip can trigger again
	// while the first read is still out) — and without a sequence number the
	// later-started read can be overtaken by the older one, leaving the panel
	// showing a snapshot that the newer response had already replaced.
	const loadSeq = react.useRef(0);
	const [loadError, setLoadError] = react.useState<string | undefined>(undefined);
	const load = react.useCallback(async () => {
		const seq = ++loadSeq.current;
		try {
			const value = await getJson<{ regions?: unknown; enabledRegions?: unknown }>(QODER_ACCOUNT_PATH);
			if (!mounted.current || seq !== loadSeq.current) return;
			const regions = Array.isArray(value.regions) ? (value.regions as CardAccountEntry[]) : [];
			setAccounts(regions);
			// Prefer the host-resolved map; fall back to each region's
			// own `enabled` flag so an older host that predates the
			// map still drives the switch (absent = offered).
			const map = value.enabledRegions !== null && typeof value.enabledRegions === "object" ? (value.enabledRegions as Record<string, boolean>) : Object.fromEntries(regions.filter((entry) => entry.region !== undefined).map((entry) => [entry.region as string, entry.enabled !== false]));
			setEnabledRegions(map);
			setStatus("ready");
			setLoadError(undefined);
		} catch (error) {
			if (!mounted.current || seq !== loadSeq.current) return;
			// Keep the host's own wording. `http.ts` goes out of its way to throw
			// the host's `error` field rather than a bare status ("origin-not-trusted"
			// and "loopback-…" are the two that actually happen), and swallowing it
			// here left the panel saying only "could not read" — the exact
			// failure-that-does-not-say-why class red line 1 names. `describeThrown`
			// is what the rest of this file already uses for the same job.
			setLoadError(describeThrown(error));
			setStatus("error");
		}
	}, []);
	react.useEffect(() => {
		void load();
	}, [load]);
	const reload = react.useCallback(async () => {
		setReloading(true);
		try {
			// The re-read only adds: drop the cached credential, refresh the
			// catalog, and start any region that looks signed-out.
			await postJson(QODER_ACCOUNT_RELOAD_PATH, {});
			if (!mounted.current) return;
			// The re-read just changed what is true on disk: drop the
			// confirm outcomes (they were answered against the old
			// credential) and let the card reconcile its models and
			// usage with the fresh state.
			setConfirmState({});
			if (onReconciled !== void 0) onReconciled();
			await load();
		} catch {
			if (mounted.current) setStatus("error");
		} finally {
			if (mounted.current) setReloading(false);
		}
	}, [load, onReconciled]);
	// WorkBuddy parity: the tab strip (rendered above the account frame)
	// is the body's whole header — no title row, no re-read button to
	// save. The re-read therefore has to find its own moment, and the
	// dots say when that is. The
	// opening GET already re-reads every store from disk, so the POST
	// only adds: drop the cached credential, refresh the catalog, and
	// start any region that looks signed-out. Once per open is enough;
	// selecting a still-bad tab (below) covers the "I just signed in
	// while the card was open" case.
	const autoReloaded = react.useRef(false);
	react.useEffect(() => {
		if (status !== "ready" || autoReloaded.current) return;
		// A re-read can only find what the DESKTOP stores hold, so the question
		// it asks is about the desktop sign-in and nothing else. A region whose
		// desktop sign-in is not `ok` may have gained one since the plugin
		// started (the user signed in to the app while it was running), and that
		// is what this pick-up is for. The plugin's own credential is not
		// affected by a re-read — it changes nothing here — so it must not
		// stand in for the desktop's answer and suppress the pick-up: a Windows
		// user who signs in to the desktop app afterwards would never see it.
		if (!accounts.some((entry) => entry.state !== "ok")) return;
		autoReloaded.current = true;
		void reload();
	}, [status, accounts, reload]);
	const confirm = react.useCallback(async (regionId: string) => {
		setConfirmBusy((current) => ({ ...current, [regionId]: true }));
		setConfirmState((current) => {
			const next = { ...current };
			delete next[regionId];
			return next;
		});
		try {
			const value = await postJson<{ available?: unknown; confirmed?: unknown; kind?: string | undefined; detail?: string | undefined }>(QODER_ACCOUNT_CONFIRM_PATH, { region: regionId });
			if (!mounted.current) return;
			if (value.available !== true) {
				// The host may know WHY the confirmation could not run — a
				// credential that threw while it was being read, or the absence
				// of any sign-in to check. Dropping that reason is what left the
				// card showing "Could not confirm: " with nothing after it: the
				// failure-that-does-not-say-why shape red line 1 forbids. A
				// host that reports no reason at all gets its own verdict, so
				// the card can say WHICH of the two it was.
				const detail = typeof value.detail === "string" && value.detail !== "" ? value.detail : undefined;
				setConfirmState((current) => ({
					...current,
					[regionId]: { kind: detail === undefined ? "no-sign-in" : "unavailable", detail },
				}));
				return;
			}
			setConfirmState((current) => ({
				...current,
				[regionId]: value.confirmed === true ? {
					kind: "confirmed"
				} : {
					kind: value.kind,
					detail: value.detail
				}
			}));
		} catch (error) {
			if (!mounted.current) return;
			setConfirmState((current) => ({
				...current,
				[regionId]: {
					kind: "unavailable",
					detail: describeThrown(error)
				}
			}));
		} finally {
			if (mounted.current) setConfirmBusy((current) => ({ ...current, [regionId]: false }));
		}
	}, []);
	// Flip one region's provider switch. The save goes through the
	// settings pipeline (host endpoint first, scope mirror second) with
	// the COMPLETE map, exactly like the model-section saves: a host
	// that merges per region cannot lose the sibling, and a host that
	// replaces the field is given the whole thing. On success the card
	// reconciles (models + usage) and re-reads the account panel, so
	// the switch settles on the authoritative state rather than an
	// optimistic guess; on failure the switch reverts and the reason
	// is shown instead of a silent no-op.
	const toggleRegion = react.useCallback(async (regionId: string, nextOn: boolean) => {
		setToggling(true);
		setOfferError(undefined);
		const next = { ...enabledRegions, [regionId]: nextOn };
		setEnabledRegions(next);
		try {
			if (settingsScope === void 0) throw new Error("settings service unavailable");
			await writeSettingsField(settingsScope, "enabledRegions", next);
			if (onReconciled !== void 0) onReconciled();
			await load();
		} catch (error) {
			setEnabledRegions((current) => ({ ...current, [regionId]: !nextOn }));
			if (mounted.current) setOfferError(describeThrown(error));
		} finally {
			if (mounted.current) setToggling(false);
		}
	}, [enabledRegions, settingsScope, onReconciled, load]);
	// Tone per state: `ok` is green, a lapsed or unreadable sign-in is
	// red or amber, and "not installed" stays neutral — the absence of
	// an app is not a fault of this machine. The same tones drive the
	// status dots on the region strip.
	const dotClassOf = (state: string | undefined) => state === "ok" || state === "device" ? " dsm-qoder-region-dot-ok" : state === "expired" ? " dsm-qoder-region-dot-expired" : state === "needs-app" ? " dsm-qoder-region-dot-needs" : "";
	// Whether the DESKTOP application's credential is the one serving this
	// region, and the EFFECTIVE sign-in state of one region.
	//
	// The host reports the desktop application's sign-in in `state` and the
	// plugin's own credential in `device`, and it deliberately does not merge
	// them (see `account-payload.ts`): two credentials, two lifetimes. The
	// host resolves them in one order — the desktop store, then the plugin's
	// own, then the PAT (see `credential-cache.ts`) — and the card has to
	// answer about the credential that order actually picks.
	//
	// The rules live in `card-model.ts` because they are decidable without a
	// DOM, and the host's own answer (`credentialKind`) is preferred over the
	// panel's inference: the host is the one that resolved the credential.
	const stateLabelOf = (entry: CardAccountEntry) => t(`account.state.${effectiveAccountStateOf(entry)}`);
	// The strip shows every known region; the detail below it shows
	// only the one the strip has selected. A selection that no longer
	// exists should not happen — the host always answers with both
	// regions — but it falls back to the first entry rather than
	// breaking the panel.
	const activeEntry = accounts.find((entry) => entry.region === activeRegion) ?? accounts[0];
	// `region` is optional on the entry, so it cannot be used as an index until
	// it is known to be a string. An entry with no region is not addressable in
	// the per-region maps at all, which is why the fallbacks below answer
	// "nothing recorded for it" rather than guessing a key.
	const activeRegionId = activeEntry?.region;
	// The label the four user-facing strings interpolate. Built once from the
	// two optional sources rather than repeated as `regionName ?? region` at
	// each site: that spelling is `string | undefined`, which the translation
	// helper does not accept, and a missing label must read as an empty string
	// rather than the word "undefined".
	const activeEdition = activeEntry?.regionName ?? activeRegionId ?? "";
	// Whether the card can actually OFFER the browser sign-in. The device
	// block renders nothing unless the host reported a `device` entry AND that
	// entry carries a state the card knows how to name — so a pointer at
	// "Sign in with a browser" has to be gated by the very same question the
	// block asks. Otherwise the copy points at a button that is not on the
	// screen: an older host that reports no `device` at all, or a newer one
	// whose state this build cannot read.
	const deviceSignInOffered = activeRegionId !== undefined && deviceLoginNotice(activeEntry?.device) !== undefined;
	// The state the CARD acts on for this region — the desktop application's
	// own state, unless the plugin's own credential is the sign-in in use.
	const activeEffectiveState = activeEntry !== undefined ? effectiveAccountStateOf(activeEntry) : "";
	// Whether the plugin's own credential is the sign-in in use here. It is a
	// different question from `deviceSignInOffered` (can the card offer a
	// browser sign-in?), and it is what makes this region signed in.
	const deviceActive = activeEntry?.device?.state === "ok";
	const activeOffered = activeEntry !== undefined && activeRegionId !== undefined && enabledRegions[activeRegionId] !== false;
	const activeResult = activeEntry !== undefined && activeRegionId !== undefined ? confirmState[activeRegionId] : undefined;
	// Bound once and tested once: `activeHasIdentity` is a boolean, so it cannot
	// narrow `activeEntry.identity` at the reads below. Holding the identity
	// itself is what lets the three later reads be checked rather than asserted.
	const activeIdentity = activeEntry?.identity ?? undefined;
	const activeHasIdentity = activeIdentity !== undefined && activeIdentity !== null;
	const activeName = activeHasIdentity ? String(activeIdentity.name ?? "").trim() : "";
	// The same three chips the old rows carried: credential source,
	// app name, and the sign-in's expiry date — now for one region.
	const activeMeta = [];
	if (activeEntry !== undefined) {
		// ONE source chip, for the credential that is actually serving this
		// region. Two of them at once ("from Qoder · from the plugin's own
		// sign-in") reads as a contradiction, and the second one is the truth
		// whenever the first names a credential the host could read but the
		// runtime does not use: the plugin's own credential is resolved BEFORE
		// the PAT and after a lapsed desktop one, so it is the credential
		// serving the region in exactly the cases where the desktop's own
		// state is not "ok".
		const chip = credentialChipOf(activeEntry);
		if (chip === "device") {
			activeMeta.push(t("account.deviceFrom"));
		} else if (chip === "env") {
			activeMeta.push(t("account.envPat"));
		} else if (chip === "app" && typeof activeEntry.appName === "string" && activeEntry.appName !== "") {
			activeMeta.push(t("account.appFrom", { app: activeEntry.appName }));
		}
		if (activeHasIdentity && Number(activeIdentity.expiresAt) > 0) activeMeta.push(withDate(t("account.expiresAt"), activeIdentity.expiresAt));
	}
	return (
		<react.Fragment>
			{/*
				The convergence point, now ABOVE the account card rather than
				inside its frame: one pill per region — status dot, name,
				provider switch — and selecting a pill scopes the sign-in
				detail, the usage panel and the model list to that region, so
				the region name appears exactly once on the card. The strip
				switches the WHOLE body, so it is the body's header, matching
				the WorkBuddy layout it was modelled on; it is hidden on a
				read failure, whose own retry stays in the card below.
			*/}
			{status !== "error" ? (
				<div className="dsm-qoder-region-tabs" role="tablist" aria-label={t("account.regionTabs")}>
					{accounts.map((entry) => {
						// A region-less entry is not addressable: it has no
						// key in `enabledRegions`, nothing to select, and
						// nothing to pass to `onRegionChange`. The host
						// always names one, so this narrows the type at the
						// render boundary instead of asserting it, and an
						// unnamed entry is skipped rather than rendered as a
						// tab that cannot work.
						const regionId = entry.region;
						if (regionId === undefined) return null;
						// Provider switch state. The local map is the source
						// of truth for the switch (it settles on the host
						// value after each save); a region with no key yet
						// reads as offered, the same default the host
						// predicate uses.
						const offered = enabledRegions[regionId] !== false;
						const isActive = regionId === activeRegion;
						return (
							<div
								key={`tab:${regionId}`}
								className={`dsm-qoder-region-tab-cell${isActive ? " dsm-qoder-region-tab-cell-active" : ""}`}
							>
								<button
									type="button"
									role="tab"
									aria-selected={isActive}
									className={`dsm-qoder-region-tab${offered ? "" : " dsm-qoder-region-tab-off"}`}
									title={`${entry.regionName ?? regionId} · ${stateLabelOf(entry)}`}
									onClick={() => {
										if (typeof onRegionChange === "function") onRegionChange(regionId);
										// Choosing a region whose DESKTOP sign-in is not
										// ok is also the moment the user may have just
										// signed in over there: run the pick-up for it,
										// dots included.
										//
										// The question is the DESKTOP one, not "is this region
										// signed in somehow": a re-read reads the desktop store,
										// so it can only ever change the desktop answer. A region
										// signed in through the plugin's own credential still
										// deserves the pick-up — the user may have signed in to
										// the desktop app as well, and that is the credential the
										// card would report afterwards.
										if (entry.state !== "ok") void reload();
									}}
								>
								<span aria-hidden="true" className={`dsm-qoder-region-dot${dotClassOf(effectiveAccountStateOf(entry))}`} />
								<span className="dsm-qoder-region-name">{entry.regionName ?? regionId}</span>
							</button>
							{/* No switch here any more. The pill used to carry
							    one beside the tab button with no text of its
							    own, so the two halves looked like one control
							    while doing opposite things: the name switched
							    the view, the switch wrote a setting that drops
							    the whole edition from DSH's model picker — and
							    the only thing saying which was which was a
							    tooltip a touch user never sees. The switch is
							    now in the account card below, labelled. The
							    pill is a tab and nothing else; `offered` still
							    dims the name so a disabled edition reads as
							    disabled at a glance. */}
						</div>
						);
					})}
				</div>
			) : null}
			<div className="dsm-qoder-account">
				{status === "error" ? (
					// A failure says so with its own retry inside the card,
					// rather than a button that is otherwise redundant.
					//
					// The reason is appended when the host supplied one, so the
					// reader can tell "the loopback origin was refused" from "the
					// panel and the host are not talking at all" — a distinction
					// this paragraph used to flatten into one sentence.
					<div className="dsm-qoder-account-error">
						<p className="dsm-qoder-error">{loadError === void 0 ? t("account.error") : `${t("account.error")} (${loadError})`}</p>
						<button
							type="button"
							className="dsm-qoder-button"
							disabled={reloading}
							onClick={() => {
								void reload();
							}}
						>
							{t("account.reload")}
						</button>
					</div>
				) : (
					<react.Fragment>
						{/* The selected region's sign-in: who it is, where the
						    credential comes from, and what to do when it is not
						    `ok`. */}
						{activeEntry !== undefined ? (
							<react.Fragment>
								<div className={`dsm-qoder-account-row${activeOffered ? "" : " dsm-qoder-account-row-off"}`}>
									<span className="dsm-qoder-account-id">
										<span className="dsm-qoder-account-name">
											{activeName !== "" ? activeName : "—"}
										</span>
										{activeMeta.length > 0 ? (
											<span className="dsm-qoder-account-meta">{activeMeta.join(" · ")}</span>
										) : null}
									</span>
								<span className="dsm-qoder-usage-spacer" />
								{/* The provider switch, moved out of the region
								    pill: it belongs to the edition whose
								    sign-in is on this line, and it now carries
								    a visible label so "启用此版本" says what
								    flipping it does. It still writes straight
								    away (the COMPLETE map, so a sibling
								    edition can never be lost) and still
								    reverts with the reason if the host
								    refuses — see `toggleRegion`. */}
								{activeRegionId !== undefined ? (
									<label className="dsm-qoder-switch" title={t("account.offerTitle")}>
										<input
											type="checkbox"
											className="dsm-qoder-offer-toggle"
											checked={activeOffered}
											disabled={toggling}
											aria-label={`${t("account.offer")}: ${activeEdition}`}
											onChange={(event: CheckboxEvent) => {
												void toggleRegion(activeRegionId, event.target.checked);
											}}
										/>
										<span>{t("account.offer")}</span>
									</label>
								) : null}
								{/* The confirmation is offered for every region that HAS a
							    sign-in to check — including one that only has the
							    plugin's own credential, which the host reports
							    beside the desktop sign-in rather than as the
							    region's `source`. Gating on `source` alone left
							    every browser-only user without the button, even
							    though the host can check that sign-in perfectly
							    well. */}
							{(activeEntry.source !== undefined || deviceActive) && activeRegionId !== undefined ? (
										<button
											type="button"
											className="dsm-qoder-button"
											disabled={confirmBusy[activeRegionId] === true}
											onClick={() => {
												void confirm(activeRegionId);
											}}
										>
											{confirmBusy[activeRegionId] === true ? t("account.confirming") : t("account.confirm")}
										</button>
									) : null}
								</div>
								{!activeOffered ? (
									<p className="dsm-qoder-account-note">{t("account.offerOff")}</p>
								) : null}
								{/* The plugin's own credential is the sign-in in use: the
							    desktop application's state is a separate account
							    (two credentials, two lifetimes), and on a machine
							    that cannot read the desktop store it must not
							    be reported as "unreadable" next to "signed in
							    to the plugin". One sentence says which credential
							    is serving this region. */}
							{activeEffectiveState === "device" ? (
								<p className="dsm-qoder-account-note">{t("account.deviceActive")}</p>
							) : null}
							{activeEffectiveState === "needs-app" ? (
									<p className="dsm-qoder-account-note dsm-qoder-account-note-error">
										{t(
											// Where the browser sign-in is on the card, it leads: it is
											// the one way in that works on EVERY platform, desktop
											// client or not — which is the whole point of the plugin
											// holding a credential of its own. A host that reports
											// no `device` entry has no such button, and gets the
											// PAT-only wording instead of a dangling pointer.
											deviceSignInOffered ? "account.readFailDevice" : "account.readFail",
											{ detail: activeEntry.detail ?? "" },
										)}
									</p>
								) : null}
								{/* The desktop application's own session, and only
							    while it is the one this region is running on. When
							    the plugin's own credential is in use, "open the
							    client and sign in again" is advice about a path
							    that is not this region's sign-in — the same class
							    of dead-end advice this card already avoids. */}
							{activeEffectiveState === "expired" ? (
									<p className="dsm-qoder-account-note">
										<span>
											{t("account.expiredHint", {
												app: activeEntry.appName ?? activeEntry.regionName ?? "Qoder",
											})}
										</span>
										<br />
										<span>
											{t("account.download", { edition: activeEdition })}
											{typeof activeEntry.downloadUrl === "string" && activeEntry.downloadUrl !== "" ? (
												<react.Fragment>
													{" · "}
													<a
														href={activeEntry.downloadUrl}
														target="_blank"
														rel="noreferrer"
														title={activeEntry.downloadUrl}
													>
														{t("account.downloadLink", { edition: activeEdition })}
													</a>
												</react.Fragment>
											) : null}
										</span>
									</p>
								) : null}
								{activeEffectiveState === "signed-out" ? (
									<p className="dsm-qoder-account-note">
										<span>{t("account.unsigned")}</span>
										<br />
										<span>
											{t("account.download", { edition: activeEdition })}
											{typeof activeEntry.downloadUrl === "string" && activeEntry.downloadUrl !== "" ? (
												<react.Fragment>
													{" · "}
													<a
														href={activeEntry.downloadUrl}
														target="_blank"
														rel="noreferrer"
														title={activeEntry.downloadUrl}
													>
														{t("account.downloadLink", { edition: activeEdition })}
													</a>
												</react.Fragment>
											) : null}
										</span>
									</p>
								) : null}
								{activeResult?.kind === "confirmed" ? (
									<p className="dsm-qoder-account-note">{t("account.confirmed")}</p>
								) : null}
								{activeResult?.kind === "sign-in-expired" ? (
									<p className="dsm-qoder-account-note dsm-qoder-account-note-error">
										{t("account.confirmExpired")}
									</p>
								) : null}
								{activeResult?.kind === "protocol-shape-changed" ? (
									<p className="dsm-qoder-account-note dsm-qoder-account-note-error">
										{t("account.confirmProtocolChanged")}
									</p>
								) : null}
								{activeResult?.kind === "unavailable" ? (
									<p className="dsm-qoder-account-note dsm-qoder-account-note-error">
										{t("account.confirmFailed", { detail: activeResult.detail ?? "" })}
									</p>
								) : null}
								{/* The host had nothing to confirm — no sign-in at all for this
								    edition. That is its own verdict, not a failure with an
								    empty reason: the card says so in its own words instead
								    of trailing a colon after nothing. */}
								{activeResult?.kind === "no-sign-in" ? (
									<p className="dsm-qoder-account-note dsm-qoder-account-note-error">
										{t("account.confirmNoSignIn")}
									</p>
								) : null}
								{/* The plugin's own credential, for the machines with no desktop
								    client to read a login out of. It renders nothing when the
								    host reported no `device` entry at all (an older build), which
								    is why it is a separate component rather than three more
								    conditionals here. Both reads go out on a change: the account
								    route's own `device` state, and — through `onReconciled` — the
								    model roster and usage, since gaining a credential can make an
								    edition that resolved nothing before resolve now. */}
								<QoderDeviceLoginPanel
									t={t}
									region={activeRegionId}
									device={activeEntry.device}
									onChanged={() => {
										void reload();
										onReconciled?.();
									}}
								/>
							</react.Fragment>
						) : null}
					</react.Fragment>
				)}
				{offerError !== undefined ? (
					<p className="dsm-qoder-account-note dsm-qoder-account-note-error">
						{t("account.offerError", { detail: offerError })}
					</p>
				) : null}
			</div>
		</react.Fragment>
	);
}

export { QoderAccountPanel }
export type { QoderAccountPanelProps }
