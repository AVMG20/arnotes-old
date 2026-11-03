import { listPins } from '../../utils/boardPins'

// The caller's pinned boards across every workspace they have.
export default defineEventHandler(event => listPins(event.context.session.user.id))
