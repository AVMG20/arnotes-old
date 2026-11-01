import { desc, eq } from 'drizzle-orm'
import { db } from '../../../db'
import { crews, organization } from '../../../db/schema'
import { crewView } from '../../../utils/crewProvisioning'
import { requireInstanceAdmin } from '../../../utils/instanceAdmin'

/**
 * Every crew on the instance, for the instance admin's Crews page: name, team, board link,
 * when it was made, whether it is disabled, and when its keys were last used. No secrets.
 */
export default defineEventHandler(async (event) => {
  await requireInstanceAdmin(event)
  const rows = await db
    .select({ crew: crews, teamName: organization.name })
    .from(crews)
    .leftJoin(organization, eq(organization.id, crews.teamId))
    .orderBy(desc(crews.createdAt))

  const list = []
  for (const { crew, teamName } of rows) {
    const view = await crewView(crew)
    const used = view.people.map(p => p.keyLastUsed).filter((t): t is number => typeof t === 'number')
    list.push({
      id: crew.id,
      slug: crew.slug,
      name: crew.name,
      teamId: crew.teamId,
      teamName: teamName ?? null,
      boardId: crew.boardId,
      boardUrl: view.boardUrl,
      createdAt: crew.createdAt,
      disabledAt: crew.disabledAt,
      keyLastUsed: used.length ? Math.max(...used) : null,
      people: view.people.length
    })
  }
  return { crews: list }
})
