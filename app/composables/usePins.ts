// The person's pinned boards, across every workspace they have. One list for the whole app:
// the sidebar loads it once and every pin or unpin answers with the new list.

export interface PinnedBoard {
  projectId: string
  name: string
  customerName: string | null
  // The workspace the board opens in; null is the personal workspace.
  teamId: string | null
  teamName: string | null
}

const _pins = ref<PinnedBoard[]>([])
const _loaded = ref(false)

export function usePins() {
  async function loadPins() {
    _pins.value = await $fetch<PinnedBoard[]>('/api/pins')
    _loaded.value = true
  }

  function isPinned(projectId: string) {
    return _pins.value.some(pin => pin.projectId === projectId)
  }

  async function pinBoard(projectId: string) {
    _pins.value = await $fetch<PinnedBoard[]>('/api/pins', { method: 'POST', body: { projectId } })
  }

  async function unpinBoard(projectId: string) {
    _pins.value = await $fetch<PinnedBoard[]>(`/api/pins/${projectId}`, { method: 'DELETE' })
  }

  return {
    pins: computed(() => _pins.value),
    pinsLoaded: computed(() => _loaded.value),
    loadPins,
    isPinned,
    pinBoard,
    unpinBoard
  }
}
