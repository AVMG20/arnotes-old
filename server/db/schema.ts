import { pgTable, text, boolean, timestamp, bigint, integer, numeric, index, uniqueIndex, json, primaryKey, type AnyPgColumn } from 'drizzle-orm/pg-core'

// ─── Better Auth tables ───────────────────────────────────────────────────────

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull(),
  image: text('image'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  twoFactorEnabled: boolean('two_factor_enabled').default(false),
  // The first account on an instance. It runs the instance: it decides who else
  // may own an organisation.
  isInstanceAdmin: boolean('is_instance_admin').notNull().default(false),
  // Handed out by the instance admin. Without it a user can join organisations
  // and customer portals but cannot start an organisation of their own.
  canCreateOrganizations: boolean('can_create_organizations').notNull().default(false),
  // The crew this account belongs to. NULL for people.
  crewId: text('crew_id').references((): AnyPgColumn => crews.id, { onDelete: 'set null' })
})

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  activeOrganizationId: text('active_organization_id')
})

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull()
})

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at')
})

export const passkey = pgTable(
  'passkey',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    publicKey: text('public_key').notNull(),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    credentialID: text('credential_id').notNull(),
    counter: integer('counter').notNull(),
    deviceType: text('device_type').notNull(),
    backedUp: boolean('backed_up').notNull(),
    transports: text('transports'),
    createdAt: timestamp('created_at'),
    aaguid: text('aaguid')
  },
  table => [
    index('passkey_user_id_idx').on(table.userId),
    index('passkey_credential_id_idx').on(table.credentialID)
  ]
)

export const twoFactor = pgTable(
  'two_factor',
  {
    id: text('id').primaryKey(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    verified: boolean('verified').default(true)
  },
  table => [index('two_factor_user_id_idx').on(table.userId)]
)

export const organization = pgTable('organization', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logo: text('logo'),
  createdAt: timestamp('created_at').notNull(),
  metadata: text('metadata'),
  joinCode: text('join_code').unique()
})

export const member = pgTable(
  'member',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    createdAt: timestamp('created_at').notNull()
  },
  // Every authenticated request resolves membership for the active team.
  table => [index('member_org_user_idx').on(table.organizationId, table.userId)]
)

export const invitation = pgTable('invitation', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role'),
  status: text('status').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull(),
  inviterId: text('inviter_id').notNull().references(() => user.id, { onDelete: 'cascade' })
})

// ─── Customers ────────────────────────────────────────────────────────────────

// A client of an organisation. Its projects live in the organisation, and the
// people who log in for it (customer contacts) see only those projects, and only
// what was marked visible to customers.
export const customers = pgTable(
  'customers',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull()
  },
  table => [index('customers_organization_id_idx').on(table.organizationId)]
)

export type Customer = typeof customers.$inferSelect

// A login that belongs to a customer. Kept apart from organisation membership on
// purpose: a customer contact must never pick up staff access by accident.
export const customerMembers = pgTable(
  'customer_members',
  {
    id: text('id').primaryKey(),
    customerId: text('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  table => [
    uniqueIndex('customer_members_customer_user_idx').on(table.customerId, table.userId),
    index('customer_members_user_id_idx').on(table.userId)
  ]
)

// A single-use link that turns whoever opens it into a contact of one customer.
// It also lets that person create an account while sign-up is otherwise closed.
export const customerInvitations = pgTable(
  'customer_invitations',
  {
    id: text('id').primaryKey(),
    customerId: text('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    // Stored as a SHA-256 hash, like API keys: the link is shown once.
    tokenHash: text('token_hash').notNull().unique(),
    // Who the link was meant for, as a label for the list of open invitations.
    label: text('label'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    acceptedBy: text('accepted_by').references(() => user.id, { onDelete: 'set null' }),
    acceptedAt: bigint('accepted_at', { mode: 'number' })
  },
  table => [index('customer_invitations_customer_id_idx').on(table.customerId)]
)

// Who may see a task or a comment. `internal` is the organisation's staff only;
// `customer` adds the contacts of the project's customer. A project without a
// customer has no outside readers, so the value changes nothing there.
export const VISIBILITIES = ['internal', 'customer'] as const
export type Visibility = typeof VISIBILITIES[number]

// ─── App tables ───────────────────────────────────────────────────────────────

// ─── Projects (kanban) ────────────────────────────────────────────────────────

// Where a delete came from. Recorded on the row so the board's trash can tell
// the user's own tidying apart from an agent's, and so a runaway MCP key's work
// can be picked out and restored in one go.
export const DELETION_SOURCES = ['ui', 'mcp', 'ai'] as const
// Who wrote a task update: the same three, and GitHub for the card syncer's copies (no backfill: older copies keep the owner's name).
export const COMMENT_SOURCES = ['ui', 'mcp', 'ai', 'github'] as const
export type CommentSource = typeof COMMENT_SOURCES[number]
// Where an activity line came from: the same three, and GitHub for the card syncer's lines.
export const ACTIVITY_SOURCES = ['ui', 'mcp', 'ai', 'github'] as const
export type ActivitySource = typeof ACTIVITY_SOURCES[number]
export type DeletionSource = typeof DELETION_SOURCES[number]

// How long a trashed column or task is kept before the purge job removes it.
export const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    // NULL = personal workspace.
    teamId: text('team_id').references(() => organization.id, { onDelete: 'cascade' }),
    // The client this project is for. Only a team project can have one, and the
    // customer must belong to that same organisation.
    customerId: text('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    name: text('name').notNull().default('Untitled project'),
    description: text('description').notNull().default(''),
    // Self-reported health shown on the Overview: on_track, at_risk or off_track; NULL = unset.
    status: text('status'),
    // Which dashboard widgets the project shows, in order. NULL is the default set.
    dashboardWidgets: json('dashboard_widgets').$type<string[] | null>(),
    // Colours the user has pinned to this board's task labels, keyed by label.
    // A label with no entry keeps the colour derived from its own text, so a
    // board reads the same as it always did until someone changes one.
    labelColors: json('label_colors').$type<Record<string, string>>().notNull().default({}),
    // A link anyone can open, optionally until a date.
    isPublic: boolean('is_public').notNull().default(false),
    publicUntil: bigint('public_until', { mode: 'number' }),
    // NULL = active. An archived project is read-only and leaves the project list.
    archivedAt: bigint('archived_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull()
  },
  table => [
    index('projects_team_id_idx').on(table.teamId),
    index('projects_customer_id_idx').on(table.customerId)
  ]
)

export type Project = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert

export const projectColumns = pgTable(
  'project_columns',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    // A colour the user picked, from the same palette as the accent in Settings.
    // NULL means the column has not been given one and its dot is still derived
    // from its name, so renaming "To do" to "Done" still turns it green.
    color: text('color'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    // Soft delete. A trashed column keeps its position so restoring puts it
    // back between the same two neighbours it sat between.
    deletedAt: bigint('deleted_at', { mode: 'number' }),
    // Who emptied it and through which door. An agent working overnight is the
    // case this exists for: the board can say "deleted by an MCP key" rather
    // than leaving the user to guess where their column went.
    deletedBy: text('deleted_by').references(() => user.id, { onDelete: 'set null' }),
    deletedVia: text('deleted_via').$type<DeletionSource>()
  },
  table => [index('project_columns_project_id_idx').on(table.projectId)]
)

export type ProjectColumn = typeof projectColumns.$inferSelect

// The project's health over time. `projects.status` is only where it stands now;
// each post here records the status at the moment someone said it, with the
// words that went with it, so the Overview can show how a project got there.
export const projectStatusUpdates = pgTable(
  'project_status_updates',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    body: text('body').notNull().default(''),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  table => [index('project_status_updates_project_id_idx').on(table.projectId)]
)

export type ProjectStatusUpdate = typeof projectStatusUpdates.$inferSelect

export const projectTasks = pgTable(
  'project_tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    columnId: text('column_id').notNull().references(() => projectColumns.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('Untitled'),
    // Rich text (tiptap HTML) — rendered with prose in cards and drawer.
    description: text('description').notNull().default(''),
    // Kanban labels: they annotate tasks (priority, workstream, …) and filter
    // the board view.
    tags: json('tags').$type<string[]>().notNull().default([]),
    // A customer's project is theirs to follow, so its tasks start out visible.
    visibility: text('visibility').$type<Visibility>().notNull().default('customer'),
    // One person owns a task, as in Asana. Staff of the project's organisation or
    // a contact of its customer; cleared if that account goes away.
    assigneeId: text('assignee_id').references(() => user.id, { onDelete: 'set null' }),
    // Who made it. Null for tasks that predate the log, and once that account is gone.
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    // A calendar day, `YYYY-MM-DD`, so it means the same date in every timezone.
    // A task without one still shows the first `@date` in its description.
    dueOn: text('due_on'),
    // When work on it begins, same `YYYY-MM-DD` form; the timeline draws a bar
    // from here to the due date.
    startOn: text('start_on'),
    // Finished, independent of the column it sits in: a board's columns are its
    // sections, and ticking a task off does not have to move it.
    completedAt: bigint('completed_at', { mode: 'number' }),
    // Set on a subtask. Subtasks live in their parent's panel rather than on the
    // board, and go when the parent is removed for good.
    parentTaskId: text('parent_task_id').references((): AnyPgColumn => projectTasks.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    // Deleting a column hands its tasks to a neighbour rather than taking them
    // down with it. This remembers where they came from, so restoring the
    // column can bring them home; any later move clears it, because a task the
    // user has since filed somewhere deliberately should stay where they put it.
    previousColumnId: text('previous_column_id'),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
    deletedBy: text('deleted_by').references(() => user.id, { onDelete: 'set null' }),
    deletedVia: text('deleted_via').$type<DeletionSource>()
  },
  table => [
    index('project_tasks_project_id_idx').on(table.projectId),
    index('project_tasks_column_id_idx').on(table.columnId),
    // My Tasks asks "what is assigned to me" across every board.
    index('project_tasks_assignee_id_idx').on(table.assigneeId),
    index('project_tasks_parent_task_id_idx').on(table.parentTaskId),
    // The trash view and the purge job both ask for "what is deleted here".
    index('project_tasks_deleted_at_idx').on(table.deletedAt)
  ]
)

// What happened to a task, in order, as Asana's activity log shows it: made,
// finished, moved, rescheduled, given to someone. `detail` holds the words the
// entry needs (names, not ids) so it still reads right after a column or a
// person is gone.
export const TASK_ACTIVITY_KINDS = ['created', 'completed', 'reopened', 'moved', 'assigned', 'unassigned', 'due', 'start', 'renamed', 'visibility', 'label', 'blocker_added', 'blocker_removed'] as const
export type TaskActivityKind = typeof TASK_ACTIVITY_KINDS[number]

export const taskActivity = pgTable(
  'task_activity',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull().references(() => projectTasks.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    actorId: text('actor_id').references(() => user.id, { onDelete: 'set null' }),
    // How it was done: the app, an agent over MCP, or the AI assistant.
    via: text('via').$type<ActivitySource>().notNull().default('ui'),
    kind: text('kind').$type<TaskActivityKind>().notNull(),
    detail: json('detail').$type<Record<string, string | null>>().notNull().default({}),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  table => [index('task_activity_task_id_idx').on(table.taskId, table.createdAt)]
)

export type ProjectTask = typeof projectTasks.$inferSelect

// Custom fields: columns of a project's own that the list shows and each task
// fills in, such as a priority or an estimate. A field belongs to one project
// and is defined once; the values live in task_field_values, one row per task
// and field, so a field added later costs the existing tasks nothing.
export const FIELD_TYPES = ['text', 'number', 'select', 'date'] as const
export type FieldType = typeof FIELD_TYPES[number]

/** One choice of a select field. The id is what a task stores, so a label can be renamed. */
export interface FieldOption {
  id: string
  label: string
  color: string
}

export const projectFields = pgTable(
  'project_fields',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').$type<FieldType>().notNull(),
    // Only a select field has any.
    options: json('options').$type<FieldOption[]>().notNull().default([]),
    position: integer('position').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  table => [index('project_fields_project_id_idx').on(table.projectId)]
)

export type ProjectField = typeof projectFields.$inferSelect

// Stored as text whatever the field's type: a number as its digits, a date as
// `YYYY-MM-DD`, a select as the option's id. A task with nothing to say for a
// field has no row, which is also what clearing one does.
export const taskFieldValues = pgTable(
  'task_field_values',
  {
    taskId: text('task_id').notNull().references(() => projectTasks.id, { onDelete: 'cascade' }),
    fieldId: text('field_id').notNull().references(() => projectFields.id, { onDelete: 'cascade' }),
    value: text('value').notNull()
  },
  table => [
    primaryKey({ columns: [table.taskId, table.fieldId] }),
    index('task_field_values_field_id_idx').on(table.fieldId)
  ]
)

// What someone has been told: one row per person per event, so a notification
// can be read, marked read and listed without touching what it was about. It
// names the project (and task) it points at and carries the words as they were
// when it was sent; whether the recipient may still open it is decided when they
// do. `emailedAt` is when a copy went out by mail, if it did.
export const NOTIFICATION_TYPES = ['assigned', 'comment', 'message', 'reply', 'update'] as const
export type NotificationType = typeof NOTIFICATION_TYPES[number]

export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    type: text('type').$type<NotificationType>().notNull(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => projectTasks.id, { onDelete: 'cascade' }),
    actorId: text('actor_id').references(() => user.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    readAt: bigint('read_at', { mode: 'number' }),
    emailedAt: bigint('emailed_at', { mode: 'number' })
  },
  table => [
    index('notifications_user_created_idx').on(table.userId, table.createdAt),
    index('notifications_user_read_idx').on(table.userId, table.readAt)
  ]
)

export type Notification = typeof notifications.$inferSelect

// How each person wants to hear: the inbox always, and by mail or as a desktop
// notification only if they asked.
export const notificationPreferences = pgTable('notification_preferences', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  email: boolean('email').notNull().default(false),
  browser: boolean('browser').notNull().default(false)
})

// Goals and portfolios sit above projects, for the team that runs them. Like
// projects they belong to a workspace: a team, or one person's own space.
// A goal says what the work is for; its progress is typed in, or read from the
// projects linked to it. Goals can nest.
export const goals = pgTable(
  'goals',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    teamId: text('team_id').references(() => organization.id, { onDelete: 'cascade' }),
    ownerId: text('owner_id').references(() => user.id, { onDelete: 'set null' }),
    parentId: text('parent_id').references((): AnyPgColumn => goals.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    // on_track, at_risk, off_track, achieved or dropped; NULL = not set.
    status: text('status'),
    // 0-100, typed in; ignored while progressFromProjects is on.
    progress: integer('progress').notNull().default(0),
    progressFromProjects: boolean('progress_from_projects').notNull().default(false),
    dueOn: text('due_on'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull()
  },
  table => [index('goals_team_id_idx').on(table.teamId), index('goals_user_id_idx').on(table.userId)]
)

export type Goal = typeof goals.$inferSelect

export const goalProjects = pgTable(
  'goal_projects',
  {
    goalId: text('goal_id').notNull().references(() => goals.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' })
  },
  table => [primaryKey({ columns: [table.goalId, table.projectId] })]
)

// A named set of projects, read together: each one's health and how much of it
// is done.
export const portfolios = pgTable(
  'portfolios',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    teamId: text('team_id').references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull()
  },
  table => [index('portfolios_team_id_idx').on(table.teamId), index('portfolios_user_id_idx').on(table.userId)]
)

export type Portfolio = typeof portfolios.$inferSelect

export const portfolioProjects = pgTable(
  'portfolio_projects',
  {
    portfolioId: text('portfolio_id').notNull().references(() => portfolios.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' })
  },
  table => [primaryKey({ columns: [table.portfolioId, table.projectId] })]
)

// One row for each browser or device that said yes to Web Push. The endpoint is
// the push service's address for that device; the two keys are what a message to
// it is encrypted with. A device the push service reports gone is deleted.
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent').notNull().default(''),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastSentAt: bigint('last_sent_at', { mode: 'number' })
  },
  table => [
    uniqueIndex('push_subscriptions_endpoint_idx').on(table.endpoint),
    index('push_subscriptions_user_idx').on(table.userId)
  ]
)

// Conversations on a project, kept apart from the work: a message has an
// optional subject, and a reply is a message whose parent is another. Replies go
// with the message they answer.
export const projectMessages = pgTable(
  'project_messages',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    parentId: text('parent_id').references((): AnyPgColumn => projectMessages.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    body: text('body').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  table => [
    index('project_messages_project_id_idx').on(table.projectId),
    index('project_messages_parent_id_idx').on(table.parentId)
  ]
)

export type ProjectMessage = typeof projectMessages.$inferSelect

// Time spent, as the people who spent it logged it: whole minutes against a task
// on a calendar day. The project is kept on the row so a project's timesheet is
// one query, and it goes with the task or the project.
export const timeEntries = pgTable(
  'time_entries',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull().references(() => projectTasks.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    minutes: integer('minutes').notNull(),
    // `YYYY-MM-DD`: the day the work was done, which is not always the day it was logged.
    day: text('day').notNull(),
    note: text('note').notNull().default(''),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  table => [
    index('time_entries_task_id_idx').on(table.taskId),
    index('time_entries_project_day_idx').on(table.projectId, table.day),
    index('time_entries_user_day_idx').on(table.userId, table.day)
  ]
)

export type TimeEntry = typeof timeEntries.$inferSelect

// The timer someone has running: at most one each, because starting another
// stops the first and logs it.
export const timeTimers = pgTable('time_timers', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  taskId: text('task_id').notNull().references(() => projectTasks.id, { onDelete: 'cascade' }),
  startedAt: bigint('started_at', { mode: 'number' }).notNull()
})

export const taskComments = pgTable(
  'task_comments',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull().references(() => projectTasks.id, { onDelete: 'cascade' }),
    // The account the update belongs to. An agent posts under the key owner's
    // account because that is whose workspace it is, but it does not get to
    // wear their name — see `createdVia` below.
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    // Inline Markdown, stored as written. A person types it in the drawer and an
    // agent posts it over MCP; both speak the same narrow subset.
    body: text('body').notNull(),
    // Comments start internal: a remark leaking to a customer is the expensive
    // mistake, so sharing one has to be a choice.
    visibility: text('visibility').$type<Visibility>().notNull().default('internal'),
    // Which door the update came through, the same three as a deletion. An
    // update posted by an agent is signed with the key's name rather than the
    // owner's, so a log the user reads back says who was really working.
    createdVia: text('created_via').$type<CommentSource>().notNull().default('ui'),
    apiKeyId: text('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    // Set when the author rewrote it, so the thread can say so.
    editedAt: bigint('edited_at', { mode: 'number' }),
    // The comment this one answers. No foreign key on purpose: when the target is
    // deleted its id stays, so the reply can say the target was deleted.
    replyToId: text('reply_to_id')
  },
  table => [index('task_comments_task_id_idx').on(table.taskId)]
)

export type TaskComment = typeof taskComments.$inferSelect

// ─── User settings ────────────────────────────────────────────────────────────

export const userSettings = pgTable('user_settings', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  primaryColor: text('primary_color').notNull().default('emerald'),
  neutralColor: text('neutral_color').notNull().default('zinc'),
  openrouterApiKey: text('openrouter_api_key'),
  openrouterModel: text('openrouter_model').notNull().default('openai/gpt-4o-mini'),
  // Who answers as Sprocket: OpenRouter with the key above, or Claude Code (`claude -p`)
  // working through the MCP endpoint as one of the person's own API keys.
  sprocketProvider: text('sprocket_provider').$type<'openrouter' | 'agent'>().notNull().default('openrouter'),
  sprocketAgentKeyId: text('sprocket_agent_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
  sprocketModel: text('sprocket_model').notNull().default('haiku'),
  // null leaves the effort to Claude Code's own default
  sprocketEffort: text('sprocket_effort'),
  updatedAt: timestamp('updated_at').notNull()
})

export type UserSettings = typeof userSettings.$inferSelect

// Stores usage metadata only. Prompt and response text are intentionally never persisted.
export const aiUsageRecords = pgTable(
  'ai_usage_records',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    cost: numeric('cost', { precision: 14, scale: 8 }).notNull().default('0'),
    createdAt: timestamp('created_at').notNull().defaultNow()
  },
  table => [index('ai_usage_records_user_created_at_idx').on(table.userId, table.createdAt)]
)

export type AiUsageRecord = typeof aiUsageRecords.$inferSelect

export const AI_SETTINGS_DEFAULTS = {
  openrouterModel: 'openai/gpt-4o-mini'
} as const

export const POPULAR_OPENROUTER_MODELS = [
  'openai/gpt-4o-mini',
  'openai/gpt-4o',
  'openai/gpt-4.1-mini',
  'anthropic/claude-3.5-haiku',
  'anthropic/claude-3.5-sonnet',
  'google/gemini-flash-1.5',
  'google/gemini-pro-1.5',
  'meta-llama/llama-3.3-70b-instruct',
  'mistralai/mistral-large',
  'deepseek/deepseek-chat'
] as const

// ─── API keys (MCP + programmatic access) ─────────────────────────────────────

// Permissions a key can carry, one pair per feature. Read covers listing,
// searching and reading; write covers everything that changes data.
export const API_KEY_SCOPES = ['boards:read', 'boards:write', 'secrets:read', 'secrets:write', 'crews:manage'] as const
export type ApiKeyScope = typeof API_KEY_SCOPES[number]

export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    // The workspace this key can reach. NULL means the owner's personal workspace;
    // otherwise the key is pinned to one team and never follows the owner around.
    teamId: text('team_id').references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Only the SHA-256 digest is stored — the key itself is shown once, at creation.
    keyHash: text('key_hash').notNull().unique(),
    // Leading characters of the key, kept so the UI can identify it after the fact.
    keyPrefix: text('key_prefix').notNull(),
    scopes: json('scopes').$type<ApiKeyScope[]>().notNull().default([]),
    lastUsedAt: bigint('last_used_at', { mode: 'number' }),
    expiresAt: bigint('expires_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  table => [index('api_keys_user_idx').on(table.userId)]
)

export type ApiKey = typeof apiKeys.$inferSelect

// ─── GitHub integration ───────────────────────────────────────────────────────

// What a link on a task points at. `ref` holds the issue or PR number, the
// branch name, or the workflow run id, as text, so one column serves all four.
export const GITHUB_LINK_KINDS = ['issue', 'pull', 'branch', 'workflow_run'] as const
export type GithubLinkKind = typeof GITHUB_LINK_KINDS[number]

// Links are the task's own history: they hang off the task and project, and
// nothing cascades from a customer, so a change of customer keeps them.
export const githubLinks = pgTable(
  'github_links',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    taskId: text('task_id').notNull().references(() => projectTasks.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<GithubLinkKind>().notNull(),
    owner: text('owner').notNull(),
    repo: text('repo').notNull(),
    ref: text('ref').notNull(),
    url: text('url').notNull(),
    // Same rule as tasks and comments: internal unless someone chooses otherwise.
    visibility: text('visibility').$type<Visibility>().notNull().default('internal'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  table => [
    index('github_links_task_id_idx').on(table.taskId),
    index('github_links_project_id_idx').on(table.projectId)
  ]
)

export type GithubLink = typeof githubLinks.$inferSelect

// Fetched GitHub responses, keyed by the request they answer. `etag` lets a
// refresh ask "changed since?" and get a free 304 back.
export const githubCache = pgTable(
  'github_cache',
  {
    id: text('id').primaryKey(),
    key: text('key').notNull().unique(),
    kind: text('kind').notNull(),
    etag: text('etag'),
    // HTTP status of the last answer, and the response body as received.
    status: integer('status'),
    body: json('body'),
    fetchedAt: bigint('fetched_at', { mode: 'number' }).notNull(),
    // Set after a rate limit or error, so we do not hammer GitHub before then.
    nextRetryAt: bigint('next_retry_at', { mode: 'number' })
  }
)

export type GithubCacheEntry = typeof githubCache.$inferSelect

// Per-project GitHub defaults: `#123` resolves against the default repo, and new
// links take the default visibility.
export const projectGithubSettings = pgTable('project_github_settings', {
  projectId: text('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
  defaultRepo: text('default_repo'),
  defaultVisibility: text('default_visibility').$type<Visibility>().notNull().default('internal')
})

export type ProjectGithubSettings = typeof projectGithubSettings.$inferSelect

// Repositories a project can link issues and pull requests from. The default
// lives in project_github_settings, so it is not repeated here.
export const projectGithubRepos = pgTable(
  'project_github_repos',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    owner: text('owner').notNull(),
    repo: text('repo').notNull(),
    visibility: text('visibility').$type<Visibility>().notNull().default('internal'),
    // Issue sync: GitHub issues become cards in this project. Off until the owner
    // turns it on. The column and visibility are what the new cards get.
    syncEnabled: boolean('sync_enabled').notNull().default(false),
    syncColumn: text('sync_column').notNull().default('Backlog'),
    syncVisibility: text('sync_visibility').$type<Visibility>().notNull().default('internal'),
    // The GitHub logins whose issues and comments are accepted, lower-cased.
    acceptedLogins: json('accepted_logins').$type<string[]>().notNull().default([]),
    // Issues from anyone else are counted, and the last one is kept so the owner
    // can see why a card did not appear.
    ignoredCount: integer('ignored_count').notNull().default(0),
    lastIgnored: json('last_ignored').$type<{ login: string, number: number, title: string, at: number } | null>(),
    // Comma separated branch names. Production empty means the default branch.
    stagingBranches: text('staging_branches').notNull().default(''),
    productionBranches: text('production_branches').notNull().default(''),
    // Off: closing the GitHub issue only tags the card 'issue closed'.
    completeOnClose: boolean('complete_on_close').notNull().default(false),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  table => [uniqueIndex('project_github_repos_project_repo_idx').on(table.projectId, table.owner, table.repo)]
)

export type ProjectGithubRepo = typeof projectGithubRepos.$inferSelect

// Who changed a linked repository's settings, and what from what to what. The
// settings page reads the latest rows, so the owner can see who turned sync on.
export const projectGithubAudit = pgTable(
  'project_github_audit',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    // owner/repo, kept as text so the line still reads after the repository is unlinked.
    repo: text('repo').notNull(),
    // Field name -> the words before and after. Never a secret.
    detail: json('detail').$type<Record<string, { from: string, to: string }>>().notNull().default({}),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  table => [index('project_github_audit_project_created_idx').on(table.projectId, table.createdAt)]
)

export type ProjectGithubAudit = typeof projectGithubAudit.$inferSelect

// Webhook deliveries already handled, by GitHub's X-GitHub-Delivery id, so a retry of
// the same delivery is not handled twice. Kept a day and pruned by received_at.
export const githubDeliveries = pgTable(
  'github_deliveries',
  {
    id: text('id').primaryKey(),
    event: text('event').notNull(),
    owner: text('owner').notNull(),
    repo: text('repo').notNull(),
    receivedAt: bigint('received_at', { mode: 'number' }).notNull()
  },
  table => [index('github_deliveries_received_at_idx').on(table.receivedAt)]
)

export type GithubDelivery = typeof githubDeliveries.$inferSelect

// The GitHub deliveries that gave up, one row each (id = the delivery id). The consumer writes the row before it
// copies the delivery to the failed queue; the PM reads and changes it. The payload is the signed body as received,
// removed by the janitor after 30 days (payload null then); the metadata stays.
export const githubDeliveryFailures = pgTable(
  'github_delivery_failures',
  {
    id: text('id').primaryKey(),
    deliveryId: text('delivery_id').notNull().unique(),
    event: text('event').notNull(),
    owner: text('owner'),
    repo: text('repo'),
    repoId: bigint('repo_id', { mode: 'number' }),
    attempts: integer('attempts').notNull(),
    class: text('class').notNull(),
    reason: text('reason'),
    payload: text('payload'),
    firstSeenAt: bigint('first_seen_at', { mode: 'number' }).notNull(),
    failedAt: bigint('failed_at', { mode: 'number' }).notNull(),
    state: text('state').notNull().default('failed'),
    retriedCount: integer('retried_count').notNull().default(0),
    handledBy: text('handled_by'),
    handledAt: bigint('handled_at', { mode: 'number' }),
    handledReason: text('handled_reason')
  },
  table => [index('github_delivery_failures_state_idx').on(table.state), index('github_delivery_failures_failed_at_idx').on(table.failedAt)]
)

export type GithubDeliveryFailure = typeof githubDeliveryFailures.$inferSelect

// Automation rules for a project. trigger, conditions and actions are JSON
// documents whose shape is validated by the rule model, not by the database.
export const projectRules = pgTable(
  'project_rules',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    trigger: json('trigger').notNull(),
    conditions: json('conditions').notNull().default([]),
    actions: json('actions').notNull().default([]),
    position: integer('position').notNull().default(0),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull()
  },
  table => [index('project_rules_project_id_idx').on(table.projectId)]
)

export type ProjectRule = typeof projectRules.$inferSelect
export type NewProjectRule = typeof projectRules.$inferInsert

// One line per rule firing. task_id has no foreign key: a task can be deleted
// while its run history stays readable.
export const projectRuleRuns = pgTable(
  'project_rule_runs',
  {
    id: text('id').primaryKey(),
    ruleId: text('rule_id').notNull().references(() => projectRules.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    taskId: text('task_id'),
    trigger: text('trigger').notNull(),
    // ran, failed or loop_stopped
    outcome: text('outcome').notNull(),
    detail: text('detail').notNull().default(''),
    chainId: text('chain_id').notNull(),
    depth: integer('depth').notNull().default(0),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  table => [index('project_rule_runs_rule_created_idx').on(table.ruleId, table.createdAt)]
)

export type ProjectRuleRun = typeof projectRuleRuns.$inferSelect

// ─── Project members and secrets ──────────────────────────────────────────────

// Who works on a project beyond the people the whole team already shares it with.
// Being on the team is what opens a board; being a project member is what opens
// the project's secrets. A `manager` also looks after the member list and the
// secrets; a `member` reads the secrets that are shared with members. The project
// owner and the team's owners and admins have manager rights without a row.
export const PROJECT_ROLES = ['manager', 'member'] as const
export type ProjectRole = typeof PROJECT_ROLES[number]

export const projectMembers = pgTable(
  'project_members',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').notNull().$type<ProjectRole>(),
    addedBy: text('added_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  table => [
    uniqueIndex('project_members_project_user_idx').on(table.projectId, table.userId),
    index('project_members_user_id_idx').on(table.userId)
  ]
)

export type ProjectMember = typeof projectMembers.$inferSelect

// Who may read a secret's value: only the managers, or every project member.
export const SECRET_ACCESS = ['managers', 'members'] as const
export type SecretAccess = typeof SECRET_ACCESS[number]

// A project's environment variables: API keys, tokens, connection strings. The
// value is stored encrypted (see secretCrypto.ts) and never leaves the server in
// a list; reading one is a separate, audited request.
export const projectSecrets = pgTable(
  'project_secrets',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    // The variable name, as written to a .env file.
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    ciphertext: text('ciphertext').notNull(),
    access: text('access').notNull().default('managers').$type<SecretAccess>(),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    updatedBy: text('updated_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull()
  },
  table => [uniqueIndex('project_secrets_project_name_idx').on(table.projectId, table.name)]
)

export type ProjectSecret = typeof projectSecrets.$inferSelect

// What happened to a project's secrets and members, and who did it. Values are
// never written here. The name is kept as text so a deleted secret's history stays.
export const SECRET_EVENT_ACTIONS = ['create', 'update', 'delete', 'reveal', 'export', 'member_add', 'member_change', 'member_remove'] as const
export type SecretEventAction = typeof SECRET_EVENT_ACTIONS[number]

export const projectSecretEvents = pgTable(
  'project_secret_events',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    action: text('action').notNull().$type<SecretEventAction>(),
    // The secret's name, or the member's name for the member actions.
    subject: text('subject').notNull(),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    via: text('via').notNull().$type<'ui' | 'mcp'>(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  table => [index('project_secret_events_project_created_idx').on(table.projectId, table.createdAt)]
)

export type ProjectSecretEvent = typeof projectSecretEvents.$inferSelect

// ─── Agent audit ──────────────────────────────────────────────────────────────

// What an agent did on someone's behalf through their API key: one row per change
// it made, for the key's owner to read in the Inbox, as if someone else had done
// it. Names are kept as text beside the ids so a row still reads right after the
// board, the task or the key is gone. It never emails or pushes.
export const agentAudit = pgTable(
  'agent_audit',
  {
    id: text('id').primaryKey(),
    // The owner of the key, who hears about it.
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    apiKeyId: text('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    keyName: text('key_name').notNull(),
    tool: text('tool').notNull(),
    toolTitle: text('tool_title').notNull(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    projectName: text('project_name'),
    taskId: text('task_id').references(() => projectTasks.id, { onDelete: 'set null' }),
    taskTitle: text('task_title'),
    // One line on what changed. Never a secret's value.
    summary: text('summary').notNull().default(''),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    readAt: bigint('read_at', { mode: 'number' })
  },
  table => [
    index('agent_audit_user_created_idx').on(table.userId, table.createdAt),
    index('agent_audit_user_read_idx').on(table.userId, table.readAt)
  ]
)

export type AgentAuditRow = typeof agentAudit.$inferSelect

// A crew: one AI-agent team (its own team, customer and board) made through the
// crew API. Crew accounts point at it through user.crewId.
export const crews = pgTable(
  'crews',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    teamId: text('team_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
    boardId: text('board_id').references(() => projects.id, { onDelete: 'set null' }),
    customerId: text('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    product: json('product').$type<{ name: string, repo?: string, appUrl?: string }>(),
    // The user whose crews:manage key created the crew.
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    // NULL while the crew is live; set when it is disabled.
    disabledAt: bigint('disabled_at', { mode: 'number' })
  },
  table => [index('crews_team_id_idx').on(table.teamId)]
)

export type Crew = typeof crews.$inferSelect

// The crew API window (BRIEF-crew-feature 2b): one row, id "gate". While openUntil is
// in the future a remote caller may use the temporary crews:manage key tempKeyId.
// Stored here, not in memory, so a restart neither leaves it open nor loses the reason
// it was closed.
export const crewApiGate = pgTable(
  'crew_api_gate',
  {
    id: text('id').primaryKey(),
    openUntil: bigint('open_until', { mode: 'number' }),
    openedBy: text('opened_by').references(() => user.id, { onDelete: 'set null' }),
    tempKeyId: text('temp_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    closedReason: text('closed_reason'),
    closedFrom: text('closed_from'),
    closedAt: bigint('closed_at', { mode: 'number' })
  }
)

// Every refused call on /api/crews: when, from where (the peer, never a header), what
// was asked and why it was refused. Never the key text.
export const crewApiAudit = pgTable(
  'crew_api_audit',
  {
    id: text('id').primaryKey(),
    at: bigint('at', { mode: 'number' }).notNull(),
    peer: text('peer').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    outcome: text('outcome').notNull(),
    keyPresented: boolean('key_presented').notNull().default(false)
  },
  table => [index('crew_api_audit_at_idx').on(table.at)]
)

// A "blocked by" link (GH #36): the task on the left waits for the task on the right. Only the
// links are stored; whether a task is blocked is derived from them, so it cannot go stale.
// Same board only, and a link is added or removed by staff only (enforced by the routes, not here).
export const taskDependencies = pgTable(
  'task_dependencies',
  {
    id: text('id').primaryKey(),
    blockedTaskId: text('blocked_task_id').notNull().references(() => projectTasks.id, { onDelete: 'cascade' }),
    blockerTaskId: text('blocker_task_id').notNull().references(() => projectTasks.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  table => [
    uniqueIndex('task_dependencies_pair_idx').on(table.blockedTaskId, table.blockerTaskId),
    index('task_dependencies_blocker_idx').on(table.blockerTaskId)
  ]
)

export type TaskDependency = typeof taskDependencies.$inferSelect
