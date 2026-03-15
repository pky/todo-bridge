<script setup lang="ts">
import { useToast } from '@/composables/useToast'

const { toasts } = useToast()
</script>

<template>
  <div class="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-80 flex flex-col gap-2 z-50 pointer-events-none">
    <TransitionGroup name="slide-up">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="text-white rounded-lg shadow-lg px-4 py-3 text-sm pointer-events-auto"
        :class="toast.type === 'error' ? 'bg-red-600' : 'bg-slate-800'"
      >
        {{ toast.message }}
      </div>
    </TransitionGroup>
  </div>
</template>
