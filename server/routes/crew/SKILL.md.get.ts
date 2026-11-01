import { readFile } from 'node:fs/promises'

// The crew skill alone (taskmanager-crew), read from the crew/ folder of this repository.
// Like /api/settings/skill it is a plain download, and it holds no secrets.
export default defineEventHandler(async (event) => {
  const text = await readFile(`${crewKitDir()}/SKILL.md`, 'utf8').catch(() => null)
  if (text === null) throw createError({ statusCode: 404, message: 'The crew skill is not in this build' })
  setResponseHeader(event, 'content-type', 'text/markdown; charset=utf-8')
  setResponseHeader(event, 'content-disposition', 'attachment; filename="SKILL.md"')
  return text
})
