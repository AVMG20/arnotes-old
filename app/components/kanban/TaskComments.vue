<script setup lang="ts">
import { format } from 'date-fns'
import { relativeTime } from '~/composables/useRelativeTime'
import type { TaskActivityItem, TaskComment, Visibility } from '~/composables/useProjects'
import { dueDayToMs } from '~/utils/dueDate'
import { commentLink, replyLineText } from '~/utils/taskComments'
import { commentAuthorName, isGithubUpdate } from '~/utils/commentAuthor'

// The conversation under a task's description: its comments and the log of what
// happened to the task, oldest first, then the box that adds to them. The drawer
// keys this by task, so each task starts with a clean box and no stale reply.

const props = defineProps<{
  taskId: string
  readonly: boolean
}>()

const route = useRoute()
const toast = useToast()
const { session } = useAuth()
const {
  comments,
  activity,
  addComment,
  editComment,
  setCommentVisibility,
  deleteComment
} = useProjects()

const root = ref<HTMLElement | null>(null)

// The drawer's one scroll body. Every jump scrolls it, never the page behind.
function scroller(): HTMLElement | null {
  return root.value?.closest<HTMLElement>('[data-drawer-body]') ?? null
}

function reduceMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function fullDate(ts: number) {
  return format(new Date(ts), 'PPp')
}

function initials(name: string | null | undefined) {
  if (!name) return '?'
  return name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase()
}

const userInitials = computed(() => initials(session.value?.user?.name))

// ─── The thread ────────────────────────────────────────────

const ownComments = computed(() => comments.value.filter(c => c.taskId === props.taskId))
const count = computed(() => ownComments.value.length)

type StreamEntry
  = | { key: string, at: number, comment: TaskComment, activity?: undefined }
    | { key: string, at: number, comment?: undefined, activity: TaskActivityItem }

const stream = computed<StreamEntry[]>(() => [
  ...ownComments.value.map(comment => ({ key: `c-${comment.id}`, at: comment.createdAt, comment })),
  ...activity.value.map(item => ({ key: `a-${item.id}`, at: item.createdAt, activity: item }))
].sort((a, b) => a.at - b.at))

// An update posted by an agent is signed with the key it came in on, not with
// the account that owns the key — otherwise a night of agent work reads back as
// the user's own writing.
function isAgentUpdate(comment: TaskComment) {
  return comment.createdVia === 'mcp' || comment.createdVia === 'ai'
}

function updateAuthor(comment: TaskComment) {
  return commentAuthorName(comment)
}

function updateSourceLabel(comment: TaskComment) {
  if (isGithubUpdate(comment)) return 'GitHub'
  return comment.createdVia === 'mcp' ? 'MCP' : 'AI'
}

const ACTIVITY_ICONS: Record<TaskActivityItem['kind'], string> = {
  created: 'i-lucide-circle-plus',
  completed: 'i-lucide-circle-check',
  reopened: 'i-lucide-rotate-ccw',
  moved: 'i-lucide-arrow-right',
  assigned: 'i-lucide-user-plus',
  unassigned: 'i-lucide-user-minus',
  due: 'i-lucide-calendar',
  start: 'i-lucide-calendar-clock',
  renamed: 'i-lucide-pencil',
  visibility: 'i-lucide-eye',
  label: 'i-lucide-tag',
  blocker_added: 'i-lucide-link',
  blocker_removed: 'i-lucide-unlink'
}

function activityIcon(kind: TaskActivityItem['kind']) {
  return ACTIVITY_ICONS[kind]
}

function activityActor(item: TaskActivityItem) {
  // A change the GitHub sync made names GitHub: the owner's account only writes it.
  if (item.via === 'github') return 'GitHub'
  if (item.detail.rule) return `Rule: ${item.detail.rule}`
  if (item.detail.rule) return `Rule: ${item.detail.rule}`
  return item.actorName ?? 'Someone'
}

function activityDay(day: string | null | undefined) {
  return day ? format(dueDayToMs(day), 'MMM d, yyyy') : ''
}

function activityText(item: TaskActivityItem) {
  const { from, to } = item.detail
  const how = item.via === 'mcp' ? ' (via an agent)' : item.via === 'ai' ? ' (via the AI assistant)' : ''
  switch (item.kind) {
    case 'created': return `created this task${how}`
    case 'completed': return `marked this task done${how}`
    case 'reopened': return `reopened this task${how}`
    case 'moved': return `moved this task from ${from} to ${to}${how}`
    case 'assigned': return `assigned this task to ${to}${how}`
    case 'unassigned': return `removed the assignee${how}`
    case 'due': return to ? `set the due date to ${activityDay(to)}${how}` : `cleared the due date${how}`
    case 'start': return to ? `set the start date to ${activityDay(to)}${how}` : `cleared the start date${how}`
    case 'renamed': return `renamed this task to “${to}”${how}`
    case 'visibility': return `made this task ${to}${how}`
    case 'blocker_added': return `made this task wait for “${to}”${how}`
    case 'blocker_removed': return `no longer waits for “${from}”${how}`
    case 'label': return from ? `removed the label “${from}”` : `added the label “${to}”`
  }
}

// ─── Composer and reply ────────────────────────────────────

const draft = ref('')
// Staff comments start internal: a note to the team is the common case, and
// telling the customer is the step taken on purpose.
const commentVisibility = ref<Visibility>('internal')
const composer = ref<{ focus: () => void } | null>(null)
// The comment the box is answering, if any.
const replyTo = ref<TaskComment | null>(null)

// A reply starts with the parent's visibility for staff, so an answer to an
// internal note stays internal unless the author chooses otherwise.
function startReply(comment: TaskComment) {
  replyTo.value = comment
  if (!props.readonly && comment.visibility) commentVisibility.value = comment.visibility
  nextTick(() => composer.value?.focus())
}

function cancelReply() {
  replyTo.value = null
}

// A reply whose parent disappears (deleted elsewhere) is no longer a reply to anything.
watch(ownComments, (list) => {
  const target = replyTo.value
  if (target && !list.some(c => c.id === target.id)) replyTo.value = null
})

function canReply(comment: TaskComment) {
  // A contact only ever sees customer-visible comments, and may answer those.
  return !props.readonly || comment.visibility === 'customer'
}

async function send() {
  const body = draft.value.trim()
  if (!body) return
  const parent = replyTo.value
  const visibility = props.readonly ? undefined : commentVisibility.value
  draft.value = ''
  replyTo.value = null
  try {
    await addComment(props.taskId, body, visibility, parent?.id)
    await nextTick()
    scrollToEnd()
  } catch {
    draft.value = body
    replyTo.value = parent
    toast.add({ title: 'Could not add the comment', icon: 'i-lucide-alert-triangle', color: 'error' })
  }
}

// ─── Jumping, highlighting and links ───────────────────────

const highlightId = ref<string | null>(null)
let highlightTimer: ReturnType<typeof setTimeout> | null = null

function scrollToEnd() {
  const body = scroller()
  body?.scrollTo({ top: body.scrollHeight, behavior: reduceMotion() ? 'auto' : 'smooth' })
}

// Brings one comment to the middle of the drawer's body and highlights it for
// about two seconds. The frames argument is for a comment that is in the data
// but not yet on screen, such as a drawer still sliding open.
async function focusComment(commentId: string, frames = 30): Promise<void> {
  await nextTick()
  const el = root.value?.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(commentId)}"]`)
  const body = scroller()
  if (!el || !body) {
    if (frames > 0 && ownComments.value.some(c => c.id === commentId)) {
      await new Promise(resolve => requestAnimationFrame(resolve))
      return focusComment(commentId, frames - 1)
    }
    return
  }
  const box = body.getBoundingClientRect()
  const target = el.getBoundingClientRect()
  const top = body.scrollTop + target.top - box.top - (body.clientHeight - target.height) / 2
  body.scrollTo({ top: Math.max(0, top), behavior: reduceMotion() ? 'auto' : 'smooth' })
  highlight(commentId)
}

async function highlight(commentId: string) {
  if (highlightTimer) clearTimeout(highlightTimer)
  // Cleared first so that a second jump to the same comment starts the flash again.
  highlightId.value = null
  await nextTick()
  highlightId.value = commentId
  highlightTimer = setTimeout(() => {
    highlightId.value = null
    highlightTimer = null
  }, 2000)
}

function jumpTo(commentId: string) {
  focusComment(commentId)
}

function commentUrl(comment: TaskComment) {
  const projectId = String(route.params.id ?? '')
  return `${window.location.origin}${commentLink(projectId, props.taskId, comment.id)}`
}

// navigator.clipboard only exists on a secure origin, so a dev page on plain
// http falls back to selecting a hidden field and copying from it.
function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text)
  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.opacity = '0'
  document.body.appendChild(field)
  field.select()
  const copied = document.execCommand('copy')
  field.remove()
  return copied ? Promise.resolve() : Promise.reject(new Error('copy refused'))
}

async function copyLink(comment: TaskComment) {
  const url = commentUrl(comment)
  try {
    await copyText(url)
    toast.add({ title: 'Link copied', icon: 'i-lucide-link', duration: 2000 })
  } catch {
    toast.add({ title: 'Could not copy the link', description: url, icon: 'i-lucide-alert-triangle', color: 'error' })
  }
}

// A link opens the page on this comment: a cold load, or the query changing while
// the drawer is already open. Each task and comment pair is jumped to once, so a
// realtime refresh does not drag the reader back to it.
const linkedId = computed(() => typeof route.query.comment === 'string' ? route.query.comment : '')
let handled = ''

watch(
  [linkedId, () => props.taskId, count],
  ([commentId, taskId]) => {
    const key = `${taskId}:${commentId}`
    if (!commentId || key === handled) return
    if (!ownComments.value.some(c => c.id === commentId)) return
    handled = key
    focusComment(commentId)
  },
  { immediate: true }
)

// New comments land at the bottom. The reader is moved there only when they were
// already at the bottom: a reader up at an older comment keeps their place.
let wasAtEnd = false
let lastCount = count.value

onBeforeUpdate(() => {
  const body = scroller()
  // Nothing counts as at the end on the first load (no comments yet) or when the
  // thread is shorter than the body, where every scroll position is the end.
  wasAtEnd = !!body && lastCount > 0 && body.scrollHeight > body.clientHeight && body.scrollHeight - body.scrollTop - body.clientHeight < 80
})

onUpdated(() => {
  if (count.value > lastCount && wasAtEnd) scrollToEnd()
  lastCount = count.value
})

// ─── Editing, visibility and removing ──────────────────────

// Your own comments only, and that includes what an agent posted with your key —
// the server holds the same line.
function canChange(comment: TaskComment) {
  return !!session.value?.user && comment.userId === session.value.user.id
}

const editingId = ref<string | null>(null)
const editDraft = ref('')

// A `ref` inside v-for collects into an array; only one edit box is ever open,
// so it is kept by hand.
let editComposer: { $el?: HTMLElement } | null = null

function setEditComposer(el: unknown) {
  editComposer = el as { $el?: HTMLElement } | null
}

async function startEdit(comment: TaskComment) {
  editingId.value = comment.id
  editDraft.value = comment.body
  await nextTick()
  // The options menu that started the edit is still closing and holds the drawer's
  // focus trap. Focus the box once it has let go, or the trap keeps the box's focus
  // from being recorded and steals it back on the next change in the drawer.
  await new Promise(resolve => setTimeout(resolve, 50))
  editComposer?.$el?.querySelector('textarea')?.focus()
}

function cancelEdit() {
  editingId.value = null
  editDraft.value = ''
}

async function saveEdit() {
  const id = editingId.value
  // Only spaces, tabs and line ends go: a no-break space in a stored body stays.
  const body = editDraft.value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')
  if (!id) return
  // Emptying an update is not how it gets removed; that asks first.
  if (!body) return
  cancelEdit()
  try {
    await editComment(props.taskId, id, body)
  } catch {
    toast.add({ title: 'Could not save the update', icon: 'i-lucide-alert-triangle', color: 'error' })
  }
}

async function toggleCommentVisibility(comment: TaskComment) {
  try {
    await setCommentVisibility(props.taskId, comment.id, comment.visibility === 'internal' ? 'customer' : 'internal')
  } catch {
    toast.add({ title: 'Could not change who sees this update', icon: 'i-lucide-alert-triangle', color: 'error' })
  }
}

const deletingComment = ref<TaskComment | null>(null)

async function confirmDeleteComment() {
  const comment = deletingComment.value
  deletingComment.value = null
  if (!comment) return
  if (editingId.value === comment.id) cancelEdit()
  try {
    await deleteComment(props.taskId, comment.id)
  } catch {
    toast.add({ title: 'Could not remove the update', icon: 'i-lucide-alert-triangle', color: 'error' })
  }
}

function commentMenu(comment: TaskComment) {
  const share = props.readonly
    ? []
    : [{
        label: comment.visibility === 'internal' ? 'Share with customer' : 'Make team only',
        icon: comment.visibility === 'internal' ? 'i-lucide-eye' : 'i-lucide-lock',
        onSelect: () => toggleCommentVisibility(comment)
      }]
  return [[
    { label: 'Edit', icon: 'i-lucide-pencil', onSelect: () => startEdit(comment) },
    ...share
  ], [
    {
      label: 'Delete',
      icon: 'i-lucide-trash-2',
      color: 'error' as const,
      onSelect: () => { deletingComment.value = comment }
    }
  ]]
}

// Escape ends an edit or a reply and reports that it did. The drawer only closes
// on Escape when this returns false.
function handleEscape(): boolean {
  if (editingId.value) {
    cancelEdit()
    return true
  }
  if (replyTo.value) {
    cancelReply()
    return true
  }
  return false
}

function onComposerEscape(event: KeyboardEvent) {
  // Escape during an IME composition only ends the composition.
  if (event.isComposing || event.keyCode === 229) return
  if (handleEscape()) event.stopPropagation()
}

// Enter saves an edit, except while an IME is still composing a word.
function onEditEnter(event: KeyboardEvent) {
  if (event.isComposing) return
  event.preventDefault()
  saveEdit()
}

defineExpose({ handleEscape })
</script>

<template>
  <section
    ref="root"
    class="shrink-0 border-t border-default px-5 pb-4 pt-3"
    aria-labelledby="task-comments-heading"
  >
    <div class="mb-3 flex items-baseline gap-2">
      <h3
        id="task-comments-heading"
        class="text-xs font-medium text-muted"
      >
        Comments
      </h3>
      <span
        v-if="count"
        class="text-xs tabular-nums text-dimmed"
      >{{ count }}</span>
    </div>

    <div class="space-y-4">
      <p
        v-if="count === 0"
        class="text-xs text-dimmed"
      >
        No comments yet. Note where this stands: on staging, waiting on feedback, needs more work.
      </p>

      <template
        v-for="entry in stream"
        :key="entry.key"
      >
        <template v-if="entry.comment">
          <article
            v-for="comment in [entry.comment]"
            :key="comment.id"
            :data-comment-id="comment.id"
            class="group/update -mx-2 flex w-[calc(100%+1rem)] gap-2.5 rounded-md px-2 py-1.5 transition-colors"
            :class="{ 'comment-highlight': highlightId === comment.id }"
          >
            <UAvatar
              v-if="isAgentUpdate(comment) || isGithubUpdate(comment)"
              :icon="isGithubUpdate(comment) ? 'i-lucide-github' : 'i-lucide-bot'"
              size="2xs"
              class="mt-0.5 shrink-0"
            />
            <UAvatar
              v-else
              :alt="initials(comment.userName)"
              size="2xs"
              class="mt-0.5 shrink-0"
            />
            <div class="w-full min-w-0 flex-1">
              <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span class="truncate text-xs font-medium text-default">
                  {{ updateAuthor(comment) }}
                </span>
                <span
                  v-if="isAgentUpdate(comment) || isGithubUpdate(comment)"
                  class="shrink-0 rounded px-1 py-px text-[0.625rem] font-semibold uppercase tracking-wide text-muted ring-1 ring-inset ring-accented"
                >
                  {{ updateSourceLabel(comment) }}
                </span>
                <span
                  class="shrink-0 text-xs text-dimmed"
                  :title="fullDate(comment.createdAt)"
                >
                  {{ relativeTime(comment.createdAt) }}
                </span>
                <span
                  v-if="comment.editedAt"
                  class="shrink-0 text-xs text-dimmed"
                  :title="`Edited ${fullDate(comment.editedAt)}`"
                >
                  (edited)
                </span>
                <!-- Contacts are never sent internal comments, so only staff see this. -->
                <span
                  v-if="!readonly && comment.visibility === 'internal'"
                  class="flex shrink-0 items-center gap-0.5 text-[0.6875rem] text-warning"
                  title="Team only: the customer does not see this comment"
                >
                  <UIcon
                    name="i-lucide-lock"
                    class="size-3"
                  />
                  Team only
                </span>

                <UDropdownMenu
                  v-if="canChange(comment) && editingId !== comment.id"
                  :items="commentMenu(comment)"
                  :content="{ align: 'end', collisionPadding: 12 }"
                >
                  <UButton
                    icon="i-lucide-ellipsis"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    :aria-label="`Options for the comment by ${updateAuthor(comment)}`"
                    class="-my-1 ml-auto"
                  />
                </UDropdownMenu>
              </div>

              <!-- The comment it answers. Clicking it jumps to that comment; a deleted
                 one is named, not linked. -->
              <template v-if="comment.replyTo">
                <button
                  v-if="!comment.replyTo.deleted && comment.replyTo.id"
                  type="button"
                  class="mt-0.5 flex max-w-full items-center gap-1 rounded text-left text-xs text-muted hover:text-default focus-visible:ring-2 focus-visible:ring-primary"
                  :aria-label="`${replyLineText(comment.replyTo)}. Show that comment.`"
                  @click="jumpTo(comment.replyTo.id)"
                >
                  <UIcon
                    name="i-lucide-corner-up-left"
                    class="size-3 shrink-0"
                  />
                  <span class="truncate">{{ replyLineText(comment.replyTo) }}</span>
                </button>
                <p
                  v-else
                  class="mt-0.5 flex items-center gap-1 text-xs text-dimmed"
                >
                  <UIcon
                    name="i-lucide-corner-up-left"
                    class="size-3 shrink-0"
                  />
                  {{ replyLineText(comment.replyTo) }}
                </p>
              </template>

              <div
                v-if="editingId === comment.id"
                class="mt-1 rounded-md border border-default bg-elevated/40 px-2.5 py-2"
              >
                <UTextarea
                  :ref="setEditComposer"
                  v-model="editDraft"
                  aria-label="Edit the comment"
                  placeholder="Edit the comment…"
                  autoresize
                  :rows="2"
                  class="w-full"
                  @keydown.enter.exact="onEditEnter"
                  @keydown.esc="onComposerEscape"
                />
                <div class="mt-2 flex flex-wrap items-center justify-end gap-1">
                  <span class="mr-auto text-[0.6875rem] text-dimmed">Enter to save · Esc to cancel</span>
                  <UButton
                    label="Cancel"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    @click="cancelEdit"
                  />
                  <UButton
                    label="Save"
                    size="xs"
                    :disabled="!editDraft.trim()"
                    @click="saveEdit"
                  />
                </div>
              </div>
              <InlineMarkdown
                v-else
                :text="comment.body"
                class="text-sm leading-relaxed text-default"
              />

              <div
                v-if="editingId !== comment.id"
                class="-ml-2 mt-0.5 flex flex-wrap items-center gap-0.5"
              >
                <UButton
                  v-if="canReply(comment)"
                  icon="i-lucide-reply"
                  label="Reply"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :aria-label="`Reply to ${updateAuthor(comment)}`"
                  @click="startReply(comment)"
                />
                <UButton
                  icon="i-lucide-link"
                  label="Copy link"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :aria-label="`Copy link to the comment by ${updateAuthor(comment)}`"
                  @click="copyLink(comment)"
                />
              </div>
            </div>
          </article>
        </template>

        <div
          v-else
          class="flex items-center gap-2.5 text-xs text-muted"
          :data-activity="entry.activity.kind"
        >
          <span class="flex size-5 shrink-0 items-center justify-center rounded-full bg-elevated">
            <UIcon
              :name="activityIcon(entry.activity.kind)"
              class="size-3"
            />
          </span>
          <span class="min-w-0 flex-1">
            <span class="font-medium text-default">{{ activityActor(entry.activity) }}</span>
            {{ activityText(entry.activity) }}
          </span>
          <span
            class="shrink-0 text-dimmed"
            :title="fullDate(entry.at)"
          >{{ relativeTime(entry.at) }}</span>
        </div>
      </template>
    </div>

    <!-- The box is part of the thread, under it, and never only inside a panel. -->
    <div
      class="mt-4 border-t border-default pt-3"
      @keydown.esc="onComposerEscape"
    >
      <div
        v-if="replyTo"
        class="mb-2 flex items-center gap-2 rounded-md bg-elevated px-2 py-1 text-xs text-default"
      >
        <UIcon
          name="i-lucide-corner-up-left"
          class="size-3.5 shrink-0 text-muted"
        />
        <span class="min-w-0 flex-1 truncate">
          Replying to <span class="font-medium">{{ updateAuthor(replyTo) }}</span>
        </span>
        <UButton
          icon="i-lucide-x"
          size="xs"
          color="neutral"
          variant="ghost"
          aria-label="Cancel reply"
          @click="cancelReply"
        />
      </div>

      <div
        class="flex cursor-text items-start gap-2"
        @click="composer?.focus()"
      >
        <UAvatar
          :alt="userInitials"
          size="2xs"
          class="mt-0.5 shrink-0"
        />
        <UpdateComposer
          ref="composer"
          v-model="draft"
          :placeholder="readonly || commentVisibility === 'customer' ? 'Write to the team and the customer…' : 'Add an internal comment…'"
          @submit="send"
        />
        <UButton
          v-if="!readonly"
          :icon="commentVisibility === 'internal' ? 'i-lucide-lock' : 'i-lucide-eye'"
          size="xs"
          :color="commentVisibility === 'internal' ? 'warning' : 'neutral'"
          variant="ghost"
          class="shrink-0"
          :aria-label="commentVisibility === 'internal' ? 'Team only. Click to share with the customer.' : 'Shared with the customer. Click to make it team only.'"
          :title="commentVisibility === 'internal' ? 'Team only. Click to share with the customer.' : 'Shared with the customer. Click to make it team only.'"
          @click.stop="commentVisibility = commentVisibility === 'internal' ? 'customer' : 'internal'"
        />
        <UButton
          icon="i-lucide-arrow-up"
          size="xs"
          color="primary"
          class="shrink-0"
          :disabled="!draft.trim()"
          aria-label="Add comment"
          @click="send"
        />
      </div>
    </div>

    <UModal
      :open="deletingComment !== null"
      title="Delete this comment?"
      description="It is removed from the task for good. This cannot be undone."
      :ui="{ footer: 'justify-end' }"
      @update:open="(v: boolean) => { if (!v) deletingComment = null }"
    >
      <template #footer>
        <UButton
          label="Cancel"
          color="neutral"
          variant="ghost"
          @click="deletingComment = null"
        />
        <UButton
          label="Delete comment"
          color="error"
          @click="confirmDeleteComment"
        />
      </template>
    </UModal>
  </section>
</template>

<style scoped>
/* Two seconds of flash for the comment a link points at. Reduced motion keeps
   the tint, which stays on screen for the same two seconds, and drops the fade. */
.comment-highlight {
  animation: comment-flash 2s ease-out;
}

@keyframes comment-flash {
  from {
    background-color: color-mix(in srgb, var(--ui-primary) 22%, transparent);
  }
  to {
    background-color: transparent;
  }
}

@media (prefers-reduced-motion: reduce) {
  .comment-highlight {
    animation: none;
    background-color: color-mix(in srgb, var(--ui-primary) 14%, transparent);
  }
}
</style>
