/**
 * 翻译与生词提取。
 *
 * 走 DashScope 的 OpenAI 兼容文本接口（和语音识别同一个域名，权限不变），
 * 每个识别分片单独调一次，所以译文和原文天然是一一对应的。
 *
 * 关于 JSON 输出，DashScope 有两个容易踩的点：
 *   1. `response_format: {type:'json_object'}` 要求消息里**必须出现 "JSON" 这个词**，
 *      否则直接返回 400。提示词里那句「必须只返回一个 JSON 对象」就是在满足它。
 *   2. 它只保证 JSON 语法合法，**不保证字段名**。所以结构必须在提示词里写死，
 *      并且解析时要做兜底（模型偶尔还是会裹一层 Markdown 代码块或者多写几句）。
 */

import { ENGINES, resolveBaseUrl } from './settings.js';
import { postJson, extractErrorMessage } from './http.js';

/**
 * 各语言在设置页里的常见写法，用来判断「原文语言」和「译文语言」是否是同一种。
 * 相同就没必要翻译了（比如中文视频配中文译文）。
 */
const LANGUAGE_ALIASES = {
  zh: ['中文', '简体中文', '汉语', '中英对照', 'chinese', 'zh'],
  en: ['英文', '英语', 'english', 'en'],
  yue: ['粤语', '广东话', 'cantonese'],
  ja: ['日文', '日语', '日本語', 'japanese', 'ja'],
  ko: ['韩文', '韩语', '한국어', 'korean', 'ko'],
  de: ['德文', '德语', 'german'],
  fr: ['法文', '法语', 'french'],
  ru: ['俄文', '俄语', 'russian'],
  es: ['西班牙文', '西班牙语', 'spanish'],
  pt: ['葡萄牙文', '葡萄牙语', 'portuguese'],
  it: ['意大利文', '意大利语', 'italian'],
};

/** 判断这次录制到底要不要翻译。 */
export function shouldTranslate(settings) {
  if (!settings.translateEnabled) return false;

  const target = (settings.translateTarget || '').trim();
  if (!target) return false;

  // 语言设为「自动检测」时无从判断，一律翻译
  if (!settings.language) return true;

  const aliases = LANGUAGE_ALIASES[settings.language] || [];
  return !aliases.includes(target.trim().toLowerCase());
}

/** 生词筛选的难度基线，对应提示词里的一句话。 */
const VOCAB_LEVEL_RULES = {
  cet4: '超过大学英语四级（CET-4）难度的词和固定搭配，常见基础词（如 make、good、thing）一律不要',
  cet6: '超过大学英语六级（CET-6）难度的词和固定搭配，中等难度的词也不要',
  ielts: '雅思、托福级别的学术词汇、地道搭配和习语',
};

const PHONETIC_RULES = {
  us: '美式音标，用国际音标符号，两端带斜杠，例如 /juːˈbɪkwɪtəs/',
  uk: '英式音标，用国际音标符号，两端带斜杠，例如 /juːˈbɪkwɪtəs/',
  both: '同时给出英式和美式音标，写成「英 /ˈ.../ 美 /ˈ.../」的形式',
};

function vocabRule(settings) {
  if (settings.vocabMode === 'off') return null;
  if (settings.vocabMode === 'all') {
    return '所有值得记的实词、固定搭配和地道表达，不按难度筛选，但跳过 the / is / and 这类功能词';
  }
  return VOCAB_LEVEL_RULES[settings.vocabLevel] || VOCAB_LEVEL_RULES.cet6;
}

function buildSystemPrompt(settings) {
  const target = settings.translateTarget || '中文';
  const rule = vocabRule(settings);
  const maxWords = Math.max(0, Number(settings.vocabPerSegment) || 0);
  const ipaRule = PHONETIC_RULES[settings.phoneticStyle] || PHONETIC_RULES.us;

  const vocabSection = rule
    ? `2. **生词提取**：挑出这段文本里符合下面条件的词或短语，给出音标和释义。
   筛选标准：${rule}。
   最多 ${maxWords} 个，按重要性从高到低排列。`
    : `2. **生词提取**：本次不需要提取生词，vocabulary 字段固定返回空数组 []。`;

  const vocabNotes = rule
    ? `
- vocabulary 里的每个词都必须真实出现在【本段文本】里，不要从【上文】里选。
- 释义要贴合本句语境，同一个词在这段里是引申义就写引申义。
- 没有合适的词就返回空数组，不要硬凑。`
    : '';

  // 示例必须是一段**合法**的 JSON：字段名、数组括号都得在。
  // 之前这里漏掉了 "vocabulary" 键和方括号，模型有概率就真的不返回这个词条了。
  const schema = rule
    ? `{
  "translation": "整段译文，保留原文的段落结构",
  "vocabulary": [
    {
      "word": "单词或短语，保留它在原文里的形态",
      "ipa": "${ipaRule}",
      "pos": "词性缩写，如 n. / v. / adj. / adv. / phrase",
      "meaning": "在本文语境下的中文释义，不要罗列词典里的所有义项"
    }
  ]
}`
    : `{
  "translation": "整段译文，保留原文的段落结构",
  "vocabulary": []
}`;

  return `你是一位专业的英汉翻译与英语教学助手。用户给你的是语音识别得到的文本，可能有同音词、漏字、断句等错误。

你要完成两件事：

1. **翻译**：把整段文本翻译成自然流畅的${target}。结合语境理解说话人的真实意图，
   把明显的识别错误改对，但**不要添加原文没有的信息，也不要省略原文的内容**，
   不要输出译者注。

${vocabSection}

必须只返回一个 JSON 对象，不要输出任何 JSON 之外的内容，也不要用 Markdown 代码块包裹：

${schema}

另外几条硬性要求：
- 译文只写译文本身，不要把原文再抄一遍。${vocabNotes}`;
}

function buildUserPrompt({ text, previousText }) {
  const parts = [];
  if (previousText) {
    // 给一点上文帮助消解代词和承接关系，但要明确禁止从这里选词
    parts.push(`【上文，仅供理解语境，不要翻译也不要从里面选生词】\n${previousText.slice(-400)}`);
  }
  parts.push(`【本段文本，请翻译这一段】\n${text}`);
  return parts.join('\n\n');
}

/** 失败的翻译请求翻译成人话。 */
function describeError(status, payload) {
  const detail = extractErrorMessage(payload);

  switch (status) {
    case 401:
    case 403:
      return 'API Key 无效或没有该文本模型的权限，请检查设置页的「翻译模型」名称与地域是否匹配。';
    case 402:
      return '账户欠费或未开通百炼服务。';
    case 429:
      return '翻译请求触发限流或额度已用尽，稍后会自动重试。';
    case 400:
      if (/json/i.test(detail)) {
        return `该模型不支持 JSON 输出：${detail}。可以在设置页换一个翻译模型（推荐 qwen-plus）。`;
      }
      if (/model/i.test(detail)) {
        return `翻译模型不可用：${detail}。请到设置页确认模型名称。`;
      }
      return `请求参数有误：${detail || '请检查设置页的翻译配置。'}`;
    default:
      if (status >= 500) return `DashScope 服务端错误（HTTP ${status}），稍后会自动重试。`;
      return `翻译失败（HTTP ${status}）${detail ? '：' + detail : ''}`;
  }
}

/**
 * 从模型返回里挖出 JSON 对象。
 *
 * 正常情况下 response_format 已经保证了纯 JSON，但模型偶尔会裹一层
 * ```json 代码块，或者在前后多写一句话，所以这里逐级降级处理。
 */
export function extractJsonObject(raw) {
  if (!raw) return null;

  let text = String(raw).trim();

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  try {
    return JSON.parse(text);
  } catch {
    /* 继续往下扫 */
  }

  const start = text.indexOf('{');
  if (start === -1) return null;

  // 扫最外层的花括号，跳过字符串里的括号和转义字符
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

/** 去掉模型爱加的 Markdown 装饰，避免把 **word** 当成单词存下来。 */
function cleanField(value, maxLength = 200) {
  return String(value ?? '')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * 译文的清洗。**不能**用 cleanField —— 它会把所有空白（含换行）压成空格，
 * 而提示词里明确要求译文「保留原文的段落结构」，压平之后 markdown.js 的
 * toParagraphs 再也切不出段落。
 *
 * 这里只归一化行内空白和多余空行，单个空行代表的段落分隔原样保留。
 *
 * 另外只剥成对的 Markdown 装饰而不用 cleanField 那种「删掉所有 *」，是因为
 * 译文里可能出现合法的单星号（比如算式 3 * 4），一并删掉会破坏内容。
 */
export function cleanTranslation(value, maxLength = 20_000) {
  const lines = String(value ?? '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim());

  // 连续空行压成一个段落分隔（最多留一个空行）
  const kept = [];
  for (const line of lines) {
    if (!line && kept[kept.length - 1] === '') continue;
    kept.push(line);
  }

  return kept.join('\n').trim().slice(0, maxLength);
}

/**
 * 把 vocabulary 规整成可信的结构：过滤垃圾项、去重、截断。
 *
 * 只有单词没有释义的条目一律丢掉 —— 这个功能的价值就在释义上，
 * 光秃秃一个词显示出来只是噪音，也容易让模型用凑数的方式占满配额。
 */
export function normalizeVocabulary(list, max = 8) {
  if (!Array.isArray(list) || max <= 0) return [];

  const seen = new Set();
  const out = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;

    const word = cleanField(item.word ?? item.term ?? item.text, 60);
    const meaning = cleanField(item.meaning ?? item.definition ?? item.translation, 200);
    if (!word || !meaning) continue;

    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      word,
      ipa: cleanField(item.ipa ?? item.phonetic ?? item.pronunciation, 80),
      pos: cleanField(item.pos ?? item.partOfSpeech ?? '', 20),
      meaning,
    });

    if (out.length >= max) break;
  }

  return out;
}

/**
 * 解析模型的返回。解析不出来时不报错，而是退化成「整段就是译文、没有生词」——
 * 宁可丢掉生词，也不该让这一段的内容整个消失。
 */
export function parseTranslationResult(raw, maxVocab = 8) {
  const content = typeof raw === 'string' ? raw.trim() : '';
  const parsed = extractJsonObject(content);

  if (!parsed || typeof parsed !== 'object') {
    // 退化成纯译文时同样走 cleanTranslation，多段落的译文不该因为走了兜底
    // 分支就被压成一行
    return { translation: cleanTranslation(content), vocabulary: [], degraded: true };
  }

  return {
    translation: cleanTranslation(parsed.translation ?? parsed.译文 ?? parsed.text),
    vocabulary: normalizeVocabulary(parsed.vocabulary ?? parsed.生词 ?? parsed.words, maxVocab),
    degraded: false,
  };
}

/**
 * 翻译一个分片，返回 { translation, vocabulary }。
 *
 * @param {object} params
 * @param {object} params.settings
 * @param {string} params.text          本段识别原文
 * @param {string} [params.previousText] 上一段原文，仅用于帮助模型理解语境
 * @param {AbortSignal} [params.signal]
 */
export async function translateSegment({ settings, text, previousText = '', signal }) {
  const baseUrl = resolveBaseUrl(settings);
  // 文本模型统一走 OpenAI 兼容通道，和设置页里语音识别的「调用通道」无关
  const url = `${baseUrl}${ENGINES.openai.path}`;

  const body = {
    model: settings.translateModel,
    messages: [
      { role: 'system', content: buildSystemPrompt(settings) },
      { role: 'user', content: buildUserPrompt({ text, previousText }) },
    ],
    response_format: { type: 'json_object' },
    // 翻译是确定性任务，温度压低能明显减少自由发挥
    temperature: 0.2,
    stream: false,
  };

  const payload = await postJson({
    url,
    apiKey: settings.apiKey,
    body,
    signal,
    describe: describeError,
  });

  const content = payload?.choices?.[0]?.message?.content ?? '';
  return parseTranslationResult(content, settings.vocabPerSegment);
}

/** 「测试连接」用：拿一句短英文跑一遍完整链路，顺便验证 JSON 解析。 */
export async function testTranslation(settings) {
  const sample = 'The ubiquitous smartphone has quietly reshaped how we work.';
  return translateSegment({ settings, text: sample });
}
