/**
 * Which credential path is serving a region.
 *
 * Three paths exist and they fail differently: the desktop application's own
 * sign-in (read out of its store, machine-bound, never renewable by us), the
 * credential this plugin obtained itself through a device login (portable,
 * renewable here), and a PAT the user exported into the environment. Once a
 * credential is loaded the three are structurally identical — the difference is
 * a tag — so the tag is the only thing that can say which road the request
 * actually travelled.
 *
 * The card used to work this out itself, from the account payload's `state` and
 * `source` fields. That is a guess: it cannot see which credential the runtime
 * resolved, only what each source looked like when the panel was rendered. The
 * host can see it, because the resolution is the host's. So the host says it,
 * and the card reads it.
 *
 * @module dsh-connect-qoder/credential-kind
 */
import type { LoadedCredential } from './credentials.ts'

/**
 * The three credential paths, named for the way a user would describe them.
 *
 * `desktop` is the Qoder desktop application, `device` is the plugin's own
 * sign-in, `env` is a PAT from the environment. The names are the ones the
 * surfaces use; the credential's own `source` tag is the implementation's.
 */
export type CredentialKind = 'desktop' | 'device' | 'env'

/**
 * The kind of the credential a region is being served by.
 *
 * @param credential - the credential that was resolved, or `undefined` when
 *   this machine has none.
 * @returns the path it came from, or `undefined` when there is no credential.
 */
export function credentialKindOf(credential: LoadedCredential | undefined): CredentialKind | undefined {
  if (credential === undefined) return undefined
  switch (credential.source) {
    case 'app':
      return 'desktop'
    case 'device':
      return 'device'
    case 'env-pat':
      return 'env'
  }
}
