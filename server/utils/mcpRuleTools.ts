// Agent tools for a board's automation rules. The same checks as the Settings page
// and the app API run here (ruleSpec.ts and ruleStore.ts), and a rule is the team's
// to change: a customer's contact is refused by name, as for every board change.
import { desc, eq } from 'drizzle-orm'
import { db } from '../db'
import { projectRuleRuns, projectRules } from '../db/schema'
import type { Project, ProjectRule } from '../db/schema'
import { findStaffBoard, touchBoard } from './mcpBoardTools'
import { McpToolError, newId, optionalBoolean, optionalLimit, requireString } from './mcpToolKit'
import type { McpToolDefinition } from './mcpToolKit'
import { ACTION_KINDS, CONDITION_KINDS, KNOWN_ACTIONS, KNOWN_CONDITIONS, KNOWN_TRIGGERS, MAX_ACTIONS, MAX_CONDITIONS, TRIGGER_KINDS, VISIBILITIES, validateRule } from './ruleSpec'
import { RUN_PAGE_SIZE, lastRunOf, loadRuleFrame, loadRules, nextRulePosition, ruleLimitMessage, ruleValues, ruleView, runView, storedRule } from './ruleStore'
import type { ApiKeyContext } from './api-keys'

const BOARD = { type: 'string', description: 'Board id, board name, or a link to the board.' }
const RULE = { type: 'string', description: 'Rule id, or the rule\'s name as the list shows it.' }

const TRIGGER_HELP = `One trigger: {"kind": ...}. Kinds: ${TRIGGER_KINDS.join(', ')}. task_moved takes "columnId"; task_assigned takes an optional "assigneeId" (no id means anyone).`
const CONDITIONS_HELP = `Up to ${MAX_CONDITIONS} conditions, all of which must hold: {"kind": ...}. Kinds: ${CONDITION_KINDS.join(', ')}. in_column takes "columnId"; assigned_to takes "assigneeId" (null for nobody); has_label takes "label"; has_due_date takes "value" (true or false); visibility takes "value" (${VISIBILITIES.join(' or ')}).`
const ACTIONS_HELP = `Between 1 and ${MAX_ACTIONS} actions, run in order: {"kind": ...}. Kinds: ${ACTION_KINDS.join(', ')}. move_to_column takes "columnId"; assign takes "assigneeId"; set_due_in_days takes "days" (0 to 365); add_label takes "label"; add_comment takes "text"; create_subtask takes "title"; set_visibility takes "value" and only the project owner may use it.`

/** A rule on the board, found by id or by name. */
async function findRule(board: Project, reference: string): Promise<ProjectRule> {
  const rules = await loadRules(board.id)
  const byId = rules.find(rule => rule.id === reference)
  if (byId) return byId

  const needle = reference.trim().toLowerCase()
  const named = rules.filter(rule => rule.name.toLowerCase() === needle)
  if (named.length > 1) throw new McpToolError(`More than one rule on "${board.name}" is called "${reference}". Use its id instead.`)
  if (named.length === 1) return named[0]!

  const known = rules.map(rule => rule.name || rule.id).join(', ')
  throw new McpToolError(`No rule "${reference}" on board "${board.name}".` + (known ? ` Rules: ${known}.` : ' The board has no rules yet.'))
}

/** The rule's parts from the arguments, without the board and rule references. */
function rulePatch(args: Record<string, unknown>): Record<string, unknown> {
  const { board: _board, rule: _rule, ...patch } = args
  return patch
}

function refuse(problems: string[]): never {
  throw new McpToolError(problems.join(' '))
}

export const MCP_RULE_TOOLS: McpToolDefinition[] = [
  {
    name: 'list_rules',
    title: 'List a board\'s rules',
    description: 'List a board\'s automation rules in the order they run: each one\'s trigger, conditions and actions, whether it is on, a sentence describing it, and its last run. Staff only.',
    scope: 'boards:read',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { board: BOARD },
      required: ['board']
    },
    async handler(args, context) {
      const board = await findStaffBoard(requireString(args, 'board'), context, 'rules')
      const frame = await loadRuleFrame(board, context.userId)
      const rows = await loadRules(board.id)
      const rules = await Promise.all(rows.map(async row => ruleView(row, frame.names, await lastRunOf(row.id))))
      return { board: { id: board.id, name: board.name }, rules }
    }
  },
  {
    name: 'create_rule',
    title: 'Add a rule',
    description: 'Add an automation rule to a board: when a trigger happens and the conditions hold, the actions run. The rule is checked the same way as in Settings, and a refused rule comes back with the sentences that say what to fix. Only the project owner may use set_visibility. Triggers: ' + KNOWN_TRIGGERS + '. Conditions: ' + KNOWN_CONDITIONS + '. Actions: ' + KNOWN_ACTIONS + '.',
    scope: 'boards:write',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        board: BOARD,
        name: { type: 'string', description: 'A name for the rule, up to 100 characters.' },
        enabled: { type: 'boolean', description: 'Whether the rule is on. Defaults to on.' },
        trigger: { type: 'object', description: TRIGGER_HELP },
        conditions: { type: 'array', items: { type: 'object' }, description: CONDITIONS_HELP },
        actions: { type: 'array', items: { type: 'object' }, description: ACTIONS_HELP }
      },
      required: ['board', 'trigger', 'actions']
    },
    async handler(args, context: ApiKeyContext) {
      const board = await findStaffBoard(requireString(args, 'board'), context, 'rules')
      const count = (await loadRules(board.id)).length
      const limit = ruleLimitMessage(count)
      if (limit) throw new McpToolError(limit)

      const frame = await loadRuleFrame(board, context.userId)
      const checked = validateRule(rulePatch(args), frame.context)
      if (!checked.ok) refuse(checked.problems)

      const now = Date.now()
      const [created] = await db.insert(projectRules).values({
        id: newId(),
        projectId: board.id,
        ...ruleValues(checked.rule),
        position: await nextRulePosition(board.id),
        createdBy: context.userId,
        createdAt: now,
        updatedAt: now
      }).returning()

      await touchBoard(board.id)
      return { created: true, board: { id: board.id, name: board.name }, rule: ruleView(created!, frame.names, null) }
    }
  },
  {
    name: 'update_rule',
    title: 'Change a rule',
    description: 'Change a rule on a board: send only the parts that change (name, trigger, conditions, actions) and they are checked together with the rest of the rule. Sending just "enabled" switches it on or off. Only the project owner may use set_visibility. Triggers: ' + KNOWN_TRIGGERS + '. Conditions: ' + KNOWN_CONDITIONS + '. Actions: ' + KNOWN_ACTIONS + '.',
    scope: 'boards:write',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        board: BOARD,
        rule: RULE,
        name: { type: 'string', description: 'A new name, up to 100 characters.' },
        enabled: { type: 'boolean', description: 'true to switch the rule on, false to switch it off.' },
        trigger: { type: 'object', description: TRIGGER_HELP },
        conditions: { type: 'array', items: { type: 'object' }, description: CONDITIONS_HELP },
        actions: { type: 'array', items: { type: 'object' }, description: ACTIONS_HELP }
      },
      required: ['board', 'rule']
    },
    async handler(args, context: ApiKeyContext) {
      const board = await findStaffBoard(requireString(args, 'board'), context, 'rules')
      const row = await findRule(board, requireString(args, 'rule'))
      const patch = rulePatch(args)
      const frame = await loadRuleFrame(board, context.userId)
      const now = Date.now()

      // Switching a rule on or off skips the checks, as the Settings switch does.
      if (Object.keys(patch).length === 1 && 'enabled' in patch) {
        const enabled = optionalBoolean(patch, 'enabled')!
        const [updated] = await db.update(projectRules).set({ enabled, updatedAt: now }).where(eq(projectRules.id, row.id)).returning()
        await touchBoard(board.id)
        return { updated: true, board: { id: board.id, name: board.name }, rule: ruleView(updated!, frame.names, await lastRunOf(row.id)) }
      }

      const stored = storedRule(row)
      const checked = validateRule({
        name: stored.name || undefined,
        enabled: stored.enabled,
        trigger: stored.trigger,
        conditions: stored.conditions,
        actions: stored.actions,
        ...patch
      }, frame.context)
      if (!checked.ok) refuse(checked.problems)

      const [updated] = await db.update(projectRules)
        .set({ ...ruleValues(checked.rule), updatedAt: now })
        .where(eq(projectRules.id, row.id))
        .returning()
      await touchBoard(board.id)
      return { updated: true, board: { id: board.id, name: board.name }, rule: ruleView(updated!, frame.names, await lastRunOf(row.id)) }
    }
  },
  {
    name: 'list_rule_runs',
    title: 'List a rule\'s runs',
    description: 'The run log of one rule on a board: one row per time it fired, with the task, the outcome (ran, failed or loop_stopped) and the detail, newest first.',
    scope: 'boards:read',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        board: BOARD,
        rule: RULE,
        limit: { type: 'number', description: `How many runs to return, at most ${RUN_PAGE_SIZE}. Defaults to ${RUN_PAGE_SIZE}.` }
      },
      required: ['board', 'rule']
    },
    async handler(args, context) {
      const board = await findStaffBoard(requireString(args, 'board'), context, 'rules')
      const row = await findRule(board, requireString(args, 'rule'))
      const limit = optionalLimit(args, 'limit', RUN_PAGE_SIZE, RUN_PAGE_SIZE)
      const runs = await db
        .select()
        .from(projectRuleRuns)
        .where(eq(projectRuleRuns.ruleId, row.id))
        .orderBy(desc(projectRuleRuns.createdAt))
        .limit(limit)
      return { board: { id: board.id, name: board.name }, rule: { id: row.id, name: row.name }, runs: runs.map(runView) }
    }
  }
]
