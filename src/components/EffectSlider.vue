<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    label: string
    value: number
    min?: number
    max?: number
    step?: number
  }>(),
  { min: 0, max: 1, step: 0.01 }
)

const emit = defineEmits<{ change: [value: number] }>()

const displayValue = computed(() =>
  props.step >= 1 ? props.value.toFixed(0) : props.value.toFixed(2)
)
</script>

<template>
  <label class="field">
    <span>
      {{ label }}
      <span class="mono muted">{{ displayValue }}</span>
    </span>
    <input
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :value="value"
      @input="(e) => emit('change', Number((e.target as HTMLInputElement).value))"
    />
  </label>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  margin-bottom: 6px;
}
.field > span {
  color: var(--fg-2);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
</style>
