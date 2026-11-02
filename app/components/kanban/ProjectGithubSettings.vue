<script setup lang="ts">
// The Repositories section of a project's settings: the repositories its issues and
// pull requests are linked from, which one `#123` means, the visibility a new link
// takes, and for each repository its issue sync settings. Staff only; the API refuses
// anyone else. Only the project's owner and the team's owners and admins change the
// sync settings, so everyone else sees them read-only.
import { format } from 'date-fns'
import { parseBranches, parseColumnName, parseLogins, sharedBranch, syncStatusWords } from '#shared/utils/githubRepoSync'
import type { RepoSyncSettings } from '#shared/utils/githubRepoSync'

const props = defineProps<{ projectId: string }>()

type Visibility = 'internal' | 'customer'
type SyncField = 'column' | 'logins' | 'staging' | 'production'

interface LinkedRepo {
  id: string
  fullName: string
  visibility: Visibility
  isDefault: boolean
  sync: RepoSyncSettings
}

interface AuditLine {
  id: string
  repo: string
  detail: Record<string, { from: string, to: string }>
  userName: string
  createdAt: number
}

interface RepoList {
  defaultRepo: string | null
  defaultVisibility: Visibility
  canManage: boolean
  columns: string[]
  audit: AuditLine[]
  repos: LinkedRepo[]
}

// The sync form as typed. Logins and branches are text until they are checked.
interface Draft {
  enabled: boolean
  column: string
  visibility: Visibility
  logins: string
  staging: string
  production: string
  completeOnClose: boolean
}

const repos = ref<LinkedRepo[]>([])
const defaultVisibility = ref<Visibility>('internal')
const canManage = ref(false)
const columns = ref<string[]>([])
const audit = ref<AuditLine[]>([])
const loading = ref(true)
const error = ref('')
const notice = ref('')
const saved = ref(false)
const newRepo = ref('')
const newVisibility = ref<Visibility>('internal')
const adding = ref(false)
// The row being changed, and the row waiting for its removal to be confirmed.
const busyId = ref('')
const confirmingId = ref('')
// The sync form per repository: what is typed, what the server last held, and the
// server's words when a save was refused.
const drafts = reactive<Record<string, Draft>>({})
const stored = reactive<Record<string, Draft>>({})
const syncError = reactive<Record<string, string>>({})
// The refusal the server gave a form field, and the value it was given for. The words stay
// by the field until the value changes.
const serverRefusal = reactive<Record<string, { field: SyncField, message: string, value: string } | undefined>>({})

// The form fields a server refusal can name (the API's field names on the left).
const REFUSED_FIELDS: Record<string, SyncField> = {
  acceptedLogins: 'logins',
  syncColumn: 'column',
  stagingBranches: 'staging',
  productionBranches: 'production'
}

function valueOf(draft: Draft, field: SyncField): string {
  if (field === 'logins') return draft.logins
  if (field === 'column') return draft.column
  if (field === 'staging') return draft.staging
  return draft.production
}

// The field a refusal names, when the form has one for it. Anything else stays a plain message.
function refusedFieldOf(e: unknown, draft: Draft) {
  const named = (e as { data?: { data?: { field?: unknown } } })?.data?.data?.field
  const field = typeof named === 'string' ? REFUSED_FIELDS[named] : undefined
  if (!field) return null
  return { field, message: messageOf(e, 'Could not save this value'), value: valueOf(draft, field) }
}

let savedTimer: ReturnType<typeof setTimeout> | undefined

const base = computed(() => `/api/projects/${props.projectId}/github`)

function messageOf(e: unknown, fallback: string) {
  const data = (e as { data?: { message?: unknown } })?.data
  return typeof data?.message === 'string' ? data.message : fallback
}

function flashSaved() {
  saved.value = true
  clearTimeout(savedTimer)
  savedTimer = setTimeout(() => saved.value = false, 1500)
}

// Takes owner/repo, or a github.com repository link, and gives back owner/repo.
// Anything else is passed on as written, and the server says why it is refused.
function repoFromInput(text: string): string {
  const trimmed = text.trim()
  const link = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s?#]+)/i.exec(trimmed)
  if (link) return `${link[1]}/${link[2]!.replace(/\.git$/, '')}`
  return trimmed
}

function draftOf(sync: RepoSyncSettings, fullName: string): Draft {
  return {
    enabled: sync.enabled,
    column: sync.column,
    visibility: sync.visibility,
    logins: sync.acceptedLogins.length ? sync.acceptedLogins.join(', ') : fullName.split('/')[0]!.toLowerCase(),
    staging: sync.stagingBranches,
    production: sync.productionBranches,
    completeOnClose: sync.completeOnClose
  }
}

function isDirty(id: string): boolean {
  return JSON.stringify(drafts[id]) !== JSON.stringify(stored[id])
}

// Each field's problem in plain words, or nothing. The same rules as the server.
function problemsOf(draft: Draft): Partial<Record<SyncField, string>> {
  const problems: Partial<Record<SyncField, string>> = {}
  const logins = parseLogins(draft.logins)
  if (!logins.ok) problems.logins = logins.message
  const column = parseColumnName(draft.column, columns.value)
  if (!column.ok) problems.column = column.message
  const staging = parseBranches(draft.staging, 'Staging')
  if (!staging.ok) problems.staging = staging.message
  const production = parseBranches(draft.production, 'Production')
  if (!production.ok) problems.production = production.message
  if (staging.ok && production.ok) {
    const both = sharedBranch(staging.value, production.value)
    if (both) problems.production = `"${both}" is named as both staging and production: a branch is one or the other`
  }
  return problems
}

// What the server refused for a field, while the field still holds the value it was refused for.
function serverProblem(row: LinkedRepo, field: SyncField): string {
  const refusal = serverRefusal[row.id]
  if (!refusal || refusal.field !== field) return ''
  return valueOf(drafts[row.id]!, field) === refusal.value ? refusal.message : ''
}

function problemOf(row: LinkedRepo, field: SyncField): string {
  return problemsOf(drafts[row.id]!)[field] ?? serverProblem(row, field)
}

// Why the save button is off, in words. Empty when it can be pressed.
function saveReason(row: LinkedRepo): string {
  if (!canManage.value) return 'Only the project owner and the team\'s owners and admins can change these.'
  if (busyId.value === row.id) return 'Saving…'
  if (!isDirty(row.id)) return 'Nothing to save: change a setting first.'
  if (Object.keys(problemsOf(drafts[row.id]!)).length) return 'Fix the field marked in red first.'
  return ''
}

function fieldId(row: LinkedRepo, name: string) {
  return `github-${row.id}-${name}`
}

function summaryOf(row: LinkedRepo): string {
  const sync = stored[row.id]
  if (!sync) return 'Issue sync'
  return sync.enabled ? `Issue sync: on, new cards go to ${sync.column}` : 'Issue sync: off'
}

// The ignored issues in words, so the owner sees why a card did not appear.
function ignoredWords(sync: RepoSyncSettings): string {
  if (sync.ignoredCount === 0) return 'No issue has been ignored.'
  const count = sync.ignoredCount === 1 ? '1 issue was' : `${sync.ignoredCount} issues were`
  const latest = sync.lastIgnored
  const last = latest
    ? ` The last one: #${latest.number} from ${latest.login}, ${format(new Date(latest.at), 'd MMM yyyy')}, "${latest.title}".`
    : ''
  return `${count} ignored, because the people who wrote them are not on the accepted list.${last}`
}

function auditWords(line: AuditLine): string {
  return Object.entries(line.detail)
    .map(([label, change]) => change.from ? `${label}: ${change.from} to ${change.to}` : `${label}: ${change.to}`)
    .join('; ')
}

async function load(quiet = false) {
  if (!quiet) loading.value = true
  error.value = ''
  try {
    const list = await $fetch<RepoList>(`${base.value}/repos`)
    repos.value = list.repos
    defaultVisibility.value = list.defaultVisibility
    canManage.value = list.canManage
    columns.value = list.columns
    audit.value = list.audit
    if (!quiet) newVisibility.value = list.defaultVisibility
    // A form the owner is typing in is left alone; one that matches the server is refreshed.
    for (const row of list.repos) {
      const next = draftOf(row.sync, row.fullName)
      if (!drafts[row.id] || !isDirty(row.id)) drafts[row.id] = { ...next }
      stored[row.id] = next
    }
  } catch (e) {
    error.value = messageOf(e, 'Could not load the repositories')
  } finally {
    loading.value = false
  }
}

watch(() => props.projectId, () => {
  notice.value = ''
  confirmingId.value = ''
  load()
}, { immediate: true })

// Unsaved issue sync edits: a warning before leaving the page, and before any other
// navigation inside it (a tab, a section, back). Staying keeps the edit. The native dialog
// takes the keyboard. Nested components are not guarded by the route's own guards, so the
// router's global guard is used and removed again when this section unmounts.
const router = useRouter()
const anyUnsaved = () => repos.value.some(row => isDirty(row.id))
const removeLeaveGuard = router.beforeEach(() => {
  if (!anyUnsaved()) return true
  return window.confirm('You have issue sync changes that are not saved. Leave without saving?')
})
function onBeforeUnload(event: BeforeUnloadEvent) {
  if (anyUnsaved()) event.preventDefault()
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
onBeforeUnmount(() => {
  removeLeaveGuard()
  window.removeEventListener('beforeunload', onBeforeUnload)
})

async function add() {
  const repo = repoFromInput(newRepo.value)
  if (!repo) {
    error.value = 'Write the repository as owner/repo, or paste its github.com link.'
    return
  }
  adding.value = true
  error.value = ''
  notice.value = ''
  try {
    await $fetch(`${base.value}/repos`, { method: 'POST', body: { repo, visibility: newVisibility.value } })
    newRepo.value = ''
    await load(true)
    flashSaved()
  } catch (e) {
    error.value = messageOf(e, 'Could not add the repository')
  } finally {
    adding.value = false
  }
}

async function makeDefault(row: LinkedRepo) {
  busyId.value = row.id
  error.value = ''
  notice.value = ''
  try {
    await $fetch(base.value, { method: 'PUT', body: { defaultRepo: row.fullName } })
    await load(true)
    flashSaved()
  } catch (e) {
    error.value = messageOf(e, 'Could not make it the default')
  } finally {
    busyId.value = ''
  }
}

async function remove(row: LinkedRepo) {
  busyId.value = row.id
  error.value = ''
  notice.value = ''
  try {
    const result = await $fetch<{ message: string }>(`${base.value}/repos/${row.id}`, { method: 'DELETE' })
    confirmingId.value = ''
    notice.value = result.message
    await load(true)
  } catch (e) {
    error.value = messageOf(e, 'Could not remove the repository')
  } finally {
    busyId.value = ''
  }
}

async function saveDefaultVisibility() {
  error.value = ''
  try {
    const settings = await $fetch<{ defaultVisibility: Visibility }>(base.value, {
      method: 'PUT',
      body: { defaultVisibility: defaultVisibility.value }
    })
    defaultVisibility.value = settings.defaultVisibility
    flashSaved()
  } catch (e) {
    error.value = messageOf(e, 'Could not save the default visibility')
    await load(true)
  }
}

async function changeVisibility(row: LinkedRepo, event: Event) {
  const select = event.target as HTMLSelectElement
  const visibility = select.value as Visibility
  busyId.value = row.id
  error.value = ''
  notice.value = ''
  try {
    await $fetch(`${base.value}/repos/${row.id}`, { method: 'PUT', body: { visibility } })
    await load(true)
    flashSaved()
  } catch (e) {
    error.value = messageOf(e, 'Could not change the visibility')
    // Put the select back on what the server holds.
    select.value = row.visibility
    await load(true)
  } finally {
    busyId.value = ''
  }
}

async function saveSync(row: LinkedRepo) {
  if (saveReason(row)) return
  const draft = drafts[row.id]!
  busyId.value = row.id
  syncError[row.id] = ''
  serverRefusal[row.id] = undefined
  try {
    const result = await $fetch<{ sync: RepoSyncSettings }>(`${base.value}/repos/${row.id}`, {
      method: 'PUT',
      body: {
        syncEnabled: draft.enabled,
        syncColumn: draft.column,
        syncVisibility: draft.visibility,
        acceptedLogins: draft.logins,
        stagingBranches: draft.staging,
        productionBranches: draft.production,
        completeOnClose: draft.completeOnClose
      }
    })
    const next = draftOf(result.sync, row.fullName)
    stored[row.id] = next
    drafts[row.id] = { ...next }
    await load(true)
    flashSaved()
  } catch (e) {
    const refused = refusedFieldOf(e, draft)
    if (refused) serverRefusal[row.id] = refused
    else syncError[row.id] = messageOf(e, 'Could not save the issue sync settings. Nothing was changed')
  } finally {
    busyId.value = ''
  }
}
</script>

<template>
  <section
    class="mt-8"
    data-github-settings
  >
    <h2 class="text-lg font-semibold text-default">
      GitHub
    </h2>
    <p class="mt-1 text-xs text-muted">
      Issues and pull requests are linked from these repositories. A bare <code>#123</code> means issue 123 in the default one.
    </p>

    <p
      v-if="loading"
      class="mt-4 text-sm text-muted"
    >
      Loading the repositories…
    </p>

    <template v-else>
      <p
        v-if="repos.length === 0"
        class="mt-4 text-sm text-muted"
        data-github-repos-empty
      >
        No repository is linked yet. Add one below.
      </p>

      <ul
        v-else
        class="mt-4 divide-y divide-default rounded-lg border border-default"
        data-github-repos
      >
        <li
          v-for="row in repos"
          :key="row.id"
          class="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
          data-github-repo-row
          :data-github-repo-name="row.fullName"
        >
          <span class="font-medium text-default">{{ row.fullName }}</span>
          <span
            v-if="row.isDefault"
            class="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary"
            data-github-repo-default
          >Default</span>
          <select
            :value="row.visibility"
            :disabled="busyId === row.id"
            aria-label="Visibility of this repository's links"
            class="rounded-lg border border-default bg-default px-2 py-1 text-xs text-default outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-50"
            data-github-repo-visibility-change
            @change="changeVisibility(row, $event)"
          >
            <option value="internal">
              Team only
            </option>
            <option value="customer">
              Shared with customer
            </option>
          </select>

          <span class="ml-auto flex flex-wrap items-center gap-2">
            <template v-if="confirmingId === row.id">
              <span class="text-xs text-muted">
                Remove {{ row.fullName }}? Task links to it stay on their tasks.
              </span>
              <button
                type="button"
                class="rounded-lg bg-error px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                :disabled="busyId === row.id"
                data-github-remove-confirm
                @click="remove(row)"
              >
                Remove
              </button>
              <button
                type="button"
                class="rounded-lg px-2 py-1 text-xs text-muted hover:text-default"
                data-github-remove-cancel
                @click="confirmingId = ''"
              >
                Cancel
              </button>
            </template>
            <template v-else>
              <button
                v-if="!row.isDefault"
                type="button"
                class="rounded-lg border border-default px-2 py-1 text-xs text-default hover:bg-elevated disabled:opacity-50"
                :disabled="busyId === row.id"
                data-github-make-default
                @click="makeDefault(row)"
              >
                Make default
              </button>
              <button
                type="button"
                class="rounded-lg px-2 py-1 text-xs text-error hover:bg-elevated disabled:opacity-50"
                :disabled="busyId === row.id"
                data-github-remove
                @click="confirmingId = row.id"
              >
                Remove
              </button>
            </template>
          </span>

          <details
            v-if="drafts[row.id]"
            class="basis-full rounded-lg bg-elevated/40 px-3 py-2"
            :data-github-sync-panel="row.fullName"
          >
            <summary class="cursor-pointer text-sm font-medium text-default">
              {{ summaryOf(row) }}
            </summary>

            <form
              class="mt-3 grid gap-4"
              :data-github-sync-form="row.fullName"
              @submit.prevent="saveSync(row)"
            >
              <p
                v-if="!canManage"
                class="text-xs text-muted"
                data-github-sync-readonly
              >
                Only the project owner and the team's owners and admins can change these. You can read them here.
              </p>

              <label class="flex items-start gap-2 text-sm text-default">
                <input
                  v-model="drafts[row.id]!.enabled"
                  type="checkbox"
                  class="mt-0.5 size-4 rounded border-default"
                  :disabled="!canManage || busyId === row.id"
                  data-github-sync-enabled
                >
                <span>
                  Sync issues from this repository
                  <span class="block text-xs text-muted">{{ syncStatusWords(drafts[row.id]!.enabled, drafts[row.id]!.logins) }}</span>
                </span>
              </label>

              <div class="grid gap-4 sm:grid-cols-2">
                <div>
                  <label
                    class="block text-sm text-muted"
                    :for="fieldId(row, 'column')"
                  >New cards go to</label>
                  <select
                    :id="fieldId(row, 'column')"
                    v-model="drafts[row.id]!.column"
                    class="mt-1 w-full rounded-lg border border-default bg-default px-3 py-2 text-sm text-default outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-50"
                    :disabled="!canManage || busyId === row.id"
                    :aria-invalid="problemOf(row, 'column') ? 'true' : undefined"
                    :aria-describedby="problemOf(row, 'column') ? fieldId(row, 'column-error') : undefined"
                    data-github-sync-column
                  >
                    <option
                      v-for="name in columns"
                      :key="name"
                      :value="name"
                    >
                      {{ name }}
                    </option>
                    <option
                      v-if="!columns.includes(drafts[row.id]!.column)"
                      :value="drafts[row.id]!.column"
                    >
                      {{ drafts[row.id]!.column }} (not on the board)
                    </option>
                  </select>
                  <p
                    v-if="problemOf(row, 'column')"
                    :id="fieldId(row, 'column-error')"
                    class="mt-1 text-xs text-error"
                  >
                    {{ problemOf(row, 'column') }}
                  </p>
                </div>

                <div>
                  <label
                    class="block text-sm text-muted"
                    :for="fieldId(row, 'visibility')"
                  >Visibility of new cards</label>
                  <select
                    :id="fieldId(row, 'visibility')"
                    v-model="drafts[row.id]!.visibility"
                    class="mt-1 w-full rounded-lg border border-default bg-default px-3 py-2 text-sm text-default outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-50"
                    :disabled="!canManage || busyId === row.id"
                    data-github-sync-visibility
                  >
                    <option value="internal">
                      Team only
                    </option>
                    <option value="customer">
                      Shared with customer
                    </option>
                  </select>
                  <p
                    v-if="drafts[row.id]!.visibility === 'customer'"
                    class="mt-1 text-xs text-warning"
                    data-github-sync-customer-warning
                  >
                    Shared with customer: issue titles and comments from these logins reach the customer. Only accept people whose text the customer may read.
                  </p>
                </div>
              </div>

              <div>
                <label
                  class="block text-sm text-muted"
                  :for="fieldId(row, 'logins')"
                >Accepted GitHub logins</label>
                <input
                  :id="fieldId(row, 'logins')"
                  v-model="drafts[row.id]!.logins"
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="the owner's login"
                  class="mt-1 w-full rounded-lg border border-default bg-default px-3 py-2 text-sm text-default outline-none placeholder:text-dimmed focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-50"
                  :class="problemOf(row, 'logins') ? 'border-error' : ''"
                  :disabled="!canManage || busyId === row.id"
                  :aria-invalid="problemOf(row, 'logins') ? 'true' : undefined"
                  :aria-describedby="fieldId(row, 'logins-help') + (problemOf(row, 'logins') ? ' ' + fieldId(row, 'logins-error') : '')"
                  data-github-sync-logins
                >
                <p
                  :id="fieldId(row, 'logins-help')"
                  class="mt-1 text-xs text-muted"
                >
                  Separate them with commas, up to 20. Logins are saved lowercase, duplicates are removed. Issues and comments from anyone else are ignored and counted.
                </p>
                <p
                  v-if="problemOf(row, 'logins')"
                  :id="fieldId(row, 'logins-error')"
                  class="mt-1 text-xs text-error"
                  data-github-sync-logins-error
                >
                  {{ problemOf(row, 'logins') }}
                </p>
                <p
                  class="mt-1 text-xs text-muted"
                  data-github-sync-ignored
                >
                  {{ ignoredWords(row.sync) }}
                </p>
              </div>

              <div class="grid gap-4 sm:grid-cols-2">
                <div>
                  <label
                    class="block text-sm text-muted"
                    :for="fieldId(row, 'staging')"
                  >Staging branches</label>
                  <input
                    :id="fieldId(row, 'staging')"
                    v-model="drafts[row.id]!.staging"
                    type="text"
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="none yet"
                    class="mt-1 w-full rounded-lg border border-default bg-default px-3 py-2 text-sm text-default outline-none placeholder:text-dimmed focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-50"
                    :class="problemOf(row, 'staging') ? 'border-error' : ''"
                    :disabled="!canManage || busyId === row.id"
                    :aria-invalid="problemOf(row, 'staging') ? 'true' : undefined"
                    :aria-describedby="fieldId(row, 'staging-help') + (problemOf(row, 'staging') ? ' ' + fieldId(row, 'staging-error') : '')"
                    data-github-sync-staging
                  >
                  <p
                    :id="fieldId(row, 'staging-help')"
                    class="mt-1 text-xs text-muted"
                  >
                    Comma separated, up to 10 names. A pull request merged into one gets the tag 'merged staging'. Empty until there is one.
                  </p>
                  <p
                    v-if="problemOf(row, 'staging')"
                    :id="fieldId(row, 'staging-error')"
                    class="mt-1 text-xs text-error"
                  >
                    {{ problemOf(row, 'staging') }}
                  </p>
                </div>

                <div>
                  <label
                    class="block text-sm text-muted"
                    :for="fieldId(row, 'production')"
                  >Production branches</label>
                  <input
                    :id="fieldId(row, 'production')"
                    v-model="drafts[row.id]!.production"
                    type="text"
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="the repository's default branch"
                    class="mt-1 w-full rounded-lg border border-default bg-default px-3 py-2 text-sm text-default outline-none placeholder:text-dimmed focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-50"
                    :class="problemOf(row, 'production') ? 'border-error' : ''"
                    :disabled="!canManage || busyId === row.id"
                    :aria-invalid="problemOf(row, 'production') ? 'true' : undefined"
                    :aria-describedby="fieldId(row, 'production-help') + (problemOf(row, 'production') ? ' ' + fieldId(row, 'production-error') : '')"
                    data-github-sync-production
                  >
                  <p
                    :id="fieldId(row, 'production-help')"
                    class="mt-1 text-xs text-muted"
                  >
                    Comma separated, up to 10 names. Empty means the repository's default branch.
                  </p>
                  <p
                    v-if="problemOf(row, 'production')"
                    :id="fieldId(row, 'production-error')"
                    class="mt-1 text-xs text-error"
                  >
                    {{ problemOf(row, 'production') }}
                  </p>
                </div>
              </div>

              <div>
                <label class="flex items-start gap-2 text-sm text-default">
                  <input
                    v-model="drafts[row.id]!.completeOnClose"
                    type="checkbox"
                    class="mt-0.5 size-4 rounded border-default"
                    :disabled="!canManage || busyId === row.id"
                    :aria-describedby="fieldId(row, 'complete-help')"
                    data-github-sync-complete
                  >
                  <span>Complete the card when its GitHub issue closes</span>
                </label>
                <p
                  :id="fieldId(row, 'complete-help')"
                  class="ml-6 mt-1 text-xs text-muted"
                >
                  {{ drafts[row.id]!.completeOnClose
                    ? 'On: closing the GitHub issue completes the card.'
                    : 'Off: closing the GitHub issue only tags the card \'issue closed\'.' }}
                </p>
              </div>

              <div class="flex flex-wrap items-center gap-3">
                <button
                  type="submit"
                  class="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                  :disabled="!!saveReason(row)"
                  :aria-describedby="saveReason(row) ? fieldId(row, 'save-reason') : undefined"
                  data-github-sync-save
                >
                  Save issue sync settings
                </button>
                <p
                  v-if="saveReason(row)"
                  :id="fieldId(row, 'save-reason')"
                  class="text-xs text-muted"
                  data-github-sync-save-reason
                >
                  {{ saveReason(row) }}
                </p>
              </div>
              <p
                v-if="syncError[row.id]"
                role="alert"
                class="text-xs text-error"
                data-github-sync-error
              >
                {{ syncError[row.id] }}
              </p>
            </form>
          </details>
        </li>
      </ul>

      <form
        class="mt-4 grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end"
        @submit.prevent="add"
      >
        <label class="block text-sm">
          <span class="text-muted">Add a repository</span>
          <input
            v-model="newRepo"
            type="text"
            placeholder="owner/repo or a github.com link"
            :disabled="adding"
            autocomplete="off"
            class="mt-1 w-full rounded-lg border border-default bg-default px-3 py-2 text-sm text-default outline-none transition-shadow placeholder:text-dimmed focus:border-primary focus:ring-2 focus:ring-primary/20"
            data-github-repo-input
          >
        </label>
        <label class="block text-sm">
          <span class="text-muted">Visibility of its links</span>
          <select
            v-model="newVisibility"
            :disabled="adding"
            class="mt-1 w-full rounded-lg border border-default bg-default px-3 py-2 text-sm text-default outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            data-github-repo-visibility
          >
            <option value="internal">
              Team only
            </option>
            <option value="customer">
              Shared with customer
            </option>
          </select>
        </label>
        <button
          type="submit"
          class="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          :disabled="adding || !newRepo.trim()"
          data-github-add
        >
          Add repository
        </button>
      </form>
      <p
        :class="newRepo.trim() ? 'invisible' : ''"
        class="mt-2 text-xs text-muted"
        data-github-add-hint
      >
        Write the repository as owner/repo, or paste its github.com link.
      </p>

      <label class="mt-6 block max-w-xs text-sm">
        <span class="text-muted">Default visibility for new links</span>
        <select
          v-model="defaultVisibility"
          class="mt-1 w-full rounded-lg border border-default bg-default px-3 py-2 text-sm text-default outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          data-github-default-visibility
          @change="saveDefaultVisibility"
        >
          <option value="internal">
            Team only: customers do not see it
          </option>
          <option value="customer">
            Shared with customer
          </option>
        </select>
      </label>

      <section
        v-if="audit.length"
        class="mt-6"
        data-github-audit
      >
        <h3 class="text-sm font-medium text-default">
          Recent changes to these settings
        </h3>
        <ul class="mt-2 space-y-1 text-xs text-muted">
          <li
            v-for="line in audit"
            :key="line.id"
            data-github-audit-line
          >
            {{ format(new Date(line.createdAt), 'd MMM yyyy, HH:mm') }}, {{ line.userName }} changed {{ line.repo }}: {{ auditWords(line) }}
          </li>
        </ul>
      </section>
    </template>

    <p
      v-if="error"
      role="alert"
      class="mt-2 text-xs text-error"
      data-github-error
    >
      {{ error }}
    </p>
    <p
      v-if="notice"
      role="status"
      class="mt-2 text-xs text-muted"
      data-github-notice
    >
      {{ notice }}
    </p>
    <p
      class="mt-2 h-4 text-xs text-success transition-opacity"
      :class="saved ? 'opacity-100' : 'opacity-0'"
    >
      Saved
    </p>
  </section>
</template>
