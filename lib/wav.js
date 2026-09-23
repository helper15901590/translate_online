/**
 * 音频工具：重采样、WAV 编码、base64。
 *
 * 全部在普通 JS 里做，不依赖 MediaRecorder —— 因为 MediaRecorder 产出的
 * WebM/Opus 分片除第一片外都无法独立解码，而我们需要把长录音切成一个个
 * 可以单独送给 ASR 的完整音频文件。
 */

/**
 * 盒式滤波重采样。对于降采样场景，[start, end) 窗口内的加权平均同时完成了
 * 低通滤波（抗混叠）和插值，语音识别足够用，且是 O(n)。
 */
export function resample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;

  const ratio = fromRate / toRate;
  const outLength = Math.max(0, Math.floor(input.length / ratio));
  const out = new Float32Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const start = i * ratio;
    const end = start + ratio;
    let sum = 0;
    let weight = 0;

    for (let j = Math.floor(start); j < Math.ceil(end) && j < input.length; j++) {
      if (j < 0) continue;
      const overlap = Math.min(end, j + 1) - Math.max(start, j);
      if (overlap <= 0) continue;
      sum += input[j] * overlap;
      weight += overlap;
    }

    out[i] = weight > 0 ? sum / weight : 0;
  }

  return out;
}

/** 把多声道 Float32 数据混成单声道。 */
export function toMono(channels) {
  if (channels.length === 1) return channels[0];

  const length = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(length);

  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let c = 0; c < channels.length; c++) sum += channels[c][i];
    out[i] = sum / channels.length;
  }

  return out;
}

/**
 * 编码成 16-bit PCM 单声道 WAV。
 * @param {Float32Array} samples - 归一化到 [-1, 1] 的采样点
 * @param {number} sampleRate
 * @returns {ArrayBuffer}
 */
export function encodeWav16(samples, sampleRate) {
  const channels = 1;
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk 长度
  view.setUint16(20, 1, true); // 1 = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true); // 字节率
  view.setUint16(32, channels * bytesPerSample, true); // 块对齐
  view.setUint16(34, 16, true); // 位深

  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }

  return buffer;
}

/** ArrayBuffer -> base64。分块处理，避免 String.fromCharCode 爆栈。 */
export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';

  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }

  return btoa(binary);
}

/**
 * 生成一段指定时长的静音 WAV，用于「测试连接」时验证 API Key。
 */
export function silentWav(seconds = 1, sampleRate = 16000) {
  return encodeWav16(new Float32Array(Math.round(seconds * sampleRate)), sampleRate);
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}
