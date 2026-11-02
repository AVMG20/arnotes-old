// The customer-visibility rule for task comments, as one pure predicate. The database
// filter (commentVisibilityFilter in auth-helpers) and the thread selection both use it,
// so they cannot disagree about what a customer may see.
import type { Audience } from './auth-helpers'

export const CUSTOMER_COMMENT_VISIBILITY = 'customer'

export function commentVisibleTo(audience: Audience, visibility: string): boolean {
  return audience !== 'customer' || visibility === CUSTOMER_COMMENT_VISIBILITY
}
