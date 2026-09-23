/**
 * Offscreen 文档：真正干活的地方。
 *
 * 职责链条：
 *   标签页音轨 -> AudioWorklet 取 PCM -> 缓冲 -> 找静音点切片 -> 重采样 ->
 *   编码 WAV -> base64 -> DashScope 识别 -> 交给 SW 写回 session
 *
 * 两条硬约束决定了这里的写法：
 *
 *   1. offscreen 文档里**只有 chrome.runtime 可用**，chrome.storage 是
 *      undefined。所以所有读写存储的动作都必须发消息让 Service Worker 代劳，
 *      settings 也由 SW 在启动时一并传进来。
 *   2. chrome.runtime 消息是 JSON 序列化的，ArrayBuffer 传不过去。所以几 MB
 *      的音频数据留在这个文档里直接发请求，只把文本结果传出去。
 */

import { resample, encodeWav16 } from './lib/wav.js';
import { transcribe, MAX_BASE64_BYTES } from './lib/dashscope.js';
import { translateSegment, shouldTranslate } from './lib/translate.js';
import { buildMarkdown } from './lib/markdown.js';
import { buildFilename } from './lib/format.js';

/** 切片的静音搜索窗口：在目标切点前这么长的时间里找能量最低的位置下刀。 */
const SILENCE_SEARCH_SEC = 2;
const SILENCE_WINDOW_SEC = 0.15;
/** 小于这个长度的尾巴不值得单独识别。 */
const MIN_TAIL_SEC = 0.4;

/** @type {null | {stream: MediaStream, ctx: AudioContext, source: MediaStreamAudioSourceNode, worklet: AudioWorkletNode, monitorGain: GainNode, sinkGain: GainNode}} */
let capture = null;

let session = null;
let settings = null;
let captureRate = 48000;
let chunkTargetSamples = 0;
let buffered = [];
let bufferedLength = 0;
let emittedSamples = 0;
let stopping = false;
let finalized = false;
/** 识别队列（串行，保证分段顺序和时间轴一致） */
let asrQueue = [];
let recognizing = false;
/**
 * 翻译队列，和识别队列**并行**推进：第 N 段在翻译时，第 N+1 段可以同时识别。
 * 两条链路各自串行，所以顺序仍然稳定，但整体吞吐接近翻倍。
 */
let translateQueue = [];
let translating = false;
/**
 * 会话世代号。每次 startCapture 自增，用于把上一轮会话残留的任务和收尾逻辑
 * 彻底隔离 —— 否则「上一次还在识别，用户又点了开始」时，旧队列可能把状态
 * 写到新会话上，甚至提前把它标记成已结束。
 */
let generation = 0;
let keepAlivePort = null;
let keepAliveTimer = null;

/** 还在排队或正在处理的分片总数，用于状态展示。 */
function pendingCount() {
  return asrQueue.length + translateQueue.length;
}

/* ------------------------------------------------------------------ 工具 */

/**
 * 把会话状态交给 Service Worker 落盘。
 *
 * 这个文档里没有 chrome.storage（offscreen 只暴露 chrome.runtime），所以存储
 * 必须绕一圈。同一发送方的消息是按顺序投递的，加上每次发送都会做一次快照，
 * 所以不必担心「先发的后到」把新状态覆盖回旧的。
 */
async function persist() {
  if (!session) return;
  try {
    await chrome.runtime.sendMessage({ type: 'SESSION_UPDATE', session });
  } catch (err) {
    // 扩展重载或 SW 正在重启时会失败，丢了状态也不该影响录制本身
    console.warn('[转录] 写入会话状态失败', err);
  }
}

/** 会话内的累计样本数换算成秒。 */
function samplesToSec(samples) {
  return samples / captureRate;
}

/* ------------------------------------------------- 音频图搭建与 PCM 收集 */

async function startCapture({ streamId, meta, settings: incomingSettings }) {
  if (capture) await stopCapture({ reason: 'restart' });

  // 上一次启动还卡在 starting 窗口里（capture 尚未赋值，stopCapture 拦不住）。
  // 这时再启动一次会创建第二个 AudioContext 并覆盖 session，所以直接拒绝。
  if (session && !capture && session.status === 'starting') {
    throw new Error('上一次启动还没完成，请稍候再试。');
  }

  // settings 由 Service Worker 读好传进来 —— 本文档拿不到 chrome.storage
  if (!incomingSettings) throw new Error('启动参数缺少设置，请重试。');
  settings = incomingSettings;

  captureRate = 0; // 拿到 AudioContext 后再填
  stopping = false;
  finalized = false;
  generation += 1;
  buffered = [];
  bufferedLength = 0;
  emittedSamples = 0;
  asrQueue = [];
  translateQueue = [];

  session = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    // 先标成 starting 而不是 recording。这一刻音频图还没接上，capture 仍是 null，
    // SW 探测不到「正在录」；若此时已写成 recording，一次恰好落在这个窗口里的
    // 状态查询就会把刚开头的录制误判成「被中断」。等 capture 就位后再改口。
    status: 'starting',
    tabId: meta.tabId,
    tabTitle: meta.tabTitle || '未命名页面',
    tabUrl: meta.tabUrl || '',
    favIconUrl: meta.favIconUrl || '',
    startedAt: Date.now(),
    endedAt: null,
    durationSec: 0,
    segments: [],
    error: null,
    model: settings.model,
    engine: settings.engine,
  };
  await persist();

  // 1. 用 stream id 换标签页音轨
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
  } catch (err) {
    session.status = 'error';
    session.error = `无法捕获标签页音频：${err.message}`;
    await persist();
    throw err;
  }

  // 2. 建音频图。tabCapture 默认会让原标签页静音，所以必须把音频重新接到
  //    扬声器上，否则用户录制时听不到声音。
  const ctx = new AudioContext();
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch (err) {
      console.warn('[转录] AudioContext 无法恢复，可能受自动播放策略限制', err);
    }
  }

  // 挂起的 AudioContext 不会处理音频，表现是「录制正常但一段都识别不出来」，
  // 这种静默失败最难排查，所以直接在这里拦下来。
  if (ctx.state !== 'running') {
    await ctx.close().catch(() => {});
    stream.getTracks().forEach((track) => track.stop());
    session.status = 'error';
    session.error = '音频处理被浏览器挂起（自动播放限制），无法开始录制。请重试一次，或重启浏览器。';
    await persist();
    throw new Error(session.error);
  }
  captureRate = ctx.sampleRate;
  chunkTargetSamples = Math.round(settings.chunkSeconds * captureRate);

  const source = ctx.createMediaStreamSource(stream);
  await ctx.audioWorklet.addModule(chrome.runtime.getURL('worklet/pcm-processor.js'));
  const worklet = new AudioWorkletNode(ctx, 'pcm-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: 'explicit',
    processorOptions: {},
  });
  worklet.port.onmessage = (event) => onPcm(event.data);

  // 静音通路：AudioWorkletNode 必须连到 destination 才会被音频图拉取
  const sinkGain = ctx.createGain();
  sinkGain.gain.value = 0;
  const monitorGain = ctx.createGain();
  monitorGain.gain.value = settings.monitor ? 1 : 0;

  source.connect(worklet);
  worklet.connect(sinkGain);
  sinkGain.connect(ctx.destination);
  source.connect(monitorGain);
  monitorGain.connect(ctx.destination);

  capture = { stream, ctx, source, worklet, monitorGain, sinkGain };

  // 3. 标签页被关掉 / 音频被系统断开时收尾
  const track = stream.getAudioTracks()[0];
  if (track) {
    track.addEventListener('ended', () => {
      if (!stopping) stopCapture({ reason: 'track-ended' });
    });
  }

  // 音轨真正接上、断开兜底也挂好了，才对外声称「录制中」。
  // 这个时间点之后状态查询才会看到 capturing=true，两者一致。
  // 放在 persist() 之前能少一个「音频已断但没人收尾」的窗口。
  session.status = 'recording';
  await persist();

  startKeepAlive();
  return { sessionId: session.id, captureRate };
}

/** AudioWorklet 每 128 帧回调一次，这里只做累积和触发切片。 */
function onPcm(mono) {
  if (stopping || !capture) return;

  buffered.push(mono);
  bufferedLength += mono.length;

  while (bufferedLength >= chunkTargetSamples) {
    const cut = findCutPoint();
    if (cut <= 0) break;
    const samples = takeSamples(cut);
    const startSec = samplesToSec(emittedSamples);
    emittedSamples += samples.length;
    const endSec = samplesToSec(emittedSamples);
    enqueueAudio(samples, startSec, endSec);
  }
}

/**
 * 在目标切点前 SILENCE_SEARCH_SEC 秒里找能量最低的位置。
 * 直接按固定长度硬切很容易把词切一半，往静音处挪一下能显著减少断句错误。
 */
function findCutPoint() {
  const target = chunkTargetSamples;
  const searchSamples = Math.round(SILENCE_SEARCH_SEC * captureRate);
  const windowSamples = Math.round(SILENCE_WINDOW_SEC * captureRate);

  const searchStart = Math.max(1, target - searchSamples);
  const windowCount = Math.floor((target - searchStart) / windowSamples);
  if (windowCount < 2) return target;

  // 把缓冲区拼成连续数组才能做窗口能量统计
  const flat = concatBuffer();

  let bestIndex = -1;
  let bestEnergy = Infinity;

  for (let w = 0; w < windowCount; w++) {
    const from = searchStart + w * windowSamples;
    const to = Math.min(from + windowSamples, flat.length);
    let energy = 0;
    for (let i = from; i < to; i++) energy += flat[i] * flat[i];
    energy /= to - from;

    if (energy < bestEnergy) {
      bestEnergy = energy;
      bestIndex = to;
    }
  }

  return bestIndex > 0 ? bestIndex : target;
}

function concatBuffer() {
  const flat = new Float32Array(bufferedLength);
  let offset = 0;
  for (const chunk of buffered) {
    flat.set(chunk, offset);
    offset += chunk.length;
  }
  return flat;
}

/** 从缓冲区头部取走 count 个样本。 */
function takeSamples(count) {
  const out = new Float32Array(count);
  let filled = 0;

  while (filled < count && buffered.length) {
    const head = buffered[0];
    const needed = count - filled;

    if (head.length <= needed) {
      out.set(head, filled);
      filled += head.length;
      buffered.shift();
    } else {
      out.set(head.subarray(0, needed), filled);
      buffered[0] = head.subarray(needed);
      filled += needed;
    }
  }

  bufferedLength -= filled;
  return out;
}

/* -------------------------------------------------------------- 切片入队 */

/**
 * 把一段音频变成识别任务。如果编码后超出单次请求体积上限，
 * 就二分再拆，保证每个任务都是合法请求。
 */
function enqueueAudio(samples, startSec, endSec) {
  const resampled = resample(samples, captureRate, settings.sampleRate);
  const estimatedBase64 = resampled.length * 2 * (4 / 3);

  if (estimatedBase64 > MAX_BASE64_BYTES && samples.length > captureRate) {
    const half = Math.floor(samples.length / 2);
    const midSec = startSec + (endSec - startSec) * (half / samples.length);
    enqueueAudio(samples.subarray(0, half), startSec, midSec);
    enqueueAudio(samples.subarray(half), midSec, endSec);
    return;
  }

  const wavBuffer = encodeWav16(resampled, settings.sampleRate);
  const segment = {
    index: session.segments.length,
    startSec,
    endSec,
    // 语音识别
    text: '',
    status: 'pending',
    error: null,
    bytes: wavBuffer.byteLength,
    // 翻译与生词（每一段独立，所以译文和原文天然一一对应）
    translation: '',
    translateStatus: 'idle',
    translateError: null,
    vocab: [],
    vocabStatus: 'idle',
  };
  session.segments.push(segment);
  persist();

  asrQueue.push({ segment, wavBuffer, startSec, endSec, generation });
  drainAsrQueue();
}

/* ------------------------------------------------------------ 流水线调度 */

/**
 * 两条队列各自串行，但互不阻塞：
 *
 *   识别:  段1 ──► 段2 ──► 段3 ...
 *   翻译:        └► 段1 ──► 段2 ...
 *
 * 第 N 段的识别一结束就把它丢进翻译队列，去和第 N+1 段的识别并行跑。
 * 顺序仍然稳定（各自串行），但整体耗时从「识别+翻译」变成 max(识别, 翻译)。
 */
async function drainAsrQueue() {
  if (recognizing) return;
  recognizing = true;

  const myGeneration = generation;

  // 一旦 generation 变了就立刻退出，把队列留给新会话那一轮去跑。
  // 注意不能在这里把不认识的任务 shift 掉 —— 那会静默丢掉新会话的音频。
  while (asrQueue.length && generation === myGeneration) {
    const job = asrQueue.shift();
    if (job.generation !== myGeneration) continue; // 同一代内不该出现，纯保险
    await runAsrJob(job);
  }

  recognizing = false;

  if (generation !== myGeneration) {
    // 录制已经在别处重新开始了：把队列交还给新一代
    if (asrQueue.length) drainAsrQueue();
    return;
  }

  await maybeFinalize(myGeneration);
}

async function drainTranslateQueue() {
  if (translating) return;
  translating = true;

  const myGeneration = generation;

  while (translateQueue.length && generation === myGeneration) {
    const job = translateQueue.shift();
    if (job.generation !== myGeneration) continue;
    await runTranslateJob(job);
  }

  translating = false;

  if (generation !== myGeneration) {
    if (translateQueue.length) drainTranslateQueue();
    return;
  }

  await maybeFinalize(myGeneration);
}

/**
 * 两条流水线都空了、并且已经停止录制，才真正收尾。
 * 收尾动作（写状态、自动下载、断开保活）只能做一次。
 */
async function maybeFinalize(myGeneration) {
  if (generation !== myGeneration) return;
  if (!stopping) return;
  if (recognizing || translating) return;
  if (asrQueue.length || translateQueue.length) return;

  await finalize(myGeneration);
}

/**
 * 收尾：标记会话完成、必要时自动下载。
 *
 * 有三个入口会走到这里（识别队列跑空、翻译队列跑空、以及 stopCapture 发现
 * 队列本来就是空的），它们之间存在 await 空隙，所以必须用标志位保证只执行
 * 一次 —— 否则自动下载会触发两遍。expectedGeneration 再兜一层：只给发起它的
 * 那次会话收尾。
 */
async function finalize(expectedGeneration) {
  if (finalized || !session) return;
  if (expectedGeneration !== undefined && expectedGeneration !== generation) return;
  finalized = true;
  session.status = 'done';
  session.endedAt = session.endedAt || Date.now();
  session.durationSec = samplesToSec(emittedSamples);
  await persist();

  await maybeAutoDownload();
  teardown();
}

/* -------------------------------------------------------------- 第一段：识别 */

async function runAsrJob({ segment, wavBuffer }) {
  try {
    const text = await transcribe({
      settings: { ...settings, context: buildContext(segment.index) },
      wavBuffer,
      sampleRate: settings.sampleRate,
    });
    segment.text = text;
    segment.status = 'done';
  } catch (err) {
    segment.status = 'error';
    segment.error = err?.message || String(err);
  }
  segment.finishedAt = Date.now();

  enqueueTranslation(segment);
  await persist();
}

/* -------------------------------------------------------------- 第二段：翻译 */

/**
 * 把刚识别完的分片交给翻译链路。
 *
 * 空文本、语言相同、或用户没开翻译时直接标记成 skipped，省得前端再判断一遍。
 * 这里不 await —— 翻译要和下一段的识别并行跑。
 */
function enqueueTranslation(segment) {
  if (segment.status !== 'done' || !segment.text.trim() || !shouldTranslate(settings)) {
    segment.translateStatus = 'skipped';
    return;
  }

  segment.translateStatus = 'pending';
  translateQueue.push({ segment, generation });
  drainTranslateQueue();
}

async function runTranslateJob({ segment }) {
  try {
    const result = await translateSegment({
      settings,
      text: segment.text,
      // 上一段原文只用来帮助模型消解代词和承接关系，不参与选词
      previousText: previousTextOf(segment.index),
    });

    segment.translation = result.translation;
    segment.vocab = result.vocabulary;
    segment.translateStatus = 'done';

    if (result.degraded) {
      // 模型没按 JSON 返回，但译文本身可用，留个标记方便排查
      segment.translateError = '模型未返回结构化结果，已按纯译文处理。';
    }
  } catch (err) {
    segment.translateStatus = 'error';
    segment.translateError = err?.message || String(err);
  }

  segment.translateFinishedAt = Date.now();
  await persist();
}

/** 取前面几段的原文。识别的语境提示和翻译的语境提示都用它。 */
function previousTextOf(index) {
  return session.segments
    .slice(Math.max(0, index - 2), index)
    .filter((seg) => seg.status === 'done' && seg.text)
    .map((seg) => seg.text)
    .join(' ');
}

/**
 * 拼接送给模型的上下文提示：用户自定义热词 + 可选的上一段识别结果。
 * 总长做了截断，避免把 bias 变成「让模型复读」。
 */
function buildContext(segmentIndex) {
  const parts = [];
  if (settings.context && settings.context.trim()) parts.push(settings.context.trim());

  if (settings.carryContext && segmentIndex > 0) {
    const previous = previousTextOf(segmentIndex);
    if (previous) parts.push(previous.slice(-200));
  }

  return parts.join('\n').slice(0, 600);
}

/* ------------------------------------------------------------------ 停止 */

async function stopCapture({ reason = 'user' } = {}) {
  if (!capture || stopping) return;

  stopping = true;
  const myGeneration = generation;

  // 1. 把残留的尾巴也送出去
  if (bufferedLength > MIN_TAIL_SEC * captureRate) {
    const samples = takeSamples(bufferedLength);
    const startSec = samplesToSec(emittedSamples);
    emittedSamples += samples.length;
    enqueueAudio(samples, startSec, samplesToSec(emittedSamples));
  }
  buffered = [];
  bufferedLength = 0;

  // 2. 拆掉音频图。已经写进 queue 的任务持有自己的 WAV 数据，
  //    不受这里影响，会继续识别完。
  if (capture) {
    try {
      capture.source.disconnect();
      capture.worklet.disconnect();
      capture.monitorGain.disconnect();
      capture.sinkGain.disconnect();
      capture.stream.getTracks().forEach((track) => track.stop());
      await capture.ctx.close();
    } catch (err) {
      console.warn('[转录] 释放音频资源时出错', err);
    }
    capture = null;
  }

  if (session) {
    session.status = pendingCount() || recognizing || translating ? 'finishing' : 'done';
    if (session.status === 'done') {
      session.endedAt = Date.now();
      session.durationSec = samplesToSec(emittedSamples);
    }
    session.stopReason = reason;
    await persist();
  }

  // 3. 队列空了就收尾；否则交给两条流水线各自跑完之后收尾。
  //    这里跨了几个 await，期间可能已经有新的录制顶上来（generation 变了），
  //    那种情况下绝不能去 finalize —— 那会把刚开头的新会话直接标记成已完成。
  await maybeFinalize(myGeneration);
}

function teardown() {
  stopKeepAlive();
  if (session) {
    console.log(`[转录] 会话结束：${session.segments.length} 段，${Math.round(session.durationSec)} 秒`);
  }
}

/* --------------------------------------------------------------- 导出 */

async function maybeAutoDownload() {
  if (!settings?.autoDownload || !session) return;

  const done = session.segments.filter((seg) => seg.status === 'done' && seg.text);
  if (!done.length) return;

  const markdown = buildMarkdown(session, settings);
  const filename = buildFilename(settings.filenameTemplate, session);

  // 下载交给 Service Worker 用 chrome.downloads 完成 —— 这个文档是隐藏的、
  // 也没有用户手势，在这里点 <a download> 不保证生效，失败了还看不出痕迹。
  //
  // URL 用 blob 而不是 data：Markdown 里的中文经 encodeURIComponent 会膨胀
  // 约 9 倍（每个汉字 3 字节 → 9 个字符），长录制拼出的 data URL 会超过
  // Chrome 约 2MB 的 URL 长度上限；blob URL 只有几十个字符，与内容大小无关。
  // Service Worker 里没有 URL.createObjectURL，所以 blob 必须在这里建。
  const blobUrl = URL.createObjectURL(
    new Blob([markdown], { type: 'text/markdown;charset=utf-8' }),
  );

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'DOWNLOAD_MARKDOWN',
      url: blobUrl,
      filename,
      // 兜底：万一 blob URL 那条路走不通，SW 还能用文本再拼一次 data URL
      markdown,
    });

    if (!response?.ok) {
      console.warn('[转录] 自动下载失败，可在弹窗里手动「下载 .md」：', response?.error);
    }
  } catch (err) {
    console.warn('[转录] 自动下载失败，可在弹窗里手动「下载 .md」', err);
  } finally {
    // 下载是异步的：chrome.downloads.download 只保证「下载已创建」，
    // 数据可能还没读完。撤销太早会得到空文件，所以留足时间再回收。
    setTimeout(() => URL.revokeObjectURL(blobUrl), 120_000);
  }
}

/* ----------------------------------------------------- Service Worker 保活 */

/**
 * MV3 的 Service Worker 空闲约 30 秒就被回收。录制期间保持一个长连接，
 * 让 popup 随时能拿到最新状态，也避免消息在 SW 冷启动间隙丢失。
 */
function startKeepAlive() {
  if (keepAlivePort) return;
  try {
    keepAlivePort = chrome.runtime.connect({ name: 'capture-keepalive' });
    keepAlivePort.onDisconnect.addListener(() => {
      keepAlivePort = null;
    });
  } catch (err) {
    console.warn('[转录] 保活连接建立失败', err);
  }

  keepAliveTimer = setInterval(() => {
    try {
      keepAlivePort?.postMessage({ type: 'ping', at: Date.now() });
    } catch {
      keepAlivePort = null;
    }
  }, 20_000);
}

function stopKeepAlive() {
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
  try {
    keepAlivePort?.disconnect();
  } catch {
    /* 已经断开就算了 */
  }
  keepAlivePort = null;
}

/* ------------------------------------------------------------- 消息入口 */

const handlers = {
  async OFFSCREEN_START(message) {
    const result = await startCapture({
      streamId: message.streamId,
      meta: message.meta,
      settings: message.settings,
    });
    return { ok: true, ...result };
  },

  async OFFSCREEN_STOP() {
    await stopCapture({ reason: 'user' });
    return { ok: true };
  },

  async OFFSCREEN_STATUS() {
    // 有三种「没有 capture 但会话显然还活着」的情况，SW 需要能分辨它们：
    //   starting  —— 会话已建立，音频图还没接上
    //   finishing —— 音频已断，但识别/翻译队列里还有活
    // 只看 capturing 的话，这两种正常中间态都会被误判成「后台页面被回收」。
    const starting = Boolean(session) && !capture && session.status === 'starting';
    const finishing = Boolean(session) && !capture && session.status === 'finishing';
    const alive = Boolean(capture) || starting || finishing;

    return {
      ok: true,
      capturing: Boolean(capture),
      starting,
      finishing,
      /** 这个文档是否正管着一次活跃会话 —— SW 用它判断能不能给存储里的会话收尸 */
      alive,
      stopping,
      // 识别和翻译分开报，前端可以分别显示进度
      pending: asrQueue.length,
      pendingTranslate: translateQueue.length,
      session,
    };
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;

  handler(message)
    .then(sendResponse)
    .catch((err) => {
      console.error('[转录] 处理消息失败', message?.type, err);
      sendResponse({ ok: false, error: err?.message || String(err) });
    });

  return true; // 异步响应
});
