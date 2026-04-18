<script setup lang="ts">
defineEmits<{ close: [] }>()

const sections = [
  {
    title: '再生',
    items: [
      ['Space', '再生 / 一時停止'],
      ['← / →', 'playhead を 1 フレーム移動'],
      ['Shift + ← / →', 'playhead を 1 秒移動'],
      ['Home / End', '先頭 / 末尾へ']
    ]
  },
  {
    title: '編集',
    items: [
      ['Cmd/Ctrl + Z', '元に戻す'],
      ['Cmd/Ctrl + Shift + Z', 'やり直し'],
      ['Cmd/Ctrl + C', 'コピー'],
      ['Cmd/Ctrl + X', 'カット'],
      ['Cmd/Ctrl + V', '貼り付け'],
      ['Cmd/Ctrl + D', '複製'],
      ['Cmd/Ctrl + A', '全選択'],
      ['S', 'クリップを分割'],
      ['Cmd/Ctrl + L', 'クリップをリンク'],
      ['Cmd/Ctrl + Shift + L', 'リンクを解除'],
      ['Delete / Backspace', '選択クリップを削除']
    ]
  },
  {
    title: 'タイムライン',
    items: [
      ['M', '現在位置にマーカー追加'],
      ['I', 'In 点を設定'],
      ['O', 'Out 点を設定'],
      ['Shift + I', 'In/Out 解除'],
      ['N', 'スナップ切替'],
      ['Shift + R', 'リップル切替']
    ]
  }
]
</script>

<template>
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal">
      <div class="modal-head">
        <div class="title">キーボードショートカット</div>
        <button class="ghost close" @click="$emit('close')">×</button>
      </div>
      <div class="modal-body">
        <div v-for="sec in sections" :key="sec.title" class="section">
          <div class="sec-title">{{ sec.title }}</div>
          <div class="grid">
            <div v-for="[k, d] in sec.items" :key="k" class="row">
              <span class="key mono">{{ k }}</span>
              <span class="desc">{{ d }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: grid;
  place-items: center;
  z-index: 9200;
}
.modal {
  width: 560px;
  max-width: 92vw;
  max-height: 80vh;
  background: var(--bg-1);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line-weak);
}
.title { font-size: 14px; font-weight: 600; }
.close { background: none; border: none; font-size: 18px; color: var(--fg-2); cursor: pointer; }
.modal-body {
  padding: 14px 18px 18px;
  overflow-y: auto;
}
.section { margin-bottom: 14px; }
.sec-title {
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--fg-2);
  text-transform: uppercase;
  margin-bottom: 6px;
}
.grid { display: grid; gap: 4px; }
.row {
  display: grid;
  grid-template-columns: 180px 1fr;
  align-items: center;
  padding: 4px 0;
  border-bottom: 1px dashed var(--line-weak);
}
.key {
  font-size: 11px;
  padding: 3px 6px;
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  display: inline-block;
  text-align: center;
}
.desc { font-size: 12px; color: var(--fg-1); }
</style>
