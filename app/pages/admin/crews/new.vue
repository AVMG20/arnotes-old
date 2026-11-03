<script setup lang="ts">
definePageMeta({ layout: 'app' })

useSeoMeta({ title: 'New crew' })

const { isInstanceAdmin, isPending: sessionPending } = useAuth()
const toast = useToast()

watch([sessionPending, isInstanceAdmin], ([pending, admin]) => {
  if (!pending && !admin) navigateTo('/settings', { replace: true })
}, { immediate: true })

function errMsg(e: unknown): string | undefined {
  return (e as { data?: { message?: string } })?.data?.message
}

// The answer to a create or rotate, kept in this page's memory only: it is the crew's
// creds.json, with every password and key, and it is shown once.
interface CrewCreds {
  crew: { slug: string, boardUrl: string | null }
  base: string
  people: Record<string, { name?: string, role?: string, apiKey?: string }>
  board: { id: string, name: string } | null
}

const STEPS = [
  { title: 'The crew', description: 'Name and product', icon: 'i-lucide-users' },
  { title: 'The project', description: 'What to keep in mind', icon: 'i-lucide-scroll-text' },
  { title: 'Make it', description: 'Accounts and keys', icon: 'i-lucide-wand-sparkles' },
  { title: 'Set up the computer', description: 'Kit and files', icon: 'i-lucide-laptop' },
  { title: 'Start', description: 'Your Claude Code session', icon: 'i-lucide-play' }
]
const step = ref(0)

// ─── 1. The crew ─────────────────────────────────────────────
const form = reactive({
  name: '',
  slug: '',
  productName: '',
  repo: '',
  appUrl: '',
  useChat: false,
  chatClient: '',
  channel: '',
  workChannel: ''
})
// The slug follows the name until it is typed in by hand.
const slugEdited = ref(false)
watch(() => form.name, (name) => {
  if (slugEdited.value) return
  form.slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63)
})
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/
const slugValid = computed(() => SLUG.test(form.slug))
// The code folder and the web address are required: without the folder the workers have nothing to
// edit, and without the address the tester would test Taskmanager itself (config.mjs falls back to it).
const appUrlValid = computed(() => /^https?:\/\/\S+$/.test(form.appUrl.trim()))
const crewReady = computed(() => form.name.trim() && slugValid.value && form.productName.trim() && form.repo.trim().startsWith('/') && appUrlValid.value)

// ─── 2. The project ──────────────────────────────────────────
// A crew works on a project, not on one task: the tasks come from the board. BRIEF.md tells every
// member which project that is and what to keep in mind; the headings are BRIEF.md.tmpl's.
const brief = reactive({ about: '', keepInMind: '', never: '' })
const briefReady = computed(() => brief.about.trim() && brief.keepInMind.trim())
// One line each, typed with or without "- ": Markdown would run bare lines into one paragraph.
function asList(text: string): string {
  return text.split('\n').map(line => line.trim()).filter(Boolean).map(line => (/^[-*] /.test(line) ? line : `- ${line}`)).join('\n')
}
const briefText = computed(() => {
  const product = form.productName.trim() || 'the project'
  return [
    `# Working on ${product}\n`,
    `You perform work on ${product}. ${brief.about.trim()}\n`,
    `## Keep in mind\n\n${asList(brief.keepInMind)}\n`,
    `## Never\n\n${asList(brief.never) || 'Nothing beyond PROJECT-RULES.md.'}\n`
  ].join('\n')
})

// ─── 3. Make it ──────────────────────────────────────────────
const creds = ref<CrewCreds | null>(null)
const making = ref(false)
const exists = ref<string | null>(null)
const downloaded = reactive({ creds: false, config: false, brief: false })
const filesSaved = computed(() => downloaded.creds && downloaded.config && downloaded.brief)

async function makeCrew(rotate = false) {
  making.value = true
  exists.value = null
  try {
    creds.value = await $fetch<CrewCreds>('/api/admin/crews', {
      method: 'POST',
      body: {
        slug: form.slug,
        name: form.name.trim(),
        product: { name: form.productName.trim(), repo: form.repo.trim() || undefined, appUrl: form.appUrl.trim() || undefined },
        rotate
      }
    })
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode
    // The API's wording is for API callers ("send rotate: true"); this page has a button for it.
    if (status === 409) exists.value = /disabled/i.test(errMsg(e) ?? '') ? `The crew ${form.slug} exists and is disabled.` : `A crew called ${form.slug} exists already.`
    else toast.add({ title: 'Could not make the crew', description: errMsg(e), color: 'error' })
  } finally {
    making.value = false
  }
}

// crew.json holds no secret: the settings the kit reads, with defaults for the rest.
const crewConfig = computed(() => {
  if (!creds.value) return ''
  return JSON.stringify({
    team: form.name.trim(),
    crew: { slug: form.slug },
    // A blank field is left out, so the kit's own default applies (config.mjs).
    product: { name: form.productName.trim(), ...(form.repo.trim() && { repo: form.repo.trim() }), ...(form.appUrl.trim() && { appUrl: form.appUrl.trim() }) },
    board: { url: creds.value.base, name: creds.value.board?.name ?? `${form.productName.trim()} Development Center` },
    customer: { name: form.productName.trim() },
    ...(form.useChat && form.chatClient.trim() && {
      chat: { client: form.chatClient.trim(), channel: form.channel.trim() || `#${form.slug}`, workChannel: form.workChannel.trim() || `#${form.slug}work` }
    })
  }, null, 2)
})

// Named for the crew, so a second crew's download never lands as "creds (1).json".
const credsFile = computed(() => `creds-${form.slug}.json`)
const configFile = computed(() => `crew-${form.slug}.json`)
const briefFile = computed(() => `brief-${form.slug}.md`)

function download(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  // Revoked a moment later: Safari cancels a download whose URL is revoked straight away.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function downloadCreds() {
  if (!creds.value) return
  download(credsFile.value, JSON.stringify(creds.value, null, 2))
  downloaded.creds = true
}

function downloadConfig() {
  download(configFile.value, crewConfig.value)
  downloaded.config = true
}

function downloadBrief() {
  download(briefFile.value, briefText.value, 'text/markdown')
  downloaded.brief = true
}

// The keys exist only on this page until the files are saved: leaving asks first.
const unsaved = computed(() => Boolean(creds.value) && !downloaded.creds)
const LEAVE_WARNING = 'The creds file is not downloaded yet. If you leave now, the crew needs new keys. Leave anyway?'
function guardUnload(event: BeforeUnloadEvent) {
  if (!unsaved.value) return
  event.preventDefault()
  event.returnValue = ''
}
onMounted(() => window.addEventListener('beforeunload', guardUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', guardUnload))
onBeforeRouteLeave(() => (unsaved.value ? window.confirm(LEAVE_WARNING) : true))

// ─── 4. Set up the computer ──────────────────────────────────
// Every step says what to run, what a good result looks like, and what to do when it is not.
interface HelperStep {
  id: string
  title: string
  why: string
  command: string
  expect: string
  trouble: string[]
}

const origin = import.meta.client ? window.location.origin : ''
const base = computed(() => creds.value?.base ?? origin)
// Every crew gets a home folder of its own, so a second crew on the same computer sits next to it.
const crewDir = computed(() => `~/crew-home/${form.slug}`)

const checkSteps = computed<HelperStep[]>(() => [
  {
    id: 'node',
    title: 'Check that Node.js is installed',
    why: 'The crew\'s tools are Node.js programs.',
    command: 'node --version',
    expect: 'One line such as v20.11.0 or v22.3.0: the first number must be 20 or higher.',
    trouble: [
      '"command not found": install the LTS version from https://nodejs.org, then close the terminal window, open a new one and run this again.',
      'A number below 20: install the LTS version from https://nodejs.org the same way.'
    ]
  },
  {
    id: 'claude',
    title: 'Check that Claude Code is installed and signed in',
    why: 'Every crew member is a Claude Code session.',
    command: 'claude --version',
    expect: 'One line with a version number, such as 2.1.312 (Claude Code).',
    trouble: [
      '"command not found": run  npm install -g @anthropic-ai/claude-code  then run  claude  once, sign in when it asks, and type /exit to leave it.'
    ]
  },
  {
    id: 'reach',
    title: 'Check that this computer reaches Taskmanager',
    why: 'The crew talks to the board at this address.',
    command: `curl -s ${base.value}/api/health`,
    expect: 'Text with "status" and "ok" in it, such as {"status":"ok","version":"0.1.0"}.',
    trouble: [
      'Nothing, or "Could not resolve host" / "Connection refused": this computer cannot reach Taskmanager at that address. Run the crew on the computer Taskmanager runs on, or ask whoever runs Taskmanager for an address this computer can reach.'
    ]
  }
])

const setupSteps = computed<HelperStep[]>(() => [
  {
    id: 'kit',
    title: 'Install the crew kit and its browser',
    why: 'Downloads the crew\'s tools into ~/crew-kit, the crew skill into Claude Code, and the Chromium browser the crew uses to look at pages. It takes a few minutes.',
    command: `${crewKitCommands(base.value)}\nnpx playwright install chromium`,
    expect: 'A line that starts with "added" and a number of packages (or "up to date" when you run it again), then download progress for Chromium. Lines that start with "npm notice" or "npm warn" are fine.',
    trouble: [
      '"npm: command not found": Node.js is missing, see check 1.',
      '"curl: (22) ... 404": Taskmanager does not serve the kit. Tell whoever runs Taskmanager.',
      'On Linux, Chromium needs extra system parts: run  cd ~/crew-kit && npx playwright install --with-deps chromium  instead of the last line. It asks for your computer\'s password.',
      'Lines that start with "npm error", or Chromium does not download: copy those lines and send them to whoever runs Taskmanager.'
    ]
  },
  {
    id: 'files',
    title: 'Put the three downloaded files in place',
    why: `Moves ${credsFile.value}, ${configFile.value} and ${briefFile.value} from your Downloads folder into ${crewDir.value}, this crew's own folder, renamed to creds.json, crew.json and BRIEF.md, and makes creds.json readable by you only.`,
    command: [
      `mkdir -p ${crewDir.value}`,
      `mv ~/Downloads/${credsFile.value} ${crewDir.value}/creds.json`,
      `mv ~/Downloads/${configFile.value} ${crewDir.value}/crew.json`,
      `mv ~/Downloads/${briefFile.value} ${crewDir.value}/BRIEF.md`,
      `chmod 600 ${crewDir.value}/creds.json`,
      `ls -l ${crewDir.value}`
    ].join('\n'),
    expect: 'Three lines at the end, from ls: BRIEF.md, creds.json starting with -rw------- and crew.json. Only these lines count: when all three are there, ignore any "No such file" above them.',
    trouble: [
      `ls shows fewer than three files: the browser saved one under another name, such as "creds-${form.slug} (1).json" when it was downloaded twice, or in another folder. Open your Downloads folder, rename that file to exactly the name in the command, and paste the commands again.`,
      'This is not the computer the files were downloaded on: copy the three files into this computer\'s Downloads folder first, with a USB stick, AirDrop or scp. Never send the creds file by chat or e-mail: it holds every password of the crew.'
    ]
  },
  {
    id: 'init',
    title: 'Check the computer and write the crew\'s documents',
    why: `Checks Node.js and the browser the crew uses, then writes CREW.md, PROMPTS.md and the other documents into ${crewDir.value}, and one Claude Code agent type per crew member (such as ${form.slug}-pia-planner) into ~/.claude/agents, so Claude Code can tell them apart. It keeps your BRIEF.md.`,
    command: `cd ~/crew-kit && CREW_HOME=${crewDir.value} node init.mjs`,
    expect: `Lines that start with "ok", eight of them under "Agent types" with names that start with ${form.slug}-, and at the end "Init done." Lines that start with WARN are fine, such as "no chat client configured".`,
    trouble: [
      '"FAIL no browser": step 4\'s last line did not finish. Run  cd ~/crew-kit && npx playwright install chromium  and then this step again.',
      '"FAIL ... exists and was not written by init": a file with that name in ~/.claude/agents belongs to something else. Rename that file, then run this step again.',
      'Another line that starts with FAIL: it says what is missing. Fix that one thing and run the command again, until it ends with "Init done."',
      'You cannot tell from the FAIL line what to do: copy it and send it to whoever runs Taskmanager.'
    ]
  },
  {
    id: 'check',
    title: 'Check that a crew member reaches the board',
    why: `Asks the board for the tasks of ${creds.value?.people.w1?.name ?? 'worker 1'}, with that worker's own key.`,
    command: `cd ~/crew-kit && CREW_HOME=${crewDir.value} node crew.mjs w1 mcp my_tasks '{}'`,
    expect: 'One line: {"total":0,"tasks":[]}. No tasks is right: nothing is assigned yet.',
    trouble: [
      `"ERROR true": the board refused the key, so the creds.json in ${crewDir.value} is not this crew's. Press Back on this page to "Make it", download the creds file again and redo step 5. If this page was closed in between, open New crew again, fill in the same short name, and press "Give it new keys" when it says the crew exists.`,
      '"ERROR fetch failed": this computer does not reach Taskmanager. Run check 3 again.',
      '"Cannot find package": the kit install did not finish. Run step 4 again.'
    ]
  }
])

// ─── 5. Start ────────────────────────────────────────────────
// PROMPTS.md writes every kit command with CREW_HOME in front, so Boss can be a session that was
// started for other work. A new window still exports it, and --add-dir lets it read both folders.
const startClaude = computed(() => `export CREW_HOME=${crewDir.value}\nclaude --add-dir ${crewDir.value} ~/crew-kit`)

function sessionCommands(who: string): string {
  const command = crewChannelCommand(who, `$HOME/crew-home/${form.slug}`)
  const channel = command.replace(/\nclaude (.*)$/, '')
  const flags = command.match(/\nclaude (.*)$/)?.[1] ?? ''
  const dir = `~/crew-sessions/${form.slug}-${who}`
  return [`mkdir -p ${dir}`, `cd ${dir}`, channel, `${startClaude.value} ${flags}`].join('\n')
}

// What Boss is told, in the session the admin already works in or in a window of its own. The plain
// start needs no channel: Boss launches everyone, the PM included, with the listen-loop prompts.
function bossMessage(alongside: boolean): string {
  const people = creds.value?.people ?? {}
  const team = ['pm', 'w1', 'w2', 'w3', 'w4', 'pietje', 'nitpicker'].map(key => people[key]?.name ?? key).join(', ')
  const dir = crewDir.value
  return [
    alongside
      ? `Next to your current work, you are now also Boss of the Taskmanager crew "${form.name.trim()}".`
      : `You are Boss of the Taskmanager crew "${form.name.trim()}".`,
    `Its files are in ${dir}. Read ${dir}/CREW.md and ${dir}/PROMPTS.md in full. Run every crew-kit command exactly as PROMPTS.md writes it, with CREW_HOME in front.`,
    `Then launch ${team} as background agents: one Agent call each, with subagent_type set to that person's agent type from the table at the top of PROMPTS.md, model haiku, run_in_background true, and that person's prompt from PROMPTS.md (for ${people.pm?.name ?? 'the PM'}, the prompt under "PM", not the channel-mode one).`,
    'If the Agent tool answers "Agent type not found", stop and tell me: never launch a crew member without its subagent_type.',
    'Then keep Boss\'s loop as the top of PROMPTS.md describes: when a crew member hands back, read the board and resume or relaunch them.',
    ...(alongside ? ['Between hand-backs, carry on with your own work.'] : [])
  ].join(' ')
}

const startHere = computed(() => bossMessage(true))
const startPlain = computed(() => {
  const dir = `~/crew-sessions/${form.slug}-boss`
  return { command: [`mkdir -p ${dir}`, `cd ${dir}`, startClaude.value].join('\n'), message: bossMessage(false) }
})

const startChannels = computed(() => {
  const people = creds.value?.people ?? {}
  const pm = people.pm?.name ?? 'the project manager'
  const workers = ['w1', 'w2', 'w3', 'w4', 'pietje', 'nitpicker'].map(key => people[key]?.name ?? key).join(', ')
  return [
    {
      id: 'boss',
      title: 'Window 1: Boss, who launches the workers',
      command: sessionCommands('boss'),
      message: `You are Boss of the crew "${form.name.trim()}". Its files are in ${crewDir.value}. Read ${crewDir.value}/CREW.md and ${crewDir.value}/PROMPTS.md in full. Then launch ${workers} as background agents with model haiku, each with their own subagent_type and prompt from PROMPTS.md. Do not launch ${pm}: she runs in her own window. Then keep Boss's loop as PROMPTS.md describes under "Channel mode: the PM's session and Boss's wake loop".`
    },
    {
      id: 'pm',
      title: `Window 2: ${pm}, the project manager`,
      command: sessionCommands('pm'),
      message: `You are ${pm}, the project manager of the crew "${form.name.trim()}". Open ${crewDir.value}/PROMPTS.md, find the section "Channel mode: the PM's session and Boss's wake loop", and follow the prompt in its first code block as your instructions.`
    }
  ]
})

const agentPrompt = computed(() => {
  const all = [...checkSteps.value, ...setupSteps.value]
  return `Set up a Taskmanager crew on this computer. Taskmanager runs at ${base.value}; the crew "${form.name.trim()}" (${form.slug}) is already made.
${credsFile.value}, ${configFile.value} and ${briefFile.value} are in ~/Downloads. The creds file holds every password and key of the crew: never print it, never copy it into a repository.

Do these steps in order. After each one, compare the output with "Good result". If it does not match, use the fix listed under "If not" for what you saw, and run the step again. If none of them fits, stop and tell me what you saw: do not invent another fix.

${all.map((s, i) => `${i + 1}. ${s.title}
${s.command.split('\n').map(line => `   ${line}`).join('\n')}
   Good result: ${s.expect}
   If not:
${s.trouble.map(line => `   - ${line}`).join('\n')}`).join('\n\n')}

When all ${all.length} pass, tell me so, step by step. I tick them off on the setup page and start the crew myself.`
})

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.add({ title: 'Copied', icon: 'i-lucide-check', duration: 1500 })
  } catch {
    toast.add({ title: 'Could not copy. Select the text and copy it.', color: 'warning' })
  }
}

// Ticks for the helper to keep their place; they leave with the page.
const done = reactive<Record<string, boolean>>({})
const allChecked = computed(() => [...checkSteps.value, ...setupSteps.value].every(s => done[s.id]))

const canNext = computed(() => {
  if (step.value === 0) return Boolean(crewReady.value)
  if (step.value === 1) return Boolean(briefReady.value)
  if (step.value === 2) return Boolean(creds.value && filesSaved.value)
  if (step.value === 3) return allChecked.value
  return false
})
// Once the crew is made its details are fixed: going back past "Make it" would only confuse.
const canBack = computed(() => step.value > 0 && !(step.value === 2 && creds.value))
const nextHint = computed(() => {
  if (step.value === 0 && form.name.trim() && !slugValid.value) return 'Fill in the short name.'
  if (step.value === 0 && !crewReady.value) return 'Fill in every field marked with *, and fix any field with red text under it.'
  if (step.value === 1 && !briefReady.value) return 'Fill in what the project is and what to keep in mind.'
  if (step.value === 2 && creds.value && !filesSaved.value) return 'Download all three files to go on.'
  if (step.value === 3 && !allChecked.value) return 'Tick each step when its result matches.'
  return ''
})
</script>

<template>
  <div class="h-full overflow-y-auto px-4 pb-10 pt-6 lg:px-6">
    <div class="mx-auto max-w-3xl space-y-6">
      <div class="flex items-center gap-3">
        <UButton
          to="/admin/crews"
          icon="i-lucide-arrow-left"
          color="neutral"
          variant="ghost"
          size="sm"
          aria-label="Back to Crews"
        />
        <div>
          <h1 class="text-xl font-semibold text-default">
            New crew
          </h1>
          <p class="text-sm text-muted">
            Five steps. You make the crew and tell it about the project, then set up the computer the agents run on, one
            command at a time.
          </p>
        </div>
      </div>

      <div
        v-if="sessionPending || !isInstanceAdmin"
        class="rounded-lg border border-default p-6 text-sm text-muted"
      >
        {{ sessionPending ? 'Loading…' : 'This page is for the instance admin.' }}
      </div>

      <template v-else>
        <UStepper
          v-model="step"
          :items="STEPS"
          :linear="true"
          disabled
          size="sm"
          class="w-full"
        />

        <!-- What a crew is, before anything is asked -->
        <UAlert
          v-if="step === 0"
          color="primary"
          variant="soft"
          icon="i-lucide-info"
          title="What a crew is"
        >
          <template #description>
            <div class="space-y-2">
              <p>
                This wizard helps you with the setup. A crew is a set of Haiku agents that your own local Claude agent
                steers. They work with this Taskmanager on a private board of their own, separate from your main project,
                and use it to manage everything and make sure everything gets handled.
              </p>
              <p>
                Your main agent steers them and checks their work, following the crew manager skill it receives during
                the setup.
              </p>
            </div>
          </template>
        </UAlert>

        <!-- 1. The crew -->
        <section
          v-if="step === 0"
          class="rounded-lg border border-default p-4 space-y-4"
        >
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField
              label="Crew name"
              description="Anything you like. It is also the name of the crew's team."
              required
            >
              <UInput
                v-model="form.name"
                placeholder="Acme Crew"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="Short name"
              :description="slugValid || !form.slug ? 'Filled in from the crew name. Lowercase letters, digits and hyphens.' : undefined"
              :error="form.slug && !slugValid ? 'Use 2 to 63 characters: a to z, 0 to 9 and hyphens, not starting with a hyphen.' : undefined"
              required
            >
              <UInput
                v-model="form.slug"
                placeholder="acme-crew"
                class="w-full font-mono"
                @update:model-value="slugEdited = true"
              />
            </UFormField>
            <UFormField
              label="Product"
              description="What the crew builds. The crew's board and customer are named after it."
              required
            >
              <UInput
                v-model="form.productName"
                placeholder="Acme App"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="Product's web address"
              description="Where the product opens in a browser on the agents' computer while the crew works on it, such as http://localhost:3000."
              :error="form.appUrl.trim() && !appUrlValid ? 'Start with http:// or https://, such as http://localhost:3000.' : undefined"
              required
            >
              <UInput
                v-model="form.appUrl"
                placeholder="http://localhost:3000"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="Product's code folder"
              description="The full path of the product's code on the computer the agents run on, starting with /. To find it: open a terminal there, type cd , drag the folder into the window, press Enter, then type pwd and press Enter. Copy the line it prints."
              :error="form.repo.trim() && !form.repo.trim().startsWith('/') ? 'A full path starts with /, such as /Users/you/git/acme.' : undefined"
              class="sm:col-span-2"
              required
            >
              <UInput
                v-model="form.repo"
                placeholder="/Users/you/git/acme"
                class="w-full font-mono"
              />
            </UFormField>
          </div>

          <div class="border-t border-default pt-4 space-y-3">
            <USwitch
              v-model="form.useChat"
              label="Talk to the customer in an IRC channel (advanced)"
              description="Leave this off unless you already run an IRC chat client. Off, the crew talks through the board's messages."
            />
            <div
              v-if="form.useChat"
              class="grid gap-4 sm:grid-cols-3"
            >
              <UFormField
                label="Chat client"
                description="Full path of the chat client program."
                class="sm:col-span-3"
              >
                <UInput
                  v-model="form.chatClient"
                  placeholder="/path/to/chat-client-rs"
                  class="w-full font-mono"
                />
              </UFormField>
              <UFormField label="Customer channel">
                <UInput
                  v-model="form.channel"
                  :placeholder="`#${form.slug || 'crew'}`"
                  class="w-full font-mono"
                />
              </UFormField>
              <UFormField label="Work channel">
                <UInput
                  v-model="form.workChannel"
                  :placeholder="`#${form.slug || 'crew'}work`"
                  class="w-full font-mono"
                />
              </UFormField>
            </div>
          </div>
        </section>

        <!-- 2. The project -->
        <section
          v-else-if="step === 1"
          class="rounded-lg border border-default p-4 space-y-4"
        >
          <p class="text-sm text-muted">
            The crew stays on this project and takes its work from the board, one task after another. Here you tell every
            crew member which project that is and what to keep in mind. It becomes BRIEF.md, which they read before
            anything else.
          </p>
          <UFormField
            :label="`You perform work on ${form.productName.trim() || 'the project'}. What is it?`"
            description="A few sentences: what it is, who uses it, and what matters most to them."
            required
          >
            <UTextarea
              v-model="brief.about"
              :rows="3"
              autoresize
              placeholder="A booking site for our restaurant. Regular guests book a table on their phone; the staff see the bookings on a tablet."
              class="w-full"
            />
          </UFormField>
          <UFormField
            label="Keep in mind"
            description="One line each: what every change must respect, and anything about the code that is not obvious."
            required
          >
            <UTextarea
              v-model="brief.keepInMind"
              :rows="4"
              autoresize
              placeholder="- The booking page must keep working on a phone.&#10;- Prices come from the menu service, never typed into a page."
              class="w-full"
            />
          </UFormField>
          <UFormField
            label="Never"
            description="Things that would be wrong or dangerous: who must never see what, what must never be deleted."
          >
            <UTextarea
              v-model="brief.never"
              :rows="2"
              autoresize
              placeholder="- A guest never sees another guest's booking."
              class="w-full"
            />
          </UFormField>
        </section>

        <!-- 3. Make it -->
        <section
          v-else-if="step === 2"
          class="rounded-lg border border-default p-4 space-y-4"
        >
          <template v-if="!creds">
            <p class="text-sm text-default">
              This makes <span class="font-medium">{{ form.name }}</span>: a team of that name, a customer and a board
              for {{ form.productName }}, and ten accounts (a boss, a project manager, four workers, a usability
              tester, a code reviewer and two customer logins), each with its own key.
            </p>
            <UAlert
              v-if="exists"
              color="warning"
              variant="soft"
              icon="i-lucide-triangle-alert"
              :title="exists"
              description="Giving it new keys and passwords re-enables it if it was disabled, and a crew still running on the old creds.json stops working. Or go back and pick another short name."
            >
              <template #actions>
                <UButton
                  label="Give it new keys"
                  color="warning"
                  size="xs"
                  :loading="making"
                  @click="makeCrew(true)"
                />
              </template>
            </UAlert>
            <UButton
              v-else
              label="Make the crew"
              icon="i-lucide-wand-sparkles"
              :loading="making"
              @click="makeCrew()"
            />
          </template>

          <template v-else>
            <UAlert
              color="success"
              variant="soft"
              icon="i-lucide-circle-check"
              :title="`${form.name} is made.`"
              :description="creds.crew.boardUrl ? 'Its board is ready.' : undefined"
            >
              <template
                v-if="creds.crew.boardUrl"
                #actions
              >
                <UButton
                  :to="creds.crew.boardUrl"
                  label="Open the board in a new tab"
                  size="xs"
                  color="neutral"
                  variant="outline"
                  target="_blank"
                />
              </template>
            </UAlert>
            <UAlert
              color="warning"
              variant="soft"
              icon="i-lucide-key-round"
              title="Download all three files now."
              :description="`${credsFile} holds every password and key of the crew. It exists only on this page: if you leave before downloading it, the crew needs new keys. Keep it private: never send it by chat or e-mail.`"
            />
            <div class="flex flex-wrap gap-2">
              <UButton
                :icon="downloaded.creds ? 'i-lucide-check' : 'i-lucide-download'"
                :label="`1. Download ${credsFile}`"
                :color="downloaded.creds ? 'success' : 'primary'"
                @click="downloadCreds"
              />
              <UButton
                :icon="downloaded.config ? 'i-lucide-check' : 'i-lucide-download'"
                :label="`2. Download ${configFile}`"
                :color="downloaded.config ? 'success' : 'primary'"
                @click="downloadConfig"
              />
              <UButton
                :icon="downloaded.brief ? 'i-lucide-check' : 'i-lucide-download'"
                :label="`3. Download ${briefFile}`"
                :color="downloaded.brief ? 'success' : 'primary'"
                @click="downloadBrief"
              />
            </div>
            <p class="text-xs text-muted">
              Your browser saves them in your Downloads folder. If it asks where to save, choose Downloads, and keep
              the names exactly as they are. The next step happens on the computer the agents run on (a Mac or Linux
              computer): if that is not this one, the three files go there too.
            </p>
            <details class="text-xs text-muted">
              <summary class="cursor-pointer">
                Who is in the crew
              </summary>
              <ul class="mt-2 grid gap-1 sm:grid-cols-2">
                <li
                  v-for="(person, key) in creds.people"
                  :key="key"
                >
                  <span class="font-mono text-default">{{ key }}</span> · {{ person.role ? `${person.name}, ${person.role}` : person.name }}
                </li>
              </ul>
            </details>
          </template>
        </section>

        <!-- 4. Set up the computer -->
        <section
          v-else-if="step === 3"
          class="space-y-3"
        >
          <div class="rounded-lg border border-default p-4 space-y-3 text-sm">
            <p class="font-medium text-default">
              How this step works
            </p>
            <ol class="list-decimal pl-5 space-y-1 text-muted">
              <li>
                Use the computer the agents will run on: a Mac or a Linux computer (Windows is not supported). Open a
                terminal there: on a Mac, press <kbd class="font-mono">⌘ Space</kbd>, type
                <span class="font-mono">Terminal</span> and press Enter; on Linux, press
                <kbd class="font-mono">Ctrl Alt T</kbd>.
              </li>
              <li>
                For each box below: press its Copy button, click in the terminal, paste (<kbd class="font-mono">⌘ V</kbd>
                on a Mac, <kbd class="font-mono">Ctrl Shift V</kbd> on Linux) and press Enter. A box with several lines
                is pasted in one go.
              </li>
              <li>Compare what the terminal shows with "Good result". When it matches, tick the box and go to the next one.</li>
              <li>When it does not match, read "If not" under it. Do not skip a step: each one needs the one before.</li>
            </ol>
            <div class="flex flex-wrap items-center gap-2 border-t border-default pt-3">
              <p class="text-xs text-muted flex-1 min-w-48">
                Or let Claude Code do this step for you: copy everything as one prompt, type
                <span class="font-mono">claude</span> in the terminal and press Enter, answer the safety check
                (<kbd class="font-mono">↓</kbd> once, then Enter), paste the prompt and press Enter.
              </p>
              <UButton
                label="Copy as a prompt"
                icon="i-lucide-clipboard-list"
                size="sm"
                color="neutral"
                variant="outline"
                @click="copy(agentPrompt)"
              />
            </div>
          </div>

          <template
            v-for="(group, g) in [{ title: 'First, three checks', items: checkSteps }, { title: 'Then the setup', items: setupSteps }]"
            :key="group.title"
          >
            <p class="text-xs font-semibold text-muted uppercase tracking-wider pt-2">
              {{ group.title }}
            </p>
            <div
              v-for="(item, i) in group.items"
              :key="item.id"
              class="rounded-lg border p-4 space-y-2"
              :class="done[item.id] ? 'border-success/40 bg-success/5' : 'border-default'"
            >
              <div class="flex items-center gap-2">
                <UCheckbox
                  v-model="done[item.id]"
                  :aria-label="`Done: ${item.title}`"
                />
                <p class="text-sm font-medium flex-1">
                  {{ g * checkSteps.length + i + 1 }}. {{ item.title }}
                </p>
                <UButton
                  icon="i-lucide-copy"
                  label="Copy"
                  size="xs"
                  color="neutral"
                  variant="soft"
                  @click="copy(item.command)"
                />
              </div>
              <p class="text-xs text-muted">
                {{ item.why }}
              </p>
              <pre class="text-xs font-mono bg-elevated/50 border border-default rounded-md p-3 whitespace-pre-wrap break-all">{{ item.command }}</pre>
              <p class="text-xs">
                <span class="font-semibold text-success">Good result:</span> {{ item.expect }}
              </p>
              <div class="text-xs text-muted">
                <span class="font-semibold text-warning">If not:</span>
                <ul class="list-disc pl-5 space-y-0.5 mt-0.5">
                  <li
                    v-for="line in item.trouble"
                    :key="line"
                  >
                    {{ line }}
                  </li>
                </ul>
              </div>
            </div>
          </template>
        </section>

        <!-- 5. Start -->
        <section
          v-else
          class="space-y-3"
        >
          <p class="text-sm text-muted">
            Boss is the Claude Code session that launches the crew members and checks their work. Choose
            <span class="text-default">one</span> of the two ways below, not both.
          </p>

          <div class="rounded-lg border border-primary/40 p-4 space-y-4 text-sm">
            <p class="font-medium text-default">
              Way 1: in the Claude Code session you already work in
            </p>
            <p class="text-muted">
              That session becomes Boss next to its own work. It does not need to be in a particular folder.
            </p>
            <div class="space-y-1">
              <div class="flex items-center gap-2">
                <p class="text-muted flex-1">
                  a. Wait until it has finished what it is doing. Then paste this message into it and press Enter:
                </p>
                <UButton
                  icon="i-lucide-copy"
                  label="Copy"
                  size="xs"
                  color="neutral"
                  variant="soft"
                  @click="copy(startHere)"
                />
              </div>
              <pre class="text-xs bg-elevated/50 border border-default rounded-md p-3 whitespace-pre-wrap">{{ startHere }}</pre>
            </div>
            <p class="text-muted">
              b. Claude Code asks before it runs a command or reads a file the first time ("Do you want to proceed?").
              Use <kbd class="font-mono text-default">↓</kbd> to put the arrow on the option that starts with
              <span class="text-default">"Yes, and don't ask again"</span> and press Enter. More of these come while the
              crew settles in: keep an eye on the session for the first few minutes.
            </p>
            <p class="text-muted">
              c. If it says <span class="text-default">"Agent type not found"</span>, the session is older than step 6,
              which made the agent types. Type <span class="font-mono text-default">/exit</span>, start Claude Code
              again in the same folder with <span class="font-mono text-default">claude --continue</span> (it keeps the
              conversation) and paste the message from a. again.
            </p>
          </div>

          <div class="rounded-lg border border-default p-4 space-y-4 text-sm">
            <p class="font-medium text-default">
              Way 2: in a new terminal window, as a session that is only Boss
            </p>
            <div class="space-y-1">
              <div class="flex items-center gap-2">
                <p class="text-muted flex-1">
                  a. Open a new terminal window (on a Mac: <kbd class="font-mono">⌘ N</kbd> in Terminal), paste these
                  lines and press Enter. Claude Code starts.
                </p>
                <UButton
                  icon="i-lucide-copy"
                  label="Copy"
                  size="xs"
                  color="neutral"
                  variant="soft"
                  @click="copy(startPlain.command)"
                />
              </div>
              <pre class="text-xs font-mono bg-elevated/50 border border-default rounded-md p-3 whitespace-pre-wrap break-all">{{ startPlain.command }}</pre>
            </div>
            <div class="space-y-1 text-muted">
              <p>
                b. Claude Code asks <span class="text-default">"Quick safety check: Is this a project you created or one you
                  trust?"</span> The arrow <span class="font-mono text-default">❯</span> starts on
                <span class="text-default">"No, exit"</span>. Press <kbd class="font-mono text-default">↓</kbd> until the
                arrow is on <span class="text-default">"Yes, I trust this folder"</span> (once is enough), then press Enter.
              </p>
              <p class="text-xs">
                Pressed Enter too soon and Claude Code closed? Paste the lines from a. again.
              </p>
            </div>
            <div class="space-y-1">
              <div class="flex items-center gap-2">
                <p class="text-muted flex-1">
                  c. When you see the box with <span class="font-mono">❯</span> at the bottom, paste this message and press
                  Enter:
                </p>
                <UButton
                  icon="i-lucide-copy"
                  label="Copy"
                  size="xs"
                  color="neutral"
                  variant="soft"
                  @click="copy(startPlain.message)"
                />
              </div>
              <pre class="text-xs bg-elevated/50 border border-default rounded-md p-3 whitespace-pre-wrap">{{ startPlain.message }}</pre>
            </div>
            <p class="text-muted">
              d. Claude Code asks before it runs a command or reads a file the first time ("Do you want to proceed?"). Use
              <kbd class="font-mono text-default">↓</kbd> to put the arrow on the option that starts with
              <span class="text-default">"Yes, and don't ask again"</span> and press Enter, so the crew does not wait for
              you on the next one. Keep an eye on the window for the first few minutes: more of these come while the crew
              settles in.
            </p>
          </div>

          <div class="rounded-lg border border-default p-4 text-sm text-muted space-y-2">
            <p>
              <span class="font-medium text-default">Good result:</span> Boss writes that it launched the crew members.
              Within a few minutes, "key last used" for this crew on the
              <NuxtLink
                to="/admin/crews"
                target="_blank"
                class="text-primary hover:underline"
              >Crews page</NuxtLink> shows the current time. Leave Boss's session open while the crew works.
            </p>
            <p>
              <span class="font-medium text-default">Give it work:</span> the board starts empty. Open the board, add a
              task in Backlog for each thing you want done, in plain words, and assign it to
              <span class="text-default">{{ creds?.people.pm?.name ?? 'the project manager' }}</span>: being assigned
              is what she notices. Within a minute or two she splits it up and hands the parts to the workers. A task
              that is ready for you to check lands in Verify.
            </p>
            <p>
              <span class="font-medium text-default">To stop the crew:</span> type
              <span class="font-mono text-default">stand down the crew</span> in Boss's session and press Enter. To cut it
              off from Taskmanager at once, press Disable next to it on the Crews page.
            </p>
          </div>

          <details class="rounded-lg border border-default p-4 text-sm text-muted">
            <summary class="cursor-pointer font-medium text-default">
              Optional, for experienced users: faster reactions with channels
            </summary>
            <div class="mt-3 space-y-3">
              <p>
                With channels, the board pushes each new card and reply straight into the project manager's window instead
                of her checking every minute. It takes two new windows instead of Way 1 or Way 2 above. Your organisation
                may have channels switched off: then Claude Code shows <span class="text-default">"blocked by org
                  policy"</span> when it starts, and nothing arrives. In that case type <span class="font-mono">/exit</span>
                and use Way 1 or Way 2 above.
              </p>
              <p>
                Two questions come first in each window. The safety check, as above. Then
                <span class="text-default">"New MCP server found in this project: taskmanager-crew"</span>: the arrow
                starts on <span class="text-default">"Continue without using this MCP server"</span>. Press
                <kbd class="font-mono">↑</kbd> until it is on <span class="text-default">"Use this MCP server"</span>
                (twice), then Enter.
              </p>
              <div
                v-for="item in startChannels"
                :key="item.id"
                class="space-y-2 border-t border-default pt-3"
              >
                <p class="font-medium text-default">
                  {{ item.title }}
                </p>
                <div class="flex items-center gap-2">
                  <p class="text-xs flex-1">
                    Commands, in a new terminal window:
                  </p>
                  <UButton
                    icon="i-lucide-copy"
                    label="Copy"
                    size="xs"
                    color="neutral"
                    variant="soft"
                    @click="copy(item.command)"
                  />
                </div>
                <pre class="text-xs font-mono bg-elevated/50 border border-default rounded-md p-3 whitespace-pre-wrap break-all">{{ item.command }}</pre>
                <div class="flex items-center gap-2">
                  <p class="text-xs flex-1">
                    First message:
                  </p>
                  <UButton
                    icon="i-lucide-copy"
                    label="Copy"
                    size="xs"
                    color="neutral"
                    variant="soft"
                    @click="copy(item.message)"
                  />
                </div>
                <pre class="text-xs bg-elevated/50 border border-default rounded-md p-3 whitespace-pre-wrap">{{ item.message }}</pre>
              </div>
            </div>
          </details>

          <div class="rounded-lg border border-default p-4 text-sm text-muted space-y-2">
            <div class="flex flex-wrap gap-2">
              <UButton
                v-if="creds?.crew.boardUrl"
                :to="creds.crew.boardUrl"
                label="Open the board"
                size="sm"
                target="_blank"
              />
              <UButton
                to="/admin/crews"
                label="Back to Crews"
                size="sm"
                color="neutral"
                variant="outline"
              />
            </div>
          </div>
        </section>

        <div class="flex items-center justify-between gap-3">
          <UButton
            label="Back"
            icon="i-lucide-arrow-left"
            color="neutral"
            variant="ghost"
            :disabled="!canBack"
            @click="step--"
          />
          <p
            v-if="nextHint"
            class="text-xs text-muted text-center"
          >
            {{ nextHint }}
          </p>
          <UButton
            v-if="step < STEPS.length - 1"
            label="Next"
            trailing-icon="i-lucide-arrow-right"
            :disabled="!canNext"
            @click="step++"
          />
        </div>
      </template>
    </div>
  </div>
</template>
