/**
 * 自测脚本。
 *
 *   node tools/selftest.mjs
 *
 * 插件跑在浏览器里，很多逻辑没法直接点着测。这里把不依赖 Chrome API 的部分
 * 单独拎出来验证：WAV 编码、重采样、请求构造、Markdown 生成、文件名清洗。
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative as relative_ } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resample, encodeWav16, arrayBufferToBase64, silentWav } from '../lib/wav.js';
import { transcribe, MAX_BASE64_BYTES } from '../lib/dashscope.js';
import {
  translateSegment,
  parseTranslationResult,
  extractJsonObject,
  normalizeVocabulary,
  shouldTranslate,
} from '../lib/translate.js';
import { buildMarkdown, buildPlainText, collectVocabulary, hasTranslation } from '../lib/markdown.js';
import { buildFilename, formatClock, formatTimestamp, sanitizeFilename } from '../lib/format.js';
import { DEFAULT_SETTINGS } from '../lib/settings.js';

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

function ascii(view, offset, length) {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

/** 去掉注释再断言，免得注释里提到的代码被误判成真实调用。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/* --------------------------------------------------------------- 重采样 */

console.log('\n重采样');

await test('降采样后长度符合比例', () => {
  const input = new Float32Array(48000);
  const output = resample(input, 48000, 16000);
  assert.equal(output.length, 16000);
});

await test('采样率相同时原样返回', () => {
  const input = new Float32Array([1, 2, 3, 4]);
  assert.equal(resample(input, 16000, 16000), input);
});

await test('直流信号重采样后仍是同一个值', () => {
  const input = new Float32Array(48000).fill(0.5);
  const output = resample(input, 48000, 16000);
  for (const value of output) assert.ok(Math.abs(value - 0.5) < 1e-6, `期望 0.5，实际 ${value}`);
});

await test('正弦波重采样后峰值基本保留', () => {
  const rate = 48000;
  const input = new Float32Array(rate);
  for (let i = 0; i < rate; i++) input[i] = Math.sin((2 * Math.PI * 440 * i) / rate);
  const output = resample(input, rate, 16000);
  const peak = Math.max(...output);
  assert.ok(peak > 0.97 && peak <= 1, `峰值 ${peak} 偏离过大`);
});

/* ------------------------------------------------------------- WAV 编码 */

console.log('\nWAV 编码');

await test('文件头字段全部正确', () => {
  const samples = new Float32Array(16000);
  const buffer = encodeWav16(samples, 16000);
  const view = new DataView(buffer);

  assert.equal(ascii(view, 0, 4), 'RIFF');
  assert.equal(ascii(view, 8, 4), 'WAVE');
  assert.equal(ascii(view, 12, 4), 'fmt ');
  assert.equal(ascii(view, 36, 4), 'data');

  assert.equal(view.getUint32(16, true), 16, 'fmt 块长度');
  assert.equal(view.getUint16(20, true), 1, 'PCM 格式标记');
  assert.equal(view.getUint16(22, true), 1, '声道数');
  assert.equal(view.getUint32(24, true), 16000, '采样率');
  assert.equal(view.getUint32(28, true), 32000, '字节率');
  assert.equal(view.getUint16(32, true), 2, '块对齐');
  assert.equal(view.getUint16(34, true), 16, '位深');

  assert.equal(view.getUint32(40, true), samples.length * 2, 'data 块长度');
  assert.equal(view.getUint32(4, true), 36 + samples.length * 2, 'RIFF 块长度');
  assert.equal(buffer.byteLength, 44 + samples.length * 2);
});

await test('采样值按 16 位有符号定点写入，且做了限幅', () => {
  const buffer = encodeWav16(new Float32Array([0, 1, -1, 2, -2, 0.5]), 16000);
  const view = new DataView(buffer);
  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), 32767, '+1.0 应写到满量程');
  assert.equal(view.getInt16(48, true), -32768, '-1.0 应写到负满量程');
  assert.equal(view.getInt16(50, true), 32767, '+2.0 应被限幅');
  assert.equal(view.getInt16(52, true), -32768, '-2.0 应被限幅');
});

await test('静音 WAV 时长正确', () => {
  const buffer = silentWav(2, 16000);
  assert.equal(buffer.byteLength, 44 + 2 * 16000 * 2);
});

/* --------------------------------------------------------------- base64 */

console.log('\nbase64');

await test('超过 32KB 的数据也能正确编码（分块路径）', () => {
  const bytes = new Uint8Array(200_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;

  const encoded = arrayBufferToBase64(bytes.buffer);
  assert.equal(encoded.length, Math.ceil(bytes.length / 3) * 4);

  const decoded = Buffer.from(encoded, 'base64');
  assert.equal(decoded.length, bytes.length);
  assert.ok(decoded.every((value, index) => value === bytes[index]), '解码结果与原数据不一致');
});

/* -------------------------------------------------- 识别请求的构造与解析 */

console.log('\n识别请求');

const settings = {
  apiKey: 'sk-test-key',
  region: 'cn',
  customBaseUrl: '',
  engine: 'openai',
  model: 'qwen3-asr-flash',
  language: 'zh',
  enableItn: true,
  context: '本期嘉宾是张一鸣',
};

function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(url, init);
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

await test('OpenAI 兼容通道：URL、鉴权头、请求体结构', async () => {
  let captured = null;
  const restore = mockFetch(async (url, init) => {
    captured = { url, init };
    return jsonResponse({ choices: [{ message: { content: '你好世界' } }] });
  });

  try {
    const text = await transcribe({ settings, wavBuffer: silentWav(1, 16000), sampleRate: 16000 });
    assert.equal(text, '你好世界');
  } finally {
    restore();
  }

  assert.equal(captured.url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(captured.init.headers.Authorization, 'Bearer sk-test-key');
  assert.equal(captured.init.headers['Content-Type'], 'application/json');

  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'qwen3-asr-flash');
  assert.equal(body.stream, false);
  assert.equal(body.messages[0].role, 'user');

  const part = body.messages[0].content[0];
  assert.equal(part.type, 'input_audio');
  assert.ok(part.input_audio.data.startsWith('data:audio/wav;base64,'), '音频应是 data URL');

  assert.equal(body.asr_options.language, 'zh');
  assert.equal(body.asr_options.enable_itn, true);
  assert.equal(body.asr_options.context, '本期嘉宾是张一鸣');
});

await test('DashScope 原生通道：走 multimodal-generation 且结构不同', async () => {
  let captured = null;
  const restore = mockFetch(async (url, init) => {
    captured = { url, init };
    return jsonResponse({ output: { choices: [{ message: { content: [{ text: '原生通道结果' }] } }] } });
  });

  let text;
  try {
    text = await transcribe({
      settings: { ...settings, engine: 'native' },
      wavBuffer: silentWav(1, 16000),
      sampleRate: 16000,
    });
  } finally {
    restore();
  }

  assert.equal(text, '原生通道结果');
  assert.equal(
    captured.url,
    'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
  );

  const body = JSON.parse(captured.init.body);
  assert.ok(body.input.messages[0].content[0].audio.startsWith('data:audio/wav;base64,'));
  assert.equal(body.parameters.asr_options.language, 'zh');
  assert.equal(body.messages, undefined, '原生通道不应带 OpenAI 格式的 messages 字段');
});

await test('OpenAI 通道的 content 为数组时也能取出文本', async () => {
  const restore = mockFetch(async () =>
    jsonResponse({ choices: [{ message: { content: [{ type: 'text', text: '数组形式' }] } }] }),
  );
  let text;
  try {
    text = await transcribe({ settings, wavBuffer: silentWav(1, 16000), sampleRate: 16000 });
  } finally {
    restore();
  }
  assert.equal(text, '数组形式');
});

await test('返回空文本不报错', async () => {
  const restore = mockFetch(async () => jsonResponse({ choices: [{ message: { content: '' } }] }));
  let text;
  try {
    text = await transcribe({ settings, wavBuffer: silentWav(1, 16000), sampleRate: 16000 });
  } finally {
    restore();
  }
  assert.equal(text, '');
});

await test('401 给出可读的中文提示且不重试', async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls++;
    return jsonResponse({ error: { message: 'Invalid API-key provided.' } }, 401);
  });

  let error = null;
  try {
    await transcribe({ settings, wavBuffer: silentWav(1, 16000), sampleRate: 16000 });
  } catch (err) {
    error = err;
  } finally {
    restore();
  }

  assert.ok(error, '应当抛错');
  assert.match(error.message, /API Key 无效/);
  assert.equal(calls, 1, '401 不应重试');
});

await test('5xx 会重试三次后失败', async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls++;
    return jsonResponse({ message: 'service unavailable' }, 503);
  });

  let error = null;
  try {
    await transcribe({ settings, wavBuffer: silentWav(1, 16000), sampleRate: 16000 });
  } catch (err) {
    error = err;
  } finally {
    restore();
  }

  assert.ok(error, '应当抛错');
  assert.equal(calls, 3, `应当重试到 3 次，实际 ${calls}`);
});

await test('服务端异常后重试成功', async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls++;
    if (calls === 1) return jsonResponse({ message: 'busy' }, 429);
    return jsonResponse({ choices: [{ message: { content: '第二次成功' } }] });
  });

  let text;
  try {
    text = await transcribe({ settings, wavBuffer: silentWav(1, 16000), sampleRate: 16000 });
  } finally {
    restore();
  }

  assert.equal(text, '第二次成功');
  assert.equal(calls, 2);
});

await test('自定义地域拼接正确', async () => {
  let captured = null;
  const restore = mockFetch(async (url, init) => {
    captured = { url, init };
    return jsonResponse({ choices: [{ message: { content: '' } }] });
  });

  try {
    await transcribe({
      settings: { ...settings, region: 'custom', customBaseUrl: 'https://ws123.cn-beijing.maas.aliyuncs.com/' },
      wavBuffer: silentWav(0.5, 16000),
      sampleRate: 16000,
    });
  } finally {
    restore();
  }

  assert.equal(captured.url, 'https://ws123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
});

await test('单次请求体积上限留了余量', () => {
  assert.ok(MAX_BASE64_BYTES < 10 * 1024 * 1024, '必须小于官方 10MB 限制');
  assert.ok(MAX_BASE64_BYTES > 5 * 1024 * 1024, '不应过于保守');
});

/* ------------------------------------------------------------ Markdown */

console.log('\nMarkdown 生成');

const session = {
  tabTitle: '如何理解大模型推理优化',
  tabUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
  startedAt: new Date('2026-09-23T11:08:00').getTime(),
  endedAt: new Date('2026-09-23T11:20:15').getTime(),
  durationSec: 735,
  model: 'qwen3-asr-flash',
  segments: [
    { index: 0, startSec: 0, endSec: 60, status: 'done', text: '大家好，欢迎来到本期节目。今天我们聊聊推理优化。' },
    { index: 1, startSec: 60, endSec: 120, status: 'done', text: '第一部分是 KV Cache 的显存占用问题。' },
    { index: 2, startSec: 120, endSec: 180, status: 'error', text: '', error: '请求超时（120 秒）。' },
    { index: 3, startSec: 180, endSec: 240, status: 'done', text: '' },
  ],
};

await test('包含标题与元信息', () => {
  const md = buildMarkdown(session, settings);
  assert.ok(md.startsWith('# 如何理解大模型推理优化'));
  assert.match(md, /https:\/\/www\.bilibili\.com\/video\/BV1xx411c7mD/);
  assert.match(md, /2026-09-23 11:08:00/);
  assert.match(md, /12 分 15 秒/);
  assert.match(md, /`qwen3-asr-flash`/);
  assert.match(md, /中文/);
});

await test('含全文与分段两个章节', () => {
  const md = buildMarkdown(session, settings);
  assert.match(md, /^## 全文$/m);
  assert.match(md, /^## 分段（含时间戳）$/m);
});

await test('分段带时间戳，失败的片段有显式标注', () => {
  const md = buildMarkdown(session, settings);
  assert.match(md, /\*\*\[00:00:00\]\*\* 大家好/);
  assert.match(md, /\*\*\[00:01:00\]\*\* 第一部分/);
  assert.match(md, /00:02:00 — 00:03:00.*识别失败.*请求超时/);
  assert.match(md, /无语音内容/);
  assert.match(md, /共有 1 个片段识别失败/);
});

await test('识别中（pending）的片段不进入导出结果', () => {
  const withPending = {
    ...session,
    segments: [...session.segments, { index: 4, startSec: 240, endSec: 300, status: 'pending', text: '' }],
  };
  const md = buildMarkdown(withPending, settings);
  assert.doesNotMatch(md, /00:04:00/, 'pending 片段不应出现');
});

await test('已完成的空片段也计入分段数（只有 pending 被排除）', () => {
  const md = buildMarkdown(session, settings);
  assert.match(md, /\*\*分片数量\*\*：4 段/);
});

await test('中文时长描述带单位分隔', () => {
  const md = buildMarkdown(session, settings);
  assert.match(md, /\*\*音频时长\*\*：12 分 15 秒/);
});

await test('没有内容时给出明确说明而不报错', () => {
  const md = buildMarkdown({ ...session, segments: [] }, settings);
  assert.match(md, /未捕获到任何音频内容/);
});

await test('纯文本导出只包含正文', () => {
  const text = buildPlainText(session);
  assert.ok(text.includes('大家好'));
  assert.ok(!text.includes('#'));
  assert.ok(!text.includes('请求超时'));
});

await test('Markdown 里的特殊字符不被转义破坏', () => {
  const tricky = {
    ...session,
    segments: [{ index: 0, startSec: 0, endSec: 10, status: 'done', text: '他说 <b>加粗</b> 和 *星号* 与 | 竖线' }],
  };
  const md = buildMarkdown(tricky, settings);
  assert.match(md, /<b>加粗<\/b>/);
  assert.match(md, /\*星号\*/);
});

/* -------------------------------------------------------- 格式化与文件名 */

console.log('\n格式化');

await test('时间格式化', () => {
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(75), '01:15');
  assert.equal(formatClock(3723), '01:02:03');
  assert.equal(formatTimestamp(3723), '01:02:03');
  assert.equal(formatTimestamp(9), '00:00:09');
});

await test('文件名清洗掉非法字符', () => {
  assert.equal(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.equal(sanitizeFilename('   '), 'transcript');
  assert.equal(sanitizeFilename('', '兜底'), '兜底');
  assert.ok(sanitizeFilename('あ'.repeat(300)).length <= 120);
});

await test('文件名模板占位符替换', () => {
  const name = buildFilename('{title}-{date}', session);
  assert.equal(name, '如何理解大模型推理优化-20260923.md');
});

await test('未知占位符原样保留', () => {
  assert.equal(buildFilename('{title}-{unknown}', session), '如何理解大模型推理优化-{unknown}.md');
});

await test('模板为空时使用默认值', () => {
  assert.match(buildFilename('', session), /\.md$/);
});

/* -------------------------------------------------------- 翻译与生词提取 */

console.log('\n翻译与生词提取');

const translateSettings = {
  ...settings,
  translateEnabled: true,
  translateModel: 'qwen-plus',
  translateTarget: '中文',
  vocabMode: 'hard',
  vocabLevel: 'cet6',
  vocabPerSegment: 6,
  phoneticStyle: 'us',
};

await test('默认设置下翻译真的是开着的', () => {
  // 这条守着一个很隐蔽的坑：默认音频语言如果写成 'zh'，就会和默认译文语言
  // 「中文」撞在一起，shouldTranslate() 恒返回 false —— 设置页里「逐段翻译」
  // 明明勾着，实际一个分片都不翻译，而界面上没有任何解释。
  assert.equal(DEFAULT_SETTINGS.language, '', '音频语言默认应为自动检测');
  assert.equal(DEFAULT_SETTINGS.translateEnabled, true);
  assert.equal(DEFAULT_SETTINGS.translateTarget, '中文');
  assert.equal(shouldTranslate(DEFAULT_SETTINGS), true, '默认配置下必须会翻译');
});

await test('只有用户显式指定了与译文相同的语言才跳过', () => {
  // 自动跳过本身是对的（中文视频配中文译文没意义），但前提是用户真的指定过，
  // 不能靠默认值撞出来
  assert.equal(shouldTranslate({ ...DEFAULT_SETTINGS, language: 'zh' }), false);
  assert.equal(shouldTranslate({ ...DEFAULT_SETTINGS, language: 'en' }), true);
});

await test('自动检测时不下发 language 参数，交给模型判断', async () => {
  // asr_options.language 如果传空字符串，DashScope 会当成非法值报 400，
  // 所以自动检测时这个字段必须整个省掉，而不是传 ''
  let captured = null;
  const restore = mockFetch(async (url, init) => {
    captured = { url, init };
    return jsonResponse({ choices: [{ message: { content: '' } }] });
  });

  try {
    await transcribe({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'sk-test' },
      wavBuffer: silentWav(0.5, 16000),
      sampleRate: 16000,
    });
  } finally {
    restore();
  }

  const body = JSON.parse(captured.init.body);
  assert.equal(body.asr_options.language, undefined, '自动检测时不应出现 language 字段');
  assert.equal(body.asr_options.enable_itn, true, '其它选项仍要正常下发');
});

await test('原文语言与译文语言相同时自动跳过', () => {
  assert.equal(shouldTranslate({ ...translateSettings, language: 'en' }), true);
  assert.equal(shouldTranslate({ ...translateSettings, language: 'zh' }), false);
  assert.equal(shouldTranslate({ ...translateSettings, language: 'zh', translateTarget: '繁體中文' }), true);
  assert.equal(shouldTranslate({ ...translateSettings, language: 'ja', translateTarget: '日本語' }), false);
  assert.equal(shouldTranslate({ ...translateSettings, language: '' }), true, '自动检测时一律翻译');
  assert.equal(shouldTranslate({ ...translateSettings, translateEnabled: false }), false);
  assert.equal(shouldTranslate({ ...translateSettings, translateTarget: '' }), false);
});

await test('能从各种包裹里挖出 JSON', () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonObject('好的，结果如下：\n{"a":1}\n以上。'), { a: 1 });
  assert.deepEqual(extractJsonObject('{"a":{"b":2}}'), { a: { b: 2 } });
});

await test('花括号出现在字符串里也不影响配对', () => {
  assert.deepEqual(extractJsonObject('{"a":"}{"}'), { a: '}{' });
  assert.deepEqual(extractJsonObject('{"a":"x\\\\"}'), { a: 'x\\' });
});

await test('没有 JSON 时返回 null', () => {
  assert.equal(extractJsonObject('完全没有 JSON 的一段话'), null);
  assert.equal(extractJsonObject(''), null);
  assert.equal(extractJsonObject(null), null);
  assert.equal(extractJsonObject(undefined), null);
});

await test('正常返回时解析出译文和生词', () => {
  const raw = JSON.stringify({
    translation: '大家好，欢迎来到本期节目。',
    vocabulary: [
      { word: 'ubiquitous', ipa: '/juːˈbɪkwɪtəs/', pos: 'adj.', meaning: '无处不在的' },
    ],
  });

  const result = parseTranslationResult(raw, 6);
  assert.equal(result.translation, '大家好，欢迎来到本期节目。');
  assert.equal(result.vocabulary.length, 1);
  assert.equal(result.vocabulary[0].word, 'ubiquitous');
  assert.equal(result.degraded, false);
});

await test('模型没按 JSON 返回时退化成纯译文而不是报错', () => {
  const result = parseTranslationResult('大家好，欢迎来到本期节目。', 6);
  assert.equal(result.translation, '大家好，欢迎来到本期节目。');
  assert.deepEqual(result.vocabulary, []);
  assert.equal(result.degraded, true, '要标记出「没拿到结构化结果」');
});

await test('译文里的引号不会破坏 JSON 解析', () => {
  const raw = JSON.stringify({ translation: '他说"你好"。', vocabulary: [] });
  assert.equal(parseTranslationResult(raw, 6).translation, '他说"你好"。');
});

await test('译文保留段落结构，不被压成一行', () => {
  // 提示词里明确要求 translation「保留原文的段落结构」，解析阶段不能把它丢掉
  const raw = JSON.stringify({
    translation: '第一段讲了背景。\n\n第二段讲了方法。\n\n第三段是结论。',
    vocabulary: [],
  });

  assert.equal(
    parseTranslationResult(raw, 6).translation,
    '第一段讲了背景。\n\n第二段讲了方法。\n\n第三段是结论。',
  );
});

await test('译文的空行和行首尾空白被归一化', () => {
  const raw = JSON.stringify({
    translation: '  第一段。  \n\n\n\n   第二段。   \n\n',
    vocabulary: [],
  });

  // 连续空行压成一个段落分隔，行首尾空白清掉，首尾空行去掉
  assert.equal(parseTranslationResult(raw, 6).translation, '第一段。\n\n第二段。');
});

await test('译文里合法的单星号不被删掉', () => {
  // cleanField 那种「删掉所有 *」会把算式里的乘号一起删了，所以译文只剥成对装饰
  const raw = JSON.stringify({
    translation: '算下来是 3 * 4 = 12，重点是 **效率**。',
    vocabulary: [],
  });

  assert.equal(parseTranslationResult(raw, 6).translation, '算下来是 3 * 4 = 12，重点是 效率。');
});

await test('降级成纯译文时也保留段落', () => {
  // 模型没按 JSON 返回时走兜底分支，多段落同样不该被压平
  const result = parseTranslationResult('第一段。\n\n第二段。', 6);
  assert.equal(result.degraded, true);
  assert.equal(result.translation, '第一段。\n\n第二段。');
});

await test('生词去重、丢弃垃圾项、剥掉 Markdown 装饰', () => {
  const list = normalizeVocabulary(
    [
      { word: '**ubiquitous**', ipa: '/a/', meaning: '无处不在的' },
      { word: 'ubiquitous', ipa: '/b/', meaning: '重复项，应被丢掉' },
      { word: '`leverage`', phonetic: '/ˈlevərɪdʒ/', meaning: '利用' },
      { word: '', meaning: '没有单词' },
      { word: 'orphan' }, // 只有词没有释义 —— 这类噪音要丢掉
      null,
      'not an object',
      { term: 'throughput', definition: '吞吐量' },
    ],
    6,
  );

  assert.equal(list.length, 3);
  assert.deepEqual(
    list.map((item) => item.word),
    ['ubiquitous', 'leverage', 'throughput'],
  );
  assert.equal(list[0].ipa, '/a/', '同名去重应保留第一次出现的');
});

await test('生词数量被上限截断', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ word: `word${i}`, meaning: `释义${i}` }));
  assert.equal(normalizeVocabulary(many, 6).length, 6);
  assert.equal(normalizeVocabulary(many, 0).length, 0, '上限为 0 时不应返回任何词');
  assert.deepEqual(normalizeVocabulary('不是数组', 6), []);
});

await test('翻译请求走文本接口，并带上 json_object 与字段约定', async () => {
  let captured = null;
  const restore = mockFetch(async (url, init) => {
    captured = { url, init };
    return jsonResponse({
      choices: [{ message: { content: JSON.stringify({ translation: '大家好。', vocabulary: [] }) } }],
    });
  });

  let result;
  try {
    result = await translateSegment({
      settings: translateSettings,
      text: 'Hello everyone, welcome to the show.',
      previousText: 'This is the intro.',
    });
  } finally {
    restore();
  }

  assert.equal(result.translation, '大家好。');
  assert.equal(captured.url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');

  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'qwen-plus');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].role, 'user');

  // DashScope 要求消息里出现 "JSON" 字样，否则 json_object 直接 400
  const allText = body.messages.map((m) => m.content).join('\n');
  assert.match(allText, /JSON/, '提示词里必须出现 "JSON" 字样');
  assert.match(allText, /"translation"/, '字段名要写死在提示里');
  assert.match(allText, /"vocabulary"/);
  assert.match(allText, /"ipa"/);
  assert.match(allText, /中文/, '目标语言要出现在提示里');

  // 上文只用于理解语境，且必须明确禁止从里面选词
  assert.match(body.messages[1].content, /This is the intro\./);
  assert.match(body.messages[1].content, /不要翻译也不要从里面选生词/);
  assert.match(body.messages[1].content, /Hello everyone, welcome to the show\./);
});

await test('没开生词提取时提示词要求返回空数组', async () => {
  let captured = null;
  const restore = mockFetch(async (url, init) => {
    captured = { url, init };
    return jsonResponse({ choices: [{ message: { content: '{"translation":"大家好。","vocabulary":[]}' } }] });
  });

  try {
    await translateSegment({ settings: { ...translateSettings, vocabMode: 'off' }, text: 'Hello.' });
  } finally {
    restore();
  }

  const prompt = JSON.parse(captured.init.body).messages[0].content;
  assert.match(prompt, /vocabulary 字段固定返回空数组/);
  assert.doesNotMatch(prompt, /"ipa"/, '不要提取生词时就不该出现音标字段约定');
});

await test('提示词里的 JSON 示例本身必须是合法的', async () => {
  // 这条守着一个真实踩过的坑：示例里漏掉 "vocabulary" 键和方括号时，
  // 结构是坏的，模型有概率就真的不返回词条了。提示词里的示例必须是合法 JSON。
  for (const vocabMode of ['hard', 'all', 'off']) {
    let captured = null;
    const restore = mockFetch(async (url, init) => {
      captured = { url, init };
      return jsonResponse({ choices: [{ message: { content: '{"translation":"x","vocabulary":[]}' } }] });
    });

    try {
      await translateSegment({ settings: { ...translateSettings, vocabMode }, text: 'Hello.' });
    } finally {
      restore();
    }

    const prompt = JSON.parse(captured.init.body).messages[0].content;
    const example = extractJsonObject(prompt);

    assert.ok(example, `vocabMode=${vocabMode} 时提示词里没有可解析的 JSON 示例`);
    assert.ok('translation' in example, `vocabMode=${vocabMode} 的示例缺少 translation 字段`);
    assert.ok('vocabulary' in example, `vocabMode=${vocabMode} 的示例缺少 vocabulary 字段`);
    assert.ok(Array.isArray(example.vocabulary), `vocabMode=${vocabMode} 的 vocabulary 必须是数组`);

    if (vocabMode !== 'off') {
      assert.equal(example.vocabulary.length, 1);
      assert.ok('ipa' in example.vocabulary[0], '生词示例里要有音标字段');
    } else {
      assert.equal(example.vocabulary.length, 0);
    }
  }
});

await test('音标风格会写进提示词', async () => {
  let captured = null;
  const restore = mockFetch(async (url, init) => {
    captured = { url, init };
    return jsonResponse({ choices: [{ message: { content: '{"translation":"x","vocabulary":[]}' } }] });
  });

  try {
    await translateSegment({ settings: { ...translateSettings, phoneticStyle: 'both' }, text: 'Hello.' });
  } finally {
    restore();
  }

  assert.match(JSON.parse(captured.init.body).messages[0].content, /英式和美式音标/);
});

await test('翻译失败时给出针对文本模型的中文提示', async () => {
  const restore = mockFetch(async () => jsonResponse({ error: { message: 'Model not exist.' } }, 400));

  let error = null;
  try {
    await translateSegment({ settings: translateSettings, text: 'Hello.' });
  } catch (err) {
    error = err;
  } finally {
    restore();
  }

  assert.ok(error);
  assert.match(error.message, /翻译模型不可用/);
});

await test('翻译请求失败会重试', async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ message: 'busy' }, 503);
    return jsonResponse({ choices: [{ message: { content: '{"translation":"第二次成功","vocabulary":[]}' } }] });
  });

  let result;
  try {
    result = await translateSegment({ settings: translateSettings, text: 'Hello.' });
  } finally {
    restore();
  }

  assert.equal(result.translation, '第二次成功');
  assert.equal(calls, 2);
});

/* -------------------------------------------------------- 双语 Markdown */

console.log('\n双语 Markdown');

const bilingualSession = {
  ...session,
  segments: [
    {
      index: 0,
      startSec: 0,
      endSec: 60,
      status: 'done',
      text: 'Hello everyone, welcome to the show.',
      translateStatus: 'done',
      translation: '大家好，欢迎来到本期节目。',
      vocab: [{ word: 'ubiquitous', ipa: '/juːˈbɪkwɪtəs/', pos: 'adj.', meaning: '无处不在的' }],
    },
    {
      index: 1,
      startSec: 60,
      endSec: 120,
      status: 'done',
      text: 'Second part starts here.',
      translateStatus: 'done',
      translation: '第二部分从这里开始。',
      vocab: [],
    },
  ],
};

await test('识别到译文时切换成双语版', () => {
  assert.equal(hasTranslation(bilingualSession), true);
  assert.equal(hasTranslation(session), false);
});

await test('双语版包含四个章节', () => {
  const md = buildMarkdown(bilingualSession, translateSettings);
  assert.match(md, /^## 全文$/m);
  assert.match(md, /^## 译文$/m);
  assert.match(md, /^## 逐段对照$/m);
  assert.match(md, /^## 生词汇总$/m);
});

await test('逐段对照里原文和译文成对出现', () => {
  const md = buildMarkdown(bilingualSession, translateSettings);
  assert.match(md, /\*\*\[00:00:00\]\*\*/);
  assert.match(md, /\*\*\[00:01:00\]\*\*/);
  assert.match(md, /\*\*原文\*\*/);
  assert.match(md, /> Hello everyone, welcome to the show\./);
  assert.match(md, /\*\*译文\*\*/);
  assert.match(md, /大家好，欢迎来到本期节目。/);
  assert.match(md, /- `ubiquitous` \/juːˈbɪkwɪtəs\/ \*adj\.\* 无处不在的/);
});

await test('多段落译文在 Markdown 里保持分段', () => {
  const multi = {
    ...bilingualSession,
    segments: [
      {
        ...bilingualSession.segments[0],
        translateStatus: 'done',
        translation: '第一段讲了背景。\n\n第二段是结论。',
        vocab: [],
      },
    ],
  };

  const md = buildMarkdown(multi, translateSettings);

  // 逐段对照区：译文原样插入，换行即是 Markdown 的段落分隔
  assert.match(md, /第一段讲了背景。\n\n第二段是结论。/);

  // 「译文」章节也要按段落输出，而不是被 toParagraphs 合并成一行
  const section = md.split('## 译文')[1].split('## 逐段对照')[0];
  assert.match(section, /第一段讲了背景。\n\n第二段是结论。/);
});

await test('元信息里带上翻译模型和译文语言', () => {
  const md = buildMarkdown(bilingualSession, translateSettings);
  assert.match(md, /\*\*翻译模型\*\*：`qwen-plus` → 中文/);
});

await test('译文独立成章，且和原文一样按段落合并', () => {
  const md = buildMarkdown(bilingualSession, translateSettings);
  const translationSection = md.split('## 译文')[1].split('## 逐段对照')[0];
  assert.match(translationSection, /大家好，欢迎来到本期节目。/);
  assert.match(translationSection, /第二部分从这里开始。/);
  assert.doesNotMatch(translationSection, /Hello everyone/, '译文区不该混进原文');
});

await test('生词表去掉重复词，并带首次出现的时间戳', () => {
  const session2 = {
    ...bilingualSession,
    segments: [
      { ...bilingualSession.segments[0], vocab: [{ word: 'Ubiquitous', ipa: '/a/', pos: 'adj.', meaning: '第一次' }] },
      { ...bilingualSession.segments[1], vocab: [{ word: 'ubiquitous', ipa: '/b/', pos: 'adj.', meaning: '第二次' }] },
    ],
  };

  const collected = collectVocabulary(session2);
  assert.equal(collected.length, 1, '同一个词只应保留一次');
  assert.equal(collected[0].meaning, '第一次');
  assert.equal(collected[0].startSec, 0);
  assert.match(buildMarkdown(session2, translateSettings), /\| `Ubiquitous` \| \/a\/ \| adj\. \| 第一次 \| \[00:00:00\] \|/);
});

await test('表格里的竖线会被转义，不会破坏列结构', () => {
  const session2 = {
    ...bilingualSession,
    segments: [
      { ...bilingualSession.segments[0], vocab: [{ word: 'a|b', ipa: '/x/', pos: 'n.', meaning: '含|竖线的释义' }] },
    ],
  };
  const md = buildMarkdown(session2, translateSettings);
  assert.match(md, /`a\\\|b`/);
  assert.match(md, /含\\\|竖线的释义/);
});

await test('翻译失败的片段在对照区里被标出来', () => {
  const session2 = {
    ...bilingualSession,
    segments: [
      { ...bilingualSession.segments[0], translateStatus: 'error', translateError: '额度已用尽', translation: '' },
    ],
  };
  const md = buildMarkdown(session2, translateSettings);
  assert.match(md, /_翻译失败：额度已用尽_/);
});

await test('没开翻译时保持原来的单语格式', () => {
  const md = buildMarkdown(session, { model: 'qwen3-asr-flash', language: 'zh' });
  assert.match(md, /^## 分段（含时间戳）$/m);
  assert.doesNotMatch(md, /^## 逐段对照$/m);
  assert.doesNotMatch(md, /^## 生词汇总$/m);
  assert.doesNotMatch(md, /翻译模型/);
});

await test('纯文本导出在双语会话下原文译文交替', () => {
  const text = buildPlainText(bilingualSession);
  assert.match(text, /Hello everyone, welcome to the show\.\n大家好，欢迎来到本期节目。/);
  // 关掉翻译开关时只留原文
  assert.doesNotMatch(buildPlainText(bilingualSession, { includeTranslation: false }), /大家好/);
});

/* ------------------------------------------------------------ 打包完整性 */

console.log('\n打包完整性');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const allFiles = walk(ROOT);
const relative = (file) => relative_(ROOT, file).replace(/\\/g, '/');
const exists = (relativePath) => existsSync(join(ROOT, relativePath));

await test('manifest.json 合法且引用的文件都存在', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

  assert.equal(manifest.manifest_version, 3);

  const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_page,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ];

  for (const path of referenced) {
    assert.ok(path, 'manifest 里有空路径');
    assert.ok(exists(path), `manifest 引用的文件不存在：${path}`);
  }
});

await test('所有 import 的相对路径都能解析', () => {
  const importPattern = /(?:^|\n)\s*import\s[^'"]*from\s*['"](\.[^'"]+)['"]/g;
  const problems = [];

  for (const file of allFiles.filter((f) => f.endsWith('.js'))) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const resolved = join(dirname(file), match[1]);
      if (!existsSync(resolved)) problems.push(`${relative(file)} -> ${match[1]}`);
    }
  }

  assert.deepEqual(problems, [], `解析失败的 import：\n    ${problems.join('\n    ')}`);
});

await test('HTML 里的本地资源路径都存在', () => {
  const problems = [];

  for (const file of allFiles.filter((f) => f.endsWith('.html'))) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const target = match[1];
      if (/^(https?:|data:|#|mailto:)/.test(target)) continue;
      if (!existsSync(join(dirname(file), target))) problems.push(`${relative(file)} -> ${target}`);
    }
  }

  assert.deepEqual(problems, [], `找不到的资源：\n    ${problems.join('\n    ')}`);
});

await test('代码里通过 getURL / executeScript 引用的路径都存在', () => {
  const patterns = [
    /chrome\.runtime\.getURL\(\s*['"]([^'"]+)['"]\s*\)/g,
    /files:\s*\[\s*['"]([^'"]+)['"]\s*\]/g,
  ];
  const problems = [];

  for (const file of allFiles.filter((f) => f.endsWith('.js'))) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        if (!exists(match[1])) problems.push(`${relative(file)} -> ${match[1]}`);
      }
    }
  }

  assert.deepEqual(problems, [], `找不到的文件：\n    ${problems.join('\n    ')}`);
});

await test('源码里没有混入控制字符', () => {
  const problems = [];

  for (const file of allFiles.filter((f) => /\.(js|mjs|html|css|json|md)$/.test(f))) {
    const buffer = readFileSync(file);
    for (let i = 0; i < buffer.length; i++) {
      const byte = buffer[i];
      if (byte < 9 || (byte > 13 && byte < 32) || byte === 127) {
        problems.push(`${relative(file)} 第 ${i} 字节 = 0x${byte.toString(16)}`);
        break;
      }
    }
  }

  assert.deepEqual(problems, [], `发现控制字符：\n    ${problems.join('\n    ')}`);
});

await test('offscreen 文档没有使用 chrome.storage（该文档只暴露 chrome.runtime）', () => {
  // Chrome 官方文档明确写着：runtime API 是 offscreen 文档唯一可用的扩展 API。
  // 一旦这里出现 chrome.storage，录制会在启动瞬间炸掉，而且报错信息很难对上号。
  const source = readFileSync(join(ROOT, 'offscreen.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  assert.ok(!/chrome\.storage/.test(source), 'offscreen.js 不能直接访问 chrome.storage');
  assert.ok(
    !/\b(getSettings|saveSettings)\s*\(/.test(source),
    'offscreen.js 不能调用读写存储的 getSettings / saveSettings，设置应由 SW 传进来',
  );

  const used = [...new Set([...source.matchAll(/chrome\.(\w+)/g)].map((m) => m[1]))];
  assert.deepEqual(used, ['runtime'], `offscreen 里只允许用 chrome.runtime，实际用了：${used.join(', ')}`);
});

await test('offscreen 只通过 chrome.runtime 消息与 SW 通信', () => {
  const source = readFileSync(join(ROOT, 'offscreen.js'), 'utf8');
  // 落盘必须走 SESSION_UPDATE，由 SW 写入
  assert.match(source, /SESSION_UPDATE/, 'offscreen 必须把会话状态发给 SW 保存');
  const background = readFileSync(join(ROOT, 'background.js'), 'utf8');
  assert.match(background, /SESSION_UPDATE:\s*handleSessionUpdate/, 'SW 必须处理 SESSION_UPDATE');
});

await test('各个页面发出的消息，Service Worker 都有对应处理', () => {
  const background = readFileSync(join(ROOT, 'background.js'), 'utf8');
  const routesBlock = background.match(/const routes = \{([\s\S]*?)\n\};/);
  assert.ok(routesBlock, '没能解析出 background.js 里的 routes');

  const handled = new Set(
    [...routesBlock[1].matchAll(/^\s*([A-Z_]+):/gm)].map((m) => m[1]),
  );
  assert.ok(handled.size >= 4, `解析出的路由太少：${[...handled].join(', ')}`);

  const problems = [];
  for (const file of ['offscreen.js', 'popup/popup.js', 'content/overlay.js']) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    // 同时覆盖 chrome.runtime.sendMessage({...}) 和 popup 里的 send({...}) 包装
    for (const match of source.matchAll(/(?:sendMessage|\bsend)\(\s*\{[^}]*type:\s*'([A-Z_]+)'/g)) {
      if (!handled.has(match[1])) problems.push(`${file} 发出 ${match[1]}，但 SW 的 routes 里没有`);
    }
  }

  assert.deepEqual(problems, [], `消息断链：\n    ${problems.join('\n    ')}`);
});

await test('offscreen 的状态写回和下载都经 SW', () => {
  const source = stripComments(readFileSync(join(ROOT, 'offscreen.js'), 'utf8'));

  assert.match(source, /SESSION_UPDATE/, '会话状态必须发给 SW 保存');
  assert.match(source, /DOWNLOAD_MARKDOWN/, '自动下载必须交给 SW');
  // 不在隐藏文档里点 <a download>：没有用户手势，失败也没痕迹
  assert.ok(!/<a\s[^>]*download/i.test(source), '不应在 offscreen 里用 anchor 触发下载');
  // blob URL 必须在这里建（SW 里没有 URL.createObjectURL），但下载动作由 SW 执行
  assert.match(source, /createObjectURL/, 'blob URL 应由 offscreen 创建');
  assert.match(source, /revokeObjectURL/, 'blob URL 用完要回收');
});

/* ------------------------------------------------ 启动窗口与下载 URL 策略 */

console.log('\n启动窗口与下载 URL');

await test('startCapture 用 starting 覆盖启动窗口', () => {
  const source = stripComments(readFileSync(join(ROOT, 'offscreen.js'), 'utf8'));

  const startingAt = source.indexOf("status: 'starting'");
  const captureAt = source.indexOf('capture = { stream, ctx');
  const recordingAt = source.indexOf("session.status = 'recording'");

  assert.ok(startingAt > -1, '会话必须先以 starting 落盘');
  assert.ok(captureAt > -1, '找不到 capture 赋值语句');
  assert.ok(recordingAt > -1, 'capture 就位后要改口成 recording');

  // 顺序必须是：starting 落盘 → capture 就位 → recording 落盘。
  // 反过来的话，落在启动窗口里的状态查询会把刚开始的录制误判成中断。
  assert.ok(startingAt < captureAt, 'starting 必须在 capture 赋值之前');
  assert.ok(captureAt < recordingAt, 'recording 必须在 capture 赋值之后');
});

await test('starting 窗口里拒绝第二次启动', () => {
  const source = stripComments(readFileSync(join(ROOT, 'offscreen.js'), 'utf8'));
  // 这个窗口里 capture 还是 null，原来的 stopCapture 判断拦不住重入
  assert.match(source, /session\.status === 'starting'\)[\s\S]{0,80}throw/, '重复启动要被拦下');
});

await test('SW 用 alive 判断会话是否还活着，不误判成中断', () => {
  const background = stripComments(readFileSync(join(ROOT, 'background.js'), 'utf8'));
  const offscreen = stripComments(readFileSync(join(ROOT, 'offscreen.js'), 'utf8'));

  // offscreen 要能区分两种「没有 capture 但还活着」的中间态
  assert.match(offscreen, /const starting =/, '要能识别 starting');
  assert.match(offscreen, /const finishing =/, '要能识别 finishing');
  assert.match(
    offscreen,
    /const alive = .*capture.*starting.*finishing/,
    'alive 必须同时覆盖 capturing / starting / finishing',
  );
  assert.match(offscreen, /^\s*alive,$/m, 'alive 要出现在状态回报里');

  // 对账必须基于 alive —— 只看 capturing 的话，收尾期间每次停止都会闪出
  // 「浏览器回收了后台页面」的错误
  const block = background.match(/async function reconcileSession\(session, offscreen\)[\s\S]*?\n\}/);
  assert.ok(block, '找不到 reconcileSession');
  assert.match(block[0], /offscreen\?\.alive/, 'reconcileSession 必须用 alive');
  assert.doesNotMatch(block[0], /offscreen\?\.capturing/, '不该退回到只看 capturing');
});

await test('收尾期间不允许清空会话', () => {
  const background = stripComments(readFileSync(join(ROOT, 'background.js'), 'utf8'));
  const block = background.match(/async function handleClear\(\)[\s\S]*?\n\}/);
  assert.ok(block, '找不到 handleClear');
  assert.match(block[0], /offscreen\?\.alive/, '清空也要按 alive 拦');
});

await test('offscreen 会回报 starting', () => {
  const source = stripComments(readFileSync(join(ROOT, 'offscreen.js'), 'utf8'));
  assert.match(source, /^\s*starting,$/m, 'OFFSCREEN_STATUS 必须回报 starting');
});

await test('popup 与悬浮条都认识 starting 状态', () => {
  const popup = stripComments(readFileSync(join(ROOT, 'popup/popup.js'), 'utf8'));
  const overlay = stripComments(readFileSync(join(ROOT, 'content/overlay.js'), 'utf8'));

  assert.match(popup, /status === 'starting'/);
  assert.match(popup, /正在启动/, 'popup 要有启动中的文案');
  assert.match(overlay, /status === 'starting'/);
  assert.match(overlay, /正在启动/, '悬浮条要有启动中的文案');
});

await test('popup 的译文样式保留换行', () => {
  // 译文现在是多段的，样式里少了 pre-wrap 就会在界面上被压成一行
  const css = readFileSync(join(ROOT, 'popup/popup.css'), 'utf8');
  const block = css.match(/\.seg-trans\s*\{[^}]*\}/);
  assert.ok(block, '找不到 .seg-trans 规则');
  assert.match(block[0], /white-space:\s*pre-wrap/, '译文必须保留换行');
});

await test('自动下载优先用 blob URL，data URL 只作兜底', () => {
  const background = stripComments(readFileSync(join(ROOT, 'background.js'), 'utf8'));
  const offscreen = stripComments(readFileSync(join(ROOT, 'offscreen.js'), 'utf8'));

  // offscreen 把 blob URL 和文本一起发过去
  assert.match(offscreen, /type: 'DOWNLOAD_MARKDOWN'/);
  assert.match(offscreen, /url: blobUrl/, '要带上 blob URL');
  assert.match(offscreen, /markdown,/, '要带上文本作为兜底');

  // SW 先试 blob URL，失败才退到 data URL
  const urlFirst = background.indexOf('if (message.url)');
  const dataUrl = background.indexOf('data:text/markdown');
  assert.ok(urlFirst > -1, 'SW 应当优先尝试传入的 URL');
  assert.ok(dataUrl > -1, 'SW 应当保留 data URL 兜底');
  assert.ok(urlFirst < dataUrl, 'blob URL 必须先于 data URL 尝试');
});

await test('自定义地址在地域切换时不会被清空', () => {
  const source = stripComments(readFileSync(join(ROOT, 'options/options.js'), 'utf8'));
  const block = source.match(/function syncRegionUi\(\)[\s\S]*?\n\}/);

  assert.ok(block, '找不到 syncRegionUi');
  // readForm() 从 DOM 读值，这里一旦清空输入框，紧接着的 persist() 就会把
  // 空值写回存储，用户切回来时地址已经没了
  assert.doesNotMatch(
    block[0],
    /customBaseUrl\.value\s*=/,
    'syncRegionUi 不该改写 customBaseUrl 的值',
  );
});

await test('manifest 只申请了必要的权限', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const allowed = ['tabCapture', 'offscreen', 'storage', 'activeTab', 'scripting', 'downloads'];
  const unexpected = manifest.permissions.filter((p) => !allowed.includes(p));
  assert.deepEqual(unexpected, [], `多出来的权限：${unexpected.join(', ')}`);
  assert.ok(!manifest.permissions.includes('tabs'), '不该申请 tabs 权限，activeTab 足够');
  assert.ok(
    !manifest.host_permissions.includes('<all_urls>'),
    '不该申请 <all_urls>，只需要 DashScope 的域名',
  );
});

/* --------------------------------------------------------------- 结果 */

console.log(`\n${'─'.repeat(46)}`);
if (failures.length) {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项\n`);
  for (const { name, err } of failures) {
    console.log(`失败：${name}`);
    console.log(`  ${err.stack?.split('\n').slice(0, 4).join('\n  ')}\n`);
  }
  process.exit(1);
}

console.log(`全部 ${passed} 项测试通过`);
