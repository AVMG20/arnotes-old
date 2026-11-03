<script setup lang="ts">
definePageMeta({ layout: 'app' })
useSeoMeta({ title: 'Sprocket' })

const { sidebarOpen } = useSidebar()
const toast = useToast()
const { settings, agent, load, save } = useSprocketSettings()

const loadError = ref<string | null>(null)
onMounted(() => {
  load(true).catch((e) => {
    loadError.value = errMsg(e) ?? 'Could not load the Sprocket settings'
  })
})

function errMsg(e: unknown): string | undefined {
  return (e as { data?: { message?: string } })?.data?.message
}

const saving = ref(false)
async function update(patch: Parameters<typeof save>[0], done = 'Saved') {
  saving.value = true
  try {
    await save(patch)
    toast.add({ title: done, icon: 'i-lucide-check', duration: 1500 })
  } catch (e) {
    toast.add({ title: 'Could not save', description: errMsg(e), icon: 'i-lucide-alert-triangle', color: 'error' })
  } finally {
    saving.value = false
  }
}

const claude = computed(() => settings.value?.claude)
const claudeReady = computed(() => !!claude.value?.allowed && !!claude.value.available)

const agentItems = computed(() => (settings.value?.agents ?? []).map(a => ({
  label: a.name,
  value: a.id,
  description: `${a.workspace} · ${a.keyPrefix}…${a.usable ? '' : ' · cannot read boards, or expired'}`,
  disabled: !a.usable
})))

const modelItems = computed(() => {
  const models = [...(settings.value?.models ?? [])]
  const current = settings.value?.model
  if (current && !models.includes(current)) models.unshift(current)
  return models
})

// The select cannot hold an empty value, so "Claude Code's own default" is a word of its own.
const DEFAULT_EFFORT = 'default'
const effortItems = computed(() => [
  { label: 'Claude Code default', value: DEFAULT_EFFORT },
  ...(settings.value?.efforts ?? []).map(e => ({ label: e, value: e }))
])
const effortValue = computed(() => settings.value?.effort ?? DEFAULT_EFFORT)

// ─── Connect an agent ────────────────────────────────────────

const origin = computed(() => (import.meta.client ? window.location.origin : ''))

const mcpCommand = computed(() =>
  `claude mcp add --transport http taskmanager ${origin.value}/api/mcp \\\n  --header "Authorization: Bearer arn_your_key_here"`
)

const kitCommands = computed(() => [
  'mkdir -p ~/crew-kit ~/.claude/skills/taskmanager-crew',
  `curl -fsSL ${origin.value}/crew/kit.tar.gz | tar -xz -C ~/crew-kit`,
  `curl -fsSL ${origin.value}/crew/SKILL.md -o ~/.claude/skills/taskmanager-crew/SKILL.md`,
  'cd ~/crew-kit && npm install'
].join('\n'))

// Written by the shell, so $HOME is the agent machine's own.
const channelCommand = computed(() => `cat > .mcp.json <<EOF
{
  "mcpServers": {
    "taskmanager-crew": {
      "command": "node",
      "args": ["$HOME/crew-kit/channel.mjs", "pm"],
      "env": { "CREW_HOME": "$HOME/crew-home" }
    }
  }
}
EOF
claude --dangerously-load-development-channels server:taskmanager-crew`)

const instructions = computed(() => `Set yourself up to work with my Taskmanager at ${origin.value}.

1. Connect its MCP server. I will give you an API key (it starts with arn_); run:
   claude mcp add --transport http taskmanager ${origin.value}/api/mcp --header "Authorization: Bearer <the key>"
2. Install the crew kit and its skill:
${kitCommands.value.split('\n').map(line => `   ${line}`).join('\n')}
3. Read ~/crew-kit/README.md and take me through "A provisioned crew" if I want to run a crew.
   The crew's home folder is ~/crew-home (CREW_HOME); creds.json goes there, never into a repository.
4. For crew channels, put a .mcp.json in the folder a crew member's session starts from, as the
   README's "Channels" section shows, with the full paths of ~/crew-kit/channel.mjs and ~/crew-home.

Ask me for anything you need, and never print the key or creds.json.`)

const copiedKey = ref<string | null>(null)

async function copy(text: string, id: string) {
  try {
    await navigator.clipboard.writeText(text)
    copiedKey.value = id
    setTimeout(() => {
      if (copiedKey.value === id) copiedKey.value = null
    }, 2000)
  } catch {
    toast.add({ title: 'Could not copy — select the text and copy it manually', icon: 'i-lucide-alert-triangle', color: 'error' })
  }
}

async function copySkill() {
  try {
    await copy(await $fetch<string>('/api/settings/skill', { responseType: 'text' }), 'skill')
  } catch (e) {
    toast.add({ title: 'Could not load the skill', description: errMsg(e), icon: 'i-lucide-alert-triangle', color: 'error' })
  }
}
</script>

<template>
  <div class="flex-1 min-w-0 flex flex-col overflow-hidden pb-14 lg:pb-0">
    <div class="sticky top-0 z-10 border-b border-default bg-default/95 backdrop-blur-sm shrink-0">
      <div class="px-4 pt-3 pb-3.5 flex items-center gap-3">
        <UButton
          to="/settings"
          icon="i-lucide-arrow-left"
          color="neutral"
          variant="ghost"
          size="xs"
          aria-label="Back to settings"
        />
        <h1 class="font-semibold text-sm">
          Sprocket
        </h1>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto">
      <UContainer class="py-6 space-y-4">
        <UAlert
          v-if="loadError"
          color="error"
          variant="subtle"
          icon="i-lucide-alert-triangle"
          :title="loadError"
        />

        <!-- Who answers -->
        <div class="rounded-xl border border-default bg-default overflow-hidden">
          <div class="px-5 py-3 border-b border-default bg-elevated/40 flex items-center gap-2">
            <UIcon
              name="i-lucide-cog"
              class="size-4 text-primary"
            />
            <span class="text-xs font-semibold text-muted uppercase tracking-wider">Who answers as Sprocket</span>
          </div>

          <div
            v-if="settings"
            class="p-5 grid gap-3 sm:grid-cols-2"
          >
            <button
              type="button"
              class="text-left rounded-lg border p-4 transition-colors cursor-pointer"
              :class="settings.provider === 'openrouter' ? 'border-primary bg-primary/5' : 'border-default hover:bg-elevated/40'"
              :disabled="saving"
              @click="update({ provider: 'openrouter' }, 'OpenRouter answers now')"
            >
              <p class="text-sm font-medium flex items-center gap-2">
                <UIcon
                  name="i-lucide-cloud"
                  class="size-4"
                />
                OpenRouter
              </p>
              <p class="text-xs text-muted mt-1">
                A model of your choice through your own OpenRouter key, paid per token.
                <template v-if="settings.hasOpenRouterKey">
                  Now: <code class="font-mono">{{ settings.openrouterModel }}</code>.
                </template>
                <template v-else>
                  No key yet.
                </template>
              </p>
            </button>

            <button
              type="button"
              class="text-left rounded-lg border p-4 transition-colors"
              :class="[
                settings.provider === 'agent' ? 'border-primary bg-primary/5' : 'border-default',
                claudeReady ? 'cursor-pointer hover:bg-elevated/40' : 'opacity-60 cursor-not-allowed'
              ]"
              :disabled="saving || !claudeReady"
              @click="update({ provider: 'agent' }, 'Claude Code answers now')"
            >
              <p class="text-sm font-medium flex items-center gap-2">
                <UIcon
                  name="i-lucide-terminal"
                  class="size-4"
                />
                Claude Code
              </p>
              <p class="text-xs text-muted mt-1">
                <template v-if="!claude?.allowed">
                  Only the instance admin can use it on this server.
                </template>
                <template v-else-if="!claude.available">
                  Claude Code is not installed where this server runs.
                </template>
                <template v-else>
                  Runs <code class="font-mono">claude -p</code> on this server with its Claude Code login,
                  working as one of your agents. {{ claude.version }}
                </template>
              </p>
            </button>
          </div>

          <div
            v-else-if="!loadError"
            class="p-5 text-xs text-muted"
          >
            Loading…
          </div>

          <p
            v-if="settings?.provider === 'openrouter'"
            class="px-5 pb-4 text-xs text-muted"
          >
            The OpenRouter key and model are set in
            <NuxtLink
              to="/settings"
              class="text-primary underline"
            >Settings</NuxtLink>.
          </p>
        </div>

        <!-- Claude Code -->
        <div
          v-if="settings && claudeReady"
          class="rounded-xl border border-default bg-default overflow-hidden"
        >
          <div class="px-5 py-3 border-b border-default bg-elevated/40 flex items-center gap-2">
            <UIcon
              name="i-lucide-terminal"
              class="size-4 text-primary"
            />
            <span class="text-xs font-semibold text-muted uppercase tracking-wider">Claude Code</span>
          </div>

          <div class="divide-y divide-default">
            <div class="px-5 py-4 space-y-2">
              <p class="text-sm font-medium">
                Agent
              </p>
              <p class="text-xs text-muted">
                Sprocket works as this agent: it sees and changes what the agent may, in the agent's
                workspace, and the agent audit shows what it did under the agent's name. Agents are the API
                keys you made; one needs at least board read access.
              </p>
              <USelectMenu
                :model-value="settings.agentKeyId ?? undefined"
                :items="agentItems"
                value-key="value"
                placeholder="Pick an agent"
                class="w-full"
                :disabled="saving"
                @update:model-value="(id: string) => update({ agentKeyId: id }, 'Agent picked')"
              />
              <p
                v-if="!agentItems.length"
                class="text-xs text-muted"
              >
                No agents yet. Create a key under
                <NuxtLink
                  to="/settings"
                  class="text-primary underline"
                >Settings → API keys</NuxtLink>.
              </p>
              <p
                v-else-if="agent"
                class="text-xs text-muted"
              >
                Works in <span class="text-default">{{ agent.workspace }}</span>
                {{ agent.scopes.includes('boards:write') ? 'and can change boards' : 'and can only read' }}.
              </p>
            </div>

            <div class="px-5 py-4 grid gap-4 sm:grid-cols-2">
              <div class="space-y-2">
                <p class="text-sm font-medium">
                  Model
                </p>
                <USelectMenu
                  :model-value="settings.model"
                  :items="modelItems"
                  create-item
                  class="w-full"
                  :disabled="saving"
                  @update:model-value="(model: string) => update({ model }, 'Model saved')"
                  @create="(model: string) => update({ model }, 'Model saved')"
                />
                <p class="text-xs text-muted">
                  An alias picks Claude Code's newest model of that kind; type a full model name for one exact model.
                </p>
              </div>
              <div class="space-y-2">
                <p class="text-sm font-medium">
                  Effort
                </p>
                <USelect
                  :model-value="effortValue"
                  :items="effortItems"
                  class="w-full"
                  :disabled="saving"
                  @update:model-value="(e: string) => update({ effort: e === DEFAULT_EFFORT ? null : e }, 'Effort saved')"
                />
                <p class="text-xs text-muted">
                  How hard the model thinks before it answers. Lower is quicker.
                </p>
              </div>
            </div>
          </div>
        </div>

        <!-- Connect an agent -->
        <div class="rounded-xl border border-default bg-default overflow-hidden">
          <div class="px-5 py-3 border-b border-default bg-elevated/40 flex items-center gap-2">
            <UIcon
              name="i-lucide-plug-zap"
              class="size-4 text-primary"
            />
            <span class="text-xs font-semibold text-muted uppercase tracking-wider">Connect an agent</span>
          </div>

          <div class="divide-y divide-default">
            <div class="px-5 py-4 space-y-2">
              <div class="flex items-center gap-2">
                <p class="text-sm font-medium">
                  Everything at once, for Claude Code
                </p>
                <UButton
                  :icon="copiedKey === 'all' ? 'i-lucide-check' : 'i-lucide-copy'"
                  :label="copiedKey === 'all' ? 'Copied' : 'Copy'"
                  color="primary"
                  variant="soft"
                  size="xs"
                  class="ml-auto"
                  @click="copy(instructions, 'all')"
                />
              </div>
              <p class="text-xs text-muted">
                Paste this into a Claude Code session on the agent's machine: it connects the MCP server and
                installs the crew kit and its skill. Hand it the API key when it asks.
              </p>
              <pre class="text-xs font-mono bg-elevated/50 border border-default rounded-md p-3 overflow-x-auto max-h-64">{{ instructions }}</pre>
            </div>

            <div class="px-5 py-4 space-y-2">
              <div class="flex items-center gap-2">
                <p class="text-sm font-medium">
                  MCP server
                </p>
                <UButton
                  :icon="copiedKey === 'mcp' ? 'i-lucide-check' : 'i-lucide-copy'"
                  :label="copiedKey === 'mcp' ? 'Copied' : 'Copy'"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  class="ml-auto"
                  @click="copy(mcpCommand, 'mcp')"
                />
              </div>
              <pre class="text-xs font-mono bg-elevated/50 border border-default rounded-md p-3 overflow-x-auto">{{ mcpCommand }}</pre>
              <p class="text-xs text-muted">
                A new key under Settings → API keys shows this command with the key filled in. More clients on
                <NuxtLink
                  to="/mcp"
                  class="text-primary underline"
                >Connect an AI agent</NuxtLink>.
              </p>
            </div>

            <div class="px-5 py-4 space-y-2">
              <div class="flex items-center gap-2">
                <p class="text-sm font-medium">
                  Taskmanager skill
                </p>
                <UButton
                  :icon="copiedKey === 'skill' ? 'i-lucide-check' : 'i-lucide-copy'"
                  :label="copiedKey === 'skill' ? 'Copied' : 'Copy SKILL.md'"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  class="ml-auto"
                  @click="copySkill"
                />
              </div>
              <p class="text-xs text-muted">
                How to use the board tools well. Save it as
                <code class="font-mono">~/.claude/skills/taskmanager/SKILL.md</code>; on a Mac, after copying:
                <code class="font-mono">mkdir -p ~/.claude/skills/taskmanager &amp;&amp; pbpaste &gt; ~/.claude/skills/taskmanager/SKILL.md</code>
              </p>
            </div>

            <div class="px-5 py-4 space-y-2">
              <div class="flex items-center gap-2">
                <p class="text-sm font-medium">
                  Crew kit and its skill
                </p>
                <UButton
                  :icon="copiedKey === 'kit' ? 'i-lucide-check' : 'i-lucide-copy'"
                  :label="copiedKey === 'kit' ? 'Copied' : 'Copy'"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  class="ml-auto"
                  @click="copy(kitCommands, 'kit')"
                />
              </div>
              <pre class="text-xs font-mono bg-elevated/50 border border-default rounded-md p-3 overflow-x-auto">{{ kitCommands }}</pre>
              <p class="text-xs text-muted">
                Needs Node 20 or newer. The kit comes from this server, so it always matches it; run the same
                commands again to update. Then follow <code class="font-mono">~/crew-kit/README.md</code>.
              </p>
            </div>

            <div class="px-5 py-4 space-y-2">
              <div class="flex items-center gap-2">
                <p class="text-sm font-medium">
                  Crew channel
                </p>
                <UButton
                  :icon="copiedKey === 'channel' ? 'i-lucide-check' : 'i-lucide-copy'"
                  :label="copiedKey === 'channel' ? 'Copied' : 'Copy'"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  class="ml-auto"
                  @click="copy(channelCommand, 'channel')"
                />
              </div>
              <pre class="text-xs font-mono bg-elevated/50 border border-default rounded-md p-3 overflow-x-auto">{{ channelCommand }}</pre>
              <p class="text-xs text-muted">
                Run it in the folder a crew member's session starts from, once the crew is provisioned. Board
                events then reach that session as they happen. <code class="font-mono">pm</code> is the member;
                use one folder per member.
              </p>
            </div>
          </div>
        </div>
      </UContainer>
    </div>
  </div>

  <div
    class="fixed bottom-0 left-0 right-0 z-20 lg:hidden flex items-center justify-around px-8 border-t border-default bg-default/95 backdrop-blur-sm"
    style="padding-top: 0.5rem; padding-bottom: max(0.5rem, env(safe-area-inset-bottom))"
  >
    <UButton
      icon="i-lucide-panel-left"
      color="neutral"
      variant="ghost"
      size="md"
      aria-label="Open sidebar"
      @click="sidebarOpen = true"
    />
    <UButton
      to="/settings"
      icon="i-lucide-arrow-left"
      color="neutral"
      variant="ghost"
      size="md"
      aria-label="Back to settings"
    />
  </div>
</template>
