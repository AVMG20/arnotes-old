// The crew kit as one byte-stable tarball, the kit at its root (see server/utils/crewKit.ts).
// Public on purpose: the kit holds no secrets, and the installer fetches it without a session.
export default defineEventHandler((event) => {
  const kit = buildCrewKit()
  setResponseHeader(event, 'content-type', 'application/gzip')
  setResponseHeader(event, 'content-disposition', 'attachment; filename="taskmanager-crew.tar.gz"')
  setResponseHeader(event, 'x-crew-kit-version', kit.version)
  return kit.archive
})
