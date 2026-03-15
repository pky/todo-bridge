<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useNewsStore } from '@/stores/news'

const newsStore = useNewsStore()
const discordEnabled = ref(false)
const discordWebhookUrl = ref('')
const discordUrgentImmediate = ref(true)
const discordDailyDigest = ref(true)
const saving = ref(false)

function syncFromStore(): void {
  const discord = newsStore.mobileNotificationPreferences.discord
  discordEnabled.value = discord?.enabled ?? false
  discordWebhookUrl.value = discord?.webhookUrl ?? ''
  discordUrgentImmediate.value = discord?.urgentImmediate ?? true
  discordDailyDigest.value = discord?.dailyDigest ?? true
}

onMounted(async () => {
  await newsStore.loadMobileNotificationPreferences()
  syncFromStore()
})

async function savePreferences(): Promise<void> {
  saving.value = true
  try {
    await newsStore.saveMobileNotificationPreferences({
      discord: {
        enabled: discordEnabled.value,
        webhookUrl: discordWebhookUrl.value.trim(),
        urgentImmediate: discordUrgentImmediate.value,
        dailyDigest: discordDailyDigest.value,
      },
    })
    alert('モバイル通知設定を保存しました')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="bg-white rounded-lg border border-gray-200 overflow-hidden">
    <div class="px-4 py-3 border-b border-gray-100">
      <h2 class="text-sm font-semibold text-gray-700">モバイル通知</h2>
      <p class="text-xs text-gray-500 mt-0.5">
        まずは Discord 通知を設定します。`urgent` は即時、`review` は朝の要約で送ります。
      </p>
    </div>

    <div class="px-4 py-4 space-y-4">
      <div class="rounded-lg border border-gray-100 bg-gray-50 p-3 space-y-3">
        <label class="flex items-center justify-between gap-3 text-sm text-gray-700">
          <span>Discord 通知を有効化</span>
          <input v-model="discordEnabled" type="checkbox" />
        </label>

        <div class="space-y-1">
          <p class="text-xs font-semibold text-gray-700">Discord Webhook URL</p>
          <input
            v-model="discordWebhookUrl"
            type="url"
            placeholder="https://discord.com/api/webhooks/..."
            class="w-full px-3 py-2 border border-gray-300 rounded text-sm"
          />
          <p class="text-[11px] text-gray-500">
            Discord チャンネルの Incoming Webhook URL を入力します。
          </p>
        </div>

        <label class="flex items-center justify-between gap-3 text-sm text-gray-700">
          <span>`今すぐ確認` を即時通知</span>
          <input v-model="discordUrgentImmediate" type="checkbox" />
        </label>

        <label class="flex items-center justify-between gap-3 text-sm text-gray-700">
          <span>朝の要約を送る</span>
          <input v-model="discordDailyDigest" type="checkbox" />
        </label>
      </div>
    </div>

    <div class="px-4 py-3 border-t border-gray-100">
      <button
        class="w-full bg-gray-900 text-white text-sm rounded-lg py-2 hover:bg-black disabled:opacity-50"
        :disabled="saving"
        @click="savePreferences"
      >
        {{ saving ? '保存中...' : '通知設定を保存' }}
      </button>
    </div>
  </section>
</template>
