import { flushAudit } from '../utils/crewGate'
import { socketTrustStartupLines } from '../utils/crewGatePolicy'
import { flushWithDeadline, SHUTDOWN_FLUSH_MS } from '../utils/shutdownFlush'

// Nitro calls the close hook on a graceful shutdown, where it runs. The flush is raced against a
// deadline, so a database that does not answer cannot hold the shutdown. Whether a stop signal
// reaches this hook is preset-specific: the node preset registers graceful shutdown, the Bun
// preset's runtime does not (checked in nitropack's bun runtime source, not on a running server).
export default defineNitroPlugin((nitroApp) => {
  // Once per process: what the socket-trust switch needs the operator to know. Never a refusal.
  for (const line of socketTrustStartupLines(process.env)) {
    if (line.level === 'error') console.error(line.text)
    else if (line.level === 'warning') console.warn(line.text)
    else console.info(line.text)
  }

  nitroApp.hooks.hook('close', async () => {
    await flushWithDeadline(flushAudit, SHUTDOWN_FLUSH_MS, line => console.error(line))
  })
})
