<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useSpaceStore } from '@/stores/space'
import { getFunctions, httpsCallable } from 'firebase/functions'
import { importRTMData, parseRTMExportFile, clearAllUserData, exportUserData, type ImportProgress, type ImportResult, type ClearResult } from '@/services/importService'

const router = useRouter()
const authStore = useAuthStore()
const spaceStore = useSpaceStore()

const fileInput = ref<HTMLInputElement | null>(null)
const selectedFile = ref<File | null>(null)
const importing = ref(false)
const clearing = ref(false)
const migrating = ref(false)
const migrateResult = ref<{ listsUpdated: number } | null>(null)
const recoverResult = ref<{ newTaskId: string; subtasksUpdated: number } | null>(null)
const recovering = ref(false)
const addingNotes = ref(false)
const notesAdded = ref(false)
const exporting = ref(false)
const progress = ref<ImportProgress | null>(null)
const result = ref<ImportResult | null>(null)
const clearResult = ref<ClearResult | null>(null)
const error = ref<string | null>(null)

const progressPercent = computed(() => {
  if (!progress.value) return 0
  if (progress.value.total === 0) return 0
  return Math.round((progress.value.current / progress.value.total) * 100)
})

function handleFileSelect(event: Event) {
  const input = event.target as HTMLInputElement
  if (input.files && input.files[0]) {
    selectedFile.value = input.files[0]
    error.value = null
    result.value = null
  }
}

async function handleImport() {
  if (!selectedFile.value || !authStore.user) return

  importing.value = true
  error.value = null
  result.value = null

  try {
    const content = await selectedFile.value.text()
    const data = parseRTMExportFile(content)

    const importResult = await importRTMData(
      authStore.user.uid,
      data,
      (p) => { progress.value = p },
      {
        spaceId: spaceStore.currentSpaceId,
        useLegacyPath: spaceStore.useLegacyPath,
      }
    )

    result.value = importResult

    if (!importResult.success) {
      error.value = importResult.error ?? 'インポートに失敗しました'
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'ファイルの読み込みに失敗しました'
  } finally {
    importing.value = false
  }
}

async function handleClear() {
  if (!authStore.user) return
  if (!confirm('全てのデータを削除しますか？この操作は取り消せません。')) return

  clearing.value = true
  error.value = null
  clearResult.value = null

  try {
    const deleteResult = await clearAllUserData(authStore.user.uid, {
      spaceId: spaceStore.currentSpaceId,
      useLegacyPath: spaceStore.useLegacyPath,
    })
    clearResult.value = deleteResult

    if (!deleteResult.success) {
      error.value = deleteResult.error ?? '削除に失敗しました'
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '削除に失敗しました'
  } finally {
    clearing.value = false
  }
}

async function handleMigrate() {
  if (!authStore.user) return

  migrating.value = true
  error.value = null
  migrateResult.value = null

  try {
    const functions = getFunctions(undefined, 'asia-northeast1')
    const migrateTaskCounts = httpsCallable<{ userId: string }, { success: boolean; listsUpdated: number }>(
      functions,
      'migrateTaskCounts'
    )

    const response = await migrateTaskCounts({ userId: authStore.user.uid })
    migrateResult.value = { listsUpdated: response.data.listsUpdated }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'マイグレーションに失敗しました'
  } finally {
    migrating.value = false
  }
}

async function handleRecover() {
  if (!authStore.user) return

  recovering.value = true
  error.value = null
  recoverResult.value = null

  try {
    const functions = getFunctions(undefined, 'asia-northeast1')
    const recover = httpsCallable<
      { userId: string; oldParentId: string; newTaskName: string; listId: string },
      { success: boolean; newTaskId: string; subtasksUpdated: number }
    >(functions, 'recoverOrphanedSubtasks')

    const response = await recover({
      userId: authStore.user.uid,
      oldParentId: 'xWyRRvsGG6KuVZQJGWGJ',
      newTaskName: 'Info',
      listId: 'nSCMRSajXOk1kS5L5z5p'
    })
    recoverResult.value = { newTaskId: response.data.newTaskId, subtasksUpdated: response.data.subtasksUpdated }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '復旧に失敗しました'
  } finally {
    recovering.value = false
  }
}

async function handleAddNotes() {
  if (!authStore.user) return

  addingNotes.value = true
  error.value = null

  try {
    const functions = getFunctions(undefined, 'asia-northeast1')
    const addNotes = httpsCallable<
      { userId: string; listId: string; taskName: string; notes: string[] },
      { success: boolean; taskId: string }
    >(functions, 'addNotesToTaskByName')

    // RTMエクスポートから取得したInfoタスクのメモ
    const infoNotes = [
      `intelij\n\n6ZZQO5SJ06-eyJsaWNlbnNlSWQiOiI2WlpRTzVTSjA2IiwibGljZW5zZWVOYW1lIjoiRWlqaSBJa2VkYSIsImFzc2lnbmVlTmFtZSI6IiIsImFzc2lnbmVlRW1haWwiOiIiLCJsaWNlbnNlUmVzdHJpY3Rpb24iOiIiLCJjaGVja0NvbmN1cnJlbnRVc2UiOmZhbHNlLCJwcm9kdWN0cyI6W3siY29kZSI6IklJIiwicGFpZFVwVG8iOiIyMDE3LTA5LTA4In0seyJjb2RlIjoiUlMwIiwicGFpZFVwVG8iOiIyMDE3LTA5LTA4In0seyJjb2RlIjoiV1MiLCJwYWlkVXBUbyI6IjIwMTctMDktMDgifSx7ImNvZGUiOiJSRCIsInBhaWRVcFRvIjoiMjAxNy0wOS0wOCJ9LHsiY29kZSI6IlJDIiwicGFpZFVwVG8iOiIyMDE3LTA5LTA4In0seyJjb2RlIjoiREMiLCJwYWlkVXBUbyI6IjIwMTctMDktMDgifSx7ImNvZGUiOiJEQiIsInBhaWRVcFRvIjoiMjAxNy0wOS0wOCJ9LHsiY29kZSI6IlJNIiwicGFpZFVwVG8iOiIyMDE3LTA5LTA4In0seyJjb2RlIjoiRE0iLCJwYWlkVXBUbyI6IjIwMTctMDktMDgifSx7ImNvZGUiOiJBQyIsInBhaWRVcFRvIjoiMjAxNy0wOS0wOCJ9LHsiY29kZSI6IkRQTiIsInBhaWRVcFRvIjoiMjAxNy0wOS0wOCJ9LHsiY29kZSI6IlBTIiwicGFpZFVwVG8iOiIyMDE3LTA5LTA4In0seyJjb2RlIjoiQ0wiLCJwYWlkVXBUbyI6IjIwMTctMDktMDgifSx7ImNvZGUiOiJQQyIsInBhaWRVcFRvIjoiMjAxNy0wOS0wOCJ9XSwiaGFzaCI6IjY0MjYzMzgvMCIsImdyYWNlUGVyaW9kRGF5cyI6NywiYXV0b1Byb2xvbmdhdGVkIjp0cnVlLCJpc0F1dG9Qcm9sb25nYXRlZCI6dHJ1ZX0=-p1j+9XkzD3QRWDYE2JBDqBahOCYagADKKBbUAP/Id4JpYwMNFgb7tN5DYJpRP73Iq4G85EJ14+hb1MJziC90xziAmWwlccp9rFuEmgKqfphgigbW6JoljGiVo8UE4K/V6DWqFOM5d6yg8s2cOZmaJlBhK9XGU4OhVn0Cprz0I+YT+eV/tDDZS7kMgDHzLurErYitcqxgFdZqU/TJnuuuy15+dffeWy1ACzgkbpg9ueV9Nf7+xtpaUKPdgCPTU07wmMRDwe8ExogAmL7Dt+IogpAP79fzGhIXPmVYwI3kb1jLJT2WrSpj174l7O6a51c14wdqiZzM2WfD3WVVDQlOiA==-MIIEPjCCAiagAwIBAgIBBTANBgkqhkiG9w0BAQsFADAYMRYwFAYDVQQDDA1KZXRQcm9maWxlIENBMB4XDTE1MTEwMjA4MjE0OFoXDTE4MTEwMTA4MjE0OFowETEPMA0GA1UEAwwGcHJvZDN5MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxcQkq+zdxlR2mmRYBPzGbUNdMN6OaXiXzxIWtMEkrJMO/5oUfQJbLLuMSMK0QHFmaI37WShyxZcfRCidwXjot4zmNBKnlyHodDij/78TmVqFl8nOeD5+07B8VEaIu7c3E1N+e1doC6wht4I4+IEmtsPAdoaj5WCQVQbrI8KeT8M9VcBIWX7fD0fhexfg3ZRt0xqwMcXGNp3DdJHiO0rCdU+Itv7EmtnSVq9jBG1usMSFvMowR25mju2JcPFp1+I4ZI+FqgR8gyG8oiNDyNEoAbsR3lOpI7grUYSvkB/xVy/VoklPCK2h0f0GJxFjnye8NT1PAywoyl7RmiAVRE/EKwIDAQABo4GZMIGWMAkGA1UdEwQCMAAwHQYDVR0OBBYEFGEpG9oZGcfLMGNBkY7SgHiMGgTcMEgGA1UdIwRBMD+AFKOetkhnQhI2Qb1t4Lm0oFKLl/GzoRykGjAYMRYwFAYDVQQDDA1KZXRQcm9maWxlIENBggkA0myxg7KDeeEwEwYDVR0lBAwwCgYIKwYBBQUHAwEwCwYDVR0PBAQDAgWgMA0GCSqGSIb3DQEBCwUAA4ICAQC9WZuYgQedSuOc5TOUSrRigMw4/+wuC5EtZBfvdl4HT/8vzMW/oUlIP4YCvA0XKyBaCJ2iX+ZCDKoPfiYXiaSiH+HxAPV6J79vvouxKrWg2XV6ShFtPLP+0gPdGq3x9R3+kJbmAm8w+FOdlWqAfJrLvpzMGNeDU14YGXiZ9bVzmIQbwrBA+c/F4tlK/`
    ]

    await addNotes({
      userId: authStore.user.uid,
      listId: 'nSCMRSajXOk1kS5L5z5p', // 個人リストのID
      taskName: 'Info',
      notes: infoNotes
    })
    notesAdded.value = true
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'メモ追加に失敗しました'
  } finally {
    addingNotes.value = false
  }
}

async function handleExport() {
  if (!authStore.user) return

  exporting.value = true
  error.value = null

  try {
    const data = await exportUserData(authStore.user.uid, {
      spaceId: spaceStore.currentSpaceId,
      useLegacyPath: spaceStore.useLegacyPath,
    })
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `rertm-backup-${new Date().toISOString().split('T')[0]}.json`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'エクスポートに失敗しました'
  } finally {
    exporting.value = false
  }
}

function goToHome() {
  router.push({ name: 'home' })
}
</script>

<template>
  <div class="min-h-screen bg-gray-100 py-12 px-4">
    <div class="max-w-xl mx-auto">
      <div class="bg-white rounded-lg shadow-md p-8">
        <h1 class="text-2xl font-bold text-gray-800 mb-6">
          RTMデータインポート
        </h1>

        <p class="text-gray-600 mb-6">
          Remember The Milk からエクスポートしたJSONファイルを選択してください。
        </p>

        <!-- ファイル選択 -->
        <div class="mb-6">
          <input
            ref="fileInput"
            type="file"
            accept=".json"
            @change="handleFileSelect"
            class="hidden"
          />
          <button
            @click="fileInput?.click()"
            :disabled="importing"
            class="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-blue-500 hover:text-blue-600 transition-colors disabled:opacity-50"
          >
            <span v-if="selectedFile">{{ selectedFile.name }}</span>
            <span v-else>ファイルを選択</span>
          </button>
        </div>

        <!-- プログレスバー -->
        <div v-if="importing && progress" class="mb-6">
          <div class="flex justify-between text-sm text-gray-600 mb-2">
            <span>{{ progress.message }}</span>
            <span>{{ progressPercent }}%</span>
          </div>
          <div class="w-full bg-gray-200 rounded-full h-2">
            <div
              class="bg-blue-600 h-2 rounded-full transition-all duration-300"
              :style="{ width: `${progressPercent}%` }"
            ></div>
          </div>
          <p class="text-sm text-gray-500 mt-2">
            {{ progress.current }} / {{ progress.total }}
          </p>
        </div>

        <!-- 削除結果表示 -->
        <div v-if="clearResult && clearResult.success" class="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
          <h3 class="font-semibold text-yellow-800 mb-2">データ削除完了</h3>
          <ul class="text-yellow-700 text-sm space-y-1">
            <li>タスク: {{ clearResult.tasksDeleted }}件削除</li>
            <li>リスト: {{ clearResult.listsDeleted }}件削除</li>
            <li>タグ: {{ clearResult.tagsDeleted }}件削除</li>
          </ul>
        </div>

        <!-- インポート結果表示 -->
        <div v-if="result && result.success" class="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
          <h3 class="font-semibold text-green-800 mb-2">インポート完了！</h3>
          <ul class="text-green-700 text-sm space-y-1">
            <li>リスト: {{ result.listsImported }}件</li>
            <li>タスク: {{ result.tasksImported }}件</li>
            <li>タグ: {{ result.tagsImported }}件</li>
          </ul>
        </div>

        <!-- エラー表示 -->
        <div v-if="error" class="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
          <p class="text-red-700">{{ error }}</p>
        </div>

        <!-- アクションボタン -->
        <div class="flex flex-col gap-4">
          <div class="flex gap-4">
            <button
              v-if="!result?.success"
              @click="handleImport"
              :disabled="!selectedFile || importing || clearing"
              class="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {{ importing ? 'インポート中...' : 'インポート開始' }}
            </button>

            <button
              @click="goToHome"
              class="flex-1 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
            >
              {{ result?.success ? 'ホームへ' : 'キャンセル' }}
            </button>
          </div>

          <!-- データエクスポートボタン -->
          <button
            @click="handleExport"
            :disabled="importing || clearing || migrating || exporting"
            class="w-full px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {{ exporting ? 'エクスポート中...' : 'データをエクスポート（バックアップ）' }}
          </button>

          <!-- 既存データ削除ボタン -->
          <button
            @click="handleClear"
            :disabled="importing || clearing || migrating || exporting"
            class="w-full px-4 py-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {{ clearing ? '削除中...' : '既存データを全て削除' }}
          </button>
        </div>
      </div>

      <!-- タスク数マイグレーション -->
      <div class="bg-white rounded-lg shadow-md p-8 mt-6">
        <h2 class="text-xl font-bold text-gray-800 mb-4">
          タスク数の初期化
        </h2>
        <p class="text-gray-600 mb-4 text-sm">
          リストごとの未完了タスク数を計算してサイドバーに表示します。
          インポート後に一度だけ実行してください。
        </p>

        <!-- マイグレーション結果 -->
        <div v-if="migrateResult" class="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg">
          <p class="text-green-700">
            {{ migrateResult.listsUpdated }}件のリストを更新しました
          </p>
        </div>

        <button
          @click="handleMigrate"
          :disabled="importing || clearing || migrating"
          class="w-full px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {{ migrating ? '処理中...' : 'タスク数を初期化' }}
        </button>
      </div>

      <!-- 孤立サブタスク復旧 -->
      <div class="bg-white rounded-lg shadow-md p-8 mt-6">
        <h2 class="text-xl font-bold text-gray-800 mb-4">
          Infoタスク復旧
        </h2>
        <p class="text-gray-600 mb-4 text-sm">
          削除されたInfoタスクを再作成し、サブタスクを紐付けます。
        </p>

        <div v-if="recoverResult" class="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg">
          <p class="text-green-700">
            復旧完了: {{ recoverResult.subtasksUpdated }}件のサブタスクを紐付けました
          </p>
          <p v-if="notesAdded" class="text-green-700 mt-2">メモも追加しました</p>
        </div>

        <button
          @click="handleRecover"
          :disabled="importing || clearing || migrating || recovering || recoverResult !== null"
          class="w-full px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {{ recovering ? '復旧中...' : 'Infoタスクを復旧' }}
        </button>

        <button
          v-if="!notesAdded"
          @click="handleAddNotes"
          :disabled="addingNotes"
          class="w-full mt-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {{ addingNotes ? 'メモ追加中...' : 'Infoタスクにメモを追加' }}
        </button>
      </div>

      <!-- 注意事項 -->
      <div class="mt-6 text-sm text-gray-500">
        <h4 class="font-medium mb-2">注意事項:</h4>
        <ul class="list-disc list-inside space-y-1">
          <li>大量のデータのインポートには時間がかかります</li>
          <li>リピートタスクは現在サポートしていません</li>
          <li>インポート中はブラウザを閉じないでください</li>
        </ul>
      </div>
    </div>
  </div>
</template>
