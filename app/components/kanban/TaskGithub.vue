<script setup lang="ts">
import { format } from 'date-fns'
import { relativeTime } from '~/composables/useRelativeTime'
import { errorMessage } from '~/utils/untypedFetch'
import type { GithubBranchData, GithubIssueData, GithubKind, GithubLink, GithubPullData, GithubRunData, GithubVisibility } from '~/composables/useGithub'

// The GitHub links on a task. A customer contact reads only the links shared
// with the customer, and cannot paste, remove or see the project's defaults.
const props = defineProps<{ taskId: string, readonly: boolean }>()

const toast = useToast()
const { links, settings, loading, refreshing, loadSettings, add, unlink, refresh } = useGithub(() => props.taskId)

const draft = ref('')
const visibility = ref<GithubVisibility>('internal')
const adding = ref(false)
const addError = ref('')
const removing = ref<GithubLink | null>(null)
const removeError = ref('')
const removeBusy = ref(false)

const visibilityItems = [
  { label: 'Team only', value: 'internal' },
  { label: 'Shared with customer', value: 'customer' }
]

// The project default applies once the settings are read; the user can change it per link.
watch(settings, (value) => {
  if (value) visibility.value = value.defaultVisibility
})

onMounted(() => {
  if (!props.readonly) loadSettings().catch(() => undefined)
})

const WORDS: Record<string, string> = {
  not_found: 'Not found on GitHub, or no access',
  rate_limited: 'GitHub is rate limiting us',
  refused: 'GitHub refused the request',
  unavailable: 'GitHub could not be reached'
}

// Plain words for a link's error: the server's message, else the fixed wording.
function errorWords(link: GithubLink): string {
  if (!link.error) return ''
  if (link.message) return link.message
  return WORDS[link.error] ?? 'GitHub could not answer'
}

function retryAt(link: GithubLink): string {
  // The server's message often says the time already.
  if (!link.nextRetryAt || /retry at/i.test(errorWords(link))) return ''
  return `retry at ${format(new Date(link.nextRetryAt), 'HH:mm')}`
}

async function addLink() {
  const input = draft.value.trim()
  if (!input || adding.value) return
  adding.value = true
  addError.value = ''
  try {
    await add(input, visibility.value)
    draft.value = ''
  } catch (e) {
    // An answer with words is shown as it is; none at all means the request itself failed.
    addError.value = errorMessage(e, 'The server did not answer, so that link was not added. Try again in a moment')
  } finally {
    adding.value = false
  }
}

async function refreshLinks() {
  try {
    await refresh()
  } catch (e) {
    toast.add({ title: errorMessage(e, 'Could not refresh GitHub'), icon: 'i-lucide-alert-triangle', color: 'error' })
  }
}

async function confirmRemove() {
  const link = removing.value
  if (!link || removeBusy.value) return
  removeBusy.value = true
  removeError.value = ''
  try {
    await unlink(link.id)
    removing.value = null
  } catch (e) {
    // 403 and 404 both mean the link is still there.
    removeError.value = errorMessage(e, 'Could not remove that link')
  } finally {
    removeBusy.value = false
  }
}

// ─── Reading each kind ─────────────────────────────────────

function issueOf(link: GithubLink) {
  return link.kind === 'issue' ? (link.data as GithubIssueData | null) : null
}
function pullOf(link: GithubLink) {
  return link.kind === 'pull' ? (link.data as GithubPullData | null) : null
}
function branchOf(link: GithubLink) {
  return link.kind === 'branch' ? (link.data as GithubBranchData | null) : null
}
function runOf(link: GithubLink) {
  return link.kind === 'workflow_run' ? (link.data as GithubRunData | null) : null
}

// The state a badge shows, and the key tests read it by.
function stateOf(link: GithubLink): string {
  if (link.error && !link.data) return 'error'
  const issue = issueOf(link)
  if (issue) return issue.issue.state
  const pull = pullOf(link)
  if (pull) return pull.merged ? 'merged' : pull.draft ? 'draft' : pull.state
  const run = runOf(link)
  if (run) return run.status === 'completed' ? (run.conclusion ?? 'completed') : run.status
  const branch = branchOf(link)
  if (branch) return 'branch'
  return 'unknown'
}

const BADGE_COLOR: Record<string, 'success' | 'error' | 'warning' | 'primary' | 'neutral' | 'info'> = {
  open: 'success',
  success: 'success',
  passing: 'success',
  merged: 'primary',
  closed: 'neutral',
  draft: 'neutral',
  failure: 'error',
  failing: 'error',
  error: 'error',
  cancelled: 'neutral',
  queued: 'warning',
  in_progress: 'warning',
  running: 'warning',
  approved: 'success',
  changes_requested: 'error',
  commented: 'info',
  none: 'neutral'
}

function badgeColor(value: string | null | undefined) {
  return BADGE_COLOR[value ?? 'none'] ?? 'neutral'
}

function labelText(state: string): string {
  return state.replace(/_/g, ' ')
}

// GitHub label colours are six hex digits without the '#'; anything else is dropped.
function labelStyle(color: string) {
  return /^[0-9a-f]{6}$/i.test(color) ? { backgroundColor: `#${color}33`, borderColor: `#${color}` } : {}
}

function kindText(kind: GithubKind, link: GithubLink): string {
  if (kind === 'issue') return `Issue #${link.ref}`
  if (kind === 'pull') return `PR #${link.ref}`
  if (kind === 'branch') return 'Branch'
  return 'Run'
}

function reviewText(state: string): string {
  return labelText(state)
}
</script>

<template>
  <section
    class="shrink-0 border-t border-default px-5 py-2.5"
    data-github-section
  >
    <div class="mb-1 flex items-center justify-between gap-2">
      <p class="text-xs font-medium text-muted">
        GitHub
        <span
          v-if="links.length"
          class="tabular-nums text-dimmed"
        >{{ links.length }}</span>
      </p>
      <UButton
        v-if="links.length"
        data-github-refresh
        label="Refresh"
        icon="i-lucide-refresh-cw"
        size="xs"
        color="neutral"
        variant="ghost"
        :loading="refreshing"
        :disabled="refreshing"
        @click="refreshLinks"
      />
    </div>

    <form
      v-if="!readonly"
      class="mb-2 flex flex-wrap items-center gap-2"
      @submit.prevent="addLink"
    >
      <UInput
        v-model="draft"
        data-github-input
        size="sm"
        class="min-w-0 flex-1"
        placeholder="Paste an issue or PR link, owner/repo#123 or #123"
        :disabled="adding"
      />
      <USelect
        v-model="visibility"
        size="sm"
        class="w-28"
        :items="visibilityItems"
        data-github-visibility
      />
      <UButton
        type="submit"
        label="Link"
        size="sm"
        :loading="adding"
        :disabled="!draft.trim() || adding"
      />
    </form>
    <p
      v-if="addError"
      class="mb-2 text-xs text-error"
      data-github-add-error
    >
      {{ addError }}
    </p>

    <p
      v-if="!links.length"
      :class="{ invisible: loading }"
      class="text-xs text-dimmed"
    >
      {{ readonly ? 'Nothing on GitHub is shared with the customer.' : 'No GitHub links yet.' }}
    </p>

    <!-- Many links must not push the description out of the drawer: the list scrolls on its own. -->
    <ul class="max-h-[45vh] space-y-2 overflow-y-auto pr-1">
      <li
        v-for="link in links"
        :key="link.id"
        class="rounded-md border border-default p-2 text-xs"
        data-github-link
        :data-github-kind="link.kind"
        :data-github-state="stateOf(link)"
      >
        <div class="flex items-start gap-2">
          <UBadge
            :color="badgeColor(stateOf(link))"
            variant="soft"
            size="sm"
            class="shrink-0 capitalize"
          >
            {{ labelText(stateOf(link)) }}
          </UBadge>
          <div class="min-w-0 flex-1">
            <p class="font-medium text-default">
              <span class="mr-1.5 text-muted">{{ kindText(link.kind, link) }}</span>
              <template v-if="issueOf(link)">
                {{ issueOf(link)!.issue.title }}
              </template>
              <template v-else-if="pullOf(link)">
                {{ pullOf(link)!.title }}
              </template>
              <template v-else-if="branchOf(link)">
                {{ branchOf(link)!.name }}
              </template>
              <template v-else-if="runOf(link)">
                {{ runOf(link)!.name }}
              </template>
              <template v-else>
                {{ link.owner }}/{{ link.repo }}
              </template>
            </p>
            <p class="text-dimmed">
              {{ link.owner }}/{{ link.repo }}
              <span v-if="link.visibility === 'customer'"> · shared with the customer</span>
            </p>
          </div>
          <UButton
            :to="link.url"
            target="_blank"
            icon="i-lucide-external-link"
            size="xs"
            color="neutral"
            variant="ghost"
            aria-label="Open on GitHub"
          />
          <UButton
            v-if="!readonly"
            data-github-unlink
            icon="i-lucide-unlink"
            size="xs"
            color="neutral"
            variant="ghost"
            aria-label="Remove link"
            @click="removing = link; removeError = ''"
          />
        </div>

        <!-- The error stays visible in words even when no data came back. -->
        <p
          v-if="link.error"
          class="mt-1.5 text-error"
          data-github-error
        >
          {{ errorWords(link) }}<span v-if="retryAt(link)"> · {{ retryAt(link) }}</span>
        </p>

        <!-- Issue: labels, people, body, comments, and the PRs that reference it -->
        <template v-if="issueOf(link)">
          <div class="mt-1.5 flex flex-wrap items-center gap-1">
            <span
              v-for="label in issueOf(link)!.issue.labels"
              :key="label.name"
              class="rounded-full border px-1.5 py-px text-[10px]"
              :style="labelStyle(label.color)"
            >{{ label.name }}</span>
          </div>
          <p class="mt-1 text-dimmed">
            by {{ issueOf(link)!.issue.author ?? 'unknown' }}
            <span v-if="issueOf(link)!.issue.assignees.length">· assigned {{ issueOf(link)!.issue.assignees.join(', ') }}</span>
            · {{ issueOf(link)!.issue.commentCount }} comment{{ issueOf(link)!.issue.commentCount === 1 ? '' : 's' }}
          </p>
          <pre
            v-if="issueOf(link)!.issue.body"
            class="mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap rounded bg-elevated p-2 font-sans text-muted"
          >{{ issueOf(link)!.issue.body }}</pre>
          <ul
            v-if="issueOf(link)!.issue.comments.length"
            class="mt-1.5 space-y-1"
          >
            <li
              v-for="(comment, index) in issueOf(link)!.issue.comments"
              :key="index"
              class="border-l-2 border-default pl-2"
            >
              <span class="text-dimmed">{{ comment.author ?? 'someone' }} · {{ relativeTime(new Date(comment.createdAt)) }}</span>
              <p class="line-clamp-3 whitespace-pre-wrap text-muted">
                {{ comment.body }}
              </p>
            </li>
          </ul>
          <ul
            v-if="issueOf(link)!.pulls.length"
            class="mt-1.5 space-y-1"
          >
            <li
              v-for="pull in issueOf(link)!.pulls"
              :key="pull.number"
              class="flex flex-wrap items-center gap-1.5"
              data-github-pull
            >
              <UBadge
                :color="badgeColor(pull.merged ? 'merged' : pull.draft ? 'draft' : pull.state)"
                variant="soft"
                size="sm"
              >
                {{ pull.merged ? 'merged' : pull.draft ? 'draft' : pull.state }}
              </UBadge>
              <span>PR #{{ pull.number }} {{ pull.title }}</span>
              <span class="text-dimmed">{{ pull.author ?? '' }} · review {{ reviewText(pull.reviewState) }}</span>
            </li>
          </ul>
        </template>

        <!-- Pull request: review, checks and branch -->
        <template v-else-if="pullOf(link)">
          <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
            <UBadge
              :color="badgeColor(pullOf(link)!.reviewState)"
              variant="soft"
              size="sm"
            >
              review {{ reviewText(pullOf(link)!.reviewState) }}
            </UBadge>
            <UBadge
              :color="badgeColor(pullOf(link)!.checks.state)"
              variant="soft"
              size="sm"
              data-github-checks
            >
              checks {{ labelText(pullOf(link)!.checks.state) }}
            </UBadge>
          </div>
          <p class="mt-1 text-dimmed">
            {{ pullOf(link)!.headRef }} → {{ pullOf(link)!.baseRef }}
            <span v-if="pullOf(link)!.headBranchDeleted">· branch deleted</span>
            <span v-if="pullOf(link)!.author">· by {{ pullOf(link)!.author }}</span>
          </p>
          <ul
            v-if="pullOf(link)!.checks.runs.length"
            class="mt-1 space-y-0.5"
          >
            <li
              v-for="run in pullOf(link)!.checks.runs"
              :key="run.name"
              class="flex items-center gap-1.5"
            >
              <span class="text-muted">{{ run.name }}</span>
              <span class="text-dimmed">{{ run.conclusion ?? run.status }}</span>
            </li>
          </ul>
        </template>

        <!-- Branch: position against the default branch and its last commit -->
        <template v-else-if="branchOf(link)">
          <p class="mt-1.5 text-muted">
            {{ branchOf(link)!.aheadBy }} ahead, {{ branchOf(link)!.behindBy }} behind {{ branchOf(link)!.defaultBranch }}
          </p>
          <p
            v-if="branchOf(link)!.lastCommit"
            class="mt-0.5 text-dimmed"
          >
            Last commit {{ branchOf(link)!.lastCommit!.message }}
            <span v-if="branchOf(link)!.lastCommit!.date">· {{ relativeTime(new Date(branchOf(link)!.lastCommit!.date!)) }}</span>
          </p>
        </template>

        <!-- Workflow run: status with its link -->
        <template v-else-if="runOf(link)">
          <p class="mt-1.5 text-muted">
            {{ runOf(link)!.event }} on {{ runOf(link)!.headBranch }}
            · {{ labelText(runOf(link)!.status) }}<span v-if="runOf(link)!.conclusion"> · {{ runOf(link)!.conclusion }}</span>
          </p>
        </template>

        <p
          v-if="link.fetchedAt"
          class="mt-1 text-dimmed"
        >
          Updated {{ relativeTime(new Date(link.fetchedAt)) }}
        </p>
      </li>
    </ul>

    <UModal
      :open="removing !== null"
      title="Remove this GitHub link?"
      description="The task stops showing that issue, pull request, branch or run. GitHub itself is not changed."
      :ui="{ footer: 'justify-end' }"
      @update:open="(v: boolean) => { if (!v) removing = null }"
    >
      <template #footer>
        <p
          v-if="removeError"
          class="mr-auto text-xs text-error"
        >
          {{ removeError }}
        </p>
        <UButton
          label="Cancel"
          color="neutral"
          variant="ghost"
          @click="removing = null"
        />
        <UButton
          label="Remove link"
          color="error"
          data-github-confirm-remove
          :loading="removeBusy"
          @click="confirmRemove"
        />
      </template>
    </UModal>
  </section>
</template>
