// The "Blocked by" words and the search for a new blocker (GH #36, slice 4). Pure, so the
// board card and the task drawer say the same thing and the tests need no browser.

/** One blocker as the server gives it to this viewer. Hidden ones carry no id, column or state. */
export interface BlockerView {
  id: string | null
  title: string
  visible: boolean
  column: string | null
  finished: boolean | null
}

/** The chip on a card: "Blocked by 2" when the count is known, "Blocked" when only the state is. */
export function blockedChipLabel(count: number | null): string {
  return count && count > 0 ? `Blocked by ${count}` : 'Blocked'
}

/** The sentence under the section heading. */
// A customer sees only the open blockers they may read, so a task blocked only by hidden ones has
// no count to give. That case gets plain words, not "0 open tasks".
export function blockedSummary(blocked: boolean, openCount: number): string {
  if (!blocked) return 'Not waiting for any task on this board.'
  if (openCount === 0) return 'Waiting for work that is not shown here.'
  const noun = openCount === 1 ? 'task' : 'tasks'
  return `Blocked until ${openCount} open ${noun} finish${openCount === 1 ? 'es' : ''}.`
}

/** The same, for a viewer who cannot see every blocker: hidden ones may be open, so a count can only be a floor. */
export function blockedSummaryWithHidden(blocked: boolean, openCount: number, hiddenCount: number): string {
  if (hiddenCount === 0) return blockedSummary(blocked, openCount)
  if (!blocked) return 'Not waiting for any task on this board.'
  if (openCount === 0) return 'Waiting for work that is not shown here.'
  const noun = openCount === 1 ? 'task' : 'tasks'
  return `Blocked until at least ${openCount} open ${noun} finish${openCount === 1 ? 'es' : ''}.`
}
/** What the candidate search says to a screen reader: how many tasks match. */
export function candidateCountWords(count: number, query: string): string {
  if (!query.trim()) return ''
  if (count === 0) return 'No task matches.'
  return count === 1 ? '1 task matches.' : `${count} tasks match.`
}

/** A blocker's state in plain words. A hidden one has none to show. */
export function blockerStateWords(blocker: Pick<BlockerView, 'finished'>): string {
  if (blocker.finished === null) return ''
  return blocker.finished ? 'Finished' : 'Open'
}

/** A task that can be picked as a blocker: live, not a subtask. `blockedBy` lists its open blockers when the board sends them (staff only). */
export interface CandidateTask {
  id: string
  title: string
  columnId: string
  deletedAt?: number | null
  parentTaskId?: string | null
  blockedBy?: string[]
}

/** Why title matches are not offered: already a blocker, or waiting for this task (a loop). */
export interface SearchNote {
  linked: number
  loop: number
}

// Live top-level tasks whose title holds the query, case-insensitive.
function liveMatches(tasks: readonly CandidateTask[], query: string): CandidateTask[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  return tasks.filter(t => t.deletedAt == null && !t.parentTaskId && t.title.toLowerCase().includes(needle))
}

// Only the open blockers are known per task, so this sees a loop of one link. A longer loop is refused by the server.
function waitsFor(task: CandidateTask, taskId: string): boolean {
  return task.blockedBy?.includes(taskId) ?? false
}

/** Live board tasks whose title holds the query, at most `limit`, minus this task, its blockers and any that would close a loop. */
export function blockerCandidates(
  tasks: readonly CandidateTask[],
  query: string,
  exclude: { selfId: string, waitingFor: readonly string[] },
  limit = 6
): CandidateTask[] {
  const skip = new Set([exclude.selfId, ...exclude.waitingFor])
  return liveMatches(tasks, query)
    .filter(t => !skip.has(t.id) && !waitsFor(t, exclude.selfId))
    .slice(0, limit)
}

/** The title matches that are left out, counted, so the box can say why. */
export function blockerSearchNote(tasks: readonly CandidateTask[], query: string, exclude: { selfId: string, waitingFor: readonly string[] }): SearchNote {
  const matches = liveMatches(tasks, query)
  return {
    linked: matches.filter(t => exclude.waitingFor.includes(t.id)).length,
    loop: matches.filter(t => !exclude.waitingFor.includes(t.id) && waitsFor(t, exclude.selfId)).length
  }
}

/** The sentence the box shows when it offers no task. */
export function emptySearchWords(note: SearchNote): string {
  if (note.linked > 0) return 'That task is already linked.'
  if (note.loop > 0) return 'That task waits for this one, so linking it would close a loop.'
  return 'No task on this board has that in its title.'
}
