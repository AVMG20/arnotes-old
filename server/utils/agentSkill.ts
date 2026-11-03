// The agent skill: a SKILL.md an AI agent can be given so it knows how to work
// with Taskmanager on someone's behalf. It is generated from the tool registry the
// server answers `tools/list` from, so what it says the tools are is what they
// are, and a tool added tomorrow is in it tomorrow.
import { MCP_TOOLS } from './mcpRegistry'
import type { McpToolDefinition } from './mcpToolKit'

// Tools are grouped in the order a person would think of them.
// A group may carry a note: a short paragraph on what its tools have in common.
const GROUPS: { title: string, match: (tool: McpToolDefinition) => boolean, note?: string }[] = [
  { title: 'Boards, columns and tasks', match: tool => /^(list_boards|get_board|get_task|search_tasks|list_task_labels|create_board|update_board|(create|update|delete|restore)_(column|task)|post_task_update|move_task)$/.test(tool.name) },
  {
    title: 'Task updates',
    match: tool => /^(edit|delete)_task_update$/.test(tool.name),
    note: 'An update on a task can be changed or removed by its author: you may change what you posted, or what your key\'s owner posted through an agent. The board\'s owner, or a team owner or admin, may change or remove any update on that board. A customer contact may change only the customer-visible updates they wrote. An edit keeps the update\'s visibility and reply, marks it edited with the time, and does not tell anyone again; the old text is not kept. A delete removes the update for good, with no trash, and a reply to it stays and shows that its target was deleted. Both are recorded in the key owner\'s Inbox without the text. Read the thread with get_task to find the update id.'
  },
  { title: 'My tasks and my inbox', match: tool => /^(my_tasks|list_notifications|mark_notifications_read)$/.test(tool.name) },
  { title: 'Custom fields', match: tool => /_fields?$/.test(tool.name) },
  {
    title: 'GitHub',
    match: tool => /_github$/.test(tool.name),
    note: 'A task can link GitHub issues, pull requests, branches and workflow runs. Each link shows what GitHub says now (state, pull requests, review and check status, branch position, run status), fetched on the server and cached, so the token never reaches you. Links follow the same audience rule as the task: a customer contact sees only the links marked for customers, and linking or unlinking is for the team.'
  },
  {
    title: 'GitHub deliveries',
    match: tool => /^(list_failed_deliveries|get_failed_delivery|retry_failed_delivery|discard_failed_delivery|github_queue_status)$/.test(tool.name),
    note: 'GitHub changes reach Taskmanager as deliveries. One that cannot be applied after its attempts is kept for the PM, any team member may list and read it; retry it once when its cause is gone, or discard it with a reason, is for the crew\'s pm key only. You see only the deliveries of the repositories linked to projects your team works on; any other repository is refused. A retry sends the stored payload back once. Reading one delivery and each retry or discard are written to the agent audit with their outcome; list and status are not. The payload itself is never returned in full.'
  },
  {
    title: 'Rules',
    match: tool => /_rules?$|_rule_runs$/.test(tool.name),
    note: 'Rules run when something happens on a board: a trigger, then the conditions that must hold, then the actions, in order. Anyone on the team may create and change them. Only the project owner may use set_visibility in a rule, which makes a task customer-visible. A rule can be switched off with update_rule and "enabled" alone, and list_rule_runs shows what it did each time it fired. The valid triggers, conditions and actions, with their fields, are listed in the create_rule tool description and in every refusal.'
  },
  {
    title: 'Secrets',
    match: tool => /secret|_env$/.test(tool.name),
    note: 'A project\'s secrets are environment variables, kept encrypted. Only project managers change them, reading a value is recorded in the project\'s trail, and a list never carries values. Never echo a value into a task, a message or chat: keep the values in the project\'s .env file, whose text get_project_env returns.'
  },
  { title: 'Goals and portfolios', match: tool => /_(goals?|portfolios?)$/.test(tool.name) },
  { title: 'Status updates', match: tool => /status_update/.test(tool.name) },
  { title: 'Messages', match: tool => /message/.test(tool.name) && !/notification/.test(tool.name) },
  { title: 'Time', match: tool => /time$/.test(tool.name) }
]

/** The first sentence of a description, enough to choose a tool by. */
function firstSentence(text: string): string {
  const match = /^(.+?[.!?])(\s|$)/.exec(text.trim())
  return (match ? match[1]! : text.trim()).replace(/\s+/g, ' ')
}

function toolLine(tool: McpToolDefinition): string {
  return `- \`${tool.name}\` (${tool.readOnly ? 'read' : 'write'}): ${firstSentence(tool.description)}`
}

export function buildAgentSkill(origin: string): string {
  const grouped = new Set<string>()
  const sections = GROUPS.map((group) => {
    const tools = MCP_TOOLS.filter(tool => !grouped.has(tool.name) && group.match(tool))
    tools.forEach(tool => grouped.add(tool.name))
    const intro = group.note ? `${group.note}\n\n` : ''
    return tools.length ? `### ${group.title}\n\n${intro}${tools.map(toolLine).join('\n')}` : ''
  }).filter(Boolean)

  const rest = MCP_TOOLS.filter(tool => !grouped.has(tool.name))
  if (rest.length) sections.push(`### Other\n\n${rest.map(toolLine).join('\n')}`)

  return `---
name: taskmanager
description: Work with a person's Taskmanager boards, tasks, time, messages and inbox over MCP, acting as that person. Use when the user asks about their projects or tasks, wants work filed, updated or reported, or wants time logged or a status update posted.
---

# Taskmanager

Taskmanager is a project and task manager: boards of tasks in columns, with
dates, assignees, custom fields, status updates, messages, time tracking and an
inbox. This skill lets you read and change it for the person whose API key you
were given.

## Connecting

The server speaks MCP over HTTP at \`${origin.replace(/\/$/, '')}/api/mcp\` and
expects \`Authorization: Bearer <api key>\`. The person creates the key under
Settings, chooses its permissions and can revoke it at any time:

- \`boards:read\` lets you read.
- \`boards:write\` lets you change things.
- \`secrets:read\` lets you list a project's secrets and get its .env text.
- \`secrets:write\` lets you add, change and delete a project's secrets (managers only).

A key belongs to one workspace (their personal one, or one team). Never print the
key, put it in a file you commit, or paste it into a task or message.

## You act as the person, and no more

A key is the person acting through you. You can open the same boards they can
and you see the same things they see on them. Anything hidden from them is hidden
from you, and anything the app would refuse them is refused to you.

- **On their team's boards** you see every task, update and custom field.
- **On a customer's board, as a customer's contact**, you see only tasks and
  updates that are shared with customers, no custom fields, and none of the
  team's status updates, messages or time. You can file a task. You cannot plan
  it (dates, assignee, done mark, fields), change it, or change the board.
- Trashed things are not there. Deleting puts things in the board's trash, which
  the person can restore; nothing here deletes for good (the one exception is an update removed with delete_task_update, which is gone at once), and boards cannot be
  deleted over MCP.

When a tool refuses with a reason that names a customer role, that is the rule
working, not a fault: tell the person what you could not do and why, and do not
look for another route to it.

## How to work

1. **Read before you write.** \`get_board\` gives the board, column and task names
   exactly as written; use them verbatim. \`get_task\` has the full description
   and the thread of updates, oldest first. On a long one, read a slice first (see "Reading a long thread").
2. **Say what you will change, then change only that.** Writes replace the value
   you send, so for a description read the task first and send the whole text.
3. **Clearing:** pass an empty string to clear a date or assignee, and \`null\` to
   clear a custom field value.
4. **Dates** are \`YYYY-MM-DD\`. **Durations** are written like \`1h 30m\`, \`1:30\`
   or \`45m\`; a bare number is hours.
5. **Be brief in what you post.** Updates, messages and status updates are read
   by people; say what changed and why in a few sentences.
6. **Check your result.** Write tools return the card or entry as it is stored;
   read it rather than assuming.

## Reading a long thread

\`get_task\` returns the whole thread unless you ask for less. On a long one, read the latest updates first and fetch the whole thread only when you need it. One example per option:

- \`limit\`: \`{"id": "<task id>", "limit": 5}\` gives the five oldest updates; with \`"order": "newest"\` it gives the five newest.
- \`order\`: \`{"id": "<task id>", "order": "newest"}\` lists the thread newest first. The default is \`"oldest"\`.
- \`since\`: \`{"id": "<task id>", "since": "2026-11-02T10:00:00Z"}\` gives the updates strictly after that time. The time must be a full ISO 8601 time with a zone; an update id works too.
- \`prefix\`: \`{"id": "<task id>", "prefix": "NITPICKER:"}\` gives the updates whose body starts with that text, ignoring case.

Filters apply before the limit, so \`{"id": "<task id>", "prefix": "QUESTION", "order": "newest", "limit": 1}\` is the latest question. The result says \`updatesMatched\` (how many matched in all) and \`updatesShown\` (how many came back). When they differ you have a slice, not the whole thread. Counts cover only the updates you may see. There is no paging: to read on, pass \`since\` with the id of the last update you have, which is the cursor to prefer. \`since\` is strictly after, so an update made in the same millisecond as the mark is left out. A thread over 5000 updates is cut, and the result says so in \`threadNote\`: use \`since\`.

## Tools
## Tools

${sections.join('\n\n')}

Each tool's full description and parameters are in the server's \`tools/list\`
answer; trust that over this summary if they differ.
`
}
