/**
 * 切片决策：在一片分块存储的 PCM 缓冲区里，找一个合适的下刀位置。
 *
 * 抽成独立模块是为了能被单测覆盖 —— 这里的下标数学（缓冲区分块、窗口跨块、
 * 边界越界）是整条音频链路上最容易悄悄出错的一段，而 offscreen.js 因为模块
 * 加载时就依赖 chrome.*，没办法在 Node 里导入。
 */

/**
 * 累加缓冲区 [from, to) 的能量均值。
 *
 * 缓冲区是若干个 AudioWorklet 回调抛过来的 Float32Array 分块，这里逐块推进，
 * 而不是先把它们拼成一个连续数组 —— 拼接每切一次片就要复制整块缓冲
 * （48kHz 下 60 秒约 288 万个采样点、11.5MB），而所有搜索窗口加起来
 * 只占其中百分之一左右。
 *
 * @param {Float32Array[]} chunks
 * @param {number} from 起始下标（全局，含）
 * @param {number} to   结束下标（全局，不含）
 */
export function windowEnergy(chunks, from, to) {
  // 空窗口返回 Infinity 而不是 0：这样它在「找最安静窗口」的竞争中永远不会
  // 胜出。改动前这种窗口会算出 NaN，NaN 参与比较同样永不胜出，语义一致。
  if (to <= from) return Infinity;

  let energy = 0;
  let base = 0;

  for (const chunk of chunks) {
    const chunkEnd = base + chunk.length;

    if (chunkEnd > from) {
      const start = Math.max(from - base, 0);
      const end = Math.min(to - base, chunk.length);
      for (let i = start; i < end; i++) energy += chunk[i] * chunk[i];
    }

    base = chunkEnd;
    if (base >= to) break;
  }

  return energy / (to - from);
}

/**
 * 在目标切点前 searchSamples 个采样点里，找能量最低的那个窗口，把刀落在它末尾。
 *
 * 直接按固定长度硬切很容易把词切一半，往静音处挪一下能显著减少断句错误。
 * 窗口不足两个（切点太靠前）时不做搜索，直接返回 target。
 *
 * 调用方保证 totalLength >= target，所以 to 一定落在缓冲区范围内。
 *
 * @returns {number} 切点（全局下标）
 */
export function findCutPoint({ chunks, totalLength, target, searchSamples, windowSamples }) {
  const searchStart = Math.max(1, target - searchSamples);
  const windowCount = Math.floor((target - searchStart) / windowSamples);
  if (windowCount < 2) return target;

  let bestIndex = -1;
  let bestEnergy = Infinity;

  for (let w = 0; w < windowCount; w++) {
    const from = searchStart + w * windowSamples;
    const to = Math.min(from + windowSamples, totalLength);
    const energy = windowEnergy(chunks, from, to);

    if (energy < bestEnergy) {
      bestEnergy = energy;
      bestIndex = to;
    }
  }

  return bestIndex > 0 ? bestIndex : target;
}

import { resampledLength } from './wav.js';

/**
 * 估算一段音频重采样、编码成 16-bit 单声道 WAV、再转 base64 之后的字符数。
 *
 * 用采样点数直接推算，是为了在决定要不要二分拆分之前就拿到体积 ——
 * 否则得先做一次全量重采样，拆分时再把它扔掉重做两遍。
 *
 * 长度算式复用 resample() 内部那一个（lib/wav.js 的 resampledLength），
 * 所以两者永远不会因为浮点舍入差出一个采样点。
 */
export function estimateBase64Bytes(sampleCount, fromRate, toRate) {
  return resampledLength(sampleCount, fromRate, toRate) * 2 * (4 / 3);
}
