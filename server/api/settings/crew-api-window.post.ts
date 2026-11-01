import { openWindow } from '../../utils/crewGate'
import { requireInstanceAdmin } from '../../utils/instanceAdmin'

// Opens the crew API to remote callers for 10 minutes. The temporary crews:manage key comes
// back once in this response; opening again replaces the key and its time.
export default defineEventHandler(async (event) => {
  await requireInstanceAdmin(event)
  const { token, openUntil } = await openWindow(event.context.session.user.id, Date.now())
  return { open: true, openUntil, token }
})
