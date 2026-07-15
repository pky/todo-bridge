<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useDocumentsStore } from '@/stores/documents'
import { useSpaceStore } from '@/stores/space'

const props = withDefaults(defineProps<{
  selectedIds: string[]
  buttonLabel?: string
  disabled?: boolean
}>(), {
  buttonLabel: '+ 書類を選ぶ',
  disabled: false,
})

const emit = defineEmits<{
  confirm: [documentIds: string[]]
}>()

const documentsStore = useDocumentsStore()
const spaceStore = useSpaceStore()
const open = ref(false)
const draftIds = ref<string[]>([])
const fileInput = ref<HTMLInputElement | null>(null)
const uploadError = ref<string | null>(null)

const availableDocuments = computed(() => documentsStore.documents.filter(
  (document) => document.status !== 'trashed'
))
const currentSpaceLabel = computed(() => {
  const spaceId = spaceStore.currentSpaceId
  if (!spaceId) return '現在のタスク'
  if (spaceId.startsWith('personal_')) return '個人'
  const membership = spaceStore.memberships.find((item) => item.spaceId === spaceId)
  return membership?.displayName ? `${membership.displayName}（家族）` : '家族'
})

watch(open, (nextOpen) => {
  if (!nextOpen) return
  draftIds.value = [...props.selectedIds]
  uploadError.value = null
})

function toggleDocument(documentId: string): void {
  draftIds.value = draftIds.value.includes(documentId)
    ? draftIds.value.filter((id) => id !== documentId)
    : [...draftIds.value, documentId]
}

function confirmSelection(): void {
  emit('confirm', [...draftIds.value])
  open.value = false
}

async function handleFileSelection(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  uploadError.value = null
  try {
    const documentId = await documentsStore.addDocument(file, 'file')
    if (!draftIds.value.includes(documentId)) {
      draftIds.value = [...draftIds.value, documentId]
    }
  } catch (error) {
    uploadError.value = error instanceof Error ? error.message : '書類を追加できませんでした'
  }
}
</script>

<template>
  <div class="relative">
    <button
      type="button"
      :disabled="disabled"
      class="text-xs font-medium text-blue-600 hover:text-blue-800 disabled:text-gray-400"
      @click="open = !open"
    >{{ open ? '閉じる' : buttonLabel }}</button>

    <div
      v-if="open"
      class="absolute right-0 z-30 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-gray-200 bg-white p-3 shadow-lg"
    >
      <div class="flex items-center justify-between gap-2">
        <p class="text-xs font-medium text-gray-700">関連づける書類を選択</p>
        <button
          type="button"
          :disabled="documentsStore.uploading"
          class="rounded border border-blue-300 px-2 py-1 text-xs text-blue-700 disabled:opacity-50"
          @click="fileInput?.click()"
        >{{ documentsStore.uploading ? '保存中...' : '新しい書類を追加' }}</button>
      </div>
      <p class="mt-1 text-[11px] text-gray-500">
        {{ currentSpaceLabel }}の書類を表示中。新しい書類も同じ保存先に追加します。
      </p>
      <input
        ref="fileInput"
        class="hidden"
        type="file"
        accept="image/*,application/pdf,.pdf"
        @change="handleFileSelection"
      />

      <p v-if="uploadError" class="mt-2 rounded bg-red-50 px-2 py-1.5 text-xs text-red-700">{{ uploadError }}</p>
      <p v-if="documentsStore.loading" class="mt-3 text-xs text-gray-500">書類を読み込み中...</p>
      <p v-else-if="availableDocuments.length === 0" class="mt-3 text-xs text-gray-500">選択できる書類がありません。</p>
      <div v-else class="mt-3 max-h-64 space-y-1 overflow-y-auto">
        <label
          v-for="document in availableDocuments"
          :key="document.id"
          class="flex cursor-pointer items-center gap-2 rounded-lg p-2 hover:bg-gray-50"
        >
          <input
            type="checkbox"
            :checked="draftIds.includes(document.id)"
            class="rounded text-blue-600 focus:ring-blue-500"
            @change="toggleDocument(document.id)"
          />
          <div class="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded bg-gray-100">
            <img
              v-if="documentsStore.thumbnailUrls[document.id]"
              :src="documentsStore.thumbnailUrls[document.id]"
              :alt="`${document.name}のサムネイル`"
              class="h-full w-full object-cover"
            />
            <span v-else>{{ document.mimeType.startsWith('image/') ? '🖼️' : '📄' }}</span>
          </div>
          <span class="min-w-0 flex-1 truncate text-xs text-gray-700">{{ document.name }}</span>
        </label>
      </div>

      <div class="mt-3 flex justify-end gap-2">
        <button type="button" class="px-3 py-1.5 text-xs text-gray-600" @click="open = false">キャンセル</button>
        <button
          type="button"
          class="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white"
          @click="confirmSelection"
        >{{ draftIds.length }}件を選択</button>
      </div>
    </div>
  </div>
</template>
