#!/usr/bin/env node
// Drives bridge/chain-model.mjs's pure core against hand-built fixtures, then
// bridge/chains.mjs's per-session store against a temp directory. Hermetic:
// a temp directory, never WORLD_DIR.
//
// Run: node test/chain-harness.mjs   (or `just test-chain`)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, chmodSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const {
  CHAIN_VERSION, MAX_TURNS, MAX_BLOCKS, MAX_TERMS, TITLE_MAX, BLOCK_TURN_CAP,
  GAP_MS, TURN_TERMS, RECENT_MS, STOP, MAX_HISTORY, SUMMARY_MAX, PROGRESS_MAX,
  termsOf, jaccard, blankChain, sanitizeChain, assignTurn, compactChain, inheritableChainOf,
  windowOf, refinerInput, applyRefinement, CHAIN_SCHEMA, CHAIN_PREAMBLE,
} = await import(join(ROOT, 'syzygy', 'bridge', 'chain-model.mjs'))
const { createChains, chainPath, readChainFile, CHAINS_DIR, chainArgv, realSpawn } =
  await import(join(ROOT, 'syzygy', 'bridge', 'chains.mjs'))
const { HEADLESS_SETTINGS } = await import(join(ROOT, 'syzygy', 'bridge', 'canvas.mjs'))

let pass = 0
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label) }
const dir = () => mkdtempSync(join(tmpdir(), 'szg-chain-'))

console.log('chain harness')
console.log('-- chain-model.mjs --')

await ok('termsOf keeps real words, drops short filler and stop words', async () => {
  const terms = termsOf('Rewrite the relay so the pane stops flickering', [])
  assert.ok(terms.includes('rewrite'))
  assert.ok(terms.includes('relay'))
  assert.ok(terms.includes('pane'))
  assert.ok(terms.includes('flickering'))
  assert.ok(!terms.includes('the'), 'the is under four letters')
  assert.ok(!terms.includes('that'), 'that is a stop word')
})

await ok('termsOf puts file basenames first, ahead of any prompt words', async () => {
  const terms = termsOf('', ['/a/b/relay.mjs', '/a/b/canvas.js'])
  assert.deepEqual(terms, ['relay.mjs', 'canvas.js'],
    'a path is the strongest signal of a turn\'s subject and there are few of them -- a long prompt must not spend every slot before the files are even read')
})

await ok('termsOf is capped and has no duplicates', async () => {
  const longText = Array.from({ length: 50 }, (_, i) => `subjectword${i}`).join(' ')
  const manyFiles = Array.from({ length: 20 }, (_, i) => `/a/file${i}.mjs`)
  const terms = termsOf(longText, manyFiles)
  assert.ok(terms.length <= TURN_TERMS)
  assert.equal(new Set(terms).size, terms.length)
})

await ok('jaccard overlaps two term sets, 0 when either side is empty', async () => {
  assert.equal(jaccard(['a', 'b'], ['b', 'c']), 1 / 3)
  assert.equal(jaccard([], ['a']), 0)
  assert.equal(jaccard([], []), 0)
})

await ok('blankChain starts empty, at version, revision zero', async () => {
  const c = blankChain({ sessionId: 's1', startedAt: 1_700_000_000_000, now: 1_700_000_000_000 })
  assert.deepEqual(c.blocks, [])
  assert.equal(c.version, CHAIN_VERSION)
  assert.equal(c.rev, 0)
  assert.equal(c.refiner.calls, 0)
  assert.equal(c.resumedFrom, null)
})

// -- assignTurn: one clause of the boundary rule per case --

const openBlock = (over = {}) => ({
  id: 'b1', title: 'x', summary: '', state: 'open', by: 'heuristic', pinned: false, rev: 0,
  startedAt: 1_700_000_000_000, endedAt: 1_700_000_000_000, parent: null,
  turns: ['t0'], files: ['/a/relay.mjs'], terms: ['relay', 'flicker', 'pane'], progress: '',
  ...over,
})

await ok('assignTurn: the first turn on an empty chain opens a block', async () => {
  const d = assignTurn({ blocks: [] }, { promptHead: 'start something new here', files: [] }, 1_700_000_000_000)
  assert.deepEqual(d, { blockId: null, opened: true, why: 'first' })
})

await ok('assignTurn: a turn touching the open block\'s own file joins it', async () => {
  const chain = { blocks: [openBlock()] }
  const d = assignTurn(chain, {
    promptHead: 'still fixing that relay flicker',
    files: ['/a/relay.mjs'],
  }, 1_700_000_001_000)
  assert.equal(d.opened, false)
  assert.equal(d.why, 'join')
  assert.equal(d.blockId, 'b1')
})

await ok('assignTurn: a pivot phrase opens a new block even under perfect overlap', async () => {
  const chain = { blocks: [openBlock({ terms: ['pane'] })] }
  const d = assignTurn(chain, { promptHead: 'ok now the pane', files: [] }, 1_700_000_001_000)
  assert.equal(d.opened, true)
  assert.equal(d.why, 'pivot')
})

await ok('assignTurn: a turn long after the block went quiet reopens on a gap', async () => {
  const chain = { blocks: [openBlock()] }
  const d = assignTurn(chain, {
    promptHead: 'continuing the earlier discussion',
    files: [],
  }, 1_700_000_000_000 + 40 * 60_000)
  assert.equal(d.opened, true)
  assert.equal(d.why, 'gap')
})

await ok('assignTurn: a block at its turn cap opens the next one', async () => {
  const padded = openBlock({ turns: Array.from({ length: BLOCK_TURN_CAP }, (_, i) => 't' + i) })
  const chain = { blocks: [padded] }
  const d = assignTurn(chain, { promptHead: 'one more turn on this same topic', files: [] }, 1_700_000_001_000)
  assert.equal(d.opened, true)
  assert.equal(d.why, 'cap')
})

await ok('assignTurn: unrelated terms on an untouched file open a new block', async () => {
  const chain = { blocks: [openBlock()] }
  const d = assignTurn(chain, {
    promptHead: 'completely unrelated topic about something else entirely',
    files: ['/z/other.mjs'],
  }, 1_700_000_001_000)
  assert.equal(d.opened, true)
  assert.equal(d.why, 'terms')
})

await ok('assignTurn: the same unrelated terms but a shared file still joins', async () => {
  const chain = { blocks: [openBlock()] }
  const d = assignTurn(chain, {
    promptHead: 'completely unrelated topic about something else entirely',
    files: ['/a/relay.mjs', '/z/other.mjs'],
  }, 1_700_000_001_000)
  assert.equal(d.opened, false, 'the term clause needs BOTH an untouched file and low overlap')
})

await ok('assignTurn: a turn too short to judge joins rather than opening', async () => {
  const chain = { blocks: [openBlock()] }
  const d = assignTurn(chain, { promptHead: 'ok yes', files: [] }, 1_700_000_001_000)
  assert.equal(termsOf('ok yes', []).length < 3, true, 'fixture sanity: under MIN_TERMS')
  assert.equal(d.opened, false)
})

await ok('compactChain carries exactly the payload keys, newest blocks first', async () => {
  const blocks = Array.from({ length: 70 }, (_, i) => ({
    id: 'b' + i, title: 't' + i, summary: 'long summary text', state: i === 69 ? 'open' : 'closed',
    by: 'heuristic', pinned: false, rev: 0, startedAt: i, endedAt: i + 1, parent: null,
    turns: ['t' + i], files: [], terms: ['x'], progress: 'working on it',
  }))
  const chain = { blocks, rev: 3, updatedAt: 999, refiner: { paused: true } }
  const c = compactChain(chain)
  assert.deepEqual(
    Object.keys(c.blocks[0]).sort(),
    ['by', 'endedAt', 'id', 'parent', 'pinned', 'rev', 'startedAt', 'state', 'title', 'turnCount'],
  )
  assert.equal(c.blocks.length, 60, 'SNAPSHOT_BLOCKS caps the payload')
  assert.equal(c.blocks[c.blocks.length - 1].id, 'b69', 'the newest block survives the cap')
  assert.equal(c.blocks[0].id, 'b10', 'the oldest surviving block is the 60th from the end')
  assert.equal('summary' in c.blocks[0], false)
  assert.equal('turns' in c.blocks[0], false)
  assert.equal('terms' in c.blocks[0], false)
  assert.equal(c.open, 'b69')
  assert.equal(c.progress, 'working on it')
  assert.equal(c.rev, 3)
  assert.equal(c.refiner.paused, true)
})

await ok('sanitizeChain never throws and always yields a usable blocks array', async () => {
  assert.equal(sanitizeChain(null), null)
  assert.deepEqual(sanitizeChain({}).blocks, [])
  assert.deepEqual(sanitizeChain({ blocks: 'nope' }).blocks, [])
  assert.deepEqual(sanitizeChain({ blocks: [{ title: 'no id here' }] }).blocks, [])
  const withExtra = sanitizeChain({ blocks: [], someUnknownField: 'kept' })
  assert.equal(withExtra.someUnknownField, 'kept', 'an unknown field survives so the file stays hand-editable')
})

await ok('inheritableChainOf: one stale match under the same name and cwd is returned', async () => {
  const index = { old1: { name: 'alpha', cwd: '/w', updatedAt: 100, resumedFrom: null } }
  const found = inheritableChainOf(index, { name: 'alpha', repo: 'demo', cwd: '/w' }, new Set())
  assert.deepEqual(found, { sessionId: 'old1', entry: index.old1 })
})

await ok('inheritableChainOf: a live candidate is never inherited', async () => {
  const index = { old1: { name: 'alpha', cwd: '/w', updatedAt: 100, resumedFrom: null } }
  const found = inheritableChainOf(index, { name: 'alpha', repo: 'demo', cwd: '/w' }, new Set(['old1']))
  assert.equal(found, null)
})

await ok('inheritableChainOf: two stale candidates under one name is ambiguous', async () => {
  const index = {
    old1: { name: 'alpha', cwd: '/w', updatedAt: 100, resumedFrom: null },
    old2: { name: 'alpha', cwd: '/w', updatedAt: 200, resumedFrom: null },
  }
  const found = inheritableChainOf(index, { name: 'alpha', repo: 'demo', cwd: '/w' }, new Set())
  assert.equal(found, null)
})

await ok('inheritableChainOf: a different cwd is not a match', async () => {
  const index = { old1: { name: 'alpha', cwd: '/other', updatedAt: 100, resumedFrom: null } }
  const found = inheritableChainOf(index, { name: 'alpha', repo: 'demo', cwd: '/w' }, new Set())
  assert.equal(found, null)
})

console.log('-- chains.mjs --')

const freshChains = (over = {}) => {
  const base = dir()
  const store = createChains({ dir: base, now: () => 1_700_000_000_000, ...over })
  return { base, store }
}

const turnFor = (over = {}) => ({
  id: 't1', at: 1_700_000_000_000, durationMs: 500, reason: 'ok', origin: 'typed',
  promptHead: 'Rewrite the relay so the pane stops flickering', answerHead: 'Done, fixed the flicker',
  files: ['/a/relay.mjs'], tools: 1, subturns: 0,
  ...over,
})

/** Writes a chain straight to disk, bypassing the store -- the only way this
 *  harness can give a session a name and cwd, since `turn()` on a session
 *  with no chain yet always starts one blank (a registration path that
 *  supplies them belongs to a later piece of this feature). */
const writeRawChain = (base, sessionId, over = {}) => {
  const file = chainPath(base, sessionId)
  mkdirSync(dirname(file), { recursive: true })
  const chain = {
    version: 1, sessionId, name: 'alpha', cwd: '/w/one', root: '/w/one', transcript: '',
    startedAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, resumedFrom: null, rev: 0,
    blocks: [{
      id: 'ob1', title: 'earlier work', summary: '', state: 'open', by: 'heuristic', pinned: false, rev: 0,
      startedAt: 1_700_000_000_000, endedAt: 1_700_000_000_000, parent: null,
      turns: ['ot1'], files: ['/a/relay.mjs'], terms: ['relay'], progress: '',
    }],
    turns: {
      ot1: {
        id: 'ot1', at: 1_700_000_000_000, durationMs: 100, reason: 'ok', origin: 'typed',
        promptHead: 'earlier work', answerHead: 'done', files: ['/a/relay.mjs'], tools: 0, subturns: 0,
      },
    },
    history: [],
    refiner: { calls: 0, spentUsd: 0, lastAt: 0, day: '', paused: false },
    ...over,
  }
  writeFileSync(file, JSON.stringify(chain, null, 2))
  return chain
}

await ok('a first turn creates the file and answers ok/opened/why', async () => {
  const { base, store } = freshChains()
  const r = store.turn('s1', turnFor())
  assert.equal(r.ok, true)
  assert.equal(r.opened, true)
  assert.equal(r.why, 'first')
  assert.ok(existsSync(chainPath(base, 's1')))
})

await ok('the block opened by a first turn is titled from the prompt head', async () => {
  const { base, store } = freshChains()
  store.turn('s2', turnFor())
  const onDisk = JSON.parse(readFileSync(chainPath(base, 's2'), 'utf8'))
  assert.equal(onDisk.version, 1)
  assert.equal(onDisk.blocks.length, 1)
  assert.equal(onDisk.blocks[0].title, turnFor().promptHead.slice(0, TITLE_MAX))
  assert.equal(onDisk.blocks[0].summary, '')
})

await ok('an empty prompt head titles the block from the answer head', async () => {
  const { store } = freshChains()
  store.turn('s3', turnFor({ promptHead: '', answerHead: 'Fixed the pane flicker for good' }))
  const chain = store.get('s3')
  assert.equal(chain.blocks[0].title, 'Fixed the pane flicker for good'.slice(0, TITLE_MAX))
})

await ok('both heads empty titles the block untitled, never empty', async () => {
  const { store } = freshChains()
  store.turn('s4', turnFor({ promptHead: '', answerHead: '' }))
  const chain = store.get('s4')
  assert.equal(chain.blocks[0].title, 'untitled')
})

await ok('a second overlapping turn joins: turn ids in order, files unioned, endedAt advances', async () => {
  const { store } = freshChains()
  store.turn('s5', turnFor({ id: 't1' }))
  const r2 = store.turn('s5', turnFor({
    id: 't2', at: 1_700_000_010_000, promptHead: 'still on the relay flicker', files: ['/a/relay.mjs'],
  }))
  assert.equal(r2.opened, false)
  assert.equal(r2.why, 'join')
  const chain = store.get('s5')
  assert.equal(chain.blocks.length, 1)
  assert.deepEqual(chain.blocks[0].turns, ['t1', 't2'])
  assert.deepEqual(chain.blocks[0].files, ['/a/relay.mjs'])
  assert.equal(chain.blocks[0].endedAt, 1_700_000_010_000)
})

await ok('a block\'s terms are capped at MAX_TERMS, oldest dropped first', async () => {
  const { store } = freshChains()
  // Two new terms per turn (not one), so MAX_TERMS is exceeded well under
  // BLOCK_TURN_CAP turns -- otherwise the per-block turn cap would open a
  // second block long before the term cap ever had a chance to bite.
  store.turn('s6', turnFor({ id: 't1', promptHead: '', files: ['/a/relay.mjs', '/a/seeda0.mjs', '/a/seedb0.mjs'] }))
  const rounds = Math.ceil(MAX_TERMS / 2) + 2
  for (let i = 1; i <= rounds; i++) {
    store.turn('s6', turnFor({
      id: 't' + (i + 1), promptHead: '', files: ['/a/relay.mjs', `/a/seeda${i}.mjs`, `/a/seedb${i}.mjs`],
    }))
  }
  const chain = store.get('s6')
  assert.equal(chain.blocks.length, 1, 'every turn shares relay.mjs, so they all join one block')
  const terms = chain.blocks[0].terms
  assert.ok(terms.length <= MAX_TERMS)
  assert.ok(!terms.includes('seeda0.mjs'), 'the oldest term was dropped once the cap was hit')
  assert.ok(terms.includes(`seedb${rounds}.mjs`), 'the newest term survives')
})

await ok('a pivot opens a second block and closes the first, with no parent set', async () => {
  const { store } = freshChains()
  store.turn('s7', turnFor({ id: 't1' }))
  const r = store.turn('s7', turnFor({ id: 't2', at: 1_700_000_020_000, promptHead: 'ok now switch to something else' }))
  assert.equal(r.opened, true)
  assert.equal(r.why, 'pivot')
  const chain = store.get('s7')
  assert.equal(chain.blocks.length, 2)
  assert.equal(chain.blocks[0].state, 'closed')
  assert.equal(chain.blocks[0].endedAt, 1_700_000_020_000)
  assert.equal(chain.blocks[1].state, 'open')
  assert.equal(chain.blocks[1].parent, null, 'the automatic rule never sets a parent')
})

await ok('the write is atomic, write-through, and a throw leaves the file untouched', async () => {
  const { base, store } = freshChains()
  store.turn('s8', turnFor())
  const file = chainPath(base, 's8')
  assert.ok(existsSync(file), 'the file exists immediately after turn() returns')
  assert.ok(!existsSync(file + '.tmp'), 'no .tmp survives a successful write')
  const before = readFileSync(file, 'utf8')

  const chain = store.get('s8')
  // A cyclic value reaching the store through a field sanitizeChain carries
  // through unchanged -- get() hands back the live cached object on purpose,
  // so a caller (here, the harness) can do exactly this.
  chain.evilField = {}
  chain.evilField.self = chain.evilField

  assert.throws(() => store.pin('s8', chain.blocks[0].id, true))
  assert.equal(readFileSync(file, 'utf8'), before, 'a failed serialize leaves the previous file byte-identical')
  assert.ok(!existsSync(file + '.tmp'), 'the temp file from the failed write does not survive')
  const after = store.get('s8')
  assert.equal(after.blocks[0].pinned, false, 'the failed pin never applied')
})

await ok('a file that will not parse is moved aside and a fresh chain starts', async () => {
  const { base, store } = freshChains()
  const file = chainPath(base, 's9')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, 'not json at all {{{')

  let stderrLine = ''
  const origWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk) => { stderrLine += chunk; return true }
  const chain = store.get('s9')
  process.stderr.write = origWrite

  assert.equal(chain, null, 'no usable chain yet -- the bad file was set aside, not adopted')
  assert.ok(stderrLine.includes(file), 'the stderr line names the original path')
  assert.ok(stderrLine.includes('.bad-'), 'the stderr line names the aside path')
  const siblings = readdirSync(dirname(file)).filter((f) => f.startsWith('s9.json.bad-'))
  assert.equal(siblings.length, 1)
  assert.equal(readFileSync(join(dirname(file), siblings[0]), 'utf8'), 'not json at all {{{',
    'the aside file holds the original bytes')

  const r = store.turn('s9', turnFor())
  assert.equal(r.ok, true, 'a fresh chain starts on the next turn')
})

await ok('MAX_TURNS+1 turns leaves the oldest turn\'s id but drops its heads', async () => {
  const { store } = freshChains()
  const firstId = 't0'
  store.turn('s10', turnFor({
    id: firstId, promptHead: 'starting the very first turn here', answerHead: 'started', files: ['/a/relay.mjs'],
  }))
  for (let i = 1; i <= MAX_TURNS; i++) {
    store.turn('s10', turnFor({
      id: 't' + i, at: 1_700_000_000_000 + i * 1000,
      promptHead: 'still on relay work ' + i, answerHead: 'done ' + i, files: ['/a/relay.mjs'],
    }))
  }
  const chain = store.get('s10')
  assert.equal(Object.keys(chain.turns).length, MAX_TURNS + 1)
  const first = chain.turns[firstId]
  assert.ok(first, 'the oldest turn keeps its id in the map')
  assert.equal('promptHead' in first, false, 'its promptHead is gone')
  assert.equal('answerHead' in first, false, 'its answerHead is gone')
  const owner = chain.blocks.find((b) => b.turns.includes(firstId))
  assert.ok(owner, 'the oldest turn id is still in its block')
})

await ok('MAX_BLOCKS+1 blocks drops the oldest block entirely', async () => {
  const { store } = freshChains()
  store.turn('s11', turnFor({ id: 'b0-t1', promptHead: 'ok now open the very first block here' }))
  for (let i = 1; i <= MAX_BLOCKS; i++) {
    store.turn('s11', turnFor({ id: 'b' + i + '-t1', promptHead: 'ok now open block number ' + i }))
  }
  const chain = store.get('s11')
  assert.equal(chain.blocks.length, MAX_BLOCKS)
  assert.ok(!chain.blocks.some((b) => b.turns.includes('b0-t1')), 'the oldest block is dropped entirely')
  assert.equal('b0-t1' in chain.turns, false, 'its turn goes with it')
})

await ok('pin sets pinned and leaves by alone', async () => {
  const { store } = freshChains()
  store.turn('s12', turnFor())
  const before = store.get('s12').blocks[0]
  const r = store.pin('s12', before.id, true)
  assert.equal(r.ok, true)
  const after = store.get('s12').blocks[0]
  assert.equal(after.pinned, true)
  assert.equal(after.by, before.by)
  assert.equal(store.pin('s12', 'nope', true).ok, false, 'an unknown block refuses')
  assert.equal(store.pin('nope', before.id, true).ok, false, 'an unknown session refuses')
})

await ok('retitle sets by human and clamps to TITLE_MAX', async () => {
  const { store } = freshChains()
  store.turn('s13', turnFor())
  const id = store.get('s13').blocks[0].id
  const r = store.retitle('s13', id, 'x'.repeat(200))
  assert.equal(r.ok, true)
  const after = store.get('s13').blocks[0]
  assert.equal(after.title.length, TITLE_MAX)
  assert.equal(after.by, 'human')
})

await ok('merge(id, "prev") folds into the earlier block and refuses on the first block', async () => {
  const { store } = freshChains()
  store.turn('s14', turnFor({ id: 't1', at: 1_700_000_000_000, promptHead: 'opening the first block here', files: ['/a/one.mjs'] }))
  store.turn('s14', turnFor({ id: 't2', at: 1_700_000_100_000, promptHead: 'ok now switch to the second block', files: ['/a/two.mjs'] }))
  let chain = store.get('s14')
  const [firstId, secondId] = chain.blocks.map((b) => b.id)
  const firstStartedAt = chain.blocks[0].startedAt
  assert.equal(store.merge('s14', firstId, 'prev').ok, false, 'the first block has no previous block')
  const r = store.merge('s14', secondId, 'prev')
  assert.equal(r.ok, true)
  chain = store.get('s14')
  assert.equal(chain.blocks.length, 2, 'the absorbed block stays, marked merged')
  const survivor = chain.blocks.find((b) => b.id === firstId)
  const absorbed = chain.blocks.find((b) => b.id === secondId)
  assert.deepEqual(survivor.turns, ['t1', 't2'])
  assert.ok(survivor.files.includes('/a/one.mjs') && survivor.files.includes('/a/two.mjs'))
  assert.equal(absorbed.state, 'merged')
  assert.equal(survivor.by, 'human')
  assert.equal(survivor.startedAt, firstStartedAt, 'the survivor keeps the older startedAt')
})

await ok('merge(id, "next") is the mirror and refuses on the last block', async () => {
  const { store } = freshChains()
  store.turn('s15', turnFor({ id: 't1', promptHead: 'opening the first block here', files: ['/a/one.mjs'] }))
  store.turn('s15', turnFor({ id: 't2', promptHead: 'ok now switch to the second block', files: ['/a/two.mjs'] }))
  let chain = store.get('s15')
  const [firstId, secondId] = chain.blocks.map((b) => b.id)
  assert.equal(store.merge('s15', secondId, 'next').ok, false, 'the last block has no next block')
  const r = store.merge('s15', firstId, 'next')
  assert.equal(r.ok, true)
  chain = store.get('s15')
  const survivor = chain.blocks.find((b) => b.id === secondId)
  const absorbed = chain.blocks.find((b) => b.id === firstId)
  assert.deepEqual(survivor.turns, ['t1', 't2'])
  assert.equal(absorbed.state, 'merged')
})

await ok('split partitions a block\'s turns in order and refuses an unknown turn id', async () => {
  const { store } = freshChains()
  store.turn('s16', turnFor({ id: 't1', promptHead: 'opening the block', files: ['/a/relay.mjs'] }))
  store.turn('s16', turnFor({ id: 't2', promptHead: 'still on the relay work', files: ['/a/relay.mjs'] }))
  store.turn('s16', turnFor({ id: 't3', promptHead: 'still more relay work', files: ['/a/relay.mjs'] }))
  let chain = store.get('s16')
  const blockId = chain.blocks[0].id
  assert.equal(store.split('s16', blockId, 'nope').ok, false, 'an unknown turn id refuses')
  const r = store.split('s16', blockId, 't2')
  assert.equal(r.ok, true)
  chain = store.get('s16')
  assert.equal(chain.blocks.length, 2)
  assert.deepEqual(chain.blocks[0].turns, ['t1'])
  assert.deepEqual(chain.blocks[1].turns, ['t2', 't3'])
  assert.equal(chain.blocks[1].parent, chain.blocks[0].id)
})

await ok('payload carries live and recent chains, drops old ones but keeps them on disk', async () => {
  let clock = 1_700_000_000_000
  const { base, store } = freshChains({ now: () => clock })
  store.turn('old1', turnFor({ id: 't1' }))
  clock += RECENT_MS - 1000
  store.turn('recent1', turnFor({ id: 't1' }))
  clock += 2000
  store.turn('live1', turnFor({ id: 't1' }))
  const p = store.payload(new Set(['live1']))
  assert.ok('live1' in p, 'the live session is always in the payload')
  assert.ok('recent1' in p, 'a chain updated within RECENT_MS rides the payload with no live session')
  assert.equal('old1' in p, false, 'a chain older than RECENT_MS and no longer live is absent from the payload')
  assert.ok(existsSync(chainPath(base, 'old1')), '...but it is still on disk')
})

await ok('inherit copies blocks, sets resumedFrom, opens a restart block, and leaves the old file alone', async () => {
  const base = dir()
  writeRawChain(base, 'old-a', {})
  const store = createChains({ dir: base, now: () => 1_700_001_000_000 })
  const oldFile = chainPath(base, 'old-a')
  const oldBytes = readFileSync(oldFile, 'utf8')
  const r = store.inherit({ sessionId: 'new-a', name: 'alpha', repo: 'demo', cwd: '/w/one' }, new Set())
  assert.equal(r.from, 'old-a')
  assert.equal(readFileSync(oldFile, 'utf8'), oldBytes, 'the old file is left exactly where it is')
  const chain = store.get('new-a')
  assert.equal(chain.resumedFrom, 'old-a')
  assert.ok(chain.blocks.some((b) => b.id === 'ob1'), 'the stale chain\'s block was copied')
  const restart = chain.blocks[chain.blocks.length - 1]
  assert.equal(restart.title, 'restart')
  assert.equal(restart.state, 'open')
})

await ok('a live same-name session refuses inheritance', async () => {
  const base = dir()
  writeRawChain(base, 'old-b', {})
  const store = createChains({ dir: base, now: () => 1_700_001_000_000 })
  const r = store.inherit({ sessionId: 'new-b', name: 'alpha', repo: 'demo', cwd: '/w/one' }, new Set(['old-b']))
  assert.equal(r.from, null)
  assert.equal(store.get('new-b'), null, 'nothing was written')
})

await ok('two stale candidates under one name refuses inheritance', async () => {
  const base = dir()
  writeRawChain(base, 'old-c1', {})
  writeRawChain(base, 'old-c2', {})
  const store = createChains({ dir: base, now: () => 1_700_001_000_000 })
  const r = store.inherit({ sessionId: 'new-c', name: 'alpha', repo: 'demo', cwd: '/w/one' }, new Set())
  assert.equal(r.from, null)
})

await ok('a session that already has a chain never inherits, even a matching one', async () => {
  const base = dir()
  writeRawChain(base, 'old-d', {})
  const store = createChains({ dir: base, now: () => 1_700_001_000_000 })
  store.turn('new-d', turnFor({ id: 't1' }))
  const r = store.inherit({ sessionId: 'new-d', name: 'alpha', repo: 'demo', cwd: '/w/one' }, new Set())
  assert.equal(r.from, null)
})

await ok('a default name (equal to repo, or the basename of cwd) never inherits', async () => {
  const base1 = dir()
  writeRawChain(base1, 'old-e1', { name: 'demo', cwd: '/w/one' })
  const store1 = createChains({ dir: base1, now: () => 1_700_001_000_000 })
  const r1 = store1.inherit({ sessionId: 'new-e1', name: 'demo', repo: 'demo', cwd: '/w/one' }, new Set())
  assert.equal(r1.from, null, 'name equals repo, even though old-e1 matches exactly')

  const base2 = dir()
  writeRawChain(base2, 'old-e2', { name: 'one', cwd: '/w/one' })
  const store2 = createChains({ dir: base2, now: () => 1_700_001_000_000 })
  const r2 = store2.inherit({ sessionId: 'new-e2', name: 'one', repo: 'other-repo', cwd: '/w/one' }, new Set())
  assert.equal(r2.from, null, 'name equals the basename of cwd, even though old-e2 matches exactly')
})

await ok('a chain already named in another\'s resumedFrom is not a second candidate', async () => {
  const base = dir()
  writeRawChain(base, 'session-a', { name: 'alpha', cwd: '/w/one' })
  const store = createChains({ dir: base, now: () => 1_700_001_000_000 })
  const rb = store.inherit({ sessionId: 'session-b', name: 'alpha', repo: 'demo', cwd: '/w/one' }, new Set())
  assert.equal(rb.from, 'session-a')
  // session-a is still on disk and never re-registered as live, so a naive
  // "two stale candidates" reading of A and B would refuse C outright. The
  // rule instead excludes A -- already carried forward once -- and hands C
  // session-b.
  const rc = store.inherit({ sessionId: 'session-c', name: 'alpha', repo: 'demo', cwd: '/w/one' }, new Set())
  assert.equal(rc.from, 'session-b', 'C inherits B, not a refusal over two stale candidates')
})

console.log('-- the refiner: window, input, answer --')

const T = 1_700_000_000_000
const rTurn = (id, at, over = {}) => ({
  id, at, durationMs: 100, reason: 'ok', origin: 'typed',
  promptHead: 'prompt for ' + id, answerHead: 'answer for ' + id,
  files: ['/w/' + id + '.mjs'], tools: 1, subturns: 0,
  ...over,
})
const rBlock = (id, turnIds, turns, over = {}) => ({
  id, title: 'title ' + id, summary: '', state: 'closed', by: 'heuristic', pinned: false, rev: 0,
  startedAt: turns[turnIds[0]].at, endedAt: turns[turnIds[turnIds.length - 1]].at, parent: null,
  turns: [...turnIds], files: turnIds.map((t) => turns[t].files[0]), terms: [], progress: '',
  ...over,
})
/** Six blocks, oldest first: f1 and f2 are frozen, and w1, w2, w3 and the
 *  open block o make up the window. `over` patches blocks by id. */
const refinerChain = (over = {}) => {
  const turns = {}
  const at = { a1: 1000, a2: 2000, b1: 3000, b2: 4000, b3: 5000, b4: 6000, b5: 7000 }
  for (const [id, ms] of Object.entries(at)) turns[id] = rTurn(id, T + ms)
  const layout = [['f1', ['a1']], ['f2', ['a2']], ['w1', ['b1']], ['w2', ['b2']], ['w3', ['b3']], ['o', ['b4', 'b5']]]
  const blocks = layout.map(([id, ids]) =>
    rBlock(id, ids, turns, { ...(id === 'o' ? { state: 'open' } : {}), ...(over[id] ?? {}) }))
  return { ...blankChain({ sessionId: 'sess-secret', cwd: '/w/secret', startedAt: T, now: T }), blocks, turns }
}
const blockOf = (chain, id) => chain.blocks.find((b) => b.id === id)

await ok('windowOf is the open block and the three before it, oldest first', async () => {
  assert.deepEqual(windowOf(refinerChain()), ['w1', 'w2', 'w3', 'o'])
})

await ok('windowOf skips merged blocks and takes the whole of a short chain', async () => {
  const c = refinerChain()
  c.blocks.splice(4, 0, { ...c.blocks[3], id: 'mx', state: 'merged', turns: [] })
  assert.deepEqual(windowOf(c), ['w1', 'w2', 'w3', 'o'], 'a merged block takes no window slot')
  const short = refinerChain()
  short.blocks = short.blocks.slice(-2)
  assert.deepEqual(windowOf(short), ['w3', 'o'])
})

await ok('refinerInput carries heads and files only, never the session, cwd or transcript', async () => {
  const c = { ...refinerChain(), transcript: '/w/secret/transcript.jsonl' }
  c.turns.stray = rTurn('stray', T + 7500)
  const input = refinerInput(c)
  assert.deepEqual(Object.keys(input).sort(), ['blocks', 'loose'])
  assert.deepEqual(input.blocks.map((b) => b.id), ['w1', 'w2', 'w3', 'o'])
  for (const b of input.blocks) {
    assert.deepEqual(Object.keys(b).sort(), ['id', 'pinned', 'summary', 'title', 'turns'])
    for (const t of b.turns) assert.deepEqual(Object.keys(t).sort(), ['answerHead', 'files', 'id', 'promptHead'])
  }
  assert.deepEqual(input.blocks[3].turns.map((t) => t.id), ['b4', 'b5'], 'a turn carries its id so an answer can move it')
  assert.deepEqual(input.loose.map((t) => t.id), ['stray'], 'a turn no block names is loose')
  assert.deepEqual(Object.keys(input.loose[0]).sort(), ['answerHead', 'files', 'id', 'promptHead'])
  const text = JSON.stringify(input)
  for (const leak of ['sess-secret', '/w/secret', 'transcript.jsonl', 'durationMs', 'origin']) {
    assert.equal(text.includes(leak), false, `the child is never shown ${leak}`)
  }
})

await ok('applyRefinement applies a legal pass: attribution, revisions and one history entry', async () => {
  const c = refinerChain()
  const r = applyRefinement(c, {
    blocks: [
      { id: 'w2', title: 'Relay flicker' },
      { id: 'w3', title: 'title w3', summary: 'Settled the pane redraw.' },
    ],
    progress: 'writing the harness',
  }, T + 9000)
  assert.deepEqual(r.refused, [])
  assert.equal(blockOf(r.chain, 'w2').title, 'Relay flicker')
  assert.equal(blockOf(r.chain, 'w3').summary, 'Settled the pane redraw.')
  for (const id of ['w2', 'w3']) {
    assert.equal(blockOf(r.chain, id).by, 'model')
    assert.equal(blockOf(r.chain, id).rev, 1)
  }
  assert.equal(blockOf(r.chain, 'w1').by, 'heuristic', 'an untouched block keeps its attribution')
  assert.equal(blockOf(r.chain, 'w1').rev, 0)
  assert.equal(blockOf(r.chain, 'o').progress, 'writing the harness')
  assert.equal(r.chain.rev, c.rev + 1)
  assert.equal(r.chain.history.length, 1)
  const h = r.chain.history[0]
  assert.deepEqual(Object.keys(h).sort(), ['at', 'blocks', 'rev'])
  assert.equal(h.at, T + 9000)
  assert.equal(h.rev, r.chain.rev)
  for (const b of h.blocks) assert.deepEqual(Object.keys(b).sort(), ['id', 'state', 'title'])
  assert.ok(h.blocks.some((b) => b.id === 'w2' && b.title === 'Relay flicker'), 'history holds the chain after the pass')
  assert.ok(r.applied.length >= 3)
})

await ok('applyRefinement: progress alone moves no attribution, revision or history', async () => {
  const c = refinerChain({ o: { pinned: true } })
  const r = applyRefinement(c, { blocks: [], progress: 'still going' }, T + 9000)
  assert.deepEqual(r.refused, [])
  assert.equal(blockOf(r.chain, 'o').progress, 'still going', 'progress is a status line, not a rewrite, so a pin does not hold it')
  assert.equal(blockOf(r.chain, 'o').by, 'heuristic')
  assert.equal(r.chain.rev, c.rev)
  assert.equal(r.chain.history.length, 0)
})

await ok('applyRefinement: an answer that only echoes a block changes nothing and refuses nothing', async () => {
  const c = refinerChain({ w1: { pinned: true } })
  const r = applyRefinement(c, { blocks: [{ id: 'w1', title: 'title w1', summary: '', turns: ['b1'] }] }, T + 9000)
  assert.deepEqual(r.refused, [], 'repeating a pinned block exactly as shown is not a change to it')
  assert.deepEqual(r.applied, [])
  assert.equal(r.chain.rev, c.rev)
})

await ok('history is capped at MAX_HISTORY, oldest dropped', async () => {
  const c = refinerChain()
  c.rev = MAX_HISTORY
  c.history = Array.from({ length: MAX_HISTORY }, (_, i) => ({ at: i, rev: i, blocks: [] }))
  const r = applyRefinement(c, { blocks: [{ id: 'w1', title: 'Renamed' }] }, T + 9000)
  assert.equal(r.chain.history.length, MAX_HISTORY)
  assert.equal(r.chain.history[0].rev, 1, 'the oldest entry went')
  assert.equal(r.chain.history[MAX_HISTORY - 1].rev, MAX_HISTORY + 1, 'the newest entry is this pass')
})

const refusalCases = [
  ['a change to a pinned block', { w1: { pinned: true } },
    { blocks: [{ id: 'w1', title: 'Renamed' }] }, 'w1', 'pinned'],
  ['a change to a hand-edited block', { w1: { by: 'human' } },
    { blocks: [{ id: 'w1', title: 'Renamed' }] }, 'w1', 'human'],
  ['a change to a block outside the window', {},
    { blocks: [{ id: 'f2', title: 'Renamed' }] }, 'f2', 'out-of-window'],
  ['a turn taken from outside the window', {},
    { blocks: [{ id: 'w2', title: 'title w2', turns: ['b2', 'a2'] }] }, 'w2', 'turn-out-of-window'],
  ['an unknown block id', {},
    { blocks: [{ id: 'nope', title: 'Renamed' }] }, 'nope', 'unknown-block'],
  ['an unknown turn id', {},
    { blocks: [{ id: 'w2', title: 'title w2', turns: ['b2', 'nope'] }] }, 'w2', 'unknown-turn'],
  ['a turn taken out of a pinned block', { w2: { pinned: true } },
    { blocks: [{ id: 'w1', title: 'title w1', turns: ['b1', 'b2'] }] }, 'w1', 'pinned'],
  ['a merge of two blocks that are not neighbours', {},
    { merges: [['w1', 'w3']] }, 'w1+w3', 'not-neighbours'],
  ['a merge naming a pinned block', { w2: { pinned: true } },
    { merges: [['w1', 'w2']] }, 'w1+w2', 'pinned'],
  ['a merge across the edge of the window', {},
    { merges: [['f2', 'w1']] }, 'f2+w1', 'out-of-window'],
  ['a title over TITLE_MAX', {},
    { blocks: [{ id: 'w1', title: 'x'.repeat(TITLE_MAX + 1) }] }, 'w1', 'too-long'],
  ['a summary over SUMMARY_MAX', {},
    { blocks: [{ id: 'w1', title: 'title w1', summary: 'x'.repeat(SUMMARY_MAX + 1) }] }, 'w1', 'too-long'],
  ['a progress line over PROGRESS_MAX', {},
    { progress: 'x'.repeat(PROGRESS_MAX + 1) }, 'o', 'too-long'],
  ['a new block with no turns', {},
    { blocks: [{ id: null, title: 'Nothing in it', turns: [] }] }, null, 'empty'],
  ['one turn claimed by two blocks', {},
    { blocks: [{ id: 'w1', title: 'title w1', turns: ['b1', 'b5'] }, { id: 'w2', title: 'title w2', turns: ['b2', 'b5'] }] },
    'w2', 'duplicate-turn'],
]

for (const [label, over, answer, id, reason] of refusalCases) {
  await ok(`applyRefinement refuses ${label}, and the rest of the pass still applies`, async () => {
    const c = refinerChain(over)
    const r = applyRefinement(c, { ...answer, blocks: [...(answer.blocks ?? []), { id: 'w3', title: 'Still applies' }] }, T + 9000)
    assert.deepEqual(r.refused, [{ id, why: reason }])
    assert.equal(blockOf(r.chain, 'w3').title, 'Still applies', 'a refusal is never fatal to the pass')
    const before = id ? blockOf(c, id) : null
    if (before) {
      const after = blockOf(r.chain, id)
      assert.equal(after.title, before.title, 'the refused title did not land')
      assert.equal(after.summary, before.summary)
      assert.deepEqual(after.turns, before.turns, 'the refused turns did not move')
      assert.equal(after.progress, before.progress)
    }
  })
}

await ok('applyRefinement applies one merge per pass and refuses the second', async () => {
  const r = applyRefinement(refinerChain(), { merges: [['w1', 'w2'], ['w3', 'o']] }, T + 9000)
  assert.deepEqual(r.refused, [{ id: 'w3+o', why: 'one-merge' }])
  assert.deepEqual(blockOf(r.chain, 'w1').turns, ['b1', 'b2'])
  assert.equal(blockOf(r.chain, 'w1').by, 'model')
  assert.equal(blockOf(r.chain, 'w2').state, 'merged')
  assert.equal(blockOf(r.chain, 'w3').state, 'closed')
  assert.equal(blockOf(r.chain, 'o').state, 'open')
})

await ok('two frozen neighbours outside the window merge, and the survivor keeps the older startedAt', async () => {
  const c = refinerChain()
  const r = applyRefinement(c, { merges: [['f2', 'f1']] }, T + 9000)
  assert.deepEqual(r.refused, [])
  const survivor = blockOf(r.chain, 'f1')
  assert.deepEqual(survivor.turns, ['a1', 'a2'])
  assert.equal(survivor.startedAt, blockOf(c, 'f1').startedAt)
  assert.equal(survivor.endedAt, blockOf(c, 'f2').endedAt)
  assert.equal(survivor.state, 'closed')
  assert.equal(blockOf(r.chain, 'f2').state, 'merged')
  assert.deepEqual(windowOf(r.chain), ['w1', 'w2', 'w3', 'o'], 'a frozen merge leaves the window where it was')
})

await ok('a turn moved between window blocks lands in time order, and an emptied block becomes merged', async () => {
  const r = applyRefinement(refinerChain(), { blocks: [{ id: 'w3', title: 'title w3', turns: ['b3', 'b2'] }] }, T + 9000)
  assert.deepEqual(r.refused, [])
  const w3 = blockOf(r.chain, 'w3')
  assert.deepEqual(w3.turns, ['b2', 'b3'])
  assert.ok(w3.files.includes('/w/b2.mjs'), 'the moved turn brings its files')
  assert.equal(w3.startedAt, T + 4000)
  const w2 = blockOf(r.chain, 'w2')
  assert.equal(w2.state, 'merged', 'an emptied block stays, so its id still resolves')
  assert.deepEqual(w2.turns, [])
  assert.ok(r.chain.history[0].blocks.some((b) => b.id === 'w2' && b.state === 'merged'))
})

await ok('an id of null opens a model block from window turns, placed by its first turn', async () => {
  const tail = applyRefinement(refinerChain(), {
    blocks: [{ id: null, title: 'Split off', summary: 'The tail end.', turns: ['b5'] }],
  }, T + 9000)
  assert.deepEqual(tail.refused, [])
  const ids = tail.chain.blocks.map((b) => b.id)
  assert.equal(ids.length, 7)
  const fresh = tail.chain.blocks[6]
  assert.ok(!['f1', 'f2', 'w1', 'w2', 'w3', 'o'].includes(fresh.id), 'the new block has an id of its own')
  assert.equal(fresh.title, 'Split off')
  assert.equal(fresh.by, 'model')
  assert.deepEqual(fresh.turns, ['b5'])
  assert.equal(fresh.state, 'open', 'a block placed after the open one takes the open state')
  assert.equal(blockOf(tail.chain, 'o').state, 'closed')
  assert.deepEqual(blockOf(tail.chain, 'o').turns, ['b4'])

  const middle = applyRefinement(refinerChain(), {
    blocks: [{ id: null, title: 'Middle', turns: ['b3'] }],
  }, T + 9000)
  const order = middle.chain.blocks.filter((b) => b.state !== 'merged').map((b) => b.id)
  assert.equal(order[order.length - 1], 'o', 'the open block is still last')
  assert.equal(blockOf(middle.chain, 'o').state, 'open')
  const placed = middle.chain.blocks.find((b) => b.title === 'Middle')
  assert.equal(placed.state, 'closed')
  assert.equal(middle.chain.blocks.indexOf(placed), middle.chain.blocks.indexOf(blockOf(middle.chain, 'o')) - 1)
})

await ok('a loose turn can be taken into a window block', async () => {
  const c = refinerChain()
  c.turns.stray = rTurn('stray', T + 7500)
  const r = applyRefinement(c, { blocks: [{ id: 'o', title: 'title o', turns: ['b4', 'b5', 'stray'] }] }, T + 9000)
  assert.deepEqual(r.refused, [])
  assert.deepEqual(blockOf(r.chain, 'o').turns, ['b4', 'b5', 'stray'])
})

await ok('applyRefinement never mutates the chain it is given', async () => {
  const c = refinerChain()
  c.turns.stray = rTurn('stray', T + 7500)
  const before = structuredClone(c)
  applyRefinement(c, {
    blocks: [
      { id: 'w1', title: 'Renamed', summary: 'Now summarised.', turns: ['b1', 'stray'] },
      { id: 'w3', title: 'title w3', turns: ['b3', 'b2'] },
      { id: null, title: 'Split off', turns: ['b5'] },
      { id: 'f1', title: 'refused' },
    ],
    progress: 'moving',
    merges: [['f1', 'f2']],
  }, T + 9000)
  assert.deepEqual(c, before)
})

await ok('applyRefinement survives an answer that is not the shape it asked for', async () => {
  const c = refinerChain()
  for (const junk of [null, 'text', 42, [], { blocks: 'no' }, { blocks: [null, 7, 'x'] }, { merges: 'no' }, { merges: [7] }]) {
    const r = applyRefinement(c, junk, T + 9000)
    assert.ok(Array.isArray(r.refused))
    assert.deepEqual(r.chain.blocks, c.blocks)
  }
})

await ok('CHAIN_SCHEMA closes every object, and CHAIN_PREAMBLE carries the whole job and cites nothing', async () => {
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'object') assert.equal(node.additionalProperties, false)
    for (const v of Object.values(node)) walk(v)
  }
  walk(CHAIN_SCHEMA)
  assert.equal(CHAIN_SCHEMA.properties.blocks.items.properties.title.maxLength, TITLE_MAX)
  // It replaces the default system prompt, so every rule the child must follow is in it.
  for (const must of ['schema', 'not shown', 'pinned', 'by hand', 'the reader', 'one merge', 'neighbouring', 'no tools']) {
    assert.ok(CHAIN_PREAMBLE.includes(must), `the preamble says "${must}"`)
  }
  const cites = new RegExp([String.fromCharCode(0xa7), '\\d{4}-\\d{2}-\\d{2}', 'the\\shuman', 'docs\\/'].join('|'), 'i')
  assert.equal(cites.test(CHAIN_PREAMBLE), false)
})

await ok('chainArgv is an argv array: no tools, its own system prompt, low effort, no session file, the input text last', async () => {
  const argv = chainArgv({ text: 'INPUT TEXT', model: 'sonnet', budgetUsd: 0.15, safeMode: true })
  assert.ok(Array.isArray(argv))
  assert.deepEqual(argv.slice(0, 3), ['-p', '--output-format', 'json'])
  assert.ok(argv.includes('--safe-mode'))
  const after = (flag) => argv[argv.indexOf(flag) + 1]
  assert.ok(argv.includes('--tools'))
  assert.equal(after('--tools'), '', '--tools is followed by an empty argv element, which disables every tool')
  assert.equal(argv.filter((a) => a === '').length, 1, 'the only empty element is the one after --tools')
  for (const variadic of ['--tools', '--disallowedTools']) {
    const i = argv.indexOf(variadic)
    if (i === -1) continue
    assert.ok(String(argv[i + 2]).startsWith('--'), `a flag follows ${variadic}'s value, so the input can never be read as a tool name`)
  }
  assert.equal(after('--settings'), HEADLESS_SETTINGS)
  assert.equal(after('--model'), 'sonnet')
  assert.equal(after('--max-budget-usd'), '0.15')
  assert.equal(after('--effort'), 'low')
  assert.ok(argv.includes('--no-session-persistence'))
  assert.equal(after('--json-schema'), JSON.stringify(CHAIN_SCHEMA))
  assert.equal(after('--system-prompt'), CHAIN_PREAMBLE)
  assert.equal(argv.includes('--append-system-prompt'), false, 'the preamble replaces the default system prompt')
  assert.equal(argv[argv.length - 1], 'INPUT TEXT')
  assert.equal(argv.includes('--verbose'), false, 'the schema form does not take --verbose')
  assert.equal(argv.includes('--'), false)
  assert.equal(chainArgv({ text: 'x', model: 'sonnet', budgetUsd: 0.15, safeMode: false }).includes('--safe-mode'), false)
  assert.equal(typeof realSpawn, 'function')
})

console.log('-- the refiner: the child --')

const until = async (fn, ms = 10_000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 20))
  }
}
const fakeDir = mkdtempSync(join(tmpdir(), 'szg-chain-fake-'))
let fakeSeq = 0
/** A tiny real node script standing in for `claude`. */
const fakeScript = (src) => {
  const p = join(fakeDir, `fake-${fakeSeq++}.mjs`)
  writeFileSync(p, src)
  return p
}
const printing = (obj, { pretty = false, delayMs = 0, code = 0 } = {}) => {
  const out = pretty ? JSON.stringify(obj, null, 2) + '\n' : JSON.stringify(obj) + '\n'
  return fakeScript(`setTimeout(() => { process.stdout.write(${JSON.stringify(out)}); process.exitCode = ${code} }, ${delayMs})\n`)
}
/** A `run` that spawns whichever script `scriptFor(n)` names in place of the
 *  binary it was asked for, and records what it was asked for. */
const fakeRun = (scriptFor) => {
  const calls = []
  const run = (bin, argv, opts) => {
    calls.push({ bin, argv, opts })
    return spawn(process.execPath, [scriptFor(calls.length)], opts)
  }
  return { run, calls }
}
const refinerStore = (over = {}, setup = null) => {
  let clock = T
  const entries = []
  const capture = { append: (kind, actor, payload) => { entries.push([kind, actor, payload]); return true } }
  const base = dir()
  if (setup) setup(base)
  const store = createChains({ dir: base, now: () => clock, capture, ...over })
  return { store, base, entries, setClock: (ms) => { clock = ms }, advance: (ms) => { clock += ms } }
}
const openIdOf = (store, sid) => store.get(sid).blocks.find((b) => b.state === 'open').id
const resultFor = (store, sid, usd = 0.012) => ({
  type: 'result',
  result: { blocks: [{ id: openIdOf(store, sid), title: 'Relay flicker', summary: 'Fixed the redraw.' }], progress: 'done' },
  total_cost_usd: usd,
})

await ok('refine applies a one-line result frame and books the call', async () => {
  let script = ''
  const { run, calls } = fakeRun(() => script)
  const h = refinerStore({ run })
  h.store.turn('s1', turnFor({ id: 't1', at: T }))
  script = printing(resultFor(h.store, 's1'))
  process.env.SZG_CHAIN_LEAK_PROBE = '1'
  let r
  try { r = await h.store.refine('s1') } finally { delete process.env.SZG_CHAIN_LEAK_PROBE }
  assert.equal(r.ok, true, r.error)
  assert.equal(r.usd, 0.012)
  assert.deepEqual(r.refused, [])
  const chain = h.store.get('s1')
  assert.equal(chain.blocks[0].title, 'Relay flicker')
  assert.equal(chain.blocks[0].summary, 'Fixed the redraw.')
  assert.equal(chain.blocks[0].by, 'model')
  assert.equal(chain.blocks[0].progress, 'done')
  assert.equal(chain.refiner.calls, 1)
  assert.equal(chain.refiner.spentUsd, 0.012)
  assert.equal(chain.refiner.lastAt, T)
  assert.match(chain.refiner.day, /^\d{4}-\d{2}-\d{2}$/)
  assert.deepEqual(h.entries, [['chain', 's1', { calls: 1, usd: 0.012, refused: 0 }]])
  assert.equal(calls.length, 1)
  const { bin, argv, opts } = calls[0]
  assert.equal(bin, 'claude')
  assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(Object.keys(opts.env).some((k) => k.startsWith('SZG_')), false, 'no SZG_ variable reaches the child')
  const text = argv[argv.length - 1]
  assert.equal(text.startsWith('-'), false, 'the input can never parse as a flag')
  const shown = JSON.parse(text.slice(text.indexOf('\n') + 1))
  assert.deepEqual(Object.keys(shown).sort(), ['blocks', 'loose'])
  const onDisk = JSON.parse(readFileSync(chainPath(h.base, 's1'), 'utf8'))
  assert.equal(onDisk.blocks[0].title, 'Relay flicker', 'the applied pass was written through')
  assert.deepEqual(await h.store.refine('s1'), { ok: false, error: 'nothing new' },
    'with no turn since the last pass only a forced refine runs')
})

await ok('refine applies the same result pretty-printed across several lines', async () => {
  let script = ''
  const { run } = fakeRun(() => script)
  const h = refinerStore({ run })
  h.store.turn('s1', turnFor({ id: 't1', at: T }))
  script = printing(resultFor(h.store, 's1'), { pretty: true })
  const r = await h.store.refine('s1')
  assert.equal(r.ok, true, r.error)
  assert.equal(h.store.get('s1').blocks[0].title, 'Relay flicker')
  assert.equal(h.store.get('s1').refiner.spentUsd, 0.012)
})

await ok('a string result is parsed as JSON', async () => {
  let script = ''
  const { run } = fakeRun(() => script)
  const h = refinerStore({ run })
  h.store.turn('s1', turnFor({ id: 't1', at: T }))
  const frame = resultFor(h.store, 's1')
  script = printing({ ...frame, result: JSON.stringify(frame.result) })
  const r = await h.store.refine('s1')
  assert.equal(r.ok, true, r.error)
  assert.equal(h.store.get('s1').blocks[0].title, 'Relay flicker')
})

await ok('refine reads the CLI\'s own success frame: structured_output beside a JSON-string result', async () => {
  let script = ''
  const { run } = fakeRun(() => script)
  const h = refinerStore({ run })
  h.store.turn('s1', turnFor({ id: 't1', at: T, promptHead: 'The relay pane flickers on every snapshot', files: ['/w/app.js'] }))
  h.store.turn('s1', turnFor({ id: 't2', at: T + 60_000, promptHead: 'ok now write the release notes for this', files: ['/w/CHANGELOG.md'] }))
  const [first, second] = h.store.get('s1').blocks.map((b) => b.id)
  const answer = {
    blocks: [{ id: first, title: 'Fixed flickering in the relay pane', summary: 'Keyed reconciliation replaced the list rebuild.', state: 'closed' }],
    merges: [[first, second]],
    progress: 'Merged the fix and its release notes',
  }
  const frame = {
    type: 'result', subtype: 'success', is_error: false, num_turns: 3, stop_reason: 'tool_use',
    terminal_reason: 'completed', permission_denials: [], session_id: 'x', usage: { output_tokens: 1681 },
    result: JSON.stringify(answer), structured_output: answer, total_cost_usd: 0.0181865,
  }
  script = printing(frame)
  const r = await h.store.refine('s1')
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(r.refused, [])
  const chain = h.store.get('s1')
  const survivor = blockOf(chain, first)
  assert.equal(survivor.title, 'Fixed flickering in the relay pane')
  assert.deepEqual(survivor.turns, ['t1', 't2'])
  assert.equal(survivor.state, 'open', 'the survivor of a merge with the open block is open')
  assert.equal(blockOf(chain, second).state, 'merged')
  assert.equal(survivor.progress, 'Merged the fix and its release notes')
  assert.equal(chain.refiner.spentUsd, 0.0181865)

  script = printing({ ...frame, result: 'Done.', structured_output: { ...answer, merges: [], progress: 'prose result, object answer' } })
  const again = await h.store.refine('s1', { force: true })
  assert.equal(again.ok, true, again.error)
  assert.equal(blockOf(h.store.get('s1'), first).progress, 'prose result, object answer', 'structured_output wins over a prose result')
})

await ok('over the day cap refine does not spawn and the chain reads paused; a new day resets it', async () => {
  let script = ''
  const { run, calls } = fakeRun(() => script)
  const h = refinerStore({ run, dayUsd: 0.02 })
  h.store.turn('s1', turnFor({ id: 't1', at: T }))
  script = printing(resultFor(h.store, 's1'))
  assert.equal((await h.store.refine('s1', { force: true })).ok, true)
  assert.equal((await h.store.refine('s1', { force: true })).ok, true)
  assert.equal(calls.length, 2)
  assert.ok(Math.abs(h.store.get('s1').refiner.spentUsd - 0.024) < 1e-9)
  const r = await h.store.refine('s1', { force: true })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'budget')
  assert.match(r.reason, /\$0\.02 today across every session; its day cap is \$0\.02$/, 'the refusal names the spend and the cap')
  assert.equal(calls.length, 2, 'the call over the cap never spawned, force or not')
  assert.equal(h.store.payload(new Set(['s1'])).s1.refiner.paused, true)

  h.advance(24 * 60 * 60_000)
  const next = await h.store.refine('s1', { force: true })
  assert.equal(next.ok, true, next.error)
  assert.equal(calls.length, 3)
  const refiner = h.store.get('s1').refiner
  assert.equal(refiner.calls, 1, 'a new day starts the count again')
  assert.equal(refiner.spentUsd, 0.012)
  assert.equal(refiner.paused, false)
  assert.equal(h.store.payload(new Set(['s1'])).s1.refiner.paused, false)
})

await ok('the day cap is relay-wide: two sessions spend one total, and a refused session reads paused', async () => {
  let script = ''
  const { run, calls } = fakeRun(() => script)
  const h = refinerStore({ run, dayUsd: 0.02 })
  h.store.turn('s1', turnFor({ id: 't1', at: T }))
  h.store.turn('s2', turnFor({ id: 't1', at: T }))
  h.store.turn('s3', turnFor({ id: 't1', at: T }))
  script = printing(resultFor(h.store, 's1'))
  assert.equal((await h.store.refine('s1')).ok, true)
  script = printing(resultFor(h.store, 's2'))
  assert.equal((await h.store.refine('s2')).ok, true)
  assert.equal(calls.length, 2)
  assert.equal(h.store.get('s1').refiner.spentUsd, 0.012, 'per-session spend is kept for display')
  assert.equal(h.store.get('s2').refiner.spentUsd, 0.012)
  assert.equal(h.store.get('s1').refiner.paused, false, 'under the cap when it booked')
  assert.equal(h.store.get('s2').refiner.paused, true, 'the booking that crossed the cap pauses its chain')
  for (const sid of ['s3', 's1']) {
    const r = await h.store.refine(sid, { force: true })
    assert.equal(r.error, 'budget', `${sid} is refused on the other sessions' spend`)
    assert.match(r.reason, /\$0\.02 today/)
  }
  assert.equal(calls.length, 2, 'neither refused session spawned')
  assert.equal(h.store.get('s1').refiner.paused, true)
  assert.equal(h.store.payload(new Set(['s3'])).s3.refiner.paused, true)
})

await ok('the day total survives a restart: a new store seeds it from every chain booked today', async () => {
  let script = ''
  const { run, calls } = fakeRun(() => script)
  const h = refinerStore({ run, dayUsd: 0.02 })
  h.store.turn('s1', turnFor({ id: 't1', at: T }))
  h.store.turn('s2', turnFor({ id: 't1', at: T }))
  script = printing(resultFor(h.store, 's1'))
  await h.store.refine('s1')
  script = printing(resultFor(h.store, 's2'))
  await h.store.refine('s2')
  assert.equal(calls.length, 2)

  let clock = T
  const again = createChains({ dir: h.base, now: () => clock, run, dayUsd: 0.02 })
  assert.equal((await again.refine('s1', { force: true })).error, 'budget', 'the restarted relay remembers today')
  assert.equal(calls.length, 2)
  clock = T + 24 * 60 * 60_000
  script = printing(resultFor(again, 's1'))
  assert.equal((await again.refine('s1', { force: true })).ok, true, 'and forgets it the next day')
  assert.equal(calls.length, 3)

  const other = refinerStore({ run, dayUsd: 0.02 }, (base) => writeRawChain(base, 'old1', {
    refiner: { calls: 9, spentUsd: 5, lastAt: 0, day: new Date(T - 30 * 24 * 60 * 60_000).toISOString().slice(0, 10), paused: true },
  }))
  script = printing({ type: 'result', result: { blocks: [] }, total_cost_usd: 0.001 })
  assert.equal((await other.store.refine('old1', { force: true })).ok, true, 'a booking from another day seeds nothing')
})

await ok('a child that reports no cost books its whole per-call budget; one that never spawned books nothing', async () => {
  const script = printing({ type: 'result', result: { blocks: [] } })
  const { run, calls } = fakeRun(() => script)
  const h = refinerStore({ run, callBudgetUsd: 0.15, dayUsd: 0.15 })
  h.store.turn('s1', turnFor({ id: 't1', at: T }))
  assert.equal((await h.store.refine('s1')).ok, true)
  assert.equal(h.store.get('s1').refiner.spentUsd, 0.15)
  assert.equal((await h.store.refine('s1', { force: true })).error, 'budget')
  assert.equal(calls.length, 1)

  const thrown = refinerStore({ run: () => { throw new Error('no such binary') }, dayUsd: 0.15 })
  thrown.store.turn('s1', turnFor({ id: 't1', at: T }))
  assert.equal((await thrown.store.refine('s1')).ok, false)
  assert.equal(thrown.store.get('s1').refiner.spentUsd, 0)
  assert.notEqual((await thrown.store.refine('s1', { force: true })).error, 'budget', 'nothing was booked against the cap')
})

const failingChildren = [
  ['exits non-zero', `process.stderr.write('boom'); process.exit(3)\n`, {}],
  ['prints output that will not parse', `process.stdout.write('this is not json\\n')\n`, {}],
  ['never exits', `setInterval(() => {}, 1000)\n`, { timeoutMs: 300 }],
  ['answers a result frame marked as an error', `process.stdout.write(${JSON.stringify(JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.05 }) + '\n')})\n`, {}],
]
for (const [label, src, over] of failingChildren) {
  await ok(`a child that ${label} leaves the chain unchanged and answers an error`, async () => {
    const script = fakeScript(src)
    const { run, calls } = fakeRun(() => script)
    const h = refinerStore({ run, ...over })
    h.store.turn('s1', turnFor({ id: 't1', at: T }))
    const before = structuredClone(h.store.get('s1'))
    const r = await h.store.refine('s1')
    assert.equal(r.ok, false)
    assert.equal(typeof r.error, 'string')
    assert.ok(r.error.length > 0)
    const after = h.store.get('s1')
    assert.deepEqual(after.blocks, before.blocks)
    assert.equal(after.rev, before.rev)
    assert.deepEqual(after.history, before.history)
    assert.equal(after.refiner.calls, 1, 'a spawned attempt is still counted')
    assert.equal(after.refiner.lastAt, T, 'and still stamped')
    assert.equal(h.store.busy('s1'), false)
    assert.equal(calls.length, 1)
    assert.equal(h.entries.length, 1, 'a failed call is still logged')
  })
}

await ok('a run that throws or returns no child answers an error instead of throwing', async () => {
  for (const run of [() => { throw new Error('no such binary') }, () => null]) {
    const h = refinerStore({ run })
    h.store.turn('s1', turnFor({ id: 't1', at: T }))
    const r = await h.store.refine('s1')
    assert.equal(r.ok, false)
    assert.equal(h.store.busy('s1'), false)
  }
})

await ok('one child at a time relay-wide: a second refine waits for the first to settle', async () => {
  const log = []
  const scripts = []
  let n = 0
  const run = (bin, argv, opts) => {
    const which = ++n
    log.push('enter ' + which)
    const child = spawn(process.execPath, [scripts[which - 1]], opts)
    child.on('close', () => log.push('close ' + which))
    return child
  }
  const h = refinerStore({ run })
  h.store.turn('s1', turnFor({ id: 't1', at: T }))
  h.store.turn('s2', turnFor({ id: 't1', at: T }))
  scripts.push(printing(resultFor(h.store, 's1'), { delayMs: 250 }), printing(resultFor(h.store, 's2'), { delayMs: 20 }))
  const p1 = h.store.refine('s1')
  const p2 = h.store.refine('s2')
  assert.equal(h.store.busy('s1'), true, 'the one in flight is busy')
  assert.equal(h.store.busy('s2'), true, 'a queued one is busy too, so it is never queued twice')
  assert.deepEqual(await h.store.refine('s1', { force: true }), { ok: false, error: 'busy' })
  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(r1.ok, true, r1.error)
  assert.equal(r2.ok, true, r2.error)
  assert.deepEqual(log, ['enter 1', 'close 1', 'enter 2', 'close 2'])
  assert.equal(h.store.busy('s1'), false)
  assert.equal(h.store.busy('s2'), false)
})

await ok('tick refines an idle chain and a working one at everyTurns, and neither twice', async () => {
  const script = printing({ type: 'result', result: { blocks: [] }, total_cost_usd: 0.001 })
  const { run, calls } = fakeRun(() => script)
  const h = refinerStore({ run, idleMs: 90_000, everyTurns: 3 })
  h.store.turn('idle1', turnFor({ id: 't1', at: T }))
  h.setClock(T + 100_000)
  for (const i of [1, 2, 3]) h.store.turn('working1', turnFor({ id: 'w' + i, at: T + 100_000 }))
  h.store.turn('quiet1', turnFor({ id: 'q1', at: T + 100_000 }))
  const ids = ['idle1', 'working1', 'quiet1']
  h.store.tick()
  await until(() => !ids.some((id) => h.store.busy(id)))
  assert.equal(calls.length, 2)
  assert.equal(h.store.get('idle1').refiner.calls, 1, 'idle for idleMs with a turn since the last pass')
  assert.equal(h.store.get('working1').refiner.calls, 1, 'everyTurns turns while still working')
  assert.equal(h.store.get('quiet1').refiner.calls, 0, 'neither idle nor at everyTurns')
  h.store.tick()
  await until(() => !ids.some((id) => h.store.busy(id)))
  assert.equal(calls.length, 2, 'neither is refined twice')
})

await ok('tick refines nothing when there is no claude', async () => {
  const h = refinerStore({ run: null, idleMs: 1 })
  h.store.turn('s1', turnFor({ id: 't1', at: T }))
  h.advance(10_000)
  h.store.tick()
  assert.equal(h.store.busy('s1'), false)
  assert.deepEqual(await h.store.refine('s1'), { ok: false, error: 'no claude' })
})

await ok('a chain with no turns is nothing to refine and spawns nothing', async () => {
  const { run, calls } = fakeRun(() => '')
  const h = refinerStore({ run }, (base) => writeRawChain(base, 'empty1', { blocks: [], turns: {} }))
  assert.deepEqual(await h.store.refine('empty1', { force: true }), { ok: false, error: 'nothing to refine' })
  assert.equal(calls.length, 0)
})

await ok('a failing child is not spawned again by the next tick until a new turn arrives', async () => {
  const script = fakeScript('process.exit(1)\n')
  const { run, calls } = fakeRun(() => script)
  const h = refinerStore({ run, idleMs: 1000 })
  h.store.turn('s1', turnFor({ id: 't1', at: T }))
  h.setClock(T + 5000)
  h.store.tick()
  await until(() => !h.store.busy('s1'))
  assert.equal(calls.length, 1)
  h.advance(60_000)
  h.store.tick()
  await until(() => !h.store.busy('s1'))
  assert.equal(calls.length, 1, 'the failure is not retried on every tick')
  h.store.turn('s1', turnFor({ id: 't2', at: T + 65_000 }))
  h.advance(5000)
  h.store.tick()
  await until(() => !h.store.busy('s1'))
  assert.equal(calls.length, 2, 'a new turn earns another attempt')
})

console.log('-- rebuild and export --')

const { turnsFromTranscript, exportChains, CHAIN_EXPORT_VERSION, HEAD_MAX } =
  await import(join(ROOT, 'syzygy', 'bridge', 'chain-model.mjs'))

const iso = (ms) => new Date(ms).toISOString()
const userLine = (uuid, at, content, over = {}) =>
  JSON.stringify({ type: 'user', uuid, timestamp: iso(at), isSidechain: false, message: { role: 'user', content }, ...over })
const assistantLine = (uuid, at, content, over = {}) =>
  JSON.stringify({ type: 'assistant', uuid, timestamp: iso(at), isSidechain: false, message: { role: 'assistant', content }, ...over })
const textBlock = (text) => ({ type: 'text', text })
const editBlock = (file) => ({ type: 'tool_use', id: 'toolu_' + file.length, name: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } })

await ok('turnsFromTranscript pairs prompts with answers and files, cuts heads, and never throws', async () => {
  const longPrompt = 'Rewrite the relay so the pane stops flickering. ' + 'detail '.repeat(100)
  const longAnswer = 'Fixed the flicker. ' + 'more '.repeat(200)
  const lines = [
    userLine('u1', T + 1000, longPrompt),
    assistantLine('a1', T + 2000, [editBlock('/w/relay.mjs')]),
    '{"type": "user", "message": {broken',
    '',
    '[1, 2, 3]',
    assistantLine('a2', T + 3000, [textBlock(longAnswer)]),
    userLine('u2', T + 4000, [textBlock('ok now write the release notes')]),
    assistantLine('a3', T + 5000, [textBlock('Drafted the notes.'), editBlock('/w/CHANGELOG.md')]),
  ]
  assert.equal(lines.length, 8)
  const turns = turnsFromTranscript(lines)
  assert.equal(turns.length, 2)
  const [first, second] = turns
  assert.equal(first.id, 'u1')
  assert.equal(first.at, T + 1000)
  assert.equal(first.promptHead, longPrompt.slice(0, HEAD_MAX))
  assert.equal(first.answerHead, longAnswer.trim().slice(-HEAD_MAX),
    'the answer excerpt is the end of the trimmed answer, where a turn says what it did')
  assert.equal(first.answerHead.length, HEAD_MAX)
  assert.ok(!first.answerHead.startsWith('Fixed the flicker.'), 'not its opening')
  assert.deepEqual(first.files, ['/w/relay.mjs'])
  assert.equal(first.tools, 1)
  assert.equal(first.durationMs, 2000)
  assert.equal(second.id, 'u2')
  assert.equal(second.promptHead, 'ok now write the release notes')
  assert.equal(second.answerHead, 'Drafted the notes.')
  assert.deepEqual(second.files, ['/w/CHANGELOG.md'])
})

await ok('turnsFromTranscript skips tool results, meta lines and subagent lines', async () => {
  const lines = [
    userLine('u1', T + 1000, 'Look at the relay'),
    assistantLine('a1', T + 2000, [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/w/relay.mjs' } }]),
    userLine('r1', T + 2100, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file text' }]),
    userLine('m1', T + 2200, [textBlock('Base directory for a skill')], { isMeta: true }),
    userLine('s1', T + 2300, 'a subagent prompt', { isSidechain: true }),
    assistantLine('s2', T + 2400, [textBlock('a subagent answer'), editBlock('/w/sub.mjs')], { isSidechain: true }),
    assistantLine('a2', T + 3000, [textBlock('The relay rebuilds the list each frame.')]),
  ]
  const turns = turnsFromTranscript(lines)
  assert.equal(turns.length, 1, 'a tool result, a meta line and a subagent prompt open no turn')
  assert.equal(turns[0].answerHead, 'The relay rebuilds the list each frame.')
  assert.deepEqual(turns[0].files, ['/w/relay.mjs'], 'a subagent\'s files are not the parent turn\'s')
})

await ok('a transcript with nothing usable is an empty list, and rebuild leaves the chain untouched', async () => {
  const junk = [
    '', 'not json', '[]', '42', '"a string"',
    JSON.stringify({ type: 'summary', summary: 'x' }),
    assistantLine('a0', T, [textBlock('an answer with no prompt before it')]),
  ]
  assert.deepEqual(turnsFromTranscript(junk), [])
  for (const bad of [null, undefined, 'text', 42, {}]) assert.deepEqual(turnsFromTranscript(bad), [])
  const base = dir()
  const file = join(base, 'junk.jsonl')
  writeFileSync(file, junk.join('\n'))
  writeRawChain(base, 'rb1', { transcript: file })
  const store = createChains({ dir: base, now: () => T })
  const before = readFileSync(chainPath(base, 'rb1'), 'utf8')
  assert.deepEqual(await store.rebuild('rb1'), { ok: false, error: 'nothing to rebuild' })
  assert.equal(readFileSync(chainPath(base, 'rb1'), 'utf8'), before, 'a wrong chain is worse than no rebuild')
  assert.equal(store.get('rb1').blocks[0].id, 'ob1')
})

// Longer than HEAD_MAX, and different at each end, so the excerpt's end matters.
const REPLAY_LONG_ANSWER = 'Fixed it for good. ' +
  'Traced the relay flicker to the list rebuild. '.repeat(12) +
  'The pane now reconciles keyed rows.\n'
const replayLines = () => [
  userLine('u1', T + 1000, 'Rewrite the relay flicker handler'),
  assistantLine('a1', T + 2000, [textBlock('Rewrote the handler.'), editBlock('/w/relay.mjs')]),
  userLine('u2', T + 3000, 'still fixing the relay flicker'),
  assistantLine('a2', T + 4000, [textBlock(REPLAY_LONG_ANSWER), editBlock('/w/relay.mjs')]),
  userLine('u3', T + 5000, 'ok now write the release notes'),
  assistantLine('a3', T + 6000, [textBlock('Drafted them.'), editBlock('/w/CHANGELOG.md')]),
]

await ok('rebuild replays a transcript into the same blocks turn() builds', async () => {
  const base = dir()
  const file = join(base, 'session.jsonl')
  writeFileSync(file, replayLines().join('\n') + '\n')
  writeRawChain(base, 'rb2', { transcript: file, refiner: { calls: 3, spentUsd: 0.4, lastAt: T, day: 'kept', paused: false } })
  const store = createChains({ dir: base, now: () => T + 10_000 })
  const r = await store.rebuild('rb2')
  assert.deepEqual(r, { ok: true, turns: 3, blocks: 2 })
  const rebuilt = store.get('rb2')

  // The live path: the long answer reaches turn() cut the way the band cuts it,
  // the last HEAD_MAX characters of the trimmed text, so a rebuilt chain and a
  // live one are shown to agree on the excerpt, not only on the blocks.
  const bandCut = REPLAY_LONG_ANSWER.trim().slice(-HEAD_MAX)
  assert.ok(REPLAY_LONG_ANSWER.trim().length > HEAD_MAX, 'the long answer is longer than the excerpt')
  const other = createChains({ dir: dir(), now: () => T + 10_000 })
  for (const t of turnsFromTranscript(replayLines())) {
    other.turn('cmp', t.id === 'u2' ? { ...t, answerHead: bandCut } : t)
  }
  const direct = other.get('cmp')
  const shape = (c) => c.blocks.map((b) => ({ title: b.title, turns: b.turns, state: b.state }))
  assert.deepEqual(shape(rebuilt), shape(direct))
  const excerpts = (c) => Object.fromEntries(Object.entries(c.turns).map(([id, t]) => [id, t.answerHead]))
  assert.equal(direct.turns.u2.answerHead, bandCut)
  assert.deepEqual(excerpts(rebuilt), excerpts(direct), 'the rebuilt excerpts are the ones the band would have posted')
  assert.equal(rebuilt.blocks.some((b) => b.id === 'ob1'), false, 'the old blocks are replaced, not kept')
  assert.equal(rebuilt.name, 'alpha', 'what a replay cannot know is carried over')
  assert.equal(rebuilt.transcript, file)
  assert.equal(rebuilt.refiner.spentUsd, 0.4, 'a rebuild never resets the spend')
  const onDisk = JSON.parse(readFileSync(chainPath(base, 'rb2'), 'utf8'))
  assert.deepEqual(onDisk.blocks.map((b) => b.title), rebuilt.blocks.map((b) => b.title), 'written through')
})

await ok('rebuild refuses an unknown session, a chain with no transcript, and one it cannot read', async () => {
  const base = dir()
  writeRawChain(base, 'rb3', { transcript: '' })
  writeRawChain(base, 'rb4', { transcript: join(base, 'missing.jsonl') })
  const store = createChains({ dir: base, now: () => T })
  assert.deepEqual(await store.rebuild('nope'), { ok: false, error: 'no such session' })
  assert.deepEqual(await store.rebuild('rb3'), { ok: false, error: 'no transcript' })
  const r = await store.rebuild('rb4')
  assert.equal(r.ok, false)
  assert.match(r.error, /transcript/)
  assert.equal(store.get('rb4').blocks[0].id, 'ob1')

  const injected = dir()
  writeRawChain(injected, 'rb5', { transcript: '/nowhere/session.jsonl' })
  const read = createChains({ dir: injected, now: () => T, readFile: async () => replayLines().join('\n') })
  assert.deepEqual(await read.rebuild('rb5'), { ok: true, turns: 3, blocks: 2 }, 'the reader is injectable')
})

await ok('rebuild keeps the day accounting, clears lastAt, and the next tick refines the rebuilt window once', async () => {
  const script = printing({ type: 'result', subtype: 'success', result: { blocks: [] }, total_cost_usd: 0.001 })
  const { run, calls } = fakeRun(() => script)
  let clock = T + 10_000
  const base = dir()
  const file = join(base, 'session.jsonl')
  writeFileSync(file, replayLines().join('\n') + '\n')
  writeRawChain(base, 'rb6', {
    transcript: file,
    rev: 1,
    history: [{ at: T, rev: 1, blocks: [{ id: 'ob1', title: 'earlier work', state: 'open' }] }],
    refiner: { calls: 4, spentUsd: 0.6, lastAt: T + 9000, day: 'kept-day', paused: false },
  })
  const store = createChains({ dir: base, now: () => clock, run, idleMs: 1000 })
  assert.equal((await store.rebuild('rb6')).ok, true)
  const rebuilt = store.get('rb6')
  const { lastAt, ...accounting } = rebuilt.refiner
  assert.deepEqual(accounting, { calls: 4, spentUsd: 0.6, day: 'kept-day', paused: false }, 'a rebuild never resets the budget')
  assert.equal(lastAt, 0, 'so the rebuilt window counts as never refined')
  assert.deepEqual(rebuilt.history, [], 'history goes with the blocks it described')
  assert.equal(calls.length, 0, 'a rebuild spawns nothing itself')

  store.tick()
  await until(() => !store.busy('rb6'))
  assert.equal(calls.length, 1, 'the next tick refines the rebuilt window')
  clock += 60_000
  store.tick()
  await until(() => !store.busy('rb6'))
  assert.equal(calls.length, 1, 'once, not on every tick')
})

const exportFixture = (sessionId, updatedAt) => ({
  ...blankChain({ sessionId, name: 'alpha', cwd: '/w/one', root: '/w', transcript: '/w/t.jsonl', startedAt: T, now: updatedAt }),
  blocks: [
    { id: 'e1', title: 'Relay flicker', summary: 'Fixed.', state: 'closed', by: 'model', pinned: true, rev: 2,
      startedAt: T, endedAt: T + 1000, parent: null, turns: ['t1', 't2'], files: ['/w/relay.mjs'], terms: ['relay'], progress: '' },
    { id: 'e2', title: 'Gone', summary: '', state: 'merged', by: 'model', pinned: false, rev: 1,
      startedAt: T + 1000, endedAt: T + 1000, parent: null, turns: [], files: [], terms: [], progress: '' },
    { id: 'e3', title: 'Release notes', summary: '', state: 'open', by: 'heuristic', pinned: false, rev: 0,
      startedAt: T + 2000, endedAt: T + 3000, parent: 'e1', turns: ['t3'], files: ['/w/CHANGELOG.md'], terms: ['release'], progress: 'drafting' },
  ],
  turns: { t1: rTurn('t1', T), t2: rTurn('t2', T + 1000), t3: rTurn('t3', T + 2000) },
})

await ok('exportChains is a versioned contract with exactly its keys, at both levels', async () => {
  const chains = { x1: exportFixture('x1', T + 5000) }
  const out = exportChains({ ids: ['x1'], read: (id) => chains[id] ?? null })
  assert.deepEqual(Object.keys(out).sort(), ['sessions', 'version'])
  assert.equal(out.version, CHAIN_EXPORT_VERSION)
  assert.equal(out.sessions.length, 1)
  const s = out.sessions[0]
  assert.deepEqual(Object.keys(s).sort(), ['blocks', 'cwd', 'name', 'root', 'sessionId'])
  assert.equal(s.sessionId, 'x1')
  assert.equal(s.name, 'alpha')
  for (const b of s.blocks) {
    assert.deepEqual(Object.keys(b).sort(), ['by', 'endedAt', 'files', 'id', 'startedAt', 'summary', 'terms', 'title', 'turnCount'])
  }
  assert.deepEqual(s.blocks.map((b) => b.id), ['e1', 'e3'], 'a merged block is omitted')
  assert.equal(s.blocks[0].turnCount, 2)
  assert.deepEqual(exportChains({ ids: ['x1'] }), { version: CHAIN_EXPORT_VERSION, sessions: [] }, 'the default reader reads nothing')
})

await ok('exportChains filters by updatedAt and skips a chain that will not parse', async () => {
  const chains = { old: exportFixture('old', T + 1000), fresh: exportFixture('fresh', T + 9000) }
  const read = (id) => {
    if (id === 'throws') throw new Error('unreadable')
    if (id === 'junk') return 'not a chain'
    return chains[id] ?? null
  }
  const since = exportChains({ ids: ['old', 'throws', 'junk', 'fresh', 'missing'], read, since: T + 5000 })
  assert.deepEqual(since.sessions.map((s) => s.sessionId), ['fresh'])
  const all = exportChains({ ids: ['old', 'throws', 'junk', 'fresh'], read })
  assert.deepEqual(all.sessions.map((s) => s.sessionId), ['old', 'fresh'])
})

await ok('exportAll exports every chain on disk through the store\'s own reader, and never moves a bad file', async () => {
  let clock = T
  const base = dir()
  const store = createChains({ dir: base, now: () => clock })
  store.turn('ex1', turnFor({ id: 't1', at: T }))
  clock = T + 50_000
  store.turn('ex2', turnFor({ id: 't1', at: T + 50_000 }))
  const bad = chainPath(base, 'broken')
  writeFileSync(bad, 'not json {{{')
  const later = createChains({ dir: base, now: () => clock })
  const all = later.exportAll()
  assert.equal(all.version, CHAIN_EXPORT_VERSION)
  assert.deepEqual(all.sessions.map((s) => s.sessionId).sort(), ['ex1', 'ex2'])
  assert.deepEqual(later.exportAll({ since: T + 10_000 }).sessions.map((s) => s.sessionId), ['ex2'])
  assert.ok(existsSync(bad), 'an export reads; it never moves a file aside')
})

await ok('turn records the session\'s name, cwd, root and transcript, and an empty value never erases one', async () => {
  let clock = T
  const store = createChains({ dir: dir(), now: () => clock })
  store.turn('m1', turnFor({ id: 't1', at: T }), { name: 'alpha', cwd: '/w/one', root: '/w', transcript: '', startedAt: T - 5000 })
  let c = store.get('m1')
  assert.equal(c.name, 'alpha')
  assert.equal(c.cwd, '/w/one')
  assert.equal(c.root, '/w')
  assert.equal(c.transcript, '', 'no path known yet')
  assert.equal(c.startedAt, T - 5000, 'a fresh chain starts when its session did')
  clock = T + 1000
  store.turn('m1', turnFor({ id: 't2', at: T + 1000 }), { name: 'alpha', cwd: '/w/one', root: '/w', transcript: '/w/t.jsonl' })
  assert.equal(store.get('m1').transcript, '/w/t.jsonl', 'a path that appears later is recorded')
  store.turn('m1', turnFor({ id: 't3', at: T + 2000 }), { name: '', cwd: '', root: '', transcript: '' })
  c = store.get('m1')
  assert.equal(c.transcript, '/w/t.jsonl', 'an empty value never erases a known path')
  assert.equal(c.name, 'alpha')
  assert.equal(c.startedAt, T - 5000, 'an existing chain keeps its own start')
  store.turn('m2', turnFor({ id: 't1', at: T }))
  assert.equal(store.get('m2').name, '', 'no description is still a chain')
})

await ok('killAll stops an in-flight refine, settles it as a failure, and spawns nothing after it', async () => {
  // A child that never exits on its own within this check. Every child is
  // killed by its own handle in the finally, so a failing check leaves no
  // orphan behind.
  const hang = fakeScript('setInterval(() => {}, 1000)\n')
  const children = []
  const run = (bin, argv, opts) => {
    const c = spawn(process.execPath, [hang], opts)
    children.push(c)
    return c
  }
  try {
    const h = refinerStore({ run })
    h.store.turn('k1', turnFor({ id: 't1', at: T }))
    h.store.turn('k2', turnFor({ id: 't1', at: T }))
    const first = h.store.refine('k1', { force: true })
    const second = h.store.refine('k2', { force: true })
    await until(() => children.length === 1)
    assert.equal(h.store.busy('k2'), true, 'the second refine is queued behind the first')
    const exited = new Promise((r) => children[0].once('exit', (code, signal) => r({ code, signal })))

    h.store.killAll()

    const one = await first
    assert.equal(one.ok, false)
    assert.equal(typeof one.error, 'string')
    const two = await second
    assert.equal(two.ok, false, 'a queued refine settles as a failure too')
    assert.equal((await exited).signal, 'SIGTERM', 'the child was stopped, not left running')
    assert.ok(h.store.get('k1').refiner.lastAt > 0, 'the attempt stays stamped, so the tick does not retry it')
    assert.equal(h.store.busy('k1'), false)
    assert.equal(h.store.busy('k2'), false)

    await new Promise((r) => setTimeout(r, 200))
    assert.equal(children.length, 1, 'the queued refine never spawned')
    const after = await h.store.refine('k1', { force: true })
    assert.equal(after.ok, false, 'a refine after killAll is refused')
    h.store.tick()
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(children.length, 1, 'nothing spawns after killAll')
  } finally {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
  }
})

// ---- the live relay: routes, payload, event, inheritance --------------------
// A mocked relay cannot prove a route ladder: the gate, the payload key, the
// event and the register-time inheritance are all things only a real process
// does. Isolated on every axis: SZG_PORT=0 (the OS picks the port, read back
// from the relay's own startup line), SZG_DATA_DIR in a throwaway directory,
// no SZG_* variable inherited from whoever runs the harness, and SZG_CLAUDE_BIN
// pointing at a shell script, so no real `claude` ever runs.
console.log('-- the relay --')
{
  const relayPath = join(ROOT, 'syzygy', 'bridge', 'relay.mjs')
  const TOKEN = 'chain-harness-' + Math.random().toString(36).slice(2)
  // A floor, not a pin: the version chains first shipped in. Later branches
  // bump the version for their own fields, and an exact match would break on each.
  const MIN_PAYLOAD_VERSION = 14
  const liveDir = mkdtempSync(join(tmpdir(), 'szg-chain-live-'))
  const slowFile = join(liveDir, 'slow')
  const fakeClaude = join(liveDir, 'claude')
  // It answers --help the way a capable binary does (both `--bg` and `attach`),
  // or the relay refuses it and every refine answers 503. A print-mode call
  // answers one result frame, after a pause while the slow marker exists.
  writeFileSync(fakeClaude, [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then echo "  --bg   run in the background"; echo "  attach   attach to a session"; exit 0; fi',
    'if [ "$1" = "--version" ]; then echo "0.0.0-fake (chain harness)"; exit 0; fi',
    'if [ "$1" = "agents" ]; then echo "[]"; exit 0; fi',
    'if [ "$1" = "-p" ]; then',
    '  [ -f "' + slowFile + '" ] && sleep 2',
    '  echo \'{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0,"structured_output":{"blocks":[]}}\'',
    '  exit 0',
    'fi',
    'exit 0',
    '',
  ].join('\n'))
  chmodSync(fakeClaude, 0o755)

  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SZG_')))
  const children = []
  const startRelay = async (env) => {
    const child = spawn(process.execPath, [relayPath], {
      cwd: ROOT,
      env: {
        ...baseEnv, SZG_PORT: '0', SZG_TOKEN: TOKEN, SZG_PANE_PASSWORD_DISABLED: '1', SZG_TMUX_BIN: '/usr/bin/false',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { err += c })
    const port = await new Promise((resolvePort, reject) => {
      const timer = setTimeout(() => reject(new Error(`relay did not report a port in time; stderr: ${err}`)), 15_000)
      const onExit = (code) => { clearTimeout(timer); reject(new Error(`relay exited early with code ${code}; stderr: ${err}`)) }
      const onData = () => {
        const m = out.match(/relay on http:\/\/127\.0\.0\.1:(\d+)/)
        if (!m) return
        clearTimeout(timer)
        child.stdout.off('data', onData)
        child.off('exit', onExit)
        resolvePort(Number(m[1]))
      }
      child.stdout.on('data', onData)
      child.on('exit', onExit)
    })
    const base = `http://127.0.0.1:${port}`
    const call = async (method, path, { body, token = TOKEN } = {}) => {
      const headers = { 'content-type': 'application/json' }
      if (token) headers['x-mch-token'] = token
      const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
      const text = await res.text()
      let parsed = null
      try { parsed = JSON.parse(text) } catch {}
      return { status: res.status, body: parsed }
    }
    return {
      child, port, base,
      stdout: () => out,
      post: (path, body, opts) => call('POST', path, { body, ...opts }),
      get: (path) => call('GET', path + (path.includes('?') ? '&' : '?') + 'token=' + TOKEN),
      // A stale relay already on the port would answer every request below and
      // turn every check into a false pass, so each check asks this first.
      alive: () => assert.equal(child.exitCode, null, `relay child died; stderr: ${err}`),
    }
  }
  const stopAll = async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      const gone = new Promise((r) => child.once('exit', r))
      child.kill('SIGTERM')
      await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }

  const ac = new AbortController()
  try {
    const dataA = mkdtempSync(join(tmpdir(), 'szg-chain-data-'))
    // Stale chains on disk before boot: the store indexes them once, at
    // construction, and a session that never registered is by definition not
    // live. One under a real name, one under a name equal to its repo.
    const seeded = Date.now()
    const seedChain = (sessionId, name) => ({
      ...blankChain({ sessionId, name, cwd: ROOT, root: ROOT, transcript: '', startedAt: seeded - 60_000, now: seeded }),
      blocks: [{
        id: 'g-' + sessionId, title: 'earlier work', summary: '', state: 'open', by: 'heuristic', pinned: false, rev: 0,
        startedAt: seeded - 60_000, endedAt: seeded - 1000, parent: null, turns: [], files: [], terms: [], progress: '',
      }],
    })
    mkdirSync(join(dataA, CHAINS_DIR), { recursive: true })
    writeFileSync(join(dataA, CHAINS_DIR, 'gone-1.json'), JSON.stringify(seedChain('gone-1', 'restarted')))
    writeFileSync(join(dataA, CHAINS_DIR, 'gone-2.json'), JSON.stringify(seedChain('gone-2', 'demo')))

    // The idle window is raised so the relay's own tick can never start a
    // refinement in the middle of these checks.
    const A = await startRelay({ SZG_DATA_DIR: dataA, SZG_CLAUDE_BIN: fakeClaude, SZG_CHAIN_IDLE_MS: '3600000' })

    await ok('the relay is up on its own port, reporting the bumped payload version', async () => {
      A.alive()
      const h = await A.get('/api/health')
      assert.equal(h.status, 200)
      assert.equal(h.body.port, A.port)
      assert.ok(h.body.payloadVersion >= MIN_PAYLOAD_VERSION, 'a relay carrying chains reports at least the version they shipped in')
    })

    await ok('an unauthenticated chain write is refused, and so is a POST to a read-only branch', async () => {
      A.alive()
      assert.equal((await A.post('/api/chain/turn', { sessionId: 'sess-1', turn: { id: 't1' } }, { token: null })).status, 401)
      assert.equal((await A.post('/api/chain/sess-1/pin', { blockId: 'x', pinned: true }, { token: null })).status, 401)
      assert.equal((await A.post('/api/state', {}, { token: null })).status, 401)
    })

    const transcriptFile = join(liveDir, 'transcript.jsonl')
    const tt = Date.now() - 10_000
    writeFileSync(transcriptFile, [
      userLine('u1', tt, 'Rewrite the relay so the pane stops flickering'),
      assistantLine('a1', tt + 1000, [textBlock('Fixed the flicker.'), editBlock('/w/relay.mjs')]),
      userLine('u2', tt + 2000, [textBlock('ok now write the release notes')]),
      assistantLine('a2', tt + 3000, [textBlock('Drafted the notes.'), editBlock('/w/CHANGELOG.md')]),
    ].join('\n') + '\n')

    const register = (session) => A.post('/api/register', {
      session: { agentName: 'main', cwd: ROOT, root: ROOT, repo: 'demo', branch: 'develop', model: 'Opus', pid: '1', startedAt: Date.now(), ...session },
    })

    await ok('the transcript path rides the heartbeat, and an empty one never erases it', async () => {
      A.alive()
      assert.equal((await register({ id: 'sess-1', name: 'alpha' })).status, 200)
      assert.equal((await A.post('/api/stats', { id: 'sess-1', transcript: transcriptFile })).status, 200)
      assert.equal((await A.post('/api/stats', { id: 'sess-1', transcript: '' })).status, 200)
      const state = await A.get('/api/state')
      const s = state.body.sessions.find((x) => x.id === 'sess-1')
      assert.equal(s.transcript, transcriptFile)
    })

    let firstBlock = ''
    const liveTurn = (id, promptHead, at = Date.now()) => ({
      id, at, durationMs: 400, reason: 'ok', origin: 'composer', promptHead, answerHead: 'answer for ' + id,
      files: ['/w/relay.mjs'], tools: 1, subturns: 0,
    })
    await ok('a turn is refused for an unknown session or with no id, and recorded for a registered one', async () => {
      A.alive()
      const unknown = await A.post('/api/chain/turn', { sessionId: 'nobody', turn: liveTurn('t1', 'hello there') })
      assert.equal(unknown.status, 404)
      const noId = await A.post('/api/chain/turn', { sessionId: 'sess-1', turn: { promptHead: 'no id here' } })
      assert.equal(noId.status, 400)
      assert.equal(typeof noId.body.error, 'string')
      const r = await A.post('/api/chain/turn', { sessionId: 'sess-1', turn: liveTurn('t1', 'Rewrite the relay so the pane stops flickering') })
      assert.equal(r.status, 200)
      assert.equal(r.body.ok, true)
      assert.equal(typeof r.body.blockId, 'string')
      assert.equal(r.body.opened, true)
      assert.ok('why' in r.body, 'the boundary rule says why')
      firstBlock = r.body.blockId
    })

    await ok('the snapshot carries every chain compact, beside the bumped version', async () => {
      A.alive()
      const state = await A.get('/api/state')
      assert.ok(state.body.payloadVersion >= MIN_PAYLOAD_VERSION, 'the snapshot carrying chains is at least the version they shipped in')
      const c = state.body.chains['sess-1']
      assert.ok(c, 'the registered session has a chain in the payload')
      assert.equal(c.open, firstBlock)
      assert.equal(c.blocks.length, 1)
      assert.equal('summary' in c.blocks[0], false, 'the payload never carries a summary')
      assert.equal('turns' in c, false, 'nor turn heads')
    })

    await ok('the one-chain read carries summaries, turn heads and the session\'s own description', async () => {
      A.alive()
      const r = await A.get('/api/chain/sess-1')
      assert.equal(r.status, 200)
      assert.equal(typeof r.body.chain.blocks[0].summary, 'string')
      assert.equal(r.body.chain.turns.t1.promptHead, 'Rewrite the relay so the pane stops flickering')
      assert.equal(r.body.chain.name, 'alpha')
      assert.equal(r.body.chain.cwd, ROOT)
      assert.equal(r.body.chain.root, ROOT)
      assert.equal(r.body.chain.transcript, transcriptFile, 'the path comes from the session record, never the request')
      assert.equal((await A.get('/api/chain/nobody')).status, 404)
      assert.equal((await A.get('/api/chain/a/b')).status, 404, 'an id is one path segment')
      assert.equal((await A.get('/api/chain/%E0%A4%A')).status, 404, 'a malformed escape is a 404, never a throw')
      assert.equal((await A.get('/api/chain/%00')).status, 404, 'a NUL never reaches the filesystem')
      assert.equal((await A.get('/api/chain/..%2Fsess-1')).status, 404)
      A.alive()
    })

    await ok('a pin reaches the file, the payload and the event stream', async () => {
      A.alive()
      assert.equal((await A.post('/api/chain/turn', { sessionId: 'sess-1', turn: liveTurn('t2', 'ok now write the release notes') })).status, 200)
      const res = await fetch(`${A.base}/api/stream?token=${TOKEN}`, { signal: ac.signal })
      assert.equal(res.status, 200)
      let sse = ''
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      ;(async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            sse += decoder.decode(value, { stream: true })
          }
        } catch {}
      })()
      await until(() => sse.includes('event: snapshot'), 5000)
      const r = await A.post('/api/chain/sess-1/pin', { blockId: firstBlock, pinned: true })
      assert.equal(r.status, 200)
      const state = await A.get('/api/state')
      assert.equal(state.body.chains['sess-1'].blocks.find((b) => b.id === firstBlock).pinned, true)
      const onDisk = JSON.parse(readFileSync(chainPath(dataA, 'sess-1'), 'utf8'))
      assert.equal(onDisk.blocks.find((b) => b.id === firstBlock).pinned, true)
      const chainFrames = () => sse.split('\n\n')
        .filter((f) => f.startsWith('event: chain\n'))
        .map((f) => JSON.parse(f.slice(f.indexOf('data: ') + 'data: '.length)))
      await until(() => chainFrames().some((d) => d.chain?.blocks?.some((b) => b.id === firstBlock && b.pinned)), 5000)
      const frame = chainFrames().find((d) => d.chain?.blocks?.some((b) => b.id === firstBlock && b.pinned))
      assert.equal(frame.sessionId, 'sess-1', 'the event is { sessionId, chain }, one level deep')
      assert.equal('summary' in frame.chain.blocks[0], false, 'the event carries the compact chain')
    })

    await ok('the hand edits answer by name, and an unknown shape is a 404', async () => {
      A.alive()
      const merge = await A.post('/api/chain/sess-1/merge', { blockId: firstBlock, into: 'prev' })
      assert.equal(merge.status, 400)
      assert.equal(merge.body.error, 'no previous block')
      const retitle = await A.post('/api/chain/sess-1/retitle', { blockId: firstBlock, title: 'Pane flicker' })
      assert.equal(retitle.status, 200)
      assert.equal((await A.get('/api/chain/sess-1')).body.chain.blocks[0].title, 'Pane flicker')
      const split = await A.post('/api/chain/sess-1/split', { blockId: 'no-such', atTurnId: 't1' })
      assert.equal(split.status, 400)
      assert.equal(split.body.error, 'no such block')
      assert.equal((await A.post('/api/chain/sess-1/bogus', {})).status, 404)
      assert.equal((await A.post('/api/chain/sess-1', {})).status, 404)
      assert.equal((await A.post('/api/chain/sess-1/pin/extra', { blockId: firstBlock })).status, 404)
      assert.equal((await A.post('/api/chain/..%2Fsess-1/pin', { blockId: firstBlock, pinned: false })).status, 404,
        'an escaped slash never reaches the store as a path')
      assert.equal((await A.post('/api/chain/%E0%A4%A/pin', { blockId: firstBlock })).status, 404)
      assert.equal((await A.post('/api/chain/%00/pin', { blockId: firstBlock })).status, 404)
      A.alive()
    })

    await ok('the export carries the frozen shape', async () => {
      A.alive()
      const r = await A.get('/api/chains/export')
      assert.equal(r.status, 200)
      assert.deepEqual(Object.keys(r.body).sort(), ['sessions', 'version'])
      assert.equal(r.body.version, CHAIN_EXPORT_VERSION)
      const s = r.body.sessions.find((x) => x.sessionId === 'sess-1')
      assert.ok(s)
      assert.deepEqual(Object.keys(s).sort(), ['blocks', 'cwd', 'name', 'root', 'sessionId'])
      assert.deepEqual(Object.keys(s.blocks[0]).sort(), ['by', 'endedAt', 'files', 'id', 'startedAt', 'summary', 'terms', 'title', 'turnCount'])
      const later = await A.get('/api/chains/export?since=' + (Date.now() + 3_600_000))
      assert.deepEqual(later.body.sessions, [])
    })

    await ok('a refine runs against the binary and is refused while one is running', async () => {
      A.alive()
      const r = await A.post('/api/chain/sess-1/refine', {})
      assert.ok(r.status < 500, `refine answered ${r.status}`)
      if (r.status !== 200) assert.equal(typeof r.body.error, 'string', 'a refused refine names why')
      assert.equal((await A.get('/api/chain/sess-1')).body.chain.refiner.calls, 1, 'the pass was recorded on the chain')
      writeFileSync(slowFile, '')
      try {
        const first = A.post('/api/chain/sess-1/refine', {})
        await new Promise((r2) => setTimeout(r2, 400))
        const second = await A.post('/api/chain/sess-1/refine', {})
        assert.equal(second.status, 409)
        assert.equal(second.body.error, 'already refining')
        assert.ok((await first).status < 500)
      } finally {
        unlinkSync(slowFile)
      }
      A.alive()
    })

    await ok('a rebuild replays the transcript the session reported', async () => {
      A.alive()
      const r = await A.post('/api/chain/sess-1/rebuild', {})
      assert.equal(r.status, 200)
      assert.equal(r.body.ok, true)
      assert.equal(r.body.turns, 2)
      const chain = (await A.get('/api/chain/sess-1')).body.chain
      assert.deepEqual(Object.keys(chain.turns).sort(), ['u1', 'u2'])
      assert.equal(chain.blocks.some((b) => b.pinned), false, 'a rebuild discards pins')
    })

    await ok('a restarted session continues its stale chain at register, once', async () => {
      A.alive()
      assert.equal((await register({ id: 'new-1', name: 'restarted' })).status, 200)
      const chain = (await A.get('/api/chain/new-1')).body?.chain
      assert.ok(chain, 'the restarted session has a chain before its first turn')
      assert.equal(chain.resumedFrom, 'gone-1')
      assert.equal(chain.blocks.length, 2)
      assert.equal(chain.blocks[0].state, 'closed')
      assert.equal(chain.blocks[1].title, 'restart')
      assert.match(A.stdout(), /chain: new-1 continues the chain of gone-1/)
      assert.equal((await register({ id: 'new-1', name: 'restarted' })).status, 200)
      assert.equal((await A.get('/api/chain/new-1')).body.chain.blocks.length, 2, 're-registering adds no second restart')
      assert.equal((await register({ id: 'plain-1', name: 'demo' })).status, 200)
      assert.equal((await A.get('/api/chain/plain-1')).status, 404, 'a name equal to the repo never inherits')
      A.alive()
    })

    await ok('the gate\'s narrow POST exemption is unchanged, and the relay never died', async () => {
      assert.equal((await A.post('/api/state', {}, { token: null })).status, 401)
      A.alive()
    })

    ac.abort()

    // A second relay whose only candidate binary does not exist, so it has none.
    const dataB = mkdtempSync(join(tmpdir(), 'szg-chain-data-'))
    const B = await startRelay({ SZG_DATA_DIR: dataB, SZG_CLAUDE_BIN: join(liveDir, 'no-such-claude') })
    await ok('with no claude binary, refine and rebuild are 503 and the hand edits still work', async () => {
      B.alive()
      assert.equal((await B.post('/api/register', {
        session: { id: 'solo', name: 'solo', cwd: ROOT, root: ROOT, repo: 'demo', pid: '1', startedAt: Date.now() },
      })).status, 200)
      const t = await B.post('/api/chain/turn', { sessionId: 'solo', turn: liveTurn('t1', 'something to pin') })
      assert.equal(t.status, 200)
      assert.equal((await B.post('/api/chain/solo/refine', {})).status, 503)
      assert.equal((await B.post('/api/chain/solo/rebuild', {})).status, 503)
      assert.equal((await B.post('/api/chain/solo/pin', { blockId: t.body.blockId, pinned: true })).status, 200)
      assert.equal((await B.post('/api/chain/solo/retitle', { blockId: t.body.blockId, title: 'by hand' })).status, 200)
      B.alive()
    })

    // A third relay with a day cap under one call's budget. The fake binary
    // reports no cost, so its one refine books the whole per-call cap.
    const dataC = mkdtempSync(join(tmpdir(), 'szg-chain-data-'))
    const C = await startRelay({ SZG_DATA_DIR: dataC, SZG_CLAUDE_BIN: fakeClaude, SZG_CHAIN_IDLE_MS: '3600000', SZG_CHAIN_DAY_USD: '0.1' })
    await ok('SZG_CHAIN_DAY_USD caps the refiner, and a refused refine says why over the route', async () => {
      C.alive()
      assert.equal((await C.post('/api/register', {
        session: { id: 'capped', name: 'capped', cwd: ROOT, root: ROOT, repo: 'demo', pid: '1', startedAt: Date.now() },
      })).status, 200)
      assert.equal((await C.post('/api/chain/turn', { sessionId: 'capped', turn: liveTurn('t1', 'something to refine') })).status, 200)
      assert.equal((await C.post('/api/chain/capped/refine', {})).status, 200)
      const refused = await C.post('/api/chain/capped/refine', {})
      assert.equal(refused.status, 400)
      assert.equal(refused.body.error, 'budget')
      assert.match(refused.body.reason, /today across every session; its day cap is \$0\.10$/)
      assert.equal((await C.get('/api/chain/capped')).body.chain.refiner.calls, 1, 'the refused refine never spawned')
      C.alive()
    })
  } finally {
    ac.abort()
    await stopAll()
  }
}

console.log(`${pass} passed`)
