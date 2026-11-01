<script setup lang="ts">
import { format } from 'date-fns'
import { dueDayToMs } from '~/utils/dueDate'
import { errorMessage } from '~/utils/untypedFetch'
import { GOAL_STATUSES, statusMeta, useGoals } from '~/composables/useGoals'
import type { Goal } from '~/composables/useGoals'

definePageMeta({ layout: 'app' })

const { sidebarOpen } = useSidebar()
useSeoMeta({ title: 'Goals' })

const { goals, loading, load, create, update, remove } = useGoals()
const toast = useToast()

onMounted(load)

function fail(e: unknown, fallback: string) {
  toast.add({ title: errorMessage(e, fallback), icon: 'i-lucide-alert-triangle', color: 'error' })
}

// Goals nest: the top ones are listed, each with its sub-goals beneath.
const top = computed(() => goals.value.filter(goal => !goal.parentId || !goals.value.some(other => other.id === goal.parentId)))
const childrenOf = (id: string) => goals.value.filter(goal => goal.parentId === id)

const title = ref('')
async function add() {
  const text = title.value.trim()
  if (!text) return
  title.value = ''
  try {
    const goal = await create({ title: text })
    openId.value = goal.id
  } catch (e) {
    fail(e, 'Could not add the goal')
  }
}

const openId = ref<string | null>(null)

async function change(goal: Goal, body: Record<string, unknown>) {
  try {
    await update(goal.id, body)
  } catch (e) {
    fail(e, 'Could not save the goal')
  }
}

async function addSub(parent: Goal, input: HTMLInputElement) {
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  try {
    await create({ title: text, parentId: parent.id })
  } catch (e) {
    fail(e, 'Could not add the sub-goal')
  }
}

const deleting = ref<Goal | null>(null)
async function confirmDelete() {
  const goal = deleting.value
  deleting.value = null
  if (!goal) return
  try {
    await remove(goal.id)
  } catch (e) {
    fail(e, 'Could not delete the goal')
  }
}

function dueLabel(day: string) {
  return format(dueDayToMs(day), 'MMM d, yyyy')
}
</script>

<template>
  <div class="flex min-w-0 flex-1 flex-col">
    <header class="flex shrink-0 items-center gap-2 border-b border-default px-4 py-3 lg:px-6">
      <UButton
        icon="i-lucide-panel-left"
        color="neutral"
        variant="ghost"
        size="sm"
        class="lg:hidden"
        aria-label="Open sidebar"
        @click="sidebarOpen = true"
      />
      <h1 class="text-base font-semibold text-default">
        Goals
      </h1>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4 lg:px-6">
      <div class="mx-auto max-w-3xl">
        <p class="mb-4 text-sm text-muted">
          Goals group projects toward an outcome. In a team, everyone on the team sees them. In your personal workspace, only you do.
        </p>
        <form
          class="mb-4 flex gap-2"
          @submit.prevent="add"
        >
          <UInput
            v-model="title"
            placeholder="Name the goal, such as “Launch the new site”"
            class="flex-1"
            :ui="{ root: 'w-full' }"
            data-goal-title
          />
          <UButton
            type="submit"
            label="Add goal"
            icon="i-lucide-plus"
            :disabled="!title.trim()"
            data-goal-add
          />
        </form>
        <p
          data-goal-hint
          class="mt-1 min-h-4 text-xs text-muted"
        >
          {{ title.trim() ? 'Press Add goal to save it.' : 'Type the goal name to turn on Add goal.' }}
        </p>

        <p
          v-if="!goals.length && !loading"
          class="rounded-xl border border-dashed border-default p-8 text-center text-sm text-muted"
          data-goals-empty
        >
          No goals yet. Add one above, then open it and pick the projects that move it.
        </p>

        <ul class="space-y-2">
          <template
            v-for="goal in top"
            :key="goal.id"
          >
            <li
              v-for="entry in [goal, ...childrenOf(goal.id)]"
              :key="entry.id"
              :class="entry.id === goal.id ? '' : 'ml-6'"
              class="rounded-xl border border-default bg-default"
              :data-goal="entry.id"
            >
              <button
                type="button"
                class="flex w-full items-center gap-3 px-4 py-3 text-left"
                @click="openId = openId === entry.id ? null : entry.id"
              >
                <span
                  class="size-2.5 shrink-0 rounded-full"
                  :class="statusMeta(entry.status)?.dot ?? 'bg-neutral-300'"
                />
                <span class="min-w-0 flex-1">
                  <span
                    class="block truncate text-sm font-medium text-default"
                    data-goal-name
                  >{{ entry.title }}</span>
                  <span class="mt-0.5 block text-xs text-muted">
                    {{ statusMeta(entry.status)?.label ?? 'No status' }}<template v-if="entry.owner"> · {{ entry.owner.name }}</template><template v-if="entry.dueOn"> · due {{ dueLabel(entry.dueOn) }}</template><template v-if="entry.projects.length"> · {{ entry.projects.length }} project{{ entry.projects.length === 1 ? '' : 's' }}</template>
                  </span>
                </span>
                <span class="flex w-32 shrink-0 items-center gap-2">
                  <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-elevated">
                    <span
                      class="block h-full rounded-full bg-primary transition-all"
                      :style="{ width: `${entry.progress}%` }"
                    />
                  </span>
                  <span
                    class="w-9 text-right text-xs tabular-nums text-muted"
                    data-goal-progress
                  >{{ entry.progress }}%</span>
                </span>
              </button>

              <div
                v-if="openId === entry.id"
                class="space-y-4 border-t border-default px-4 py-4"
                data-goal-editor
              >
                <UInput
                  :model-value="entry.title"
                  size="sm"
                  :ui="{ root: 'w-full' }"
                  aria-label="Title"
                  data-goal-edit-title
                  @change="(e: Event) => change(entry, { title: (e.target as HTMLInputElement).value })"
                />

                <div>
                  <p class="mb-1.5 text-xs font-medium text-muted">
                    Status
                  </p>
                  <div class="flex flex-wrap gap-1.5">
                    <button
                      v-for="status in GOAL_STATUSES"
                      :key="status.key"
                      type="button"
                      class="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
                      :class="entry.status === status.key ? 'border-primary bg-primary/10 text-default' : 'border-default text-muted hover:bg-elevated'"
                      :data-goal-status="status.key"
                      @click="change(entry, { status: entry.status === status.key ? null : status.key })"
                    >
                      <span
                        class="size-2 rounded-full"
                        :class="status.dot"
                      />
                      {{ status.label }}
                    </button>
                  </div>
                </div>

                <div class="grid gap-4 sm:grid-cols-2">
                  <label class="block">
                    <span class="mb-1.5 block text-xs font-medium text-muted">Due</span>
                    <input
                      type="date"
                      class="w-full rounded-lg border border-default bg-default px-2.5 py-1.5 text-sm text-default"
                      :value="entry.dueOn ?? ''"
                      data-goal-due
                      @change="(e: Event) => change(entry, { dueOn: (e.target as HTMLInputElement).value || null })"
                    >
                  </label>
                  <label class="block">
                    <span class="mb-1.5 block text-xs font-medium text-muted">Progress: {{ entry.progress }}%</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="5"
                      class="w-full accent-primary"
                      :value="entry.manualProgress"
                      :disabled="entry.progressFromProjects"
                      data-goal-slider
                      @change="(e: Event) => change(entry, { progress: Number((e.target as HTMLInputElement).value) })"
                    >
                  </label>
                </div>

                <label class="flex items-start gap-2">
                  <input
                    type="checkbox"
                    class="mt-0.5 size-4 accent-primary"
                    :checked="entry.progressFromProjects"
                    data-goal-from-projects
                    @change="change(entry, { progressFromProjects: !entry.progressFromProjects })"
                  >
                  <span class="text-sm text-default">Read progress from the linked projects
                    <span class="block text-xs text-muted">The average of how much of each project is done.</span>
                  </span>
                </label>

                <div>
                  <p class="mb-1.5 text-xs font-medium text-muted">
                    Projects that move this goal
                  </p>
                  <ProjectPicker
                    :model-value="entry.projects.map(project => project.id)"
                    @update:model-value="(ids: string[]) => change(entry, { projectIds: ids })"
                  />
                </div>

                <form
                  v-if="entry.id === goal.id"
                  class="flex gap-2"
                  @submit.prevent="(e: Event) => addSub(entry, (e.target as HTMLFormElement).elements.namedItem('sub') as HTMLInputElement)"
                >
                  <input
                    name="sub"
                    placeholder="Add a sub-goal"
                    class="flex-1 rounded-lg border border-default bg-default px-2.5 py-1.5 text-sm text-default"
                    data-goal-sub
                  >
                  <UButton
                    type="submit"
                    label="Add"
                    size="sm"
                    color="neutral"
                    variant="soft"
                  />
                </form>

                <div class="flex justify-end">
                  <UButton
                    label="Delete goal"
                    icon="i-lucide-trash-2"
                    size="xs"
                    color="error"
                    variant="ghost"
                    data-goal-delete
                    @click="deleting = entry"
                  />
                </div>
              </div>
            </li>
          </template>
        </ul>
      </div>
    </div>

    <UModal
      :open="!!deleting"
      title="Delete this goal?"
      :description="deleting ? `“${deleting.title}” goes away. Its sub-goals stay, and so do its projects.` : ''"
      @update:open="(open: boolean) => { if (!open) deleting = null }"
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            label="Cancel"
            color="neutral"
            variant="ghost"
            @click="deleting = null"
          />
          <UButton
            label="Delete"
            color="error"
            data-goal-confirm-delete
            @click="confirmDelete"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
