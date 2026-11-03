<script setup lang="ts">
import { columnDotAttrs } from '~/utils/tagColors'
import { format } from 'date-fns'
import { relativeTime } from '~/composables/useRelativeTime'
import type { Visibility, ProjectTask } from '~/composables/useProjects'
import { dueDayToMs, isOverdueDay } from '~/utils/dueDate'

interface Task {
  id: string
  columnId: string
  title: string
  description: string
  tags: string[]
  visibility?: Visibility
  assigneeId?: string | null
  dueOn?: string | null
  startOn?: string | null
  completedAt?: number | null
  createdAt: number
  updatedAt: number
}

const props = defineProps<{ task: Task | null }>()

const emit = defineEmits<{ close: [] }>()

const toast = useToast()
const {
  activeProject,
  isCustomerView,
  boardColumns,
  boardTagCounts,
  people,
  personById,
  subtasksOf,
  updateTask,
  moveTask,
  deleteTask,
  restoreTask,
  loadComments,
  clearComments
} = useProjects()

// A customer contact reads the task and talks about it; the task itself is the
// team's to edit, and the server refuses the rest.
const readonly = isCustomerView

function fullDate(ts: number) {
  return format(new Date(ts), 'PPp')
}

// The drawer reports "closed" once on mount, before any task is shown. Passing
// that on as a close would wipe a ?task= deep link before the board has even
// loaded the task it points at, so only a close of something open counts.
const open = computed({
  get: () => props.task !== null,
  set: (v: boolean) => { if (!v && props.task) emit('close') }
})

// The panel slides out over ~half a second. It renders the last task it was
// given rather than the prop, so closing it doesn't empty it mid-animation.
const shownTask = ref<Task | null>(props.task)

watch(() => props.task, (task) => {
  if (task) shownTask.value = task
})

const column = computed(() =>
  boardColumns.value.find(c => c.id === shownTask.value?.columnId) ?? null
)

// ─── Panel width: cookie-persisted, drag-resize, reset ──────

const DEFAULT_WIDTH = 620
const MIN_WIDTH = 400

const storedWidth = useCookie<number | null>('kanban-drawer-width', { default: () => null })

const width = ref(DEFAULT_WIDTH)
const maxWidth = ref(DEFAULT_WIDTH)

function measure() {
  maxWidth.value = Math.max(MIN_WIDTH, window.innerWidth - 24)
  width.value = Math.min(storedWidth.value ?? DEFAULT_WIDTH, maxWidth.value)
}

onMounted(() => {
  measure()
  window.addEventListener('resize', measure)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', measure)
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', onResizeEnd)
})

let resizing = false

function onResizeStart(e: PointerEvent) {
  resizing = true
  e.preventDefault()
  window.addEventListener('pointermove', onResizeMove)
  window.addEventListener('pointerup', onResizeEnd)
}

function onResizeMove(e: PointerEvent) {
  if (!resizing) return
  width.value = Math.min(Math.max(window.innerWidth - e.clientX, MIN_WIDTH), maxWidth.value)
}

function onResizeEnd() {
  resizing = false
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', onResizeEnd)
  storedWidth.value = width.value === DEFAULT_WIDTH ? null : width.value
}

function resetWidth() {
  width.value = DEFAULT_WIDTH
  storedWidth.value = null
}

// Label box state, reset with the task.
const tagDraft = ref('')
const tagFocused = ref(false)
const tagHighlight = ref(-1)

// ─── Title (auto-save) ─────────────────────────────────────

const titleDraft = ref('')
let titleTimer: ReturnType<typeof setTimeout> | null = null
let titleDirty = false

// The id is passed in rather than read off props: by the time the task-switch
// watcher runs, props.task is already the task being opened, so flushing
// against it would write this task's draft onto the next one.
function flushTitle(taskId = props.task?.id) {
  if (titleTimer) {
    clearTimeout(titleTimer)
    titleTimer = null
  }
  if (!titleDirty) return
  titleDirty = false
  if (taskId) updateTask(taskId, { title: titleDraft.value })
}

watch(titleDraft, (v) => {
  if (!props.task || v === props.task.title) return
  titleDirty = true
  if (titleTimer) clearTimeout(titleTimer)
  titleTimer = setTimeout(() => flushTitle(), 600)
})

// ─── Description (auto-save) ────────────────────────────────

const editorContent = ref('')
let descTimer: ReturnType<typeof setTimeout> | null = null
let descDirty = false
let suppressSave = false

function flushDescription(taskId = props.task?.id) {
  if (descTimer) {
    clearTimeout(descTimer)
    descTimer = null
  }
  if (!descDirty) return
  descDirty = false
  if (taskId) updateTask(taskId, { description: editorContent.value })
}

watch(editorContent, () => {
  if (suppressSave) return
  descDirty = true
  if (descTimer) clearTimeout(descTimer)
  descTimer = setTimeout(() => flushDescription(), 600)
})

// Switching task saves whatever the previous one had pending — against that
// task's id — and then reloads every draft.
// Closing leaves every draft alone: the panel is still on screen animating out,
// and the next open overwrites them anyway.
watch(() => props.task?.id, (id, previousId) => {
  flushTitle(previousId)
  flushDescription(previousId)
  if (!id) return

  titleDraft.value = props.task?.title ?? ''
  suppressSave = true
  editorContent.value = props.task?.description ?? ''
  nextTick(() => {
    suppressSave = false
  })

  tagDraft.value = ''
  tagHighlight.value = -1
  clearComments()
  loadComments(id)
}, { immediate: true })

// Changes made elsewhere — an agent over MCP, a teammate, the AI chat — land in
// the open panel, but never on top of what the user is in the middle of typing.
watch(() => props.task?.title, (title) => {
  if (title === undefined || titleDirty || titleTimer) return
  if (title !== titleDraft.value) titleDraft.value = title
})

watch(() => props.task?.description, (description) => {
  if (description === undefined || descDirty || descTimer) return
  if (description === editorContent.value) return
  suppressSave = true
  editorContent.value = description
  nextTick(() => {
    suppressSave = false
  })
})

onBeforeUnmount(() => {
  flushTitle()
  flushDescription()
})

// ─── Images ────────────────────────────────────────────────

// Pasted or dropped into the description. The file is stored with the task and
// served from the task's own attachment route.
async function uploadImage(file: File): Promise<string | null> {
  const id = props.task?.id
  if (!id) return null
  const form = new FormData()
  form.append('file', file)
  try {
    const res = await $fetch<{ url: string }>(`/api/tasks/${id}/attachments`, { method: 'POST', body: form })
    return res.url
  } catch (e) {
    const err = e as { data?: { message?: string } }
    toast.add({
      title: 'Image upload failed',
      description: err?.data?.message,
      icon: 'i-lucide-image-off',
      color: 'error',
      duration: 3000
    })
    return null
  }
}

// ─── Labels ────────────────────────────────────────────────

// A label is only worth anything when it is the same label the rest of the board
// carries, and typing one from memory is how a board ends up holding "bug",
// "bugs" and "Bug" in three different colours. Focusing the field offers what is
// already in use; typing narrows it.
const tagSuggestions = computed(() => {
  const partial = tagDraft.value.trim().toLowerCase()
  const own = props.task?.tags ?? []
  return boardTagCounts.value
    .map(([tag]) => tag)
    .filter(tag => !own.includes(tag) && (!partial || tag.includes(partial)))
    .slice(0, 6)
})

const showTagSuggestions = computed(() => tagFocused.value && tagSuggestions.value.length > 0)

// -1 is "nothing picked": an open list under an empty field is a menu to look
// at, not an answer waiting on Enter. Typing narrows it to a best match, and
// arrowing always picks.
watch(tagDraft, (draft) => {
  tagHighlight.value = draft.trim() ? 0 : -1
})

function addTagValue(value: string) {
  const tag = value.trim().toLowerCase()
  tagDraft.value = ''
  tagHighlight.value = -1
  if (!tag || !props.task || props.task.tags.includes(tag)) return
  updateTask(props.task.id, { tags: [...props.task.tags, tag] })
}

function addTag() {
  addTagValue(tagDraft.value)
}

function removeTag(tag: string) {
  if (!props.task) return
  updateTask(props.task.id, { tags: props.task.tags.filter(t => t !== tag) })
}

function onTagKeydown(e: KeyboardEvent) {
  const suggestions = showTagSuggestions.value ? tagSuggestions.value : []

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!suggestions.length) return
    e.preventDefault()
    const step = e.key === 'ArrowDown' ? 1 : -1
    tagHighlight.value = (Math.max(tagHighlight.value, 0) + step + suggestions.length) % suggestions.length
  } else if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault()
    // The picked suggestion is what the field is offering, so that is what Enter
    // takes; with nothing picked it is the label being typed.
    addTagValue(suggestions[tagHighlight.value] ?? tagDraft.value)
  } else if (e.key === 'Escape') {
    if (!suggestions.length) return
    e.preventDefault()
    e.stopPropagation()
    tagFocused.value = false
  } else if (e.key === 'Backspace' && !tagDraft.value && props.task?.tags.length) {
    removeTag(props.task.tags[props.task.tags.length - 1]!)
  }
}

function onTagBlur() {
  tagFocused.value = false
  addTag()
}

// ─── Comments ──────────────────────────────────────────────

// The thread and its box live in TaskComments.vue. Escape goes to the thread
// first, so it can end a reply or an edit before the drawer closes.
const thread = ref<{ handleEscape: () => boolean } | null>(null)

function onDrawerEscape(event: KeyboardEvent) {
  if (thread.value?.handleEscape()) event.preventDefault()
}

// ─── Done, assignee, due date ──────────────────────────────

const taskCompleted = computed(() => shownTask.value?.completedAt != null)

async function patchTask(patch: Parameters<typeof updateTask>[1], failure: string) {
  const task = props.task
  if (!task || readonly.value) return
  try {
    await updateTask(task.id, patch)
  } catch {
    toast.add({ title: failure, icon: 'i-lucide-alert-triangle', color: 'error' })
  }
}

function toggleCompleted() {
  return patchTask({ completed: !taskCompleted.value }, 'Could not update the task')
}

const assignee = computed(() => personById(shownTask.value?.assigneeId))

const assigneeItems = computed(() => [
  [{ label: 'Unassigned', icon: 'i-lucide-user-x', onSelect: () => patchTask({ assigneeId: null }, 'Could not change the assignee') }],
  people.value.map(person => ({
    // Customer contacts are told apart, since giving them work is a choice.
    label: person.kind === 'customer' ? `${person.name || person.email} (customer)` : person.name || person.email,
    avatar: { src: person.image ?? undefined, alt: person.name || person.email },
    onSelect: () => patchTask({ assigneeId: person.id }, 'Could not change the assignee')
  }))
])

function onDueChange(event: Event) {
  const value = (event.target as HTMLInputElement).value
  patchTask({ dueOn: value || null }, 'Could not change the due date')
}

function onStartChange(event: Event) {
  const value = (event.target as HTMLInputElement).value
  patchTask({ startOn: value || null }, 'Could not change the start date')
}

const dueOverdue = computed(() => {
  const due = shownTask.value?.dueOn
  return !!due && !taskCompleted.value && isOverdueDay(due)
})

// ─── Subtasks ──────────────────────────────────────────────

// Every subtask under the task, at any nesting depth — the checklist header
// counts the whole tree, matching the card badge (see KanbanCard.vue).
function allSubtasks(taskId: string): ProjectTask[] {
  const direct = subtasksOf(taskId)
  return direct.flatMap(t => [t, ...allSubtasks(t.id)])
}
const subtasks = computed(() => shownTask.value ? allSubtasks(shownTask.value.id) : [])

// ─── Visibility ────────────────────────────────────────────

const taskInternal = computed(() => shownTask.value?.visibility === 'internal')

async function toggleTaskVisibility() {
  const task = props.task
  if (!task || readonly.value) return
  const before = task.visibility
  const next = before === 'internal' ? 'customer' : 'internal'
  // The Undo toast is the safety net, so a change does not ask first.
  try {
    await updateTask(task.id, { visibility: next })
  } catch {
    toast.add({ title: 'Could not change who sees this task', icon: 'i-lucide-alert-triangle', color: 'error' })
    return
  }
  // The undo puts the task back the way it was; it does not ask again.
  toast.add({
    title: next === 'internal' ? 'Now team only: the customer cannot see this task.' : 'Now shared with the customer.',
    duration: 6000,
    actions: [{
      label: 'Undo',
      onClick: () => {
        void updateTask(task.id, { visibility: before }).catch(() => {
          toast.add({ title: 'Could not undo', icon: 'i-lucide-alert-triangle', color: 'error' })
        })
      }
    }]
  })
}

// ─── Move / delete ─────────────────────────────────────────

async function moveToColumn(columnId: string) {
  if (!props.task || props.task.columnId === columnId) return
  await moveTask(props.task.id, columnId, null, null)
}

const stateItems = computed(() =>
  [boardColumns.value.map(c => ({
    label: c.name,
    // Rendered by the #item slot below: the same dot as the board column, so
    // state reads the same in both places.
    dot: columnDotAttrs(c),
    active: c.id === props.task?.columnId,
    onSelect: () => moveToColumn(c.id)
  }))]
)

const deleteOpen = ref(false)

async function confirmDelete() {
  if (!props.task) return
  deleteOpen.value = false
  const id = props.task.id
  // Drop pending autosaves: the row is about to be gone.
  descDirty = false
  titleDirty = false
  emit('close')
  await deleteTask(id)
  toast.add({
    title: 'Task moved to Trash',
    icon: 'i-lucide-trash-2',
    duration: 10000,
    actions: [{
      label: 'Undo',
      onClick: () => {
        void restoreTask(id).catch(() => {
          toast.add({ title: 'Could not undo', icon: 'i-lucide-alert-triangle', color: 'error' })
        })
      }
    }]
  })
}

const menuItems = computed(() => [[
  { label: 'Reset panel width', icon: 'i-lucide-rotate-ccw', onSelect: resetWidth }
], ...(readonly.value
  ? []
  : [[{
      label: 'Delete task',
      icon: 'i-lucide-trash-2',
      color: 'error' as const,
      onSelect: () => { deleteOpen.value = true }
    }]])])
</script>

<template>
  <!-- `handle-only` with no handle rendered means nothing on the panel is a
       drag surface: swipe-to-dismiss fired on mouse drags inside the
       description and comment fields. Close is the X, a click outside, or
       Escape. The left edge still resizes. -->
  <UDrawer
    v-model:open="open"
    direction="right"
    :handle="false"
    handle-only
    :ui="{ content: 'inset-y-0 right-0 rounded-none' }"
    :content="{ onEscapeKeyDown: onDrawerEscape }"
  >
    <template #content>
      <div
        v-if="shownTask"
        class="relative flex h-full flex-col bg-default focus:outline-none"
        :style="{ width: `${width}px`, maxWidth: '100%' }"
      >
        <!-- Resize edge -->
        <div
          class="group absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize"
          @pointerdown="onResizeStart"
        >
          <div class="absolute inset-y-0 left-0 w-px bg-default transition-colors group-hover:bg-primary" />
        </div>

        <!-- Header: state, breadcrumb, actions -->
        <header class="flex flex-wrap shrink-0 items-center gap-x-2 gap-y-1.5 border-b border-default px-4 py-2.5">
          <!-- The button borrows the menu's own padding and gap (6px each) so
               that with the menu flush against it, its dot and label sit on the
               same two vertical lines as every dot and label in the list.
               `items-center` because the theme starts menu items at the top,
               which leaves the dots riding above their labels. -->
          <UButton
            v-if="!readonly"
            :icon="taskCompleted ? 'i-lucide-circle-check' : 'i-lucide-circle'"
            size="xs"
            :color="taskCompleted ? 'success' : 'neutral'"
            :variant="taskCompleted ? 'soft' : 'outline'"
            :label="taskCompleted ? 'Done' : 'Mark done'"
            class="shrink-0"
            @click="toggleCompleted"
          />
          <UBadge
            v-else-if="taskCompleted"
            color="success"
            variant="soft"
            icon="i-lucide-circle-check"
            class="shrink-0"
          >
            Done
          </UBadge>
          <UBadge
            v-if="readonly"
            color="neutral"
            variant="soft"
            class="shrink-0 gap-1.5"
          >
            <span
              class="size-2 shrink-0 rounded-full"
              :class="columnDotAttrs(column ?? { name: '' }).class"
              :style="columnDotAttrs(column ?? { name: '' }).style"
            />
            {{ column?.name ?? 'No column' }}
          </UBadge>
          <UDropdownMenu
            v-else
            :items="stateItems"
            :content="{ align: 'start', collisionPadding: 12 }"
            :ui="{ item: 'items-center' }"
          >
            <UButton
              color="neutral"
              variant="soft"
              size="xs"
              trailing-icon="i-lucide-chevron-down"
              :ui="{ base: 'px-1.5 gap-1.5' }"
            >
              <span
                class="size-2 shrink-0 rounded-full"
                :class="columnDotAttrs(column ?? { name: '' }).class"
                :style="columnDotAttrs(column ?? { name: '' }).style"
              />
              {{ column?.name ?? 'No column' }}
            </UButton>

            <template #item="{ item }">
              <span
                class="size-2 shrink-0 rounded-full"
                :class="item.dot.class"
                :style="item.dot.style"
              />
              <span class="flex-1 truncate text-left">{{ item.label }}</span>
              <UIcon
                v-if="item.active"
                name="i-lucide-check"
                class="size-3.5 text-primary"
              />
            </template>
          </UDropdownMenu>

          <!-- Board and last-edited time, kept to one quiet line; the exact
               timestamps live in the tooltip. -->
          <span
            class="min-w-0 flex-1 truncate text-xs text-dimmed"
            :title="`Created ${fullDate(shownTask.createdAt)}\nUpdated ${fullDate(shownTask.updatedAt)}`"
          >
            <template v-if="activeProject">{{ activeProject.name }} · </template>edited {{ relativeTime(shownTask.updatedAt) }}
          </span>

          <UButton
            v-if="!readonly"
            :icon="taskInternal ? 'i-lucide-lock' : 'i-lucide-eye'"
            size="xs"
            :color="taskInternal ? 'warning' : 'neutral'"
            variant="soft"
            :label="taskInternal ? 'Team only' : 'Shared with customer'"
            :title="taskInternal
              ? 'Team only. Click to share with the customer.'
              : 'Shared with the customer. Click to make it team only.'"
            @click="toggleTaskVisibility"
          />

          <UDropdownMenu
            :items="menuItems"
            :content="{ align: 'end', collisionPadding: 12 }"
          >
            <UButton
              icon="i-lucide-ellipsis"
              size="xs"
              color="neutral"
              variant="ghost"
              aria-label="Task options"
            />
          </UDropdownMenu>
          <UButton
            icon="i-lucide-x"
            size="xs"
            color="neutral"
            variant="ghost"
            aria-label="Close"
            @click="emit('close')"
          />
        </header>

        <!-- Title + labels + description -->
        <!-- Everything below the header scrolls as one on a short screen (a phone), with
             the description kept at a usable height instead of squeezed to its toolbar. -->
        <div
          data-drawer-body
          class="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
        >
          <div class="shrink-0 px-5 pb-3 pt-4">
            <UTextarea
              v-model="titleDraft"
              :rows="1"
              autoresize
              variant="none"
              placeholder="Task title"
              :readonly="readonly"
              class="w-full"
              :ui="{ base: 'px-0 py-0 text-lg font-semibold leading-snug resize-none' }"
              @keydown.enter.prevent="($event.target as HTMLTextAreaElement).blur()"
            />

            <div class="mt-2 flex flex-wrap items-center gap-1.5">
              <KanbanLabelChip
                v-for="tag in shownTask.tags"
                :key="tag"
                :tag="tag"
                :editable="!readonly"
                :removable="!readonly"
                chip-class="text-xs"
                @remove="removeTag"
              />
              <div
                v-if="!readonly"
                class="relative min-w-24 flex-1"
              >
                <input
                  v-model="tagDraft"
                  :placeholder="shownTask.tags.length ? 'Add label…' : 'Add a label…'"
                  class="w-full bg-transparent py-0.5 text-xs text-default outline-none placeholder:text-dimmed"
                  @keydown="onTagKeydown"
                  @focus="tagFocused = true"
                  @input="tagFocused = true"
                  @blur="onTagBlur"
                >

                <!-- The board's own labels. `mousedown.prevent` keeps the field
                     focused so picking one is not read as blurring away from it. -->
                <div
                  v-if="showTagSuggestions"
                  class="absolute left-0 top-full z-20 mt-1 w-44 rounded-lg border border-default bg-default p-1 shadow-lg"
                >
                  <button
                    v-for="(tag, index) in tagSuggestions"
                    :key="tag"
                    class="flex w-full items-center rounded-md px-1 py-1 text-left transition-colors"
                    :class="index === tagHighlight ? 'bg-elevated' : 'hover:bg-elevated/60'"
                    @mousedown.prevent="addTagValue(tag)"
                  >
                    <KanbanLabelChip
                      :tag="tag"
                      chip-class="min-w-0 text-xs"
                    />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Assignee and due date, Asana's two fields every task has. -->
          <dl class="grid shrink-0 grid-cols-[6rem_1fr] items-center gap-x-3 gap-y-1.5 px-5 pb-3 text-xs">
            <dt class="text-muted">
              Assignee
            </dt>
            <dd class="min-w-0">
              <UDropdownMenu
                v-if="!readonly"
                :items="assigneeItems"
                :content="{ align: 'start', collisionPadding: 12 }"
              >
                <UButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  class="-ml-2 max-w-full"
                  :avatar="assignee ? { src: assignee.image ?? undefined, alt: assignee.name || assignee.email } : undefined"
                  :icon="assignee ? undefined : 'i-lucide-user-plus'"
                  :label="assignee ? (assignee.name || assignee.email) : 'No assignee'"
                  :ui="{ label: assignee ? 'text-default' : 'text-dimmed' }"
                />
              </UDropdownMenu>
              <span
                v-else
                class="text-default"
              >{{ assignee ? (assignee.name || assignee.email) : 'No assignee' }}</span>
            </dd>

            <dt class="text-muted">
              Start date
            </dt>
            <dd class="flex min-w-0 items-center gap-1">
              <input
                v-if="!readonly"
                type="date"
                min="2000-01-01"
                max="2999-12-31"
                :value="shownTask.startOn ?? ''"
                class="rounded bg-transparent px-0 py-0.5 text-xs outline-none focus:ring-1 focus:ring-primary"
                :class="shownTask.startOn ? 'text-default' : 'text-dimmed'"
                data-start-input
                @change="onStartChange"
              >
              <span
                v-else
                class="text-default"
              >{{ shownTask.startOn ? format(new Date(dueDayToMs(shownTask.startOn)), 'PP') : 'No start date' }}</span>
              <UButton
                v-if="!readonly && shownTask.startOn"
                icon="i-lucide-x"
                size="xs"
                color="neutral"
                variant="ghost"
                aria-label="Clear start date"
                @click="patchTask({ startOn: null }, 'Could not change the start date')"
              />
            </dd>

            <dt class="text-muted">
              Due date
            </dt>
            <dd class="flex min-w-0 items-center gap-1">
              <input
                v-if="!readonly"
                type="date"
                min="2000-01-01"
                max="2999-12-31"
                :value="shownTask.dueOn ?? ''"
                class="rounded bg-transparent px-0 py-0.5 text-xs outline-none focus:ring-1 focus:ring-primary"
                :class="dueOverdue ? 'font-medium text-error' : shownTask.dueOn ? 'text-default' : 'text-dimmed'"
                @change="onDueChange"
              >
              <span
                v-else
                :class="dueOverdue ? 'font-medium text-error' : 'text-default'"
              >{{ shownTask.dueOn ? format(new Date(dueDayToMs(shownTask.dueOn)), 'PP') : 'No due date' }}</span>
              <UButton
                v-if="!readonly && shownTask.dueOn"
                icon="i-lucide-x"
                size="xs"
                color="neutral"
                variant="ghost"
                aria-label="Clear due date"
                @click="patchTask({ dueOn: null }, 'Could not change the due date')"
              />
            </dd>
          </dl>

          <KanbanTaskFields
            v-if="!readonly && shownTask"
            :task-id="shownTask.id"
          />

          <KanbanTaskTime
            v-if="!readonly && shownTask"
            :task-id="shownTask.id"
          />

          <!-- Subtasks: an Asana-style checklist, nestable and drag-reorderable. -->
          <div
            v-if="subtasks.length || !readonly"
            class="shrink-0 border-t border-default px-5 py-2.5"
          >
            <p class="mb-1 text-xs font-medium text-muted">
              Subtasks
              <span
                v-if="subtasks.length"
                class="tabular-nums text-dimmed"
              >{{ subtasks.filter(s => s.completedAt != null).length }}/{{ subtasks.length }}</span>
            </p>
            <KanbanSubtaskList
              v-if="shownTask"
              :parent-task-id="shownTask.id"
              :readonly="readonly"
            />
          </div>

          <KanbanTaskGithub
            v-if="shownTask"
            :task-id="shownTask.id"
            :readonly="readonly"
          />

          <!-- Description: the rich-text editor, bounded so it keeps its own scroll -->
          <div class="flex min-h-72 flex-col border-t border-default">
            <div
              v-if="readonly"
              class="min-h-0 flex-1 overflow-y-auto"
            >
              <ReadOnlyRichText :content="shownTask.description" />
            </div>
            <RichEditor
              v-else
              v-model="editorContent"
              :upload-image="uploadImage"
              placeholder="Add a description… (@ for dates, / for commands)"
              class="min-h-0 flex-1"
            />
          </div>
          <!-- Under the description, in the same scroll body: the conversation and its box. -->
          <KanbanTaskComments
            v-if="shownTask"
            :key="shownTask.id"
            ref="thread"
            :task-id="shownTask.id"
            :readonly="readonly"
          />
        </div>
      </div>
    </template>
  </UDrawer>

  <UModal
    v-model:open="deleteOpen"
    title="Delete task?"
    description="It moves to the board's trash with its updates. Project options > Show trashed can restore it for the next 7 days."
    :ui="{ footer: 'justify-end' }"
  >
    <template #footer>
      <UButton
        label="Cancel"
        color="neutral"
        variant="ghost"
        @click="deleteOpen = false"
      />
      <UButton
        label="Delete task"
        color="error"
        @click="confirmDelete"
      />
    </template>
  </UModal>
</template>
