<script setup lang="ts">
import { isOverdueDay } from '~/utils/dueDate'
import { relativeTime } from '~/composables/useRelativeTime'

const props = defineProps<{ projectId: string }>()

const { activeProject, updateProjectDetails, board, isTrashed } = useProjects()

const draft = ref('')
const saved = ref(false)

// The project can arrive from the store's cache first and again fresher from the
// server, so the draft follows its description until the user starts typing.
const dirty = ref(false)

watch(() => [activeProject.value?.id, activeProject.value?.description] as const, () => {
  if (!dirty.value) draft.value = activeProject.value?.description ?? ''
}, { immediate: true })

function clearSaved() {
  saved.value = false
}

async function saveDescription() {
  if (draft.value === (activeProject.value?.description ?? '')) {
    dirty.value = false
    return
  }
  await updateProjectDetails(props.projectId, { description: draft.value })
  dirty.value = false
  saved.value = true
  setTimeout(clearSaved, 1500)
}

const STATUSES = [
  { key: 'on_track', label: 'On track', dot: 'bg-success' },
  { key: 'at_risk', label: 'At risk', dot: 'bg-warning' },
  { key: 'off_track', label: 'Off track', dot: 'bg-error' }
] as const

function setStatus(key: (typeof STATUSES)[number]['key']) {
  const next = activeProject.value?.status === key ? null : key
  return updateProjectDetails(props.projectId, { status: next })
}

interface StatusUpdate {
  id: string
  status: 'on_track' | 'at_risk' | 'off_track'
  body: string
  createdAt: number
  author: { id: string, name: string, image: string | null }
}

const { syncProjects } = useProjects()
const { session } = useAuth()
const me = computed(() => session.value?.user)

const updates = useProjectCollection<StatusUpdate>(() => props.projectId, 'status-updates')
const updateDraft = ref('')
const posting = ref(false)
const postError = ref('')

const statusMeta = (key: string) => STATUSES.find(status => status.key === key)

async function postUpdate() {
  const status = activeProject.value?.status
  if (!status || !updateDraft.value.trim() || posting.value) return
  posting.value = true
  postError.value = ''
  try {
    await updates.add({ status, body: updateDraft.value })
    updateDraft.value = ''
    await syncProjects()
  } catch (e) {
    postError.value = updates.messageOf(e, 'Could not post the update')
  } finally {
    posting.value = false
  }
}

const counts = computed(() => {
  const tasks = (board.value?.tasks ?? []).filter(task => !isTrashed(task))
  return {
    total: tasks.length,
    done: tasks.filter(task => task.completedAt).length,
    overdue: tasks.filter(task => task.dueOn && !task.completedAt && isOverdueDay(task.dueOn)).length
  }
})
</script>

<template>
  <div class="h-full overflow-y-auto px-4 pb-10 pt-6 lg:px-6">
    <div class="mx-auto grid max-w-5xl gap-8 lg:grid-cols-[1fr_18rem]">
      <div>
        <h2 class="text-lg font-semibold text-default">
          Project description
        </h2>
        <textarea
          v-model="draft"
          rows="8"
          placeholder="What is this project about? Add goals, links and context for everyone working on it."
          class="mt-3 w-full resize-y rounded-xl border border-default bg-default p-3 text-sm leading-relaxed text-default outline-none transition-shadow placeholder:text-dimmed focus:border-primary focus:ring-2 focus:ring-primary/20"
          data-overview-description
          @input="dirty = true"
          @blur="saveDescription"
        />
        <p
          class="mt-1 h-4 text-xs text-success transition-opacity"
          :class="saved ? 'opacity-100' : 'opacity-0'"
        >
          Saved
        </p>

        <h2 class="mt-6 text-lg font-semibold text-default">
          Status updates
        </h2>
        <div class="mt-3 rounded-xl border border-default bg-default p-3">
          <textarea
            v-model="updateDraft"
            rows="3"
            placeholder="How is the project going? Say what changed since the last update."
            class="w-full resize-y bg-transparent text-sm leading-relaxed text-default outline-none placeholder:text-dimmed"
            data-update-input
          />
          <div class="mt-2 flex items-center justify-between gap-3">
            <p class="min-h-4 text-xs text-muted">
              <template v-if="!activeProject?.status">
                Choose a status first.
              </template>
              <template v-else-if="!updateDraft.trim()">
                Write what changed, then Post update.
              </template>
              <template v-else>
                Posts as
                <span class="font-medium text-default">{{ statusMeta(activeProject.status)?.label }}</span>
              </template>
            </p>
            <UButton
              label="Post update"
              size="sm"
              :disabled="!activeProject?.status || !updateDraft.trim()"
              :loading="posting"
              data-update-post
              @click="postUpdate"
            />
          </div>
          <p
            v-if="postError"
            class="mt-2 text-xs text-error"
          >
            {{ postError }}
          </p>
        </div>

        <ul
          class="mt-4 space-y-3"
          data-update-feed
        >
          <li
            v-for="update in updates.items.value"
            :key="update.id"
            class="rounded-xl border border-default bg-default p-3"
            data-status-update
          >
            <div class="flex items-center gap-2">
              <UAvatar
                :src="update.author.image ?? undefined"
                :alt="update.author.name"
                size="2xs"
              />
              <span class="text-sm font-medium text-default">{{ update.author.name }}</span>
              <span
                class="flex items-center gap-1.5 rounded-full bg-elevated px-2 py-0.5 text-xs text-default"
                :data-update-status="update.status"
              >
                <span
                  class="size-2 rounded-full"
                  :class="statusMeta(update.status)?.dot"
                />
                {{ statusMeta(update.status)?.label }}
              </span>
              <span class="ml-auto text-xs text-dimmed">{{ relativeTime(update.createdAt) }}</span>
              <button
                v-if="update.author.id === me?.id"
                class="text-dimmed transition-colors hover:text-error"
                aria-label="Delete update"
                title="Delete update"
                data-update-delete
                @click="updates.remove(update.id)"
              >
                <UIcon
                  name="i-lucide-trash-2"
                  class="size-3.5"
                />
              </button>
            </div>
            <p
              v-if="update.body"
              class="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-default"
            >
              {{ update.body }}
            </p>
          </li>
          <li
            v-if="!updates.items.value.length && !updates.loading.value"
            class="text-sm text-muted"
          >
            No updates yet. The first one starts the project's history.
          </li>
        </ul>
      </div>

      <aside class="space-y-6">
        <section>
          <h3 class="text-sm font-semibold text-default">
            What's the status?
          </h3>
          <div class="mt-3 flex flex-wrap gap-2">
            <button
              v-for="status in STATUSES"
              :key="status.key"
              class="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors"
              :class="activeProject?.status === status.key
                ? 'border-primary bg-primary/10 font-medium text-default'
                : 'border-default text-muted hover:bg-elevated'"
              :data-status="status.key"
              @click="setStatus(status.key)"
            >
              <span
                class="size-2 rounded-full"
                :class="status.dot"
              />
              {{ status.label }}
            </button>
          </div>
        </section>

        <section>
          <h3 class="text-sm font-semibold text-default">
            At a glance
          </h3>
          <dl class="mt-3 divide-y divide-default rounded-xl border border-default bg-default text-sm">
            <div class="flex justify-between px-3 py-2">
              <dt class="text-muted">
                Tasks
              </dt>
              <dd class="tabular-nums text-default">
                {{ counts.total }}
              </dd>
            </div>
            <div class="flex justify-between px-3 py-2">
              <dt class="text-muted">
                Completed
              </dt>
              <dd class="tabular-nums text-default">
                {{ counts.done }}
              </dd>
            </div>
            <div class="flex justify-between px-3 py-2">
              <dt class="text-muted">
                Overdue
              </dt>
              <dd
                class="tabular-nums"
                :class="counts.overdue ? 'text-error' : 'text-default'"
              >
                {{ counts.overdue }}
              </dd>
            </div>
          </dl>
        </section>
      </aside>
    </div>
  </div>
</template>
