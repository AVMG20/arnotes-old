// The queue of GitHub deliveries: the factory, its health view and its shutdown. The implementations are in
// githubDeliveryQueueAmqp.ts (RabbitMQ) and githubDeliveryQueueMemory.ts (development and tests); the
// interface is in githubDeliveryQueueTypes.ts.
//
// The webhook still calls the old hand-off from githubDeliveryHandoff.ts; the re-export below keeps that import
// working until GH6b. GH6b deletes the re-export together with the hand-off.
import { createAmqpDeliveryQueue } from './githubDeliveryQueueAmqp'
import { createMemoryDeliveryQueue } from './githubDeliveryQueueMemory'
import { DeliveryQueueUnavailable, describeBrokerUrl } from './githubDeliveryQueueTypes'
import type { DeliveryQueue, QueueStatus } from './githubDeliveryQueueTypes'

export * from './githubDeliveryQueueTypes'
export {
  DEFAULT_PER_MINUTE, deliveryQueue, forgetPerMinuteWarning, inlineDeliveryQueue, perMinuteFromEnv, RepoAcceptLimit, repoAcceptLimit, useDeliveryQueue
} from './githubDeliveryHandoff'
export type { DeliveryHandoff } from './githubDeliveryHandoff'

let shared: DeliveryQueue | null = null

/**
 * The queue of GitHub deliveries. The connection to RabbitMQ opens on first use, not at start, so the
 * server starts without a broker. Throws DeliveryQueueUnavailable when there is no broker and this is not
 * development or test. Never defaults to memory outside development and test.
 */
export function getDeliveryQueue(): DeliveryQueue {
  if (shared) return shared
  const url = (process.env.RABBITMQ_URL ?? '').trim()
  if (url) {
    shared = createAmqpDeliveryQueue({ url, label: describeBrokerUrl(url), log: line => console.info(line) })
  } else if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
    shared = createMemoryDeliveryQueue({ log: line => console.info(line) })
  } else {
    throw new DeliveryQueueUnavailable('RABBITMQ_URL is not set')
  }
  return shared
}

/**
 * Closes the shared queue and forgets it. The next getDeliveryQueue() starts again. GH6b calls this from a
 * Nitro close hook, after it has stopped its consumer (the stop function from consume()).
 */
export async function closeDeliveryQueue(): Promise<void> {
  const queue = shared
  shared = null
  await queue?.close()
}

/** For the health check and the PM's status: the state, and the depths when the broker answers (null when not). */
export async function deliveryQueueHealth(): Promise<QueueStatus & { depth: number | null, failed: number | null }> {
  let queue: DeliveryQueue
  try {
    queue = getDeliveryQueue()
  } catch {
    return { state: 'unavailable', broker: null, detail: 'RABBITMQ_URL is not set', depth: null, failed: null }
  }
  const [depth, failed] = await Promise.all([
    queue.depth().catch(() => null),
    queue.failedDepth().catch(() => null)
  ])
  return { ...queue.status(), depth, failed }
}
