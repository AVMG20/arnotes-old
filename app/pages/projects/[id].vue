<script setup lang="ts">
import type { ProjectTask } from '~/composables/useProjects'
import { taskCountLabel, terminalColumnIds } from '#shared/utils/board'

definePageMeta({ layout: 'app' })

const route = useRoute()
const { sidebarOpen } = useSidebar()
const searchOpen = useSearchModal()

const {
  activeProject,
  isCustomerView,
  loadBoard,
  board,
  boardColumns,
  renameProject,
  setProjectCustomer,
  updateProjectSharing,
  unarchiveProject,
  activeTags,
  boardTagCounts,
  toggleTagFilter,
  clearTagFilter,
  showTrashed,
  trashedCount,
  toggleShowTrashed,
  isTrashed
} = useProjects()

const projectId = computed(() => route.params.id as string)

const VIEWS = [
  { key: 'overview', label: 'Overview', icon: 'i-lucide-layout-dashboard' },
  { key: 'board', label: 'Board', icon: 'i-lucide-kanban' },
  { key: 'list', label: 'List', icon: 'i-lucide-list' },
  { key: 'timeline', label: 'Timeline', icon: 'i-lucide-gantt-chart' },
  { key: 'calendar', label: 'Calendar', icon: 'i-lucide-calendar-days' },
  { key: 'dashboard', label: 'Dashboard', icon: 'i-lucide-chart-column' },
  { key: 'messages', label: 'Messages', icon: 'i-lucide-message-square' },
  { key: 'time', label: 'Time', icon: 'i-lucide-clock' },
  { key: 'files', label: 'Files', icon: 'i-lucide-paperclip' },
  { key: 'settings', label: 'Settings', icon: 'i-lucide-settings' }
] as const

// Time, messages and settings are the team's own: a customer's contact has no tab for them.
const STAFF_ONLY_VIEWS: string[] = ['messages', 'time', 'settings']
const visibleViews = computed(() => VIEWS.filter(v => !STAFF_ONLY_VIEWS.includes(v.key) || !isCustomerView.value))

const tabViews = computed(() => visibleViews.value.filter(v => v.key !== 'settings'))
const view = computed(() => visibleViews.value.find(v => v.key === route.query.view)?.key ?? 'board')

function setView(key: string) {
  navigateTo({ path: route.path, query: { ...route.query, view: key === 'board' ? undefined : key } }, { replace: true })
}

// The tab row scrolls sideways on a phone. Its edges fade where tabs are cut off,
// so it is clear that the row goes on.
const tabsEl = ref<HTMLElement | null>(null)
const moreLeft = ref(false)
const moreRight = ref(false)
function updateTabCues() {
  const el = tabsEl.value
  if (!el) return
  moreLeft.value = el.scrollLeft > 1
  moreRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
}
const tabsMaskStyle = computed(() => {
  if (!moreLeft.value && !moreRight.value) return {}
  const start = moreLeft.value ? 'transparent 0, black 2.5rem' : 'black 0'
  const end = moreRight.value ? 'black calc(100% - 2.5rem), transparent 100%' : 'black 100%'
  const mask = `linear-gradient(to right, ${start}, ${end})`
  return { maskImage: mask, WebkitMaskImage: mask }
})
watch(visibleViews, () => nextTick(updateTabCues))
onMounted(() => {
  updateTabCues()
  window.addEventListener('resize', updateTabCues)
})
onBeforeUnmount(() => window.removeEventListener('resize', updateTabCues))

const loadFailed = ref(false)
// The team a board that will not open here belongs to, when the caller is in that team.
const teamHint = ref<{ teamId: string, teamName: string } | null>(null)

async function openBoard(id: string) {
  loadFailed.value = false
  teamHint.value = null
  try {
    await loadBoard(id)
  } catch {
    // Deleted in another tab, or a board from a workspace this session no longer
    // has: an endless spinner is the one thing that must not happen.
    loadFailed.value = true
    teamHint.value = await $fetch<{ teamId: string, teamName: string }>(`/api/projects/${id}/team-hint`).catch(() => null)
  }
}

watch(projectId, (id) => {
  if (!id || !/^[a-z0-9]+$/i.test(id)) return
  openBoard(id)
}, { immediate: true })

// The board's team is one click away: switch the workspace to it and open the board.
async function switchToHintTeam() {
  const hint = teamHint.value
  if (!hint) return
  await setActiveTeam(hint.teamId)
  await refreshProjects()
  await openBoard(projectId.value)
}

// ─── Task panel ────────────────────────────────────────────

const drawerTaskId = ref<string | null>(null)

// Deep link ?task=<id> (global search) opens the panel.
watch(() => route.query.task, (taskId) => {
  drawerTaskId.value = typeof taskId === 'string' && taskId ? taskId : null
}, { immediate: true })

function closeDrawer() {
  drawerTaskId.value = null
  if (route.query.task) navigateTo({ path: route.path, replace: true })
}

const drawerTask = computed<ProjectTask | null>(() =>
  drawerTaskId.value ? board.value?.tasks.find(t => t.id === drawerTaskId.value) ?? null : null
)

// ─── Project name (inline rename) ──────────────────────────

const renaming = ref(false)
const nameDraft = ref('')
const nameEl = ref<HTMLInputElement | null>(null)

async function startRename() {
  if (!activeProject.value || isCustomerView.value) return
  nameDraft.value = activeProject.value.name
  renaming.value = true
  await nextTick()
  nameEl.value?.select()
}

async function commitRename() {
  const name = nameDraft.value.trim()
  const project = activeProject.value
  renaming.value = false
  if (project && name && name !== project.name) await renameProject(project.id, name)
}

async function unarchiveNow() {
  const project = activeProject.value
  if (!project) return
  await unarchiveProject(project.id)
}

// The trash entry earns its place only when there is something in it — or when
// it is already on, so there is a way back. A board with nothing deleted looks
// exactly as it did before.
const projectMenu = computed(() => {
  const trash = trashedCount.value > 0 || showTrashed.value
    ? [[{
        label: showTrashed.value ? 'Hide trashed' : `Show trashed (${trashedCount.value})`,
        icon: showTrashed.value ? 'i-lucide-eye-off' : 'i-lucide-trash-2',
        onSelect: () => { toggleShowTrashed() }
      }]]
    : []

  return [
    [{ label: 'Rename project', icon: 'i-lucide-pencil', onSelect: startRename }],
    ...trash
  ]
})

// The open board knows its own columns, so the count is read from them live
// rather than from the shape cached with the project list.
// Trashed rows are only in state while "Show trashed" is on, and they are not
// part of how much work the board holds.
const liveColumns = computed(() => boardColumns.value.filter(column => !isTrashed(column)))
const liveTasks = computed(() => (board.value?.tasks ?? []).filter(task => !isTrashed(task)))

const taskCount = computed(() => liveTasks.value.length)

const taskCountText = computed(() => {
  const terminal = new Set(terminalColumnIds(liveColumns.value))
  const open = liveTasks.value.filter(task => !terminal.has(task.columnId)).length
  return taskCountLabel(open, liveTasks.value.length, terminal.size > 0)
})

const taskCountTitle = computed(() => {
  const terminal = new Set(terminalColumnIds(liveColumns.value))
  const tasks = liveTasks.value
  if (!terminal.size) return `${tasks.length} in total`
  return `${tasks.filter(task => !terminal.has(task.columnId)).length} open of ${tasks.length}`
})

// ─── Customer ──────────────────────────────────────────────

// Only an organisation's boards can belong to a customer; a personal board has
// nobody to share with.
const { activeTeamId, setActiveTeam } = useTeams()
const { refresh: refreshProjects } = useProjects()
const { customers, ensureLoaded: ensureCustomers } = useCustomers()
const toast = useToast()

const canPickCustomer = computed(() => Boolean(activeTeamId.value) && !isCustomerView.value)

watch(canPickCustomer, (can) => {
  if (can) ensureCustomers().catch(() => {})
}, { immediate: true })

async function pickCustomer(customerId: string | null, customerName: string | null) {
  const project = activeProject.value
  if (!project || (project.customerId ?? null) === customerId) return
  try {
    await setProjectCustomer(project.id, customerId, customerName)
  } catch {
    toast.add({ title: 'Could not change the customer', icon: 'i-lucide-alert-triangle', color: 'error' })
  }
}

const customerMenu = computed(() => [
  [{
    label: 'Team only',
    icon: 'i-lucide-lock',
    onSelect: () => pickCustomer(null, null)
  }],
  customers.value.map(c => ({
    label: c.name,
    icon: c.id === activeProject.value?.customerId ? 'i-lucide-check' : 'i-lucide-building-2',
    onSelect: () => pickCustomer(c.id, c.name)
  }))
])

// ─── Sharing ───────────────────────────────────────────────

const publicLink = computed(() =>
  activeProject.value && import.meta.client
    ? `${window.location.origin}/public/project/${activeProject.value.id}`
    : ''
)

function saveSharing(isPublic: boolean, publicUntil: number | null) {
  return updateProjectSharing(projectId.value, isPublic, publicUntil)
}

useSeoMeta({
  title: computed(() => activeProject.value?.name || 'Projects')
})
</script>

<template>
  <div class="flex min-w-0 flex-1 flex-col">
    <!-- Board header -->
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

      <input
        v-if="renaming"
        ref="nameEl"
        v-model="nameDraft"
        class="min-w-0 max-w-80 flex-1 rounded bg-elevated px-2 py-1 text-base font-semibold text-default outline-none ring-1 ring-primary"
        @keydown.enter.prevent="commitRename"
        @keydown.escape="renaming = false"
        @blur="commitRename"
      >
      <button
        v-else
        class="min-w-0 flex-1 rounded px-1 py-0.5 text-left text-base font-semibold text-default transition-colors lg:flex-none lg:truncate max-lg:line-clamp-2 max-lg:break-words"
        :class="isCustomerView ? 'cursor-default' : 'hover:bg-elevated'"
        :title="activeProject?.name"
        @click="startRename"
      >
        {{ activeProject?.name ?? 'Board' }}
      </button>

      <UDropdownMenu
        v-if="canPickCustomer"
        :items="customerMenu"
        :content="{ align: 'start' }"
      >
        <UButton
          size="xs"
          color="neutral"
          variant="soft"
          :icon="activeProject?.customerId ? 'i-lucide-building-2' : 'i-lucide-lock'"
          class="shrink-0"
        >
          {{ activeProject?.customerName ?? 'Team only' }}
        </UButton>
      </UDropdownMenu>
      <UBadge
        v-else-if="activeProject?.customerName"
        size="sm"
        color="neutral"
        variant="soft"
        icon="i-lucide-building-2"
        class="shrink-0"
      >
        {{ activeProject.customerName }}
      </UBadge>

      <span
        class="shrink-0 text-xs text-dimmed max-sm:hidden"
        :title="taskCountTitle"
      >
        {{ taskCountText }} {{ taskCount === 1 ? 'task' : 'tasks' }}
      </span>

      <div class="ml-auto flex shrink-0 items-center gap-1">
        <!-- Label filter -->
        <UPopover
          v-if="boardTagCounts.length"
          :content="{ align: 'end', sideOffset: 6 }"
        >
          <UButton
            icon="i-lucide-filter"
            size="xs"
            :color="activeTags.length ? 'primary' : 'neutral'"
            :variant="activeTags.length ? 'soft' : 'ghost'"
          >
            <span class="hidden sm:inline">Labels</span>
            <span v-if="activeTags.length">{{ activeTags.length }}</span>
          </UButton>

          <template #content>
            <div class="w-56 p-1.5">
              <div class="flex items-center justify-between px-1.5 pb-1.5">
                <span class="text-xs font-semibold text-muted">Filter by label</span>
                <button
                  v-if="activeTags.length"
                  class="text-xs text-primary hover:underline"
                  @click="clearTagFilter"
                >
                  Clear
                </button>
              </div>
              <button
                v-for="[tag, count] in boardTagCounts"
                :key="tag"
                class="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-elevated"
                @click="toggleTagFilter(tag)"
              >
                <UIcon
                  :name="activeTags.includes(tag) ? 'i-lucide-square-check' : 'i-lucide-square'"
                  class="size-3.5 shrink-0"
                  :class="activeTags.includes(tag) ? 'text-primary' : 'text-dimmed'"
                />
                <KanbanLabelChip
                  :tag="tag"
                  :editable="!isCustomerView"
                  chip-class="min-w-0 flex-1 text-xs"
                />
                <span class="shrink-0 text-xs tabular-nums text-dimmed">{{ count }}</span>
              </button>
            </div>
          </template>
        </UPopover>

        <!-- Settings lives here, not in the tab row: at 1280 px the last tab was cut off -->
        <UButton
          v-if="activeProject && !isCustomerView"
          icon="i-lucide-settings"
          size="xs"
          :color="view === 'settings' ? 'primary' : 'neutral'"
          :variant="view === 'settings' ? 'soft' : 'ghost'"
          aria-label="Project settings"
          data-project-settings
          @click="setView('settings')"
        >
          <span class="hidden sm:inline">Settings</span>
        </UButton>

        <SharePopover
          v-if="activeProject && !isCustomerView"
          subject="board"
          :is-public="activeProject.isPublic"
          :public-until="activeProject.publicUntil"
          :link="publicLink"
          :save="saveSharing"
        />

        <UDropdownMenu
          v-if="!isCustomerView"
          :items="projectMenu"
        >
          <UButton
            icon="i-lucide-ellipsis"
            size="xs"
            color="neutral"
            variant="ghost"
            aria-label="Project options"
          />
        </UDropdownMenu>
      </div>
    </header>

    <!-- Archived: out of the lists and its rules are paused; the board itself stays usable -->
    <div
      v-if="activeProject?.archivedAt"
      class="flex flex-wrap items-center gap-3 border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-default lg:px-6"
      data-archived-banner
    >
      <span class="inline-flex items-center gap-1.5 font-medium">
        <UIcon
          name="i-lucide-archive"
          class="size-4 text-warning"
        />
        Archived
      </span>
      <span class="min-w-0 flex-1 text-muted">
        Hidden from the project lists and its rules are paused. Tasks can still be edited.
      </span>
      <UButton
        v-if="!isCustomerView"
        label="Unarchive"
        icon="i-lucide-archive-restore"
        color="neutral"
        variant="outline"
        size="sm"
        data-unarchive
        @click="unarchiveNow"
      />
    </div>

    <!-- View tabs -->
    <nav
      ref="tabsEl"
      class="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-default px-4 lg:px-6"
      aria-label="Project views"
      :style="tabsMaskStyle"
      @scroll="updateTabCues"
    >
      <button
        v-for="v in tabViews"
        :key="v.key"
        class="relative flex shrink-0 items-center gap-1.5 px-2.5 py-2 text-sm transition-colors"
        :class="view === v.key ? 'font-medium text-default' : 'text-muted hover:text-default'"
        :aria-current="view === v.key ? 'page' : undefined"
        @click="setView(v.key)"
      >
        <UIcon
          :name="v.icon"
          class="size-4"
        />
        {{ v.label }}
        <span
          class="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary transition-opacity duration-200"
          :class="view === v.key ? 'opacity-100' : 'opacity-0'"
        />
      </button>
    </nav>

    <!-- Trash summary. The board itself draws the deleted columns and cards in
         place; this says what is being looked at and how long it has left. -->
    <div
      v-if="showTrashed"
      class="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-default bg-elevated/40 px-4 py-2 lg:px-6"
    >
      <UIcon
        name="i-lucide-trash-2"
        class="size-3.5 shrink-0 text-dimmed"
      />
      <span class="text-xs text-muted">
        Showing {{ trashedCount }} deleted {{ trashedCount === 1 ? 'item' : 'items' }} in place.
      </span>
      <span class="text-xs text-dimmed">
        Anything deleted more than 7 days ago is removed automatically.
      </span>
      <button
        class="ml-auto text-xs text-primary hover:underline"
        @click="toggleShowTrashed"
      >
        Hide
      </button>
    </div>

    <!-- Active filter summary -->
    <div
      v-if="activeTags.length"
      class="flex shrink-0 items-center gap-1.5 border-b border-default px-4 py-2 lg:px-6"
    >
      <span class="text-xs text-dimmed">Showing tasks labelled</span>
      <button
        v-for="tag in activeTags"
        :key="tag"
        class="flex items-center gap-1"
        @click="toggleTagFilter(tag)"
      >
        <KanbanLabelChip
          :tag="tag"
          :editable="!isCustomerView"
          chip-class="cursor-pointer text-xs"
        />
        <UIcon
          name="i-lucide-x"
          class="size-3 opacity-50"
        />
      </button>
    </div>

    <!-- Board -->
    <div class="min-h-0 flex-1">
      <div
        v-if="loadFailed"
        class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
      >
        <UIcon
          name="i-lucide-unlink"
          class="size-6 text-dimmed"
        />
        <p class="text-sm text-muted">
          {{ teamHint ? `This board is in the team ${teamHint.teamName}.` : "This board is not available in this workspace." }}
        </p>
        <UButton
          v-if="teamHint"
          :label="`Switch to ${teamHint.teamName} and open it`"
          size="sm"
          color="primary"
          variant="soft"
          @click="switchToHintTeam"
        />
        <UButton
          label="Back to projects"
          size="sm"
          color="neutral"
          variant="soft"
          @click="navigateTo('/projects')"
        />
      </div>
      <template v-else-if="projectId">
        <KanbanProjectOverviewView
          v-if="view === 'overview'"
          :project-id="projectId"
        />
        <KanbanBoard
          v-else-if="view === 'board'"
          :project-id="projectId"
          @open-task="drawerTaskId = $event"
        />
        <KanbanProjectListView
          v-else-if="view === 'list'"
          @open-task="drawerTaskId = $event"
        />
        <KanbanProjectTimelineView
          v-else-if="view === 'timeline'"
          @open-task="drawerTaskId = $event"
        />
        <KanbanProjectCalendarView
          v-else-if="view === 'calendar'"
          @open-task="drawerTaskId = $event"
        />
        <KanbanProjectDashboardView v-else-if="view === 'dashboard'" />
        <KanbanProjectMessagesView
          v-else-if="view === 'messages'"
          :project-id="projectId"
        />
        <KanbanProjectTimeView
          v-else-if="view === 'time'"
          :project-id="projectId"
        />
        <KanbanProjectSettingsView
          v-else-if="view === 'settings'"
          :project-id="projectId"
        />
        <KanbanProjectFilesView
          v-else
          @open-task="drawerTaskId = $event"
        />
      </template>
    </div>

    <!-- Task panel -->
    <KanbanTaskDrawer
      :task="drawerTask"
      @close="closeDrawer"
    />

    <!-- Mobile bottom nav -->
    <div
      class="fixed bottom-0 left-0 right-0 z-20 flex items-center justify-around border-t border-default bg-default/95 px-8 backdrop-blur-sm lg:hidden"
      style="padding-top: 0.5rem; padding-bottom: max(0.5rem, env(safe-area-inset-bottom))"
    >
      <UButton
        icon="i-lucide-panel-left"
        color="neutral"
        variant="ghost"
        size="md"
        aria-label="Open sidebar"
        @click="sidebarOpen = true"
      />
      <UButton
        icon="i-lucide-search"
        color="neutral"
        variant="ghost"
        size="md"
        aria-label="Search"
        @click="searchOpen = true"
      />
      <UButton
        icon="i-lucide-kanban"
        color="primary"
        variant="soft"
        size="md"
        aria-label="Projects"
        @click="navigateTo('/projects')"
      />
    </div>

    <div class="h-14 lg:hidden" />
  </div>
</template>
