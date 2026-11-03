<script setup lang="ts">
import { format } from 'date-fns'
import { relativeTime } from '~/composables/useRelativeTime'
import { dueDayToMs } from '~/utils/dueDate'
import { agentAuditLink } from '~/composables/useAgentAudit'
import type { AgentAuditItem } from '~/composables/useAgentAudit'

definePageMeta({ layout: 'app' })

const { sidebarOpen } = useSidebar()
useSeoMeta({ title: 'Inbox' })

const { items, unread, prefs, push, loaded, load, markRead, markAllRead, setPreference, setPush, testPush } = useNotifications()
onMounted(load)

// The Agent audit tab exists only for someone with an agent; ?tab=agent keeps it across a reload.
const audit = useAgentAudit()
const { items: auditItems, unread: auditUnread, hasAgents, loaded: auditLoaded, load: loadAudit, markRead: markAuditRead, markAllRead: markAllAuditRead } = audit
onMounted(loadAudit)
const route = useRoute()
const router = useRouter()
const onAgentTab = computed(() => hasAgents.value && route.query.tab === 'agent')

const filter = ref<'all' | 'unread'>('all')
const shown = computed(() => filter.value === 'unread' ? items.value.filter(item => !item.readAt) : items.value)

// Grouped by the day they arrived, newest day first.
function groupByDay<T extends { createdAt: number }>(list: T[]) {
  const groups = new Map<string, T[]>()
  for (const item of list) {
    const day = format(item.createdAt, 'yyyy-MM-dd')
    groups.set(day, [...(groups.get(day) ?? []), item])
  }
  return [...groups]
}

const byDay = computed(() => groupByDay(shown.value))
const agentShown = computed(() => filter.value === 'unread' ? auditItems.value.filter(item => !item.readAt) : auditItems.value)
const agentByDay = computed(() => groupByDay(agentShown.value))

function dayLabel(day: string) {
  const today = format(Date.now(), 'yyyy-MM-dd')
  const yesterday = format(Date.now() - 86_400_000, 'yyyy-MM-dd')
  if (day === today) return 'Today'
  if (day === yesterday) return 'Yesterday'
  return format(dueDayToMs(day), 'EEEE, MMM d')
}

// ─── The open item ─────────────────────────────────────────
// An item opens over the inbox, the way it opens on its board: a task in the task panel, a
// message in its conversation with the reply box ready. A board in another workspace switches
// there first, as a pinned board does.

const { board, loadBoard } = useProjects()
const { switchToBoard } = useWorkspace()
const toast = useToast()

const openTaskId = ref<string | null>(null)
const drawerTask = computed(() => (openTaskId.value ? board.value?.tasks.find(t => t.id === openTaskId.value) ?? null : null))
// threadId null shows the board's whole conversation list: older notifications did not keep the message.
const openThread = ref<{ projectId: string, projectName: string, threadId: string | null } | null>(null)
const opening = ref<string | null>(null)

function isOpen(item: NotificationItem) {
  return opening.value === item.id
    || (Boolean(item.taskId) && openTaskId.value === item.taskId)
    || (Boolean(item.messageId) && openThread.value?.threadId === item.messageId)
}

async function open(item: NotificationItem) {
  if (!item.readAt) markRead([item.id])
  if (opening.value) return
  opening.value = item.id
  try {
    if (!(await switchToBoard(item.projectId))) {
      toast.add({ title: 'This board is not available to you any more', color: 'warning' })
      return
    }
    if (item.taskId) {
      await loadBoard(item.projectId)
      if (!board.value?.tasks.some(t => t.id === item.taskId)) {
        toast.add({ title: 'That task is no longer on the board', color: 'warning' })
        return
      }
      openTaskId.value = item.taskId
    } else if (item.type === 'message' || item.type === 'reply') {
      openThread.value = { projectId: item.projectId, projectName: item.projectName, threadId: item.messageId ?? null }
    } else {
      await navigateTo(notificationLink(item))
    }
  } catch {
    toast.add({ title: 'Could not open it', color: 'error' })
  } finally {
    opening.value = null
  }
}

function selectTab(tab: 'inbox' | 'agent') {
  const query = { ...route.query }
  if (tab === 'agent') query.tab = 'agent'
  else delete query.tab
  router.replace({ query })
}

async function openAgent(item: AgentAuditItem) {
  if (!item.readAt) markAuditRead([item.id])
  const link = agentAuditLink(item)
  if (link) await navigateTo(link)
}

const settingsOpen = ref(false)
const settingsError = ref('')

async function toggle(key: 'email' | 'browser') {
  settingsError.value = (await setPreference(key, !prefs.value[key])) ?? ''
}

async function togglePush() {
  settingsError.value = (await setPush(!push.value.subscribed)) ?? ''
}

const pushNote = ref('')
async function sendTest() {
  pushNote.value = (await testPush()) ?? 'Sent. It should arrive in a moment.'
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
        Inbox
      </h1>
      <span
        v-if="!onAgentTab && unread"
        class="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium tabular-nums text-primary"
        data-inbox-unread
      >{{ unread }} unread</span>
      <div class="ml-auto flex items-center gap-1">
        <UButton
          v-if="!onAgentTab && unread"
          label="Mark all read"
          icon="i-lucide-check-check"
          size="xs"
          color="neutral"
          variant="ghost"
          data-inbox-mark-all
          @click="markAllRead"
        />
        <UButton
          v-if="onAgentTab && auditUnread"
          label="Mark all read"
          icon="i-lucide-check-check"
          size="xs"
          color="neutral"
          variant="ghost"
          data-agent-mark-all
          @click="markAllAuditRead"
        />
        <UButton
          v-if="!onAgentTab"
          icon="i-lucide-settings-2"
          size="xs"
          color="neutral"
          variant="ghost"
          aria-label="Notification settings"
          data-inbox-settings
          @click="settingsOpen = !settingsOpen"
        />
      </div>
    </header>

    <nav
      v-if="hasAgents"
      class="flex shrink-0 gap-5 border-b border-default px-4 lg:px-6"
      role="tablist"
    >
      <button
        type="button"
        role="tab"
        class="-mb-px border-b-2 py-2 text-sm transition-colors"
        :class="onAgentTab ? 'border-transparent text-muted hover:text-default' : 'border-primary font-medium text-default'"
        :aria-selected="!onAgentTab"
        data-inbox-tab
        @click="selectTab('inbox')"
      >
        Inbox
      </button>
      <button
        type="button"
        role="tab"
        class="-mb-px flex items-center gap-1.5 border-b-2 py-2 text-sm transition-colors"
        :class="onAgentTab ? 'border-primary font-medium text-default' : 'border-transparent text-muted hover:text-default'"
        :aria-selected="onAgentTab"
        data-agent-tab
        @click="selectTab('agent')"
      >
        Agent audit
        <span
          v-if="auditUnread"
          class="rounded-full bg-primary/10 px-1.5 text-xs font-medium tabular-nums text-primary"
          data-agent-unread
        >{{ auditUnread }}</span>
      </button>
    </nav>

    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4 lg:px-6">
      <div class="mx-auto max-w-3xl">
        <section
          v-if="settingsOpen && !onAgentTab"
          class="mb-4 rounded-xl border border-default bg-default p-4"
          data-inbox-prefs
        >
          <h2 class="text-sm font-semibold text-default">
            How you hear
          </h2>
          <p class="mt-1 text-xs text-muted">
            Everything arrives here. These are extra ways to be told.
          </p>
          <div class="mt-3 space-y-3">
            <label class="flex items-start gap-3">
              <input
                type="checkbox"
                class="mt-0.5 size-4 accent-primary"
                :checked="prefs.browser"
                data-pref-browser
                @change="toggle('browser')"
              >
              <span>
                <span class="block text-sm text-default">Desktop notifications</span>
                <span class="block text-xs text-muted">Shown by your browser when Taskmanager is open in a tab you are not looking at.</span>
              </span>
            </label>
            <label
              v-if="push.supported && push.enabled"
              class="flex items-start gap-3"
            >
              <input
                type="checkbox"
                class="mt-0.5 size-4 accent-primary"
                :checked="push.subscribed"
                data-pref-push
                @change="togglePush"
              >
              <span>
                <span class="block text-sm text-default">Push notifications on this device</span>
                <span class="block text-xs text-muted">Shown by your device even when Taskmanager is closed.</span>
                <span
                  v-if="push.subscribed"
                  class="mt-1 flex items-center gap-2 text-xs"
                >
                  <button
                    type="button"
                    class="text-primary hover:underline"
                    data-push-test
                    @click.prevent="sendTest"
                  >Send a test</button>
                  <span
                    v-if="pushNote"
                    class="text-muted"
                    data-push-note
                  >{{ pushNote }}</span>
                </span>
              </span>
            </label>
            <label class="flex items-start gap-3">
              <input
                type="checkbox"
                class="mt-0.5 size-4 accent-primary"
                :checked="prefs.email"
                data-pref-email
                @change="toggle('email')"
              >
              <span>
                <span class="block text-sm text-default">Email</span>
                <span class="block text-xs text-muted">A message for each notification, with a link to open it.</span>
                <span
                  v-if="prefs.email && !prefs.mailEnabled"
                  class="mt-1 block text-xs text-warning"
                  data-mail-note
                >This server has no mail set up yet, so nothing is being sent.</span>
              </span>
            </label>
          </div>
          <p
            v-if="settingsError"
            class="mt-3 text-xs text-error"
            data-pref-error
          >
            {{ settingsError }}
          </p>
        </section>

        <div class="mb-3 flex gap-1">
          <button
            v-for="option in (['all', 'unread'] as const)"
            :key="option"
            class="rounded-md px-2.5 py-1 text-xs capitalize transition-colors"
            :class="filter === option ? 'bg-elevated font-medium text-default' : 'text-muted hover:text-default'"
            :data-inbox-filter="option"
            :data-agent-filter="option"
            @click="filter = option"
          >
            {{ option }}
          </button>
        </div>

        <template v-if="!onAgentTab">
          <p
            v-if="loaded && !shown.length"
            class="rounded-xl border border-dashed border-default px-4 py-12 text-center text-sm text-muted"
            data-inbox-empty
          >
            {{ filter === 'unread' ? 'You are all caught up.' : 'Nothing yet. Assignments, comments and messages for you will land here.' }}
          </p>

          <section
            v-for="[day, dayItems] in byDay"
            :key="day"
            class="mb-5"
          >
            <h3 class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-dimmed">
              {{ dayLabel(day) }}
            </h3>
            <ul class="overflow-hidden rounded-xl border border-default bg-default">
              <li
                v-for="item in dayItems"
                :key="item.id"
                class="flex cursor-pointer items-start gap-3 border-b border-default px-3 py-3 transition-colors last:border-b-0 hover:bg-elevated/60"
                :class="isOpen(item) ? 'bg-elevated/60' : ''"
                :data-inbox-item="item.type"
                :data-unread="item.readAt ? 'false' : 'true'"
                @click="open(item)"
              >
                <span
                  class="mt-1.5 size-2 shrink-0 rounded-full"
                  :class="item.readAt ? 'bg-transparent' : 'bg-primary'"
                />
                <UAvatar
                  :src="item.actorImage ?? undefined"
                  :alt="item.actorName ?? 'Someone'"
                  size="xs"
                  class="mt-0.5"
                />
                <div class="min-w-0 flex-1">
                  <p
                    class="text-sm"
                    :class="item.readAt ? 'text-muted' : 'font-medium text-default'"
                  >
                    {{ item.title }}
                  </p>
                  <p
                    v-if="item.body"
                    class="mt-0.5 line-clamp-2 text-xs text-muted"
                  >
                    {{ item.body }}
                  </p>
                  <p class="mt-1 text-xs text-dimmed">
                    {{ item.projectName }}
                  </p>
                </div>
                <span class="shrink-0 text-xs text-dimmed">{{ relativeTime(item.createdAt) }}</span>
              </li>
            </ul>
          </section>
        </template>
        <template v-else>
          <p
            class="mb-4 text-xs text-muted"
            data-agent-note
          >
            An agent is a tool or script that works on your boards with an API key. Agent activity is only shown here, and it never sends email or push.
            <NuxtLink
              to="/settings"
              class="text-primary hover:underline"
              data-agent-manage
            >
              Manage agents
            </NuxtLink>
          </p>
          <p
            v-if="auditLoaded && !agentShown.length"
            class="rounded-xl border border-dashed border-default px-4 py-12 text-center text-sm text-muted"
            data-agent-empty
          >
            {{ filter === 'unread' ? 'You are all caught up.' : 'Nothing yet. When one of your agents changes something it shows up here.' }}
          </p>

          <section
            v-for="[day, dayItems] in agentByDay"
            :key="day"
            class="mb-5"
            data-agent-day
          >
            <h3 class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-dimmed">
              {{ dayLabel(day) }}
            </h3>
            <ul class="overflow-hidden rounded-xl border border-default bg-default">
              <li
                v-for="item in dayItems"
                :key="item.id"
                class="flex items-start gap-3 border-b border-default px-3 py-3 transition-colors last:border-b-0"
                :class="agentAuditLink(item) ? 'cursor-pointer hover:bg-elevated/60' : ''"
                :data-agent-item="item.tool"
                :data-unread="item.readAt ? 'false' : 'true'"
                :data-agent-link="agentAuditLink(item) ? 'true' : 'false'"
                @click="openAgent(item)"
              >
                <span
                  class="mt-1.5 size-2 shrink-0 rounded-full"
                  :class="item.readAt ? 'bg-transparent' : 'bg-primary'"
                />
                <span
                  class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-elevated text-muted"
                  aria-hidden="true"
                >
                  <UIcon
                    name="i-lucide-bot"
                    class="size-4"
                  />
                </span>
                <div class="min-w-0 flex-1">
                  <p
                    class="text-sm"
                    :class="item.readAt ? 'text-muted' : 'font-medium text-default'"
                  >
                    <span class="text-xs font-normal text-muted">via API key {{ item.keyName }}</span>
                    {{ item.toolTitle }}
                  </p>
                  <p class="mt-0.5 line-clamp-2 text-xs text-muted">
                    {{ item.summary }}
                  </p>
                  <p
                    v-if="item.projectName || item.taskTitle"
                    class="mt-1 truncate text-xs text-dimmed"
                  >
                    {{ [item.projectName, item.taskTitle].filter(Boolean).join(' · ') }}
                  </p>
                </div>
                <span class="shrink-0 text-xs text-dimmed">{{ relativeTime(item.createdAt) }}</span>
              </li>
            </ul>
          </section>
        </template>
      </div>
    </div>

    <KanbanTaskDrawer
      :task="drawerTask"
      @close="openTaskId = null"
    />

    <USlideover
      :open="openThread !== null"
      :title="openThread?.projectName ?? ''"
      description="Messages"
      :ui="{ content: 'max-w-2xl', body: 'p-0 sm:p-0' }"
      data-inbox-thread
      @update:open="(value: boolean) => { if (!value) openThread = null }"
    >
      <template #body>
        <KanbanProjectMessagesView
          v-if="openThread"
          :project-id="openThread.projectId"
          :thread-id="openThread.threadId"
          @show-all="openThread = { ...openThread, threadId: null }"
        />
      </template>
    </USlideover>
  </div>
</template>
