// ============================================================
// 位置指定の書き込みを受けて Blob を組み立てる (muxer の StreamTarget 用)
// ============================================================
// mp4-muxer / webm-muxer は基本的に末尾へ追記し、ときどき少し前 (直前のクラスタの
// サイズ) や先頭 (mdat / Segment のサイズ) を書き直す。WebM のクラスタはキーフレーム
// ごと (書き出しでは 2 秒ごと) なので、直近部分はビットレート上限 100Mbps × 2 秒
// (= 25MB) より十分大きく取る。
// 出力全体を 1 つの ArrayBuffer に持つとメモリが 3〜4 倍になり長い書き出しで
// タブが落ちるため、
//  - 先頭 HEAD_BYTES と直近 MUTABLE_TAIL_BYTES は書き換え可能なバイト列のまま持つ
//  - それより古い部分は順次 Blob に確定する (ブラウザが必要に応じてディスクへ逃がす)
// 確定済みの範囲への書き直しは想定外なので、壊れたファイルを出さずに例外にする。
// ============================================================

const HEAD_BYTES = 1024 * 1024
const MUTABLE_TAIL_BYTES = 128 * 1024 * 1024

interface Part {
  pos: number
  bytes: Uint8Array
}

export class PositionedBlobWriter {
  private head = new Uint8Array(0) // 位置 0 から
  private frozen: Blob[] = [] // HEAD_BYTES 以降、確定済み
  private frozenEnd = HEAD_BYTES // frozen の末尾位置 (= tail の開始位置の下限)
  private tail: Part[] = [] // 書き換え可能な直近部分 (位置順・連続)
  private end = 0 // 書かれた範囲の末尾

  constructor(private headBytes = HEAD_BYTES, private tailBytes = MUTABLE_TAIL_BYTES) {
    this.frozenEnd = headBytes
  }

  get size() {
    return this.end
  }

  write(data: Uint8Array, position: number) {
    let pos = position
    let src = data
    // 1) 先頭領域に掛かる部分
    if (pos < this.headBytes) {
      const n = Math.min(src.length, this.headBytes - pos)
      const need = pos + n
      if (this.head.length < need) {
        const grown = new Uint8Array(Math.max(need, Math.min(this.headBytes, this.head.length * 2)))
        grown.set(this.head)
        this.head = grown
      }
      this.head.set(src.subarray(0, n), pos)
      pos += n
      src = src.subarray(n)
      this.end = Math.max(this.end, pos)
    }
    if (src.length === 0) return
    // 先頭領域が埋まっていないのに後ろへ書かれた場合は、先頭領域を 0 で埋めておく
    if (this.end < this.headBytes) {
      const grown = new Uint8Array(this.headBytes)
      grown.set(this.head.subarray(0, this.end))
      this.head = grown
      this.end = this.headBytes
    }
    // 2) 確定済み範囲への書き直しは受け付けない
    const tailStart = this.tail.length ? this.tail[0].pos : this.frozenEnd
    if (pos < tailStart) {
      throw new Error('書き出しデータの整合性エラー (確定済みの位置への書き込み)')
    }
    // 3) 末尾への追記 (隙間は 0 で埋める)
    if (pos >= this.end) {
      if (pos > this.end) this.tail.push({ pos: this.end, bytes: new Uint8Array(pos - this.end) })
      this.tail.push({ pos, bytes: src.slice() })
      this.end = pos + src.length
      this.freezeOld()
      return
    }
    // 4) 直近部分の書き直し
    let written = 0
    for (const part of this.tail) {
      const partEnd = part.pos + part.bytes.length
      if (partEnd <= pos + written || part.pos >= pos + src.length) continue
      const from = Math.max(part.pos, pos + written)
      const to = Math.min(partEnd, pos + src.length)
      part.bytes.set(src.subarray(from - pos, to - pos), from - part.pos)
      written = to - pos
    }
    if (pos + src.length > this.end) {
      const rest = src.subarray(this.end - pos)
      this.tail.push({ pos: this.end, bytes: rest.slice() })
      this.end += rest.length
    }
  }

  /** 直近 tailBytes より古い部分を Blob に確定する */
  private freezeOld() {
    let tailSize = this.end - (this.tail[0]?.pos ?? this.end)
    const toFreeze: Uint8Array[] = []
    while (this.tail.length > 1 && tailSize - this.tail[0].bytes.length >= this.tailBytes) {
      const p = this.tail.shift()!
      toFreeze.push(p.bytes)
      tailSize -= p.bytes.length
      this.frozenEnd = p.pos + p.bytes.length
    }
    if (toFreeze.length) this.frozen.push(new Blob(toFreeze as BlobPart[]))
  }

  toBlob(type: string): Blob {
    const headLen = Math.min(this.end, this.headBytes)
    return new Blob(
      [this.head.subarray(0, headLen), ...this.frozen, ...this.tail.map(p => p.bytes)] as BlobPart[],
      { type }
    )
  }
}
