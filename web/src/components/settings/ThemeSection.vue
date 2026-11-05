<script setup lang="ts">
import { useTheme, type ThemePreference } from '@/composables/useTheme'

const { preference, setPreference } = useTheme()
const options: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'ライト' },
  { value: 'dark', label: 'ダーク' },
  { value: 'system', label: '端末に合わせる' },
]

function moveSelection(event: KeyboardEvent, index: number): void {
  let next: number
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % options.length
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + options.length - 1) % options.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = options.length - 1
  else return
  event.preventDefault()
  const option = options[next]
  if (!option) return
  setPreference(option.value)
  const group = (event.currentTarget as HTMLButtonElement).parentElement
  group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
}
</script>

<template>
  <section class="bg-surface rounded-lg border border-line overflow-hidden">
    <div class="px-4 py-3 border-b border-line-subtle">
      <h2 class="text-sm font-semibold text-fg-secondary">表示</h2>
    </div>
    <div role="radiogroup" aria-label="テーマ" class="flex flex-wrap gap-2 px-4 py-4">
      <button
        v-for="(option, index) in options"
        :key="option.value"
        type="button"
        role="radio"
        :aria-checked="preference === option.value"
        :tabindex="preference === option.value ? 0 : -1"
        class="px-3 py-2 rounded-lg text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent"
        :class="preference === option.value ? 'bg-accent text-on-solid' : 'bg-surface-alt text-fg-secondary hover:bg-surface-strong'"
        @click="setPreference(option.value)"
        @keydown="moveSelection($event, index)"
      >{{ option.label }}</button>
    </div>
  </section>
</template>
