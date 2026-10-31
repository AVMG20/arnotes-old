<script setup lang="ts">
// The Members section of a project's settings: who is on the project and in what
// vault role. Managers see the secrets and may change who is on the project; everyone
// else on the project sees this list read-only. The server decides every role; this
// only shows it and sends the changes. Staff only, the parent mounts it for team members.
type VaultRole = 'manager' | 'member'

interface ProjectPerson {
  id: string
  name: string
  email: string
  image: string | null
  teamRole: 'owner' | 'admin' | 'member'
  isProjectOwner: boolean
  role: VaultRole | null
  // True when the role comes from a project_members row, so it can be changed or removed.
  explicit: boolean
}

interface MembersResponse {
  canManage: boolean
  personal: boolean
  role: VaultRole | null
  people: ProjectPerson[]
}

const props = defineProps<{ projectId: string }>()

const people = ref<ProjectPerson[]>([])
const canManage = ref(false)
const loading = ref(true)
const error = ref('')
const notice = ref('')
const saved = ref(false)
// The row being changed, the row waiting for its removal to be confirmed, and the new-member form.
const busyId = ref('')
const confirmingId = ref('')
const newUserId = ref('')
const newRole = ref<VaultRole>('member')
const adding = ref(false)

let savedTimer: ReturnType<typeof setTimeout> | undefined

const base = computed(() => `/api/projects/${props.projectId}/members`)
// A personal project has no team, so it has nobody to add.
const personal = ref(false)
// Team members who are not on the project yet, in the order the server lists them.
const candidates = computed(() => people.value.filter(person => person.role === null))

const ROLE_LABELS: Record<VaultRole, string> = { manager: 'Manager', member: 'Member' }

// The badge says what a person may do; the line under the name says why.
function badgeOf(person: ProjectPerson): { label: string, classes: string } {
  if (person.isProjectOwner) return { label: 'Owner', classes: 'bg-primary/10 text-primary' }
  if (person.role === 'manager' && !person.explicit) return { label: 'Team admin', classes: 'bg-elevated text-default' }
  if (person.role === 'manager') return { label: 'Manager', classes: 'bg-primary/10 text-primary' }
  if (person.role === 'member') return { label: 'Member', classes: 'bg-elevated text-default' }
  return { label: 'No access', classes: 'bg-elevated text-dimmed' }
}

function sourceOf(person: ProjectPerson): string {
  if (person.isProjectOwner) return 'Project owner'
  if (person.role === 'manager' && !person.explicit) return `Team ${person.teamRole}`
  if (person.explicit) return 'Added to the project'
  if (person.role === 'member') return 'Member of the team'
  return 'Not on the project'
}

function messageOf(e: unknown, fallback: string) {
  const data = (e as { data?: { message?: unknown } })?.data
  return typeof data?.message === 'string' ? data.message : fallback
}

function flashSaved() {
  saved.value = true
  clearTimeout(savedTimer)
  savedTimer = setTimeout(() => saved.value = false, 1500)
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await $fetch<MembersResponse>(base.value)
    people.value = res.people
    canManage.value = res.canManage
    personal.value = res.personal
  } catch (e) {
    error.value = messageOf(e, 'Could not load the members')
  } finally {
    loading.value = false
  }
}

watch(() => props.projectId, () => {
  notice.value = ''
  confirmingId.value = ''
  newUserId.value = ''
  load()
}, { immediate: true })

// The server answers with the person's updated row; the list takes that row in place.
function replaceRow(row: ProjectPerson) {
  people.value = people.value.map(person => person.id === row.id ? row : person)
}

async function add() {
  if (!newUserId.value) return
  adding.value = true
  error.value = ''
  notice.value = ''
  try {
    const row = await $fetch<ProjectPerson>(base.value, {
      method: 'POST', headers: realtimeHeaders(), body: { userId: newUserId.value, role: newRole.value }
    })
    replaceRow(row)
    newUserId.value = ''
    newRole.value = 'member'
    flashSaved()
  } catch (e) {
    error.value = messageOf(e, 'Could not add the member')
    await load()
  } finally {
    adding.value = false
  }
}

async function changeRole(person: ProjectPerson, event: Event) {
  const select = event.target as HTMLSelectElement
  const role = select.value as VaultRole
  busyId.value = person.id
  error.value = ''
  notice.value = ''
  try {
    const row = await $fetch<ProjectPerson>(`${base.value}/${person.id}`, {
      method: 'PUT', headers: realtimeHeaders(), body: { role }
    })
    replaceRow(row)
    flashSaved()
  } catch (e) {
    error.value = messageOf(e, 'Could not change the role')
    // Put the select back on what the server holds.
    select.value = person.role ?? ''
    await load()
  } finally {
    busyId.value = ''
  }
}

async function remove(person: ProjectPerson) {
  busyId.value = person.id
  error.value = ''
  notice.value = ''
  try {
    await $fetch(`${base.value}/${person.id}`, { method: 'DELETE', headers: realtimeHeaders() })
    confirmingId.value = ''
    notice.value = `${person.name || person.email} is no longer on the project.`
    await load()
  } catch (e) {
    error.value = messageOf(e, 'Could not remove the member')
  } finally {
    busyId.value = ''
  }
}
</script>

<template>
  <section
    class="space-y-4"
    data-members-settings
  >
    <p class="text-xs text-muted">
      Everyone on the team sees the board. Managers see and change the project's secrets and decide who is on the project.
      The project owner and the team's owners and admins are managers.
    </p>

    <p
      v-if="loading"
      class="text-sm text-dimmed"
    >
      Loading the members...
    </p>

    <p
      v-else-if="personal"
      class="rounded-xl border border-default bg-default p-3 text-sm text-muted"
      data-members-personal
    >
      This is a personal project, so only its owner is on it. To share it, move it to a team project.
    </p>

    <template v-else-if="people.length">
      <ul
        class="divide-y divide-default overflow-hidden rounded-xl border border-default bg-default text-sm"
        data-members-list
      >
        <li
          v-for="person in people"
          :key="person.id"
          class="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5"
          data-member-row
          :data-member-name="person.name || person.email"
          :data-member-role="person.role ?? 'none'"
        >
          <div class="flex min-w-0 flex-1 items-center gap-2.5">
            <UAvatar
              :src="person.image || undefined"
              :alt="person.name || person.email"
              size="xs"
            />
            <div class="min-w-0">
              <p class="truncate font-medium text-default">
                {{ person.name || person.email }}
              </p>
              <p class="truncate text-xs text-dimmed">
                {{ sourceOf(person) }}
              </p>
            </div>
          </div>

          <div class="ml-auto flex flex-wrap items-center gap-2">
            <span
              class="rounded-full px-2 py-0.5 text-xs"
              :class="badgeOf(person).classes"
              data-member-badge
            >
              {{ badgeOf(person).label }}
            </span>

            <template v-if="canManage && person.explicit">
              <select
                :value="person.role ?? ''"
                :disabled="busyId === person.id || confirmingId === person.id"
                class="rounded-lg border border-default bg-default px-2 py-1 text-xs text-default outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-50"
                :aria-label="`Role of ${person.name || person.email}`"
                data-member-role-change
                @change="changeRole(person, $event)"
              >
                <option value="manager">
                  {{ ROLE_LABELS.manager }}
                </option>
                <option value="member">
                  {{ ROLE_LABELS.member }}
                </option>
              </select>

              <template v-if="confirmingId === person.id">
                <button
                  type="button"
                  class="rounded-lg bg-error px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                  :disabled="busyId === person.id"
                  data-member-remove-confirm
                  @click="remove(person)"
                >
                  Remove?
                </button>
                <button
                  type="button"
                  class="rounded-lg px-2 py-1 text-xs text-muted hover:text-default"
                  data-member-remove-cancel
                  @click="confirmingId = ''"
                >
                  Cancel
                </button>
              </template>
              <button
                v-else
                type="button"
                class="rounded-lg px-2 py-1 text-xs text-error hover:bg-elevated disabled:opacity-50"
                :disabled="busyId === person.id"
                data-member-remove
                @click="confirmingId = person.id"
              >
                Remove
              </button>
            </template>
          </div>
        </li>
      </ul>

      <form
        v-if="canManage && candidates.length"
        class="grid gap-3 rounded-xl border border-default bg-default p-3 sm:grid-cols-[1fr_auto_auto] sm:items-end"
        data-member-add-form
        @submit.prevent="add"
      >
        <label class="block text-sm">
          <span class="text-muted">Add a team member</span>
          <select
            v-model="newUserId"
            :disabled="adding"
            class="mt-1 w-full rounded-lg border border-default bg-default px-3 py-2 text-sm text-default outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            data-member-add-user
          >
            <option value="">
              Choose a person
            </option>
            <option
              v-for="person in candidates"
              :key="person.id"
              :value="person.id"
            >
              {{ person.name || person.email }}
            </option>
          </select>
        </label>
        <label class="block text-sm">
          <span class="text-muted">Role</span>
          <select
            v-model="newRole"
            :disabled="adding"
            class="mt-1 w-full rounded-lg border border-default bg-default px-3 py-2 text-sm text-default outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            data-member-add-role
          >
            <option value="member">
              Member: sees the shared secrets
            </option>
            <option value="manager">
              Manager: sees and changes every secret
            </option>
          </select>
        </label>
        <button
          type="submit"
          class="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          :disabled="adding || !newUserId"
          data-member-add
        >
          Add
        </button>
      </form>
    </template>

    <p
      v-else-if="!error"
      class="text-sm text-muted"
      data-members-empty
    >
      Nobody is on the project yet.
    </p>

    <p
      v-if="!canManage && !loading && !error && !personal"
      class="text-xs text-dimmed"
      data-members-readonly
    >
      Only a manager can change who is on the project.
    </p>

    <p
      v-if="error"
      role="alert"
      class="text-xs text-error"
      data-members-error
    >
      {{ error }}
    </p>
    <p
      v-if="notice"
      role="status"
      class="text-xs text-muted"
      data-members-notice
    >
      {{ notice }}
    </p>
    <p
      class="h-4 text-xs text-success transition-opacity"
      :class="saved ? 'opacity-100' : 'opacity-0'"
    >
      Saved
    </p>
  </section>
</template>
