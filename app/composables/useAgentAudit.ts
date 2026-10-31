import { onNotification, realtimeHeaders } from '~/composables/useRealtime'
import { untypedFetch } from '~/utils/untypedFetch'

// What the signed-in person's agents did through their API keys. Kept apart from
// useNotifications: an agent's change is a record to read, never an alarm, and the
// sidebar badge counts only the normal inbox.

export interface AgentAuditItem {
  id: string
  keyName: string
  tool: string
  toolTitle: string
  projectId: string | null
  projectName: string | null
  taskId: string | null
  taskTitle: string | null
  summary: string
  createdAt: number
  readAt: number | null
}

const request = untypedFetch

const _items = ref<AgentAuditItem[]>([])
const _unread = ref(0)
const _hasAgents = ref(false)
const _loaded = ref(false)

/**
 * Where an audit row leads: its task, or its board when the row is about the
 * board itself. Null when the task was deleted since (its title stays, its id goes).
 */
export function agentAuditLink(item: Pick<AgentAuditItem, 'projectId' | 'taskId' | 'taskTitle'>): string | null {
  if (item.taskId) return `/projects/${item.projectId}?task=${item.taskId}`
  if (item.taskTitle) return null
  return item.projectId ? `/projects/${item.projectId}` : null
}

export function useAgentAudit() {
  async function load() {
    try {
      const res = await request<{ hasAgents: boolean, unread: number, items: AgentAuditItem[] }>('/api/agent-audit?limit=50')
      _items.value = res.items
      _unread.value = res.unread
      _hasAgents.value = res.hasAgents
      _loaded.value = true
    } catch { /* signed out, or offline: the tab stays as it was */ }
  }

  async function markRead(ids: string[]) {
    const now = Date.now()
    const unread = _items.value.filter(item => ids.includes(item.id) && !item.readAt).length
    _items.value = _items.value.map(item => ids.includes(item.id) && !item.readAt ? { ...item, readAt: now } : item)
    _unread.value = Math.max(0, _unread.value - unread)
    await request('/api/agent-audit/read', { method: 'POST', headers: realtimeHeaders(), body: { ids } })
  }

  async function markAllRead() {
    const now = Date.now()
    _items.value = _items.value.map(item => item.readAt ? item : { ...item, readAt: now })
    _unread.value = 0
    await request('/api/agent-audit/read', { method: 'POST', headers: realtimeHeaders(), body: { all: true } })
  }

  // Refetch when the server nudges us about a change; the listener goes with the page that asked.
  const stop = onNotification(load)
  if (getCurrentScope()) onScopeDispose(stop)

  return { items: _items, unread: _unread, hasAgents: _hasAgents, loaded: _loaded, load, markRead, markAllRead }
}
