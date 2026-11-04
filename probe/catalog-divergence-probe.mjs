/**
 * 探针：目录落盘失败时，内存里的目录会不会先一步说谎？
 *
 * 为什么要问这个问题：兄弟插件 §40 那一类事故的签名是——`persist()` 把写盘失败
 * 吞掉了，而内存里的状态（entries / fetchedAt）已经先往前走了一步。于是「这份
 * 目录的唯一权威是磁盘」变成了「内存说自己新、磁盘说自己是旧的」，重启之后一切
 * 归零，界面上却一直显示"已更新"。本探针在**本仓**跑一遍这个签名，看它今天还
 * 在不在。
 *
 * 做法（跑真实模块，不 mock、不联网）：
 *   1. 把目录路径的父级做成一个**文件**，于是 `mkdirSync` 必然失败——写盘路径真的
 *      走不通（不是模拟一个错误）；
 *   2. 用真的 `CatalogStore.replace()` 写一条目录，再分别看内存（entries /
 *      fetchedAt / fresh()）与磁盘（文件到底存不存在）；
 *   3. 新开一个 store，看重启之后读回来的是什么（磁盘才是重启后的权威）；
 *   4. 走真的 `applyCatalogOutcome()`，看刷新结果是不是照样报 committed，以及
 *      失败有没有被标出来（`refreshFailed`）；
 *   5. 看 `!force && catalog.fresh()` 这道跳过闸会不会把下一轮非 force 轮询也跳过。
 *
 * 运行：node probe/catalog-divergence-probe.mjs
 *
 * 退出码：0 = 没找到这个签名（内存没有声称磁盘上没有的目录）；1 = 找到了——写盘
 * 失败时内存仍然算 fresh，下一轮非 force 轮询会被跳过。**2026-10-21 实测是 1**：
 * 这个状态还在。它没有被登记成 `docs/KNOWN_GAPS.md` 的一条，也没有任何门禁会跑
 * 这个探针；要收口它，先把它写进 gap 登记，并把本文件指过去。
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CatalogStore } from '../src/host/catalog-store.ts'
import { applyCatalogOutcome } from '../src/host/catalog-refresh.ts'

const root = mkdtempSync(join(tmpdir(), 'qoder-catalog-probe-'))
// Make the catalog path unwritable: its parent is a FILE, so mkdirSync fails.
const blocker = join(root, 'blocker')
writeFileSync(blocker, 'i am a file, not a directory')
const path = join(blocker, 'catalog.json')

// ① The live store advances memory even though the disk write failed.
const store = new CatalogStore({ path })
store.replace([{ id: 'a', key: 'a', name: 'A' }], Date.now())
console.log('[memory] entries=%d fetchedAt=%d fresh()=%s', store.entries.length, store.fetchedAt, store.fresh())
console.log('[disk] catalog file exists:', existsSync(path))
console.log('[store] lastSaveError set:', store.lastSaveError !== undefined)
const memoryClaimsUnwrittenCatalog = store.entries.length === 1 && !existsSync(path)
console.log('  -> memory claims a catalog the disk does not have:', memoryClaimsUnwrittenCatalog)

// ② A restart reads the disk: nothing there (or the old copy).
const store2 = new CatalogStore({ path })
console.log('[restart store] entries=%d fetchedAt=%d (disk is the authority on restart)', store2.entries.length, store2.fetchedAt)

// ③ The refresh-outcome fold reports "committed" even though nothing landed.
const runtime = { catalog: store, invalidate() {}, refreshFailed: undefined }
const outcome = applyCatalogOutcome(runtime, { ok: true, entries: [{ id: 'a', key: 'a', name: 'A' }] })
console.log('[applyCatalogOutcome] committed=%s refreshFailed=%s', outcome.committed, runtime.refreshFailed === undefined ? 'undefined' : runtime.refreshFailed.reason)

// ④ The skip gate `!force && catalog.fresh()` would skip the next poll.
const nextPollWouldBeSkipped = store.fresh() === true
console.log('[fresh() gate] a force=false poll would be skipped:', nextPollWouldBeSkipped)

rmSync(root, { recursive: true, force: true })

if (memoryClaimsUnwrittenCatalog && nextPollWouldBeSkipped) {
  console.log('FAIL the divergence is still here: the disk write failed, the memory says fresh, and the next poll is skipped')
  process.exit(1)
}
console.log('PASS no divergence: a failed write does not leave a fresher-looking memory behind')
