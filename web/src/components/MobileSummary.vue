<script setup lang="ts">
import type { MobileSummary } from '@/types/news'

defineProps<{
  summary: MobileSummary
}>()
</script>

<template>
  <div>
    <p>概要: {{ summary.overview }}</p>
    <p>対象: {{ summary.target }}</p>
    <p>期限: {{ summary.deadline }}</p>
    <p>やること: {{ summary.action }}</p>
  </div>
</template>
