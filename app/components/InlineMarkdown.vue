<script setup lang="ts">
import { computed } from 'vue'
import { renderCommentMarkdown } from '~/utils/markdown'

// Renders a task comment: the Markdown it is stored as, drawn like a task description.
// GFM with breaks: true (a line break stays a line break, as it always did), then the
// chat sanitiser: fences, lists and headings draw; script stays inert.
// Bodies from agents over MCP are untrusted, so this is the chat sanitiser, not raw HTML.
const props = defineProps<{ text: string }>()

const html = computed(() => renderCommentMarkdown(props.text))
</script>

<template>
  <div
    class="markdown-content comment-body w-full min-w-0 break-words"
    v-html="html"
  />
</template>
