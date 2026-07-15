<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import type { DocumentSuggestion, DocumentSuggestionStatus } from '@/types'
import type { UpdateDocumentSuggestionInput } from '@/stores/documents'

const props = defineProps<{
  suggestions: DocumentSuggestion[]
  loading: boolean
  error: string | null
  savingIds: string[]
  reanalyzing: boolean
}>()

const emit = defineEmits<{
  save: [suggestionId: string, input: UpdateDocumentSuggestionInput]
  registerCalendar: [suggestionId: string, input: Omit<UpdateDocumentSuggestionInput, 'status'>]
  reanalyze: []
  openPage: [pageNumber: number]
}>()

interface SuggestionDraft {
  title: string
  value: Record<string, unknown>
}

const drafts = reactive<Record<string, SuggestionDraft>>({})
const sourceVersions = new Map<string, string>()
const actionableSuggestions = computed(() => props.suggestions.filter(
  (suggestion) => suggestion.type === 'task' || suggestion.type === 'calendar_event'
))

const typeLabels: Record<DocumentSuggestion['type'], string> = {
  task: 'Todo候補',
  calendar_event: 'Calendar予定候補',
  contact: '連絡先',
  amount: '金額',
  field: '書類情報',
}

const statusLabels: Record<DocumentSuggestion['status'], string> = {
  pending: '確認待ち',
  accepted: '採用済み',
  dismissed: '却下済み',
}

function suggestionVersion(suggestion: DocumentSuggestion): string {
  const updatedAt = suggestion.updatedAt?.toMillis?.() ?? 0
  return `${updatedAt}:${suggestion.status}:${suggestion.title}:${JSON.stringify(suggestion.value)}`
}

function formatExtractedTime(period: string | undefined, hourText: string, minuteText?: string): string {
  let hour = Number(hourText)
  if (period === '午後' && hour < 12) hour += 12
  if (period === '午前' && hour === 12) hour = 0
  return `${String(hour).padStart(2, '0')}:${String(Number(minuteText ?? 0)).padStart(2, '0')}`
}

function completeLegacyCalendarValue(suggestion: DocumentSuggestion): Record<string, unknown> {
  const value = { ...suggestion.value }
  if (suggestion.type !== 'calendar_event' || typeof value.endTime === 'string') return value
  const match = suggestion.sourceExcerpt.match(
    /[〜～~ー-]\s*(?:(午前|午後)\s*)?(\d{1,2})(?::|時)\s*(\d{1,2})?分?/
  )
  if (match?.[2]) value.endTime = formatExtractedTime(match[1], match[2], match[3])
  return value
}

watch(
  () => props.suggestions,
  (suggestions) => {
    const availableIds = new Set(suggestions.map((suggestion) => suggestion.id))
    Object.keys(drafts).forEach((id) => {
      if (!availableIds.has(id)) {
        delete drafts[id]
        sourceVersions.delete(id)
      }
    })
    suggestions.forEach((suggestion) => {
      const version = suggestionVersion(suggestion)
      if (sourceVersions.get(suggestion.id) === version) return
      drafts[suggestion.id] = {
        title: suggestion.title,
        value: completeLegacyCalendarValue(suggestion),
      }
      sourceVersions.set(suggestion.id, version)
    })
  },
  { immediate: true, deep: true }
)

function valueAsString(suggestionId: string, key: string): string {
  const value = drafts[suggestionId]?.value[key]
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function titleValue(suggestionId: string): string {
  return drafts[suggestionId]?.title ?? ''
}

function updateTitle(suggestionId: string, title: string): void {
  const draft = drafts[suggestionId]
  if (draft) draft.title = title
}

function hasAmbiguousYear(suggestionId: string): boolean {
  return drafts[suggestionId]?.value.yearAmbiguous === true
}

function ambiguousYearMessage(suggestionId: string): string {
  const value = drafts[suggestionId]?.value
  return typeof value?.inferredYear === 'number'
    ? `年の記載がないため${value.inferredYear}年と推定しました。採用前に日付を確認してください。`
    : '年が書類から確定できません。採用前に日付を確認してください。'
}

function updateValue(suggestionId: string, key: string, value: unknown): void {
  const draft = drafts[suggestionId]
  if (!draft) return
  draft.value = { ...draft.value, [key]: value }
}

function updateDate(suggestionId: string, value: string): void {
  const draft = drafts[suggestionId]
  if (!draft) return
  draft.value = {
    ...draft.value,
    date: value || null,
    yearAmbiguous: !value,
  }
}

function primaryTextKey(suggestion: DocumentSuggestion): string | null {
  if (typeof suggestion.value.text === 'string') return 'text'
  if (typeof suggestion.value.address === 'string') return 'address'
  if (typeof suggestion.value.number === 'string') return 'number'
  return null
}

function save(suggestion: DocumentSuggestion, status: DocumentSuggestionStatus): void {
  const draft = drafts[suggestion.id]
  if (!draft) return
  emit('save', suggestion.id, {
    title: draft.title,
    value: { ...draft.value },
    status,
  })
}

function confidenceLabel(confidence: number | null): string {
  return confidence === null ? '信頼度不明' : `信頼度 ${Math.round(confidence * 100)}%`
}

function hasCalendarRegistration(suggestion: DocumentSuggestion): boolean {
  return suggestion.type === 'calendar_event'
    && (typeof suggestion.calendarEventId === 'string'
      || typeof suggestion.value.calendarEventId === 'string')
}

function acceptanceLabel(suggestion: DocumentSuggestion): string {
  if (suggestion.type === 'task') return 'Todo候補として採用'
  return hasCalendarRegistration(suggestion)
    ? 'Google Calendarに再登録'
    : 'Google Calendarに登録'
}

function registerCalendar(suggestion: DocumentSuggestion): void {
  const draft = drafts[suggestion.id]
  if (!draft) return
  emit('registerCalendar', suggestion.id, {
    title: draft.title,
    value: { ...draft.value },
  })
}
</script>

<template>
  <section data-testid="document-suggestions" class="mt-4 rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
    <div class="flex items-center justify-between gap-3">
      <div>
        <h3 class="text-sm font-medium text-slate-800">読み取り候補</h3>
        <p class="mt-0.5 text-xs text-slate-500">内容を確認してから採用します。TodoやCalendarへの登録は自動では行いません。</p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <span v-if="actionableSuggestions.length" class="text-xs text-slate-500">{{ actionableSuggestions.length }}件</span>
        <button
          type="button"
          :disabled="reanalyzing"
          class="rounded-lg border border-blue-300 bg-white px-2.5 py-1.5 text-xs font-medium text-blue-700 disabled:opacity-50"
          @click="emit('reanalyze')"
        >{{ reanalyzing ? '再抽出中...' : '候補を再抽出' }}</button>
      </div>
    </div>

    <p v-if="loading" class="mt-3 text-sm text-slate-500">候補を読み込み中...</p>
    <p v-else-if="error" class="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{{ error }}</p>
    <p v-else-if="actionableSuggestions.length === 0" class="mt-3 text-sm text-slate-500">Todoや予定にできる候補は見つかりませんでした。</p>

    <div v-else class="mt-3 space-y-3">
      <article
        v-for="suggestion in actionableSuggestions"
        :key="suggestion.id"
        class="rounded-xl border border-slate-200 p-3"
        :class="suggestion.status === 'dismissed' ? 'bg-slate-50 opacity-75' : 'bg-white'"
      >
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <span class="rounded-full bg-blue-50 px-2 py-1 font-medium text-blue-700">{{ typeLabels[suggestion.type] }}</span>
          <span
            class="rounded-full px-2 py-1"
            :class="suggestion.status === 'accepted'
              ? 'bg-green-100 text-green-700'
              : suggestion.status === 'dismissed'
                ? 'bg-slate-200 text-slate-600'
                : 'bg-amber-100 text-amber-700'"
          >{{ statusLabels[suggestion.status] }}</span>
          <span :class="suggestion.confidence !== null && suggestion.confidence < 0.7 ? 'font-medium text-amber-700' : 'text-slate-500'">
            {{ confidenceLabel(suggestion.confidence) }}
          </span>
        </div>

        <label class="mt-3 block text-xs font-medium text-slate-600">
          タイトル
          <input
            v-if="drafts[suggestion.id]"
            :value="titleValue(suggestion.id)"
            type="text"
            maxlength="500"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800"
            @input="updateTitle(suggestion.id, ($event.target as HTMLInputElement).value)"
          />
        </label>

        <div v-if="drafts[suggestion.id] && 'dateText' in suggestion.value" class="mt-3 grid gap-3 sm:grid-cols-2">
          <label class="block text-xs font-medium text-slate-600">
            日付
            <input
              type="date"
              :value="valueAsString(suggestion.id, 'date')"
              class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              @input="updateDate(suggestion.id, ($event.target as HTMLInputElement).value)"
            />
          </label>
          <label class="block text-xs font-medium text-slate-600">
            開始時刻
            <input
              type="time"
              :value="valueAsString(suggestion.id, 'time')"
              class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              @input="updateValue(suggestion.id, 'time', ($event.target as HTMLInputElement).value || null)"
            />
          </label>
          <label v-if="suggestion.type === 'calendar_event'" class="block text-xs font-medium text-slate-600">
            終了時刻
            <input
              type="time"
              :value="valueAsString(suggestion.id, 'endTime')"
              class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              @input="updateValue(suggestion.id, 'endTime', ($event.target as HTMLInputElement).value || null)"
            />
          </label>
          <label v-if="suggestion.type === 'calendar_event'" class="block text-xs font-medium text-slate-600 sm:col-span-2">
            場所
            <input
              type="text"
              :value="valueAsString(suggestion.id, 'location')"
              maxlength="500"
              class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              @input="updateValue(suggestion.id, 'location', ($event.target as HTMLInputElement).value || null)"
            />
          </label>
          <p v-if="hasAmbiguousYear(suggestion.id)" class="sm:col-span-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {{ ambiguousYearMessage(suggestion.id) }}
          </p>
        </div>

        <label v-else-if="primaryTextKey(suggestion)" class="mt-3 block text-xs font-medium text-slate-600">
          内容
          <input
            type="text"
            :value="valueAsString(suggestion.id, primaryTextKey(suggestion)!)"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            @input="updateValue(suggestion.id, primaryTextKey(suggestion)!, ($event.target as HTMLInputElement).value)"
          />
        </label>

        <label v-else-if="typeof suggestion.value.amount === 'number'" class="mt-3 block text-xs font-medium text-slate-600">
          金額（円）
          <input
            type="number"
            min="0"
            :value="valueAsString(suggestion.id, 'amount')"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            @input="updateValue(suggestion.id, 'amount', Number(($event.target as HTMLInputElement).value))"
          />
        </label>

        <div class="mt-3 rounded-lg bg-slate-50 px-3 py-2">
          <div class="flex items-center justify-between gap-3">
            <span class="text-xs font-medium text-slate-500">根拠</span>
            <button
              v-if="suggestion.pageNumber"
              type="button"
              class="text-xs font-medium text-blue-600 hover:underline"
              @click="emit('openPage', suggestion.pageNumber)"
            >{{ suggestion.pageNumber }}ページを開く</button>
          </div>
          <p class="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-slate-600">{{ suggestion.sourceExcerpt }}</p>
        </div>

        <div class="mt-3 grid gap-2 sm:grid-cols-3">
          <button
            type="button"
            :disabled="savingIds.includes(suggestion.id)"
            class="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-50"
            @click="save(suggestion, suggestion.status)"
          >修正を保存</button>
          <button
            v-if="suggestion.type === 'calendar_event' || suggestion.status !== 'accepted'"
            type="button"
            :disabled="savingIds.includes(suggestion.id)"
            class="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            @click="suggestion.type === 'calendar_event' ? registerCalendar(suggestion) : save(suggestion, 'accepted')"
          >{{ acceptanceLabel(suggestion) }}</button>
          <button
            v-if="suggestion.status !== 'dismissed'"
            type="button"
            :disabled="savingIds.includes(suggestion.id)"
            class="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 disabled:opacity-50"
            @click="save(suggestion, 'dismissed')"
          >候補から外す</button>
          <button
            v-else
            type="button"
            :disabled="savingIds.includes(suggestion.id)"
            class="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 disabled:opacity-50"
            @click="save(suggestion, 'pending')"
          >確認待ちに戻す</button>
        </div>
      </article>
    </div>
  </section>
</template>
