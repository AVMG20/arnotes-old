// Opening something that lives in another workspace (a pinned board, an inbox item):
// switch to that workspace the way the team switcher does, then open it.
export function useWorkspace() {
  const { activeTeamId, setActiveTeam } = useTeams()
  const { refresh: refreshProjects } = useProjects()
  const { refresh: refreshCustomers } = useCustomers()

  /** Makes the team (or the personal workspace, null) the open one. Nothing happens when it already is. */
  async function switchWorkspace(teamId: string | null) {
    if (teamId === activeTeamId.value) return
    await setActiveTeam(teamId)
    await refreshProjects()
    // Customers exist only in a team: the personal workspace answers 403, which changes nothing here.
    await refreshCustomers().catch(() => {})
  }

  /** Switches to the workspace a board opens in. False when the board cannot be opened at all. */
  async function switchToBoard(projectId: string): Promise<boolean> {
    const where = await $fetch<{ teamId: string | null }>(`/api/projects/${projectId}/workspace`).catch(() => null)
    if (!where) return false
    await switchWorkspace(where.teamId)
    return true
  }

  return { switchWorkspace, switchToBoard }
}
