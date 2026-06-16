// ============================================================
// LZ77 + 静的ハフマン圧縮・解凍
// 設計:
//   ウィンドウサイズ: 20MB / 最小マッチ長: 4バイト / 最大マッチ長: 65535バイト
//   ハッシュテーブル: チェーンなし最新位置のみ（速度優先）
//   トークンフォーマット:
//     リテラル低  [0][7bit data]              1バイト (0x00-0x7F)
//     リテラル高  [10][6bit pad][8bit data]   2バイト (0x80-0xFF)
//     参照短距離  [110][13bit dist][8bit len]  3バイト dist<8192, len<256
//     参照長距離  [111][25bit dist][16bit len] 6バイト それ以外
//   ハフマン: 静的固定テーブル（RFC 1951ベース）
//   ヘッダー: フラグ1byte + トークンビット数4byte（終端判定用）
// ============================================================

const WINDOW_SIZE    = 20 * 1024 * 1024;
const MIN_MATCH      = 4;
const MAX_MATCH      = 65535;
const HASH_SIZE      = 1 << 20;
const HASH_MASK      = HASH_SIZE - 1;
const SHORT_DIST_MAX = 8192;
const SHORT_LEN_MAX  = 255;

// --- 静的ハフマン符号表（RFC 1951 固定テーブル） ---
function buildStaticHuffmanTable(): { code: number; len: number }[] {
  const table: { code: number; len: number }[] = new Array(288);
  const lengths = new Uint8Array(288);
  for (let i = 0; i <= 143; i++) lengths[i] = 8;
  for (let i = 144; i <= 255; i++) lengths[i] = 9;
  for (let i = 256; i <= 279; i++) lengths[i] = 7;
  for (let i = 280; i <= 287; i++) lengths[i] = 8;
  const bl_count = new Uint16Array(10);
  for (let i = 0; i < 288; i++) bl_count[lengths[i]]++;
  const next_code = new Uint16Array(10);
  let code = 0;
  bl_count[0] = 0;
  for (let bits = 1; bits <= 9; bits++) {
    code = (code + bl_count[bits - 1]) << 1;
    next_code[bits] = code;
  }
  for (let i = 0; i < 288; i++) {
    const len = lengths[i];
    table[i] = len !== 0 ? { code: next_code[len]++, len } : { code: 0, len: 0 };
  }
  return table;
}

function buildDecodeTable(enc: { code: number; len: number }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let sym = 0; sym < enc.length; sym++) {
    const { code, len } = enc[sym];
    if (len > 0) map.set(`${len}:${code}`, sym);
  }
  return map;
}

const HUFFMAN_TABLE        = buildStaticHuffmanTable();
const HUFFMAN_DECODE_TABLE = buildDecodeTable(HUFFMAN_TABLE);

// --- ビットライター ---
class BitWriter {
  private buf: number[] = [];
  private cur = 0;
  private bitPos = 0;
  totalBits = 0;

  writeBits(value: number, numBits: number): void {
    this.totalBits += numBits;
    for (let i = numBits - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | ((value >> i) & 1);
      if (++this.bitPos === 8) { this.buf.push(this.cur); this.cur = 0; this.bitPos = 0; }
    }
  }

  flush(): Uint8Array {
    if (this.bitPos > 0) this.buf.push(this.cur << (8 - this.bitPos));
    return new Uint8Array(this.buf);
  }
}

// --- ビットリーダー ---
class BitReader {
  private bytePos = 0;
  private bitPos  = 0;
    private data: Uint8Array; // 1. ここで宣言する

    constructor(data: Uint8Array) {
        this.data = data;       // 2. コンストラクタで代入する
    }


  readBit(): number {
    if (this.bytePos >= this.data.length) return 0;
    const bit = (this.data[this.bytePos] >> (7 - this.bitPos)) & 1;
    if (++this.bitPos === 8) { this.bitPos = 0; this.bytePos++; }
    return bit;
  }

  readBits(n: number): number {
    let val = 0;
    for (let i = 0; i < n; i++) val = (val << 1) | this.readBit();
    return val;
  }

  isEnd(): boolean { return this.bytePos >= this.data.length; }
}

// --- ハッシュ計算 ---
function hash3(data: Uint8Array, pos: number): number {
  return ((data[pos] * 2654435761) ^ (data[pos + 1] * 2246822519) ^ (data[pos + 2] * 3266489917)) & HASH_MASK;
}

// --- トークン書き出し ---
function writeToken(w: BitWriter, isLit: boolean, value: number, dist?: number, len?: number): void {
  if (isLit) {
    if (value <= 0x7F) { w.writeBits(0, 1); w.writeBits(value, 7); }
    else               { w.writeBits(0b10, 2); w.writeBits(0, 6); w.writeBits(value, 8); }
  } else {
    const d = dist!, l = len!;
    if (d < SHORT_DIST_MAX && l <= SHORT_LEN_MAX) {
      w.writeBits(0b110, 3); w.writeBits(d, 13); w.writeBits(l, 8);
    } else {
      w.writeBits(0b111, 3); w.writeBits(d, 25); w.writeBits(l, 16);
    }
  }
}

// ============================================================
// compress
// ============================================================
export function compress(input: Uint8Array): Uint8Array {
  const n = input.length;
  const hashTable = new Int32Array(HASH_SIZE).fill(-1);
  const rawWriter = new BitWriter();

  // LZ77トークン化
  let pos = 0;
  while (pos < n) {
    if (pos + MIN_MATCH <= n) {
      const h = hash3(input, pos);
      const candidate = hashTable[h];
      hashTable[h] = pos;
      if (candidate >= 0 && pos - candidate <= WINDOW_SIZE) {
        let matchLen = 0;
        const maxLen = Math.min(MAX_MATCH, n - pos);
        while (matchLen < maxLen && input[candidate + matchLen] === input[pos + matchLen]) matchLen++;
        if (matchLen >= MIN_MATCH) {
          writeToken(rawWriter, false, 0, pos - candidate, matchLen);
          for (let i = 1; i < matchLen && pos + i + MIN_MATCH <= n; i++) {
            hashTable[hash3(input, pos + i)] = pos + i;
          }
          pos += matchLen;
          continue;
        }
      }
    }
    writeToken(rawWriter, true, input[pos]);
    pos++;
  }

  // トークンのビット数を記録（復号の終端判定に使う）
  const tokenBitCount = rawWriter.totalBits;
  const rawBytes = rawWriter.flush();

  // ハフマン符号化
  const huffWriter = new BitWriter();
  for (const byte of rawBytes) {
    const { code, len } = HUFFMAN_TABLE[byte];
    huffWriter.writeBits(code, len);
  }
  const { code: ec, len: el } = HUFFMAN_TABLE[256];
  huffWriter.writeBits(ec, el);
  const compressed = huffWriter.flush();

  if (compressed.length + 5 >= input.length) {
    // 無圧縮: [0x00][元データ]
    const result = new Uint8Array(1 + input.length);
    result[0] = 0x00;
    result.set(input, 1);
    return result;
  }

  // 圧縮済み: [0x01][tokenBitCount 4byte BE][圧縮データ]
  const result = new Uint8Array(5 + compressed.length);
  result[0] = 0x01;
  result[1] = (tokenBitCount >>> 24) & 0xFF;
  result[2] = (tokenBitCount >>> 16) & 0xFF;
  result[3] = (tokenBitCount >>>  8) & 0xFF;
  result[4] = (tokenBitCount       ) & 0xFF;
  result.set(compressed, 5);
  return result;
}

// ============================================================
// decompress
// ============================================================
export function decompress(input: Uint8Array): Uint8Array {
  if (input[0] === 0x00) return input.slice(1);

  // tokenBitCountを読む
  const tokenBitCount = (input[1] << 24) | (input[2] << 16) | (input[3] << 8) | input[4];
  const huffData = input.slice(5);
  const reader = new BitReader(huffData);

  // ハフマン復号 → tokenBits
  const tokenBits: number[] = [];
  while (!reader.isEnd()) {
    let code = 0, sym = -1;
    for (let len = 1; len <= 9; len++) {
      code = (code << 1) | reader.readBit();
      const found = HUFFMAN_DECODE_TABLE.get(`${len}:${code}`);
      if (found !== undefined) { sym = found; break; }
    }
    if (sym === 256 || sym === -1) break;
    for (let i = 7; i >= 0; i--) tokenBits.push((sym >> i) & 1);
  }

  // LZ77復号: tokenBitCountビットだけ読む
  const output: number[] = [];
  let bitPos = 0;

  function rb(): number { return bitPos < tokenBits.length ? tokenBits[bitPos++] : 0; }
  function rbs(n: number): number {
    let val = 0;
    for (let i = 0; i < n; i++) val = (val << 1) | rb();
    return val;
  }

  while (bitPos < tokenBitCount) {
    const b0 = rb();
    if (b0 === 0) {
      output.push(rbs(7));
    } else {
      const b1 = rb();
      if (b1 === 0) {
        rbs(6);
        output.push(rbs(8));
      } else {
        const b2 = rb();
        if (b2 === 0) {
          const dist = rbs(13), len = rbs(8);
          const start = output.length - dist;
          for (let i = 0; i < len; i++) output.push(output[start + i]);
        } else {
          const dist = rbs(25), len = rbs(16);
          const start = output.length - dist;
          for (let i = 0; i < len; i++) output.push(output[start + i]);
        }
      }
    }
  }

  return new Uint8Array(output);
}

// --- 自己テスト ---
const _t = new TextEncoder().encode("");
console.time("Compression");
const _c = compress(_t);
console.timeEnd("Compression");
console.time("Decompression");
const _d = decompress(_c);
console.timeEnd("Decompression");
console.log("圧縮前サイズ:", _t.length);
console.log("圧縮後サイズ:", _c.length);
console.log("圧縮率:", (_c.length / _t.length * 100).toFixed(2) + "%");
console.log("自己テスト:", new TextDecoder().decode(_d) === new TextDecoder().decode(_t) ? "✅" : "❌");