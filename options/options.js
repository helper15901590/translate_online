/**
 * 设置页。
 *
 * 表单改动即保存（change 事件，文本框失焦时触发），避免用户填完忘了点保存。
 * 「测试连接」会真的往 DashScope 发一段 1 秒静音，用来一次性验证
 * Key / 地域 / 模型名 / 网络 四件事。
 */

import {
  DEFAULT_SETTINGS,
  ENGINES,
  KNOWN_MODELS,
  KNOWN_TRANSLATE_MODELS,
  LANGUAGES,
  PHONETIC_STYLES,
  REGIONS,
  TARGET_LANGUAGES,
  VOCAB_LEVELS,
  VOCAB_MODES,
  getSettings,
  saveSettings,
  validateSettings,
} from '../lib/settings.js';
import { testConnection } from '../lib/dashscope.js';
import { testTranslation, shouldTranslate } from '../lib/translate.js';

const el = {
  apiKey: document.getElementById('apiKey'),
  btnReveal: document.getElementById('btnReveal'),
  region: document.getElementById('region'),
  customUrlField: document.getElementById('customUrlField'),
  customBaseUrl: document.getElementById('customBaseUrl'),
  engine: document.getElementById('engine'),
  model: document.getElementById('model'),
  modelList: document.getElementById('modelList'),
  language: document.getElementById('language'),
  chunkSeconds: document.getElementById('chunkSeconds'),
  sampleRate: document.getElementById('sampleRate'),
  context: document.getElementById('context'),
  enableItn: document.getElementById('enableItn'),
  carryContext: document.getElementById('carryContext'),
  translateEnabled: document.getElementById('translateEnabled'),
  translateModel: document.getElementById('translateModel'),
  translateModelList: document.getElementById('translateModelList'),
  translateTarget: document.getElementById('translateTarget'),
  targetLanguageList: document.getElementById('targetLanguageList'),
  vocabMode: document.getElementById('vocabMode'),
  vocabLevel: document.getElementById('vocabLevel'),
  vocabLevelField: document.getElementById('vocabLevelField'),
  vocabPerSegment: document.getElementById('vocabPerSegment'),
  vocabCountField: document.getElementById('vocabCountField'),
  phoneticStyle: document.getElementById('phoneticStyle'),
  phoneticField: document.getElementById('phoneticField'),
  monitor: document.getElementById('monitor'),
  autoDownload: document.getElementById('autoDownload'),
  filenameTemplate: document.getElementById('filenameTemplate'),
  consoleLink: document.getElementById('consoleLink'),
  btnTest: document.getElementById('btnTest'),
  testResult: document.getElementById('testResult'),
  btnSave: document.getElementById('btnSave'),
  btnReset: document.getElementById('btnReset'),
  saveState: document.getElementById('saveState'),
};

let current = { ...DEFAULT_SETTINGS };
let saveStateTimer = null;

/* --------------------------------------------------------- 初始化下拉框 */

function populateStaticOptions() {
  el.region.replaceChildren(
    ...Object.entries(REGIONS).map(([value, region]) => new Option(region.label, value)),
  );

  el.engine.replaceChildren(
    ...Object.entries(ENGINES).map(([value, engine]) => new Option(engine.label, value)),
  );

  el.language.replaceChildren(
    ...LANGUAGES.map((item) => new Option(item.label, item.value)),
  );

  el.modelList.replaceChildren(...KNOWN_MODELS.map((name) => new Option(name, name)));
  el.translateModelList.replaceChildren(
    ...KNOWN_TRANSLATE_MODELS.map((name) => new Option(name, name)),
  );
  el.targetLanguageList.replaceChildren(...TARGET_LANGUAGES.map((name) => new Option(name, name)));
  el.vocabMode.replaceChildren(...VOCAB_MODES.map((item) => new Option(item.label, item.value)));
  el.vocabLevel.replaceChildren(...VOCAB_LEVELS.map((item) => new Option(item.label, item.value)));
  el.phoneticStyle.replaceChildren(
    ...PHONETIC_STYLES.map((item) => new Option(item.label, item.value)),
  );
}

/* ------------------------------------------------------------- 表单读写 */

function fillForm(settings) {
  el.apiKey.value = settings.apiKey || '';
  el.region.value = settings.region;
  el.customBaseUrl.value = settings.customBaseUrl || '';
  el.engine.value = settings.engine;
  el.model.value = settings.model || '';
  el.language.value = settings.language ?? '';
  el.chunkSeconds.value = settings.chunkSeconds;
  el.sampleRate.value = String(settings.sampleRate);
  el.context.value = settings.context || '';
  el.enableItn.checked = Boolean(settings.enableItn);
  el.carryContext.checked = Boolean(settings.carryContext);

  el.translateEnabled.checked = Boolean(settings.translateEnabled);
  el.translateModel.value = settings.translateModel || '';
  el.translateTarget.value = settings.translateTarget || '';
  el.vocabMode.value = settings.vocabMode;
  el.vocabLevel.value = settings.vocabLevel;
  el.vocabPerSegment.value = settings.vocabPerSegment;
  el.phoneticStyle.value = settings.phoneticStyle;

  el.monitor.checked = Boolean(settings.monitor);
  el.autoDownload.checked = Boolean(settings.autoDownload);
  el.filenameTemplate.value = settings.filenameTemplate || '';

  syncRegionUi();
  syncTranslateUi();
}

function readForm() {
  const chunk = Number(el.chunkSeconds.value);
  const rate = Number(el.sampleRate.value);

  return {
    apiKey: el.apiKey.value.trim(),
    region: el.region.value,
    customBaseUrl: el.customBaseUrl.value.trim().replace(/\/+$/, ''),
    engine: el.engine.value,
    model: el.model.value.trim(),
    language: el.language.value,
    chunkSeconds: Number.isFinite(chunk) ? Math.min(300, Math.max(15, Math.round(chunk))) : 60,
    sampleRate: Number.isFinite(rate) ? rate : 16000,
    context: el.context.value,
    enableItn: el.enableItn.checked,
    carryContext: el.carryContext.checked,

    translateEnabled: el.translateEnabled.checked,
    translateModel: el.translateModel.value.trim(),
    translateTarget: el.translateTarget.value.trim(),
    vocabMode: el.vocabMode.value,
    vocabLevel: el.vocabLevel.value,
    vocabPerSegment: clampCount(el.vocabPerSegment.value, 1, 20, 6),
    phoneticStyle: el.phoneticStyle.value,

    monitor: el.monitor.checked,
    autoDownload: el.autoDownload.checked,
    filenameTemplate: el.filenameTemplate.value.trim() || DEFAULT_SETTINGS.filenameTemplate,
  };
}

function clampCount(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/** 自定义地址只在选了「自定义」时出现；控制台链接跟着地域走。 */
function syncRegionUi() {
  const region = el.region.value;
  el.customUrlField.hidden = region !== 'custom';

  // 这里刻意不清空 customBaseUrl。readForm() 是从 DOM 读值的，一旦在这里清掉，
  // 紧接着的 persist() 就会把空值写回存储，用户切回来时地址已经没了。
  // 留着它没有副作用：resolveBaseUrl() 只在 region === 'custom' 时才读这个字段。

  const consoleUrl = REGIONS[region]?.console;
  el.consoleLink.href = consoleUrl || REGIONS.cn.console;
}

/** 生词相关的几项只在「开了翻译 + 没关生词提取」时才有意义。 */
function syncTranslateUi() {
  const translationOn = el.translateEnabled.checked;
  const vocabOn = translationOn && el.vocabMode.value !== 'off';

  el.vocabMode.disabled = !translationOn;
  el.vocabLevelField.hidden = !vocabOn || el.vocabMode.value !== 'hard';
  el.vocabCountField.hidden = !vocabOn;
  el.phoneticField.hidden = !vocabOn;
}

/* --------------------------------------------------------------- 保存 */

function flashSaved(text = '已保存') {
  el.saveState.textContent = text;
  clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => {
    el.saveState.textContent = '';
  }, 1800);
}

async function persist({ quiet = false } = {}) {
  const patch = readForm();
  current = await saveSettings(patch);
  fillForm(current);
  el.testResult.textContent = '';
  el.testResult.className = 'test-result';
  if (!quiet) flashSaved();
  return current;
}

/* --------------------------------------------------------- 测试连接 */

async function runTest() {
  el.btnTest.disabled = true;
  el.testResult.className = 'test-result pending';
  el.testResult.textContent = '正在测试语音识别…';

  try {
    const settings = await persist({ quiet: true });

    const invalid = validateSettings(settings);
    if (invalid) throw new Error(invalid);

    // 1. 语音识别：送 1 秒静音过去。只要 200 就说明 Key / 地域 / 模型名 / 网络都通了
    const asrStart = Date.now();
    await testConnection(settings);
    const lines = [`识别正常（${Date.now() - asrStart} ms）· ${settings.model}`];

    // 2. 翻译：拿一句真英文跑完整链路，顺便验证 JSON 结构解析得出来
    if (settings.translateEnabled) {
      el.testResult.textContent = '正在测试翻译模型…';

      const trStart = Date.now();
      const result = await testTranslation(settings);
      const skipped = shouldTranslate(settings) ? '' : '（当前「音频语言」设置下会自动跳过翻译）';

      lines.push(
        `翻译正常（${Date.now() - trStart} ms）· ${settings.translateModel} → ${settings.translateTarget}${skipped}`,
      );
      lines.push(`译文示例：${result.translation || '（空）'}`);

      if (result.vocabulary.length) {
        lines.push(
          `生词示例：${result.vocabulary.map((v) => `${v.word} ${v.ipa} ${v.meaning}`).join('；')}`,
        );
      } else {
        lines.push('生词示例：未提取到（可能是难度基线设得偏高，或该模型不支持 JSON 输出）');
      }
    } else {
      lines.push('翻译未启用');
    }

    el.testResult.className = 'test-result ok';
    el.testResult.textContent = lines.join('\n');
  } catch (err) {
    el.testResult.className = 'test-result fail';
    el.testResult.textContent = err?.message || String(err);
  } finally {
    el.btnTest.disabled = false;
  }
}

/* --------------------------------------------------------------- 绑定 */

const formInputs = [
  el.apiKey,
  el.region,
  el.customBaseUrl,
  el.engine,
  el.model,
  el.language,
  el.chunkSeconds,
  el.sampleRate,
  el.context,
  el.translateModel,
  el.translateTarget,
  el.vocabMode,
  el.vocabLevel,
  el.vocabPerSegment,
  el.phoneticStyle,
  el.filenameTemplate,
];

for (const input of formInputs) {
  input.addEventListener('change', () => {
    if (input === el.region) syncRegionUi();
    if (input === el.vocabMode) syncTranslateUi();
    persist();
  });
}

for (const box of [el.enableItn, el.carryContext, el.translateEnabled, el.monitor, el.autoDownload]) {
  box.addEventListener('change', () => {
    if (box === el.translateEnabled) syncTranslateUi();
    persist();
  });
}

el.btnReveal.addEventListener('click', () => {
  const hidden = el.apiKey.type === 'password';
  el.apiKey.type = hidden ? 'text' : 'password';
  el.btnReveal.textContent = hidden ? '隐藏' : '显示';
});

el.btnSave.addEventListener('click', () => persist());
el.btnTest.addEventListener('click', runTest);

el.btnReset.addEventListener('click', async () => {
  const confirmed = confirm('确定要恢复所有默认设置吗？已填写的 API Key 也会被清空。');
  if (!confirmed) return;

  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS } });
  current = { ...DEFAULT_SETTINGS };
  fillForm(current);
  el.testResult.textContent = '';
  el.testResult.className = 'test-result';
  flashSaved('已恢复默认');
});

/* --------------------------------------------------------------- 启动 */

(async () => {
  populateStaticOptions();
  current = await getSettings();
  fillForm(current);
})();
