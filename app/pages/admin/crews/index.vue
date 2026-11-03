<script setup lang="ts">
import { format } from 'date-fns'

definePageMeta({ layout: 'app' })

useSeoMeta({ title: 'Crews' })

const { isInstanceAdmin, isPending: sessionPending } = useAuth()
const toast = useToast()
const { sidebarOpen } = useSidebar()

function errMsg(e: unknown): string | undefined {
  return (e as { data?: { message?: string } })?.data?.message
}

interface CrewRow {
  id: string
  slug: string
  name: string
  teamName: string | null
  boardUrl: string | null
  createdAt: number
  disabledAt: number | null
  keyLastUsed: number | null
  people: number
}

interface WindowState {
  open: boolean
  openUntil: number | null
  closedReason: string | null
  closedFrom: string | null
  closedAt: number | null
}

// Nothing is fetched until the session says who is asking: a visitor who is not the instance
// admin never sends these requests.
const { data: crewData, refresh: refreshCrews, status: crewStatus } = useFetch<{ crews: CrewRow[] }>('/api/admin/crews', { server: false, immediate: false })
const { data: windowData, refresh: refreshWindow } = useFetch<WindowState>('/api/settings/crew-api-window', { server: false, immediate: false })

watch([sessionPending, isInstanceAdmin], ([pending, admin]) => {
  if (pending) return
  if (!admin) {
    navigateTo('/settings', { replace: true })
    return
  }
  refreshCrews()
  refreshWindow()
}, { immediate: true })

const crews = computed(() => crewData.value?.crews ?? [])

// The clock the time left and the status lines read; it ticks every 10 seconds.
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  clock = setInterval(() => {
    now.value = Date.now()
  }, 10_000)
})
onBeforeUnmount(() => clock && clearInterval(clock))

const windowOpen = computed(() => Boolean(windowData.value?.open && (windowData.value.openUntil ?? 0) > now.value))
const minutesLeft = computed(() => Math.max(0, Math.ceil(((windowData.value?.openUntil ?? 0) - now.value) / 60_000)))

// The window's closing reasons, as the admin reads them. Anything unknown is shown as it came.
const CLOSE_REASONS: Record<string, string> = {
  'timed out': 'the 10 minutes ran out',
  'closed by the owner': 'you closed it',
  'bad key': 'a call presented a key that was refused',
  'wrong scope': 'a call presented a key without the crew scope',
  'expired': 'the temporary key had expired',
  'not admin': 'a call came from a key whose owner is no longer the instance admin'
}

// The closed line says why, when and from where, in one piece of text.
const closedLine = computed(() => {
  const w = windowData.value
  const reason = w?.closedReason ? CLOSE_REASONS[w.closedReason] ?? w.closedReason : ''
  const why = reason ? `: ${reason}` : ''
  const closedAt = w?.closedAt ? ` at ${when(w.closedAt)}` : ''
  const from = w?.closedFrom
    ? `, from ${w.closedFrom === 'unix' ? 'a process on this server' : w.closedFrom}`
    : ''
  return `Closed${why}${closedAt}${from}.`
})

// Secrets are shown once: a key or token leaves the page on dismiss, never stored.
const shownSecret = ref<{ title: string, value: string } | null>(null)
const busy = ref<string | null>(null)
const purging = ref<CrewRow | null>(null)
// Purge is irreversible: the admin types the crew's slug before the button is enabled.
const purgeTyped = ref('')
const purgeReady = computed(() => purging.value !== null && purgeTyped.value === purging.value.slug)

function openPurge(crew: CrewRow) {
  purgeTyped.value = ''
  purging.value = crew
}

// After an action the focus goes back to the control the admin used, not to the page body.
function focusSoon(selector: string) {
  nextTick(() => {
    setTimeout(() => document.querySelector<HTMLElement>(selector)?.focus(), 50)
  })
}

function focusPurgeInput() {
  document.querySelector<HTMLInputElement>('#purge-confirm input')?.focus()
}

function when(ms: number | null | undefined): string {
  return ms ? format(new Date(ms), 'd MMM yyyy, HH:mm') : 'never'
}

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    toast.add({ title: 'Copied', icon: 'i-lucide-check', duration: 1500 })
  } catch {
    toast.add({ title: 'Could not copy. Select the text and copy it.', color: 'warning' })
  }
}

async function openWindow() {
  busy.value = 'window'
  try {
    const opened = await $fetch<{ token: string, openUntil: number }>('/api/settings/crew-api-window', { method: 'POST' })
    shownSecret.value = {
      title: 'Temporary key for the crew API window, open for 10 minutes. Shown once. It is not your crews:manage key.',
      value: opened.token
    }
    await refreshWindow()
  } catch (e) {
    toast.add({ title: 'Could not open the window', description: errMsg(e), color: 'error' })
  } finally {
    busy.value = null
    focusSoon('#window-action')
  }
}

async function closeWindow() {
  busy.value = 'window'
  try {
    await $fetch('/api/settings/crew-api-window', { method: 'DELETE' })
    await refreshWindow()
  } catch (e) {
    toast.add({ title: 'Could not close the window', description: errMsg(e), color: 'error' })
  } finally {
    busy.value = null
    focusSoon('#window-action')
  }
}

async function createKey() {
  busy.value = 'key'
  try {
    // Each key gets its own name (the time to the second), so two keys tell apart in the list.
    const made = await $fetch<{ token: string }>('/api/settings/api-keys', {
      method: 'POST',
      body: { name: `crews key ${format(new Date(), 'd MMM HH:mm:ss')}`, scopes: ['crews:manage'] }
    })
    shownSecret.value = { title: 'New crews:manage key. Shown once: copy it now.', value: made.token }
  } catch (e) {
    toast.add({ title: 'Could not create the key', description: errMsg(e), color: 'error' })
  } finally {
    busy.value = null
  }
}

async function toggleCrew(crew: CrewRow) {
  const enable = Boolean(crew.disabledAt)
  busy.value = crew.slug
  try {
    await $fetch(`/api/admin/crews/${crew.slug}/${enable ? 'enable' : 'disable'}`, { method: 'POST' })
    toast.add({
      title: enable ? `${crew.name} can sign in again` : `${crew.name} is disabled`,
      description: enable ? 'Its keys were revoked. Rotate the crew through the crew API for new ones.' : 'Its keys are revoked and its sessions ended.',
      icon: enable ? 'i-lucide-circle-check' : 'i-lucide-circle-slash',
      duration: 3000
    })
    await refreshCrews()
  } catch (e) {
    toast.add({ title: 'Could not change the crew', description: errMsg(e), color: 'error' })
  } finally {
    busy.value = null
    focusSoon(`#toggle-${crew.slug}`)
  }
}

async function confirmPurge() {
  const crew = purging.value
  if (!crew || !purgeReady.value) return
  purging.value = null
  busy.value = crew.slug
  try {
    await $fetch(`/api/admin/crews/${crew.slug}`, { method: 'DELETE' })
    toast.add({ title: `${crew.name} was deleted`, icon: 'i-lucide-trash-2', duration: 3000 })
    await refreshCrews()
  } catch (e) {
    toast.add({ title: 'Could not delete the crew', description: errMsg(e), color: 'error' })
  } finally {
    busy.value = null
    // The row is gone on success: the heading takes the focus. On failure the row is still there.
    focusSoon(crews.value.some(c => c.slug === crew.slug) ? `#purge-${crew.slug}` : '#crews-heading')
  }
}

// Cancelling the purge puts the focus back on the Purge button it came from.
function cancelPurge() {
  const slug = purging.value?.slug
  purging.value = null
  if (slug) focusSoon(`#purge-${slug}`)
}
</script>

<template>
  <div class="h-full overflow-y-auto px-4 pb-10 pt-6 lg:px-6">
    <div class="mx-auto max-w-4xl space-y-8">
      <div class="flex items-center gap-3">
        <UButton
          v-if="!sidebarOpen"
          icon="i-lucide-panel-left"
          color="neutral"
          variant="ghost"
          size="sm"
          class="lg:hidden"
          aria-label="Open sidebar"
          @click="sidebarOpen = true"
        />
        <div class="flex-1 min-w-0">
          <h1 class="text-xl font-semibold text-default">
            Crews
          </h1>
          <p class="text-sm text-muted">
            Agent teams, made here or through the crew API. Only the instance admin sees this page.
          </p>
        </div>
        <UButton
          v-if="isInstanceAdmin"
          to="/admin/crews/new"
          label="New crew"
          icon="i-lucide-plus"
          size="sm"
        />
      </div>

      <!-- Until the session is known, nothing of the admin's UI is drawn. -->
      <div
        v-if="sessionPending || !isInstanceAdmin"
        class="rounded-lg border border-default p-6 text-sm text-muted"
        data-admin-gate
      >
        {{ sessionPending ? 'Loading…' : 'This page is for the instance admin.' }}
      </div>

      <template v-else>
        <!-- The window: remote callers may use the crew API for 10 minutes -->
        <section class="rounded-lg border border-default p-4 space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 class="text-sm font-semibold text-default">
                Crew API window
              </h2>
              <p class="text-sm text-muted">
                <template v-if="windowOpen">
                  Open for {{ minutesLeft }} more minute{{ minutesLeft === 1 ? '' : 's' }}, until {{ when(windowData?.openUntil) }}.
                </template>
                <template v-else>
                  {{ closedLine }}
                </template>
              </p>
              <p class="mt-1 text-xs text-dimmed">
                Opening it shows a temporary key for this window only. Your crews:manage key is separate.
              </p>
            </div>
            <div class="flex gap-2">
              <UButton
                v-if="!windowOpen"
                id="window-action"
                label="Open for 10 minutes"
                icon="i-lucide-door-open"
                size="sm"
                class="min-h-9 sm:min-h-0"
                :loading="busy === 'window'"
                @click="openWindow"
              />
              <UButton
                v-else
                id="window-action"
                label="Close now"
                icon="i-lucide-door-closed"
                size="sm"
                color="neutral"
                variant="outline"
                class="min-h-9 sm:min-h-0"
                :loading="busy === 'window'"
                @click="closeWindow"
              />
            </div>
          </div>
        </section>

        <!-- A key for the crew API: the one thing an agent host needs to make crews -->
        <section class="rounded-lg border border-default p-4 space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 class="text-sm font-semibold text-default">
                Crew key
              </h2>
              <p class="text-sm text-muted">
                A key that may only manage crews. The agent API lists no tools for it, so it reaches no board. Shown once.
              </p>
            </div>
            <UButton
              label="Create a crews:manage key"
              icon="i-lucide-key-round"
              size="sm"
              color="neutral"
              variant="outline"
              class="min-h-9 sm:min-h-0"
              :loading="busy === 'key'"
              @click="createKey"
            />
          </div>
        </section>

        <!-- The shown-once secret -->
        <section
          v-if="shownSecret"
          class="rounded-lg border border-warning/50 bg-warning/10 p-4 space-y-2"
          data-shown-secret
        >
          <p class="text-sm font-medium text-default">
            {{ shownSecret.title }}
          </p>
          <code class="block break-all rounded bg-elevated p-2 text-xs text-default">{{ shownSecret.value }}</code>
          <div class="flex gap-2">
            <UButton
              label="Copy"
              icon="i-lucide-copy"
              size="xs"
              class="min-h-9 sm:min-h-0"
              @click="copy(shownSecret.value)"
            />
            <UButton
              label="Dismiss"
              size="xs"
              color="neutral"
              variant="ghost"
              class="min-h-9 sm:min-h-0"
              @click="shownSecret = null"
            />
          </div>
        </section>

        <!-- The crews -->
        <section class="space-y-3">
          <h2
            id="crews-heading"
            tabindex="-1"
            class="text-sm font-semibold text-default focus:outline-none"
          >
            Crews on this instance
          </h2>
          <p
            v-if="crewStatus === 'pending' && !crewData"
            class="text-sm text-muted"
          >
            Loading crews…
          </p>
          <div
            v-else-if="!crews.length"
            class="rounded-lg border border-default p-4 text-sm text-muted space-y-2"
          >
            <p>No crews yet.</p>
            <p>
              <NuxtLink
                to="/admin/crews/new"
                class="text-primary hover:underline"
              >New crew</NuxtLink> makes one and walks whoever sets up the agents' machine through the rest. An agent host
              can also call <code class="text-default">POST /api/crews</code> with a crews:manage key (create one above).
              Each crew appears here, with its board link.
            </p>
          </div>
          <ul
            v-else
            class="divide-y divide-default rounded-lg border border-default"
          >
            <li
              v-for="crew in crews"
              :key="crew.id"
              class="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
              :data-crew="crew.slug"
            >
              <div class="min-w-0 space-y-0.5">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-medium text-default break-words">{{ crew.name }}</span>
                  <UBadge
                    :label="crew.disabledAt ? 'Disabled' : 'Live'"
                    :color="crew.disabledAt ? 'warning' : 'success'"
                    variant="soft"
                    size="sm"
                  />
                </div>
                <p class="text-xs text-muted break-words">
                  {{ crew.slug }}<template v-if="crew.teamName">
                    · team {{ crew.teamName }}
                  </template> · {{ crew.people }} people · made {{ when(crew.createdAt) }} · key last used {{ when(crew.keyLastUsed) }}
                </p>
                <a
                  v-if="crew.boardUrl"
                  :href="crew.boardUrl"
                  class="text-xs text-primary hover:underline"
                >Open the board</a>
              </div>
              <div class="flex shrink-0 flex-wrap gap-2">
                <UButton
                  :id="`toggle-${crew.slug}`"
                  :label="crew.disabledAt ? 'Re-enable' : 'Disable'"
                  :aria-label="`${crew.disabledAt ? 'Re-enable' : 'Disable'} ${crew.name}`"
                  :icon="crew.disabledAt ? 'i-lucide-circle-check' : 'i-lucide-circle-slash'"
                  size="xs"
                  color="neutral"
                  variant="outline"
                  class="min-h-9 sm:min-h-0"
                  :loading="busy === crew.slug"
                  @click="toggleCrew(crew)"
                />
                <UButton
                  :id="`purge-${crew.slug}`"
                  label="Purge"
                  :aria-label="`Purge ${crew.name}`"
                  icon="i-lucide-trash-2"
                  size="xs"
                  color="error"
                  variant="ghost"
                  class="min-h-9 sm:min-h-0"
                  :disabled="busy === crew.slug"
                  @click="openPurge(crew)"
                />
              </div>
            </li>
          </ul>
        </section>
      </template>
    </div>

    <UModal
      :open="purging !== null"
      :title="purging ? `Delete ${purging.name} for good?` : ''"
      :description="purging ? `Its accounts, team, customer and board are deleted. Its history goes with them. This cannot be undone.` : ''"
      :ui="{ footer: 'justify-end' }"
      @update:open="(v: boolean) => { if (!v) cancelPurge() }"
      @after:enter="focusPurgeInput"
    >
      <template #body>
        <p class="text-sm text-muted">
          Type <code class="text-default">{{ purging?.slug }}</code> to confirm.
        </p>
        <div
          id="purge-confirm"
          class="mt-3"
        >
          <UInput
            v-model="purgeTyped"
            :placeholder="purging?.slug"
            class="w-full"
          />
        </div>
      </template>
      <template #footer>
        <UButton
          label="Cancel"
          color="neutral"
          variant="ghost"
          @click="cancelPurge"
        />
        <UButton
          label="Delete permanently"
          color="error"
          :disabled="!purgeReady"
          @click="confirmPurge"
        />
      </template>
    </UModal>
  </div>
</template>
