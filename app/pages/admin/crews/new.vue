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
  people: Record<string, { name?: string, role?: string }>
  board: { name: string } | null
}

const STEPS = [
  { title: 'The crew', description: 'Name and product', icon: 'i-lucide-users' },
  { title: 'Make it', description: 'Accounts and keys', icon: 'i-lucide-wand-sparkles' },
  { title: 'Helper\'s machine', description: 'Kit and files', icon: 'i-lucide-laptop' },
  { title: 'Start', description: 'The PM\'s session', icon: 'i-lucide-play' }
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
const crewReady = computed(() => form.name.trim() && slugValid.value && form.productName.trim())

// ─── 2. Make it ──────────────────────────────────────────────
const creds = ref<CrewCreds | null>(null)
const making = ref(false)
const exists = ref<string | null>(null)
const downloaded = reactive({ creds: false, config: false })

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

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

function downloadCreds() {
  if (!creds.value) return
  download('creds.json', JSON.stringify(creds.value, null, 2))
  downloaded.creds = true
}

function downloadConfig() {
  download('crew.json', crewConfig.value)
  downloaded.config = true
}

// ─── 3 and 4. The helper's machine ───────────────────────────
const origin = import.meta.client ? window.location.origin : ''
const kitCommands = crewKitCommands(origin)
const filesCommands = [
  'mkdir -p ~/crew-home',
  'mv ~/Downloads/creds.json ~/Downloads/crew.json ~/crew-home/',
  'chmod 600 ~/crew-home/creds.json'
].join('\n')
const initCommand = 'cd ~/crew-kit && CREW_HOME=~/crew-home node init.mjs'
const checkCommand = 'cd ~/crew-kit && CREW_HOME=~/crew-home ./crew.mjs w1 mcp my_tasks \'{}\''
const channelCommand = crewChannelCommand()

// Ticks for the helper to keep their place; they leave with the page.
const done = reactive<Record<string, boolean>>({})

const helperSteps = computed(() => [
  { id: 'kit', title: 'Install the crew kit and its skill', text: 'Node 20 or newer. Run it again later to update the kit.', command: kitCommands },
  { id: 'files', title: 'Put the two files in the crew\'s home folder', text: 'From the Downloads folder of this browser. On another machine, move creds.json over a private channel such as scp, never chat or mail.', command: filesCommands },
  { id: 'init', title: 'Check the machine and render the agents\' documents', text: 'It checks Node and a browser and writes CREW.md, PROMPTS.md and the rest into ~/crew-home. Fix what it reports and run it again.', command: initCommand },
  { id: 'check', title: 'Check that a worker reaches the board', text: 'It lists Wren Worker\'s tasks through the agent API: an empty list is fine, an error is not.', command: checkCommand }
])

const agentPrompt = computed(() => `Set up a Taskmanager crew on this machine. Taskmanager runs at ${origin}; the crew "${form.name.trim()}" (${form.slug}) is already made.
creds.json and crew.json are in ~/Downloads. creds.json holds every password and key of the crew: never print it, never copy it into a repository.

${helperSteps.value.map((s, i) => `${i + 1}. ${s.title}:\n${s.command.split('\n').map(line => `   ${line}`).join('\n')}`).join('\n')}
5. Read ~/crew-kit/README.md, "A provisioned crew" and "Channels", and tell me how to start the PM's session with the crew channel:
${channelCommand.split('\n').map(line => `   ${line}`).join('\n')}

Stop and tell me when a step fails rather than working around it.`)

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.add({ title: 'Copied', icon: 'i-lucide-check', duration: 1500 })
  } catch {
    toast.add({ title: 'Could not copy. Select the text and copy it.', color: 'warning' })
  }
}

const canNext = computed(() => {
  if (step.value === 0) return Boolean(crewReady.value)
  if (step.value === 1) return Boolean(creds.value && downloaded.creds && downloaded.config)
  return step.value < STEPS.length - 1
})
// Once the crew is made its details are fixed: going back to step 1 would only confuse.
const canBack = computed(() => step.value > 0 && !(step.value === 1 && creds.value))
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
            Makes the crew here, then takes whoever sets up the agents' machine through it step by step.
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

        <!-- 1. The crew -->
        <section
          v-if="step === 0"
          class="rounded-lg border border-default p-4 space-y-4"
        >
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField
              label="Crew name"
              description="Also the name of its team."
              required
            >
              <UInput
                v-model="form.name"
                placeholder="Acme Crew"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="Slug"
              :description="slugValid || !form.slug ? 'Lowercase letters, digits and hyphens.' : undefined"
              :error="form.slug && !slugValid ? '2 to 63 characters: a to z, 0 to 9 and hyphens, not starting with a hyphen.' : undefined"
              required
            >
              <UInput
                v-model="form.slug"
                placeholder="acme"
                class="w-full font-mono"
                @update:model-value="slugEdited = true"
              />
            </UFormField>
            <UFormField
              label="Product"
              description="What the crew builds. Its board and customer are named after it."
              required
            >
              <UInput
                v-model="form.productName"
                placeholder="Acme App"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="App URL"
              description="Where the product runs while the crew works on it."
            >
              <UInput
                v-model="form.appUrl"
                placeholder="http://localhost:3000"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="Repository"
              description="Full path of the product's repository on the agents' machine."
              class="sm:col-span-2"
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
              label="Talk to the customer in an IRC channel"
              description="Off: meetings and steering go through the board's messages, which needs nothing more."
            />
            <div
              v-if="form.useChat"
              class="grid gap-4 sm:grid-cols-3"
            >
              <UFormField
                label="Chat client"
                description="Full path of the binary."
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

        <!-- 2. Make it -->
        <section
          v-else-if="step === 1"
          class="rounded-lg border border-default p-4 space-y-4"
        >
          <template v-if="!creds">
            <p class="text-sm text-default">
              This makes <span class="font-medium">{{ form.name }}</span>: a team of that name, the customer
              and board for {{ form.productName }}, and ten accounts (a boss, a project manager, four workers, a
              usability tester, a code reviewer and two customer logins), each with its own key.
            </p>
            <UAlert
              v-if="exists"
              color="warning"
              variant="soft"
              icon="i-lucide-triangle-alert"
              :title="exists"
              description="Giving it new keys and passwords re-enables it if it was disabled, and a crew still running on the old creds.json stops working. Or go back and pick another slug."
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
                  label="Open the board"
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
              title="Download both files now."
              description="creds.json holds every password and key of the crew. It exists only on this page: once you leave, getting it again means new keys for the whole crew."
            />
            <div class="flex flex-wrap gap-2">
              <UButton
                :icon="downloaded.creds ? 'i-lucide-check' : 'i-lucide-download'"
                label="creds.json"
                :color="downloaded.creds ? 'success' : 'primary'"
                @click="downloadCreds"
              />
              <UButton
                :icon="downloaded.config ? 'i-lucide-check' : 'i-lucide-download'"
                label="crew.json"
                :color="downloaded.config ? 'success' : 'primary'"
                variant="soft"
                @click="downloadConfig"
              />
            </div>
            <ul class="text-xs text-muted grid gap-1 sm:grid-cols-2">
              <li
                v-for="(person, key) in creds.people"
                :key="key"
              >
                <span class="font-mono text-default">{{ key }}</span> · {{ person.role ? `${person.name}, ${person.role}` : person.name }}
              </li>
            </ul>
          </template>
        </section>

        <!-- 3. The helper's machine -->
        <section
          v-else-if="step === 2"
          class="space-y-3"
        >
          <div class="flex flex-wrap items-center gap-2 rounded-lg border border-default p-4">
            <p class="text-sm text-muted flex-1 min-w-48">
              Run these on the machine the agents work on, in order. An agent can do it too: copy the steps as one
              prompt for Claude Code.
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
          <div
            v-for="(item, i) in helperSteps"
            :key="item.id"
            class="rounded-lg border border-default p-4 space-y-2"
            :class="done[item.id] ? 'opacity-60' : ''"
          >
            <div class="flex items-center gap-2">
              <UCheckbox
                v-model="done[item.id]"
                :aria-label="`Done: ${item.title}`"
              />
              <p class="text-sm font-medium flex-1">
                {{ i + 1 }}. {{ item.title }}
              </p>
              <UButton
                icon="i-lucide-copy"
                label="Copy"
                size="xs"
                color="neutral"
                variant="ghost"
                @click="copy(item.command)"
              />
            </div>
            <p class="text-xs text-muted">
              {{ item.text }}
            </p>
            <pre class="text-xs font-mono bg-elevated/50 border border-default rounded-md p-3 whitespace-pre-wrap break-all">{{ item.command }}</pre>
          </div>
        </section>

        <!-- 4. Start -->
        <section
          v-else
          class="space-y-3"
        >
          <div class="rounded-lg border border-default p-4 space-y-2">
            <div class="flex items-center gap-2">
              <p class="text-sm font-medium flex-1">
                Start the project manager's session
              </p>
              <UButton
                icon="i-lucide-copy"
                label="Copy"
                size="xs"
                color="neutral"
                variant="ghost"
                @click="copy(channelCommand)"
              />
            </div>
            <p class="text-xs text-muted">
              In an empty folder for her session: it writes a .mcp.json that pushes the board's events into the
              session, then starts Claude Code with that channel. Pia reads CREW.md in ~/crew-home and takes it from there.
            </p>
            <pre class="text-xs font-mono bg-elevated/50 border border-default rounded-md p-3 whitespace-pre-wrap break-all">{{ channelCommand }}</pre>
          </div>
          <div class="rounded-lg border border-default p-4 text-sm text-muted space-y-2">
            <p>
              The other people start the same way, each in a folder of their own, with their key in place of
              <code class="font-mono text-default">pm</code>: w1 to w4, pietje, nitpicker. The kit's README covers
              the rest, under "A provisioned crew" and "Channels".
            </p>
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

        <div class="flex items-center justify-between">
          <UButton
            label="Back"
            icon="i-lucide-arrow-left"
            color="neutral"
            variant="ghost"
            :disabled="!canBack"
            @click="step--"
          />
          <p
            v-if="step === 1 && creds && !(downloaded.creds && downloaded.config)"
            class="text-xs text-muted"
          >
            Download both files to go on.
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
