import { onNotification, realtimeHeaders } from '~/composables/useRealtime'
import { errorMessage, untypedFetch } from '~/utils/untypedFetch'

export interface NotificationItem {
  id: string
  type: 'assigned' | 'comment' | 'message' | 'reply' | 'update'
  projectId: string
  projectName: string
  taskId: string | null
  taskTitle: string | null
  /** For a message or a reply: the conversation's first message. Older notifications have none. */
  messageId?: string | null
  title: string
  body: string
  createdAt: number
  readAt: number | null
  actorName: string | null
  actorImage: string | null
}

export interface NotificationPreferences {
  email: boolean
  browser: boolean
  /** Whether this server can send mail at all. */
  mailEnabled: boolean
}

const request = untypedFetch

// One inbox for the whole app: the sidebar badge and the Inbox page read it.
const _items = ref<NotificationItem[]>([])
const _unread = ref(0)
const _prefs = ref<NotificationPreferences>({ email: false, browser: false, mailEnabled: false })
const _loaded = ref(false)
// What has already been shown as a desktop notification, so a refetch does not
// show it twice.
const announced = new Set<string>()
let started = false

/** Where a notification leads: the task it is about, or the conversation. */
export function notificationLink(item: Pick<NotificationItem, 'type' | 'projectId' | 'taskId' | 'messageId'>): string {
  if (item.taskId) return `/projects/${item.projectId}?task=${item.taskId}`
  if (item.messageId) return `/projects/${item.projectId}?view=messages&message=${item.messageId}`
  if (item.type === 'message' || item.type === 'reply') return `/projects/${item.projectId}?view=messages`
  return `/projects/${item.projectId}`
}

function desktopCanShow(): boolean {
  return import.meta.client
    && _prefs.value.browser
    && 'Notification' in window
    && Notification.permission === 'granted'
    // A tab you are looking at already shows it; the desktop is for when you are not.
    && document.visibilityState !== 'visible'
}

function showDesktop(item: NotificationItem) {
  try {
    const shown = new Notification(item.title, { body: item.body, tag: item.id })
    shown.onclick = () => {
      window.focus()
      navigateTo(notificationLink(item))
      shown.close()
    }
  } catch { /* a browser that refuses is a browser that does not get one */ }
}

async function load() {
  try {
    const res = await request<{ unread: number, items: NotificationItem[] }>('/api/notifications')
    const fresh = res.items.filter(item => !item.readAt && !announced.has(item.id))
    for (const item of fresh) announced.add(item.id)
    // The first read only learns what is already there; it announces nothing.
    if (_loaded.value && desktopCanShow()) fresh.forEach(showDesktop)
    _items.value = res.items
    _unread.value = res.unread
    _loaded.value = true
  } catch { /* signed out, or offline: the inbox stays as it was */ }
}

async function loadPreferences() {
  try {
    _prefs.value = await request<NotificationPreferences>('/api/notifications/preferences')
  } catch { /* as above */ }
}

// ─── Web Push: a notification when no tab is open ───────────────────────────
// This device's own subscription, kept apart from the account's preferences:
// pushing is something one browser agrees to, not something the account is set to.

export interface PushState {
  /** This browser can do Web Push at all. */
  supported: boolean
  /** The server has keys to push with. */
  enabled: boolean
  /** This browser is subscribed and the server knows it. */
  subscribed: boolean
}

const _push = ref<PushState>({ supported: false, enabled: false, subscribed: false })
let pushKey = ''

function pushSupported(): boolean {
  return import.meta.client && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const base64 = key.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(key.length / 4) * 4, '=')
  return Uint8Array.from(atob(base64), ch => ch.charCodeAt(0))
}

/** The page's service worker, or the push one on its own where the app's is not registered (development). */
async function pushRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration()
  if (!existing) await navigator.serviceWorker.register('/push-sw.js')
  return navigator.serviceWorker.ready
}

async function loadPush() {
  if (!pushSupported()) return
  try {
    const res = await request<{ enabled: boolean, publicKey: string | null, endpoints: string[] }>('/api/notifications/push')
    pushKey = res.publicKey ?? ''
    const registration = await navigator.serviceWorker.getRegistration()
    const mine = await registration?.pushManager.getSubscription()
    _push.value = { supported: true, enabled: res.enabled, subscribed: Boolean(mine && res.endpoints.includes(mine.endpoint)) }
  } catch { /* signed out, or offline */ }
}

export function useNotifications() {
  /** Subscribes this browser to push, or unsubscribes it. Returns a reason when it cannot. */
  async function setPush(on: boolean): Promise<string | null> {
    if (!pushSupported()) return 'This browser cannot receive push notifications'
    try {
      if (on) {
        if (!pushKey) return 'Push notifications are not set up on this server'
        const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
        if (permission !== 'granted') return 'Allow notifications for this site in the browser, then try again'
        const registration = await pushRegistration()
        const subscription = (await registration.pushManager.getSubscription())
          ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(pushKey) })
        await request('/api/notifications/push', { method: 'POST', headers: realtimeHeaders(), body: subscription.toJSON() })
      } else {
        const registration = await navigator.serviceWorker.getRegistration()
        const subscription = await registration?.pushManager.getSubscription()
        if (subscription) {
          await request('/api/notifications/push', { method: 'DELETE', headers: realtimeHeaders(), body: { endpoint: subscription.endpoint } })
          await subscription.unsubscribe()
        }
      }
      await loadPush()
      return null
    } catch (e) {
      return errorMessage(e, 'Could not change push notifications')
    }
  }

  /** Asks the server to push to every subscribed device. */
  async function testPush(): Promise<string | null> {
    try {
      const res = await request<{ devices: number, accepted: number }>('/api/notifications/push-test', { method: 'POST', headers: realtimeHeaders() })
      return res.accepted ? null : 'No push service accepted the message'
    } catch (e) {
      return errorMessage(e, 'Could not send a test')
    }
  }

  async function markRead(ids: string[]) {
    const now = Date.now()
    const unread = _items.value.filter(item => ids.includes(item.id) && !item.readAt).length
    _items.value = _items.value.map(item => ids.includes(item.id) && !item.readAt ? { ...item, readAt: now } : item)
    _unread.value = Math.max(0, _unread.value - unread)
    await request('/api/notifications/read', { method: 'POST', headers: realtimeHeaders(), body: { ids } })
  }

  async function markAllRead() {
    const now = Date.now()
    _items.value = _items.value.map(item => item.readAt ? item : { ...item, readAt: now })
    _unread.value = 0
    await request('/api/notifications/read', { method: 'POST', headers: realtimeHeaders(), body: { all: true } })
  }

  /** Turns a way of being told on or off; a desktop notification needs the browser's permission first. */
  async function setPreference(key: 'email' | 'browser', value: boolean): Promise<string | null> {
    if (key === 'browser' && value) {
      if (!('Notification' in window)) return 'This browser cannot show desktop notifications'
      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
      if (permission !== 'granted') return 'Allow notifications for this site in the browser, then try again'
    }
    try {
      _prefs.value = await request<NotificationPreferences>('/api/notifications/preferences', {
        method: 'PUT', headers: realtimeHeaders(), body: { [key]: value }
      })
      return null
    } catch (e) {
      return errorMessage(e, 'Could not save that')
    }
  }

  /** Loads the inbox and keeps it live; safe to call from anywhere, it runs once. */
  function init() {
    if (started || !import.meta.client) return
    started = true
    load()
    loadPreferences()
    loadPush()
    onNotification(load)
    // A tab that slept through some comes back to a stale count.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') load()
    })
  }

  return { items: _items, unread: _unread, prefs: _prefs, push: _push, loaded: _loaded, load, markRead, markAllRead, setPreference, setPush, testPush, init }
}
