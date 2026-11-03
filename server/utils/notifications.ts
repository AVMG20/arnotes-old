// Telling people things: an inbox row for each person, a live nudge to their open
// tabs, and a copy by mail for those who asked for one. Shared by the endpoints
// and the agent tools, so a task an agent assigns lands in the same inbox as one
// assigned by hand.
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { notificationPreferences, notifications, pushSubscriptions, user } from '../db/schema'
import type { NotificationType } from '../db/schema'
import { mailEnabled, sendMail } from '../lib/mailer'
import { pushEnabled, sendPush } from '../lib/webpush'
import { projectPeople } from './people'
import { publishToUser } from './realtime'

const MAX_EXCERPT = 160

interface NotifyInput {
  project: { id: string, name: string, userId: string, teamId: string | null, customerId: string | null }
  /** Set when the notification is about one task: a customer's contact is told only about tasks they can see. */
  task?: { id: string, title: string, visibility: 'internal' | 'customer' }
  /** For a message or a reply: the conversation's first message, which the inbox opens. */
  messageId?: string
  actorId: string | null
  type: NotificationType
  recipients: string[]
  /** For what the customer must not read, such as an internal comment or a team message. */
  staffOnly?: boolean
  title: string
  body?: string
}

export function notificationExcerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_EXCERPT ? `${flat.slice(0, MAX_EXCERPT - 1)}…` : flat
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[ch]!)
}

/** Where a mail or a push leads: the task, the conversation, or the board. Matches notificationLink in the app. */
function pathOf(input: NotifyInput): string {
  if (input.task) return `/projects/${input.project.id}?task=${input.task.id}`
  if (input.messageId) return `/projects/${input.project.id}?view=messages&message=${input.messageId}`
  return `/projects/${input.project.id}`
}

function appUrl(path: string): string {
  return `${(process.env.BETTER_AUTH_URL ?? 'http://localhost:3000').replace(/\/$/, '')}${path}`
}

/**
 * Tells each recipient, except whoever did it. A recipient who cannot see what
 * it is about is dropped, not told: a notification is a way to read something,
 * so it is held to the same audience rule as reading it. Returns how many were
 * told.
 */
export async function notify(input: NotifyInput): Promise<number> {
  const people = await projectPeople(input.project)
  const allowed = new Set(
    people
      .filter(person => person.kind === 'staff' || (!input.staffOnly && input.task?.visibility === 'customer'))
      .map(person => person.id)
  )
  const ids = [...new Set(input.recipients)].filter(id => id !== input.actorId && allowed.has(id))
  if (!ids.length) return 0

  const now = Date.now()
  const rows = await db.insert(notifications).values(ids.map(id => ({
    id: `${now.toString(36)}${Math.random().toString(36).slice(2)}`,
    userId: id,
    type: input.type,
    projectId: input.project.id,
    taskId: input.task?.id ?? null,
    messageId: input.messageId ?? null,
    actorId: input.actorId,
    title: input.title,
    body: input.body ?? '',
    createdAt: now
  }))).returning()

  await Promise.all(ids.map(id => publishToUser(id, { type: 'notification' }).catch(() => {})))
  void sendCopies(rows, input)
  void sendPushes(rows, input)
  return rows.length
}

// Mail is best effort: a notification that could not be emailed is still in the
// inbox, so a failure here is logged and nothing else.
async function sendCopies(rows: { id: string, userId: string }[], input: NotifyInput) {
  if (!mailEnabled) return
  try {
    const wanting = await db
      .select({ userId: notificationPreferences.userId, email: user.email })
      .from(notificationPreferences)
      .innerJoin(user, eq(user.id, notificationPreferences.userId))
      .where(and(
        inArray(notificationPreferences.userId, rows.map(row => row.userId)),
        eq(notificationPreferences.email, true)
      ))

    const link = appUrl(pathOf(input))
    const body = input.body ?? ''
    for (const person of wanting) {
      const row = rows.find(candidate => candidate.userId === person.userId)!
      await sendMail({
        to: person.email,
        subject: input.title,
        text: `${input.title}\n${body ? `\n${body}\n` : ''}\nOpen it: ${link}\n\nYou get this because email notifications are on in your Taskmanager inbox settings.`,
        html: `<p><strong>${escapeHtml(input.title)}</strong></p>${body ? `<p>${escapeHtml(body)}</p>` : ''}<p><a href="${escapeHtml(link)}">Open it in Taskmanager</a></p><p style="color:#888;font-size:12px">You get this because email notifications are on in your Taskmanager inbox settings.</p>`
      })
      await db.update(notifications).set({ emailedAt: Date.now() }).where(eq(notifications.id, row.id))
    }
  } catch (error) {
    console.error('[notifications] could not send email', error)
  }
}

// A push goes to every device the person subscribed, and a device the push
// service says is gone is forgotten. Like mail, it is best effort.
async function sendPushes(rows: { id: string, userId: string }[], input: NotifyInput) {
  if (!pushEnabled) return
  try {
    const devices = await db.select().from(pushSubscriptions)
      .where(inArray(pushSubscriptions.userId, rows.map(row => row.userId)))
    const url = pathOf(input)
    await Promise.all(devices.map(async (device) => {
      const row = rows.find(candidate => candidate.userId === device.userId)!
      const result = await sendPush(device, { title: input.title, body: input.body ?? '', url, tag: row.id })
      if (result.gone) await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, device.id))
      else if (result.ok) await db.update(pushSubscriptions).set({ lastSentAt: Date.now() }).where(eq(pushSubscriptions.id, device.id))
    }))
  } catch (error) {
    console.error('[notifications] could not send push', error)
  }
}

export async function loadPreferences(userId: string) {
  const [row] = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId))
  return { email: row?.email ?? false, browser: row?.browser ?? false }
}
