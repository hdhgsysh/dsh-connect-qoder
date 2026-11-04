/**
 * Guard `requireInjected`, the one conversion from "an inject callback ran" to
 * "the service is present".
 *
 * Extracted from `activate()` so this is a real assertion rather than the
 * comment it used to defend. The behaviour that matters: a correct Host (the
 * service present) passes through unchanged, and a Host that fires the callback
 * WITHOUT the service throws — naming the service, instead of registering
 * routes into `undefined` and failing silently later (red line 1, AGENTS.md).
 */
// @ts-check

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requireInjected } from '../src/host/injected.ts'

test('a present service is returned unchanged, including a falsy one', () => {
  const server = { register() {} }
  assert.equal(requireInjected(server, 'webServer'), server, 'the very value is handed back')

  // Only `undefined` is refused. A host that answers with some other falsy
  // value is that host's contract violation to keep; rewriting it here would
  // hide the host's answer rather than surface it.
  assert.equal(requireInjected(null, 'webServer'), null)
  assert.equal(requireInjected(0, 'settings'), 0)
  assert.equal(requireInjected(false, 'settings'), false)
})

test('a missing service throws, naming the service', () => {
  assert.throws(
    () => requireInjected(undefined, 'webServer'),
    (error) => {
      assert.ok(error instanceof Error, 'the refusal is an Error, not a thrown string')
      assert.match(error.message, /ctx\.inject ran for 'webServer' without the service/)
      return true
    },
  )
  assert.throws(
    () => requireInjected(undefined, 'settings'),
    /ctx\.inject ran for 'settings' without the service/,
    'the throw names whichever service was asked for',
  )
})
