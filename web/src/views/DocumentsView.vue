<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useDocumentsStore } from '@/stores/documents'
import { useSpaceStore } from '@/stores/space'
import type { FamilyDocument } from '@/types'

const documentsStore = useDocumentsStore()
const spaceStore = useSpaceStore()
const router = useRouter()
const documentInput = ref<HTMLInputElement | null>(null)
const viewMode = ref<'documents' | 'trash'>('documents')
const mutatingDocumentId = ref<string | null>(null)
const accessUrl = ref<string | null>(null)
const accessLoading = ref(false)
const accessError = ref<string | null>(null)
let accessSequence = 0

const currentSpaceName = computed(() => {
  const membership = spaceStore.memberships.find((item) => item.spaceId === spaceStore.currentSpaceId)
  if (membership?.displayName) return membership.displayName
  if (spaceStore.currentSpaceId?.startsWith('personal_')) return '個人スペース'
  return '家族スペース'
})

const selectedDocument = computed(() => documentsStore.selectedDocument)
const visibleDocuments = computed(() => documentsStore.documents.filter((document) => (
  viewMode.value === 'trash' ? document.status === 'trashed' : document.status !== 'trashed'
)))
const trashedDocumentCount = computed(() => documentsStore.documents.filter(
  (document) => document.status === 'trashed'
).length)
const currentMembership = computed(() => spaceStore.memberships.find(
  (membership) => membership.spaceId === spaceStore.currentSpaceId
))
const isCurrentSpaceOwner = computed(() => currentMembership.value?.role === 'owner')
const usageTotalBytes = computed(() => (
  (documentsStore.usage?.originalBytes ?? 0) + (documentsStore.usage?.derivedBytes ?? 0)
))
const usagePercent = computed(() => {
  const limitBytes = documentsStore.usage?.limitBytes ?? 0
  if (limitBytes <= 0) return 0
  return Math.min(100, usageTotalBytes.value / limitBytes * 100)
})
const isAtCapacity = computed(() => {
  const usage = documentsStore.usage
  return !!usage && usageTotalBytes.value >= usage.limitBytes
})
const isAtWarning = computed(() => {
  const usage = documentsStore.usage
  return !!usage && usageTotalBytes.value >= usage.warningBytes
})
const canPreviewSelectedDocument = computed(() => (
  !!selectedDocument.value
  && ['uploaded', 'processing', 'ready', 'trashed'].includes(selectedDocument.value.status)
))
const selectedPreviewType = computed<'image' | 'pdf' | 'other'>(() => {
  const mimeType = selectedDocument.value?.mimeType ?? ''
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType === 'application/pdf') return 'pdf'
  return 'other'
})

const categoryLabels: Record<FamilyDocument['category'], string> = {
  school_childcare: '学校・保育',
  medical: '医療',
  insurance_tax: '保険・税',
  home_warranty: '住居・保証',
  billing_receipt: '請求・領収',
  contact: '連絡先',
  other: '未分類',
}

const statusLabels: Record<FamilyDocument['status'], string> = {
  uploading: 'アップロード中',
  uploaded: '保存済み',
  processing: '解析中',
  ready: '準備完了',
  failed: '処理失敗',
  trashed: 'ごみ箱',
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function formatDate(document: FamilyDocument): string {
  const date = document.createdAt?.toDate?.()
  return date ? date.toLocaleString('ja-JP') : ''
}

function openInput(input: HTMLInputElement | null): void {
  input?.click()
}

async function handleFileSelection(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  try {
    await documentsStore.addDocument(file, 'file')
  } catch {
    // Storeのエラーを画面に表示する
  }
}

async function loadSelectedAccessUrl(document: FamilyDocument | null): Promise<void> {
  const sequence = ++accessSequence
  accessUrl.value = null
  accessError.value = null
  if (!document || !['uploaded', 'processing', 'ready', 'trashed'].includes(document.status)) return

  accessLoading.value = true
  try {
    const result = await documentsStore.getAccessUrl(document.id)
    if (sequence !== accessSequence) return
    accessUrl.value = result.url
  } catch (error) {
    if (sequence !== accessSequence) return
    accessError.value = error instanceof Error ? error.message : '原本を開けませんでした'
  } finally {
    if (sequence === accessSequence) accessLoading.value = false
  }
}

function selectDocument(documentId: string): void {
  documentsStore.selectDocument(documentId)
}

function closeDetail(): void {
  documentsStore.selectDocument(null)
}

function switchView(nextView: 'documents' | 'trash'): void {
  viewMode.value = nextView
  documentsStore.selectDocument(null)
}

async function moveSelectedToTrash(): Promise<void> {
  const document = selectedDocument.value
  if (!document) return
  mutatingDocumentId.value = document.id
  try {
    await documentsStore.moveToTrash(document.id)
  } catch {
    // Storeのエラーを画面に表示する
  } finally {
    mutatingDocumentId.value = null
  }
}

async function restoreSelectedDocument(): Promise<void> {
  const document = selectedDocument.value
  if (!document) return
  mutatingDocumentId.value = document.id
  try {
    await documentsStore.restoreFromTrash(document.id)
  } catch {
    // Storeのエラーを画面に表示する
  } finally {
    mutatingDocumentId.value = null
  }
}

async function permanentlyDeleteSelectedDocument(): Promise<void> {
  const document = selectedDocument.value
  if (!document || !isCurrentSpaceOwner.value) return
  if (!window.confirm(`「${document.name}」を完全に削除します。元に戻せません。`)) return
  mutatingDocumentId.value = document.id
  try {
    await documentsStore.permanentlyDelete(document.id)
  } catch {
    // Storeのエラーを画面に表示する
  } finally {
    mutatingDocumentId.value = null
  }
}

onMounted(async () => {
  await spaceStore.initSpace()
  documentsStore.subscribe()
})

onUnmounted(() => {
  accessSequence++
  documentsStore.unsubscribe()
})

watch(
  () => spaceStore.currentSpaceId,
  (spaceId, previousSpaceId) => {
    if (!spaceId || spaceId === previousSpaceId) return
    documentsStore.subscribe()
  }
)

watch(selectedDocument, (document) => {
  void loadSelectedAccessUrl(document)
})
</script>

<template>
  <div class="min-h-screen bg-slate-100 text-slate-800">
    <header class="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div class="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
        <div class="flex min-w-0 items-center gap-3">
          <button
            class="rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
            @click="router.push({ name: 'home' })"
          >
            ← Todo
          </button>
          <div class="min-w-0">
            <h1 class="truncate text-lg font-semibold">家族書類ボックス</h1>
            <p class="truncate text-xs text-slate-500">{{ currentSpaceName }}</p>
          </div>
        </div>
        <div class="hidden items-center gap-2 sm:flex">
          <button
            class="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            :disabled="isAtCapacity || viewMode === 'trash'"
            @click="openInput(documentInput)"
          >書類・写真を追加</button>
        </div>
      </div>
    </header>

    <input ref="documentInput" data-testid="document-input" class="hidden" type="file" accept="image/*,application/pdf,.pdf" @change="handleFileSelection" />

    <main class="mx-auto grid max-w-7xl gap-4 p-3 sm:p-4 md:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.6fr)]">
      <section class="min-h-[60vh] rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div class="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <div>
            <h2 class="font-medium">{{ viewMode === 'trash' ? 'ごみ箱' : '書類' }}</h2>
            <p class="text-xs text-slate-500">{{ visibleDocuments.length }}件</p>
          </div>
          <div v-if="documentsStore.uploading" class="text-right text-xs text-blue-600">
            <div>保存中...</div>
            <div class="max-w-36 truncate text-slate-500">{{ documentsStore.uploadFileName }}</div>
          </div>
        </div>

        <div class="border-b border-slate-100 px-3 pt-3">
          <div class="grid grid-cols-2 rounded-lg bg-slate-100 p-1 text-sm">
            <button class="rounded-md px-3 py-2" :class="viewMode === 'documents' ? 'bg-white font-medium shadow-sm' : 'text-slate-500'" @click="switchView('documents')">書類</button>
            <button class="rounded-md px-3 py-2" :class="viewMode === 'trash' ? 'bg-white font-medium shadow-sm' : 'text-slate-500'" @click="switchView('trash')">ごみ箱<span v-if="trashedDocumentCount">（{{ trashedDocumentCount }}）</span></button>
          </div>
          <div v-if="documentsStore.usage" class="py-3">
            <div class="flex justify-between text-xs text-slate-500">
              <span>使用量 {{ formatBytes(usageTotalBytes) }}</span>
              <span>上限 {{ formatBytes(documentsStore.usage.limitBytes) }}</span>
            </div>
            <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div class="h-full rounded-full" :class="isAtWarning ? 'bg-amber-500' : 'bg-blue-500'" :style="{ width: `${usagePercent}%` }" />
            </div>
            <p v-if="isAtWarning && !isAtCapacity" class="mt-2 text-xs text-amber-700">容量が警告値に達しています。不要な書類はごみ箱から完全削除してください。</p>
          </div>
        </div>

        <div v-if="viewMode === 'documents'" class="border-b border-slate-100 p-3 sm:hidden">
          <button class="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300" :disabled="isAtCapacity" @click="openInput(documentInput)">書類・写真を追加</button>
        </div>

        <p v-if="isAtCapacity" class="m-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">容量上限に達したため、新しい書類を追加できません。ごみ箱の書類を完全削除すると空き容量が増えます。</p>

        <p v-if="documentsStore.error" class="m-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {{ documentsStore.error }}
        </p>
        <div v-if="documentsStore.loading" class="p-8 text-center text-sm text-slate-500">読み込み中...</div>
        <div v-else-if="visibleDocuments.length === 0" class="flex flex-col items-center px-6 py-16 text-center">
          <div class="mb-3 text-4xl">📄</div>
          <h3 class="font-medium">{{ viewMode === 'trash' ? 'ごみ箱は空です' : 'まだ書類がありません' }}</h3>
          <p v-if="viewMode === 'documents'" class="mt-1 text-sm text-slate-500">撮影、フォトライブラリ、ファイル、Google Driveから追加できます。</p>
        </div>
        <ul v-else class="divide-y divide-slate-100">
          <li v-for="document in visibleDocuments" :key="document.id">
            <div
              role="button"
              tabindex="0"
              class="flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-slate-50"
              :class="document.id === documentsStore.selectedDocumentId ? 'bg-blue-50' : ''"
              @click="selectDocument(document.id)"
              @keydown.enter="selectDocument(document.id)"
            >
              <div class="mt-0.5 flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-slate-100 text-xl">
                <img
                  v-if="documentsStore.thumbnailUrls[document.id]"
                  :src="documentsStore.thumbnailUrls[document.id]"
                  :alt="`${document.name}のサムネイル`"
                  class="h-full w-full object-cover"
                  @error="documentsStore.reloadThumbnail(document.id)"
                />
                <span v-else>{{ document.mimeType.startsWith('image/') ? '🖼️' : document.mimeType === 'application/pdf' ? '📕' : '📄' }}</span>
              </div>
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-medium">{{ document.name }}</div>
                <div class="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-slate-500">
                  <span>{{ categoryLabels[document.category] }}</span>
                  <span>{{ formatBytes(document.sizeBytes) }}</span>
                  <span :class="document.status === 'failed' ? 'text-red-600' : ''">{{ statusLabels[document.status] }}</span>
                </div>
                <button
                  v-if="document.previewStatus === 'failed' && (document.mimeType.startsWith('image/') || document.mimeType === 'application/pdf')"
                  class="mt-1 text-xs font-medium text-blue-600 hover:underline"
                  @click.stop="documentsStore.retryThumbnail(document.id)"
                >
                  サムネイルを再作成
                </button>
                <div class="mt-1 text-[11px] text-slate-400">{{ formatDate(document) }}</div>
              </div>
            </div>
          </li>
        </ul>
      </section>

      <section
        class="rounded-2xl border border-slate-200 bg-white shadow-sm"
        :class="selectedDocument ? 'fixed inset-0 z-30 overflow-y-auto md:static md:min-h-[60vh]' : 'hidden md:block md:min-h-[60vh]'"
      >
        <div v-if="selectedDocument" class="flex min-h-full flex-col">
          <div class="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
            <div class="min-w-0">
              <h2 class="truncate font-medium">{{ selectedDocument.name }}</h2>
              <p class="mt-1 text-xs text-slate-500">{{ categoryLabels[selectedDocument.category] }}・{{ formatBytes(selectedDocument.sizeBytes) }}</p>
            </div>
            <button class="rounded-lg px-3 py-2 text-sm text-slate-500 hover:bg-slate-100 md:hidden" @click="closeDetail">閉じる</button>
          </div>

          <div class="flex-1 p-3 sm:p-4">
            <div v-if="!canPreviewSelectedDocument" class="rounded-lg bg-amber-50 p-4 text-sm text-amber-800">
              {{ statusLabels[selectedDocument.status] }}です。保存完了後に原本を表示できます。
            </div>
            <div v-else-if="selectedPreviewType === 'pdf'">
              <div v-if="accessLoading" class="flex min-h-80 items-center justify-center text-sm text-slate-500">PDFを開く準備中...</div>
              <div v-else-if="accessError" class="rounded-lg bg-red-50 p-4 text-sm text-red-700">{{ accessError }}</div>
              <div v-else-if="accessUrl" class="flex min-h-80 flex-col items-center justify-center text-center">
                <img
                  v-if="documentsStore.thumbnailUrls[selectedDocument.id]"
                  :src="documentsStore.thumbnailUrls[selectedDocument.id]"
                  :alt="`${selectedDocument.name}の表紙`"
                  class="max-h-64 max-w-full rounded-lg border border-slate-200 object-contain"
                />
                <div v-else class="text-6xl">📕</div>
                <p class="mt-4 text-sm text-slate-600">端末のPDFビューアで全ページを表示します。</p>
                <p v-if="selectedDocument.pageCount" class="mt-1 text-xs text-slate-500">{{ selectedDocument.pageCount }}ページ</p>
                <a
                  :href="accessUrl"
                  target="_blank"
                  rel="noopener"
                  class="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white"
                >PDFを開く</a>
              </div>
            </div>
            <div v-else>
              <div v-if="accessLoading" class="flex min-h-80 items-center justify-center text-sm text-slate-500">原本を読み込み中...</div>
              <div v-else-if="accessError" class="rounded-lg bg-red-50 p-4 text-sm text-red-700">{{ accessError }}</div>
              <img v-else-if="accessUrl && selectedPreviewType === 'image'" :src="accessUrl" :alt="selectedDocument.name" class="mx-auto max-h-[72vh] max-w-full rounded-lg object-contain" />
              <div v-else-if="accessUrl" class="flex min-h-80 flex-col items-center justify-center text-center">
                <div class="text-5xl">📎</div>
                <p class="mt-3 text-sm text-slate-600">この形式はブラウザ内プレビューに対応していません。</p>
                <a :href="accessUrl" target="_blank" rel="noopener" class="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white">原本を開く</a>
              </div>
            </div>
          </div>
          <div class="border-t border-slate-100 p-4">
            <button
              v-if="selectedDocument.status !== 'trashed'"
              class="w-full rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 disabled:opacity-50"
              :disabled="mutatingDocumentId === selectedDocument.id"
              @click="moveSelectedToTrash"
            >ごみ箱へ移動</button>
            <div v-else class="space-y-2">
              <button
                class="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                :disabled="mutatingDocumentId === selectedDocument.id || selectedDocument.deletionStatus === 'processing'"
                @click="restoreSelectedDocument"
              >復元する</button>
              <button
                v-if="isCurrentSpaceOwner"
                class="w-full rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-50"
                :disabled="mutatingDocumentId === selectedDocument.id || selectedDocument.deletionStatus === 'processing'"
                @click="permanentlyDeleteSelectedDocument"
              >完全に削除</button>
              <p v-if="selectedDocument.deletionStatus === 'failed'" class="text-xs text-red-600">{{ selectedDocument.deletionError || '完全削除に失敗しました。もう一度実行できます。' }}</p>
              <p v-else-if="!isCurrentSpaceOwner" class="text-center text-xs text-slate-500">完全削除は家族スペースの所有者だけが実行できます。</p>
            </div>
          </div>
        </div>
        <div v-else class="flex min-h-[60vh] flex-col items-center justify-center p-8 text-center text-slate-400">
          <div class="text-4xl">🔍</div>
          <p class="mt-3 text-sm">左の一覧から書類を選択してください</p>
        </div>
      </section>
    </main>
  </div>
</template>
