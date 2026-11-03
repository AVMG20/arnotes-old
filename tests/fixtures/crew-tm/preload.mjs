// Loaded with --import into the crew/tm.mjs process of the tests: installs the stand-in hook.
import { register } from 'node:module'

register(new URL('./hooks.mjs', import.meta.url))
