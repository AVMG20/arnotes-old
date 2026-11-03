<script setup lang="ts">
import { computed, nextTick, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import type { ChatMessage } from '~/composables/useAiChat'

// ─── Panel state ─────────────────────────────────────────────

const open = ref(false)
const expanded = useCookie<boolean>('sprocket-expanded', { default: () => false, maxAge: 60 * 60 * 24 * 365 })

const { messages, thinking, busy, send, retry, stop, clearChat } = useAiChat()
const { openrouterModel, openrouterApiKey, openrouterApiKeyMasked } = useUserSettings()
const { settings: sprocket, answeredBy, load: loadSprocket } = useSprocketSettings()
const router = useRouter()

const input = ref('')
const inputEl = ref<HTMLTextAreaElement | null>(null)
const scrollEl = ref<HTMLElement | null>(null)

const byAgent = computed(() => sprocket.value?.provider === 'agent')
const hasApiKey = computed(() => !!openrouterApiKey.value || !!openrouterApiKeyMasked.value)
const ready = computed(() => byAgent.value ? !!sprocket.value?.agentKeyId : hasApiKey.value)

function toggle() {
  open.value = !open.value
  if (open.value) {
    // A change on the settings page shows the next time the panel opens.
    loadSprocket(true).catch(() => {})
    nextTick(() => inputEl.value?.focus())
  }
}

// Escape closes the panel, unless a menu or dialog on top of it owns the key.
// Clicking elsewhere in the app deliberately does *not* close it: the chat is a
// side panel you work alongside, not a modal.
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !open.value) return
  if (document.querySelector('[data-reka-popper-content-wrapper], [role="dialog"], [role="menu"]')) return
  open.value = false
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

// ─── Sending ─────────────────────────────────────────────────

function autoGrow() {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`
}

async function submit() {
  const text = input.value.trim()
  if (!text || busy.value) return
  input.value = ''
  nextTick(autoGrow)
  await send(text)
}

function onInputKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submit()
  }
}

function useSuggestion(text: string) {
  input.value = text
  nextTick(() => {
    inputEl.value?.focus()
    autoGrow()
  })
}

// ─── Rendering ───────────────────────────────────────────────

const toolIcon: Record<string, string> = {
  list_boards: 'i-lucide-kanban',
  get_board: 'i-lucide-square-kanban',
  create_board: 'i-lucide-kanban',
  search_tasks: 'i-lucide-search',
  create_task: 'i-lucide-square-plus',
  update_task: 'i-lucide-pencil-line',
  move_task: 'i-lucide-move',
  delete_task: 'i-lucide-trash-2'
}

const toolVerb: Record<string, string> = {
  list_boards: 'Listing boards',
  get_board: 'Reading a board',
  create_board: 'Creating a board',
  search_tasks: 'Searching tasks',
  create_task: 'Creating a task',
  update_task: 'Updating a task',
  move_task: 'Moving a task',
  delete_task: 'Moving a task to trash'
}

// While the model writes a long tool argument (a whole task description) no
// text streams in, so say what it is doing instead of showing a bare spinner.
function pendingLabel(m: ChatMessage): string {
  if (m.retrying) return 'Connection lost — reconnecting…'
  const call = m.toolProgress?.[m.toolProgress.length - 1]
  if (call?.name) return `${toolVerb[call.name] ?? call.name}…`
  const running = m.agentTools?.findLast(tool => tool.state === 'running')
  if (running) return `${toolVerb[running.name] ?? `Using ${running.name}`}…`
  return 'Thinking…'
}

const SUGGESTIONS = [
  { icon: 'i-lucide-search', label: 'Find tasks about ' },
  { icon: 'i-lucide-square-plus', label: 'Create a task for ' },
  { icon: 'i-lucide-kanban', label: 'What boards do I have?' }
]

const hasContent = computed(() => messages.value.some(m => m.role === 'user' || m.content))
const lastMessage = computed(() => messages.value[messages.value.length - 1])
const canRetry = computed(() => !busy.value && !!lastMessage.value?.error)

// ─── Auto-scroll ─────────────────────────────────────────────

const pinnedToBottom = ref(true)

function onScroll() {
  const el = scrollEl.value
  if (!el) return
  pinnedToBottom.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 80
}

async function scrollToBottom() {
  await nextTick()
  const el = scrollEl.value
  if (el) el.scrollTop = el.scrollHeight
  pinnedToBottom.value = true
}

watch(messages, () => {
  if (pinnedToBottom.value) scrollToBottom()
}, { deep: true })

watch([open, expanded], ([isOpen]) => {
  if (isOpen) scrollToBottom()
})

function openTarget(m: ChatMessage) {
  if (!m.targetUrl) return
  router.push(m.targetUrl)
  if (window.innerWidth < 640) open.value = false
}
</script>

<template>
  <!-- Floating launcher -->
  <button
    v-if="!open"
    class="fixed bottom-5 right-5 z-60 flex size-10 cursor-pointer items-center justify-center rounded-full border border-primary/30 bg-elevated text-primary shadow-md transition-all hover:border-primary/60 hover:bg-primary/10 active:scale-95 max-lg:bottom-20"
    aria-label="Open Sprocket chat"
    @click="toggle"
  >
    <UIcon
      name="i-lucide-cog"
      class="size-4.5"
    />
  </button>

  <!-- Chat panel: bottom sheet on phones, floating card from `sm` up -->
  <div
    v-else
    class="fixed z-60 flex flex-col overflow-hidden border border-default bg-default shadow-2xl
           inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl
           sm:inset-x-auto sm:bottom-5 sm:right-5 sm:max-h-[calc(100dvh-3rem)] sm:rounded-2xl max-lg:sm:bottom-20"
    :class="expanded ? 'sm:w-[760px] sm:h-[calc(100dvh-6rem)]' : 'sm:w-[420px]'"
    style="max-width: 100vw"
  >
    <!-- Header -->
    <div class="flex shrink-0 items-center gap-2.5 border-b border-default/60 px-4 py-2.5">
      <div class="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <UIcon
          name="i-lucide-cog"
          class="size-4"
        />
      </div>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-semibold leading-tight text-default">
          Sprocket
        </p>
        <p class="truncate text-xs leading-tight text-muted">
          {{ answeredBy ?? openrouterModel }}
        </p>
      </div>

      <UButton
        to="/settings/sprocket"
        icon="i-lucide-settings-2"
        color="neutral"
        variant="ghost"
        size="xs"
        aria-label="Sprocket settings"
        title="Who answers as Sprocket"
      />

      <UTooltip text="Show the model's reasoning">
        <label class="flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted transition-colors hover:bg-elevated hover:text-default">
          <UIcon
            name="i-lucide-brain"
            class="size-4"
            :class="thinking ? 'text-primary' : ''"
          />
          <span class="max-sm:sr-only">Thinking</span>
          <USwitch
            v-model="thinking"
            size="xs"
          />
        </label>
      </UTooltip>

      <UButton
        :icon="expanded ? 'i-lucide-minimize-2' : 'i-lucide-maximize-2'"
        color="neutral"
        variant="ghost"
        size="xs"
        class="max-sm:hidden"
        :aria-label="expanded ? 'Shrink chat' : 'Expand chat'"
        @click="expanded = !expanded"
      />
      <UButton
        icon="i-lucide-rotate-ccw"
        color="neutral"
        variant="ghost"
        size="xs"
        aria-label="New chat"
        @click="clearChat"
      />
      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        size="xs"
        aria-label="Close chat"
        @click="open = false"
      />
    </div>

    <!-- Messages -->
    <div
      ref="scrollEl"
      class="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4"
      @scroll="onScroll"
    >
      <!-- Empty state -->
      <div
        v-if="!hasContent && !busy"
        class="flex h-full flex-col items-center justify-center gap-1 px-4 text-center"
      >
        <div class="mb-2 flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
          <UIcon
            name="i-lucide-cog"
            class="size-5"
          />
        </div>
        <p class="text-sm font-medium text-default">
          Hi, I'm Sprocket
        </p>
        <p class="text-xs text-muted">
          I keep an eye on your boards. Ask me to find, plan or tidy up your tasks.
        </p>

        <div
          v-if="!ready"
          class="mt-4 w-full rounded-lg border border-default bg-elevated/40 p-3 text-left"
        >
          <p class="text-xs text-default">
            {{ byAgent ? 'Pick the agent I work as, and I am ready.' : 'No OpenRouter API key yet. Add one, or let Claude Code answer.' }}
          </p>
          <UButton
            label="Sprocket settings"
            icon="i-lucide-settings-2"
            size="xs"
            color="primary"
            variant="soft"
            class="mt-2"
            to="/settings/sprocket"
            @click="open = false"
          />
        </div>

        <div
          v-else
          class="mt-4 w-full space-y-1.5"
        >
          <button
            v-for="s in SUGGESTIONS"
            :key="s.label"
            class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-default/60 px-3 py-2.5 text-left text-xs text-default transition-colors hover:bg-elevated/60"
            @click="useSuggestion(s.label)"
          >
            <UIcon
              :name="s.icon"
              class="size-4 shrink-0 text-primary"
            />
            {{ s.label }}
          </button>
        </div>
      </div>

      <template
        v-for="m in messages"
        :key="m.id"
      >
        <!-- User -->
        <div
          v-if="m.role === 'user'"
          class="flex justify-end"
        >
          <div class="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-inverted">
            {{ m.content }}
          </div>
        </div>

        <!-- Tool activity -->
        <div
          v-else-if="m.role === 'tool'"
          class="flex"
        >
          <button
            class="inline-flex max-w-full items-center gap-1.5 rounded-full border border-default/60 px-2.5 py-1 text-xs transition-colors hover:bg-elevated/60"
            :class="[
              m.targetUrl ? 'cursor-pointer hover:text-default' : 'cursor-default',
              m.error ? 'text-error' : 'text-muted'
            ]"
            @click="openTarget(m)"
          >
            <UIcon
              :name="m.pending ? 'i-lucide-loader-circle' : (toolIcon[m.name ?? ''] ?? 'i-lucide-wrench')"
              class="size-3.5 shrink-0"
              :class="{ 'animate-spin': m.pending }"
            />
            <span class="truncate">{{ m.label ?? m.name }}</span>
            <UIcon
              v-if="m.targetUrl"
              name="i-lucide-arrow-up-right"
              class="size-3 shrink-0 opacity-50"
            />
          </button>
        </div>

        <!-- Assistant -->
        <div
          v-else
          class="space-y-2"
        >
          <!-- Reasoning (thinking models) -->
          <details
            v-if="m.reasoning?.trim()"
            class="group rounded-lg border border-default/60"
          >
            <summary class="flex cursor-pointer select-none items-center gap-1.5 px-3 py-1.5 text-xs text-muted">
              <UIcon
                name="i-lucide-brain"
                class="size-3.5"
                :class="m.pending ? 'animate-pulse text-primary' : ''"
              />
              Thinking
            </summary>
            <div class="max-h-40 overflow-y-auto whitespace-pre-wrap px-3 pb-2 text-xs leading-relaxed text-muted">
              {{ m.reasoning }}
            </div>
          </details>

          <!-- Tools a Claude Code run used; it ran them itself -->
          <div
            v-if="m.agentTools?.length"
            class="flex flex-wrap gap-1.5"
          >
            <span
              v-for="tool in m.agentTools"
              :key="tool.id"
              class="inline-flex max-w-full items-center gap-1.5 rounded-full border border-default/60 px-2.5 py-1 text-xs"
              :class="tool.state === 'error' ? 'text-error' : 'text-muted'"
            >
              <UIcon
                :name="tool.state === 'running' ? 'i-lucide-loader-circle' : (toolIcon[tool.name] ?? 'i-lucide-wrench')"
                class="size-3.5 shrink-0"
                :class="{ 'animate-spin': tool.state === 'running' }"
              />
              <span class="truncate">{{ tool.name }}</span>
            </span>
          </div>

          <ChatMarkdown
            v-if="m.content"
            class="max-w-full text-sm leading-relaxed text-default"
            :class="m.error ? 'text-error' : ''"
            :text="m.content"
          />

          <div
            v-if="m.pending && (m.retrying || m.toolProgress?.length || m.agentTools?.some(tool => tool.state === 'running') || (!m.content && !m.reasoning))"
            class="flex items-center gap-1.5 text-xs"
            :class="m.retrying ? 'text-warning' : 'text-muted'"
          >
            <UIcon
              :name="m.retrying ? 'i-lucide-wifi-off' : 'i-lucide-loader-circle'"
              class="size-3.5"
              :class="{ 'animate-spin': !m.retrying }"
            />
            {{ pendingLabel(m) }}
          </div>
        </div>
      </template>

      <div
        v-if="canRetry"
        class="flex"
      >
        <UButton
          label="Retry"
          icon="i-lucide-rotate-cw"
          size="xs"
          color="neutral"
          variant="outline"
          @click="retry"
        />
      </div>
    </div>

    <!-- Jump to latest -->
    <button
      v-if="!pinnedToBottom && hasContent"
      class="absolute bottom-24 left-1/2 z-10 flex -translate-x-1/2 cursor-pointer items-center gap-1 rounded-full border border-default bg-default px-2.5 py-1 text-xs text-muted shadow-md transition-colors hover:text-default"
      @click="scrollToBottom"
    >
      <UIcon
        name="i-lucide-arrow-down"
        class="size-3.5"
      />
      Latest
    </button>

    <!-- Composer -->
    <div
      class="shrink-0 p-3 pt-1"
      style="padding-bottom: max(0.75rem, env(safe-area-inset-bottom))"
    >
      <div class="flex items-end gap-2 rounded-xl border border-default bg-elevated/40 px-3 py-2 transition-colors focus-within:border-primary/50">
        <textarea
          ref="inputEl"
          v-model="input"
          rows="1"
          placeholder="Ask about your boards…"
          aria-label="Message Sprocket"
          class="max-h-40 min-h-[1.5rem] flex-1 resize-none bg-transparent text-sm text-default outline-none placeholder:text-muted"
          @keydown="onInputKeydown"
          @input="autoGrow"
        />
        <UButton
          v-if="busy"
          icon="i-lucide-square"
          size="xs"
          color="neutral"
          variant="ghost"
          aria-label="Stop generating"
          @click="stop"
        />
        <UButton
          v-else
          icon="i-lucide-arrow-up"
          size="xs"
          :disabled="!input.trim()"
          aria-label="Send message"
          @click="submit"
        />
      </div>
    </div>
  </div>
</template>
