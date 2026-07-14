<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { doc, onSnapshot, type Unsubscribe } from 'firebase/firestore'
import { updateDocumentOcrSettingsApi } from '@/services/documentService'
import { db } from '@/services/firebase'

const OCR_POLICY_VERSION = 1

const props = defineProps<{
  spaceId: string
  canManage: boolean
}>()

const enabled = ref(false)
const loading = ref(true)
const saving = ref(false)
const showConsent = ref(false)
const consentChecked = ref(false)
const error = ref<string | null>(null)
const usageCount = ref(0)
let unsubscribeSettings: Unsubscribe | null = null
let unsubscribeUsage: Unsubscribe | null = null

function currentUsageMonth(): string {
  const japanTime = new Date(Date.now() + 9 * 60 * 60 * 1000)
  return japanTime.toISOString().slice(0, 7)
}

function subscribe(): void {
  unsubscribeSettings?.()
  unsubscribeUsage?.()
  loading.value = true
  error.value = null
  unsubscribeSettings = onSnapshot(
    doc(db, 'spaces', props.spaceId, 'settings', 'documentIntegrations'),
    (snapshot) => {
      enabled.value = snapshot.exists() && snapshot.data().ocrEnabled === true
      loading.value = false
    },
    () => {
      error.value = '文字読み取り設定を取得できませんでした'
      loading.value = false
    }
  )
  unsubscribeUsage = onSnapshot(
    doc(db, 'spaces', props.spaceId, 'usage', 'documents'),
    (snapshot) => {
      const data = snapshot.exists() ? snapshot.data() : null
      usageCount.value = data
        && data.processingPageMonth === currentUsageMonth()
        && Number.isSafeInteger(data.processingPageCountThisMonth)
        ? data.processingPageCountThisMonth
        : 0
    }
  )
}

watch(() => props.spaceId, subscribe, { immediate: true })
onBeforeUnmount(() => {
  unsubscribeSettings?.()
  unsubscribeUsage?.()
})

async function enableOcr(): Promise<void> {
  if (!consentChecked.value || saving.value) return
  saving.value = true
  error.value = null
  try {
    await updateDocumentOcrSettingsApi(props.spaceId, true, OCR_POLICY_VERSION)
    showConsent.value = false
    consentChecked.value = false
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '文字読み取りを有効にできませんでした'
  } finally {
    saving.value = false
  }
}

async function disableOcr(): Promise<void> {
  if (saving.value || !confirm('書類の文字読み取りを無効にしますか？')) return
  saving.value = true
  error.value = null
  try {
    await updateDocumentOcrSettingsApi(props.spaceId, false)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '文字読み取りを無効にできませんでした'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="bg-white rounded-lg border border-gray-200 overflow-hidden">
    <div class="px-4 py-3 border-b border-gray-100">
      <div class="flex items-center justify-between gap-3">
        <div>
          <h2 class="text-sm font-semibold text-gray-700">書類の文字読み取り</h2>
          <p class="text-xs text-gray-500 mt-0.5">写真やスキャンPDFから予定・タスク候補を読み取ります</p>
        </div>
        <span
          class="px-2 py-1 rounded-full text-xs"
          :class="enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'"
        >
          {{ loading ? '確認中' : enabled ? '有効' : '無効' }}
        </span>
      </div>
    </div>

    <div class="px-4 py-4 space-y-3">
      <div class="rounded-lg bg-gray-50 border border-gray-200 px-3 py-3 text-xs text-gray-600 space-y-1">
        <p>・PDF内の文字はアプリのサーバー内で読み取り、外部へ送りません。</p>
        <p>・文字がないページ画像だけをGoogle Cloud VisionのEU処理環境へ送ります。</p>
        <p>・送信画像はモデル学習に使われず、オンライン処理後に保持されません。</p>
        <p>・外部OCRは家族全体で月1,000ページに達すると停止します。</p>
      </div>

      <div class="space-y-1">
        <div class="flex justify-between text-xs text-gray-600">
          <span>今月の外部OCR</span>
          <span>{{ usageCount.toLocaleString() }} / 1,000ページ</span>
        </div>
        <div class="h-2 rounded-full bg-gray-100 overflow-hidden">
          <div
            class="h-full transition-all"
            :class="usageCount >= 800 ? 'bg-amber-500' : 'bg-blue-500'"
            :style="{ width: `${Math.min(100, usageCount / 10)}%` }"
          />
        </div>
        <p v-if="usageCount >= 800" class="text-xs text-amber-700">
          無料枠の上限に近づいています。
        </p>
      </div>

      <p v-if="!canManage" class="text-xs text-gray-500">
        この設定は家族スペースのownerが管理します。
      </p>

      <template v-else-if="!loading">
        <button
          v-if="enabled"
          type="button"
          :disabled="saving"
          class="w-full border border-gray-300 text-gray-700 text-sm rounded-lg py-2 disabled:opacity-50"
          @click="disableOcr"
        >
          {{ saving ? '変更中...' : '文字読み取りを無効にする' }}
        </button>

        <button
          v-else-if="!showConsent"
          type="button"
          class="w-full bg-blue-600 text-white text-sm rounded-lg py-2 hover:bg-blue-700"
          @click="showConsent = true"
        >
          説明を確認して有効にする
        </button>

        <div v-else class="rounded-lg border border-blue-200 bg-blue-50 px-3 py-3 space-y-3">
          <p class="text-xs leading-5 text-gray-700">
            文字情報を取得できないページ画像をGoogle Cloud VisionのEU処理環境へ送信します。
            原本の保存と閲覧は、文字読み取りを無効にしても利用できます。
          </p>
          <label class="flex items-start gap-2 text-xs text-gray-700">
            <input v-model="consentChecked" type="checkbox" class="mt-0.5" />
            <span>上記の外部送信と処理方針に同意します</span>
          </label>
          <div class="flex gap-2">
            <button
              type="button"
              class="flex-1 border border-gray-300 bg-white text-gray-700 text-sm rounded-lg py-2"
              @click="showConsent = false; consentChecked = false"
            >
              キャンセル
            </button>
            <button
              type="button"
              :disabled="!consentChecked || saving"
              class="flex-1 bg-blue-600 text-white text-sm rounded-lg py-2 disabled:opacity-50"
              @click="enableOcr"
            >
              {{ saving ? '有効化中...' : '同意して有効化' }}
            </button>
          </div>
        </div>
      </template>

      <p v-if="error" class="text-xs text-red-600">{{ error }}</p>
    </div>
  </section>
</template>
