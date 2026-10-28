<script setup lang="ts">
import type { MobileSummary } from '@/types/news'

defineProps<{
  summary: MobileSummary
}>()

const emptyValues = new Set(['期限なし', '記載なし', '対応不要'])

function hasValue(value: string): boolean {
  const trimmed = value.trim()
  return trimmed !== '' && !emptyValues.has(trimmed)
}
</script>

<template>
  <div>
    <p v-if="hasValue(summary.overview)">概要: {{ summary.overview }}</p>
    <p v-if="hasValue(summary.target)" class="line-clamp-2">対象: {{ summary.target }}</p>
    <p v-if="hasValue(summary.deadline)">期限: {{ summary.deadline }}</p>
    <p v-if="hasValue(summary.action)" class="line-clamp-2">やること: {{ summary.action }}</p>
  </div>
</template>
