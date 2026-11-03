<script setup lang="ts">
import { realtimeHeaders } from '~/composables/useRealtime'
import { errorMessage, untypedFetch } from '~/utils/untypedFetch'
import { blockedSummaryWithHidden, blockerCandidates, blockerSearchNote, blockerStateWords, candidateCountWords, emptySearchWords } from '~/utils/taskBlockers'
import type { BlockerView } from '~/utils/taskBlockers'
import type { ProjectTask } from '~/composables/useProjects'

// The "Blocked by" section of a task: the tasks on this board it waits for. Staff add and
// remove; a customer reads the state and only the titles that are customer-visible.
const props = defineProps<{ taskId: string, readonly: boolean }>()

const route = useRoute()
const { board } = useProjects()
const request = untypedFetch
const url = () => `/api/tasks/${props.taskId}/blockers`

const root = ref<HTMLElement | null>(null)
const blockers = ref<BlockerView[]>([])
const blocked = ref(false)
const loading = ref(false)
const loadError = ref('')
const query = ref('')
const adding = ref(false)
const addError = ref('')
const removeError = ref('')
const removingId = ref<string | null>(null)

// Only the latest load counts, so a slow answer for the last task never lands on this one.
let latest = 0
async function load() {
  const mine = ++latest
  loading.value = true
  loadError.value = ''
  try {
    const body = await request<{ blocked: boolean, blockers: BlockerView[] }>(url())
    if (mine !== latest) return
    blocked.value = body.blocked
    blockers.value = body.blockers
  } catch (e) {
    if (mine === latest) loadError.value = errorMessage(e, 'Could not load the blocked-by list')
  } finally {
    if (mine === latest) loading.value = false
  }
}

watch(() => props.taskId, () => {
  query.value = ''
  addError.value = ''
  removeError.value = ''
  load()
}, { immediate: true })

// The board payload carries each card's blocked mark. When it changes (a blocker added or finished
// elsewhere), the list is read again rather than left stale.
const boardMark = computed(() => {
  const task = board.value?.tasks.find(t => t.id === props.taskId) as (ProjectTask & { blocked?: boolean, blockedBy?: string[] }) | undefined
  return task ? `${task.blocked}|${(task.blockedBy ?? []).join(',')}` : ''
})
watch(boardMark, (next, prev) => {
  if (prev && next !== prev) load()
})

const openCount = computed(() => blockers.value.filter(b => b.finished === false).length)
// A viewer who cannot see every blocker (a customer) gets a floor, not an exact count.
const hiddenCount = computed(() => blockers.value.filter(b => !b.visible).length)
const summary = computed(() => blockedSummaryWithHidden(blocked.value, openCount.value, hiddenCount.value))

const columnName = computed(() => new Map((board.value?.columns ?? []).map(column => [column.id, column.name])))
const candidates = computed(() => {
  if (props.readonly) return []
  return blockerCandidates(board.value?.tasks ?? [], query.value, {
    selfId: props.taskId,
    waitingFor: blockers.value.flatMap(b => (b.id ? [b.id] : []))
  })
})

const emptyNote = computed(() => emptySearchWords(blockerSearchNote(board.value?.tasks ?? [], query.value, {
  selfId: props.taskId,
  waitingFor: blockers.value.flatMap(b => (b.id ? [b.id] : []))
})))
const candidateCount = computed(() => candidateCountWords(candidates.value.length, query.value))

function boardColumnName(columnId: string): string {
  return columnName.value.get(columnId) ?? ''
}

async function addBlocker(blockerId: string) {
  if (adding.value) return
  adding.value = true
  addError.value = ''
  try {
    await request(url(), { method: 'POST', headers: realtimeHeaders(), body: { blockerId } })
    query.value = ''
    await load()
  } catch (e) {
    // The server's refusal says why in plain words (a loop, another board, a duplicate).
    addError.value = errorMessage(e, 'Could not add that link')
  } finally {
    adding.value = false
    // The search box is disabled while adding: focus it once it is enabled again.
    if (!addError.value) nextTick(focusSearch)
  }
}
async function removeBlocker(blockerId: string) {
  if (removingId.value) return
  removingId.value = blockerId
  removeError.value = ''
  try {
    await request(`${url()}/${blockerId}`, { method: 'DELETE', headers: realtimeHeaders() })
    await load()
  } catch (e) {
    removeError.value = errorMessage(e, 'Could not remove that link')
  } finally {
    removingId.value = null
    nextTick(focusAfterRemoval)
  }
}

// After a remove the button is gone: focus goes to the list, or to the search box when the list is empty.
function focusAfterRemoval() {
  const target = root.value?.querySelector<HTMLElement>('[data-blocker-list]') ?? root.value?.querySelector<HTMLElement>('#task-blocker-search')
  target?.focus()
}

// The search box keeps focus after an add, so the next title can be typed at once.
function focusSearch() {
  root.value?.querySelector<HTMLInputElement>('input[data-blocker-search], [data-blocker-search] input')?.focus()
}

// The drawer opens from ?task=, so a blocker opens the same way the board does.
function openBlocker(taskId: string) {
  navigateTo({ query: { ...route.query, task: taskId } })
}
</script>

<template>
  <section
    ref="root"
    class="shrink-0 border-t border-default px-5 py-2.5"
    data-task-blockers
  >
    <p class="mb-1 text-xs font-medium text-muted">
      Blocked by
      <span
        v-if="blockers.length"
        class="tabular-nums text-dimmed"
      >{{ openCount }} open</span>
    </p>

    <p
      v-if="loadError"
      role="alert"
      class="text-xs text-error"
    >
      {{ loadError }}
    </p>
    <p
      v-else
      class="text-xs"
      :class="blocked ? 'text-warning' : 'text-dimmed'"
      data-blocked-summary
      aria-live="polite"
    >
      {{ loading && !blockers.length ? 'Loading…' : summary }}
    </p>

    <ul
      v-if="blockers.length"
      class="mt-1.5 space-y-1"
      data-blocker-list
      tabindex="-1"
    >
      <li
        v-for="blocker in blockers"
        :key="blocker.id ?? blocker.title"
        class="flex min-w-0 items-center gap-2 text-xs"
        data-blocker
      >
        <UIcon
          v-if="blocker.finished !== null"
          :name="blocker.finished ? 'i-lucide-check-circle' : 'i-lucide-circle-dashed'"
          class="size-4 shrink-0"
          :class="blocker.finished ? 'text-success' : 'text-warning'"
          aria-hidden="true"
        />
        <UIcon
          v-else
          name="i-lucide-eye-off"
          class="size-4 shrink-0 text-dimmed"
          aria-hidden="true"
        />
        <button
          v-if="blocker.id"
          type="button"
          class="min-w-0 flex-1 truncate text-left text-default hover:underline focus-visible:underline"
          @click="openBlocker(blocker.id)"
        >
          {{ blocker.title }}
        </button>
        <span
          v-else
          class="min-w-0 flex-1 truncate italic text-dimmed"
        >{{ blocker.title }}</span>
        <span
          v-if="blocker.column"
          class="shrink-0 text-dimmed"
        >{{ blocker.column }}</span>
        <span class="sr-only">{{ blockerStateWords(blocker) }}</span>
        <UButton
          v-if="!readonly && blocker.id"
          icon="i-lucide-x"
          size="xs"
          color="neutral"
          variant="ghost"
          :loading="removingId === blocker.id"
          :aria-label="`Stop waiting for ${blocker.title}`"
          data-blocker-remove
          @click="removeBlocker(blocker.id)"
        />
      </li>
    </ul>

    <p
      v-if="removeError"
      role="alert"
      class="mt-1 text-xs text-error"
    >
      {{ removeError }}
    </p>

    <div
      v-if="!readonly"
      class="mt-2 space-y-1.5"
    >
      <label
        class="block text-xs text-muted"
        for="task-blocker-search"
      >Add a task this one waits for</label>
      <p
        class="sr-only"
        aria-live="polite"
        data-candidate-count
      >
        {{ candidateCount }}
      </p>
      <UInput
        id="task-blocker-search"
        v-model="query"
        size="sm"
        class="w-full"
        placeholder="Type part of a title on this board"
        :disabled="adding"
        data-blocker-search
      />
      <p
        v-if="query.trim() && !candidates.length"
        class="text-xs text-dimmed"
      >
        {{ emptyNote }}
      </p>
      <ul
        v-if="candidates.length"
        class="space-y-0.5"
      >
        <li
          v-for="task in candidates"
          :key="task.id"
        >
          <button
            type="button"
            class="flex w-full min-w-0 items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-elevated focus-visible:bg-elevated"
            :disabled="adding"
            data-blocker-candidate
            @click="addBlocker(task.id)"
          >
            <span class="min-w-0 flex-1 truncate">{{ task.title }}</span>
            <span class="shrink-0 text-dimmed">{{ boardColumnName(task.columnId) }}</span>
          </button>
        </li>
      </ul>
      <p
        v-if="addError"
        role="alert"
        class="text-xs text-error"
      >
        {{ addError }}
      </p>
    </div>
  </section>
</template>
