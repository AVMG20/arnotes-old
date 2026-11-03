<script setup lang="ts">
import { formatDateMention } from '~/composables/useDateMention'
import { relativeTime } from '~/composables/useRelativeTime'
import { deletionSourceLabel } from '#shared/utils/board'
import { descriptionDetails } from '~/utils/cardDetails'
import { selectChipsOf } from '~/composables/useCustomFields'
import { blockedChipLabel } from '~/utils/taskBlockers'
import { chipStyle } from '#shared/utils/colors'
import { dueDayToMs, isOverdueDay } from '~/utils/dueDate'
import { boardGithubBadgesOf, boardPeople, boardPerson, boardSubtasksOf } from '~/composables/useProjects'
import type { ProjectTask } from '~/composables/useProjects'

const props = defineProps<{
  task: {
    id: string
    projectId?: string
    title: string
    description: string
    tags: string[]
    visibility?: 'internal' | 'customer'
    assigneeId?: string | null
    dueOn?: string | null
    completedAt?: number | null
    deletedAt?: number | null
    deletedVia?: 'ui' | 'mcp' | 'ai' | null
    // Set from the board when the task waits for tasks that are not finished yet.
    blocked?: boolean
    blockedBy?: string[]
  }
  commentCount?: number
  // A customer contact's board: labels are shown, not recoloured, and the
  // done mark is shown but not a button.
  readonly?: boolean
}>()

const emit = defineEmits<{
  open: [taskId: string]
  restore: [taskId: string]
  purge: [taskId: string]
  toggleComplete: [taskId: string]
  assign: [taskId: string, personId: string | null]
}>()

// A card in the board's trash is drawn in place, faded, so it is obvious both
// that it is gone and where it used to sit. It is not a link into the task
// panel: there is nothing to edit until it is back.
const trashed = computed(() => props.task.deletedAt != null)

const trashedLabel = computed(() => {
  if (!props.task.deletedAt) return ''
  return `Deleted ${relativeTime(props.task.deletedAt)}${deletionSourceLabel(props.task.deletedVia)}`
})

// Cards stay quiet: one line of plain text from the description, never rendered
// HTML. The formatted version lives in the task panel.
const details = computed(() => descriptionDetails(props.task.description ?? ''))

const snippet = computed(() => details.value.snippet)

// Both of these are read out of the description rather than stored: a checklist
// is the editor's task list, a due date is an `@date` mention. Nothing to fill
// in, and nothing that can fall out of step with what the task actually says.
const checklist = computed(() => details.value.checklist)
const checklistDone = computed(() => !!checklist.value && checklist.value.done === checklist.value.total)

// A due date set on the task wins; without one, the first `@date` in the
// description still stands in for it.
const due = computed(() => props.task.dueOn ? dueDayToMs(props.task.dueOn) : details.value.due)
const dueLabel = computed(() => due.value === null ? '' : formatDateMention(new Date(due.value).toISOString()))
const completed = computed(() => props.task.completedAt != null)
const overdue = computed(() => {
  if (completed.value || due.value === null) return false
  return props.task.dueOn ? isOverdueDay(props.task.dueOn) : due.value < Date.now()
})

// Only staff are ever sent an internal task, so the mark needs no audience check.
const internal = computed(() => props.task.visibility === 'internal')

const assignee = computed(() => boardPerson(props.task.assigneeId))

// The quick-assign menu on the card's foot, the same choices as the task panel's.
const assignItems = computed(() => [
  [{ label: 'Unassigned', icon: 'i-lucide-user-x', onSelect: () => emit('assign', props.task.id, null) }],
  boardPeople().map(person => ({
    label: person.kind === 'customer' ? `${person.name || person.email} (customer)` : person.name || person.email,
    avatar: { src: person.image ?? undefined, alt: person.name || person.email },
    onSelect: () => emit('assign', props.task.id, person.id)
  }))
])

// A select field's choice, such as a priority, rides the card as a coloured chip.
const fieldChips = computed(() => selectChipsOf(props.task.projectId, props.task.id))

const cover = computed(() => /<img[^>]+src="(\/api\/attachments\/tasks\/[^"]+)"/.exec(props.task.description ?? '')?.[1] ?? null)

// The badge counts every subtask under the task, at any nesting depth, not
// just its direct children.
function allSubtasks(taskId: string): ProjectTask[] {
  const direct = boardSubtasksOf(taskId)
  return direct.flatMap(t => [t, ...allSubtasks(t.id)])
}
const subtasks = computed(() => allSubtasks(props.task.id))
const subtasksDone = computed(() => subtasks.value.filter(t => t.completedAt != null).length)

// The first GitHub item the viewer may see, drawn as "#45 merged, checks passing".
// The board sends only visible links, so a customer never gets an internal one.
const githubBadge = computed(() => {
  const badge = boardGithubBadgesOf(props.task.id)[0]
  if (!badge) return null
  const icon = {
    issue: 'i-lucide-circle-dot',
    pull: 'i-lucide-git-pull-request',
    branch: 'i-lucide-git-branch',
    workflow_run: 'i-lucide-play'
  }[badge.kind]
  let label = badge.kind === 'branch'
    ? `${badge.title ?? badge.ref}${badge.state ? `, ${badge.state}` : ''}`
    : badge.kind === 'workflow_run'
      ? `run ${badge.ref}${badge.state ? ` ${badge.state}` : ''}`
      : `#${badge.ref}${badge.state ? ` ${badge.state}` : ''}`
  if (badge.checks) label += `, checks ${badge.checks}`
  const checksTone = badge.checks === 'failing'
    ? 'text-error'
    : badge.checks === 'running' ? 'text-warning' : badge.checks === 'passing' ? 'text-success' : ''
  return { icon, label, checksTone, title: badge.title }
})

// The blocked mark: a task with an open blocker on this board. Derived on the server, never stored.
const blockedChip = computed(() => props.task.blocked ? blockedChipLabel(props.task.blockedBy?.length ?? null) : '')

// One row of small print under the card, or none at all.
const hasMeta = computed(() =>
  props.task.tags.length > 0 || !!checklist.value || due.value !== null || !!props.commentCount
  || internal.value || (!!assignee.value && props.readonly) || subtasks.value.length > 0 || fieldChips.value.length > 0
  || !!githubBadge.value
  || !!blockedChip.value
)
</script>

<template>
  <div
    :data-id="task.id"
    :data-card-id="trashed ? undefined : task.id"
    :role="trashed ? undefined : 'button'"
    :tabindex="trashed ? undefined : 0"
    class="group rounded-lg border bg-default px-3 py-2.5 transition-all"
    :class="trashed
      ? 'border-dashed border-default opacity-50 hover:opacity-100'
      : 'cursor-pointer border-default hover:border-primary/40 hover:shadow-sm focus:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30'"
    @click="trashed || $emit('open', task.id)"
    @keydown.enter.prevent="trashed || $emit('open', task.id)"
    @keydown.space.prevent="trashed || $emit('open', task.id)"
  >
    <!-- The task's first attached image, bled to the card edges as its cover. -->
    <img
      v-if="cover && !trashed"
      :src="cover"
      alt=""
      loading="lazy"
      data-card-cover
      class="-mx-3 -mt-2.5 mb-2 aspect-[16/9] w-[calc(100%+1.5rem)] max-w-none rounded-t-lg object-cover"
    >

    <div class="flex items-start gap-1.5">
      <!-- The done mark, Asana's circle. A button for staff, so ticking a task
           off does not mean opening it; `.stop` keeps the click off the card. -->
      <button
        v-if="!trashed && !readonly"
        type="button"
        class="mt-px shrink-0 rounded-full transition-colors"
        :class="completed ? 'text-success' : 'text-dimmed opacity-60 hover:text-success hover:opacity-100'"
        :aria-label="completed ? 'Mark as not done' : 'Mark as done'"
        :title="completed ? 'Mark as not done' : 'Mark as done'"
        @click.stop="$emit('toggleComplete', task.id)"
        @keydown.enter.stop
        @keydown.space.stop
      >
        <UIcon
          :name="completed ? 'i-lucide-circle-check' : 'i-lucide-circle'"
          class="size-4"
        />
      </button>
      <UIcon
        v-else-if="completed"
        name="i-lucide-circle-check"
        class="mt-px size-4 shrink-0 text-success"
      />
      <p
        class="line-clamp-2 text-sm font-medium leading-snug"
        :class="trashed
          ? 'text-muted line-through decoration-1'
          : completed ? 'text-muted' : 'text-default'"
      >
        {{ task.title }}
      </p>
    </div>

    <p
      v-if="snippet"
      class="mt-1 line-clamp-2 text-xs leading-relaxed text-muted"
    >
      {{ snippet }}
    </p>

    <!-- Labels carry the colour on a card; everything else stays small print so
         the row reads as one quiet line however much of it is filled in. -->
    <div
      v-if="hasMeta"
      class="mt-2 flex items-center gap-1.5"
    >
      <span
        v-for="chip in fieldChips"
        :key="chip.fieldId"
        class="flex min-w-0 items-center truncate rounded px-1.5 py-0.5 text-[0.6875rem] font-medium ring-1 ring-inset"
        :style="chipStyle(chip.color)"
        data-field-chip
      >
        <span class="truncate">{{ chip.label }}</span>
      </span>
      <span
        v-if="blockedChip"
        class="flex min-w-0 items-center truncate rounded px-1.5 py-0.5 text-[0.6875rem] font-medium ring-1 ring-inset text-warning ring-warning/40"
        title="Waits for open tasks on this board"
        data-blocked-chip
      >
        <span class="truncate">{{ blockedChip }}</span>
      </span>
      <KanbanLabelChip
        v-for="tag in task.tags.slice(0, 3)"
        :key="tag"
        :tag="tag"
        :editable="!trashed && !readonly"
        chip-class="text-[0.6875rem]"
      />
      <span
        v-if="task.tags.length > 3"
        class="text-[0.6875rem] text-dimmed"
      >
        +{{ task.tags.length - 3 }}
      </span>

      <span class="ml-auto flex shrink-0 items-center gap-2 text-[0.6875rem] text-dimmed">
        <span
          v-if="githubBadge"
          class="flex min-w-0 items-center gap-1"
          :class="githubBadge.checksTone"
          :title="githubBadge.title ?? undefined"
          data-github-badge
        >
          <UIcon
            :name="githubBadge.icon"
            class="size-3 shrink-0"
          />
          <span class="truncate">{{ githubBadge.label }}</span>
        </span>

        <span
          v-if="internal"
          class="flex items-center gap-1 text-warning"
          title="Team only: the customer does not see this task"
        >
          <UIcon
            name="i-lucide-lock"
            class="size-3"
          />
          Team only
        </span>

        <span
          v-if="due !== null"
          class="flex items-center gap-1"
          :class="overdue ? 'font-medium text-error' : ''"
        >
          <UIcon
            name="i-lucide-calendar"
            class="size-3"
          />
          {{ dueLabel }}
        </span>

        <span
          v-if="checklist"
          class="flex items-center gap-1 tabular-nums"
          :class="checklistDone ? 'text-success' : ''"
        >
          <UIcon
            name="i-lucide-list-checks"
            class="size-3"
          />
          {{ checklist.done }}/{{ checklist.total }}
        </span>

        <span
          v-if="subtasks.length"
          class="flex items-center gap-1 tabular-nums"
          :class="subtasksDone === subtasks.length ? 'text-success' : ''"
          :title="`${subtasksDone} of ${subtasks.length} subtasks done`"
        >
          <UIcon
            name="i-lucide-list-tree"
            class="size-3"
          />
          {{ subtasksDone }}/{{ subtasks.length }}
        </span>

        <span
          v-if="commentCount"
          class="flex items-center gap-1"
        >
          <UIcon
            name="i-lucide-message-square"
            class="size-3"
          />
          {{ commentCount }}
        </span>

        <UAvatar
          v-if="assignee && readonly"
          :src="assignee.image ?? undefined"
          :alt="assignee.name || assignee.email"
          size="3xs"
          :title="`Assigned to ${assignee.name || assignee.email}`"
        />
      </span>
    </div>

    <!-- Asana's foot: who has it, as a button that picks someone (a dashed empty
         person until somebody does), and an arrow that opens the task. -->
    <div
      v-if="!trashed && !readonly"
      class="mt-2 flex items-center justify-between"
    >
      <UDropdownMenu :items="assignItems">
        <button
          type="button"
          class="flex size-6 items-center justify-center rounded-full transition-colors"
          :class="assignee ? '' : 'border border-dashed border-dimmed text-dimmed hover:border-primary hover:text-primary'"
          :aria-label="assignee ? `Assigned to ${assignee.name || assignee.email}, change` : 'Assign to someone'"
          :title="assignee ? `Assigned to ${assignee.name || assignee.email}` : 'Assign to someone'"
          data-card-assign
          @click.stop
          @keydown.enter.stop
          @keydown.space.stop
        >
          <UAvatar
            v-if="assignee"
            :src="assignee.image ?? undefined"
            :alt="assignee.name || assignee.email"
            size="xs"
          />
          <UIcon
            v-else
            name="i-lucide-user"
            class="size-3.5"
          />
        </button>
      </UDropdownMenu>
      <button
        type="button"
        class="flex size-6 items-center justify-center rounded-md text-dimmed opacity-0 transition-opacity hover:bg-elevated hover:text-default focus:opacity-100 group-hover:opacity-100"
        aria-label="Open task"
        title="Open task"
        data-card-open
        @click.stop="$emit('open', task.id)"
        @keydown.enter.stop
        @keydown.space.stop
      >
        <UIcon
          name="i-lucide-chevron-right"
          class="size-4"
        />
      </button>
    </div>

    <div
      v-if="trashed"
      class="mt-2 border-t border-default pt-2"
    >
      <p class="truncate text-[0.6875rem] text-dimmed">
        {{ trashedLabel }}
      </p>
      <div class="mt-1 flex items-center gap-1">
        <UButton
          label="Restore"
          icon="i-lucide-undo-2"
          size="xs"
          color="neutral"
          variant="soft"
          @click.stop="$emit('restore', task.id)"
        />
        <UButton
          icon="i-lucide-trash-2"
          size="xs"
          color="error"
          variant="ghost"
          aria-label="Delete permanently"
          title="Delete permanently"
          @click.stop="$emit('purge', task.id)"
        />
      </div>
    </div>
  </div>
</template>
