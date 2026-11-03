// Who hears about what. Each event names the people it concerns; `notify` then
// drops whoever did it and whoever may not read it.
import { and, eq } from 'drizzle-orm'
import { db } from '../db'
import { projectColumns, projectMessages, projectRules, projectTasks, taskComments, user } from '../db/schema'
import { notificationExcerpt, notify } from './notifications'
import { projectPeople } from './people'
import { agentEventHub, emitAgentEventAsync, emitInBackground, githubDatabaseLookups, replyRecipients } from './agentEvents'
import { agentHearsMove, createMoveCoalescer, isDefaultMoveColumn, moveRecipients } from './moveWatch'
import { tellUnblockedOnChange } from './unblockedWatch'
import type { ReplyWriter } from './agentEvents'

type Project = { id: string, name: string, userId: string, teamId: string | null, customerId: string | null }
type Task = { id: string, title: string, visibility: 'internal' | 'customer', assigneeId?: string | null, createdBy?: string | null }

async function nameOf(userId: string | null): Promise<string> {
  if (!userId) return 'Someone'
  const [row] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId))
  return row?.name ?? 'Someone'
}

/** A task was given to someone. */
export async function notifyAssigned(project: Project, task: Task, actorId: string | null, assigneeId: string) {
  emitInBackground(() => tellAssigned(project, task, actorId, assigneeId))
  await notify({
    project,
    task,
    actorId,
    type: 'assigned',
    recipients: [assigneeId],
    title: `${await nameOf(actorId)} assigned you "${task.title}"`
  })
}

// The agent event for an assignment: the assignee hears of it, unless they assigned it to themselves.
async function tellAssigned(project: Project, task: Task, actorId: string | null, assigneeId: string) {
  if (assigneeId === actorId) return
  await emitAgentEventAsync(assigneeId, { kind: 'task_assigned', board: project, task, from: await nameOf(actorId), customerVisible: task.visibility === 'customer' })
}

/** An update was posted on a task: its assignee and the others who have written on it hear. */
export async function notifyComment(project: Project, task: Task, actorId: string | null, body: string, internal: boolean, replyToId: string | null = null) {
  const writers = await db.select({ id: taskComments.id, userId: taskComments.userId, body: taskComments.body }).from(taskComments).where(eq(taskComments.taskId, task.id))
  const recipients = [...new Set([...(task.assigneeId ? [task.assigneeId] : []), ...(task.createdBy ? [task.createdBy] : []), ...writers.map(writer => writer.userId)])]
  await notify({
    project,
    task,
    actorId,
    type: 'comment',
    recipients,
    staffOnly: internal,
    title: `${await nameOf(actorId)} commented on "${task.title}"`,
    body: notificationExcerpt(body)
  })
  // Agents hear of a mention, and of a reply: to the people on the card, to those who commented on it, and to the author replied to.
  emitInBackground(() => tellAgentsOfComment(project, task, actorId, body, { internal, replyToId, owners: [task.assigneeId, task.createdBy], writers }))
}

/**
 * The agent events for a comment: a mention, and a reply to the owners of the card, the
 * people who asked on it and the author of the comment replied to. Someone mentioned
 * gets the mention only. A customer hears only what is customer-visible on a
 * customer-visible card.
 */
async function tellAgentsOfComment(
  project: Project,
  task: Task,
  actorId: string | null,
  body: string,
  comment: { internal: boolean, replyToId: string | null, owners: (string | null | undefined)[], writers: ReplyWriter[] }
) {
  const customerVisible = !comment.internal && task.visibility === 'customer'
  const from = await nameOf(actorId)
  const mentioned = body.includes('@') ? await mentionedIn(project, body, actorId) : new Set<string>()
  for (const id of mentioned) {
    await emitAgentEventAsync(id, { kind: 'mention', board: project, task, from, customerVisible })
  }

  const replied = replyRecipients({ actorId, owners: comment.owners, writers: comment.writers, replyToId: comment.replyToId, watches: userId => agentEventHub.watches(userId) })
  for (const { userId, needsFeedbackFromMe } of replied) {
    if (mentioned.has(userId)) continue
    await emitAgentEventAsync(userId, { kind: 'reply', board: project, task, from, customerVisible, needsFeedbackFromMe })
  }
}

/** The people on the board a comment names with @name or @first-name, other than whoever wrote it. */
async function mentionedIn(project: Project, body: string, actorId: string | null): Promise<Set<string>> {
  const found = new Set<string>()
  for (const person of await projectPeople(project)) {
    if (person.id === actorId || !agentEventHub.watches(person.id)) continue
    const names = [person.name, person.name.split(/\s+/)[0] ?? ''].filter(name => name.length > 0)
    if (names.some(name => namedIn(body, name))) found.add(person.id)
  }
  return found
}

function namedIn(body: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`@${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(body)
}

/**
 * A message or a reply. A new message goes to the whole team on the project; a
 * reply goes to the people already in that conversation. The team's own talk is
 * never shown to a customer's contact.
 */
export async function notifyMessage(project: Project, message: { title: string, body: string, parentId: string | null }, actorId: string | null) {
  const actor = await nameOf(actorId)

  if (!message.parentId) {
    const staff = (await projectPeople(project)).filter(person => person.kind === 'staff').map(person => person.id)
    await notify({
      project,
      actorId,
      type: 'message',
      recipients: staff,
      staffOnly: true,
      title: `${actor} posted in ${project.name}${message.title ? `: ${message.title}` : ''}`,
      body: notificationExcerpt(message.body)
    })
    return
  }

  const thread = await db
    .select({ userId: projectMessages.userId })
    .from(projectMessages)
    .where(eq(projectMessages.parentId, message.parentId))
  const [parent] = await db.select({ userId: projectMessages.userId, title: projectMessages.title })
    .from(projectMessages).where(eq(projectMessages.id, message.parentId))

  await notify({
    project,
    actorId,
    type: 'reply',
    recipients: [...(parent ? [parent.userId] : []), ...thread.map(reply => reply.userId)],
    staffOnly: true,
    title: `${actor} replied${parent?.title ? ` to "${parent.title}"` : ''} in ${project.name}`,
    body: notificationExcerpt(message.body)
  })
}

/**
 * Something about a task changed: done, reopened, a new due date, a move. The
 * people on it hear: its assignee and everyone who has written on it.
 */
export async function notifyTaskChange(project: Project, task: Task, actorId: string | null, changes: string[]) {
  if (!changes.length) return
  const writers = await db.select({ userId: taskComments.userId }).from(taskComments).where(eq(taskComments.taskId, task.id))
  await notify({
    project,
    task,
    actorId,
    type: 'update',
    recipients: [...new Set([...(task.assigneeId ? [task.assigneeId] : []), ...(task.createdBy ? [task.createdBy] : []), ...writers.map(writer => writer.userId)])],
    title: `${await nameOf(actorId)} updated "${task.title}"`,
    body: changes.join(' · ')
  })
  // Agents hear of a card that reached a column they watch for.
  emitInBackground(() => tellAgentsOfMove(project, task, actorId, changes))
  // The people on a task that was the last thing holding another back hear it (GH #36 slice 5). Never throws.
  void tellUnblockedOnChange(project, task.id, actorId, changes)
}

// The people a move reaches: the card's people and the crew pm, coalesced per board, person and visibility.
// The first move in a window goes out at once, the rest of the window is counted (moveWatch.ts).
type MovePayload = { recipient: string, board: Project, task: Task, from: string, customerVisible: boolean }
const moveCoalescer = createMoveCoalescer<MovePayload>({
  send: (payload, more) => {
    emitInBackground(() => emitAgentEventAsync(payload.recipient, {
      kind: 'task_moved',
      board: payload.board,
      task: payload.task,
      // A summary has no mover of its own: its count goes where the mover's name goes.
      from: more > 0 ? `${more} more moves on ${payload.board.name}` : payload.from,
      customerVisible: payload.customerVisible
    }))
  }
})

// The agents hear of a card that reached a column they watch for: its owners and the crew pm hear of it.
async function tellAgentsOfMove(project: Project, task: Task, actorId: string | null, changes: string[]) {
  const column = await movedTo(task, changes)
  if (!column) return
  // The default columns need no rule lookup; only another column asks the board's rules.
  if (!isDefaultMoveColumn(column.name) && !agentHearsMove(column, await enabledRuleTriggers(project.id))) return
  const from = await nameOf(actorId)
  const crew = project.teamId ? await githubDatabaseLookups.crewPeople(project.teamId) : []
  const pm = crew.filter(person => person.key === 'pm').map(person => person.userId)
  const customerVisible = task.visibility === 'customer'
  for (const recipient of moveRecipients(task, actorId, pm)) {
    moveCoalescer.offer(`${project.id}|${recipient}|${customerVisible ? 'customer' : 'internal'}`, { recipient, board: project, task, from, customerVisible })
  }
}
/** The column a card was moved into, when this change says it was moved. */
async function movedTo(task: Task, changes: string[]): Promise<{ id: string, name: string } | null> {
  if (!changes.some(change => change.startsWith('Moved to '))) return null
  const [row] = await db.select({ id: projectColumns.id, name: projectColumns.name }).from(projectTasks)
    .innerJoin(projectColumns, eq(projectColumns.id, projectTasks.columnId))
    .where(eq(projectTasks.id, task.id))
  return row ?? null
}

/** The triggers of the rules on a board that are switched on. A rule that chooses a column is one of them. */
async function enabledRuleTriggers(projectId: string): Promise<unknown[]> {
  const rows = await db.select({ trigger: projectRules.trigger }).from(projectRules)
    .where(and(eq(projectRules.projectId, projectId), eq(projectRules.enabled, true)))
  return rows.map(row => row.trigger)
}
