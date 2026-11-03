import { requireTask } from '../../../../utils/projects'
import { blockedState, listBlockers } from '../../../../utils/taskDependencyService'

// The blockers of a task the caller may see, and whether the task is blocked now.
// Open blocker ids are not returned: a customer must not learn the id of a hidden task.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { task, project } = await requireTask(event, id)
  const viewer = { userId: event.context.session.user.id, audience: project.audience }
  const [blockers, state] = await Promise.all([listBlockers(task.id, viewer), blockedState(task.id)])
  return { blocked: state.blocked, blockers }
})
