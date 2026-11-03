<script setup lang="ts">
import { relativeTime } from '~/composables/useRelativeTime'
import type { Project } from '~/composables/useProjects'
import type { PinnedBoard } from '~/composables/usePins'
import { taskCountLabel } from '#shared/utils/board'

const { ready, projects, allTasks, deleteProject, renameProject } = useProjects()
const route = useRoute()
const { unread: inboxUnread } = useNotifications()
const { pins, pinsLoaded, loadPins, isPinned, pinBoard, unpinBoard } = usePins()
const { activeTeamId } = useTeams()
const { switchWorkspace } = useWorkspace()
const toast = useToast()

const activeId = computed(() => (route.params.id as string | undefined) ?? null)

function openProject(id: string) {
  if (route.path !== `/projects/${id}`) navigateTo(`/projects/${id}`)
}

// ─── Pins ──────────────────────────────────────────────────
// Pins come from every workspace. A board in the open workspace shows its live name from
// the project list; one elsewhere shows the name it had when the list was last loaded.

onMounted(() => {
  if (!pinsLoaded.value) loadPins().catch(() => {})
})
// A team switch can add or drop a membership's boards (joining, leaving), so reload then.
watch(activeTeamId, () => loadPins().catch(() => {}))

function pinName(pin: PinnedBoard) {
  return projects.value.find(p => p.id === pin.projectId)?.name ?? pin.name
}

function pinPlace(pin: PinnedBoard) {
  return [pin.teamName ?? 'Personal Workspace', pin.customerName].filter(Boolean).join(' · ')
}

// A board in another workspace switches to it first, as the team switcher does, then opens it.
async function openPin(pin: PinnedBoard) {
  await switchWorkspace(pin.teamId)
  await navigateTo(`/projects/${pin.projectId}`)
}

async function togglePin(projectId: string) {
  try {
    await (isPinned(projectId) ? unpinBoard(projectId) : pinBoard(projectId))
  } catch {
    toast.add({ title: 'Could not change the pin', color: 'error' })
  }
}

// Project creation lives on one surface only: /projects?new=1.
function newProject() {
  navigateTo('/projects?new=1')
}

// "47 tasks" on a board six months old says nothing — almost all of them are
// finished. Counting what is still short of the board's finishing columns says
// how much is left, and the total is still there behind it.
const taskCounts = computed(() => {
  const terminal = new Map(projects.value.map(p => [p.id, new Set(p.terminalColumnIds ?? [])]))
  const counts = new Map<string, { open: number, total: number }>()
  for (const task of allTasks.value) {
    const entry = counts.get(task.projectId) ?? { open: 0, total: 0 }
    entry.total++
    if (!terminal.get(task.projectId)?.has(task.columnId)) entry.open++
    counts.set(task.projectId, entry)
  }
  return counts
})

function countsFor(project: Project) {
  return taskCounts.value.get(project.id) ?? { open: 0, total: 0 }
}

function countLabel(project: Project) {
  const { open, total } = countsFor(project)
  return taskCountLabel(open, total, (project.terminalColumnIds?.length ?? 0) > 0)
}

function countTitle(project: Project) {
  const { open, total } = countsFor(project)
  return project.terminalColumnIds?.length ? `${open} open of ${total}` : `${total} in total`
}

// ─── Inline rename / delete ────────────────────────────────

const renamingId = ref<string | null>(null)
const renameValue = ref('')

async function startRename(project: { id: string, name: string }) {
  renamingId.value = project.id
  renameValue.value = project.name
  // A `ref` inside v-for collects into an array, so the one mounted input is
  // picked up from the DOM instead.
  await nextTick()
  document.querySelector<HTMLInputElement>('[data-project-rename]')?.select()
}

async function commitRename(project: { id: string, name: string }) {
  const id = renamingId.value
  const name = renameValue.value.trim()
  renamingId.value = null
  if (id && name && name !== project.name) {
    await renameProject(id, name)
    if (isPinned(id)) loadPins().catch(() => {})
  }
}

const WORKSPACE_LINKS = [
  { to: '/projects/home', label: 'Home', icon: 'i-lucide-house' },
  { to: '/projects/inbox', label: 'Inbox', icon: 'i-lucide-inbox' },
  { to: '/projects/my-tasks', label: 'My tasks', icon: 'i-lucide-circle-check' },
  { to: '/projects/browse', label: 'Browse projects', icon: 'i-lucide-folder-search' },
  { to: '/projects/goals', label: 'Goals', icon: 'i-lucide-target' },
  { to: '/projects/portfolios', label: 'Portfolios', icon: 'i-lucide-layout-grid' },
  { to: '/projects/timesheet', label: 'Timesheet', icon: 'i-lucide-clock' },
  { to: '/projects/profile', label: 'Profile', icon: 'i-lucide-user-round' }
]

const deleteTarget = ref<{ id: string, name: string } | null>(null)

async function confirmDelete() {
  const target = deleteTarget.value
  deleteTarget.value = null
  if (!target) return
  await deleteProject(target.id)
  if (isPinned(target.id)) loadPins().catch(() => {})
  if (activeId.value === target.id) navigateTo('/projects')
}

// Anyone may pin a board they can open; a customer's board is the organisation's to rename or delete.
function menuItems(project: Project) {
  const pinned = isPinned(project.id)
  const pin = [{
    label: pinned ? 'Unpin' : 'Pin to sidebar',
    icon: pinned ? 'i-lucide-pin-off' : 'i-lucide-pin',
    onSelect: () => togglePin(project.id)
  }]
  if (project.audience === 'customer') return [pin]
  return [pin, [
    { label: 'Rename', icon: 'i-lucide-pencil', onSelect: () => startRename(project) }
  ], [
    {
      label: 'Delete project',
      icon: 'i-lucide-trash-2',
      color: 'error' as const,
      onSelect: () => { deleteTarget.value = project }
    }
  ]]
}
</script>

<template>
  <div class="flex flex-col gap-0.5">
    <nav
      class="mb-2 flex flex-col gap-0.5 border-b border-default pb-2"
      aria-label="Workspace"
    >
      <NuxtLink
        v-for="link in WORKSPACE_LINKS"
        :key="link.to"
        :to="link.to"
        class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted transition-colors hover:bg-elevated hover:text-default"
        active-class="bg-elevated font-medium text-default"
      >
        <UIcon
          :name="link.icon"
          class="size-4"
        />
        {{ link.label }}
        <span
          v-if="link.to === '/projects/inbox' && inboxUnread"
          class="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[0.625rem] font-semibold leading-none tabular-nums text-inverted"
          data-inbox-badge
        >{{ inboxUnread > 99 ? '99+' : inboxUnread }}</span>
      </NuxtLink>
    </nav>

    <RunningTimer />

    <template v-if="pins.length">
      <div class="px-2 pb-1">
        <span class="text-xs font-semibold uppercase tracking-wider text-dimmed">Pinned</span>
      </div>
      <div
        v-for="pin in pins"
        :key="pin.projectId"
        class="group flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-1.5 transition-colors"
        :class="activeId === pin.projectId ? 'bg-elevated' : 'hover:bg-elevated/60'"
        data-pinned-board
        @click="openPin(pin)"
      >
        <UIcon
          name="i-lucide-pin"
          class="mt-0.5 size-4 shrink-0"
          :class="activeId === pin.projectId ? 'text-primary' : 'text-dimmed group-hover:text-muted'"
        />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium leading-snug text-default">
            {{ pinName(pin) }}
          </p>
          <p class="truncate text-xs text-muted">
            {{ pinPlace(pin) }}
          </p>
        </div>
        <UButton
          icon="i-lucide-pin-off"
          size="xs"
          color="neutral"
          variant="ghost"
          class="mt-0.5 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
          :aria-label="`Unpin ${pinName(pin)}`"
          @click.stop="togglePin(pin.projectId)"
        />
      </div>
      <div class="mb-2 border-b border-default pb-2" />
    </template>

    <div class="flex items-center justify-between px-2 pb-1">
      <span class="text-xs font-semibold uppercase tracking-wider text-dimmed">Projects</span>
      <UButton
        icon="i-lucide-plus"
        size="xs"
        color="neutral"
        variant="ghost"
        aria-label="New project"
        @click="newProject"
      />
    </div>

    <p
      v-if="ready && projects.length === 0"
      class="px-2 py-3 text-xs text-dimmed"
    >
      No projects yet.
      <button
        class="text-primary hover:underline"
        @click="newProject"
      >
        Create one
      </button>
    </p>

    <template
      v-for="project in projects"
      :key="project.id"
    >
      <input
        v-if="renamingId === project.id"
        v-model="renameValue"
        data-project-rename
        class="w-full rounded-lg bg-default px-2.5 py-1.5 text-sm font-medium text-default outline-none ring-1 ring-primary"
        @keydown.enter.prevent="commitRename(project)"
        @keydown.escape="renamingId = null"
        @blur="commitRename(project)"
      >
      <div
        v-else
        class="group flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-1.5 transition-colors"
        :class="activeId === project.id ? 'bg-elevated' : 'hover:bg-elevated/60'"
        @click="openProject(project.id)"
      >
        <UIcon
          :name="project.customerId ? 'i-lucide-building-2' : 'i-lucide-kanban'"
          class="mt-0.5 size-4 shrink-0"
          :class="activeId === project.id ? 'text-primary' : 'text-dimmed group-hover:text-muted'"
        />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium leading-snug text-default">
            {{ project.name }}
          </p>
          <p
            class="truncate text-xs text-muted"
            :title="countTitle(project)"
          >
            {{ project.customerName ? `${project.customerName} · ` : '' }}{{ relativeTime(project.updatedAt) }} · {{ countLabel(project) }} {{ countsFor(project).total === 1 ? 'task' : 'tasks' }}
          </p>
        </div>
        <!-- The menu keeps its slot even when invisible, so rows never jump on hover. -->
        <UDropdownMenu
          :items="menuItems(project)"
          :content="{ align: 'start', collisionPadding: 12 }"
        >
          <UButton
            icon="i-lucide-ellipsis"
            size="xs"
            color="neutral"
            variant="ghost"
            class="mt-0.5 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
            aria-label="Project options"
            @click.stop
          />
        </UDropdownMenu>
      </div>
    </template>

    <UModal
      :open="deleteTarget !== null"
      title="Delete project?"
      description="Columns, tasks and updates are deleted with it. This cannot be undone."
      :ui="{ footer: 'justify-end' }"
      @update:open="(v: boolean) => { if (!v) deleteTarget = null }"
    >
      <template #footer>
        <UButton
          label="Cancel"
          color="neutral"
          variant="ghost"
          @click="deleteTarget = null"
        />
        <UButton
          label="Delete project"
          color="error"
          @click="confirmDelete"
        />
      </template>
    </UModal>
  </div>
</template>
