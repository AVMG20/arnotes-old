// What a rule is, and whether it may exist. One file, so the API, the agent tools,
// the Settings UI and the engine read the same shapes and give the same answers.
// Pure, with no imports: nothing here touches the database, so it tests on its own.

export const TRIGGER_KINDS = [
  'task_added', 'task_moved', 'task_completed', 'task_reopened', 'task_assigned',
  'due_set', 'due_passed', 'comment_added', 'pr_merged', 'pr_closed', 'pr_checks_failed'
] as const
export type TriggerKind = typeof TRIGGER_KINDS[number]

export const CONDITION_KINDS = ['in_column', 'assigned_to', 'has_label', 'has_due_date', 'visibility'] as const
export type ConditionKind = typeof CONDITION_KINDS[number]

export const ACTION_KINDS = [
  'move_to_column', 'assign', 'unassign', 'set_due_in_days', 'complete', 'reopen',
  'add_label', 'add_comment', 'create_subtask', 'set_visibility'
] as const
export type ActionKind = typeof ACTION_KINDS[number]

export const VISIBILITIES = ['internal', 'customer'] as const
export type Visibility = typeof VISIBILITIES[number]

// The kinds with the fields each one takes, written out for an agent that was refused.
// One place: the refusal messages and the MCP tool descriptions both read these.
const TRIGGER_FIELDS: Record<TriggerKind, string> = {
  task_added: '', task_moved: 'columnId', task_completed: '', task_reopened: '',
  task_assigned: 'optional assigneeId, no id means anyone', due_set: '', due_passed: '',
  comment_added: '', pr_merged: '', pr_closed: '', pr_checks_failed: ''
}
const CONDITION_FIELDS: Record<ConditionKind, string> = {
  in_column: 'columnId', assigned_to: 'assigneeId (null means nobody)', has_label: 'label',
  has_due_date: 'value (true or false)', visibility: 'value (internal or customer)'
}
const ACTION_FIELDS: Record<ActionKind, string> = {
  move_to_column: 'columnId', assign: 'assigneeId', unassign: '', set_due_in_days: 'days from 0 to 365',
  complete: '', reopen: '', add_label: 'label', add_comment: 'text', create_subtask: 'title',
  set_visibility: 'value (internal or customer; project owner only)'
}

function listKinds(kinds: readonly string[], fields: Record<string, string>): string {
  return kinds.map(kind => (fields[kind] ? `${kind}: ${fields[kind]}` : kind)).join('; ')
}

export const KNOWN_TRIGGERS = listKinds(TRIGGER_KINDS, TRIGGER_FIELDS)
export const KNOWN_CONDITIONS = listKinds(CONDITION_KINDS, CONDITION_FIELDS)
export const KNOWN_ACTIONS = listKinds(ACTION_KINDS, ACTION_FIELDS)

// Limits. The API counts a project's existing rules against MAX_RULES_PER_PROJECT;
// validateRule only sees one rule at a time.
export const MAX_RULES_PER_PROJECT = 50
export const MAX_CONDITIONS = 10
export const MAX_ACTIONS = 20
/** The most rule firings one chain of changes may cause before the engine stops it. */
export const MAX_RULE_STEPS = 5
export const MAX_DUE_DAYS = 365
export const MAX_COMMENT_LENGTH = 2000
export const MAX_LABEL_LENGTH = 50
export const MAX_SUBTASK_TITLE_LENGTH = 200
export const MAX_RULE_NAME_LENGTH = 100

export type Trigger
  = | { kind: 'task_moved', columnId: string }
    // No assigneeId means "assigned to anyone".
    | { kind: 'task_assigned', assigneeId?: string }
    | { kind: Exclude<TriggerKind, 'task_moved' | 'task_assigned'> }

export type Condition
  = | { kind: 'in_column', columnId: string }
    // null means "nobody is assigned".
    | { kind: 'assigned_to', assigneeId: string | null }
    | { kind: 'has_label', label: string }
    | { kind: 'has_due_date', value: boolean }
    | { kind: 'visibility', value: Visibility }

export type Action
  = | { kind: 'move_to_column', columnId: string }
    | { kind: 'assign', assigneeId: string }
    | { kind: 'unassign' }
    | { kind: 'set_due_in_days', days: number }
    | { kind: 'complete' }
    | { kind: 'reopen' }
    | { kind: 'add_label', label: string }
    | { kind: 'add_comment', text: string }
    | { kind: 'create_subtask', title: string }
    | { kind: 'set_visibility', value: Visibility }

export interface Rule {
  /** Empty when the rule has no name; describeRule still reads well. */
  name: string
  enabled: boolean
  trigger: Trigger
  conditions: Condition[]
  actions: Action[]
}

export interface RuleContext {
  columnIds: string[]
  memberIds: string[]
  /** True only for the project owner. Other staff may not let a rule change visibility. */
  mayChangeVisibility: boolean
}

/** What a task looked like when a rule was checked. Plain values, no database rows. */
export interface TaskSnapshot {
  columnId: string
  assigneeId: string | null
  tags: string[]
  dueOn: string | null
  visibility: Visibility
}

/** Turns ids into the names people read in a sentence. */
export interface RuleNames {
  column: (id: string) => string
  person: (id: string) => string
}

export type ValidateResult = { ok: true, rule: Rule } | { ok: false, problems: string[] }

type Obj = Record<string, unknown>

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value)
}

// Trimmed text of 1 to max characters, or null.
function readText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length > 0 && text.length <= max ? text : null
}

// The problem sentences are written for the person who built the rule, so they
// name the step and say what to pick.
function pickColumn(value: unknown, context: RuleContext, problems: string[], where: string): string | null {
  if (typeof value === 'string' && context.columnIds.includes(value)) return value
  problems.push(`Choose the column for '${where}'`)
  return null
}

function pickMember(value: unknown, context: RuleContext, problems: string[], where: string): string | null {
  if (typeof value === 'string' && context.memberIds.includes(value)) return value
  problems.push(`Pick someone who is a member of this project for ${where}`)
  return null
}

function pickLabel(value: unknown, problems: string[], where: string): string | null {
  const label = readText(value, MAX_LABEL_LENGTH)
  if (label === null) problems.push(`Write a label of 1 to ${MAX_LABEL_LENGTH} characters for ${where}`)
  return label
}

function pickVisibility(value: unknown, problems: string[], where: string): Visibility | null {
  if (isOneOf(VISIBILITIES, value)) return value
  problems.push(`Pick team only or shared with customer for ${where}`)
  return null
}

// Parses the trigger. A rule has exactly one, so this takes one object, not a list.
function parseTrigger(raw: unknown, context: RuleContext, problems: string[]): Trigger | null {
  if (!isObject(raw) || !isOneOf(TRIGGER_KINDS, raw.kind)) {
    problems.push(`Pick a known trigger; each rule has exactly one. Known triggers: ${KNOWN_TRIGGERS}`)
    return null
  }
  const kind = raw.kind
  if (kind === 'task_moved') {
    const columnId = pickColumn(raw.columnId, context, problems, 'A task is moved to a column')
    return columnId === null ? null : { kind, columnId }
  }
  if (kind === 'task_assigned') {
    if (raw.assigneeId === undefined) return { kind }
    const assigneeId = pickMember(raw.assigneeId, context, problems, 'the assigned trigger')
    return assigneeId === null ? null : { kind, assigneeId }
  }
  return { kind }
}

function parseCondition(raw: unknown, context: RuleContext, problems: string[]): Condition | null {
  if (!isObject(raw) || !isOneOf(CONDITION_KINDS, raw.kind)) {
    problems.push(`Pick a known condition. Known conditions: ${KNOWN_CONDITIONS}`)
    return null
  }
  switch (raw.kind) {
    case 'in_column': {
      const columnId = pickColumn(raw.columnId, context, problems, 'The task is in a column')
      return columnId === null ? null : { kind: 'in_column', columnId }
    }
    case 'assigned_to': {
      // null is the choice "nobody"; anything else must be a member.
      if (raw.assigneeId === null) return { kind: 'assigned_to', assigneeId: null }
      const assigneeId = pickMember(raw.assigneeId, context, problems, 'the assigned-to condition')
      return assigneeId === null ? null : { kind: 'assigned_to', assigneeId }
    }
    case 'has_label': {
      const label = pickLabel(raw.label, problems, 'the label condition')
      return label === null ? null : { kind: 'has_label', label }
    }
    case 'has_due_date': {
      if (typeof raw.value !== 'boolean') {
        problems.push('Say yes or no for the due-date condition')
        return null
      }
      return { kind: 'has_due_date', value: raw.value }
    }
    case 'visibility': {
      const value = pickVisibility(raw.value, problems, 'the visibility condition')
      return value === null ? null : { kind: 'visibility', value }
    }
  }
  return null
}

function parseAction(raw: unknown, context: RuleContext, problems: string[]): Action | null {
  if (!isObject(raw) || !isOneOf(ACTION_KINDS, raw.kind)) {
    problems.push(`Pick a known action for every step. Known actions: ${KNOWN_ACTIONS}`)
    return null
  }
  switch (raw.kind) {
    case 'move_to_column': {
      const columnId = pickColumn(raw.columnId, context, problems, 'Move it to a column')
      return columnId === null ? null : { kind: 'move_to_column', columnId }
    }
    case 'assign': {
      const assigneeId = pickMember(raw.assigneeId, context, problems, 'the assign action')
      return assigneeId === null ? null : { kind: 'assign', assigneeId }
    }
    case 'unassign':
    case 'complete':
    case 'reopen':
      return { kind: raw.kind }
    case 'set_due_in_days': {
      const days = raw.days
      if (typeof days !== 'number' || !Number.isInteger(days) || days < 0 || days > MAX_DUE_DAYS) {
        problems.push(`Pick a whole number of days from 0 to ${MAX_DUE_DAYS} for the due-date action`)
        return null
      }
      return { kind: 'set_due_in_days', days }
    }
    case 'add_label': {
      const label = pickLabel(raw.label, problems, 'the add-label action')
      return label === null ? null : { kind: 'add_label', label }
    }
    case 'add_comment': {
      const text = readText(raw.text, MAX_COMMENT_LENGTH)
      if (text === null) {
        problems.push(`Write a comment of 1 to ${MAX_COMMENT_LENGTH} characters for the add-comment action`)
        return null
      }
      return { kind: 'add_comment', text }
    }
    case 'create_subtask': {
      const title = readText(raw.title, MAX_SUBTASK_TITLE_LENGTH)
      if (title === null) {
        problems.push(`Write a subtask title of 1 to ${MAX_SUBTASK_TITLE_LENGTH} characters`)
        return null
      }
      return { kind: 'create_subtask', title }
    }
    case 'set_visibility': {
      // Visibility decides what the customer sees, so only the owner may set it by rule.
      if (!context.mayChangeVisibility) {
        problems.push('Only the project owner can make a rule change task visibility')
        return null
      }
      const value = pickVisibility(raw.value, problems, 'the set-visibility action')
      return value === null ? null : { kind: 'set_visibility', value }
    }
  }
  return null
}

/**
 * Checks a rule a person or an agent wrote and returns it in the normal form, or
 * the list of things to fix. Unknown fields are dropped, so the stored rule holds
 * only what this file knows about.
 */
export function validateRule(input: unknown, context: RuleContext): ValidateResult {
  if (!isObject(input)) {
    return { ok: false, problems: ['A rule must have a trigger, optional conditions and at least one action'] }
  }
  const problems: string[] = []

  let name = ''
  if (input.name !== undefined) {
    const text = readText(input.name, MAX_RULE_NAME_LENGTH)
    if (text === null) problems.push(`The rule name must be 1 to ${MAX_RULE_NAME_LENGTH} characters`)
    else name = text
  }

  let enabled = true
  if (input.enabled !== undefined) {
    if (typeof input.enabled === 'boolean') enabled = input.enabled
    else problems.push('Say whether the rule is on or off')
  }

  const trigger = parseTrigger(input.trigger, context, problems)

  const conditions: Condition[] = []
  if (input.conditions !== undefined) {
    if (!Array.isArray(input.conditions)) problems.push('Conditions must be a list')
    else if (input.conditions.length > MAX_CONDITIONS) problems.push(`A rule can have at most ${MAX_CONDITIONS} conditions`)
    else for (const raw of input.conditions) {
      const condition = parseCondition(raw, context, problems)
      if (condition !== null) conditions.push(condition)
    }
  }

  const actions: Action[] = []
  if (!Array.isArray(input.actions)) {
    problems.push('A rule needs a list of actions')
  } else if (input.actions.length === 0) {
    problems.push('A rule needs at least one action')
  } else if (input.actions.length > MAX_ACTIONS) {
    problems.push(`A rule can have at most ${MAX_ACTIONS} actions`)
  } else {
    for (const raw of input.actions) {
      const action = parseAction(raw, context, problems)
      if (action !== null) actions.push(action)
    }
  }

  if (problems.length > 0 || trigger === null) {
    return { ok: false, problems: problems.length > 0 ? problems : [`Pick a known trigger; each rule has exactly one. Known triggers: ${KNOWN_TRIGGERS}`] }
  }
  return { ok: true, rule: { name, enabled, trigger, conditions, actions } }
}

function describeTrigger(trigger: Trigger, names: RuleNames): string {
  switch (trigger.kind) {
    case 'task_moved': return `a task is moved to ${names.column(trigger.columnId)}`
    case 'task_assigned':
      return trigger.assigneeId === undefined
        ? 'a task is assigned to anyone'
        : `a task is assigned to ${names.person(trigger.assigneeId)}`
    case 'task_added': return 'a task is added'
    case 'task_completed': return 'a task is completed'
    case 'task_reopened': return 'a task is reopened'
    case 'due_set': return 'a due date is set or changed'
    case 'due_passed': return 'a due date passes'
    case 'comment_added': return 'a comment is added'
    case 'pr_merged': return 'a linked pull request is merged'
    case 'pr_closed': return 'a linked pull request is closed'
    case 'pr_checks_failed': return 'a linked pull request has checks that fail'
  }
}

function describeCondition(condition: Condition, names: RuleNames): string {
  switch (condition.kind) {
    case 'in_column': return `the task is in ${names.column(condition.columnId)}`
    case 'assigned_to':
      return condition.assigneeId === null
        ? 'nobody is assigned'
        : `it is assigned to ${names.person(condition.assigneeId)}`
    case 'has_label': return `it has the label "${condition.label}"`
    case 'has_due_date': return condition.value ? 'it has a due date' : 'it has no due date'
    case 'visibility': return `it is ${condition.value}`
  }
}

function describeAction(action: Action, names: RuleNames): string {
  switch (action.kind) {
    case 'move_to_column': return `move it to ${names.column(action.columnId)}`
    case 'assign': return `assign it to ${names.person(action.assigneeId)}`
    case 'unassign': return 'unassign it'
    case 'set_due_in_days': return `set the due date to ${action.days} days from now`
    case 'complete': return 'mark it complete'
    case 'reopen': return 'reopen it'
    case 'add_label': return `add the label "${action.label}"`
    case 'add_comment': return `add the comment "${action.text}"`
    case 'create_subtask': return `create the subtask "${action.title}"`
    case 'set_visibility': return `set it to ${action.value}`
  }
}

/** One plain sentence for a rule, for the Settings UI and the run log. */
export function describeRule(rule: Rule, names: RuleNames): string {
  const when = describeTrigger(rule.trigger, names)
  const conditions = rule.conditions.map(condition => describeCondition(condition, names))
  const actions = rule.actions.map(action => describeAction(action, names))
  const head = conditions.length > 0
    ? `When ${when}, if ${conditions.join(' and ')}`
    : `When ${when}`
  return `${head}: ${actions.join(', then ')}.`
}

/**
 * Whether every condition holds for a task. An empty list holds. Labels are
 * compared exactly, as validateRule stored them.
 */
export function conditionsHold(conditions: Condition[], task: TaskSnapshot): boolean {
  return conditions.every((condition) => {
    switch (condition.kind) {
      case 'in_column': return task.columnId === condition.columnId
      case 'assigned_to': return task.assigneeId === condition.assigneeId
      case 'has_label': return task.tags.includes(condition.label)
      case 'has_due_date': return (task.dueOn !== null) === condition.value
      case 'visibility': return task.visibility === condition.value
    }
  })
}
