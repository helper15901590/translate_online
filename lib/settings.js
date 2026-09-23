/**
 * 插件设置：默认值、读写、以及 DashScope 的地域/模型/语言常量。
 */

export const REGIONS = {
  cn: {
    label: '中国大陆（北京）',
    baseUrl: 'https://dashscope.aliyuncs.com',
    console: 'https://bailian.console.aliyun.com/',
  },
  intl: {
    label: '国际站（新加坡）',
    baseUrl: 'https://dashscope-intl.aliyuncs.com',
    console: 'https://modelstudio.console.alibabacloud.com/',
  },
  custom: {
    label: '自定义地址（专属 Workspace 域名）',
    baseUrl: '',
    console: '',
  },
};

/**
 * 两个调用通道：
 *  - openai：OpenAI 兼容接口 /compatible-mode/v1/chat/completions，文档最全
 *  - native：DashScope 原生同步接口 /api/v1/services/aigc/multimodal-generation/generation
 */
export const ENGINES = {
  openai: { label: 'OpenAI 兼容接口', path: '/compatible-mode/v1/chat/completions' },
  native: { label: 'DashScope 原生接口', path: '/api/v1/services/aigc/multimodal-generation/generation' },
};

export const LANGUAGES = [
  { value: '', label: '自动检测' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: '英文' },
  { value: 'yue', label: '粤语' },
  { value: 'ja', label: '日语' },
  { value: 'ko', label: '韩语' },
  { value: 'de', label: '德语' },
  { value: 'fr', label: '法语' },
  { value: 'ru', label: '俄语' },
  { value: 'es', label: '西班牙语' },
  { value: 'pt', label: '葡萄牙语' },
  { value: 'it', label: '意大利语' },
  { value: 'ar', label: '阿拉伯语' },
  { value: 'id', label: '印尼语' },
  { value: 'th', label: '泰语' },
  { value: 'vi', label: '越南语' },
  { value: 'tr', label: '土耳其语' },
  { value: 'hi', label: '印地语' },
  { value: 'ms', label: '马来语' },
  { value: 'nl', label: '荷兰语' },
  { value: 'pl', label: '波兰语' },
  { value: 'sv', label: '瑞典语' },
];

export const KNOWN_MODELS = [
  'qwen3-asr-flash',
  'qwen3-asr-flash-2025-09-08',
  'qwen-audio-asr',
  'qwen-audio-asr-latest',
];

/** 翻译用的文本模型。走同一个 OpenAI 兼容通道，只是换 model 名。 */
export const KNOWN_TRANSLATE_MODELS = [
  'qwen-plus',
  'qwen-flash',
  'qwen-max',
  'qwen-turbo',
  'qwen3-max',
  'qwen-long',
];

export const TARGET_LANGUAGES = [
  '中文',
  '繁體中文',
  'English',
  '日本語',
  '한국어',
  'Deutsch',
  'Français',
  'Русский',
  'Español',
];

export const VOCAB_MODES = [
  { value: 'hard', label: '只挑生词（按难度基线筛）' },
  { value: 'all', label: '所有值得记的词和搭配' },
  { value: 'off', label: '不提取生词' },
];

export const VOCAB_LEVELS = [
  { value: 'cet4', label: '大学英语四级（CET-4）以上' },
  { value: 'cet6', label: '大学英语六级（CET-6）以上' },
  { value: 'ielts', label: '雅思 / 托福级别' },
];

export const PHONETIC_STYLES = [
  { value: 'us', label: '美式音标' },
  { value: 'uk', label: '英式音标' },
  { value: 'both', label: '英式 + 美式' },
];

export const DEFAULT_SETTINGS = {
  apiKey: '',
  region: 'cn',
  /** 仅当 region === 'custom' 时使用 */
  customBaseUrl: '',
  engine: 'openai',
  model: 'qwen3-asr-flash',
  /**
   * 音频语言。空字符串 = 自动检测。
   *
   * 默认必须是自动检测，不能写死成 'zh'：它和默认译文语言「中文」撞在一起时
   * shouldTranslate() 会恒返回 false，「逐段翻译」明明默认开着却完全不干活，
   * 而界面上不会有任何提示。指定语言确实能让识别更准一点，所以设置页里
   * 仍然把它作为可选项摆在那儿。
   */
  language: '',
  /** 逆文本规整：把「二零二五年」转成「2025 年」 */
  enableItn: true,
  /** 每个识别分片的时长（秒）。音频会按这个长度切开逐片送识别。 */
  chunkSeconds: 60,
  /** 送给 ASR 的采样率。16k 足够，且能把体积压到最小。 */
  sampleRate: 16000,
  /** 转录时是否同时把音频放给扬声器（tabCapture 默认会让标签页静音） */
  monitor: true,
  /** 热词 / 上下文提示，帮助识别专有名词 */
  context: '',
  /** 识别完成后自动下载 .md */
  autoDownload: false,
  filenameTemplate: '{title}-{date}',
  /** 是否把上一段的识别结果作为上下文提示带给模型。默认关闭：开启后连贯性略好，
   *  但小概率让模型把提示内容也一并「听」出来，造成重复。 */
  carryContext: false,

  /* ---------------------------------------------------- 翻译与生词提取 */

  /** 逐段翻译 + 提取生词。关闭后只做语音识别。 */
  translateEnabled: true,
  /** 翻译用的文本模型（和语音识别模型是两个独立配置） */
  translateModel: 'qwen-plus',
  /** 译文语言。若与「音频语言」是同一种，这一段会自动跳过翻译。 */
  translateTarget: '中文',
  vocabMode: 'hard',
  vocabLevel: 'cet6',
  /** 每段最多提取几个生词 */
  vocabPerSegment: 6,
  phoneticStyle: 'us',
};

const SETTINGS_KEY = 'settings';

export async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** 把 region / customBaseUrl 解析成真正要请求的 base url。 */
export function resolveBaseUrl(settings) {
  if (settings.region === 'custom') {
    return (settings.customBaseUrl || '').replace(/\/+$/, '');
  }
  return REGIONS[settings.region]?.baseUrl || REGIONS.cn.baseUrl;
}

/**
 * manifest 的 host_permissions 里声明的域名，必须和那里保持一致。
 *
 * 扩展页面的 fetch 只有落在这些域名内才能绕过 CORS。换成别的地址（比如自建代理）
 * 会退化成普通跨域请求，对方不回 CORS 头就只能拿到一个无法定位的
 * 「Failed to fetch」，而且还会先白白重试三次。所以在这里提前拦下来。
 */
const ALLOWED_HOST_PATTERNS = [
  /^https:\/\/dashscope\.aliyuncs\.com$/,
  /^https:\/\/dashscope-intl\.aliyuncs\.com$/,
  // 与 Chrome 的 *.maas.aliyuncs.com 同义：裸域和任意子域都算
  /^https:\/\/([\w-]+\.)*maas\.aliyuncs\.com$/,
];

/** 判断一个 Base URL 是否落在插件已申请权限的域名内。 */
export function isAllowedBaseUrl(baseUrl) {
  try {
    return ALLOWED_HOST_PATTERNS.some((pattern) => pattern.test(new URL(baseUrl).origin));
  } catch {
    // 不是合法 URL（含空字符串）一律拒绝
    return false;
  }
}

/** 校验配置是否完整，返回错误信息或 null。 */
export function validateSettings(settings) {
  if (!settings.apiKey || !settings.apiKey.trim()) {
    return '尚未配置 DashScope API Key，请先到设置页填写。';
  }
  if (!settings.model || !settings.model.trim()) {
    return '尚未指定语音识别模型。';
  }
  if (settings.translateEnabled && !(settings.translateModel || '').trim()) {
    return '已开启逐段翻译，但尚未指定翻译模型。';
  }
  if (settings.region === 'custom') {
    const baseUrl = resolveBaseUrl(settings);
    if (!baseUrl) {
      return '选择了「自定义地址」但未填写 Base URL。';
    }
    if (!isAllowedBaseUrl(baseUrl)) {
      return (
        '自定义地址不在插件申请的权限范围内，请求会被浏览器拦下。' +
        '只允许 dashscope.aliyuncs.com、dashscope-intl.aliyuncs.com、*.maas.aliyuncs.com。'
      );
    }
  }
  return null;
}
