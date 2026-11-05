<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import { useDocumentSearchStore, type DocumentSearchResult } from '@/stores/documentSearch'
import { useSpaceStore } from '@/stores/space'

const emit = defineEmits<{
  select: [result: DocumentSearchResult]
}>()
const searchStore = useDocumentSearchStore()
const spaceStore = useSpaceStore()
const input = ref('')
let searchTimer: ReturnType<typeof setTimeout> | null = null

watch(input, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void searchStore.search(value), 250)
})

watch(() => spaceStore.currentSpaceId, () => {
  input.value = ''
  searchStore.reset()
})

onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer)
  searchStore.reset()
})
</script>

<template>
  <div class="border-b border-line-subtle p-3">
    <label class="relative block">
      <span class="sr-only">書類を検索</span>
      <input
        v-model="input"
        data-testid="document-search-input"
        type="search"
        placeholder="書類名・読み取った文字を検索"
        class="w-full rounded-lg border border-line bg-surface-muted px-3 py-2 pr-9 text-sm outline-none focus:border-accent focus:bg-surface"
      />
      <span class="pointer-events-none absolute right-3 top-2 text-fg-faint">⌕</span>
    </label>
    <p v-if="searchStore.loading" class="mt-2 text-xs text-fg-subtle">検索中...</p>
    <p v-else-if="searchStore.error" class="mt-2 text-xs text-danger">{{ searchStore.error }}</p>
    <p v-else-if="input.trim() && searchStore.results.length === 0" class="mt-2 text-xs text-fg-subtle">
      一致する書類はありません。
    </p>
    <ul v-if="searchStore.results.length" data-testid="document-search-results" class="mt-2 max-h-64 divide-y divide-line-subtle overflow-y-auto rounded-lg border border-line bg-surface">
      <li v-for="result in searchStore.results" :key="`${result.documentId}-${result.pageNumber ?? 'document'}`">
        <button type="button" class="w-full px-3 py-2 text-left hover:bg-accent-soft" @click="emit('select', result)">
          <span class="block truncate text-sm font-medium text-fg-secondary">{{ result.name }}</span>
          <span v-if="result.pageNumber" class="mt-0.5 block text-xs font-medium text-accent">{{ result.pageNumber }}ページ</span>
          <span class="mt-0.5 block line-clamp-2 text-xs text-fg-subtle">{{ result.excerpt }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>
