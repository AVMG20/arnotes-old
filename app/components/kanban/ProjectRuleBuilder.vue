<script setup lang="ts">
// The rule builder: one trigger, up to 10 conditions and 20 actions. The page checks
// the rule with the same model the server uses, so the preview and the problems in
// words match what the save will say; the server still checks again on save.
import { describeRule, validateRule, MAX_CONDITIONS, MAX_ACTIONS, MAX_RULE_NAME_LENGTH } from '~~/server/utils/ruleSpec'
import type { RuleContext, RuleNames } from '~~/server/utils/ruleSpec'
import { boardPeople } from '~/composables/useProjects'
import { createProjectRule, updateProjectRule, ruleErrorMessage } from '~/composables/useProjectRules'
import type { ProjectRule, RuleBody } from '~/composables/useProjectRules'

const props = defineProps<{
  projectId: string
  rule?: ProjectRule | null
  // Only the project owner may let a rule set a task's visibility.
  canSetVisibility: boolean
}>()

const emit = defineEmits<{ saved: [rule: ProjectRule], cancel: [] }>()

const { boardColumns, isTrashed, boardTagCounts } = useProjects()

type StepField = 'none' | 'column' | 'person' | 'personOrNobody' | 'personOrAnyone' | 'label' | 'days' | 'text' | 'visibility' | 'yesNo'
interface KindInfo { label: string, field: StepField, key?: string }
interface Row { kind: string, value: string }

// The plain words for each kind, and the key the rule model stores its value under.
const TRIGGERS: Record<string, KindInfo> = {
  task_added: { label: 'A task is added', field: 'none' },
  task_moved: { label: 'A task is moved to a column', field: 'column', key: 'columnId' },
  task_completed: { label: 'A task is completed', field: 'none' },
  task_reopened: { label: 'A task is reopened', field: 'none' },
  task_assigned: { label: 'A task is assigned to someone', field: 'personOrAnyone', key: 'assigneeId' },
  due_set: { label: 'A due date is set or changed', field: 'none' },
  due_passed: { label: 'A due date passes', field: 'none' },
  comment_added: { label: 'A comment is added', field: 'none' },
  pr_merged: { label: 'A linked pull request is merged', field: 'none' },
  pr_closed: { label: 'A linked pull request is closed', field: 'none' },
  pr_checks_failed: { label: 'Checks fail on a linked pull request', field: 'none' }
}

const CONDITIONS: Record<string, KindInfo> = {
  in_column: { label: 'The task is in a column', field: 'column', key: 'columnId' },
  assigned_to: { label: 'It is assigned to someone, or to nobody', field: 'personOrNobody', key: 'assigneeId' },
  has_label: { label: 'It has a label', field: 'label', key: 'label' },
  has_due_date: { label: 'It has a due date (yes or no)', field: 'yesNo', key: 'value' },
  visibility: { label: 'It is internal or customer', field: 'visibility', key: 'value' }
}

const ACTIONS: Record<string, KindInfo> = {
  move_to_column: { label: 'Move it to a column', field: 'column', key: 'columnId' },
  assign: { label: 'Assign it to someone', field: 'person', key: 'assigneeId' },
  unassign: { label: 'Unassign it', field: 'none' },
  set_due_in_days: { label: 'Set the due date, days from now', field: 'days', key: 'days' },
  complete: { label: 'Mark it complete', field: 'none' },
  reopen: { label: 'Reopen it', field: 'none' },
  add_label: { label: 'Add a label', field: 'label', key: 'label' },
  add_comment: { label: 'Add a comment', field: 'text', key: 'text' },
  create_subtask: { label: 'Create a subtask', field: 'text', key: 'title' },
  set_visibility: { label: 'Set it internal or customer', field: 'visibility', key: 'value' }
}

function kindList(table: Record<string, KindInfo>, disabled: (kind: string) => boolean = () => false) {
  return Object.entries(table).map(([value, info]) => ({
    value,
    label: value === 'set_visibility' && disabled(value) ? `${info.label} (project owner only)` : info.label,
    field: info.field,
    disabled: disabled(value)
  }))
}

const triggerKinds = kindList(TRIGGERS)
const conditionKinds = kindList(CONDITIONS)
const actionKinds = kindList(ACTIONS, kind => kind === 'set_visibility' && !props.canSetVisibility)

// Columns the board still has; a trashed column cannot be picked for a new rule.
const columns = computed(() => boardColumns.value.filter(column => !isTrashed(column)).map(column => ({ id: column.id, name: column.name })))
const people = computed(() => boardPeople().map(person => ({ id: person.id, name: person.name || person.email })))
const labels = computed(() => boardTagCounts.value.map(([tag]) => tag))

// Rows are edited as text; each kind turns its value into the stored shape.
function fromStored(item: Record<string, unknown>, info: KindInfo): Row {
  const kind = String(item.kind)
  if (!info.key) return { kind, value: '' }
  const raw = item[info.key]
  if (info.field === 'yesNo') return { kind, value: raw === true ? 'yes' : raw === false ? 'no' : '' }
  if (info.field === 'days') return { kind, value: raw === undefined ? '' : String(raw) }
  return { kind, value: typeof raw === 'string' ? raw : '' }
}

function toStored(row: Row, info: KindInfo): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: row.kind }
  if (!info.key) return out
  switch (info.field) {
    case 'personOrNobody':
      out[info.key] = row.value === '' ? null : row.value
      break
    case 'personOrAnyone':
      // An empty value is the choice "anyone", which the model reads as no key.
      if (row.value !== '') out[info.key] = row.value
      break
    case 'days':
      out[info.key] = row.value === '' ? row.value : Number(row.value)
      break
    case 'yesNo':
      out[info.key] = row.value === 'yes' ? true : row.value === 'no' ? false : ''
      break
    default:
      out[info.key] = row.value.trim()
  }

  return out
}

const stored = props.rule ?? null
const name = ref(stored?.name ?? '')
const trigger = ref<Row>(stored
  ? fromStored(stored.trigger as unknown as Record<string, unknown>, TRIGGERS[stored.trigger.kind] ?? { label: '', field: 'none' })
  : { kind: 'task_moved', value: '' })
const conditions = ref<Row[]>(stored?.conditions.map(item => fromStored(item as unknown as Record<string, unknown>, CONDITIONS[item.kind] ?? { label: '', field: 'none' })) ?? [])
const actions = ref<Row[]>(stored?.actions.map(item => fromStored(item as unknown as Record<string, unknown>, ACTIONS[item.kind] ?? { label: '', field: 'none' })) ?? [])
if (!stored) actions.value = [{ kind: 'move_to_column', value: '' }]

function addCondition() {
  conditions.value.push({ kind: 'in_column', value: '' })
}

function addAction() {
  actions.value.push({ kind: 'move_to_column', value: '' })
}

const body = computed<RuleBody>(() => {
  const trig = toStored(trigger.value, TRIGGERS[trigger.value.kind] ?? { label: '', field: 'none' })
  const result: RuleBody = {
    trigger: trig as unknown as RuleBody['trigger'],
    conditions: conditions.value.map(row => toStored(row, CONDITIONS[row.kind] ?? { label: '', field: 'none' })) as unknown as RuleBody['conditions'],
    actions: actions.value.map(row => toStored(row, ACTIONS[row.kind] ?? { label: '', field: 'none' })) as unknown as RuleBody['actions']
  }
  // An unnamed rule is sent without a name; the server reads that as no name at all.
  const text = name.value.trim()
  if (text) result.name = text
  return result
})

const context = computed<RuleContext>(() => ({
  columnIds: columns.value.map(column => column.id),
  memberIds: people.value.map(person => person.id),
  mayChangeVisibility: props.canSetVisibility
}))

const names = computed<RuleNames>(() => ({
  column: id => columns.value.find(column => column.id === id)?.name ?? 'a column that has been removed',
  person: id => people.value.find(person => person.id === id)?.name ?? 'someone who is no longer on the project'
}))

const checked = computed(() => validateRule(body.value, context.value))
const preview = computed(() => checked.value.ok ? describeRule(checked.value.rule, names.value) : null)
const problems = computed(() => checked.value.ok ? [] : checked.value.problems)
// The first problem is the reason the save button is off. Only one line shows, so the page does not move as the rule changes.
const firstProblem = computed(() => {
  const list = problems.value
  if (!list.length) return ''
  return list.length > 1 ? `${list[0]} (and ${list.length - 1} more)` : list[0]
})

const saving = ref(false)
const saveError = ref('')

async function save() {
  if (!checked.value.ok || saving.value) return
  saving.value = true
  saveError.value = ''
  try {
    const saved = props.rule
      ? await updateProjectRule(props.projectId, props.rule.id, body.value)
      : await createProjectRule(props.projectId, body.value)
    emit('saved', saved)
  } catch (e) {
    saveError.value = ruleErrorMessage(e, 'Could not save the rule')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="space-y-4 rounded-xl border border-default bg-default p-4">
    <div>
      <label
        class="text-xs font-medium text-muted"
        for="rule-builder-name"
      >Name (optional)</label>
      <input
        id="rule-builder-name"
        v-model="name"
        type="text"
        :maxlength="MAX_RULE_NAME_LENGTH"
        placeholder="For example: ship it"
        class="mt-1 w-full rounded-md border border-default bg-transparent px-2 py-1.5 text-sm text-default outline-none focus:border-primary"
        data-rule-name
      >
    </div>

    <section class="space-y-2">
      <h4 class="text-xs font-semibold uppercase tracking-wide text-muted">
        When
      </h4>
      <KanbanProjectRuleStep
        v-model="trigger"
        :kinds="triggerKinds"
        :columns="columns"
        :people="people"
        :labels="labels"
      />
    </section>

    <section class="space-y-2">
      <h4 class="text-xs font-semibold uppercase tracking-wide text-muted">
        If (all of these)
      </h4>
      <p
        v-if="!conditions.length"
        class="text-xs text-dimmed"
      >
        No conditions: the rule applies to every task the trigger fires for.
      </p>
      <div
        v-for="(row, index) in conditions"
        :key="index"
        class="flex items-start gap-2"
      >
        <div class="min-w-0 flex-1">
          <KanbanProjectRuleStep
            :model-value="row"
            :kinds="conditionKinds"
            :columns="columns"
            :people="people"
            :labels="labels"
            @update:model-value="conditions[index] = $event"
          />
        </div>
        <button
          class="mt-1.5 text-xs text-dimmed hover:text-error"
          :aria-label="`Remove condition ${index + 1}`"
          @click="conditions.splice(index, 1)"
        >
          Remove
        </button>
      </div>
      <button
        v-if="conditions.length < MAX_CONDITIONS"
        class="text-xs text-primary hover:underline"
        data-add-condition
        @click="addCondition"
      >
        Add a condition
      </button>
    </section>

    <section class="space-y-2">
      <h4 class="text-xs font-semibold uppercase tracking-wide text-muted">
        Then (in this order)
      </h4>
      <div
        v-for="(row, index) in actions"
        :key="index"
        class="flex items-start gap-2"
      >
        <div class="min-w-0 flex-1">
          <KanbanProjectRuleStep
            :model-value="row"
            :kinds="actionKinds"
            :columns="columns"
            :people="people"
            :labels="labels"
            @update:model-value="actions[index] = $event"
          />
        </div>
        <button
          class="mt-1.5 text-xs text-dimmed hover:text-error"
          :aria-label="`Remove action ${index + 1}`"
          @click="actions.splice(index, 1)"
        >
          Remove
        </button>
      </div>
      <button
        v-if="actions.length < MAX_ACTIONS"
        class="text-xs text-primary hover:underline"
        data-add-action
        @click="addAction"
      >
        Add an action
      </button>
      <p
        v-if="!canSetVisibility"
        class="text-xs text-muted"
      >
        Setting a task internal or customer is for the project owner only, so that option is off here.
      </p>
      <p class="text-xs text-muted">
        If a step fails, the steps before it stay applied: they are not undone.
      </p>
    </section>

    <div
      class="flex min-h-14 items-center rounded-lg bg-elevated px-3 py-2 text-sm"
      data-rule-preview
    >
      <span
        v-if="preview"
        class="text-default"
      >{{ preview }}</span>
      <span
        v-else
        class="text-error"
        data-rule-problems
      >{{ firstProblem }}</span>
    </div>

    <p
      v-if="saveError"
      class="text-xs text-error"
      data-rule-error
    >
      {{ saveError }}
    </p>

    <div class="flex justify-end gap-2">
      <UButton
        label="Cancel"
        color="neutral"
        variant="ghost"
        size="sm"
        @click="emit('cancel')"
      />
      <UButton
        :label="rule ? 'Save rule' : 'Create rule'"
        size="sm"
        :disabled="!checked.ok"
        :loading="saving"
        data-rule-save
        @click="save"
      />
    </div>
  </div>
</template>
