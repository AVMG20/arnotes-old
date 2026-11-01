<script setup lang="ts">
import { relativeTime } from '~/composables/useRelativeTime'

// The Secrets section of a project's settings: the environment variables the project
// keeps (API keys, tokens, connection strings), who may read each one, and the trail of
// who did what. Values are encrypted on the server and only come back one at a time,
// when someone asks for one (Reveal, Copy). Staff only; the parent mounts this for team
// members. The server decides every right; this shows what it allows.
type SecretAccess = 'managers' | 'members'
type Role = 'manager' | 'member'

interface SecretRow {
  name: string
  description: string
  access: SecretAccess
  createdAt: number
  updatedAt: number
  updatedBy: { id: string, name: string } | null
}

interface SecretList {
  enabled: boolean
  reason: string | null
  role: Role | null
  archived: boolean
  secrets: SecretRow[]
}

interface SecretEvent {
  action: string
  subject: string
  via: string
  createdAt: number
  user: { id: string, name: string } | null
}

const props = defineProps<{ projectId: string }>()

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_NAME = 100
const MAX_VALUE = 16384
const MAX_DESCRIPTION = 200
// A revealed value leaves the screen by itself after this long.
const REVEAL_MS = 30_000

const EVENT_LABELS: Record<string, string> = {
  create: 'Created',
  update: 'Changed',
  delete: 'Deleted',
  reveal: 'Revealed',
  export: 'Downloaded the .env of',
  member_add: 'Added to the project',
  member_change: 'Changed the role of',
  member_remove: 'Removed from the project'
}

const status = ref<SecretList | null>(null)
const events = ref<SecretEvent[]>([])
const loading = ref(true)
const error = ref('')
const notice = ref('')
const busy = ref('')
const panel = ref<'add' | 'import' | null>(null)
const editing = ref('')
const confirmingName = ref('')
// The one value on screen, kept apart from the list, and the row whose value was just copied.
const revealed = ref<{ name: string, value: string } | null>(null)
const copiedName = ref('')
const showNewValue = ref(false)

const addForm = reactive({ name: '', value: '', description: '', access: 'managers' as SecretAccess })
const editForm = reactive({ value: '', description: '', access: 'managers' as SecretAccess })
const importText = ref('')

let hideTimer: ReturnType<typeof setTimeout> | undefined
let copiedTimer: ReturnType<typeof setTimeout> | undefined

const base = computed(() => `/api/projects/${props.projectId}`)
const secrets = computed(() => status.value?.secrets ?? [])
const archived = computed(() => status.value?.archived ?? false)
const canManage = computed(() => status.value?.role === 'manager' && !archived.value)

function messageOf(e: unknown, fallback: string) {
  const data = (e as { data?: { message?: unknown } })?.data
  return typeof data?.message === 'string' ? data.message : fallback
}

function hideValue() {
  clearTimeout(hideTimer)
  revealed.value = null
}

function say(text: string) {
  error.value = ''
  notice.value = text
}

function fail(e: unknown, fallback: string) {
  notice.value = ''
  error.value = messageOf(e, fallback)
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    status.value = await $fetch<SecretList>(`${base.value}/secrets`)
    events.value = []
    if (status.value.role === 'manager') await loadEvents()
  } catch (e) {
    fail(e, 'Could not load the secrets')
  } finally {
    loading.value = false
  }
}

async function loadEvents() {
  // Only managers may read the trail; for anyone else the request would be refused.
  if (status.value?.role !== 'manager') return
  try {
    const res = await $fetch<{ events: SecretEvent[] }>(`${base.value}/secrets/events`)
    events.value = res.events
  } catch {
    // The list above is the part that matters; the trail can be asked for again.
  }
}

// Every change ends with a fresh list, so what is on screen is what the server holds.
async function reload() {
  hideValue()
  await load()
}

watch(() => props.projectId, () => {
  hideValue()
  panel.value = null
  editing.value = ''
  confirmingName.value = ''
  notice.value = ''
  load()
}, { immediate: true })

onBeforeUnmount(() => {
  hideValue()
  clearTimeout(copiedTimer)
})

function openPanel(next: 'add' | 'import') {
  panel.value = panel.value === next ? null : next
  error.value = ''
  notice.value = ''
}

// Takes the secret's value from the server, one request each. The value is shown or
// copied, never stored with the list.
async function fetchValue(name: string) {
  return $fetch<{ name: string, value: string }>(`${base.value}/secrets/${name}/reveal`, { method: 'POST' })
}

async function reveal(row: SecretRow) {
  busy.value = row.name
  error.value = ''
  try {
    const res = await fetchValue(row.name)
    revealed.value = res
    clearTimeout(hideTimer)
    hideTimer = setTimeout(hideValue, REVEAL_MS)
    loadEvents()
  } catch (e) {
    fail(e, 'Could not reveal the secret')
  } finally {
    busy.value = ''
  }
}

async function copy(row: SecretRow) {
  busy.value = row.name
  error.value = ''
  try {
    const res = await fetchValue(row.name)
    await navigator.clipboard.writeText(res.value)
    copiedName.value = row.name
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => copiedName.value = '', 1500)
    loadEvents()
  } catch (e) {
    fail(e, 'Could not copy the secret. The browser may not allow it here.')
  } finally {
    busy.value = ''
  }
}

async function addSecret() {
  const name = addForm.name.trim()
  if (!NAME_PATTERN.test(name) || name.length > MAX_NAME) {
    error.value = 'A name uses letters, digits and underscores only, and does not start with a digit.'
    return
  }
  busy.value = 'add'
  error.value = ''
  notice.value = ''
  try {
    await $fetch(`${base.value}/secrets`, {
      method: 'POST',
      headers: realtimeHeaders(),
      body: { name, value: addForm.value, description: addForm.description.trim(), access: addForm.access }
    })
    addForm.name = ''
    addForm.value = ''
    addForm.description = ''
    addForm.access = 'managers'
    showNewValue.value = false
    panel.value = null
    say(`${name} is saved.`)
    await reload()
  } catch (e) {
    fail(e, 'Could not add the secret')
  } finally {
    busy.value = ''
  }
}

function startEdit(row: SecretRow) {
  editing.value = row.name
  confirmingName.value = ''
  editForm.value = ''
  editForm.description = row.description
  editForm.access = row.access
  error.value = ''
  notice.value = ''
}

// A blank value means "keep the one stored"; the value field is never filled in.
async function saveEdit(row: SecretRow) {
  busy.value = row.name
  error.value = ''
  try {
    const body: { description: string, access: SecretAccess, value?: string } = {
      description: editForm.description.trim(),
      access: editForm.access
    }
    if (editForm.value !== '') body.value = editForm.value
    await $fetch(`${base.value}/secrets/${row.name}`, { method: 'PUT', headers: realtimeHeaders(), body })
    editing.value = ''
    editForm.value = ''
    say(`${row.name} is saved.`)
    await reload()
  } catch (e) {
    fail(e, 'Could not save the secret')
  } finally {
    busy.value = ''
  }
}

// Deleting asks twice: the first press turns the button into "Delete?".
async function removeSecret(row: SecretRow) {
  if (confirmingName.value !== row.name) {
    confirmingName.value = row.name
    return
  }
  busy.value = row.name
  error.value = ''
  try {
    await $fetch(`${base.value}/secrets/${row.name}`, { method: 'DELETE', headers: realtimeHeaders() })
    confirmingName.value = ''
    say(`${row.name} is deleted.`)
    await reload()
  } catch (e) {
    fail(e, 'Could not delete the secret')
  } finally {
    busy.value = ''
  }
}

// Reads the lines of a .env file: NAME=value, `export NAME=value`, # comments, and quoted
// values ('...' literal, "..." with \" \\ \n \t \$). A " #" after an unquoted value starts a comment.
function unquote(raw: string): string {
  const value = raw.trim()
  const quote = value[0]
  if ((quote === '"' || quote === '\'') && value.length >= 2 && value.endsWith(quote)) {
    const inner = value.slice(1, -1)
    if (quote === '\'') return inner
    return inner.replace(/\\(["\\nt$])/g, (_, char: string) => char === 'n' ? '\n' : char === 't' ? '\t' : char)
  }
  return value.replace(/\s+#.*$/, '')
}

function parseEnv(text: string): { entries: { name: string, value: string }[], skipped: number } {
  const entries: { name: string, value: string }[] = []
  let skipped = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([^=\s]+)\s*=(.*)$/.exec(line)
    if (!match || !NAME_PATTERN.test(match[1]!)) {
      skipped++
      continue
    }
    entries.push({ name: match[1]!, value: unquote(match[2]!) })
  }
  return { entries, skipped }
}

// Each name that exists gets its value replaced; the others are added. The last of a
// name written twice wins.
async function importEnv() {
  const { entries, skipped } = parseEnv(importText.value)
  if (!entries.length) {
    error.value = 'No NAME=value lines were found in the text.'
    return
  }
  busy.value = 'import'
  error.value = ''
  notice.value = ''
  const known = new Set(secrets.value.map(row => row.name))
  let added = 0
  let updated = 0
  try {
    for (const entry of entries) {
      if (known.has(entry.name)) {
        await $fetch(`${base.value}/secrets/${entry.name}`, { method: 'PUT', headers: realtimeHeaders(), body: { value: entry.value } })
        updated++
      } else {
        await $fetch(`${base.value}/secrets`, { method: 'POST', headers: realtimeHeaders(), body: { name: entry.name, value: entry.value } })
        known.add(entry.name)
        added++
      }
    }
    importText.value = ''
    panel.value = null
    const lines = skipped ? `, and skipped ${skipped} ${skipped === 1 ? 'line' : 'lines'} that were not NAME=value` : ''
    say(`Imported: ${added} added, ${updated} updated${lines}.`)
  } catch (e) {
    fail(e, `Could not import all of it. ${added} added and ${updated} updated before that.`)
  } finally {
    busy.value = ''
    await reload()
  }
}

async function downloadEnv() {
  busy.value = 'download'
  error.value = ''
  try {
    const text = await $fetch<string>(`${base.value}/secrets/export`, {
      method: 'POST', headers: realtimeHeaders(), body: {}, responseType: 'text'
    })
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    const link = document.createElement('a')
    link.href = url
    link.download = '.env'
    link.click()
    URL.revokeObjectURL(url)
    loadEvents()
  } catch (e) {
    fail(e, 'Could not download the .env file')
  } finally {
    busy.value = ''
  }
}

function eventText(event: SecretEvent): string {
  return `${EVENT_LABELS[event.action] ?? event.action} ${event.subject}`.trim()
}
</script>

<template>
  <section
    class="space-y-4"
    data-secrets-settings
  >
    <p
      v-if="loading && !status"
      class="text-sm text-dimmed"
    >
      Loading the secrets...
    </p>

    <p
      v-else-if="error && !status"
      class="text-sm text-error"
      role="alert"
      data-secrets-error
    >
      {{ error }}
    </p>

    <template v-else-if="status">
      <div
        v-if="!status.enabled"
        class="rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm"
        role="status"
        data-secrets-disabled
      >
        <p class="font-medium text-default">
          Secrets are off on this server.
        </p>
        <p class="mt-1 text-muted">
          {{ status.reason || 'The server has no encryption key for secrets.' }}
        </p>
      </div>

      <template v-else>
        <p
          v-if="!status.role"
          class="rounded-xl border border-default bg-default p-3 text-sm text-muted"
          data-secrets-none
        >
          You cannot see this project's secrets. A manager of the project can add you under Members.
        </p>

        <template v-else>
          <div class="flex flex-wrap items-start gap-3">
            <p class="min-w-0 flex-1 text-xs text-muted">
              <template v-if="canManage">
                Values are encrypted and never shown in this list. Managers see every secret, members only those shared with them. The downloaded .env is written for shells and Docker Compose. Other tools, such as the Node dotenv package, may read values that contain a backslash or a dollar sign differently.
              </template>
              <template v-else-if="archived">
                This project is archived, so its secrets are read-only.
              </template>
              <template v-else>
                You see the secrets the project's managers shared with members. The managers decide what is shared.
              </template>
            </p>
            <div
              v-if="canManage"
              class="flex w-full flex-wrap items-start gap-2 sm:w-auto sm:shrink-0"
            >
              <button
                type="button"
                class="rounded-lg border border-default px-2.5 py-1.5 text-xs text-default hover:bg-elevated disabled:opacity-50"
                :aria-expanded="panel === 'import'"
                data-secret-import-toggle
                @click="openPanel('import')"
              >
                Import .env
              </button>
              <div class="flex max-w-[9rem] flex-col items-end gap-1">
                <button
                  type="button"
                  class="rounded-lg border border-default px-2.5 py-1.5 text-xs text-default hover:bg-elevated disabled:opacity-50"
                  :disabled="busy === 'download' || !secrets.length"
                  data-secret-download
                  @click="downloadEnv"
                >
                  Download .env
                </button>
                <p
                  v-if="!secrets.length"
                  class="text-right text-xs text-muted"
                  data-secret-download-hint
                >
                  Nothing to download yet. Add a secret first.
                </p>
              </div>
              <button
                type="button"
                class="rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                :aria-expanded="panel === 'add'"
                data-secret-add-toggle
                @click="openPanel('add')"
              >
                Add secret
              </button>
            </div>
          </div>

          <form
            v-if="panel === 'add' && canManage"
            class="grid gap-3 rounded-xl border border-default bg-default p-3 sm:grid-cols-2"
            data-secret-add-form
            @submit.prevent="addSecret"
          >
            <label class="block text-sm">
              <span class="text-muted">Name</span>
              <input
                v-model="addForm.name"
                type="text"
                :maxlength="MAX_NAME"
                placeholder="STRIPE_KEY"
                autocomplete="off"
                spellcheck="false"
                :disabled="busy === 'add'"
                class="mt-1 w-full rounded-lg border border-default bg-default px-3 py-2 font-mono text-sm text-default outline-none placeholder:text-dimmed focus:border-primary focus:ring-2 focus:ring-primary/20"
                data-secret-name-input
              >
            </label>
            <label class="block text-sm">
              <span class="text-muted">Value</span>
              <span class="mt-1 flex gap-2">
                <input
                  v-model="addForm.value"
                  :type="showNewValue ? 'text' : 'password'"
                  :maxlength="MAX_VALUE"
                  autocomplete="new-password"
                  spellcheck="false"
                  :disabled="busy === 'add'"
                  class="min-w-0 flex-1 rounded-lg border border-default bg-default px-3 py-2 font-mono text-sm text-default outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                  data-secret-value-input
                >
                <button
                  type="button"
                  class="shrink-0 rounded-lg border border-default px-2.5 text-xs text-muted hover:text-default"
                  :aria-pressed="showNewValue"
                  data-secret-value-toggle
                  @click="showNewValue = !showNewValue"
                >
                  {{ showNewValue ? 'Hide' : 'Show' }}
                </button>
              </span>
            </label>
            <label class="block text-sm">
              <span class="text-muted">What it is for (optional)</span>
              <input
                v-model="addForm.description"
                type="text"
                :maxlength="MAX_DESCRIPTION"
                :disabled="busy === 'add'"
                class="mt-1 w-full rounded-lg border border-default bg-default px-3 py-2 text-sm text-default outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                data-secret-description-input
              >
            </label>
            <label class="block text-sm">
              <span class="text-muted">Who can see it</span>
              <select
                v-model="addForm.access"
                :disabled="busy === 'add'"
                class="mt-1 w-full rounded-lg border border-default bg-default px-3 py-2 text-sm text-default outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                data-secret-access-input
              >
                <option value="managers">
                  Managers only
                </option>
                <option value="members">
                  All members
                </option>
              </select>
            </label>
            <div class="flex justify-end gap-2 sm:col-span-2">
              <p
                :class="addForm.name.trim() ? 'invisible' : ''"
                class="self-center text-xs text-muted"
                data-secret-add-hint
              >
                Type a name to save the secret.
              </p>
              <button
                type="button"
                class="rounded-lg px-3 py-2 text-sm text-muted hover:text-default"
                @click="panel = null"
              >
                Cancel
              </button>
              <button
                type="submit"
                class="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                :disabled="busy === 'add' || !addForm.name.trim()"
                data-secret-add
              >
                Save secret
              </button>
            </div>
          </form>

          <form
            v-if="panel === 'import' && canManage"
            class="space-y-3 rounded-xl border border-default bg-default p-3"
            data-secret-import-form
            @submit.prevent="importEnv"
          >
            <label class="block text-sm">
              <span class="text-muted">Paste the contents of a .env file</span>
              <textarea
                v-model="importText"
                rows="6"
                spellcheck="false"
                placeholder="STRIPE_KEY=sk_test_...&#10;DATABASE_URL=postgres://..."
                :disabled="busy === 'import'"
                class="mt-1 w-full rounded-lg border border-default bg-default px-3 py-2 font-mono text-xs text-default outline-none placeholder:text-dimmed focus:border-primary focus:ring-2 focus:ring-primary/20"
                data-secret-import-text
              />
            </label>
            <p class="text-xs text-dimmed">
              Names that already exist get their value replaced. The new ones are added as managers only; change them below.
            </p>
            <div class="flex justify-end gap-2">
              <button
                type="button"
                class="rounded-lg px-3 py-2 text-sm text-muted hover:text-default"
                @click="panel = null"
              >
                Cancel
              </button>
              <button
                type="submit"
                class="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                :disabled="busy === 'import' || !importText.trim()"
                data-secret-import-apply
              >
                Import
              </button>
            </div>
          </form>

          <p
            v-if="!secrets.length"
            class="text-sm text-muted"
            data-secret-empty
          >
            <template v-if="canManage">
              No secrets yet. Add one, or import a .env file.
            </template>
            <template v-else>
              No secret has been shared with members yet.
            </template>
          </p>

          <ul
            v-else
            class="divide-y divide-default overflow-hidden rounded-xl border border-default bg-default text-sm"
            data-secret-list
          >
            <li
              v-for="row in secrets"
              :key="row.name"
              class="space-y-2 px-3 py-2.5"
              data-secret-row
              :data-secret-name="row.name"
              :data-secret-access="row.access"
            >
              <div class="flex flex-wrap items-start gap-x-3 gap-y-2">
                <div class="min-w-0 flex-1">
                  <p
                    class="break-all font-mono text-sm font-medium text-default"
                    data-secret-name-label
                  >
                    {{ row.name }}
                  </p>
                  <p
                    v-if="row.description"
                    class="mt-0.5 text-xs text-muted"
                  >
                    {{ row.description }}
                  </p>
                  <p class="mt-0.5 text-xs text-dimmed">
                    Updated {{ relativeTime(row.updatedAt) }}
                    <template v-if="row.updatedBy">
                      by {{ row.updatedBy.name }}
                    </template>
                  </p>
                </div>

                <span
                  class="shrink-0 rounded-full px-2 py-0.5 text-xs"
                  :class="row.access === 'managers' ? 'bg-elevated text-default' : 'bg-primary/10 text-primary'"
                  data-secret-access-badge
                >
                  {{ row.access === 'managers' ? 'Managers only' : 'All members' }}
                </span>

                <div class="flex shrink-0 flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    class="rounded-lg border border-default px-2 py-1 text-xs text-default hover:bg-elevated disabled:opacity-50"
                    :disabled="busy === row.name"
                    data-secret-reveal
                    @click="revealed?.name === row.name ? hideValue() : reveal(row)"
                  >
                    {{ revealed?.name === row.name ? 'Hide' : 'Reveal' }}
                  </button>
                  <button
                    type="button"
                    class="rounded-lg border border-default px-2 py-1 text-xs text-default hover:bg-elevated disabled:opacity-50"
                    :disabled="busy === row.name"
                    data-secret-copy
                    @click="copy(row)"
                  >
                    {{ copiedName === row.name ? 'Copied' : 'Copy' }}
                  </button>
                  <template v-if="canManage">
                    <button
                      type="button"
                      class="rounded-lg px-2 py-1 text-xs text-default hover:bg-elevated disabled:opacity-50"
                      :disabled="busy === row.name || editing === row.name"
                      data-secret-edit
                      @click="startEdit(row)"
                    >
                      Edit
                    </button>
                    <button
                      v-if="confirmingName !== row.name"
                      type="button"
                      class="rounded-lg px-2 py-1 text-xs text-error hover:bg-elevated disabled:opacity-50"
                      :disabled="busy === row.name"
                      data-secret-delete
                      @click="removeSecret(row)"
                    >
                      Delete
                    </button>
                    <template v-else>
                      <button
                        type="button"
                        class="rounded-lg bg-error px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                        :disabled="busy === row.name"
                        data-secret-delete-confirm
                        @click="removeSecret(row)"
                      >
                        Delete {{ row.name }}?
                      </button>
                      <button
                        type="button"
                        class="rounded-lg px-2 py-1 text-xs text-muted hover:text-default"
                        data-secret-delete-cancel
                        @click="confirmingName = ''"
                      >
                        Cancel
                      </button>
                    </template>
                  </template>
                </div>
              </div>

              <p
                v-if="revealed && revealed.name === row.name"
                class="flex flex-wrap items-center gap-2 rounded-lg bg-elevated px-3 py-2"
                data-secret-revealed
              >
                <code class="min-w-0 flex-1 break-all font-mono text-xs text-default">{{ revealed.value || '(empty)' }}</code>
                <button
                  type="button"
                  class="shrink-0 text-xs text-muted hover:text-default"
                  data-secret-hide
                  @click="hideValue"
                >
                  Hide
                </button>
              </p>

              <form
                v-if="canManage && editing === row.name"
                class="grid gap-3 rounded-lg border border-default p-3 sm:grid-cols-2"
                data-secret-edit-form
                @submit.prevent="saveEdit(row)"
              >
                <label class="block text-sm sm:col-span-2">
                  <span class="text-muted">New value</span>
                  <input
                    v-model="editForm.value"
                    type="password"
                    :maxlength="MAX_VALUE"
                    autocomplete="new-password"
                    spellcheck="false"
                    placeholder="Leave blank to keep the current value"
                    :disabled="busy === row.name"
                    class="mt-1 w-full rounded-lg border border-default bg-default px-3 py-2 font-mono text-sm text-default outline-none placeholder:text-dimmed focus:border-primary focus:ring-2 focus:ring-primary/20"
                    data-secret-edit-value
                  >
                </label>
                <label class="block text-sm">
                  <span class="text-muted">What it is for</span>
                  <input
                    v-model="editForm.description"
                    type="text"
                    :maxlength="MAX_DESCRIPTION"
                    :disabled="busy === row.name"
                    class="mt-1 w-full rounded-lg border border-default bg-default px-3 py-2 text-sm text-default outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                    data-secret-edit-description
                  >
                </label>
                <label class="block text-sm">
                  <span class="text-muted">Who can see it</span>
                  <select
                    v-model="editForm.access"
                    :disabled="busy === row.name"
                    class="mt-1 w-full rounded-lg border border-default bg-default px-3 py-2 text-sm text-default outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                    data-secret-edit-access
                  >
                    <option value="managers">
                      Managers only
                    </option>
                    <option value="members">
                      All members
                    </option>
                  </select>
                </label>
                <div class="flex justify-end gap-2 sm:col-span-2">
                  <button
                    type="button"
                    class="rounded-lg px-3 py-2 text-sm text-muted hover:text-default"
                    data-secret-edit-cancel
                    @click="editing = ''"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    class="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                    :disabled="busy === row.name"
                    data-secret-edit-save
                  >
                    Save
                  </button>
                </div>
              </form>
            </li>
          </ul>

          <section
            v-if="canManage"
            class="pt-2"
            data-secret-events
          >
            <h3 class="text-sm font-medium text-default">
              Activity
            </h3>
            <p class="mt-0.5 text-xs text-muted">
              Who created, changed, deleted, revealed or downloaded what. Values never appear here.
            </p>
            <p
              v-if="!events.length"
              class="mt-2 text-xs text-dimmed"
            >
              Nothing yet.
            </p>
            <ul
              v-else
              class="mt-2 divide-y divide-default rounded-xl border border-default bg-default text-xs"
            >
              <li
                v-for="(event, index) in events"
                :key="index"
                class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2"
                data-secret-event
              >
                <span class="min-w-0 break-all text-default">
                  {{ event.user?.name || 'Someone' }} {{ eventText(event) }}
                </span>
                <span
                  v-if="event.via === 'mcp'"
                  class="rounded-full bg-elevated px-1.5 text-[10px] text-muted"
                >
                  agent
                </span>
                <span class="ml-auto shrink-0 text-dimmed">{{ relativeTime(event.createdAt) }}</span>
              </li>
            </ul>
          </section>
        </template>
      </template>
    </template>

    <p
      v-if="error && status"
      role="alert"
      class="text-xs text-error"
      data-secrets-error
    >
      {{ error }}
    </p>
    <p
      v-if="notice"
      role="status"
      class="text-xs text-muted"
      data-secrets-notice
    >
      {{ notice }}
    </p>
  </section>
</template>
