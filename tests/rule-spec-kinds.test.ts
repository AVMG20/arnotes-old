// The refusal of an unknown rule trigger or action names every valid kind with its fields (GH #38 slice A).
// Pure: ruleSpec.ts has no imports, so this needs no database and no network.
//   node --import tsx --test tests/rule-spec-kinds.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ACTION_KINDS, CONDITION_KINDS, KNOWN_ACTIONS, KNOWN_CONDITIONS, KNOWN_TRIGGERS, TRIGGER_KINDS, validateRule } from '../server/utils/ruleSpec'
import type { RuleContext } from '../server/utils/ruleSpec'

const context: RuleContext = { columnIds: ['col-todo', 'col-verify'], memberIds: ['user-1'], mayChangeVisibility: true }
const goodTrigger = { kind: 'task_added' }
const goodAction = { kind: 'complete' }

test('an unknown trigger lists every valid trigger with its fields', () => {
  const result = validateRule({ name: 'x', trigger: { kind: 'nope' }, actions: [goodAction] }, context)
  assert.equal(result.ok, false)
  if (result.ok) return
  const message = result.problems.join('\n')
  for (const kind of TRIGGER_KINDS) assert.ok(message.includes(kind), `missing trigger ${kind}`)
  assert.ok(message.includes(`Known triggers: ${KNOWN_TRIGGERS}`))
  assert.ok(message.includes('task_moved: columnId'))
  assert.ok(message.includes('task_assigned: optional assigneeId, no id means anyone'))
})

test('an unknown action lists every valid action with its fields', () => {
  const result = validateRule({ name: 'x', trigger: goodTrigger, actions: [{ kind: 'explode' }] }, context)
  assert.equal(result.ok, false)
  if (result.ok) return
  const message = result.problems.join('\n')
  for (const kind of ACTION_KINDS) assert.ok(message.includes(kind), `missing action ${kind}`)
  assert.ok(message.includes(`Known actions: ${KNOWN_ACTIONS}`))
  assert.ok(message.includes('move_to_column: columnId'))
  assert.ok(message.includes('set_due_in_days: days from 0 to 365'))
})

test('an unknown condition lists every valid condition with its fields', () => {
  const result = validateRule({ name: 'x', trigger: goodTrigger, conditions: [{ kind: 'vibes' }], actions: [goodAction] }, context)
  assert.equal(result.ok, false)
  if (result.ok) return
  const message = result.problems.join('\n')
  for (const kind of CONDITION_KINDS) assert.ok(message.includes(kind), `missing condition ${kind}`)
  assert.ok(message.includes(`Known conditions: ${KNOWN_CONDITIONS}`))
})

// Drift guard on the tool descriptions. mcpRuleTools.ts imports the database, so this reads its source:
// each of create_rule and update_rule must name all three lists, and the lists must hold every kind.
const toolSource = readFileSync(new URL('../server/utils/mcpRuleTools.ts', import.meta.url), 'utf8')
const skillSource = readFileSync(new URL('../server/utils/agentSkill.ts', import.meta.url), 'utf8')

for (const tool of ['create_rule', 'update_rule']) {
  test(`${tool} description names every trigger, condition and action kind`, () => {
    const start = toolSource.indexOf(`name: '${tool}'`)
    assert.ok(start >= 0, `${tool} not found`)
    const block = toolSource.slice(start, toolSource.indexOf('inputSchema', start))
    assert.ok(block.includes('KNOWN_TRIGGERS') && block.includes('KNOWN_CONDITIONS') && block.includes('KNOWN_ACTIONS'),
      `${tool} description must read all three kind lists`)
    // Each kind is checked against its own list: items read "kind" or "kind: fields".
    const listed = (list: string) => list.split('; ').map(item => item.split(':')[0])
    for (const kind of TRIGGER_KINDS) assert.ok(listed(KNOWN_TRIGGERS).includes(kind), `trigger ${kind} not in the trigger list`)
    for (const kind of CONDITION_KINDS) assert.ok(listed(KNOWN_CONDITIONS).includes(kind), `condition ${kind} not in the condition list`)
    for (const kind of ACTION_KINDS) assert.ok(listed(KNOWN_ACTIONS).includes(kind), `action ${kind} not in the action list`)
  })
}

test('the agent skill Rules note names the create_rule description', () => {
  assert.ok(skillSource.includes('listed in the create_rule tool description'))
})

test('a valid rule still passes', () => {
  const result = validateRule({ name: 'x', trigger: goodTrigger, actions: [goodAction] }, context)
  assert.equal(result.ok, true)
})
