// reconcileTasks: a board re-read keeps the task objects that did not change, and takes the new ones
// when the blocked mark changes (GH #36, slice 4). Pure, no browser.
// The store module uses Nuxt auto-imports, so the functions it names are put on globalThis first.
// Run: TSX_TSCONFIG_PATH=.nuxt/tsconfig.app.json node --import tsx --test tests/reconcile-tasks.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import type { ProjectTask } from '../app/composables/useProjects'

const autoImports = globalThis as unknown as Record<string, unknown>
for (const name of ['ref', 'computed', 'watch', 'reactive', 'shallowRef', 'readonly', 'toValue', 'watchEffect', 'onScopeDispose', 'getCurrentScope', 'onMounted', 'nextTick', 'unref', 'isRef', 'toRef', 'toRefs'] as const) {
  autoImports[name] ??= (vue as unknown as Record<string, unknown>)[name]
}
// Only the board re-read calls $fetch, and these tests never reach it.
autoImports.$fetch ??= () => Promise.reject(new Error('no network in tests'))
autoImports.untypedFetch ??= (await import('../app/utils/untypedFetch')).untypedFetch
const { reconcileTasks } = await import('../app/composables/useProjects')

type Board = ProjectTask & { blocked?: boolean, blockedBy?: string[] }

function task(id: string, extra: Partial<Board> = {}): Board {
  return {
    id,
    projectId: 'p',
    columnId: 'c',
    title: id,
    description: '',
    tags: [],
    position: 1,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...extra
  }
}

test('nothing changed: each task keeps the object the board already had', () => {
  const previous = [task('a'), task('b')]
  const next = [task('a'), task('b')]
  const out = reconcileTasks(previous, next)
  assert.equal(out[0], previous[0])
  assert.equal(out[1], previous[1])
})

test('a changed blocked mark takes the new object', () => {
  const previous = [task('a', { blocked: false })]
  const next = [task('a', { blocked: true, blockedBy: ['x'] })]
  const out = reconcileTasks(previous, next)
  assert.equal(out[0], next[0])
  assert.equal(out[0]!.blocked, true)
})

test('a changed blockedBy takes the new object, even with the same blocked flag', () => {
  const previous = [task('a', { blocked: true, blockedBy: ['x'] })]
  const next = [task('a', { blocked: true, blockedBy: ['x', 'y'] })]
  assert.equal(reconcileTasks(previous, next)[0], next[0])
})

test('the order of the next read is kept, and a newly arrived task is included', () => {
  const previous = [task('a'), task('b')]
  const next = [task('b'), task('new'), task('a')]
  const out = reconcileTasks(previous, next)
  assert.deepEqual(out.map(t => t.id), ['b', 'new', 'a'])
  assert.equal(out[0], previous[1])
  assert.equal(out[2], previous[0])
  assert.equal(out[1], next[1])
})

test('a task that is gone from the next read is dropped', () => {
  const previous = [task('a'), task('b')]
  const next = [task('b')]
  assert.deepEqual(reconcileTasks(previous, next).map(t => t.id), ['b'])
})

test('with no previous board, the next read is returned as it is', () => {
  const next = [task('a')]
  assert.equal(reconcileTasks(undefined, next), next)
})
