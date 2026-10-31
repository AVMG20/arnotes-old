<script setup lang="ts">
// Project settings, for the team only: the page keeps its tab away from a
// customer's contact. The section is kept in the URL so a reload stays on it.
import type { FieldType } from '~/composables/useCustomFields'

const props = defineProps<{ projectId: string }>()

const route = useRoute()

const SECTIONS = [
  { key: 'general', label: 'General', icon: 'i-lucide-sliders-horizontal' },
  { key: 'repositories', label: 'Repositories', icon: 'i-lucide-git-branch' },
  { key: 'rules', label: 'Rules', icon: 'i-lucide-workflow' },
  { key: 'members', label: 'Members', icon: 'i-lucide-users' },
  { key: 'secrets', label: 'Secrets', icon: 'i-lucide-lock-keyhole' },
  { key: 'fields', label: 'Custom fields', icon: 'i-lucide-list-plus' }
] as const

const section = computed(() => SECTIONS.find(s => s.key === route.query.section)?.key ?? 'general')
const sectionLabel = computed(() => SECTIONS.find(s => s.key === section.value)?.label ?? 'General')

function setSection(key: string) {
  navigateTo({ path: route.path, query: { ...route.query, section: key } }, { replace: true })
}

// ─── Custom fields ─────────────────────────────────────────

const { fields, templates, loadTemplates, addField, removeField, messageOf } = useCustomFields(() => props.projectId)

watch(() => props.projectId, () => {
  loadTemplates().catch(() => {})
}, { immediate: true })

const FIELD_TYPE_LABELS: Record<FieldType, string> = { text: 'Text', number: 'Number', select: 'Dropdown', date: 'Date' }
const FIELD_TYPE_ICONS: Record<FieldType, string> = {
  text: 'i-lucide-type', number: 'i-lucide-hash', select: 'i-lucide-list', date: 'i-lucide-calendar'
}

const newField = reactive({ name: '', type: 'text' as FieldType, options: '' })
const fieldError = ref('')
// Deleting a field takes every task's value with it, so it asks twice.
const confirmingRemove = ref<string | null>(null)

async function runFieldAction(action: () => Promise<unknown>) {
  fieldError.value = ''
  try {
    await action()
  } catch (e) {
    fieldError.value = messageOf(e, 'Could not change the fields')
  }
}

function addTemplate(key: string) {
  return runFieldAction(() => addField({ template: key }))
}

function createField() {
  const name = newField.name.trim()
  if (!name) return
  const options = newField.type === 'select'
    ? newField.options.split(',').map(option => option.trim()).filter(Boolean)
    : undefined
  // The form empties at once, so what is typed while the request is out is not
  // wiped when it lands; a refusal puts the draft back.
  const draft = { name: newField.name, options: newField.options }
  newField.name = ''
  newField.options = ''
  return runFieldAction(async () => {
    try {
      await addField({ name, type: newField.type, options })
    } catch (e) {
      if (!newField.name) {
        newField.name = draft.name
        newField.options = draft.options
      }
      throw e
    }
  })
}

function dropField(fieldId: string) {
  if (confirmingRemove.value !== fieldId) {
    confirmingRemove.value = fieldId
    return
  }
  confirmingRemove.value = null
  return runFieldAction(() => removeField(fieldId))
}
</script>

<template>
  <div class="h-full overflow-y-auto px-4 pb-10 pt-6 lg:px-6">
    <div class="mx-auto grid max-w-5xl gap-8 lg:grid-cols-[12rem_1fr]">
      <nav
        class="flex gap-1 overflow-x-auto lg:flex-col"
        aria-label="Settings sections"
      >
        <button
          v-for="s in SECTIONS"
          :key="s.key"
          class="flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors"
          :class="section === s.key ? 'bg-elevated font-medium text-default' : 'text-muted hover:bg-elevated hover:text-default'"
          :aria-current="section === s.key ? 'page' : undefined"
          :data-settings-section="s.key"
          @click="setSection(s.key)"
        >
          <UIcon
            :name="s.icon"
            class="size-4"
          />
          {{ s.label }}
        </button>
      </nav>

      <div class="min-w-0 max-w-2xl">
        <h2 class="text-lg font-semibold text-default">
          {{ sectionLabel }}
        </h2>

        <KanbanProjectGeneralSettings
          v-if="section === 'general'"
          class="mt-4"
          :project-id="projectId"
        />
        <KanbanProjectGithubSettings
          v-else-if="section === 'repositories'"
          class="mt-4"
          :project-id="projectId"
        />
        <KanbanProjectRulesSettings
          v-else-if="section === 'rules'"
          :project-id="projectId"
          class="mt-4"
        />
        <KanbanProjectMembersSettings
          v-else-if="section === 'members'"
          class="mt-4"
          :project-id="projectId"
        />
        <KanbanProjectSecretsSettings
          v-else-if="section === 'secrets'"
          class="mt-4"
          :project-id="projectId"
        />
        <section
          v-else-if="section === 'fields'"
          class="mt-4"
          data-custom-fields
        >
          <p class="text-xs text-muted">
            Extra columns for every task, such as a priority or an estimate.
          </p>

          <ul
            v-if="fields.length"
            class="mt-3 divide-y divide-default rounded-xl border border-default bg-default text-sm"
          >
            <li
              v-for="field in fields"
              :key="field.id"
              class="flex items-center gap-2 px-3 py-2"
              data-field-row
            >
              <UIcon
                :name="FIELD_TYPE_ICONS[field.type]"
                class="size-4 shrink-0 text-dimmed"
              />
              <span class="min-w-0 flex-1 truncate text-default">{{ field.name }}</span>
              <span class="shrink-0 text-xs text-dimmed">{{ FIELD_TYPE_LABELS[field.type] }}</span>
              <button
                class="shrink-0 text-xs transition-colors"
                :class="confirmingRemove === field.id ? 'font-medium text-error' : 'text-dimmed hover:text-error'"
                :aria-label="`Delete ${field.name}`"
                data-field-delete
                @click="dropField(field.id)"
              >
                <template v-if="confirmingRemove === field.id">
                  Delete?
                </template>
                <UIcon
                  v-else
                  name="i-lucide-trash-2"
                  class="size-3.5"
                />
              </button>
            </li>
          </ul>

          <div
            v-if="templates.length"
            class="mt-3 flex flex-wrap gap-2"
          >
            <button
              v-for="template in templates"
              :key="template.key"
              class="flex items-center gap-1.5 rounded-lg border border-dashed border-default px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-default"
              :data-field-template="template.key"
              @click="addTemplate(template.key)"
            >
              <UIcon
                name="i-lucide-plus"
                class="size-3.5"
              />
              {{ template.name }}
            </button>
          </div>

          <form
            class="mt-3 space-y-2 rounded-xl border border-default bg-default p-3"
            @submit.prevent="createField"
          >
            <input
              v-model="newField.name"
              type="text"
              maxlength="40"
              placeholder="New field name"
              class="w-full rounded-md border border-default bg-transparent px-2 py-1.5 text-sm text-default outline-none placeholder:text-dimmed focus:border-primary"
              data-new-field-name
            >
            <div class="flex gap-2">
              <select
                v-model="newField.type"
                class="flex-1 rounded-md border border-default bg-transparent px-2 py-1.5 text-sm text-default outline-none focus:border-primary"
                data-new-field-type
              >
                <option
                  v-for="(label, type) in FIELD_TYPE_LABELS"
                  :key="type"
                  :value="type"
                >
                  {{ label }}
                </option>
              </select>
              <UButton
                type="submit"
                label="Add"
                size="sm"
                :disabled="!newField.name.trim()"
                data-new-field-add
              />
            </div>
            <input
              v-if="newField.type === 'select'"
              v-model="newField.options"
              type="text"
              placeholder="Options, comma separated"
              class="w-full rounded-md border border-default bg-transparent px-2 py-1.5 text-sm text-default outline-none placeholder:text-dimmed focus:border-primary"
              data-new-field-options
            >
          </form>
          <p
            v-if="fieldError"
            class="mt-2 text-xs text-error"
            data-field-error
          >
            {{ fieldError }}
          </p>
        </section>
      </div>
    </div>
  </div>
</template>
