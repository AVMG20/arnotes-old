<script setup lang="ts">
// The Repositories section of a project's settings: the repositories its issues and
// pull requests are linked from, which one `#123` means, and the visibility a new
// link takes. Staff only; the API refuses anyone else, and the parent only mounts
// this for staff. Uses the repos routes and the GitHub defaults route only.
const props = defineProps<{ projectId: string }>()

type Visibility = 'internal' | 'customer'

interface LinkedRepo {
  id: string
  fullName: string
  visibility: Visibility
  isDefault: boolean
}

interface RepoList {
  defaultRepo: string | null
  defaultVisibility: Visibility
  repos: LinkedRepo[]
}

const repos = ref<LinkedRepo[]>([])
const defaultVisibility = ref<Visibility>('internal')
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

async function load(quiet = false) {
  if (!quiet) loading.value = true
  error.value = ''
  try {
    const list = await $fetch<RepoList>(`${base.value}/repos`)
    repos.value = list.repos
    defaultVisibility.value = list.defaultVisibility
    if (!quiet) newVisibility.value = list.defaultVisibility
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
