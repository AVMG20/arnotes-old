<script setup lang="ts">
import type { CustomerContact, CustomerInvitation } from '~/composables/useCustomers'

const open = defineModel<boolean>('open', { default: false })

const { activeTeam } = useTeams()
const {
  customers,
  canManageCustomers,
  refresh,
  createCustomer,
  renameCustomer,
  deleteCustomer,
  loadContacts,
  createInvitation,
  revokeInvitation,
  removeContact
} = useCustomers()
const { refresh: refreshProjects } = useProjects()
const toast = useToast()

function fail(e: unknown, fallback: string) {
  toast.add({
    title: (e as { data?: { message?: string } })?.data?.message || fallback,
    icon: 'i-lucide-alert-triangle',
    color: 'error'
  })
}

watch(open, (isOpen) => {
  if (isOpen) refresh().catch(e => fail(e, 'Could not load customers'))
  else expandedId.value = null
})

// ─── New customer ────────────────────────────────────────────

const newName = ref('')
const creating = ref(false)

async function handleCreate() {
  const name = newName.value.trim()
  if (!name) return
  creating.value = true
  try {
    const customer = await createCustomer(name)
    newName.value = ''
    await toggle(customer.id)
  } catch (e) {
    fail(e, 'Could not add the customer')
  } finally {
    creating.value = false
  }
}

// ─── Rename ──────────────────────────────────────────────────

const editingId = ref<string | null>(null)
const editName = ref('')

function startRename(id: string, name: string) {
  editingId.value = id
  editName.value = name
}

async function handleRename() {
  const id = editingId.value
  const name = editName.value.trim()
  if (!id || !name) return
  try {
    await renameCustomer(id, name)
    editingId.value = null
    // Project lists show the customer's name.
    await refreshProjects()
  } catch (e) {
    fail(e, 'Could not rename the customer')
  }
}

// ─── One customer's contacts and links ───────────────────────

const expandedId = ref<string | null>(null)
const contacts = ref<CustomerContact[]>([])
const invitations = ref<CustomerInvitation[]>([])
const detailLoading = ref(false)
const inviteLabel = ref('')
const inviting = ref(false)
// The link exists in full only in the response that created it.
const freshLink = ref<{ customerId: string, url: string } | null>(null)
const copied = ref(false)

async function loadDetail(id: string) {
  detailLoading.value = true
  try {
    const res = await loadContacts(id)
    contacts.value = res.contacts
    invitations.value = res.invitations
  } catch (e) {
    fail(e, 'Could not load contacts')
  } finally {
    detailLoading.value = false
  }
}

async function toggle(id: string) {
  if (expandedId.value === id) {
    expandedId.value = null
    return
  }
  expandedId.value = id
  inviteLabel.value = ''
  freshLink.value = null
  contacts.value = []
  invitations.value = []
  await loadDetail(id)
}

async function handleInvite(customerId: string) {
  inviting.value = true
  try {
    const res = await createInvitation(customerId, inviteLabel.value.trim())
    freshLink.value = { customerId, url: res.url }
    inviteLabel.value = ''
    copied.value = false
    invitations.value = [res, ...invitations.value]
  } catch (e) {
    fail(e, 'Could not create an invitation link')
  } finally {
    inviting.value = false
  }
}

async function copyLink() {
  if (!freshLink.value) return
  try {
    await navigator.clipboard.writeText(freshLink.value.url)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch {
    toast.add({ title: 'Select and copy the link manually', icon: 'i-lucide-alert-triangle', color: 'error' })
  }
}

function formatDate(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

// ─── Confirmation ────────────────────────────────────────────

interface ConfirmRequest {
  title: string
  description: string
  confirmLabel: string
  action: () => Promise<unknown>
}

const confirmRequest = ref<ConfirmRequest | null>(null)
const confirmLoading = ref(false)
const isConfirmOpen = computed({
  get: () => confirmRequest.value !== null,
  set: (val) => { if (!val) confirmRequest.value = null }
})

async function handleConfirm() {
  if (!confirmRequest.value) return
  confirmLoading.value = true
  try {
    await confirmRequest.value.action()
    confirmRequest.value = null
  } catch (e) {
    fail(e, 'Something went wrong')
  } finally {
    confirmLoading.value = false
  }
}

function confirmDelete(id: string, name: string) {
  confirmRequest.value = {
    title: `Remove ${name}?`,
    description: 'Its projects stay in the team as team-only projects. Its contacts lose access and open invitation links stop working.',
    confirmLabel: 'Remove customer',
    action: async () => {
      await deleteCustomer(id)
      if (expandedId.value === id) expandedId.value = null
      await refreshProjects()
    }
  }
}

function confirmRemoveContact(customerId: string, contact: CustomerContact) {
  confirmRequest.value = {
    title: `Remove ${contact.name || contact.email}?`,
    description: 'They keep their account but no longer see this customer\'s projects.',
    confirmLabel: 'Remove contact',
    action: async () => {
      await removeContact(customerId, contact.userId)
      contacts.value = contacts.value.filter(c => c.userId !== contact.userId)
    }
  }
}

function confirmRevoke(customerId: string, invitation: CustomerInvitation) {
  confirmRequest.value = {
    title: 'Revoke this invitation link?',
    description: 'Anyone holding the link can no longer use it.',
    confirmLabel: 'Revoke',
    action: async () => {
      await revokeInvitation(customerId, invitation.id)
      invitations.value = invitations.value.filter(i => i.id !== invitation.id)
      if (freshLink.value?.customerId === customerId) freshLink.value = null
    }
  }
}
</script>

<template>
  <div>
    <UModal
      v-model:open="open"
      :title="activeTeam ? `Customers of ${activeTeam.name}` : 'Customers'"
      description="Customers group projects and log in to follow them. They see only the tasks you share with them."
      :ui="{ content: 'sm:max-w-2xl' }"
    >
      <template #body>
        <div class="space-y-4 text-sm">
          <form
            v-if="canManageCustomers"
            class="flex items-center gap-2"
            @submit.prevent="handleCreate"
          >
            <UInput
              v-model="newName"
              placeholder="New customer name"
              class="flex-1"
            />
            <UButton
              type="submit"
              icon="i-lucide-plus"
              :loading="creating"
              :disabled="!newName.trim()"
            >
              Add customer
            </UButton>
          </form>
          <p class="min-h-4 text-xs text-muted">
            {{ canManageCustomers ? '' : 'Only team owners and admins add customers and send links. Ask a team admin if you need one.' }}
          </p>

          <p
            v-if="customers.length === 0"
            class="py-6 text-center text-xs text-muted"
          >
            No customers yet.
          </p>

          <div
            v-else
            class="divide-y divide-default rounded-xl border border-default overflow-hidden"
          >
            <div
              v-for="c in customers"
              :key="c.id"
            >
              <div class="flex items-center gap-2 px-3 py-2.5">
                <form
                  v-if="editingId === c.id"
                  class="flex flex-1 items-center gap-2"
                  @submit.prevent="handleRename"
                >
                  <UInput
                    v-model="editName"
                    size="sm"
                    class="flex-1"
                    autofocus
                  />
                  <UButton
                    type="submit"
                    size="xs"
                  >
                    Save
                  </UButton>
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    @click="editingId = null"
                  >
                    Cancel
                  </UButton>
                </form>
                <template v-else>
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-center gap-2 text-left"
                    @click="toggle(c.id)"
                  >
                    <UIcon
                      :name="expandedId === c.id ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                      class="size-4 shrink-0 text-muted"
                    />
                    <span class="truncate font-medium text-default">{{ c.name }}</span>
                    <span class="shrink-0 text-xs text-muted">
                      {{ c.projectCount }} {{ c.projectCount === 1 ? 'project' : 'projects' }} ·
                      {{ c.contactCount }} {{ c.contactCount === 1 ? 'contact' : 'contacts' }}
                    </span>
                  </button>
                  <template v-if="canManageCustomers">
                    <UButton
                      icon="i-lucide-pencil"
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      aria-label="Rename customer"
                      @click="startRename(c.id, c.name)"
                    />
                    <UButton
                      icon="i-lucide-trash-2"
                      size="xs"
                      color="error"
                      variant="ghost"
                      aria-label="Remove customer"
                      @click="confirmDelete(c.id, c.name)"
                    />
                  </template>
                </template>
              </div>

              <div
                v-if="expandedId === c.id"
                class="space-y-3 border-t border-default bg-elevated/30 px-4 py-3"
              >
                <div
                  v-if="detailLoading"
                  class="flex justify-center py-2"
                >
                  <UIcon
                    name="i-lucide-loader-2"
                    class="size-4 animate-spin text-muted"
                  />
                </div>
                <template v-else>
                  <div class="space-y-1.5">
                    <p class="text-xs font-semibold uppercase tracking-wider text-muted">
                      Contacts
                    </p>
                    <p
                      v-if="contacts.length === 0"
                      class="text-xs text-muted"
                    >
                      Nobody logs in for {{ c.name }} yet.
                    </p>
                    <div
                      v-for="contact in contacts"
                      :key="contact.userId"
                      class="flex items-center justify-between gap-2"
                    >
                      <div class="flex min-w-0 items-center gap-2">
                        <UAvatar
                          :alt="contact.name || contact.email"
                          size="2xs"
                        />
                        <span class="truncate text-xs text-default">{{ contact.name || contact.email }}</span>
                        <span
                          v-if="contact.name"
                          class="truncate text-[11px] text-muted"
                        >{{ contact.email }}</span>
                      </div>
                      <UButton
                        v-if="canManageCustomers"
                        icon="i-lucide-user-minus"
                        size="xs"
                        color="error"
                        variant="ghost"
                        aria-label="Remove contact"
                        @click="confirmRemoveContact(c.id, contact)"
                      />
                    </div>
                  </div>

                  <div
                    v-if="canManageCustomers"
                    class="space-y-1.5"
                  >
                    <p class="text-xs font-semibold uppercase tracking-wider text-muted">
                      Invitation links
                    </p>
                    <p class="text-[11px] text-muted">
                      Make a link and send it to the customer yourself. Nothing is emailed.
                    </p>
                    <div
                      v-for="inv in invitations"
                      :key="inv.id"
                      class="flex items-center justify-between gap-2 text-xs"
                    >
                      <span class="truncate text-default">{{ inv.label || 'Unlabelled link' }}</span>
                      <div class="flex shrink-0 items-center gap-1">
                        <span class="text-muted">expires {{ formatDate(inv.expiresAt) }}</span>
                        <UButton
                          icon="i-lucide-x"
                          size="xs"
                          color="neutral"
                          variant="ghost"
                          aria-label="Revoke link"
                          @click="confirmRevoke(c.id, inv)"
                        />
                      </div>
                    </div>

                    <div
                      v-if="freshLink?.customerId === c.id"
                      class="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-2"
                    >
                      <code class="min-w-0 flex-1 truncate text-[11px]">{{ freshLink.url }}</code>
                      <UButton
                        size="xs"
                        variant="soft"
                        :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
                        @click="copyLink"
                      >
                        {{ copied ? 'Copied' : 'Copy' }}
                      </UButton>
                    </div>
                    <p
                      v-if="freshLink?.customerId === c.id"
                      class="text-[11px] text-muted"
                    >
                      Copy it now: the link is shown once. It works for one person, for 14 days.
                    </p>

                    <form
                      class="flex items-center gap-2"
                      @submit.prevent="handleInvite(c.id)"
                    >
                      <UInput
                        v-model="inviteLabel"
                        size="sm"
                        placeholder="Who is it for? (optional)"
                        class="flex-1"
                      />
                      <UButton
                        type="submit"
                        size="sm"
                        variant="soft"
                        icon="i-lucide-link"
                        :loading="inviting"
                      >
                        Create link
                      </UButton>
                    </form>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </div>
      </template>
    </UModal>

    <!-- Declared last so it stacks above the customers modal. -->
    <UModal
      v-model:open="isConfirmOpen"
      :title="confirmRequest?.title"
      :description="confirmRequest?.description"
      :ui="{ overlay: 'z-[60]', content: 'z-[60]' }"
    >
      <template #body>
        <div class="flex justify-end gap-2">
          <UButton
            color="neutral"
            variant="soft"
            :disabled="confirmLoading"
            @click="isConfirmOpen = false"
          >
            Cancel
          </UButton>
          <UButton
            color="error"
            :loading="confirmLoading"
            @click="handleConfirm"
          >
            {{ confirmRequest?.confirmLabel }}
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
