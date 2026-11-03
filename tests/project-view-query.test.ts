// The query a project page keeps when its tab changes: leaving Settings drops the section key.
// Run: node --import tsx --test tests/project-view-query.test.ts
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { queryForView } from '../app/utils/projectViewQuery'

describe('queryForView', () => {
  test('leaving Settings for the Overview drops section, so a reload lands on the Overview', () => {
    const next = queryForView({ view: 'settings', section: 'repositories' }, 'overview')
    assert.deepEqual(next, { view: 'overview' })
    assert.equal('section' in next, false)
  })

  test('the board is the default: its view key is cleared, and section goes too', () => {
    const next = queryForView({ view: 'settings', section: 'rules' }, 'board')
    assert.equal(next.view, undefined)
    assert.equal('section' in next, false)
  })

  test('the other tabs keep task and trashed as they were', () => {
    const next = queryForView({ view: 'settings', section: 'general', task: 'abc123', trashed: '1' }, 'messages')
    assert.deepEqual(next, { view: 'messages', task: 'abc123', trashed: '1' })
  })

  test('switching to Settings keeps a section already in the URL, so a deep link still works', () => {
    const next = queryForView({ view: 'overview', section: 'rules' }, 'settings')
    assert.deepEqual(next, { view: 'settings', section: 'rules' })
  })

  test('a plain switch with no section leaves the query alone apart from view', () => {
    assert.deepEqual(queryForView({ view: 'time' }, 'list'), { view: 'list' })
    assert.deepEqual(queryForView({}, 'calendar'), { view: 'calendar' })
  })
})
