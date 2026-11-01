<script setup lang="ts">
// The Rules section of Settings: the project's rules, each with its on/off switch,
// its plain sentence and last run, its run log, and the builder for new and
// changed rules. Staff only; the parent mounts this for team members.
import { MAX_RULES_PER_PROJECT } from '~~/server/utils/ruleSpec'
import { listProjectRules, updateProjectRule, deleteProjectRule, ruleErrorMessage } from '~/composables/useProjectRules'
import type { ProjectRule } from '~/composables/useProjectRules'
import { relativeTime } from '~/composables/useRelativeTime'

const props = defineProps<{ projectId: string }>()

const rules = ref<ProjectRule[]>([])
const loading = ref(true)
const loadError = ref('')
// One message per rule when its switch or its delete is refused.
const switchErrors = ref<Record<string, string>>({})
// The rule being edited, 'new' for a rule being created, or null.
const editing = ref<string | null>(null)
const logOpen = ref<string | null>(null)
// Why New rule is off, if it is. The line is always there, so the page does not move.
const newRuleHint = computed(() => {
  if (rules.value.length >= MAX_RULES_PER_PROJECT) return `This project has ${MAX_RULES_PER_PROJECT} rules, the most it can hold. Delete one to add another.`
  if (editing.value !== null) return 'Save or cancel the open rule first.'
  return ''
})

// Visibility can only be set by the project owner: the owner id is on the project record.
// The server checks it again on save.
const { activeProject } = useProjects()
const { session } = useAuth()
const canSetVisibility = computed(() => !!session.value?.user && activeProject.value?.userId === session.value.user.id)

const OUTCOME_WORDS: Record<NonNullable<ProjectRule['lastRun']>['outcome'], string> = {
  ran: 'ran',
  failed: 'failed',
  loop_stopped: 'stopped to prevent a loop'
}

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    rules.value = await listProjectRules(props.projectId)
  } catch (e) {
    loadError.value = ruleErrorMessage(e, 'Could not load the rules')
  } finally {
    loading.value = false
  }
}

watch(() => props.projectId, () => {
  editing.value = null
  logOpen.value = null
  load()
}, { immediate: true })

// The switch changes at once and goes back with a message if the server refuses.
async function setEnabled(rule: ProjectRule, enabled: boolean) {
  const before = rule.enabled
  rule.enabled = enabled
  switchErrors.value = { ...switchErrors.value, [rule.id]: '' }
  try {
    Object.assign(rule, await updateProjectRule(props.projectId, rule.id, { enabled }))
  } catch (e) {
    rule.enabled = before
    switchErrors.value[rule.id] = ruleErrorMessage(e, 'Could not switch the rule')
  }
}

// Deletes the rule and its run log once the person confirms.
async function deleteRule(rule: ProjectRule) {
  if (!window.confirm('Delete this rule and its log?')) return
  try {
    await deleteProjectRule(props.projectId, rule.id)
    rules.value = rules.value.filter(candidate => candidate.id !== rule.id)
    if (logOpen.value === rule.id) logOpen.value = null
  } catch (e) {
    switchErrors.value = { ...switchErrors.value, [rule.id]: ruleErrorMessage(e, 'Could not delete the rule') }
  }
}

async function onSaved() {
  editing.value = null
  await load()
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-3">
      <p class="min-w-0 flex-1 text-sm text-muted">
        Rules do something to a task when it changes. Anyone on the team can make or change them.
      </p>
      <span
        class="shrink-0 text-xs tabular-nums text-dimmed"
        data-rule-count
        :title="'Each project can have up to ' + MAX_RULES_PER_PROJECT + ' rules.'"
      >
        {{ rules.length }} of {{ MAX_RULES_PER_PROJECT }} rules used
      </span>
      <UButton
        label="New rule"
        icon="i-lucide-plus"
        size="sm"
        :disabled="rules.length >= MAX_RULES_PER_PROJECT || editing !== null"
        data-rule-new
        @click="editing = 'new'"
      />
    </div>

    <p
      class="min-h-5 text-xs text-muted"
      data-rule-new-hint
    >
      {{ newRuleHint }}
    </p>

    <KanbanProjectRuleBuilder
      v-if="editing === 'new'"
      :project-id="projectId"
      :can-set-visibility="canSetVisibility"
      @saved="onSaved"
      @cancel="editing = null"
    />

    <p
      v-if="loading"
      class="text-sm text-dimmed"
    >
      Loading the rules...
    </p>
    <p
      v-else-if="loadError"
      class="text-sm text-error"
    >
      {{ loadError }}
    </p>
    <p
      v-else-if="!rules.length && editing !== 'new'"
      class="text-sm text-muted"
      data-rule-empty
    >
      No rules yet. A rule might move a task to Done when it is marked complete, or post a comment when it is moved to a column.
    </p>

    <ul
      v-else
      class="space-y-3"
      data-rule-list
    >
      <li
        v-for="rule in rules"
        :key="rule.id"
        class="rounded-xl border border-default bg-default p-3"
        data-rule
        :data-rule-enabled="rule.enabled"
      >
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium text-default">
              {{ rule.name || 'Untitled rule' }}
            </p>
            <p
              v-if="editing !== rule.id"
              class="mt-1 text-sm leading-relaxed text-muted"
              data-rule-description
            >
              {{ rule.description }}
            </p>
            <p class="mt-1 text-xs text-dimmed">
              <template v-if="rule.lastRun">
                Last run {{ relativeTime(rule.lastRun.createdAt) }}, {{ OUTCOME_WORDS[rule.lastRun.outcome] }}
              </template>
              <template v-else>
                Never run
              </template>
            </p>
            <p
              v-if="switchErrors[rule.id]"
              class="mt-1 text-xs text-error"
              data-rule-switch-error
            >
              {{ switchErrors[rule.id] }}
            </p>
          </div>

          <div class="flex shrink-0 items-center gap-2">
            <button
              role="switch"
              type="button"
              :aria-checked="rule.enabled"
              :aria-label="`${rule.enabled ? 'Switch off' : 'Switch on'} ${rule.name || 'this rule'}`"
              class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors"
              :class="rule.enabled ? 'bg-primary' : 'bg-elevated ring-1 ring-default'"
              data-rule-switch
              @click="setEnabled(rule, !rule.enabled)"
            >
              <span
                class="inline-block size-4 rounded-full bg-white shadow transition-transform"
                :class="rule.enabled ? 'translate-x-4' : 'translate-x-0.5'"
              />
            </button>
            <UButton
              label="Edit"
              color="neutral"
              variant="ghost"
              size="xs"
              :disabled="editing !== null && editing !== rule.id"
              data-rule-edit
              @click="editing = rule.id"
            />
            <UButton
              label="Delete"
              color="error"
              variant="ghost"
              size="xs"
              data-rule-delete
              @click="deleteRule(rule)"
            />
            <UButton
              :label="logOpen === rule.id ? 'Hide log' : 'Run log'"
              color="neutral"
              variant="ghost"
              size="xs"
              data-rule-log-toggle
              @click="logOpen = logOpen === rule.id ? null : rule.id"
            />
          </div>
        </div>

        <div
          v-if="editing === rule.id"
          class="mt-3"
        >
          <KanbanProjectRuleBuilder
            :project-id="projectId"
            :rule="rule"
            :can-set-visibility="canSetVisibility"
            @saved="onSaved"
            @cancel="editing = null"
          />
        </div>

        <div
          v-if="logOpen === rule.id"
          class="mt-3"
        >
          <KanbanProjectRuleLog
            :project-id="projectId"
            :rule-id="rule.id"
          />
        </div>
      </li>
    </ul>
  </div>
</template>
