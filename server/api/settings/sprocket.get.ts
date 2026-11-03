import { desc, eq } from 'drizzle-orm'
import { db } from '../../db'
import { apiKeys, organization, userSettings } from '../../db/schema'
import { claudeBinary, claudeVersion, mayUseClaude, SPROCKET_EFFORTS, SPROCKET_MODEL_ALIASES } from '../../utils/sprocketAgent'

/**
 * Who answers as Sprocket, and what there is to choose from: the caller's agents (API keys,
 * from every workspace, since a key belongs to one) and whether Claude Code can run here.
 */
export default defineEventHandler(async (event) => {
  const userId = event.context.session.user.id

  const [[settings], keys, allowed] = await Promise.all([
    db.select().from(userSettings).where(eq(userSettings.userId, userId)),
    db
      .select({ key: apiKeys, teamName: organization.name })
      .from(apiKeys)
      .leftJoin(organization, eq(organization.id, apiKeys.teamId))
      .where(eq(apiKeys.userId, userId))
      .orderBy(desc(apiKeys.createdAt)),
    mayUseClaude(userId)
  ])

  const bin = allowed ? claudeBinary() : null
  const now = Date.now()

  return {
    provider: settings?.sprocketProvider ?? 'openrouter',
    agentKeyId: settings?.sprocketAgentKeyId ?? null,
    model: settings?.sprocketModel ?? 'haiku',
    effort: settings?.sprocketEffort ?? null,
    hasOpenRouterKey: Boolean(settings?.openrouterApiKey),
    openrouterModel: settings?.openrouterModel ?? null,
    agents: keys.map(({ key, teamName }) => ({
      id: key.id,
      name: key.name,
      keyPrefix: key.keyPrefix,
      workspace: key.teamId ? (teamName ?? 'Team') : 'Personal',
      scopes: key.scopes,
      usable: key.scopes.includes('boards:read') && !(key.expiresAt && key.expiresAt <= now)
    })),
    claude: {
      allowed,
      available: Boolean(bin),
      version: bin ? await claudeVersion(bin) : null
    },
    models: SPROCKET_MODEL_ALIASES,
    efforts: SPROCKET_EFFORTS
  }
})
