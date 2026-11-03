// Who a task update reads as: the GitHub sync's copies read as GitHub, never as the project owner
// whose account they are stored under. Run:
//   node --import tsx --test tests/comment-author.test.ts
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { commentAuthorName, isGithubUpdate } from '../app/utils/commentAuthor'

const OWNER = 'Wick Worker'

describe('commentAuthorName', () => {
  test('a GitHub sync copy reads as GitHub, not the owner', () => {
    assert.equal(commentAuthorName({ createdVia: 'github', userName: OWNER }), 'GitHub')
    assert.equal(commentAuthorName({ createdVia: 'github', userName: null, keyName: null }), 'GitHub')
  })

  test('a person in the app reads as their own name', () => {
    assert.equal(commentAuthorName({ createdVia: 'ui', userName: OWNER }), OWNER)
    assert.equal(commentAuthorName({ createdVia: 'ui', userName: null }), 'Unknown')
  })

  test('an agent and the AI assistant keep their own labels', () => {
    assert.equal(commentAuthorName({ createdVia: 'mcp', userName: OWNER, keyName: 'Claude Code' }), 'Claude Code')
    assert.equal(commentAuthorName({ createdVia: 'mcp', userName: OWNER, keyName: null }), 'MCP key')
    assert.equal(commentAuthorName({ createdVia: 'ai', userName: OWNER }), 'AI assistant')
  })
})

describe('isGithubUpdate', () => {
  test('only the github source counts', () => {
    assert.equal(isGithubUpdate({ createdVia: 'github' }), true)
    assert.equal(isGithubUpdate({ createdVia: 'ui' }), false)
    assert.equal(isGithubUpdate({ createdVia: null }), false)
  })
})
