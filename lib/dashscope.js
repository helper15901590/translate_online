/**
 * DashScope 语音识别客户端。
 *
 * 只走「同步 + base64 音频」这一条路，原因：
 *
 *  1. paraformer-realtime-v2 的 WebSocket 鉴权必须在握手阶段带 Authorization 头，
 *     浏览器原生 WebSocket 无法设置自定义请求头，此路不通（除非自建代理）。
 *  2. 录音文件识别（filetrans）需要可公网访问的音频 URL，本地捕获的音频传不上去。
 *  3. qwen3-asr-flash 的同步接口直接接受 `data:audio/wav;base64,...` 形式的音频，
 *     限制是单次 10MB / 5 分钟以内 —— 正好用「按 60 秒切片」来满足。
 *
 * 重试、超时、错误格式化在 lib/http.js。
 */

import { arrayBufferToBase64, silentWav } from './wav.js';
import { ENGINES, resolveBaseUrl } from './settings.js';
import { postJson, extractErrorMessage } from './http.js';

/** 单次请求 base64 之后的体积上限（官方限制 10MB，留一点余量）。 */
export const MAX_BASE64_BYTES = 9_000_000;

/** 把设置和原始音频组装成一次识别请求。 */
function buildRequest({ settings, baseUrl, wavBuffer, sampleRate, mime = 'audio/wav' }) {
  const dataUrl = `data:${mime};base64,${arrayBufferToBase64(wavBuffer)}`;
  const engine = ENGINES[settings.engine] || ENGINES.openai;
  const asrOptions = {};
  if (settings.language) asrOptions.language = settings.language;
  if (settings.enableItn) asrOptions.enable_itn = true;
  if (settings.context && settings.context.trim()) asrOptions.context = settings.context.trim();

  if (settings.engine === 'native') {
    return {
      url: `${baseUrl}${engine.path}`,
      body: {
        model: settings.model,
        input: {
          messages: [{ role: 'user', content: [{ audio: dataUrl }] }],
        },
        parameters: { asr_options: asrOptions },
      },
    };
  }

  return {
    url: `${baseUrl}${engine.path}`,
    body: {
      model: settings.model,
      messages: [
        {
          role: 'user',
          content: [{ type: 'input_audio', input_audio: { data: dataUrl } }],
        },
      ],
      stream: false,
      asr_options: asrOptions,
    },
  };
}

/** 两个通道的返回结构不一样，这里统一取出纯文本。 */
function extractText(payload) {
  const openAiContent = payload?.choices?.[0]?.message?.content;
  if (typeof openAiContent === 'string') return openAiContent;

  const nativeContent = payload?.output?.choices?.[0]?.message?.content;
  const content = Array.isArray(openAiContent) ? openAiContent : nativeContent;

  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  }

  return '';
}

/** 把各种失败翻译成能直接给用户看的中文。 */
function describeError(status, payload) {
  const detail = extractErrorMessage(payload);

  switch (status) {
    case 401:
    case 403:
      return 'API Key 无效或没有该模型的权限，请到设置页检查 Key 与地域是否匹配（北京站和国际站的 Key 不通用）。';
    case 402:
      return '账户欠费或未开通百炼服务。';
    case 429:
      return '触发限流或免费额度已用尽，请稍后重试。';
    case 400:
      if (/too long|duration|length|size/i.test(detail)) {
        return `音频分片超出模型限制：${detail}。请到设置页把「分片时长」调小。`;
      }
      return `请求参数有误：${detail || '请检查模型名称与设置页配置。'}`;
    default:
      if (status >= 500) return `DashScope 服务端错误（HTTP ${status}），稍后会自动重试。`;
      return `请求失败（HTTP ${status}）${detail ? '：' + detail : ''}`;
  }
}

/**
 * 识别一段 WAV 音频，返回文本。
 *
 * @param {object} params
 * @param {object} params.settings   插件设置
 * @param {ArrayBuffer} params.wavBuffer
 * @param {number} params.sampleRate
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<string>}
 */
export async function transcribe({ settings, wavBuffer, sampleRate, signal }) {
  const baseUrl = resolveBaseUrl(settings);
  const { url, body } = buildRequest({ settings, baseUrl, wavBuffer, sampleRate });

  const payload = await postJson({
    url,
    apiKey: settings.apiKey,
    body,
    signal,
    describe: describeError,
    // 原生多模态通道默认会尝试 SSE，这里明确要一次性响应
    headers: { 'X-DashScope-SSE': 'disable' },
  });

  return extractText(payload).trim();
}

/**
 * 「测试连接」：送一段 1 秒静音过去。只要 HTTP 200 就说明 Key、地域、
 * 模型名、网络这几项都通了（返回空文本是正常的）。
 */
export async function testConnection(settings) {
  const wavBuffer = silentWav(1, 16000);
  const text = await transcribe({ settings, wavBuffer, sampleRate: 16000 });
  return { ok: true, text };
}
