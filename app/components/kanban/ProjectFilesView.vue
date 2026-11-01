<script setup lang="ts">
const emit = defineEmits<{ openTask: [taskId: string] }>()

const { board, subtasks, isTrashed } = useProjects()

const route = useRoute()

const IMG_SRC = /<img[^>]+src="(\/api\/attachments\/tasks\/[^"]+)"/g

const files = computed(() =>
  [...(board.value?.tasks ?? []), ...subtasks.value]
    .filter(task => !isTrashed(task))
    .flatMap(task =>
      [...(task.description ?? '').matchAll(IMG_SRC)].map(match => ({
        url: match[1]!,
        name: match[1]!.split('/').pop()!,
        taskId: task.parentTaskId ?? task.id,
        taskTitle: task.title
      }))
    )
)

const preview = ref<string | null>(null)
</script>

<template>
  <div class="h-full overflow-y-auto px-4 pb-10 pt-4 lg:px-6">
    <div
      v-if="!files.length"
      class="flex h-full flex-col items-center justify-center gap-2 text-center"
    >
      <UIcon
        name="i-lucide-image"
        class="size-6 text-dimmed"
      />
      <p class="text-sm text-muted">
        Paste or drop an image into any
        <NuxtLink
          :to="{ path: route.path, query: { ...route.query, view: undefined } }"
          class="text-primary hover:underline"
        >task description</NuxtLink> and it shows up here. Only images are listed.
      </p>
    </div>

    <div
      v-else
      class="columns-2 gap-3 md:columns-3 xl:columns-4"
    >
      <figure
        v-for="file in files"
        :key="file.url"
        class="group mb-3 break-inside-avoid overflow-hidden rounded-xl border border-default bg-default transition-shadow hover:shadow-md"
        data-file
      >
        <button
          class="block w-full"
          :aria-label="`Preview ${file.name}`"
          @click="preview = file.url"
        >
          <img
            :src="file.url"
            :alt="file.name"
            loading="lazy"
            class="w-full object-cover"
          >
        </button>
        <figcaption class="border-t border-default px-3 py-2">
          <button
            class="block w-full truncate text-left text-xs text-muted transition-colors hover:text-default"
            @click="emit('openTask', file.taskId)"
          >
            {{ file.taskTitle }}
          </button>
        </figcaption>
      </figure>
    </div>

    <UModal
      :open="!!preview"
      :ui="{ content: 'max-w-4xl' }"
      @update:open="preview = null"
    >
      <template #content>
        <img
          v-if="preview"
          :src="preview"
          alt=""
          class="max-h-[85vh] w-full object-contain"
        >
      </template>
    </UModal>
  </div>
</template>
