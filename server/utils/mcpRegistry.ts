// Every tool the MCP server answers with, gathered from the modules that define
// them. A feature that comes with agent tools adds its module to this list and
// nothing else: the server's `tools/list`, its scope checks and the setup guide's
// catalogue all read from here.
import type { ApiKeyScope } from '../db/schema'
import { MCP_BOARD_TOOLS } from './mcpBoardTools'
import { MCP_FIELD_TOOLS } from './mcpFieldTools'
import { MCP_GITHUB_TOOLS } from './mcpGithubTools'
import { MCP_GOAL_TOOLS } from './mcpGoalTools'
import { MCP_ME_TOOLS } from './mcpMeTools'
import { MCP_MESSAGE_TOOLS } from './mcpMessageTools'
import { MCP_RULE_TOOLS } from './mcpRuleTools'
import { MCP_SECRET_TOOLS } from './mcpSecretTools'
import { MCP_STATUS_TOOLS } from './mcpStatusTools'
import { MCP_TIME_TOOLS } from './mcpTimeTools'
import { MCP_UPDATE_TOOLS } from './mcpUpdateTools'
import type { McpToolDefinition } from './mcpToolKit'

export const MCP_TOOLS: McpToolDefinition[] = [
  ...MCP_BOARD_TOOLS,
  ...MCP_FIELD_TOOLS,
  ...MCP_GITHUB_TOOLS,
  ...MCP_GOAL_TOOLS,
  ...MCP_MESSAGE_TOOLS,
  ...MCP_ME_TOOLS,
  ...MCP_RULE_TOOLS,
  ...MCP_SECRET_TOOLS,
  ...MCP_STATUS_TOOLS,
  ...MCP_TIME_TOOLS,
  ...MCP_UPDATE_TOOLS
]

export function toolsForScopes(scopes: ApiKeyScope[]): McpToolDefinition[] {
  return MCP_TOOLS.filter(tool => scopes.includes(tool.scope))
}
