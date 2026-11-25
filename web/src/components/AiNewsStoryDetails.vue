<script setup lang="ts">
import { computed } from 'vue'
import type { AiNewsReaction, AiNewsRelated } from '@/types/news'
import { formatAiReaction } from '@/utils/aiNewsReactions'
import { isHttpsUrl } from '@/utils/newsFeedV2'

const props = defineProps<{
  reactions?: AiNewsReaction[]
  related?: AiNewsRelated[]
}>()

const relatedLinks = computed(() => props.related?.filter(link => isHttpsUrl(link.url)) ?? [])
</script>

<template>
  <div class="mt-2 space-y-2 break-words text-xs leading-relaxed text-fg-muted">
    <p v-if="reactions?.length">
      <template v-for="(reaction, index) in reactions" :key="index">
        <span v-if="index > 0">・</span>
        <a
          v-if="isHttpsUrl(reaction.url)"
          :href="reaction.url"
          target="_blank"
          rel="noopener noreferrer"
          class="text-accent underline underline-offset-2"
          @click.stop
        >{{ formatAiReaction(reaction) }}</a>
        <span v-else>{{ formatAiReaction(reaction) }}</span>
      </template>
    </p>
    <div v-if="relatedLinks.length">
      <p class="font-semibold">関連</p>
      <ul class="space-y-1">
        <li v-for="(link, index) in relatedLinks" :key="index">
          <a
            :href="link.url"
            target="_blank"
            rel="noopener noreferrer"
            class="text-accent underline underline-offset-2"
            @click.stop
          >{{ link.sourceName }}: {{ link.title }}</a>
        </li>
      </ul>
    </div>
  </div>
</template>
