import type { BoundedQueue } from './boundedQueue'

// Where a refused call's audit row goes. The row of a call that closes the crew API window is
// written at once, awaited before the refusal is answered, so a flood that fills the queue can
// never hide the attempt that shut the window. Every other row waits in the bounded queue.

export interface AuditSink<T> {
  queue: BoundedQueue<T>
  /** Writes one row to the database now. Failures are reported by the caller, not swallowed here. */
  writeDirect: (row: T) => Promise<void>
}

export type AuditRoute = 'direct' | 'queued' | 'dropped'

export async function recordAudit<T>(sink: AuditSink<T>, row: T, closesWindow: boolean): Promise<AuditRoute> {
  if (closesWindow) {
    await sink.writeDirect(row)
    return 'direct'
  }
  return sink.queue.push(row) ? 'queued' : 'dropped'
}

/**
 * Wraps the direct writer of closing rows so a failed write is reported to onError and never
 * thrown: the refusal is answered either way.
 */
export function closingWriter<T>(write: (row: T) => Promise<void>, onError: (error: unknown) => void): (row: T) => Promise<void> {
  return async (row: T) => {
    try {
      await write(row)
    } catch (error) {
      onError(error)
    }
  }
}
