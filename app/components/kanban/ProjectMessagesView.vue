<script setup lang="ts">
import { relativeTime } from '~/composables/useRelativeTime'

// The project's conversations: post a message, answer one, and read them newest
// first. Replies stay under the message they answer. With a threadId it shows that one
// conversation, its reply box open: what the inbox and a mailed link open.
const props = defineProps<{ projectId: string, threadId?: string | null }>()
const emit = defineEmits<{ showAll: [] }>()

interface Message {
  id: string
  parentId: string | null
  title: string
  body: string
  createdAt: number
  author: { id: string, name: string, image: string | null }
}

const { session } = useAuth()
const me = computed(() => session.value?.user)

const messages = useProjectCollection<Message>(() => props.projectId, 'messages', { addAt: 'end' })

const threads = computed(() =>
  messages.items.value
    .filter(message => !message.parentId && (!props.threadId || message.id === props.threadId))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(message => ({ message, replies: messages.items.value.filter(reply => reply.parentId === message.id) }))
)

const title = ref('')
const body = ref('')
const posting = ref(false)
const error = ref('')

// The hint names the keys that post. Phones have no Ctrl or Cmd Enter, so the line
// is kept (it does not jump) but only shown where a keyboard is the pointer.
const POST_HINT = 'Press Ctrl+Enter (Cmd+Enter on a Mac) to post.'
const keyboardDevice = ref(false)
onMounted(() => {
  keyboardDevice.value = window.matchMedia('(pointer: fine)').matches
})

async function post() {
  if (!body.value.trim() || posting.value) return
  posting.value = true
  error.value = ''
  try {
    await messages.add({ title: title.value, body: body.value })
    title.value = ''
    body.value = ''
  } catch (e) {
    error.value = messages.messageOf(e, 'Could not post the message')
  } finally {
    posting.value = false
  }
}

const replyingTo = ref<string | null>(null)
const replyBody = ref('')
const replyError = ref('')
const replyPosting = ref(false)

function openReply(id: string) {
  replyingTo.value = replyingTo.value === id ? null : id
  replyBody.value = ''
  replyError.value = ''
}

// One conversation is opened to be answered, so its reply box starts open.
watch(() => props.threadId, (id) => {
  if (id) {
    replyingTo.value = id
    replyBody.value = ''
    replyError.value = ''
  }
}, { immediate: true })

async function sendReply(parentId: string) {
  if (!replyBody.value.trim() || replyPosting.value) return
  replyPosting.value = true
  replyError.value = ''
  try {
    await messages.add({ body: replyBody.value, parentId })
    replyBody.value = ''
    replyingTo.value = null
  } catch (e) {
    replyError.value = messages.messageOf(e, 'Could not post the reply')
  } finally {
    replyPosting.value = false
  }
}

// A message takes its replies with it, so the list is read again.
async function removeMessage(id: string, isThread: boolean) {
  await messages.remove(id)
  if (isThread) await messages.load()
}
</script>

<template>
  <div class="h-full overflow-y-auto px-4 pb-10 pt-4 lg:px-6">
    <div class="mx-auto max-w-3xl">
      <UButton
        v-if="threadId"
        label="All messages"
        icon="i-lucide-arrow-left"
        size="xs"
        color="neutral"
        variant="ghost"
        data-msg-all
        @click="emit('showAll')"
      />
      <form
        v-else
        class="rounded-xl border border-default bg-default p-3"
        data-msg-composer
        @submit.prevent="post"
      >
        <input
          v-model="title"
          type="text"
          maxlength="200"
          placeholder="Subject (optional)"
          class="w-full bg-transparent text-sm font-medium text-default outline-none placeholder:text-dimmed"
          data-msg-title
        >
        <textarea
          v-model="body"
          rows="3"
          placeholder="Start a conversation with the team…"
          class="mt-2 w-full resize-y bg-transparent text-sm leading-relaxed text-default outline-none placeholder:text-dimmed"
          data-msg-body
          @keydown.ctrl.enter.prevent="post"
          @keydown.meta.enter.prevent="post"
        />
        <div class="mt-2 flex items-center justify-end gap-3">
          <p
            v-if="error"
            class="mr-auto text-xs text-error"
          >
            {{ error }}
          </p>
          <UButton
            type="submit"
            label="Post"
            size="sm"
            :disabled="!body.trim()"
            :loading="posting"
            data-msg-post
          />
        </div>
        <p
          class="mt-2 text-xs text-dimmed"
          data-msg-hint
          :class="keyboardDevice ? '' : 'invisible'"
        >
          {{ POST_HINT }}
        </p>
      </form>

      <ul
        class="space-y-4"
        :class="threadId ? 'mt-3' : 'mt-5'"
      >
        <li
          v-for="{ message, replies } in threads"
          :key="message.id"
          class="rounded-xl border border-default bg-default"
          data-thread
        >
          <div
            class="group p-4"
            data-message
          >
            <div class="flex items-center gap-2">
              <UAvatar
                :src="message.author.image ?? undefined"
                :alt="message.author.name"
                size="xs"
              />
              <span class="text-sm font-medium text-default">{{ message.author.name }}</span>
              <span class="text-xs text-dimmed">{{ relativeTime(message.createdAt) }}</span>
              <button
                v-if="message.author.id === me?.id"
                class="ml-auto text-dimmed opacity-0 transition-opacity hover:text-error focus:opacity-100 group-hover:opacity-100"
                aria-label="Delete message"
                data-message-delete
                @click="removeMessage(message.id, true)"
              >
                <UIcon
                  name="i-lucide-trash-2"
                  class="size-4"
                />
              </button>
            </div>
            <h3
              v-if="message.title"
              class="mt-2 text-base font-semibold text-default"
            >
              {{ message.title }}
            </h3>
            <p class="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-default">
              {{ message.body }}
            </p>
          </div>

          <ul
            v-if="replies.length"
            class="space-y-3 border-t border-default bg-elevated/40 px-4 py-3"
          >
            <li
              v-for="reply in replies"
              :key="reply.id"
              class="group flex gap-2"
              data-reply
            >
              <UAvatar
                :src="reply.author.image ?? undefined"
                :alt="reply.author.name"
                size="2xs"
                class="mt-0.5"
              />
              <div class="min-w-0 flex-1">
                <p class="flex items-center gap-2 text-xs">
                  <span class="font-medium text-default">{{ reply.author.name }}</span>
                  <span class="text-dimmed">{{ relativeTime(reply.createdAt) }}</span>
                  <button
                    v-if="reply.author.id === me?.id"
                    class="ml-auto text-dimmed opacity-0 transition-opacity hover:text-error focus:opacity-100 group-hover:opacity-100"
                    aria-label="Delete reply"
                    data-reply-delete
                    @click="removeMessage(reply.id, false)"
                  >
                    <UIcon
                      name="i-lucide-trash-2"
                      class="size-3.5"
                    />
                  </button>
                </p>
                <p class="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed text-default">
                  {{ reply.body }}
                </p>
              </div>
            </li>
          </ul>

          <div class="border-t border-default px-4 py-2">
            <template v-if="replyingTo === message.id">
              <textarea
                v-model="replyBody"
                rows="2"
                placeholder="Write a reply…"
                class="w-full resize-y rounded-md border border-default bg-transparent p-2 text-sm text-default outline-none placeholder:text-dimmed focus:border-primary"
                data-reply-body
                @keydown.ctrl.enter.prevent="sendReply(message.id)"
                @keydown.meta.enter.prevent="sendReply(message.id)"
              />
              <p
                class="mt-1.5 min-h-4 text-xs text-dimmed"
                :class="keyboardDevice ? '' : 'invisible'"
                data-reply-hint
              >
                {{ POST_HINT }}
              </p>
              <div class="mt-1.5 flex items-center justify-end gap-2">
                <p
                  v-if="replyError"
                  class="mr-auto text-xs text-error"
                >
                  {{ replyError }}
                </p>
                <UButton
                  label="Cancel"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  @click="openReply(message.id)"
                />
                <UButton
                  label="Reply"
                  size="xs"
                  :disabled="!replyBody.trim()"
                  data-reply-post
                  @click="sendReply(message.id)"
                />
              </div>
            </template>
            <button
              v-else
              class="flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-default"
              data-reply-open
              @click="openReply(message.id)"
            >
              <UIcon
                name="i-lucide-corner-down-right"
                class="size-3.5"
              />
              Reply<span
                v-if="replies.length"
                class="text-dimmed"
              > · {{ replies.length }} {{ replies.length === 1 ? 'reply' : 'replies' }}</span>
            </button>
          </div>
        </li>

        <li
          v-if="!threads.length && !messages.loading.value"
          class="rounded-xl border border-dashed border-default px-4 py-10 text-center text-sm text-muted"
        >
          {{ threadId ? 'This conversation was deleted.' : 'No conversations yet. Post the first message above.' }}
        </li>
      </ul>
    </div>
  </div>
</template>
