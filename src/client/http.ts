/**
 * The card's only `fetch` surface.
 *
 * Every host-route read the card performs goes through here, so the request
 * contract lives in one place. The routes serve the plugin's own `lib/`, so they
 * are same-origin and answer JSON.
 *
 * Every call sends `accept: application/json` and `credentials: "same-origin"`
 * — the routes sit behind the loopback origin check in `src/host/routes.ts`.
 *
 * The shape of a failed response is decided here and nowhere else: a non-OK
 * status throws with the host's own `error` field when present, so the card's
 * catch blocks show the real reason (docs/issues/06). A `POST` body that will
 * not parse degrades to `undefined`, never a throw; a `GET` that will not parse
 * THROWS — the reads that use it have no "no data" state to fall back to.
 */

/**
 * The reason to report for a refused response.
 *
 * The host answers refusals in three shapes and all must reach the reader:
 * route gates write `{ error: "origin-not-trusted" }` (a bare string), the
 * device-login handlers write `{ error: "sign-out-failed", detail: "…" }`, and
 * `writeError` writes `{ error: { message, type, code } }`. Reading only the
 * first would turn every `writeError` refusal into a bare `HTTP 500`, and
 * dropping the second's `detail` names the failure without saying what happened
 * (docs/issues/06). A shape neither branch recognises still yields the status
 * code: naming the failure is the floor, never a fabricated reason.
 */
function failureMessage(value: unknown, status: number): string {
	const error = (value as { error?: unknown } | undefined)?.error;
	const detail = (value as { detail?: unknown } | undefined)?.detail;
	if (typeof error === "string" && error !== "" && typeof detail === "string" && detail !== "") return `${error}: ${detail}`;
	if (typeof error === "string" && error !== "") return error;
	const message = (error as { message?: unknown } | undefined | null)?.message;
	if (typeof message === "string" && message !== "") return message;
	return `HTTP ${status}`;
}

/** Read the host route at `path` and decode its JSON answer. */
export async function getJson<T = unknown>(path: string, options?: { signal?: AbortSignal | undefined }): Promise<T> {
	const response = await fetch(path, {
		headers: { accept: "application/json" },
		credentials: "same-origin",
		...(options?.signal === undefined ? {} : { signal: options.signal }),
	});
	const value = (await response.json().catch((): undefined => undefined)) as T | undefined;
	if (!response.ok) {
		// A refused GET can carry the host's own `error` — e.g. the loopback
		// origin check answers `{ error: "origin-not-trusted" }`. Surfacing it
		// is what the module doc above promises; throwing a bare "HTTP 403"
		// would hand the user a status code and drop the diagnosis.
		throw new Error(failureMessage(value, response.status));
	}
	if (value === undefined) throw new Error(`unparseable JSON body (HTTP ${response.status})`);
	return value as T;
}

/** POST to the host route at `path` and decode its JSON answer. */
export async function postJson<T = unknown>(path: string, body?: unknown): Promise<T> {
	const response = await fetch(path, {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/json" },
		credentials: "same-origin",
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const value = (await response.json().catch((): undefined => undefined)) as T | undefined;
	if (!response.ok) {
		throw new Error(failureMessage(value, response.status));
	}
	return value as T;
}
