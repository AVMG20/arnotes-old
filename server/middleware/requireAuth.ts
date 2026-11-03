import { auth } from '../lib/auth'
import { crewAccountLive, isCrewAddress } from '../utils/crewAccounts'

// Everything under these needs a session. `/api/invitations` is deliberately not
// here: an invite link has to be readable before its recipient has an account.
const PROTECTED_PREFIXES = [
  '/api/settings',
  '/api/ai',
  '/api/chat',
  '/api/teams',
  '/api/projects',
  '/api/tasks',
  '/api/columns',
  '/api/notifications',
  '/api/pins',
  '/api/agent-audit',
  '/api/goals',
  '/api/portfolios',
  '/api/time',
  '/api/timer',
  '/api/customers',
  '/api/admin',
  '/api/github'
]

// GitHub calls this itself, so it carries no session. It proves who it is with the
// X-Hub-Signature-256 header, checked in the route.
const WEBHOOK_PATHS = ['/api/github/webhook']

export default defineEventHandler(async (event) => {
  const path = event.path
  if (WEBHOOK_PATHS.includes(path)) return
  if (!PROTECTED_PREFIXES.some(prefix => path.startsWith(prefix))) return

  const session = await auth.api.getSession({ headers: event.headers })
  if (!session) throw createError({ statusCode: 401, message: 'Unauthorized' })

  // A crew account is refused once its crew is disabled or gone, even on a session that
  // was open before that happened.
  if (isCrewAddress(session.user.email) && !(await crewAccountLive(session.user.id))) {
    throw createError({ statusCode: 401, message: 'Unauthorized' })
  }
  event.context.session = session
})
