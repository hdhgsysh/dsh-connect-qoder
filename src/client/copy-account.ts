/** Simplified Chinese — account panel copy. */
export const zhAccount = {
	"account.reload": "重新读取登录状态",
	"account.confirm": "在线校验登录",
	"account.confirming": "校验中…",
	"account.confirmed": "在线校验通过：登录有效",
	"account.confirmExpired": "在线校验发现登录已过期——在 Qoder 客户端里重新登录后点「重新读取登录状态」",
	"account.confirmFailed": "在线校验失败：{detail}",
	// 宿主答「没有可校验的登录」时不给原因——原因就是没有登录，这句话自己说清楚，
	// 比在「在线校验失败：」后面留一个空尾巴强（红线 1：失败必须说清是哪一种）。
	"account.confirmNoSignIn": "这个版本没有可校验的登录——请先登录，或设置环境变量 PAT（QODERCN_PAT / QODER_PAT）",
	// 协议漂移不是登录坏了：上游 200 的正文换了形状，重新登录修不了它。与 usage
	// 的 protocolChanged 同一套判断（host handlers 的 confirm 路由会单独报这个
	// kind），措辞必须指向「更新插件」，不能落进「在线校验失败」让用户白登录。
	"account.confirmProtocolChanged": "在线校验收到本插件不认识的接口格式——请更新插件（重新登录没有用）",
	"account.state.ok": "正常",
	"account.state.expired": "已过期",
	"account.state.needs-app": "读不到",
	"account.state.signed-out": "未登录",
	// The plugin's OWN credential is the sign-in in use. The host reports the
	// desktop application's sign-in and the plugin's credential side by side
	// and deliberately does not merge them (two credentials, two lifetimes) —
	// but the card answers one question, "am I signed in for this edition?",
	// and on a machine whose desktop sign-in cannot be read the answer is yes
	// whenever the plugin's own credential is there. Without this state the
	// macOS user who signed in through the browser read "读不到" next to
	// "插件已登录" and had to guess which of the two was true.
	"account.state.device": "已登录",
	"account.deviceActive": "当前用的是插件自有登录（浏览器登录）——不需要桌面端客户端。",
	"account.deviceFrom": "来自插件自有登录",
	"account.envPat": "来自环境变量 PAT",
	"account.appFrom": "来自 {app}",
	"account.expiresAt": "有效期至 {date}",
	"account.unsigned": "本机没装这个版本的 Qoder 客户端",
	"account.expiredHint": "登录已失效——请打开 Qoder 客户端（{app}）重新登录，然后点「重新读取登录状态」",
	// The advice has to be true on every platform the plugin can run on. The
	// previous wording ("make sure a signed-in Qoder client is on this machine")
	// is exactly wrong for a macOS or Linux user: they HAVE one, the plugin just
	// cannot read that platform's keychain yet, and the host now says so in
	// `detail`.
	//
	// TWO variants, because the remedies are not the same on every host. Where
	// the host reports the plugin's OWN credential (`device`), the browser
	// sign-in leads: it is the one way in that holds on every platform, desktop
	// client or not, which is the whole point of the plugin having a credential
	// of its own. The environment PAT is second (it needs a token minted in a
	// web console first) and "re-read" third (it only helps when the cause
	// really was a stale read).
	//
	// Where the host reports NO `device` entry (an older build), the browser
	// sign-in is not on the card at all — pointing at a button that does not
	// exist would be the dangling-pointer version of the same lie. That host
	// keeps the PAT-only wording.
	"account.readFail": "本地登录信息读不到：{detail}。可改用环境变量 PAT（QODERCN_PAT / QODER_PAT），或点「重新读取登录状态」",
	"account.readFailDevice": "本地登录信息读不到：{detail}。可点「浏览器登录」用插件自有登录（不装桌面端也能用），或改用环境变量 PAT（QODERCN_PAT / QODER_PAT），或点「重新读取登录状态」",
	"account.download": "没装 Qoder 客户端？到「下载」区安装 {edition}，装好后登录",
	"account.downloadLink": "下载 {edition}",
	"account.error": "读取账号状态失败",
	// Now a VISIBLE label on the switch, not a tooltip. It used to be "模型"
	// with the whole explanation living in a 57-character `title` that a touch
	// user or a keyboard focus never saw — and the switch sat inside the region
	// pill, eight pixels from a tab button that did something else entirely.
	"account.offer": "启用此版本",
	"account.offerTitle": "关闭后这个版本的模型不会出现在 DSH 的模型下拉框里；登录、用量与模型设置都会保留，重新开启即恢复。",
	"account.offerOff": "已关闭：该版本的模型不会出现在 DSH 的模型下拉框里",
	"account.offerError": "保存「启用此版本」开关失败：{detail}",
	"account.regionTabs": "版本：点哪个就看哪个版本的账号、用量与模型",
	// The plugin's OWN credential, reported BESIDE the application's sign-in and
	// never merged into it: two credentials, two lifetimes. `device.*` keys live
	// here because this is the account surface, the same way `pill.*` keys live
	// in `copy-usage.ts`.
	//
	// Every key below that carries a `{reason}`/`{detail}` exists so a failure
	// says WHICH failure. The alternative — one "something went wrong" — is the
	// silent-failure class this repo's first red line names, and a sign-in button
	// that quietly does nothing is the worst place to have one.
	"device.title": "插件自有登录",
	"device.available": "不装桌面端也能用：在浏览器里批准一个码，插件把换来的可刷新令牌存在本机，只放在这个版本自己的文件里。",
	"device.signIn": "浏览器登录",
	"device.starting": "正在获取授权链接…",
	"device.waiting": "已打开授权页，等待批准（最多 5 分钟）",
	"device.reopen": "重新打开授权页",
	"device.signOut": "退出插件登录",
	"device.signingOut": "正在退出…",
	"device.state.ok": "插件已登录",
	"device.state.none": "本机没有插件自己的登录",
	"device.state.expired": "插件登录已过期——点「浏览器登录」重新授权",
	"device.state.unknown": "插件登录状态未知（宿主比本卡片新）",
	"device.renewFailed": "插件登录续期被拒：{reason}——点「浏览器登录」重新授权",
	"device.saveFailed": "插件登录续期成功，但没能写入本机文件：{reason}。当前会话照常用，重启后会失效——请检查磁盘与插件目录的写入权限",
	"device.unreadable": "插件保存的登录文件读不出来：{reason}",
	"device.startFailed": "打开授权页失败：{detail}",
	"device.loginFailed": "登录失败：{reason}",
	"device.loginExpired": "授权超时了，请重新点「浏览器登录」",
	"device.loginLost": "这次登录已经不在等待中了，请重新发起",
	"device.signOutFailed": "退出插件登录失败：{detail}",
	"device.signOutNote": "只删除插件自己的令牌；桌面端的登录、环境变量 PAT、另一个版本的文件都不受影响。"
};
/** English — account panel copy. */
export const enAccount = {
	"account.reload": "Re-read sign-in",
	"account.confirm": "Confirm online",
	"account.confirming": "Confirming…",
	"account.confirmed": "Confirmed: sign-in is valid",
	"account.confirmFailed": "Could not confirm: {detail}",
	// See the zh note above: the host's "no sign-in to check" verdict gets its
	// own sentence, instead of a colon followed by nothing.
	"account.confirmNoSignIn": "There is no sign-in to confirm for this edition — sign in first, or set an environment PAT (QODERCN_PAT / QODER_PAT)",
	"account.state.ok": "OK",
	"account.state.expired": "Expired",
	"account.state.needs-app": "Unreadable",
	"account.state.signed-out": "Not signed in",
	// See the zh note above: the plugin's own credential IS the sign-in in use
	// whenever the desktop application's cannot be read.
	"account.state.device": "Signed in",
	"account.deviceActive": "You are signed in with the plugin's own sign-in (browser sign-in) — the desktop client is not needed.",
	"account.deviceFrom": "from the plugin's own sign-in",
	"account.envPat": "from an environment PAT",
	"account.appFrom": "from {app}",
	"account.expiresAt": "Valid until {date}",
	"account.unsigned": "No Qoder client for this edition is installed on this machine",
	"account.expiredHint": "Sign-in has lapsed — sign in again in the Qoder client ({app}), then click Re-read sign-in",
	// See the zh note above: the remedy has to be valid everywhere, and the
	// browser sign-in is the one that is valid on a machine with no readable
	// desktop sign-in at all. It is offered only where the host reported the
	// plugin's own credential, because that is where the button is.
	"account.readFail": "Could not read the local credential: {detail}. Either set an environment PAT (QODERCN_PAT / QODER_PAT), or press Re-read sign-in",
	"account.readFailDevice": "Could not read the local credential: {detail}. Either press Sign in with a browser (the plugin's own sign-in, which works without the desktop client), or set an environment PAT (QODERCN_PAT / QODER_PAT), or press Re-read sign-in",
	"account.download": "The Qoder client is missing — install {edition} from the Download section, then sign in",
	"account.downloadLink": "Download {edition}",
	"account.confirmExpired": "Confirmed: sign-in expired — sign in again in the Qoder client, then re-read",
	// See the zh note: this is a shape change, not a lapsed sign-in.
	"account.confirmProtocolChanged": "Confirmation hit an unrecognised API shape — update the plugin (signing in again will not help)",
	"account.error": "Could not read the account states",
	"account.offer": "Offer this edition",
	"account.offerTitle": "Turning this off hides the edition's models from DSH's model picker; the sign-in, usage and model settings are kept, and turning it back on restores them.",
	"account.offerOff": "Disabled: this edition's models are not offered to the model picker",
	"account.offerError": "Could not save the edition switch: {detail}",
	"account.regionTabs": "Editions: pick which one's account, usage and models to view",
	// See the zh note above; these mirror those keys exactly.
	"device.title": "Plugin sign-in",
	"device.available": "Works without the desktop client: approve a code in your browser and the plugin stores the refreshable token it gets back, in this edition's own file only.",
	"device.signIn": "Sign in with a browser",
	"device.starting": "Getting the sign-in URL…",
	"device.waiting": "Authorization page opened — waiting for approval (up to 5 minutes)",
	"device.reopen": "Open the authorization page again",
	"device.signOut": "Sign out of the plugin",
	"device.signingOut": "Signing out…",
	"device.state.ok": "Signed in to the plugin",
	"device.state.none": "This machine has no plugin sign-in",
	"device.state.expired": "The plugin sign-in has expired — press Sign in with a browser to authorize again",
	"device.state.unknown": "The plugin sign-in is in a state this card does not know (the host is newer)",
	"device.renewFailed": "The plugin sign-in could not be renewed: {reason} — press Sign in with a browser to authorize again",
	"device.saveFailed": "The plugin sign-in renewed successfully but could not be written to disk: {reason} — this session keeps working, a restart will not; check that the plugin directory is writable",
	"device.unreadable": "The plugin's saved sign-in file cannot be read: {reason}",
	"device.startFailed": "Could not open the authorization page: {detail}",
	"device.loginFailed": "Sign-in failed: {reason}",
	"device.loginExpired": "The authorization timed out — press Sign in with a browser to start again",
	"device.loginLost": "That sign-in attempt is no longer pending — start it again",
	"device.signOutFailed": "Could not sign out of the plugin: {detail}",
	"device.signOutNote": "Only the plugin's own token is deleted; the desktop client's sign-in, an environment PAT, and the other edition's file are all untouched."
};
