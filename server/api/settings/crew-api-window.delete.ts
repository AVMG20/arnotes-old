import { closeWindow, expireWindowIfDue, readGate, windowIsOpen } from '../../utils/crewGate'
import { requireInstanceAdmin } from '../../utils/instanceAdmin'

// Closes the crew API window early and revokes its temporary key. Closing a window that is
// already shut changes nothing.
export default defineEventHandler(async (event) => {
  await requireInstanceAdmin(event)
  const now = Date.now()
  const gate = await expireWindowIfDue(await readGate(), now)
  if (windowIsOpen(gate, now)) await closeWindow('closed by the owner', null, now)
  return { open: false }
})
