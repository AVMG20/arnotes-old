// Copies exactly the crew kit files that crew/kit-files.txt lists, from the source folder to the
// destination. The Docker image (builder stage) and the nix package both run it, so there is one
// copy step and one set of checks (server/utils/crewKit.ts). It exits non-zero, with the reason,
// when the list is missing, empty, has a bad name, or a listed file is missing, a symlink or a
// folder. Nothing else is copied.
// The destination folder is created if it is missing. A listed file that already exists there is
// overwritten; nothing else in it is removed or touched.
//   bun scripts/copy-crew-kit.ts <src dir> <dest dir>      (node --import tsx works too)
import { copyCrewKit } from '../server/utils/crewKit'

const [src, dest] = process.argv.slice(2)
if (!src || !dest) {
  console.error('usage: copy-crew-kit <src dir> <dest dir>')
  process.exit(2)
}

try {
  const copied = copyCrewKit(src, dest)
  console.log(`crew kit: copied ${copied.length} files to ${dest}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
