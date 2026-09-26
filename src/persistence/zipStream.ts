import { inflate } from 'fflate'

// ============================================================
// バックアップ用の ZIP 読み書き (大容量向け)
// ============================================================
// 書き込み: 無圧縮 (stored)。素材の中身はメモリにコピーせず、元の Blob / File を
//   そのまま Blob の部品として並べる (CRC 計算のためにストリームで 1 回読むだけ)。
//   4GB を超えるサイズ・位置は ZIP64 で書く。
// 読み込み: 末尾の中央ディレクトリだけを読み、各項目を File.slice で取り出す。
//   stored はそのまま、deflate (旧バージョンのバックアップ) はその項目だけ展開する。
// ============================================================

const U32 = 0xffffffff
const U16 = 0xffff

// ---------- CRC32 ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32Update(crc: number, data: Uint8Array): number {
  let c = crc ^ U32
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ U32) >>> 0
}

/** Blob をストリームで読みながら CRC32 とバイト数を求める (全体をメモリに載せない) */
export async function crc32OfBlob(blob: Blob): Promise<{ crc: number; size: number }> {
  let crc = 0
  let size = 0
  const reader = blob.stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    crc = crc32Update(crc, value)
    size += value.byteLength
  }
  return { crc, size }
}

// ---------- 書き込み ----------

export interface ZipEntryInput {
  name: string
  data: Blob
  /** 事前に計算済みなら渡す (無ければ data を読んで計算する) */
  crc?: number
}

class Bytes {
  private buf: number[] = []
  u16(v: number) {
    this.buf.push(v & 0xff, (v >>> 8) & 0xff)
    return this
  }
  u32(v: number) {
    this.buf.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
    return this
  }
  u64(v: number) {
    // Number で表せる範囲 (2^53) で十分
    this.u32(v % 0x100000000)
    this.u32(Math.floor(v / 0x100000000))
    return this
  }
  bytes(b: Uint8Array) {
    for (const x of b) this.buf.push(x)
    return this
  }
  get length() {
    return this.buf.length
  }
  toArray() {
    return new Uint8Array(this.buf)
  }
}

function dosDateTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

/**
 * 無圧縮 ZIP を Blob として組み立てる。素材の中身は元の Blob を参照するだけなので、
 * 数 GB の素材でもメモリはほとんど増えない。
 */
export async function buildStoredZip(
  entries: ZipEntryInput[],
  now = new Date(),
  /** テスト用: 小さなファイルでも ZIP64 形式で書く */
  forceZip64 = false
): Promise<Blob> {
  const { time, date } = dosDateTime(now)
  const enc = new TextEncoder()
  const parts: BlobPart[] = []
  const central = new Bytes()
  let offset = 0

  for (const e of entries) {
    const name = enc.encode(e.name)
    const size = e.data.size
    const crc = e.crc ?? (await crc32OfBlob(e.data)).crc
    const big = forceZip64 || size >= U32
    const farOffset = forceZip64 || offset >= U32
    const version = big || farOffset ? 45 : 20

    // ローカルヘッダ (サイズが 4GB 以上なら ZIP64 拡張に 8 バイトで入れる)
    const localExtra = new Bytes()
    if (big) localExtra.u16(0x0001).u16(16).u64(size).u64(size)
    const local = new Bytes()
      .u32(0x04034b50).u16(version).u16(0x0800).u16(0).u16(time).u16(date)
      .u32(crc).u32(big ? U32 : size).u32(big ? U32 : size)
      .u16(name.length).u16(localExtra.length)
      .bytes(name).bytes(localExtra.toArray())
    const localBytes = local.toArray()
    parts.push(localBytes, e.data)

    // 中央ディレクトリ
    const cenExtra = new Bytes()
    if (big || farOffset) {
      const fields = new Bytes()
      if (big) fields.u64(size).u64(size)
      if (farOffset) fields.u64(offset)
      cenExtra.u16(0x0001).u16(fields.length).bytes(fields.toArray())
    }
    central
      .u32(0x02014b50).u16(version).u16(version).u16(0x0800).u16(0).u16(time).u16(date)
      .u32(crc).u32(big ? U32 : size).u32(big ? U32 : size)
      .u16(name.length).u16(cenExtra.length).u16(0).u16(0).u16(0).u32(0)
      .u32(farOffset ? U32 : offset)
      .bytes(name).bytes(cenExtra.toArray())

    offset += localBytes.length + size
  }

  const cdOffset = offset
  const cdBytes = central.toArray()
  parts.push(cdBytes)
  const cdSize = cdBytes.length
  const count = entries.length
  const needZip64 = forceZip64 || cdOffset >= U32 || cdSize >= U32 || count >= U16

  const tail = new Bytes()
  if (needZip64) {
    const zip64EocdOffset = cdOffset + cdSize
    tail
      .u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0)
      .u64(count).u64(count).u64(cdSize).u64(cdOffset)
      .u32(0x07064b50).u32(0).u64(zip64EocdOffset).u32(1)
  }
  tail
    .u32(0x06054b50).u16(0).u16(0)
    .u16(needZip64 ? U16 : count).u16(needZip64 ? U16 : count)
    .u32(needZip64 ? U32 : cdSize).u32(needZip64 ? U32 : cdOffset)
    .u16(0)
  parts.push(tail.toArray())
  return new Blob(parts, { type: 'application/zip' })
}

// ---------- 読み込み ----------

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  size: number
  crc: number
  /** 中身を Blob として取り出す (deflate は展開する) */
  read(type?: string): Promise<Blob>
  text(): Promise<string>
}

async function readBytes(file: Blob, start: number, end: number): Promise<DataView> {
  const buf = await file.slice(start, end).arrayBuffer()
  return new DataView(buf)
}

function u64(dv: DataView, off: number): number {
  return dv.getUint32(off, true) + dv.getUint32(off + 4, true) * 0x100000000
}

/** ZIP の中央ディレクトリを読み、項目の一覧を返す (中身はまだ読まない) */
export async function readZipEntries(file: Blob): Promise<ZipEntry[]> {
  const size = file.size
  if (size < 22) throw new Error('ZIP ファイルではありません')
  // EOCD は末尾 22 バイト + コメント (最大 65535) の中にある
  const tailStart = Math.max(0, size - 22 - 0xffff)
  const tail = await readBytes(file, tailStart, size)
  let eocd = -1
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('ZIP ファイルではありません (終端が見つかりません)')
  let count = tail.getUint16(eocd + 10, true)
  let cdSize = tail.getUint32(eocd + 12, true)
  let cdOffset = tail.getUint32(eocd + 16, true)
  if (count === U16 || cdSize === U32 || cdOffset === U32) {
    // ZIP64: EOCD の直前に locator がある
    const loc = eocd - 20
    if (loc < 0 || tail.getUint32(loc, true) !== 0x07064b50) throw new Error('ZIP64 の情報が壊れています')
    const z64Offset = u64(tail, loc + 8)
    const z = await readBytes(file, z64Offset, z64Offset + 56)
    if (z.getUint32(0, true) !== 0x06064b50) throw new Error('ZIP64 の情報が壊れています')
    count = u64(z, 32)
    cdSize = u64(z, 40)
    cdOffset = u64(z, 48)
  }
  if (cdOffset + cdSize > size) throw new Error('ZIP ファイルが途中で切れています')

  const cd = await readBytes(file, cdOffset, cdOffset + cdSize)
  const dec = new TextDecoder()
  const entries: ZipEntry[] = []
  let p = 0
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.byteLength || cd.getUint32(p, true) !== 0x02014b50) {
      throw new Error('ZIP の目次が壊れています')
    }
    const method = cd.getUint16(p + 10, true)
    const crc = cd.getUint32(p + 16, true)
    let compressedSize = cd.getUint32(p + 20, true)
    let uncompressed = cd.getUint32(p + 24, true)
    const nameLen = cd.getUint16(p + 28, true)
    const extraLen = cd.getUint16(p + 30, true)
    const commentLen = cd.getUint16(p + 32, true)
    let localOffset = cd.getUint32(p + 42, true)
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen))
    // ZIP64 拡張: 0xFFFFFFFF になっている項目だけが順に入っている
    let e = p + 46 + nameLen
    const eEnd = e + extraLen
    while (e + 4 <= eEnd) {
      const id = cd.getUint16(e, true)
      const len = cd.getUint16(e + 2, true)
      if (id === 0x0001) {
        let q = e + 4
        if (uncompressed === U32) { uncompressed = u64(cd, q); q += 8 }
        if (compressedSize === U32) { compressedSize = u64(cd, q); q += 8 }
        if (localOffset === U32) { localOffset = u64(cd, q); q += 8 }
      }
      e += 4 + len
    }
    p = eEnd + commentLen

    const cSize = compressedSize
    const lOff = localOffset
    const dataStart = async () => {
      const lh = await readBytes(file, lOff, lOff + 30)
      if (lh.getUint32(0, true) !== 0x04034b50) throw new Error(`ZIP の項目が壊れています: ${name}`)
      return lOff + 30 + lh.getUint16(26, true) + lh.getUint16(28, true)
    }
    const read = async (type = '') => {
      const start = await dataStart()
      if (start + cSize > size) throw new Error(`ZIP の項目が途中で切れています: ${name}`)
      const slice = file.slice(start, start + cSize)
      if (method === 0) {
        // 元の ZIP ファイルを参照し続けないよう、少しずつ読んで新しい Blob にする
        // (復元後に ZIP を削除・移動しても素材が読めなくなるのを防ぐ)
        const chunks: Uint8Array[] = []
        const reader = slice.stream().getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
        }
        return new Blob(chunks as BlobPart[], { type })
      }
      if (method === 8) {
        const raw = new Uint8Array(await slice.arrayBuffer())
        const out = await new Promise<Uint8Array>((resolve, reject) =>
          inflate(raw, (err, data) => (err ? reject(err) : resolve(data)))
        )
        return new Blob([out as BlobPart], { type })
      }
      throw new Error(`対応していない圧縮形式です (${method}): ${name}`)
    }
    entries.push({
      name,
      method,
      compressedSize,
      size: uncompressed,
      crc,
      read,
      text: async () => (await read()).text()
    })
  }
  return entries
}
