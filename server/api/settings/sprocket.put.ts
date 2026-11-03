import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { apiKeys, userSettings } from '../../db/schema'
import { isSprocketEffort, isSprocketModel, mayUseClaude } from '../../utils/sprocketAgent'

export default defineEventHandler(async (event) => {
  const userId = event.context.session.user.id
  const body = await readBody<{
    provider?: unknown
    agentKeyId?: unknown
    model?: unknown
    effort?: unknown
  }>(event)

  const provider = body.provider === 'agent' ? 'agent' : 'openrouter'
  if (body.provider !== 'agent' && body.provider !== 'openrouter') {
    throw createError({ statusCode: 400, message: 'Sprocket is answered by "openrouter" or "agent"' })
  }
  if (provider === 'agent' && !(await mayUseClaude(userId))) {
    throw createError({ statusCode: 403, message: 'Claude Code answers for the instance admin only on this server' })
  }

  let agentKeyId: string | null = null
  if (body.agentKeyId !== null && body.agentKeyId !== undefined && body.agentKeyId !== '') {
    if (typeof body.agentKeyId !== 'string') throw createError({ statusCode: 400, message: 'Unknown agent' })
    const [key] = await db.select({ id: apiKeys.id }).from(apiKeys).where(and(eq(apiKeys.id, body.agentKeyId), eq(apiKeys.userId, userId)))
    if (!key) throw createError({ statusCode: 400, message: 'Unknown agent' })
    agentKeyId = key.id
  }

  const model = typeof body.model === 'string' ? body.model.trim() : 'haiku'
  if (!isSprocketModel(model)) throw createError({ statusCode: 400, message: 'Model: an alias like haiku, or a full model name' })

  let effort: string | null = null
  if (body.effort !== null && body.effort !== undefined && body.effort !== '') {
    if (!isSprocketEffort(body.effort)) throw createError({ statusCode: 400, message: 'Effort: low, medium, high, xhigh or max' })
    effort = body.effort
  }

  const values = { sprocketProvider: provider, sprocketAgentKeyId: agentKeyId, sprocketModel: model, sprocketEffort: effort, updatedAt: new Date() } as const
  await db
    .insert(userSettings)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: userSettings.userId, set: values })

  return { provider, agentKeyId, model, effort }
})
