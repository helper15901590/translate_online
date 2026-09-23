/**
 * AudioWorklet 处理器：把标签页音频的每一帧原始 PCM 直接抛给主线程。
 *
 * 用 AudioWorklet 而不是 MediaRecorder 的原因：MediaRecorder 输出的是 WebM/Opus，
 * 而且除第一个分片外都不是可独立解码的文件，没法拿来逐片送 ASR。
 * 这里直接拿浮点 PCM，主线程再重采样、切分、编码成 WAV，每一片都是完整文件。
 *
 * AudioWorklet 不支持 ESM import，所以这个文件必须自包含。
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._lastReport = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) {
      // 源还没接上或已断开，保持节点存活
      return true;
    }

    const frameCount = input[0].length;
    const mono = new Float32Array(frameCount);

    if (input.length === 1) {
      mono.set(input[0]);
    } else {
      // 多声道降为单声道（人声内容没必要保留立体声，还能省一半体积）
      for (let channel = 0; channel < input.length; channel++) {
        const data = input[channel];
        if (!data) continue;
        for (let i = 0; i < frameCount; i++) mono[i] += data[i];
      }
      for (let i = 0; i < frameCount; i++) mono[i] /= input.length;
    }

    // 转移所有权，避免每帧都复制
    this.port.postMessage(mono, [mono.buffer]);

    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
