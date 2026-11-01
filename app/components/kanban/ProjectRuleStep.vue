<script setup lang="ts">
// One step of a rule (the trigger, a condition or an action): a kind, and the one
// value that kind needs. The builder says which kinds it offers and what to pick from.
type StepField = 'none' | 'column' | 'person' | 'personOrNobody' | 'personOrAnyone' | 'label' | 'days' | 'text' | 'visibility' | 'yesNo'

const props = defineProps<{
  kinds: { value: string, label: string, field: StepField, disabled?: boolean }[]
  columns: { id: string, name: string }[]
  people: { id: string, name: string }[]
  labels: string[]
}>()

const row = defineModel<{ kind: string, value: string }>({ required: true })

const listId = useId()
const field = computed(() => props.kinds.find(k => k.value === row.value.kind)?.field ?? 'none')

function setKind(kind: string) {
  row.value = { kind, value: '' }
}

function setValue(value: string) {
  row.value = { ...row.value, value }
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <select
      :value="row.kind"
      class="rounded-md border border-default bg-default px-2 py-1.5 text-sm text-default outline-none focus:border-primary"
      data-step-kind
      @change="setKind(($event.target as HTMLSelectElement).value)"
    >
      <option
        v-for="kind in kinds"
        :key="kind.value"
        :value="kind.value"
        :disabled="kind.disabled"
      >
        {{ kind.label }}
      </option>
    </select>

    <select
      v-if="field === 'column'"
      :value="row.value"
      class="min-w-0 rounded-md border border-default bg-default px-2 py-1.5 text-sm text-default outline-none focus:border-primary"
      data-step-value
      @change="setValue(($event.target as HTMLSelectElement).value)"
    >
      <option
        value=""
        disabled
      >
        Pick a column
      </option>
      <option
        v-for="column in columns"
        :key="column.id"
        :value="column.id"
      >
        {{ column.name }}
      </option>
    </select>

    <select
      v-else-if="field === 'person' || field === 'personOrNobody' || field === 'personOrAnyone'"
      :value="row.value"
      class="min-w-0 rounded-md border border-default bg-default px-2 py-1.5 text-sm text-default outline-none focus:border-primary"
      data-step-value
      @change="setValue(($event.target as HTMLSelectElement).value)"
    >
      <option
        v-if="field === 'person'"
        value=""
        disabled
      >
        Pick someone
      </option>
      <option
        v-if="field === 'personOrNobody'"
        value=""
      >
        Nobody
      </option>
      <option
        v-if="field === 'personOrAnyone'"
        value=""
      >
        Anyone
      </option>
      <option
        v-for="person in people"
        :key="person.id"
        :value="person.id"
      >
        {{ person.name }}
      </option>
    </select>

    <template v-else-if="field === 'label'">
      <input
        :value="row.value"
        type="text"
        maxlength="50"
        placeholder="Label"
        :list="listId"
        class="w-40 rounded-md border border-default bg-default px-2 py-1.5 text-sm text-default outline-none focus:border-primary"
        data-step-value
        @input="setValue(($event.target as HTMLInputElement).value)"
      >
      <datalist :id="listId">
        <option
          v-for="label in labels"
          :key="label"
          :value="label"
        />
      </datalist>
    </template>

    <input
      v-else-if="field === 'days'"
      :value="row.value"
      type="number"
      min="0"
      max="365"
      placeholder="Days"
      class="w-24 rounded-md border border-default bg-default px-2 py-1.5 text-sm text-default outline-none focus:border-primary"
      data-step-value
      @input="setValue(($event.target as HTMLInputElement).value)"
    >

    <input
      v-else-if="field === 'text'"
      :value="row.value"
      type="text"
      maxlength="2000"
      placeholder="Text"
      class="min-w-0 flex-1 rounded-md border border-default bg-default px-2 py-1.5 text-sm text-default outline-none focus:border-primary"
      data-step-value
      @input="setValue(($event.target as HTMLInputElement).value)"
    >

    <select
      v-else-if="field === 'visibility'"
      :value="row.value"
      class="rounded-md border border-default bg-default px-2 py-1.5 text-sm text-default outline-none focus:border-primary"
      data-step-value
      @change="setValue(($event.target as HTMLSelectElement).value)"
    >
      <option
        value=""
        disabled
      >
        Pick one
      </option>
      <option value="internal">
        Team only
      </option>
      <option value="customer">
        Shared with customer
      </option>
    </select>

    <select
      v-else-if="field === 'yesNo'"
      :value="row.value"
      class="rounded-md border border-default bg-default px-2 py-1.5 text-sm text-default outline-none focus:border-primary"
      data-step-value
      @change="setValue(($event.target as HTMLSelectElement).value)"
    >
      <option
        value=""
        disabled
      >
        Pick one
      </option>
      <option value="yes">
        Yes
      </option>
      <option value="no">
        No
      </option>
    </select>
  </div>
</template>
