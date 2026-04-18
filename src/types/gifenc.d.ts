declare module 'gifenc' {
  export function GIFEncoder(): {
    writeFrame(
      indexed: Uint8Array,
      width: number,
      height: number,
      opts?: { palette?: number[][]; delay?: number; transparent?: boolean; transparentIndex?: number; repeat?: number; first?: boolean; dispose?: number }
    ): void
    finish(): void
    bytes(): Uint8Array
    reset(): void
  }
  export function quantize(
    data: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    opts?: { format?: string; oneBitAlpha?: boolean; clearAlpha?: boolean; clearAlphaThreshold?: number; clearAlphaColor?: number }
  ): number[][]
  export function applyPalette(
    data: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: string
  ): Uint8Array
}
