<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'

const { teams, activeTeam, setActiveTeam } = useTeams()
const { isInstanceAdmin, canCreateOrganizations } = useAuth()
const { refresh: refreshProjects } = useProjects()
const { refresh: refreshCustomers } = useCustomers()

const showManageModal = ref(false)
const showCreateModal = ref(false)
const showJoinModal = ref(false)
const showCustomersModal = ref(false)
const showAdminModal = ref(false)

const route = useRoute()

async function handleSelectTeam(id: string | null) {
  await setActiveTeam(id)
  await refreshProjects()
  // Customers exist only in a team: a personal workspace answers 403 here, and that must
  // not stop the move away from the old board below.
  await refreshCustomers().catch(() => {})
  // The board that was open belongs to the workspace we just left; its route
  // would keep pointing at an id the new workspace does not have.
  if (route.path.startsWith('/projects/')) await navigateTo('/projects', { replace: true })
}

const dropdownItems = computed<DropdownMenuItem[]>(() => {
  const items: DropdownMenuItem[] = []

  // Personal workspace item
  items.push({
    label: 'Personal Workspace',
    icon: 'i-lucide-user',
    active: !activeTeam.value,
    onSelect: () => handleSelectTeam(null)
  })

  if (teams.value.length > 0) {
    items.push({
      type: 'label',
      label: 'Your Teams'
    })

    teams.value.forEach((t) => {
      items.push({
        label: t.name,
        icon: 'i-lucide-users',
        active: activeTeam.value?.id === t.id,
        onSelect: () => handleSelectTeam(t.id)
      })
    })
  }

  // Only for people who cannot create teams: the sentence would contradict the Create Team entry.
  if (!canCreateOrganizations.value) {
    items.push({
      slot: 'teams-hint',
      // A click on the sentence keeps the menu open; only the link does anything.
      onSelect: (event: Event) => event.preventDefault()
    })
  }

  items.push({
    type: 'separator'
  })

  // Owning an organisation is handed out by the instance admin; the server
  // refuses the rest, so the menu does not offer it to them.
  if (canCreateOrganizations.value) {
    items.push({
      label: 'Create Team',
      icon: 'i-lucide-plus',
      onSelect: () => { showCreateModal.value = true }
    })
  }

  items.push({
    label: 'Join Team with Code',
    icon: 'i-lucide-key-round',
    onSelect: () => { showJoinModal.value = true }
  })

  if (activeTeam.value) {
    items.push({
      label: 'Customers',
      icon: 'i-lucide-building-2',
      onSelect: () => { showCustomersModal.value = true }
    })
    items.push({
      label: 'Team Settings & Members',
      icon: 'i-lucide-settings-2',
      onSelect: () => { showManageModal.value = true }
    })
  }

  if (isInstanceAdmin.value) {
    items.push({
      label: 'Accounts on this instance',
      icon: 'i-lucide-shield',
      onSelect: () => { showAdminModal.value = true }
    })
  }

  return items
})
</script>

<template>
  <div>
    <UDropdownMenu
      :items="dropdownItems"
      :content="{ align: 'start', collisionPadding: 12 }"
      :ui="{ content: 'w-56' }"
    >
      <template #teams-hint>
        <p class="px-2 py-1.5 text-xs text-muted">
          Teams are created by an admin. Have a join code?
          <button
            type="button"
            class="text-primary hover:underline"
            data-team-join-link
            @click="showJoinModal = true"
          >
            Join a team
          </button>
        </p>
      </template>
      <button class="flex w-full items-center gap-2 rounded-lg border border-default bg-elevated/50 px-2.5 py-1.5 text-xs text-default hover:bg-elevated transition-colors">
        <div class="flex size-5 shrink-0 items-center justify-center rounded bg-primary/10 text-primary font-medium">
          <UIcon
            :name="activeTeam ? 'i-lucide-users' : 'i-lucide-user'"
            class="size-3.5"
          />
        </div>
        <span class="min-w-0 flex-1 truncate text-left font-medium">
          {{ activeTeam ? activeTeam.name : 'Personal Workspace' }}
        </span>
        <UBadge
          v-if="activeTeam"
          size="xs"
          variant="subtle"
          color="neutral"
          class="shrink-0 text-[10px]"
        >
          Team
        </UBadge>
        <UIcon
          name="i-lucide-chevrons-up-down"
          class="size-3.5 shrink-0 opacity-50"
        />
      </button>
    </UDropdownMenu>

    <TeamManageModal
      v-model:open="showManageModal"
      v-model:create-open="showCreateModal"
      v-model:join-open="showJoinModal"
    />
    <CustomersModal v-model:open="showCustomersModal" />
    <AdminUsersModal
      v-if="isInstanceAdmin"
      v-model:open="showAdminModal"
    />
  </div>
</template>
