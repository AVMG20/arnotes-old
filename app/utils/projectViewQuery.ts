// The URL query a project page keeps when its tab changes. The Settings view owns the
// `section` key: once the tab leaves Settings the key is dropped, so a reload or a shared
// link does not reopen a Settings section nobody is looking at. Other keys (task, trashed)
// stay as they were. Pure, so the tests need no browser.
import type { LocationQuery, LocationQueryRaw } from 'vue-router'

/** The query for switching the project page to `key`. The board is the default, so it has no `view` key. */
export function queryForView(query: LocationQuery, key: string): LocationQueryRaw {
  const next: LocationQueryRaw = { ...query, view: key === 'board' ? undefined : key }
  if (key !== 'settings') delete next.section
  return next
}
