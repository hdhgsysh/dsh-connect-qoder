window.__ModuleLoader__.load({
	id: "dsh-connect-qoder",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		//#region src/client/paths.ts
		/** Plugin-owned read-only model route the card renders its rows from. */
		const QODER_MODELS_PATH = "/plugins/dsh-connect-qoder/models";
		/** Plugin-owned read-only usage route the panel renders its quotas from. */
		const QODER_USAGE_PATH = "/plugins/dsh-connect-qoder/usage";
		//#endregion

		//#region src/client/styles.ts
		/**
		 * Card styles, injected once into the page head.
		 *
		 * The card frame (`dsm-plugin-card` and its header/body parts) follows
		 * the dsh-connect-* sibling convention — WorkBuddy's card — so every
		 * connect plugin in the settings list reads as one family. Those rules
		 * are COPIED here rather than borrowed: the host defines no `dsm-*`
		 * class at all (its own chrome is hashed CSS modules), so without this
		 * block the frame silently depends on whichever sibling plugin happens
		 * to be installed, and uninstalling it would strip the border, header
		 * and caret. The copy is byte-identical to WorkBuddy's on purpose, so
		 * both plugins render the same even when loaded together.
		 *
		 * Every colour is a theme token with a literal fallback, so the card
		 * follows the active theme instead of pinning one.
		 */
		const QODER_CARD_CSS = [
			// --- Card frame, copied from dsh-connect-workbuddy's card block ---
			".dsm-plugin-card{border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-3,#202126);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}",
			".dsm-plugin-card:hover{border-color:var(--dsw-alias-label-dimmed,#777)}",
			".dsm-plugin-card-open{background:var(--dsw-alias-bg-layer-2,#25262b);border-color:var(--dsw-alias-label-dimmed,#777)}",
			".dsm-plugin-card-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
			".dsm-plugin-card-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:-2px}",
			".dsm-plugin-card-head{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
			".dsm-plugin-card-title{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:15px;font-weight:600;line-height:1.4}",
			".dsm-plugin-card-description{color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5}",
			// Pure-CSS caret (WorkBuddy's rationale, verbatim): the host
			// primitives' chevron icon names differ per DSH line (0.1.5
			// Outline14 vs 0.1.7 OutlineRegular), so no static import can serve
			// both. A border caret in the plugin's own CSS is version-proof.
			".dsm-plugin-card-chevron{color:var(--dsw-alias-label-tertiary,#999);flex:none;width:16px;height:16px;position:relative;transition:transform .16s}",
			".dsm-plugin-card-chevron::before{content:\"\";display:block;position:absolute;left:4px;top:5px;width:7px;height:7px;border-right:1.6px solid currentColor;border-bottom:1.6px solid currentColor;transform:rotate(45deg)}",
			".dsm-plugin-card-chevron-open{transform:rotate(180deg)}",
			".dsm-plugin-card-body{border-top:1px solid var(--dsw-alias-border-l2,#36373b);margin:0 16px;padding:0 0 8px}",
			".dsm-plugin-card-icon{width:32px;height:32px;flex:none;border-radius:7px}",
			// --- Card body, owned by this plugin ---
			".dsm-qoder-body{padding:12px 14px;display:flex;flex-direction:column;gap:12px}",
			".dsm-qoder-hint{margin:0;color:var(--dsw-alias-label-primary,#1a1a1a);font-size:12px;line-height:1.6}",
			".dsm-qoder-switch{display:flex;align-items:center;gap:8px;font-size:13px}",
			".dsm-qoder-models{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;max-height:320px;overflow:auto}",
			".dsm-qoder-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px}",
			".dsm-qoder-row-main{display:flex;align-items:center;gap:8px;min-width:0}",
			".dsm-qoder-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsm-qoder-badge{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#36373b);color:var(--dsw-alias-label-primary,#1a1a1a);white-space:nowrap}",
			".dsm-qoder-select{font-size:12px;padding:3px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-3,#202126);color:inherit;border:1px solid var(--dsw-alias-border-l2,#36373b)}",
			".dsm-qoder-state{margin:0;font-size:12px;color:var(--dsw-alias-label-primary,#1a1a1a)}",
			".dsm-qoder-error{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary,#d92d20)}",
			".dsm-qoder-tabs{display:flex;gap:6px}",
			".dsm-qoder-tab{font-size:12px;padding:4px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#36373b);background:transparent;color:inherit;cursor:pointer}",
			".dsm-qoder-tab-active{background:var(--dsw-alias-bg-layer-3,#202126)}",
			".dsm-qoder-actions{display:flex;gap:8px}",
			".dsm-qoder-button{font-size:12px;padding:5px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#36373b);background:transparent;color:inherit;cursor:pointer}",
			".dsm-qoder-button:disabled{opacity:.5;cursor:default}",
			// Usage panel. Mirrors the Qoder IDE's own "我的用量" card: a titled
			// block per quota, each with a filled bar and a used/total line.
			".dsm-qoder-usage{border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:12px}",
			".dsm-qoder-usage-head{display:flex;align-items:center;justify-content:space-between;gap:8px}",
			".dsm-qoder-usage-title{margin:0;font-size:13px;font-weight:600}",
			".dsm-qoder-usage-region{font-size:11px;color:var(--dsw-alias-label-primary,#1a1a1a)}",
			".dsm-qoder-usage-block{display:flex;flex-direction:column;gap:6px}",
			".dsm-qoder-usage-label{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px}",
			".dsm-qoder-usage-when{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-primary,#1a1a1a);white-space:nowrap}",
			".dsm-qoder-bar{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,#202126);overflow:hidden}",
			".dsm-qoder-bar-fill{height:100%;border-radius:999px;background:var(--dsw-alias-label-primary,#e8eaed);transition:width .3s ease}",
			".dsm-qoder-bar-warn{background:var(--dsw-alias-state-warning-primary,#f79009)}",
			".dsm-qoder-bar-full{background:var(--dsw-alias-state-error-primary,#d92d20)}",
			".dsm-qoder-usage-figures{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:12px;color:var(--dsw-alias-label-primary,#1a1a1a)}",
			".dsm-qoder-usage-figures strong{color:inherit;font-weight:500}",
			".dsm-qoder-usage-badge{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#36373b);color:var(--dsw-alias-label-primary,#1a1a1a);white-space:nowrap}",
			".dsm-qoder-usage-badge-offer{border-color:var(--dsw-alias-state-success-primary,#12b76a);color:var(--dsw-alias-state-success-primary,#12b76a)}",
			".dsm-qoder-usage-promo{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-primary,#1a1a1a)}",
			".dsm-qoder-usage-promo a{color:inherit}",
			".dsm-qoder-usage-sep{height:1px;background:var(--dsw-alias-border-l2,#36373b);margin:0}",
			".dsm-qoder-usage-spacer{flex:1}",
			// Model row: a picker-visibility checkbox on the left, the name and its
			// rate in the middle, the image choice on the right.
			".dsm-qoder-pick{display:flex;align-items:center;gap:6px;flex:0 0 auto}",
			".dsm-qoder-rate{font-size:11px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#36373b);color:var(--dsw-alias-label-primary,#1a1a1a);white-space:nowrap;font-variant-numeric:tabular-nums}",
			".dsm-qoder-rate-free{border-color:var(--dsw-alias-state-success-primary,#12b76a);color:var(--dsw-alias-state-success-primary,#12b76a)}",
			".dsm-qoder-row-off .dsm-qoder-name{opacity:.55}",
			".dsm-qoder-models-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".dsm-qoder-models-head .dsm-qoder-state{margin-left:auto}",
			// Filter bar: region tabs plus a name filter. View-only state — none of
			// it is ever written back to the settings document.
			".dsm-qoder-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".dsm-qoder-search{font-size:12px;padding:5px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-3,#202126);color:inherit;border:1px solid var(--dsw-alias-border-l2,#36373b);min-width:150px;flex:1 1 150px}",
			".dsm-qoder-count{font-size:11px;color:var(--dsw-alias-label-primary,#1a1a1a);white-space:nowrap;font-variant-numeric:tabular-nums}",
			// Loading skeleton: three shimmering placeholder rows in the shape of a
			// real model row, so the list does not jump when the data lands.
			".dsm-qoder-skeleton{display:flex;flex-direction:column;gap:6px}",
			".dsm-qoder-skeleton-row{height:34px;border-radius:8px;background:linear-gradient(90deg,var(--dsw-alias-bg-layer-3,#202126) 25%,var(--dsw-alias-bg-layer-2,#2a2b31) 37%,var(--dsw-alias-bg-layer-3,#202126) 63%);background-size:400% 100%;animation:dsm-qoder-shimmer 1.4s ease infinite}",
			"@keyframes dsm-qoder-shimmer{0%{background-position:100% 50%}100%{background-position:0 50%}}",
			// Row flash after an in-place edit (checkbox tick / image-mode pick), so
			// the change is visible where it happened instead of only in the
			// "有未保存的更改" banner at the bottom.
			".dsm-qoder-row-pulse{animation:dsm-qoder-flash 1.2s ease}",
			"@keyframes dsm-qoder-flash{0%{border-color:var(--dsw-alias-state-success-primary,#12b76a)}100%{border-color:var(--dsw-alias-border-l2,#36373b)}}",
		].join("");
		/** Inject the card stylesheet once per page. */
		function installStyles() {
			const cssId = "dsh-connect-qoder/client.css";
			if (document.querySelector(`style[data-plugin-css="${cssId}"]`) !== null) return;
			const styleTag = document.createElement("style");
			styleTag.dataset.plugin = "dsh-connect-qoder";
			styleTag.dataset.pluginCss = cssId;
			styleTag.textContent = QODER_CARD_CSS;
			document.head.appendChild(styleTag);
		}
		//#endregion

		//#region src/client/settings-write.ts
		/**
		 * Verified settings writes, adapted from the WorkBuddy bundle's
		 * `writeField` contract (src/client/account-selection) to this card's
		 * three top-level fields.
		 *
		 * `settingsScope.set()` resolving is NOT proof that anything was stored.
		 * The Host's settings document is replaced by writing a temp file and
		 * renaming it over the target; on Windows an antivirus scanner or a sync
		 * client can hold the file briefly, and once the atomic-write retries
		 * exhaust the settings scope reloads Host state and merely RETURNS — the
		 * card's `await` succeeds while the document is unchanged. Reading the
		 * field back is the only reliable check, and the plugin's own Host
		 * endpoint is the only writer that actually persists in that failure
		 * mode (it runs the mutate inside the Host process).
		 *
		 * Field shapes, matching the Host `__save` whitelist:
		 * - `enabledModelIds` is per-region, so the write posts only the
		 *   regions the card edits and the Host merges them into the
		 *   authoritative value — saving one region can never delete the
		 *   other's allow-list.
		 * - `imageOverrides` / `useMaximumContextWindow` are posted whole; the
		 *   card always knows their complete value.
		 */
		/**
		 * A settings write that did not take effect.
		 *
		 * Distinct from a rejected `set()`: thrown when the write reported
		 * success (or the read-back disagreed) — which is the whole point of
		 * this module. The card shows it, so the user knows the value is not
		 * saved instead of trusting a "已保存" banner over stale settings.
		 */
		var QoderSettingsWriteError = class extends Error {
			field;
			constructor(field, reason) {
				super(`qoder: settings field "${field}" was not persisted${reason === void 0 ? "" : `: ${reason}`}`);
				this.name = "QoderSettingsWriteError";
				this.field = field;
			}
		};
		/**
		 * POST one field to the plugin's own Host save endpoint.
		 *
		 * The handler runs `settings.mutate` inside the Host process and
		 * answers with the merged value plus a read-back, so a failure here
		 * names its cause instead of arriving as a swallowed success.
		 *
		 * The 200 response may carry `ok: false` with an `errorName` when the
		 * host read-back mismatched (the value did not land). That case is
		 * indistinguishable from "not persisted" from the card's side, so it is
		 * thrown as a write failure rather than returning the stale value.
		 */
		async function saveFieldViaHost(field, value) {
			let response;
			try {
				response = await fetch("/plugins/dsh-connect-qoder/__save", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					credentials: "same-origin",
					body: JSON.stringify({ field, value })
				});
			} catch (error) {
				throw new QoderSettingsWriteError(field, `Host save endpoint unreachable: ${String(error)}`);
			}
			if (!response.ok) {
				const detail = await response.json().catch(() => ({ error: `HTTP ${String(response.status)}` }));
				const reason = `${String(detail.errorName ?? "")} ${String(detail.error ?? "")}`.trim();
				throw new QoderSettingsWriteError(field, `Host save refused: ${reason === "" ? String(detail.error) : reason}`);
			}
			const detail = await response.json().catch(() => void 0);
			if (detail !== void 0 && detail.ok === false) {
				const reason = `${String(detail.errorName ?? "")} ${String(detail.error ?? "")}`.trim();
				throw new QoderSettingsWriteError(field, `Host read-back mismatch: ${reason}`);
			}
			return detail?.value;
		}
		/** Read one field back from the scope snapshot, tolerating an absent namespace. */
		function fieldSnapshot(scope, field) {
			try {
				const value = scope.getSnapshot().value?.[field];
				return value === void 0 ? null : value;
			} catch {
				return null;
			}
		}
		/**
		 * Write one settings field, then confirm the value actually landed.
		 *
		 * The Host endpoint goes FIRST — it is the only writer that persists in
		 * the 0.1.7 silent-failure mode and, for the per-region field, the only
		 * one that preserves the sibling region. `scope.set` then runs purely as
		 * a mirror refresh (and as the legacy-host path, where the endpoint is
		 * absent or the settings service is unreachable): on a host whose scope
		 * write is authoritative, delivering and reading back suffices; on a
		 * host where it settled without persisting, the read-back mismatch
		 * falls through to the endpoint error, which is thrown — never
		 * swallowed into a false "已保存".
		 *
		 * @returns the authoritative value the write settled on (from the
		 *   endpoint) or `null` when only the scope delivered it.
		 */
		async function writeSettingsField(scope, field, value) {
			let hostError;
			let authoritative = null;
			try {
				authoritative = await saveFieldViaHost(field, value);
				try {
					await scope.set(field, authoritative);
				} catch {
					// Mirror only; the endpoint already persisted the value.
				}
				return authoritative;
			} catch (error) {
				hostError = error;
			}
			let scopeDelivered = false;
			try {
				// `enabledModelIds` is per-region on the Host, so its scope mirror
				// must keep the regions the card did not edit — every other field
				// is posted whole and replaces the field outright.
				const nextValue =
					field === "enabledModelIds"
						? { ...fieldSnapshot(scope, field), ...value }
						: value;
				// The scope stores the value verbatim (no server-side merge on
				// this path).
				scopeDelivered = (await scope.set(field, nextValue)) !== false;
			} catch {
				scopeDelivered = false;
			}
			// On 0.1.7 the settings service owns the document: a `scope.set`
			// that resolves here has not necessarily landed in the file — the
			// authoritative merge may keep a sibling region the card did not
			// post, and the scope's snapshot can trail the document. The Host
			// endpoint's read-back is the source of truth, so when it answered
			// `ok` the write is done; otherwise confirm what actually stored.
			if (authoritative !== null) return authoritative;
			if (scopeDelivered) {
				const readBack = fieldSnapshot(scope, field);
				const matches =
					field === "enabledModelIds"
						// Every posted region must match its read-back copy; the
						// mirror merge may legitimately keep sibling regions the
						// card did not edit, so the check is "all posted regions
						// equal", not "whole object equal".
						? Object.keys(nextValue).every((regionId) => JSON.stringify(readBack?.[regionId]) === JSON.stringify(nextValue[regionId]))
						: JSON.stringify(readBack) === JSON.stringify(nextValue);
				if (matches) return authoritative;
			}
			throw hostError instanceof Error ? hostError : new QoderSettingsWriteError(field, "neither the Host save endpoint nor the settings scope persisted the value");
		}
		//#endregion

		//#region src/client/copy.ts
		/** Simplified Chinese copy. */
		const zh = {
			"row.title": "接入使用 Qoder 积分与模型 (dsh-connect-qoder)",
			"row.desc": "使用本机已登录的 Qoder（国内版 / 国际版）模型；图像输入可由你逐个模型决定。",
			"row.expand": "展开",
			"row.collapse": "收起",
			"row.loading": "正在读取模型目录…",
			"row.signedOut": "该区域未检测到已登录的 Qoder 应用，因此没有模型。",
			"row.emptyModels": "该区域暂无可用的模型。",
			"row.imageTitle": "图像输入",
			"row.imageHint": "「跟随目录」使用 Qoder 自己声明的视觉能力；「开启」/「关闭」强制覆盖。开启后该模型可接收图片。",
			"row.maxWindow": "使用模型声明的最大上下文窗口",
			"row.maxWindowHint": "关闭时使用 Qoder 客户端默认的窗口。",
			"row.maxWindowOn": "已启用：每个模型按目录声明的最大窗口使用。",
			"row.maxWindowOff": "已关闭：使用 Qoder 客户端默认窗口（多数模型 200K）。",
			"row.save": "保存",
			"row.saving": "保存中…",
			"row.saved": "已保存",
			"row.discard": "撤销更改",
			"row.unsaved": "有未保存的更改",
			"row.failed": "保存失败",
			"row.requestFailed": "读取模型目录失败",
			"row.imageAuto": "跟随目录",
			"row.imageOn": "开启",
			"row.imageOff": "关闭",
			"row.vision": "视觉",
			"row.textOnly": "纯文本",
			"row.region.qoder-cn": "国内版",
			"row.region.qoder": "国际版",
			"usage.title": "我的用量",
			"usage.refresh": "刷新",
			"usage.loading": "正在读取用量…",
			"usage.empty": "当前账户暂无可展示的用量。",
			"usage.unavailable": "该区域暂时无法读取用量。",
			"usage.error": "读取用量失败",
			"usage.planCredits": "套餐内 Credits",
			"usage.resourcePackage": "个人资源包",
			"usage.dedicatedPackage": "专属资源包",
			"usage.renewsOn": "将于 {date} 续订",
			"usage.expiresOn": "将于 {date} 结束",
			"usage.remaining": "剩余",
			"usage.used": "已使用",
			"usage.exceeded": "额度已用尽",
			"usage.promotion": "限时特惠",
			"usage.viewDetails": "查看详情",
			"usage.credits": "Credits",
			"row.showInPicker": "在下拉框中显示",
			"row.showHint": "取消勾选的模型不会出现在模型选择器里。",
			"row.enableAll": "全部显示",
			"row.disableAll": "全部隐藏",
			"row.enabledCount": "已选 {count} / {total}",
			"row.rateFree": "免费",
			"row.rateLabel": "倍率",
			"row.refreshModels": "刷新模型与费率",
			"row.refreshing": "正在刷新…",
			"row.refreshed": "已更新（{time}）",
			"row.offPeakOn": "错峰价",
			"row.offPeakOff": "标准价",
			"row.offPeakUntil": "{time} 后切换",
			"row.offPeakHint": "错峰时段 {window}（{zone}）享受折扣；倍率按当前时段显示，到点会自动变化。",
			// Search, error retry, and the Escape-to-collapse affordance.
			"row.search": "搜索模型",
			"row.searchPlaceholder": "输入模型名…",
			"row.searchEmpty": "没有匹配的模型。",
			"row.retry": "重试",
			"row.regionFilter": "按区域筛选",
			"row.regionAll": "全部",
			"row.filterCount": "显示 {visible} / {total} · 已选 {ticked}",
			"row.clearFilter": "清除筛选"
		};
		/** English copy. */
		const en = {
			"row.title": "Connect Qoder credits and models (dsh-connect-qoder)",
			"row.desc": "Use the Qoder models already signed in on this machine (Qoder CN / Qoder); image input is decided per model.",
			"row.expand": "Expand",
			"row.collapse": "Collapse",
			"row.loading": "Reading the model catalog…",
			"row.signedOut": "No signed-in Qoder app was found for this region, so it lists no models.",
			"row.emptyModels": "This region currently offers no models.",
			"row.imageTitle": "Image input",
			"row.imageHint": "\"Follow catalog\" uses Qoder's own vision flag; On/Off forces it. An enabled model accepts images.",
			"row.maxWindow": "Use each model's largest declared context window",
			"row.maxWindowHint": "When off, the window the Qoder client itself starts on is used.",
			"row.maxWindowOn": "On: each model uses the largest window its catalog entry declares.",
			"row.maxWindowOff": "Off: the Qoder client's own default window is used (200K for most models).",
			"row.save": "Save",
			"row.saving": "Saving…",
			"row.saved": "Saved",
			"row.discard": "Discard changes",
			"row.unsaved": "Unsaved changes",
			"row.failed": "Save failed",
			"row.requestFailed": "Could not read the model catalog",
			"row.imageAuto": "Follow catalog",
			"row.imageOn": "On",
			"row.imageOff": "Off",
			"row.vision": "Vision",
			"row.textOnly": "Text",
			"row.region.qoder-cn": "Qoder CN",
			"row.region.qoder": "Qoder",
			"usage.title": "My usage",
			"usage.refresh": "Refresh",
			"usage.loading": "Reading usage…",
			"usage.empty": "This account has no usage to show right now.",
			"usage.unavailable": "Usage is unavailable for this region right now.",
			"usage.error": "Could not read usage",
			"usage.planCredits": "Plan Credits",
			"usage.resourcePackage": "Personal resource package",
			"usage.dedicatedPackage": "Dedicated package",
			"usage.renewsOn": "Renews on {date}",
			"usage.expiresOn": "Ends on {date}",
			"usage.remaining": "remaining",
			"usage.used": "used",
			"usage.exceeded": "Quota exhausted",
			"usage.promotion": "Limited offer",
			"usage.viewDetails": "View details",
			"usage.credits": "Credits",
			"row.showInPicker": "Show in the model picker",
			"row.showHint": "An unchecked model is hidden from the model picker.",
			"row.enableAll": "Show all",
			"row.disableAll": "Hide all",
			"row.enabledCount": "{count} of {total} selected",
			"row.rateFree": "free",
			"row.rateLabel": "Rate",
			"row.refreshModels": "Refresh models and rates",
			"row.refreshing": "Refreshing…",
			"row.refreshed": "Updated ({time})",
			"row.offPeakOn": "off-peak",
			"row.offPeakOff": "standard",
			"row.offPeakUntil": "switches in {time}",
			"row.offPeakHint": "The off-peak discount applies {window} ({zone}); the rate shown follows the current window and changes on its own at the boundary.",
			// Search, error retry, and the Escape-to-collapse affordance.
			"row.search": "Search models",
			"row.searchPlaceholder": "Type a model name…",
			"row.searchEmpty": "No matching models.",
			"row.retry": "Retry",
			"row.regionFilter": "Filter by region",
			"row.regionAll": "All",
			"row.filterCount": "{visible} of {total} shown · {ticked} ticked",
			"row.clearFilter": "Clear filter"
		};
		//#endregion

		/** The three per-model image choices this card writes. */
		const IMAGE_MODES = ["auto", "on", "off"];

		/**
		 * Sentinel stored in a region's allow-list to mean "hide every model".
		 *
		 * The host convention is `[] = no filter = show all` (a fresh install
		 * must still see every model), so "hide all" has no value of its own in
		 * that scheme. A non-empty list that matches no real model id collapses
		 * to "show nothing" in `filterByEnabled` (the allow-list branch keeps
		 * the ids, matches none, returns `[]`), so a marker that no model id can
		 * ever equal expresses "hide all" without touching that convention.
		 * Unticking any one model drops the marker (it is not in the region's
		 * roster) and the list becomes a plain allow-list again.
		 */
		const HIDE_ALL_MODELS = "__hide-all__";

		/** Normalise whatever the saved map holds into one of {@link IMAGE_MODES}. */
		function imageModeOf(overrides, modelId) {
			const saved = overrides === null || typeof overrides !== "object" ? undefined : overrides[modelId];
			return IMAGE_MODES.includes(saved) ? saved : "auto";
		}

		/** Fill a `{date}` placeholder in a translated string. */
		function withDate(template, at) {
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
		function rateLabelOf(t, factor) {
			const value = Number(factor);
			if (!Number.isFinite(value)) return undefined;
			return value <= 0 ? t("row.rateFree") : `x${value.toFixed(2)}`;
		}

		/** Seconds past local midnight in `timezone`, or undefined when unusable. */
		function localSecondsOf(date, timezone) {
			try {
				const parts = new Intl.DateTimeFormat("en-US", {
					timeZone: timezone,
					hour12: false,
					hour: "2-digit",
					minute: "2-digit",
					second: "2-digit"
				}).formatToParts(date);
				const read = (type) => Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
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
		function parseClock(text) {
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
		 * @returns `{ active, remainingSeconds }`, or undefined when the model
		 *   carries no usable window.
		 */
		function offPeakState(model, now) {
			const promo = model.promotion;
			if (promo === null || typeof promo !== "object") return undefined;
			const start = parseClock(promo.windowStart);
			const end = parseClock(promo.windowEnd);
			if (start === undefined || end === undefined || start === end) return undefined;
			const seconds = localSecondsOf(now, promo.timezone ?? "Asia/Shanghai");
			if (seconds === undefined) return undefined;
			const active = start < end ? seconds >= start && seconds < end : seconds >= start || seconds < end;
			const target = active ? end : start;
			const remainingSeconds = target >= seconds ? target - seconds : 86400 - seconds + target;
			return { active, remainingSeconds };
		}

		/** `HH:MM:SS` from a second count, matching the Qoder client's countdown. */
		function formatCountdown(seconds) {
			const total = Math.max(0, Math.floor(Number(seconds) || 0));
			const pad = (value) => String(value).padStart(2, "0");
			return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60].map(pad).join(":");
		}

		/**
		 * The multiplier that applies at `now`.
		 *
		 * Mirrors the host's resolution: `priceFactor` is Qoder's *discounted*
		 * price, and `beforePromotionPriceFactor` is what applies outside the
		 * window — the two are related by exactly `before x discount`. Reading
		 * `priceFactor` alone understates the cost for most of the day.
		 */
		function rateAt(model, now) {
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
		 * The set of model ids currently ticked, given what the host reported.
		 *
		 * The host stores an empty list as "no filter" (every model shows), so the
		 * card presents that same state as "everything ticked" — otherwise a fresh
		 * install would render every box empty while every model was visible.
		 */
		function enabledIdsFor(models, saved) {
			const list = Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : [];
			if (list.length === 0) return new Set(models.map((model) => model.id));
			return new Set(list);
		}

		/**
		 * One quota row: label, optional badges, an optional date, a bar, and the
		 * used/total figures. Shared by the plan quota, the add-on package and the
		 * per-model dedicated packages, which differ only in their wording.
		 */
		function QuotaBlock({ t, label, quota, when, badge }) {
			const percentage = Math.min(1, Math.max(0, Number(quota.percentage) || 0));
			// Round before formatting: a ratio like 268/2000 is 0.14 in binary
			// floating point, and rendering the raw product would emit
			// "14.000000000000002%" into the style attribute.
			const percent = Math.round(percentage * 1000) / 10;
			// The IDE paints the bar neutral, amber past 80%, red once exhausted;
			// matching that keeps a nearly-spent quota legible at a glance.
			const tone = quota.remaining <= 0 ? " dsm-qoder-bar-full" : percentage >= 0.8 ? " dsm-qoder-bar-warn" : "";
			const unit = quota.unit === "credits" ? t("usage.credits") : quota.unit ?? "";
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "dsm-qoder-usage-block",
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-qoder-usage-label",
						children: [
							(0, react_jsx_runtime.jsx)("span", { children: label }),
							badge !== undefined ? (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-qoder-usage-badge dsm-qoder-usage-badge-offer",
								children: badge
							}) : null,
							quota.remaining <= 0 ? (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-qoder-usage-badge",
								children: t("usage.exceeded")
							}) : null,
							when ? (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-qoder-usage-when",
								children: when
							}) : null
						]
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: "dsm-qoder-bar",
						role: "progressbar",
						"aria-valuemin": 0,
						"aria-valuemax": 100,
						"aria-valuenow": Math.round(percentage * 100),
						"aria-label": label,
						children: (0, react_jsx_runtime.jsx)("div", {
							className: `dsm-qoder-bar-fill${tone}`,
							style: { width: `${percent}%` }
						})
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-qoder-usage-figures",
						children: [
							(0, react_jsx_runtime.jsxs)("span", {
								children: [
									(0, react_jsx_runtime.jsx)("strong", { children: `${quota.used} / ${quota.total}` }),
									` (${Math.round(percent)}%)`
								]
							}),
							(0, react_jsx_runtime.jsx)("span", {
								children: `${t("usage.remaining")} ${quota.remaining}${unit ? ` ${unit}` : ""}`
							})
						]
					})
				]
			});
		}

		/** One region's usage block, as returned by the host usage route. */
		function RegionUsage({ t, entry }) {
			if (entry.available !== true) {
				return (0, react_jsx_runtime.jsxs)("div", {
					className: "dsm-qoder-usage-block",
					children: [
						(0, react_jsx_runtime.jsx)("p", {
							className: "dsm-qoder-state",
							children: `${entry.regionName}: ${t("usage.unavailable")}`
						})
					]
				});
			}
			const packages = Array.isArray(entry.dedicatedPackages) ? entry.dedicatedPackages : [];
			const campaigns = Array.isArray(entry.campaigns) ? entry.campaigns : [];
			const hasAny = entry.userQuota !== undefined || entry.addOnQuota !== undefined || packages.length > 0;
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "dsm-qoder-usage-block",
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-qoder-usage-head",
						children: [
							(0, react_jsx_runtime.jsx)("h4", {
								className: "dsm-qoder-usage-title",
								children: t("usage.title")
							}),
							(0, react_jsx_runtime.jsx)("span", {
								className: "dsm-qoder-usage-region",
								children: entry.regionName
							})
						]
					}),
					!hasAny ? (0, react_jsx_runtime.jsx)("p", {
						className: "dsm-qoder-state",
						children: t("usage.empty")
					}) : null,
					entry.userQuota !== undefined ? (0, react_jsx_runtime.jsx)(QuotaBlock, {
						t,
						label: t("usage.planCredits"),
						quota: entry.userQuota,
						when: withDate(t("usage.renewsOn"), entry.expiresAt)
					}) : null,
					entry.addOnQuota !== undefined ? (0, react_jsx_runtime.jsx)(QuotaBlock, {
						t,
						label: t("usage.resourcePackage"),
						quota: entry.addOnQuota
					}) : null,
					// Dedicated packages are per-model allowances. They appear only
					// when the account actually holds one, so the panel stays honest
					// for accounts that have none.
					packages.map((pack, index) => (0, react_jsx_runtime.jsxs)(react.Fragment, {
						children: [
							(0, react_jsx_runtime.jsx)("div", { className: "dsm-qoder-usage-sep" }),
							(0, react_jsx_runtime.jsx)(QuotaBlock, {
								t,
								label: pack.name || t("usage.dedicatedPackage"),
								quota: pack,
								when: withDate(t("usage.expiresOn"), pack.expiresAt)
							})
						]
					}, `pack:${pack.id}:${index}`)),
					campaigns.length > 0 ? (0, react_jsx_runtime.jsx)("div", { className: "dsm-qoder-usage-sep" }) : null,
					campaigns.map((camp) => (0, react_jsx_runtime.jsxs)("p", {
						className: "dsm-qoder-usage-promo",
						children: [
							(0, react_jsx_runtime.jsx)("span", {
								className: "dsm-qoder-usage-badge dsm-qoder-usage-badge-offer",
								children: t("usage.promotion")
							}),
							" ",
							camp.title,
							camp.endsAt !== undefined ? ` · ${withDate(t("usage.expiresOn"), camp.endsAt)}` : "",
							camp.detailUrl ? (0, react_jsx_runtime.jsxs)(react.Fragment, {
								children: [
									" ",
									(0, react_jsx_runtime.jsx)("a", {
										href: camp.detailUrl,
										target: "_blank",
										rel: "noreferrer",
										children: t("usage.viewDetails")
									})
								]
							}) : null
						]
					}, `camp:${camp.key}`))
				]
			});
		}

		/**
		 * The usage section: a refresh control plus one block per region.
		 *
		 * The panel owns its own fetch rather than riding the model read, because
		 * quota changes with every turn and must be refreshable on demand.
		 */
		function QoderUsagePanel({ t }) {
			const [regions, setRegions] = (0, react.useState)([]);
			const [status, setStatus] = (0, react.useState)("loading");
			const [notice, setNotice] = (0, react.useState)(undefined);
			const [busy, setBusy] = (0, react.useState)(false);
			const mounted = (0, react.useRef)(true);
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			const load = (0, react.useCallback)(async (refresh) => {
				setBusy(true);
				try {
					const response = await fetch(`${QODER_USAGE_PATH}${refresh ? "?refresh=1" : ""}`, {
						headers: { accept: "application/json" },
						credentials: "same-origin"
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok || value === void 0) throw new Error(`HTTP ${response.status}`);
					if (!mounted.current) return;
					setRegions(Array.isArray(value.regions) ? value.regions : []);
					setStatus("ready");
					setNotice(undefined);
				} catch (error) {
					if (!mounted.current) return;
					setStatus("error");
					setNotice(error instanceof Error ? error.message : String(error));
				} finally {
					if (mounted.current) setBusy(false);
				}
			}, []);
			(0, react.useEffect)(() => {
				void load(false);
			}, [load]);
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "dsm-qoder-usage",
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-qoder-usage-head",
						children: [
							// The status line renders only when it has something to say; the
							// spacer keeps the refresh button pinned right either way.
							status === "loading" ? (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-qoder-hint",
								children: t("usage.loading")
							}) : status === "error" ? (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-qoder-error",
								children: `${t("usage.error")}: ${notice ?? ""}`
							}) : (0, react_jsx_runtime.jsx)("span", { className: "dsm-qoder-usage-spacer" }),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsm-qoder-button",
								disabled: busy,
								onClick: () => {
									void load(true);
								},
								children: t("usage.refresh")
							})
						]
					}),
					regions.map((entry, index) => (0, react_jsx_runtime.jsxs)(react.Fragment, {
						children: [
							index > 0 ? (0, react_jsx_runtime.jsx)("div", { className: "dsm-qoder-usage-sep" }) : null,
							(0, react_jsx_runtime.jsx)(RegionUsage, { t, entry })
						]
					}, `region:${entry.region ?? index}`))
				]
			});
		}

		/**
		 * Whether the card starts expanded, resolved from the host's `view`.
		 *
		 * The host renders a slot card with one of three shapes:
		 *
		 * - `view: "page"` — the card is the page itself (the bundle / row
		 *   detail pages, and the WorkBuddy-style detail surface). Collapsing a
		 *   page would leave the user staring at an empty screen, so the card
		 *   opens by default. This is the "auto-expand" behaviour borrowed from
		 *   the WorkBuddy bundle.
		 * - `view: "summary"` — the card sits in a list of cards, where an
		 *   expanded card would push every sibling off-screen; start collapsed
		 *   and let the header click do the work.
		 * - no `view` (legacy slots that predate the prop) — the previous
		 *   default was collapsed, and keeping it means an old host surface
		 *   does not suddenly change shape on upgrade.
		 *
		 * Collapsing is never destructive: the card's body is `hidden`, not
		 * unmounted, so staged edits and a ticking off-peak countdown survive a
		 * collapse/expand cycle.
		 *
		 * @param view - the `view` prop the host slot passed, if any.
		 * @returns true when the card should start expanded.
		 */
		function initialOpenForView(view) {
			return view === "page";
		}

		/** Render the Qoder model and image-input card. */
		function QoderPluginCard({ t, settingsScope, view }) {
			if (t === void 0) throw new Error("Qoder settings card requires its translation function");
			const [open, setOpen] = (0, react.useState)(() => initialOpenForView(view));
			const [models, setModels] = (0, react.useState)([]);
			const [imageOverrides, setImageOverrides] = (0, react.useState)({});
			const [savedOverrides, setSavedOverrides] = (0, react.useState)({});
			const [maxWindow, setMaxWindow] = (0, react.useState)(false);
			const [savedMaxWindow, setSavedMaxWindow] = (0, react.useState)(false);
			// Picker visibility, per region. The host stores an empty list as "no
			// filter", so the card keeps the same shape and renders that state as
			// "everything ticked".
			const [enabledIds, setEnabledIds] = (0, react.useState)({});
			const [savedEnabledIds, setSavedEnabledIds] = (0, react.useState)({});
			const [status, setStatus] = (0, react.useState)("loading");
			const [saving, setSaving] = (0, react.useState)(false);
			const [notice, setNotice] = (0, react.useState)(undefined);
			const [refreshing, setRefreshing] = (0, react.useState)(false);
			const [refreshedAt, setRefreshedAt] = (0, react.useState)(undefined);
			// View-only filter state. It narrows which rows RENDER, never which
			// rows are SAVED: filtering the list cannot change `enabledModelIds`,
			// so it is deliberately kept out of `dirty` and out of `save()`.
			const [query, setQuery] = (0, react.useState)("");
			const [regionFilter, setRegionFilter] = (0, react.useState)("all");
			// The model id whose row should flash, set by the last in-place edit
			// (checkbox tick or image-mode pick). A timeout clears it, so the CSS
			// animation plays once and the row settles back.
			const [pulse, setPulse] = (0, react.useState)(undefined);
			// A ticking clock, so the off-peak rate and its countdown flip on their
			// own at the window boundary instead of waiting for a manual refresh.
			// The tick only runs when at least one model carries a usable
			// off-peak window (`promotion.active === true`); with no active
			// window the rate and countdown are static and a per-second
			// re-render would cost nothing but gain nothing either.
			const [clock, setClock] = (0, react.useState)(() => new Date());
			const mounted = (0, react.useRef)(true);
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			// Clear the row flash after one animation cycle; a new pulse id re-arms
			// this timer because the effect re-runs on every id change.
			(0, react.useEffect)(() => {
				if (pulse === undefined) return undefined;
				const timer = window.setTimeout(() => setPulse(undefined), 1300);
				return () => window.clearTimeout(timer);
			}, [pulse]);
			(0, react.useEffect)(() => {
				// Tick only when a promotion window is active on at least one
				// model; otherwise the clock is inert and re-rendering every
				// second just churns the model list for no visible change.
				const hasActiveWindow = models.some((m) => m.promotion?.active === true);
				if (!hasActiveWindow) return undefined;
				const timer = window.setInterval(() => {
					if (mounted.current) setClock(new Date());
				}, 1000);
				return () => {
					window.clearInterval(timer);
				};
			}, [models]);
			/**
			 * Read the model roster from the host route.
			 *
			 * The card reads its rows from the host rather than the settings
			 * document: the roster and the rates are live catalog state, not
			 * configuration, so they are never persisted.
			 *
			 * `refresh` asks the host to re-read the catalog from upstream, which is
			 * how a newly published model or a changed multiplier reaches the
			 * picker without restarting DSH. The settings fields are only seeded on
			 * the first load: a refresh must not clobber edits the user has staged
			 * but not yet saved.
			 */
			const load = (0, react.useCallback)(async (refresh, signal) => {
				if (refresh) setRefreshing(true);
				try {
					const response = await fetch(`${QODER_MODELS_PATH}${refresh ? "?refresh=1" : ""}`, {
						headers: { accept: "application/json" },
						credentials: "same-origin",
						signal
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok || value === void 0) throw new Error(`HTTP ${response.status}`);
					if (!mounted.current) return;
					setModels(Array.isArray(value.models) ? value.models : []);
					if (!refresh) {
						const overrides = value.imageOverrides !== null && typeof value.imageOverrides === "object" ? value.imageOverrides : {};
						const savedEnabled = value.enabledModelIds !== null && typeof value.enabledModelIds === "object" ? value.enabledModelIds : {};
						setImageOverrides(overrides);
						setSavedOverrides(overrides);
						setMaxWindow(value.useMaximumContextWindow === true);
						setSavedMaxWindow(value.useMaximumContextWindow === true);
						setEnabledIds(savedEnabled);
						setSavedEnabledIds(savedEnabled);
					}
					setRefreshedAt(typeof value.refreshedAt === "number" ? value.refreshedAt : Date.now());
					setStatus("ready");
				} catch (error) {
					if (!mounted.current || signal?.aborted === true) return;
					setStatus("error");
					setNotice(error instanceof Error ? error.message : String(error));
				} finally {
					if (mounted.current) setRefreshing(false);
				}
			}, []);
			(0, react.useEffect)(() => {
				const controller = new AbortController();
				void load(false, controller.signal);
				return () => {
					controller.abort();
				};
			}, [load]);
			// Every editable field participates in "has unsaved changes": the
			// per-model image modes, the picker roster, and the context-window switch.
			const dirty = (0, react.useMemo)(() => JSON.stringify(imageOverrides) !== JSON.stringify(savedOverrides) || JSON.stringify(enabledIds) !== JSON.stringify(savedEnabledIds) || maxWindow !== savedMaxWindow, [imageOverrides, savedOverrides, enabledIds, savedEnabledIds, maxWindow, savedMaxWindow]);
			const setMode = (0, react.useCallback)((modelId, mode) => {
				setImageOverrides((current) => {
					const next = { ...current };
					// "auto" is the absence of an override, so an auto row never
					// writes a key — the saved document stays minimal and a future
					// catalog change is picked up again.
					if (mode === "auto") delete next[modelId];
					else next[modelId] = mode;
					return next;
				});
				// Flash the row so the pick gives feedback where it happened;
				// without it the only signal is the banner at the bottom.
				setPulse(modelId);
				setNotice(undefined);
			}, []);
			/**
			 * Tick or untick one model for the picker.
			 *
			 * Ticking is recorded against the region's **full** roster, not against
			 * whatever happens to be ticked now, so the saved list is a complete
			 * allow-list rather than a diff. That is what lets a partially curated
			 * region stay curated when the catalog later grows.
			 */
			const toggleModel = (0, react.useCallback)((regionId, modelId) => {
				setEnabledIds((current) => {
					const roster = models.filter((m) => m.region === regionId).map((m) => m.id);
					const active = enabledIdsFor(models, current[regionId]);
					const next = new Set(active);
					if (!next.delete(modelId)) next.add(modelId);
					// A full selection is stored as the empty list, which is the
					// "no filter" state — so re-ticking everything returns the region
					// to following the catalog automatically.
					const list = roster.filter((id) => next.has(id));
					return { ...current, [regionId]: list.length === roster.length ? [] : list };
				});
				// Same in-place flash as the image-mode pick: the tick visibly
				// lands even though nothing is saved yet.
				setPulse(modelId);
				setNotice(undefined);
			}, [models]);
			/**
			 * Bulk-set every region's roster to one of two extremes.
			 *
			 * `[]` is the host's "no filter" state — every model shows, so this
			 * is the card's "show all". `[HIDE_ALL_MODELS]` matches no real model
			 * id, so `filterByEnabled` returns `[]` (nothing shown) — a true
			 * "hide all" / "deselect all" without changing that convention. The
			 * two are distinct states, so the button can toggle between them the
			 * way the official picker's 全选/取消全选 does; ticking any one model
			 * out of the hidden state drops the sentinel and the list becomes a
			 * plain allow-list again.
			 */
			const setAllRegions = (0, react.useCallback)((list) => {
				setEnabledIds((current) => {
					const next = { ...current };
					for (const model of models) next[model.region] = list;
					return next;
				});
				setNotice(undefined);
			}, [models]);
			/**
			 * Persist the card's three settings fields.
			 *
			 * Each write is verified (read-back against what was posted) and the
			 * per-region allow-list goes through the Host merge, so a save
			 * either lands or raises — the "已保存" banner only appears for
			 * values that actually persisted.
			 */
			const save = (0, react.useCallback)(async () => {
				if (settingsScope === undefined) return;
				setSaving(true);
				try {
					await writeSettingsField(settingsScope, "enabledModelIds", enabledIds);
					await writeSettingsField(settingsScope, "imageOverrides", imageOverrides);
					// The other fields are siblings of the same namespace, so they are
					// written in the same save action.
					await writeSettingsField(settingsScope, "useMaximumContextWindow", maxWindow);
					setSavedOverrides(imageOverrides);
					setSavedMaxWindow(maxWindow);
					setSavedEnabledIds(enabledIds);
					setNotice(t("row.saved"));
				} catch (error) {
					setNotice(`${t("row.failed")}: ${error instanceof Error ? error.message : String(error)}`);
				} finally {
					if (mounted.current) setSaving(false);
				}
			}, [settingsScope, imageOverrides, maxWindow, enabledIds, t]);
			const discard = (0, react.useCallback)(() => {
				setImageOverrides(savedOverrides);
				setMaxWindow(savedMaxWindow);
				setEnabledIds(savedEnabledIds);
				setNotice(undefined);
			}, [savedOverrides, savedMaxWindow, savedEnabledIds]);
			// `t()` echoes the key when a lookup misses, so the host-provided
			// region name is the fallback rather than a raw "row.region.x" string.
			const regionLabel = (model) => {
				const key = `row.region.${model.region}`;
				const translated = t(key);
				return translated === key ? model.regionName ?? model.region : translated;
			};
			// The bulk button acts on the whole roster across every region: the
			// list mixes regions, so "show all" / "hide all" name the entire
			// roster, not just the first region. `allTicked` is true when every
			// model in every region is currently ticked — `[]` (the host's
			// no-filter state) counts as ticked for that region.
			const allTicked = models.length > 0 && models.every((model) => enabledIdsFor(models, enabledIds[model.region]).has(model.id));
			// Regions actually present in the roster, for the tab strip. Derived
			// from data rather than hard-coded so a region whose sign-in vanished
			// drops its tab instead of showing an empty one.
			const regions = [];
			for (const model of models) {
				if (!regions.some((region) => region.id === model.region)) {
					regions.push({ id: model.region, label: regionLabel(model) });
				}
			}
			// A filter tab whose region is gone falls back to "all".
			const activeRegion = regions.some((region) => region.id === regionFilter) ? regionFilter : "all";
			const needle = query.trim().toLowerCase();
			// What actually renders: region tab first, then the name filter. The
			// filter only narrows the VIEW — `save()` still writes the full
			// allow-list, so hiding rows while a filter is active can never
			// silently uncheck a model the user never saw.
			const visibleModels = models.filter((model) => {
				if (activeRegion !== "all" && model.region !== activeRegion) return false;
				if (needle === "") return true;
				return String(model.name ?? model.id).toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle);
			});
			// Visible + ticked, for the counter beside the filter. Counted over
			// `visibleModels` so the number matches the rows on screen.
			const visibleTicked = visibleModels.filter((model) => enabledIdsFor(models, enabledIds[model.region]).has(model.id)).length;
			return (0, react_jsx_runtime.jsxs)("li", {
				className: `dsm-plugin-card${open ? " dsm-plugin-card-open" : ""}`,
				// Escape leaves the card in two steps: inside the search box it first
				// clears the filter (the natural "get me out of this search" gesture);
				// with the filter already clear it collapses the card from anywhere
				// inside it, so a user lost in a long roster has one keystroke out.
				onKeyDown: (event) => {
					if (event.key !== "Escape" || !open) return;
					if (query !== "") {
						setQuery("");
						return;
					}
					setOpen(false);
				},
				children: [(0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "dsm-plugin-card-header",
					"aria-expanded": open,
					"aria-label": `${t(open ? "row.collapse" : "row.expand")}: ${t("row.title")}`,
					onClick: () => {
						setOpen(!open);
					},
					children: [(0, react_jsx_runtime.jsxs)("span", {
						className: "dsm-plugin-card-head",
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: "dsm-plugin-card-title",
							children: t("row.title")
						}), (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-plugin-card-description",
							children: t("row.desc")
						})]
					}), (0, react_jsx_runtime.jsx)("span", {
						// Empty span: the caret is drawn by the ::before rule copied
						// from WorkBuddy. A text glyph here too would render a second
						// arrow beside the CSS one.
						"aria-hidden": "true",
						className: `dsm-plugin-card-chevron${open ? " dsm-plugin-card-chevron-open" : ""}`
					})]
				}), (0, react_jsx_runtime.jsx)("div", {
					className: "dsm-plugin-card-body",
					hidden: !open,
					children: open ? (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-qoder-body",
						children: [
							(0, react_jsx_runtime.jsx)(QoderUsagePanel, { t }),
							(0, react_jsx_runtime.jsx)("p", {
								className: "dsm-qoder-hint",
								children: t("row.imageHint")
							}),
							status === "loading" ? (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-qoder-skeleton",
								"aria-busy": "true",
								children: [(0, react_jsx_runtime.jsx)("p", {
									className: "dsm-qoder-state",
									children: t("row.loading")
								}), (0, react_jsx_runtime.jsx)("div", { className: "dsm-qoder-skeleton-row" }), (0, react_jsx_runtime.jsx)("div", { className: "dsm-qoder-skeleton-row" }), (0, react_jsx_runtime.jsx)("div", { className: "dsm-qoder-skeleton-row" })]
							}) : null,
							status === "error" ? (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-qoder-tools",
								children: [(0, react_jsx_runtime.jsx)("p", {
									className: "dsm-qoder-error",
									children: `${t("row.requestFailed")}: ${notice ?? ""}`
								}), (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsm-qoder-button",
									disabled: refreshing,
									// The retry sits ON the error, not behind the toolbar
									// button elsewhere on the page: recovery should be one
									// click from where the failure is being read. `load(true)`
									// also re-pulls the catalog, which is the failure mode
									// users actually hit (an upstream blip left a stale list).
									onClick: () => {
										void load(true);
									},
									children: refreshing ? t("row.refreshing") : t("row.retry")
								})]
							}) : null,
							status === "ready" && models.length === 0 ? (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-qoder-state",
								children: t("row.signedOut")
							}) : null,
							models.length > 0 ? (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-qoder-models-head",
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: "dsm-qoder-hint",
									children: t("row.showHint")
								}), (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsm-qoder-button",
									disabled: refreshing,
									onClick: () => {
										void load(true);
									},
									children: refreshing ? t("row.refreshing") : t("row.refreshModels")
								}), (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsm-qoder-button",
									disabled: saving,
									onClick: () => {
										// One bulk button for the whole roster, like the official
										// picker's select-all/deselect-all toggle: when every model
										// is ticked it flips to "hide all" (HIDE_ALL_MODELS, a list
										// matching no model); otherwise it flips to "show all"
										// ([] = no filter). A fresh card (no saved allow-list) is all
										// ticked, so the label reads "hide all" on first open.
										setAllRegions(allTicked ? [HIDE_ALL_MODELS] : []);
									},
									children: t(allTicked ? "row.disableAll" : "row.enableAll")
								}), refreshedAt !== undefined && !refreshing ? (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-qoder-state",
									children: t("row.refreshed", { time: new Date(refreshedAt).toLocaleTimeString() })
								}) : null]
							}) : null,
							// The filter bar: a name search plus one tab per region. It
							// only decides which rows render — the saved allow-list and
							// `dirty` never see it — and the counter beside it always
							// matches the rows on screen. The tabs collapse to nothing
							// when only one region is present, so a single-region install
							// does not grow a pointless tab strip.
							models.length > 0 ? (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-qoder-tools",
								children: [regions.length > 1 ? (0, react_jsx_runtime.jsxs)("div", {
									className: "dsm-qoder-tabs",
									role: "tablist",
									"aria-label": t("row.regionFilter"),
									children: [(0, react_jsx_runtime.jsx)("button", {
										type: "button",
										role: "tab",
										"aria-selected": activeRegion === "all",
										className: `dsm-qoder-tab${activeRegion === "all" ? " dsm-qoder-tab-active" : ""}`,
										onClick: () => setRegionFilter("all"),
										children: t("row.regionAll")
									}), regions.map((region) => (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										role: "tab",
										"aria-selected": activeRegion === region.id,
										className: `dsm-qoder-tab${activeRegion === region.id ? " dsm-qoder-tab-active" : ""}`,
										onClick: () => setRegionFilter(region.id),
										children: region.label
									}, region.id))]
								}) : null, (0, react_jsx_runtime.jsx)("input", {
									type: "search",
									className: "dsm-qoder-search",
									value: query,
									placeholder: t("row.searchPlaceholder"),
									"aria-label": t("row.search"),
									onChange: (event) => setQuery(event.target.value)
								}), (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-qoder-count",
									"aria-live": "polite",
									children: t("row.filterCount", { visible: visibleModels.length, total: models.length, ticked: visibleTicked })
								})]
							}) : null,
							// The off-peak rule is stated once for the roster rather than
							// repeated on every row that carries it.
							models.some((model) => model.promotion !== undefined) ? (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-qoder-hint",
								children: t("row.offPeakHint", {
									window: `${models.find((model) => model.promotion !== undefined)?.promotion?.windowStart}–${models.find((model) => model.promotion !== undefined)?.promotion?.windowEnd}`,
									zone: models.find((model) => model.promotion !== undefined)?.promotion?.timezone ?? "Asia/Shanghai"
								})
							}) : null,
							// An empty result after filtering is distinct from "not signed
							// in": the roster exists, the filter just matched nothing, so
							// it gets its own message plus a one-click way back.
							models.length > 0 && visibleModels.length === 0 ? (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-qoder-tools",
								children: [(0, react_jsx_runtime.jsx)("p", {
									className: "dsm-qoder-state",
									children: t("row.searchEmpty")
								}), (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsm-qoder-button",
									onClick: () => {
										setQuery("");
										setRegionFilter("all");
									},
									children: t("row.clearFilter")
								})]
							}) : null,
							visibleModels.length > 0 ? (0, react_jsx_runtime.jsx)("ul", {
								className: "dsm-qoder-models",
								children: visibleModels.map((model) => {
									const active = enabledIdsFor(models, enabledIds[model.region]).has(model.id);
									// The rate is resolved against the ticking clock, not the
									// server's snapshot, so it flips at the window boundary.
									const offPeak = offPeakState(model, clock);
									const rate = rateLabelOf(t, rateAt(model, clock));
									const offPeakTitle = model.promotion === undefined ? t("row.rateLabel") : offPeak?.active === true ? `${t("row.offPeakOn")} · ${formatCountdown(offPeak.remainingSeconds)}` : t("row.offPeakOff");
									return (0, react_jsx_runtime.jsxs)("li", {
										className: `dsm-qoder-row${active ? "" : " dsm-qoder-row-off"}${pulse === model.id ? " dsm-qoder-row-pulse" : ""}`,
										children: [(0, react_jsx_runtime.jsxs)("span", {
											className: "dsm-qoder-row-main",
											children: [(0, react_jsx_runtime.jsx)("label", {
												className: "dsm-qoder-pick",
												title: t("row.showInPicker"),
												children: (0, react_jsx_runtime.jsx)("input", {
													type: "checkbox",
													checked: active,
													disabled: saving,
													"aria-label": `${t("row.showInPicker")}: ${model.name ?? model.id}`,
													onChange: () => {
														toggleModel(model.region, model.id);
													}
												})
											}), (0, react_jsx_runtime.jsx)("span", {
												className: "dsm-qoder-name",
												title: model.id,
												children: model.name ?? model.id
											}), rate !== undefined ? (0, react_jsx_runtime.jsx)("span", {
												className: `dsm-qoder-rate${Number(rateAt(model, clock)) <= 0 ? " dsm-qoder-rate-free" : ""}`,
												title: offPeakTitle,
												children: rate
											}) : null, offPeak !== undefined ? (0, react_jsx_runtime.jsx)("span", {
												className: `dsm-qoder-badge${offPeak.active ? " dsm-qoder-badge-offer" : ""}`,
												title: model.promotion?.description ?? "",
												children: `${offPeak.active ? t("row.offPeakOn") : t("row.offPeakOff")} ${formatCountdown(offPeak.remainingSeconds)}`
											}) : null, (0, react_jsx_runtime.jsx)("span", {
												className: "dsm-qoder-badge",
												children: regionLabel(model)
											}), (0, react_jsx_runtime.jsx)("span", {
												className: "dsm-qoder-badge",
												children: model.isVL === true ? t("row.vision") : t("row.textOnly")
											})]
										}), (0, react_jsx_runtime.jsxs)("label", {
											className: "dsm-qoder-switch",
											children: [(0, react_jsx_runtime.jsx)("span", {
												children: t("row.imageTitle")
											}), (0, react_jsx_runtime.jsx)("select", {
												className: "dsm-qoder-select",
												value: imageModeOf(imageOverrides, model.id),
												disabled: saving,
												"aria-label": `${t("row.imageTitle")}: ${model.name ?? model.id}`,
												onChange: (event) => {
													setMode(model.id, event.target.value);
												},
												children: IMAGE_MODES.map((mode) => (0, react_jsx_runtime.jsx)("option", {
													value: mode,
													children: t(mode === "auto" ? "row.imageAuto" : mode === "on" ? "row.imageOn" : "row.imageOff")
												}, mode))
											})]
										})]
									}, `${model.region}:${model.id}`);
								})
							}) : null,
							(0, react_jsx_runtime.jsxs)("label", {
								className: "dsm-qoder-switch",
								children: [(0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: maxWindow,
									disabled: saving,
									"aria-label": t("row.maxWindow"),
									onChange: (event) => {
										setMaxWindow(event.target.checked);
										setNotice(undefined);
									}
								}), (0, react_jsx_runtime.jsx)("span", {
									children: t("row.maxWindow")
								})]
							}),
							(0, react_jsx_runtime.jsx)("p", {
								className: "dsm-qoder-hint",
								children: maxWindow ? t("row.maxWindowOn") : t("row.maxWindowOff")
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-qoder-actions",
								children: [(0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsm-qoder-button",
									disabled: saving || !dirty || settingsScope === undefined,
									onClick: save,
									children: saving ? t("row.saving") : t("row.save")
								}), (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsm-qoder-button",
									disabled: saving || !dirty,
									onClick: discard,
									children: t("row.discard")
								}), notice !== undefined ? (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-qoder-state",
									// A save just completed (success banner or failure
									// reason). The failure banner is the one that has to
									// be visible: it is the card's only proof that the
									// value did not persist, so it outranks the generic
									// "unsaved" marker while it is up.
									children: notice
								}) : dirty ? (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-qoder-state",
									children: t("row.unsaved")
								}) : null]
							})
						]
					}) : null
				})]
			});
		}

		//#region src/client/index.ts
		/** Stable browser-plugin name. */
		const name = "dsh-connect-qoder-client";
		/**
		 * Client services this card reads.
		 *
		 * FIX 0.1.7: the harness removed the `settingsScope` wrapper service in the
		 * 0.1.7 settings rewrite and replaced it with `configForms`. Cordis' hard
		 * inject gate never calls `apply` while a listed service is absent, so
		 * listing `settingsScope` here bricked web boot on 0.1.7
		 * ("1 entry did not activate: dsh-connect-qoder: pending (waiting for
		 * service: settingsScope)"). Only guaranteed services go in `inject`; the
		 * settings service is probed softly inside `apply` below.
		 */
		const inject = ["slots", "locale"];
		/**
		 * Register the Qoder card under Plugin configuration.
		 *
		 * The whole body is wrapped so that a future DSH slot-API change degrades
		 * to a `console.error` instead of throwing into the loader and raising the
		 * red "Failed to load plugins" banner — the host provider keeps working
		 * either way, and the model channel is unaffected.
		 *
		 * `key` names the settings namespace the HOST serves. A card whose key
		 * names no served namespace is registered into the slot but never
		 * rendered, because the card list is built from the Host's installed
		 * sections.
		 */
		function apply(ctx) {
			try {
				installStyles();
				const namespace = "settings.qoder";
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-connect-qoder: settings copy");
			const t = ctx.locale.bind(namespace);
			/**
			 * FIX 0.1.7: probe the settings surface without a hard dependency.
			 * 0.1.7 serves the section through `configForms`; 0.1.6 and earlier
			 * through `settingsScope`. `ctx.get` returns undefined (never throws)
			 * for an absent service, so one build spans both lines. `forms.get(ns)`
			 * mirrors the legacy `settingsScope.bind` shape (`.set` / `.getSnapshot`),
			 * so the card body below is unchanged.
			 */
			const softGet = (name) => ctx.get(name);
			let settingsScope;
			const forms = softGet("configForms");
			const legacy = softGet("settingsScope");
			if (forms !== void 0) {
				let ns = "dsh-connect-qoder";
				try {
					const served = (forms.describe().getSnapshot().view?.namespaces ?? [])
						.find((entry) => entry.ns === "dsh-connect-qoder" || /qoder/i.test(entry.ns));
					if (served !== void 0) ns = served.ns;
				} catch {}
				settingsScope = forms.get(ns);
			} else if (legacy !== void 0) {
				settingsScope = legacy.bind({ namespace: "dsh-connect-qoder" });
			}
			/**
			 * FIX 0.1.7: the plugin-manager detail page renders a bundle's config
			 * card from the `plugins.bundle.config` slot (and a row's from
			 * `plugins.row.config`); the legacy `settings.plugin.item` slot is no
			 * longer rendered there. Register under all three so the card shows
			 * on the bundle page (0.1.7), the row page, and any legacy surface.
			 * Each registration degrades to a read-only card when no settings
			 * surface is served, instead of throwing into the loader.
			 */
			const registerCard = (slotName, key) => {
				try {
					ctx.slots.inject(slotName, () => ctx.slots.register({
						name: slotName,
						key,
						priority: 30,
						inject: () => settingsScope === void 0 ? {
							t
						} : {
							t,
							settingsScope
						}
					}, QoderPluginCard));
				} catch (error) {
					console.error(`[dsh-connect-qoder] card slot "${slotName}" failed to register (host provider unaffected):`, error);
				}
			};
			registerCard("plugins.bundle.config", "dsh-connect-qoder");
			registerCard("plugins.row.config", "dsh-connect-qoder#llm-qoder");
			registerCard("settings.plugin.item", "qoder");
			} catch (error) {
				console.error("[dsh-connect-qoder] client card failed to load (host provider unaffected):", error);
			}
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
