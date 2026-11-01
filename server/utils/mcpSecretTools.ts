// Agent tools for a project's secrets. The same rules as Settings > Secrets and the
// app API (projectSecrets.ts), applied to the person behind the key: their vault
// role on the project decides what they may read and change, and a secret they may
// not read is as good as absent. Values leave only through get_project_env, which
// the trail records; nothing here echoes a value back, and no message names one.
import { findStaffBoard } from './mcpBoardTools'
import { McpToolError, asToolErrorAsync, optionalStringArray, requireString } from './mcpToolKit'
import type { McpToolDefinition } from './mcpToolKit'
import { vaultRoleOf } from './projectMembers'
import type { VaultRole } from './projectMembers'
import { MAX_SECRET_NAME, MAX_SECRET_VALUE, SECRET_NAME_PATTERN, exportEnv, listSecrets, removeSecret, saveSecret, secretInputOf } from './projectSecrets'
import type { SecretInput, VaultProject } from './projectSecrets'
import { secretsUnavailableReason } from './secretCrypto'
import type { ApiKeyContext } from './api-keys'

const MAX_BULK = 50

const BOARD = { type: 'string', description: 'Board id, board name, or a link to the board.' }
const NAME = {
  type: 'string',
  description: `The variable name, such as DATABASE_URL: letters, digits and underscores, not starting with a digit, at most ${MAX_SECRET_NAME} characters. Kept exactly as written.`
}
const VALUE = { type: 'string', description: `The value, at most ${MAX_SECRET_VALUE} characters; it may be empty. Leave it out on an existing name to keep the stored value.` }
const ACCESS = {
  type: 'string',
  enum: ['managers', 'members'],
  description: '"managers" (the default) for project managers only, or "members" for every project member.'
}

function boardRef(board: VaultProject & { name: string }) {
  return { id: board.id, name: board.name }
}

/** The board, and the person's vault role on it (null when they have none). */
async function vaultFor(reference: string, context: ApiKeyContext) {
  const board = await findStaffBoard(reference, context, 'the secrets')
  const role: VaultRole | null = await vaultRoleOf(board, context.userId)
  return { board, role }
}

function isSecretName(name: string): boolean {
  return name.length <= MAX_SECRET_NAME && SECRET_NAME_PATTERN.test(name)
}

/** What the arguments ask for: one secret from name and value, or many from variables. */
function secretInputsOf(args: Record<string, unknown>): SecretInput[] {
  const hasName = args.name !== undefined
  const hasVariables = args.variables !== undefined
  if (hasName === hasVariables) {
    throw new McpToolError('Give either "name" with "value", or "variables" with NAME: "value" pairs. Not both, and not neither.')
  }

  if (!hasVariables) {
    if (typeof args.name !== 'string') throw new McpToolError('"name" must be text.')
    return [secretInputOf(args)]
  }

  if (args.description !== undefined || args.access !== undefined) {
    throw new McpToolError('"description" and "access" go with a single "name", not with "variables".')
  }
  const variables = args.variables
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
    throw new McpToolError('"variables" is an object of NAME: "value" pairs.')
  }
  const entries = Object.entries(variables as Record<string, unknown>)
  if (entries.length === 0) throw new McpToolError('"variables" is empty: give at least one NAME: "value" pair.')
  if (entries.length > MAX_BULK) {
    throw new McpToolError(`At most ${MAX_BULK} secrets at a time. Nothing was changed; send the rest in another call.`)
  }

  // Every problem is reported at once, and nothing is written unless all of them pass.
  const badNames = entries.map(([name]) => name).filter(name => !isSecretName(name))
  const badValues = entries
    .filter(([, value]) => typeof value !== 'string' || value.length > MAX_SECRET_VALUE)
    .map(([name]) => name)
  if (badNames.length > 0 || badValues.length > 0) {
    const problems = [
      ...badNames.map(name => `"${name}" is not a valid name`),
      ...badValues.map(name => `${name} needs a text value of at most ${MAX_SECRET_VALUE} characters`)
    ]
    const nameRule = badNames.length > 0
      ? ` A name uses only letters, digits and underscores, does not start with a digit, and is at most ${MAX_SECRET_NAME} characters.`
      : ''
    throw new McpToolError(`Nothing was changed. ${problems.join('; ')}.${nameRule}`)
  }
  return entries.map(([name, value]) => ({ name, value: value as string }))
}

export const MCP_SECRET_TOOLS: McpToolDefinition[] = [
  {
    name: 'list_project_secrets',
    title: 'List a project\'s secrets',
    description: 'List the secrets of a project by name: each one\'s description, whether it is for managers only or for every member, and when it was last changed and by whom. Values are never listed; get_project_env returns them. Also says your role on the project (manager, member, or null when you have none) and whether encryption is set up on this server.',
    scope: 'secrets:read',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { board: BOARD },
      required: ['board']
    },
    async handler(args, context) {
      const { board, role } = await vaultFor(requireString(args, 'board'), context)
      const secrets = await asToolErrorAsync(() => listSecrets(board, role))
      const reason = secretsUnavailableReason()
      return { board: boardRef(board), role, enabled: reason === null, reason, secrets }
    }
  },
  {
    name: 'get_project_env',
    title: 'Get a project\'s .env',
    audit: true,
    description: 'The project\'s secrets as .env text (NAME=value lines, sorted by name): every secret you may read, or only the names given. The server cannot write files on the agent\'s machine, so write the returned text to the project\'s .env yourself, and make sure .env is git-ignored first. Do not paste values into task updates, messages or chat. The download is recorded in the project\'s trail. Written for shells and Docker Compose: the node dotenv package reads backslashes and \\$ differently.',
    scope: 'secrets:read',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        board: BOARD,
        names: { type: 'array', items: { type: 'string' }, description: 'Only these secrets, by name. Leave out for every secret you may read.' }
      },
      required: ['board']
    },
    async handler(args, context) {
      const { board, role } = await vaultFor(requireString(args, 'board'), context)
      const names = optionalStringArray(args, 'names')
      const exported = await asToolErrorAsync(() => exportEnv(board, role, context.userId, 'mcp', names))
      return { board: boardRef(board), names: exported.names, env: exported.env }
    }
  },
  {
    name: 'set_project_secrets',
    title: 'Add or change project secrets',
    description: `Add or change secrets by the variable name you choose. Either one: "name" with "value" (and optionally "description" and "access"), or many at once: "variables" as {NAME: "value"} pairs, up to ${MAX_BULK}. A name that exists is updated, a new one is added. Managers only. Returns created or updated for each name, never values. If any name is invalid, nothing is changed and every invalid name is listed in one message.`,
    scope: 'secrets:write',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        board: BOARD,
        name: NAME,
        value: VALUE,
        description: { type: 'string', description: 'A note on what the secret is for, at most 200 characters. Kept when left out.' },
        access: ACCESS,
        variables: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: `Many secrets at once: {"NAME": "value", ...}, up to ${MAX_BULK}. Use either this or "name" with "value".`
        }
      },
      required: ['board']
    },
    async handler(args, context) {
      const { board, role } = await vaultFor(requireString(args, 'board'), context)
      const inputs = secretInputsOf(args)

      const saved = await asToolErrorAsync(async () => {
        const results: { name: string, action: 'created' | 'updated', access: string }[] = []
        for (const input of inputs) {
          const { created, secret } = await saveSecret(board, role, context.userId, 'mcp', input, 'upsert')
          results.push({ name: secret.name, action: created ? 'created' : 'updated', access: secret.access })
        }
        return results
      })
      return { board: boardRef(board), saved }
    }
  },
  {
    name: 'delete_project_secret',
    title: 'Delete a project secret',
    description: 'Delete one secret of a project, by name. Managers only. A deleted secret cannot be restored, and its value is gone; the trail keeps a record that it was deleted.',
    scope: 'secrets:write',
    readOnly: false,
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: { board: BOARD, name: NAME },
      required: ['board', 'name']
    },
    async handler(args, context) {
      const { board, role } = await vaultFor(requireString(args, 'board'), context)
      const name = requireString(args, 'name')
      await asToolErrorAsync(() => removeSecret(board, role, context.userId, 'mcp', name))
      return { board: boardRef(board), name, removed: true }
    }
  }
]
