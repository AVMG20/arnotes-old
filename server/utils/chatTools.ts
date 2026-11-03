// Tool definitions for the AI chat assistant. Tools are advertised to the
// model here (OpenAI-style function schemas) but executed on the client,
// which owns the projects store and the search index.

export interface ChatToolCallDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}

export const CHAT_TOOLS: ChatToolCallDef[] = [
  {
    type: 'function',
    function: {
      name: 'list_boards',
      description: 'List the user\'s kanban project boards (id, name, last updated).',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_board',
      description: 'Read one board in full: its columns (in order) and every task (id, column, title, markdown description, tags, updated). Use before creating or moving tasks so names match.',
      parameters: {
        type: 'object',
        properties: {
          board: { type: 'string', description: 'Board id or name (case-insensitive).' }
        },
        required: ['board']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_board',
      description: 'Create a new kanban board. It starts with the default columns: Backlog, To do, Verify, Done.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Board name.' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_tasks',
      description: 'Search across the tasks of every board by text and/or tags (labels like priority or workstream).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query. Empty string matches all tasks.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags all results must have.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Create a task on a board. Description is markdown; tags are kanban labels (e.g. priority, workstream).',
      parameters: {
        type: 'object',
        properties: {
          board: { type: 'string', description: 'Board id or name.' },
          column: { type: 'string', description: 'Column name, e.g. Backlog, To do, Verify, Done.' },
          title: { type: 'string', description: 'Task title.' },
          description: { type: 'string', description: 'Markdown description. A ```mermaid fence is drawn as a diagram and a ```chart fence as a bar, line or pie chart (lines like "type: bar", "labels: Jan, Feb", "Sales: 12, 19").' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Labels (no # prefix).' }
        },
        required: ['board', 'column', 'title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_task',
      description: 'Edit an existing task. Only provided fields change; description and tags are replaced as a whole when given.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id.' },
          title: { type: 'string', description: 'New title.' },
          description: { type: 'string', description: 'Full replacement markdown description. A ```mermaid fence is drawn as a diagram and a ```chart fence as a bar, line or pie chart (lines like "type: bar", "labels: Jan, Feb", "Sales: 12, 19").' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Full replacement label list.' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'move_task',
      description: 'Move a task to another column of its board, e.g. mark it done.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id.' },
          column: { type: 'string', description: 'Target column name.' }
        },
        required: ['id', 'column']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_task',
      description: 'Move a task to its board\'s trash. Recoverable: the user can restore it from "Show trashed" on the board for 7 days.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id.' }
        },
        required: ['id']
      }
    }
  }
]

/** Sprocket's character, shared by every way Sprocket can be run. */
export const SPROCKET_CHARACTER = 'Your character: quirky and good-humoured, and organised to the bone. You keep an eye on things: when it bears on the question, mention in a line what you noticed on the way, such as a task that is overdue, blocked or has nobody assigned. Keep the humour to a light touch, at most one per reply, and never let it get in the way of the answer.'

export const CHAT_SYSTEM_PROMPT = `You are Sprocket, the AI assistant built into Taskmanager, a self-hosted projects and tasks app. A board (project) has columns (kanban stages like Backlog, To do, Verify, Done) and tasks; a task has a title, a markdown description and labels used for priority or workstream.

${SPROCKET_CHARACTER}

You can search, read, create and edit the user's boards through the provided tools. Ground every answer in tool results — search or inspect first, then answer. After creating or editing anything, briefly confirm what you did; do not dump raw JSON at the user.

Guidelines:
- For board work, use get_board before create_task or move_task so board, column and task names match exactly.
- When editing, always pass complete replacement values for description and tags, not deltas.
- Use "- [ ]" checklist items when the user wants a checklist in a task description.
- Diagrams and charts are fenced code blocks, in replies as well as in task descriptions: a \`\`\`mermaid block (flowchart, sequenceDiagram, gantt, …) is drawn as a diagram; a \`\`\`chart block is drawn as a simple chart. A chart block is a few lines: "type: bar" (or line, pie), optional "title: …", "labels: a, b, c" for the x axis or the pie slices, then one "Series name: 1, 2, 3" line per series. Prefer a chart block over a table when the user asks to visualise numbers, and a mermaid block when they ask for a diagram, flow or timeline.
- delete_task only moves a task to the trash, where the user can restore it — confirm intent in your reply, not with an extra question, when the request was explicit.

Dates are YYYY-MM-DD. Be concise, use markdown, and reply in the user's language.`
