// 正準ハフマン復元用のシンプルなノード型
type HuffmanNode = {
    value: number; // 0〜255のバイト値、枝ノードの場合は -1
    left: HuffmanNode | null;
    right: HuffmanNode | null;
};

/**
 * 【マイン仕様】無駄な割り込みゼロ・完全シンクロ正準ハフマン符号化クラス
 */
class HuffmanCompressor {
    // 256バイト固定の符号長ヘッダ
    public codeLengths: Uint8Array = new Uint8Array(256);
    private bitCodes: { code: number; length: number }[] = Array.from({ length: 256 }, () => ({ code: 0, length: 0 }));

    /**
     * 1パス目: 生バイナリの出現頻度を1行ずつ完璧に計上する
     */
    public analyzeFrequency(src: Uint8Array): BigUint64Array {
        const freq = new BigUint64Array(256);
        for (let i = 0; i < src.length; i++) {
            freq[src[i]]++;
        }
        return freq;
    }

    /**
     * 2パス目: 数学的に美しく固定された「正準ハフマン木」をビルド
     */
    public buildHuffmanTree(freq: BigUint64Array): void {
        type TempNode = { value: number; freq: bigint; left: TempNode | null; right: TempNode | null };
        const nodes: TempNode[] = [];

        for (let i = 0; i < 256; i++) {
            if (freq[i] > 0n) {
                nodes.push({ value: i, freq: freq[i], left: null, right: null });
            }
        }
        if (nodes.length === 0) return;
        if (nodes.length === 1) {
            nodes.push({ value: (nodes[0].value + 1) % 256, freq: 0n, left: null, right: null });
        }

        while (nodes.length > 1) {
            nodes.sort((a, b) => (a.freq < b.freq ? -1 : a.freq > b.freq ? 1 : 0));
            const left = nodes.shift()!;
            const right = nodes.shift()!;
            nodes.push({ value: -1, freq: left.freq + right.freq, left, right });
        }

        const getLengths = (node: TempNode | null, depth: number) => {
            if (!node) return;
            if (node.value !== -1) {
                this.codeLengths[node.value] = depth;
                return;
            }
            getLengths(node.left, depth + 1);
            getLengths(node.right, depth + 1);
        };
        getLengths(nodes[0], 0);

        let currentCode = 0;
        let lastLength = 0;
        for (let len = 1; len <= 32; len++) {
            for (let i = 0; i < 256; i++) {
                if (this.codeLengths[i] === len) {
                    if (lastLength > 0) {
                        currentCode = (currentCode + 1) << (len - lastLength);
                    }
                    this.bitCodes[i] = { code: currentCode, length: len };
                    lastLength = len;
                }
            }
        }
    }

    /**
     * 3パス目: 1バイト読んでハフマンビットを出す、純粋なストリーム出力
     */
    public compress(src: Uint8Array): Uint8Array {
        // ヘッダサイズは 8B(元サイズ) + 256B(符号長) = 264B 固定
        const outBuffer = new Uint8Array(264 + src.length * 2);
        const dataLengthView = new DataView(outBuffer.buffer);
        
        dataLengthView.setBigUint64(0, BigInt(src.length), false); // 先頭8Bに元サイズ
        outBuffer.set(this.codeLengths, 8); // 次の256Bにヘッダ
        
        let writeIndex = 264;
        let byteBuffer = 0;
        let bitCount = 0;

        for (let i = 0; i < src.length; i++) {
            const { code, length } = this.bitCodes[src[i]];
            if (length === 0) continue;

            for (let b = length - 1; b >= 0; b--) {
                const bit = (code >> b) & 1;
                byteBuffer = (byteBuffer << 1) | bit;
                bitCount++;

                if (bitCount === 8) {
                    outBuffer[writeIndex++] = byteBuffer;
                    byteBuffer = 0;
                    bitCount = 0;
                }
            }
        }

        if (bitCount > 0) {
            byteBuffer = byteBuffer << (8 - bitCount);
            outBuffer[writeIndex++] = byteBuffer;
        }

        return outBuffer.subarray(0, writeIndex);
    }
}

/**
 * 【復元側】純粋ハフマン・デコーダー
 */
class HuffmanDecoder {
    private rebuildTreeFromLengths(lengths: Uint8Array): HuffmanNode {
        const root: HuffmanNode = { value: -1, left: null, right: null };
        let currentCode = 0;
        let lastLength = 0;

        for (let len = 1; len <= 32; len++) {
            for (let i = 0; i < 256; i++) {
                if (lengths[i] === len) {
                    if (lastLength > 0) {
                        currentCode = (currentCode + 1) << (len - lastLength);
                    }
                    lastLength = len;

                    let currentNode = root;
                    for (let b = len - 1; b >= 0; b--) {
                        const bit = (currentCode >> b) & 1;
                        if (bit === 0) {
                            if (!currentNode.left) currentNode.left = { value: -1, left: null, right: null };
                            currentNode = currentNode.left;
                        } else {
                            if (!currentNode.right) currentNode.right = { value: -1, left: null, right: null };
                            currentNode = currentNode.right;
                        }
                    }
                    currentNode.value = i;
                }
            }
        }
        return root;
    }

    public decompress(packedData: Uint8Array): Uint8Array {
        const dataLengthView = new DataView(packedData.buffer, packedData.byteOffset, packedData.byteLength);
        const originalLength = dataLengthView.getBigUint64(0, false);

        const codeLengths = packedData.subarray(8, 264); 
        const root = this.rebuildTreeFromLengths(codeLengths);

        const dest = new Uint8Array(Number(originalLength));
        let destIndex = 0;
        let readIndex = 264;
        let currentNode = root;

        let byte = 0;
        let bitPos = -1;

        while (destIndex < dest.length) {
            if (bitPos < 0) {
                if (readIndex >= packedData.length) break;
                byte = packedData[readIndex++];
                bitPos = 7;
            }

            const bit = (byte >> bitPos) & 1;
            bitPos--;

            currentNode = bit === 0 ? currentNode.left! : currentNode.right!;

            if (currentNode.value !== -1) {
                dest[destIndex++] = currentNode.value;
                currentNode = root; // 木の根元にリセット
            }
        }
        return dest;
    }
}

// --- テストデータ生成部（マインの提案：ランダム日本語版） ---
const textEncoder = new TextEncoder();
let randomText = "";

for (let i = 0; i < 3500; i++) {
    let charCode = 0;
        charCode = 0x4E00 + Math.floor(Math.random() * (0x6000 - 0x4E00)); // 漢字
    
    randomText += String.fromCharCode(charCode);
}

const originalData = textEncoder.encode(randomText);

console.log("1. 元のデータサイズ（日本語ランダム）:", originalData.byteLength, "bytes");

// --- 圧縮実行 ---
const comp = new HuffmanCompressor();
const freq = comp.analyzeFrequency(originalData);
comp.buildHuffmanTree(freq);
const packedBinary = comp.compress(originalData);

console.log("\n2. 純粋ハフマン 圧縮完了！");
console.log("総出力バイナリサイズ（ヘッダ264B込み）:", packedBinary.byteLength, "bytes");

// --- 復元（解凍）実行 ---
const decomp = new HuffmanDecoder();
const restoredData = decomp.decompress(packedBinary);

console.log("\n3. 復元完了！");
console.log("解凍されたデータサイズ:", restoredData.byteLength, "bytes");

let isPerfect = restoredData.byteLength === originalData.byteLength;
if (isPerfect) {
    for (let i = 0; i < originalData.length; i++) {
        if (originalData[i] !== restoredData[i]) {
            isPerfect = false;
            break;
        }
    }
}
console.log("\n[最終判定] 1ビットの狂いもなく完全復元できたか:", isPerfect ? "YES! 完璧に大成功！" : "NO...データ破損");