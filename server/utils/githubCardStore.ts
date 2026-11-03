// The database side of the card syncer: the writes githubCards.ts asks for. A card made here is the
// same as one made in the app: its activity line, the agent event, the live update of the board.
// A card change and its activity line are one transaction, so a crash leaves neither or both.
import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db'
import { githubDeliveries, githubLinks, projectColumns, projectGithubRepos, projects, projectTasks, taskActivity, taskComments } from '../db/schema'
import type { ProjectTask } from '../db/schema'
import { announceTaskCreated } from './agentEvents'
import { genId } from './projects'
import { notifyComment } from './notifyEvents'
import { publish, workspaceTopic } from './realtime'
import type { ActivityEntry } from './taskActivity'
import type { CardPatch, CardTask, GithubCardStore, NewIssueCard, SyncedRepo } from './githubCards'
import type { DeliveryLedger } from './githubDeliveryConsumer'

/** The database handle the store uses. The real one in the app; a fake in the tests. */
export type CardDatabase = typeof db
type Transaction = Parameters<Parameters<CardDatabase['transaction']>[0]>[0]

function cardOf(task: ProjectTask): CardTask {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    description: task.description,
    tags: task.tags,
    visibility: task.visibility,
    completedAt: task.completedAt,
    trashed: task.deletedAt !== null
  }
}

async function projectRow(database: CardDatabase, projectId: string) {
  const [project] = await database.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!project) throw new Error(`Project ${projectId} is gone`)
  return project
}

/** The activity lines of one change, written inside the change's transaction. */
async function writeActivity(tx: Transaction, task: { id: string, projectId: string }, entries: ActivityEntry[]) {
  if (!entries.length) return
  const now = Date.now()
  await tx.insert(taskActivity).values(entries.map((entry, index) => ({
    id: randomUUID(),
    taskId: task.id,
    projectId: task.projectId,
    actorId: null,
    via: 'github' as const,
    kind: entry.kind,
    detail: entry.detail ?? {},
    createdAt: now + index
  })))
}

/** Runs an announcement after the change is saved. It cannot undo the change, so a failure is logged only. */
async function announce(what: string, run: () => Promise<void>) {
  try {
    await run()
  } catch (error) {
    const kind = error instanceof Error ? error.name : 'non-Error'
    console.error(`GitHub card sync: the change is saved, but ${what} was not sent (${kind})`)
  }
}

async function announceBoard(database: CardDatabase, projectId: string) {
  const project = await projectRow(database, projectId)
  await publish(workspaceTopic(project.userId, project.teamId), { type: 'board', projectId })
}

export function makeDatabaseCardStore(database: CardDatabase): GithubCardStore {
  return {
    async linkedRepos(owner, repo) {
      const rows = await database.select({
        id: projectGithubRepos.id,
        projectId: projectGithubRepos.projectId,
        owner: projectGithubRepos.owner,
        repo: projectGithubRepos.repo,
        syncEnabled: projectGithubRepos.syncEnabled,
        syncColumn: projectGithubRepos.syncColumn,
        syncVisibility: projectGithubRepos.syncVisibility,
        acceptedLogins: projectGithubRepos.acceptedLogins,
        completeOnClose: projectGithubRepos.completeOnClose
      })
        .from(projectGithubRepos)
        .where(and(
          sql`lower(${projectGithubRepos.owner}) = ${owner.toLowerCase()}`,
          sql`lower(${projectGithubRepos.repo}) = ${repo.toLowerCase()}`
        ))
      return rows.map((row): SyncedRepo => ({ ...row, acceptedLogins: row.acceptedLogins.map(login => login.toLowerCase()) }))
    },

    async recordIgnored(repo, issue) {
      // An atomic increment: two deliveries at once both count.
      await database.update(projectGithubRepos)
        .set({ ignoredCount: sql`${projectGithubRepos.ignoredCount} + 1`, lastIgnored: issue })
        .where(eq(projectGithubRepos.id, repo.id))
    },

    async issueCard(repo, number) {
      const [row] = await database.select({ task: projectTasks })
        .from(githubLinks)
        .innerJoin(projectTasks, eq(projectTasks.id, githubLinks.taskId))
        .where(and(
          eq(githubLinks.projectId, repo.projectId),
          eq(githubLinks.kind, 'issue'),
          eq(githubLinks.ref, String(number)),
          sql`lower(${githubLinks.owner}) = ${repo.owner.toLowerCase()}`,
          sql`lower(${githubLinks.repo}) = ${repo.repo.toLowerCase()}`
        ))
        .limit(1)
      return row ? cardOf(row.task) : null
    },

    async resolveColumn(projectId, name) {
      const columns = await database.select({ id: projectColumns.id, name: projectColumns.name })
        .from(projectColumns)
        .where(and(eq(projectColumns.projectId, projectId), sql`${projectColumns.deletedAt} is null`))
        .orderBy(projectColumns.position)
      const exact = columns.find(column => column.name === name)
      if (exact) return { columnId: exact.id, name: exact.name, fellBack: false }
      const fallback = columns.find(column => column.name === 'Backlog') ?? columns[0]
      return fallback ? { columnId: fallback.id, name: fallback.name, fellBack: true } : null
    },

    async createIssueCard(input: NewIssueCard) {
      const now = Date.now()
      const project = await projectRow(database, input.projectId)
      // The card, its link row, its activity line and the fallback notice go in together: a failure leaves none
      // of them, so a retry makes the card once and the notice with it.
      const task = await database.transaction(async (tx) => {
        // The last position is read inside the transaction, and the column is locked for it, so two cards
        // made at once cannot read the same last position.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.columnId}))`)
        const [last] = await tx.select({ position: projectTasks.position })
          .from(projectTasks)
          .where(and(eq(projectTasks.columnId, input.columnId), sql`${projectTasks.deletedAt} is null`))
          .orderBy(desc(projectTasks.position))
          .limit(1)
        const [created] = await tx.insert(projectTasks).values({
          id: genId(),
          projectId: input.projectId,
          columnId: input.columnId,
          title: input.title,
          description: input.description,
          tags: input.tags,
          visibility: input.visibility,
          // No person made it: GitHub did. The activity line says so.
          createdBy: null,
          position: (last?.position ?? -1000) + 1000,
          createdAt: now,
          updatedAt: now
        }).returning()
        if (!created) throw new Error('The card was not saved')
        await tx.insert(githubLinks).values({
          id: randomUUID(),
          projectId: input.projectId,
          taskId: created.id,
          kind: 'issue',
          owner: input.owner,
          repo: input.repo,
          ref: String(input.number),
          url: input.url,
          visibility: input.visibility,
          createdBy: null,
          createdAt: now
        })
        await writeActivity(tx, created, [{ kind: 'created', detail: { from: 'GitHub' } }])
        if (input.notice) {
          await tx.insert(taskComments).values({
            id: genId(),
            taskId: created.id,
            userId: project.userId,
            body: input.notice,
            visibility: input.visibility,
            createdVia: 'ui',
            createdAt: now
          })
        }
        return created
      })
      await announce('the new card', async () => {
        announceTaskCreated(project, task, null, 'github')
        await announceBoard(database, input.projectId)
      })
      return cardOf(task)
    },

    async updateCard(task: CardTask, patch: CardPatch) {
      const values: Partial<typeof projectTasks.$inferInsert> = { updatedAt: Date.now() }
      if (patch.title !== undefined) values.title = patch.title
      if (patch.description !== undefined) values.description = patch.description
      if (patch.tags !== undefined) values.tags = patch.tags
      if (patch.completedAt !== undefined) values.completedAt = patch.completedAt

      // The activity line shows every change the sync makes, title overwrites included, and it is
      // saved with the change: a crash cannot leave the change without its line.
      const activity: ActivityEntry[] = []
      if (patch.title !== undefined && patch.title !== task.title) {
        activity.push({ kind: 'renamed', detail: { from: task.title.slice(0, 200), to: patch.title.slice(0, 200) } })
      }
      if (patch.tags !== undefined) {
        for (const tag of patch.tags.filter(tag => !task.tags.includes(tag))) activity.push({ kind: 'label', detail: { to: tag } })
        for (const tag of task.tags.filter(tag => !patch.tags!.includes(tag))) activity.push({ kind: 'label', detail: { from: tag } })
      }
      if (patch.completedAt !== undefined && (patch.completedAt === null) !== (task.completedAt === null)) {
        activity.push({ kind: patch.completedAt === null ? 'reopened' : 'completed', detail: { from: 'GitHub' } })
      }
      await database.transaction(async (tx) => {
        await tx.update(projectTasks).set(values).where(eq(projectTasks.id, task.id))
        await writeActivity(tx, task, activity)
      })
      await announce('the board refresh', () => announceBoard(database, task.projectId))
    },

    async hasUpdate(task, marker) {
      // Only the tail counts: a marker pasted into the middle of a comment does not match.
      // The syncer writes its markers as the owner's account with createdVia 'github' (older ones 'ui'), so an agent's update never counts.
      const [row] = await database.select({ id: taskComments.id })
        .from(taskComments)
        .where(and(eq(taskComments.taskId, task.id), inArray(taskComments.createdVia, ['ui', 'github']), sql`right(${taskComments.body}, ${marker.length}) = ${marker}`))
        .limit(1)
      return row !== undefined
    },

    async addUpdate(task: CardTask, body: string) {
      const project = await projectRow(database, task.projectId)
      const [row] = await database.select().from(projectTasks).where(eq(projectTasks.id, task.id)).limit(1)
      if (!row) return
      // The update is signed with the project owner's account, as a rule's comment is. The body says who wrote on GitHub.
      await database.insert(taskComments).values({
        id: genId(),
        taskId: task.id,
        userId: project.userId,
        body,
        visibility: task.visibility,
        createdVia: 'github',
        createdAt: Date.now()
      })
      // Saved above, so the update is never lost to a failed notification; the notification is logged if it fails.
      await announce('the notification', () => notifyComment(project, row, null, body, task.visibility === 'internal'))
      await announce('the board refresh', () => announceBoard(database, task.projectId))
    }
  }
}

export const databaseCardStore: GithubCardStore = makeDatabaseCardStore(db)

/** The record of applied deliveries (github_deliveries): the consumer skips a delivery that is in it. */
export function makeDeliveryLedger(database: CardDatabase): DeliveryLedger {
  return {
    async succeeded(deliveryId) {
      const [row] = await database.select({ id: githubDeliveries.id })
        .from(githubDeliveries)
        .where(eq(githubDeliveries.id, deliveryId))
        .limit(1)
      return row !== undefined
    },

    async recordSucceeded(entry) {
      await database.insert(githubDeliveries)
        .values({ id: entry.deliveryId, event: entry.event, owner: entry.owner, repo: entry.repo, receivedAt: entry.receivedAt })
        .onConflictDoNothing()
    }
  }
}

export const databaseDeliveryLedger: DeliveryLedger = makeDeliveryLedger(db)
