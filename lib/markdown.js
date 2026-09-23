/**
 * 把一次转录会话渲染成 Markdown。
 *
 * 开了逐段翻译时输出双语对照版：
 *   # 标题
 *   > 元信息
 *   ## 全文        —— 原文连续段落
 *   ## 译文        —— 译文连续段落
 *   ## 逐段对照     —— 一段原文一段译文，紧跟该段生词
 *   ## 生词汇总     —— 全文去重后的生词表，带首次出现的时间戳
 *
 * 没开翻译时退回到单语版（全文 + 带时间戳的分段）。
 */

import { formatDateTime, formatDurationCn, formatTimestamp } from './format.js';
import { LANGUAGES, ENGINES } from './settings.js';

function languageLabel(value) {
  return LANGUAGES.find((item) => item.value === value)?.label || value || '自动检测';
}

/** 表格单元格里的竖线和换行会破坏结构，转义掉。 */
function cell(text) {
  return String(text ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/** 把分段文本合并成自然段落：过短的分片会与相邻分片拼接，避免一行一句。 */
function toParagraphs(texts) {
  const paragraphs = [];
  let current = '';

  for (const text of texts) {
    const piece = text.trim();
    if (!piece) continue;

    if (!current) {
      current = piece;
    } else if (/[。！？.!?；;]$/.test(current) && current.length > 60) {
      // 上一段已经是完整句子且够长，另起一段
      paragraphs.push(current);
      current = piece;
    } else {
      current += current.endsWith('-') ? piece : ` ${piece}`;
    }

    // 单段过长时在句末断一次，避免出现巨型段落
    while (current.length > 400) {
      const cut = current.lastIndexOf('。', 400);
      if (cut < 120) break;
      paragraphs.push(current.slice(0, cut + 1));
      current = current.slice(cut + 1).trim();
    }
  }

  if (current.trim()) paragraphs.push(current.trim());
  return paragraphs;
}

/** 这个会话里有没有成功的译文。 */
export function hasTranslation(session) {
  return (session.segments || []).some(
    (seg) => seg.translateStatus === 'done' && (seg.translation || '').trim(),
  );
}

/**
 * 是否尝试过翻译（含失败）。
 *
 * 导出格式由它决定，而不是 hasTranslation —— 否则「全部片段都翻译失败」时会
 * 悄悄退回单语版，用户完全看不出翻译出过错。失败也要摆在明面上。
 */
export function translationAttempted(session) {
  return (session.segments || []).some((seg) =>
    ['done', 'error', 'pending'].includes(seg.translateStatus),
  );
}

/**
 * 汇总全文生词，同一个词只留第一次出现的那次（含时间戳和段落序号）。
 * 按首次出现顺序排列，方便顺着视频往下背。
 */
export function collectVocabulary(session) {
  const byWord = new Map();

  for (const seg of session.segments || []) {
    for (const item of seg.vocab || []) {
      const key = item.word.toLowerCase();
      if (byWord.has(key)) continue;
      byWord.set(key, { ...item, startSec: seg.startSec, segmentIndex: seg.index });
    }
  }

  return [...byWord.values()];
}

/** 元信息里的「识别/翻译」两行。 */
function buildMetaLines(session, settings, segments) {
  const engineLabel = ENGINES[settings.engine]?.label || settings.engine || '';
  const lines = [];

  lines.push(`> **转录时间**：${formatDateTime(session.startedAt)}${session.endedAt ? ` — ${formatDateTime(session.endedAt)}` : ''}  `);
  lines.push(`> **音频时长**：${formatDurationCn(session.durationSec || 0)}  `);
  lines.push(
    `> **识别模型**：\`${settings.model || session.model || '-'}\`${engineLabel ? `（DashScope · ${engineLabel}）` : '（DashScope）'}  `,
  );
  lines.push(`> **识别语言**：${languageLabel(settings.language)}  `);

  if (translationAttempted(session)) {
    lines.push(`> **翻译模型**：\`${settings.translateModel || '-'}\` → ${settings.translateTarget || '中文'}  `);
  }

  lines.push(`> **分片数量**：${segments.length} 段`);

  return lines;
}

/** 双语对照版。 */
function renderBilingual(session, settings, segments) {
  const lines = [];
  const translated = segments.filter((seg) => seg.translateStatus === 'done' && seg.translation);
  const originals = segments.filter((seg) => seg.status === 'done' && seg.text);

  // ---- 全文
  lines.push('## 全文');
  lines.push('');
  if (originals.length) {
    for (const paragraph of toParagraphs(originals.map((seg) => seg.text))) {
      lines.push(paragraph);
      lines.push('');
    }
  } else {
    lines.push('_本次没有识别出有效文本。_');
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  // ---- 译文
  lines.push('## 译文');
  lines.push('');
  if (translated.length) {
    for (const paragraph of toParagraphs(translated.map((seg) => seg.translation))) {
      lines.push(paragraph);
      lines.push('');
    }
  } else {
    lines.push('_本次没有产出译文。_');
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  // ---- 逐段对照
  lines.push('## 逐段对照');
  lines.push('');

  for (const seg of segments) {
    const stamp = formatTimestamp(seg.startSec);
    lines.push(`**[${stamp}]**`);
    lines.push('');

    if (seg.status === 'error') {
      lines.push(`> ⚠️ 该片段识别失败：${seg.error || '未知错误'}`);
      lines.push('');
      lines.push('---');
      lines.push('');
      continue;
    }

    if (seg.text) {
      lines.push('**原文**');
      lines.push('');
      // 引用块让原文在视觉上区别于译文，扫读时容易定位
      for (const paragraph of seg.text.split(/\n+/)) {
        lines.push(`> ${paragraph}`);
      }
      lines.push('');
    }

    if (seg.translateStatus === 'done' && seg.translation) {
      lines.push('**译文**');
      lines.push('');
      lines.push(seg.translation);
      lines.push('');
    } else if (seg.translateStatus === 'pending') {
      lines.push('**译文**');
      lines.push('');
      lines.push('_（翻译未完成）_');
      lines.push('');
    } else if (seg.translateStatus === 'error') {
      lines.push('**译文**');
      lines.push('');
      lines.push(`_翻译失败：${seg.translateError || '未知错误'}_`);
      lines.push('');
    }

    if (seg.vocab?.length) {
      lines.push('**生词**');
      lines.push('');
      for (const item of seg.vocab) {
        lines.push(`- \`${item.word}\` ${item.ipa} ${item.pos ? `*${item.pos}* ` : ''}${item.meaning}`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  // ---- 生词汇总
  const vocabulary = collectVocabulary(session);
  if (vocabulary.length) {
    lines.push('## 生词汇总');
    lines.push('');
    lines.push('| 单词 | 音标 | 词性 | 释义 | 首次出现 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const item of vocabulary) {
      lines.push(
        `| \`${cell(item.word)}\` | ${cell(item.ipa)} | ${cell(item.pos)} | ${cell(item.meaning)} | [${formatTimestamp(item.startSec)}] |`,
      );
    }
    lines.push('');
    lines.push(`共 ${vocabulary.length} 个词条。`);
    lines.push('');
  }

  return lines;
}

/** 单语版（没开翻译时的原有格式）。 */
function renderMonolingual(session, segments) {
  const lines = [];
  const done = segments.filter((seg) => seg.status === 'done' && seg.text);
  const failed = segments.filter((seg) => seg.status === 'error');

  lines.push('## 全文');
  lines.push('');

  if (done.length) {
    for (const paragraph of toParagraphs(done.map((seg) => seg.text))) {
      lines.push(paragraph);
      lines.push('');
    }
  } else {
    lines.push('_本次没有识别出有效文本。_');
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## 分段（含时间戳）');
  lines.push('');

  for (const seg of segments) {
    const stamp = `[${formatTimestamp(seg.startSec)}]`;
    if (seg.status === 'error') {
      lines.push(`**[${formatTimestamp(seg.startSec)} — ${formatTimestamp(seg.endSec)}]** ⚠️ 该片段识别失败：${seg.error || '未知错误'}`);
    } else if (seg.text) {
      lines.push(`**${stamp}** ${seg.text}`);
    } else {
      lines.push(`**${stamp}** _（该片段无语音内容）_`);
    }
    lines.push('');
  }

  if (failed.length) {
    lines.push('---');
    lines.push('');
    lines.push(`> ⚠️ 共有 ${failed.length} 个片段识别失败，对应时间段的内容缺失。可在设置页调小「分片时长」后重新录制。`);
    lines.push('');
  }

  return lines;
}

/**
 * @param {object} session 会话对象
 * @param {object} settings 插件设置
 * @returns {string} Markdown 文本
 */
export function buildMarkdown(session, settings = {}) {
  // 识别中（pending）的分片没有内容，不进导出
  const segments = (session.segments || []).filter((seg) => seg.status !== 'pending');
  const bilingual = translationAttempted(session);

  const lines = [];

  lines.push(`# ${session.tabTitle || '未命名页面'}`);
  lines.push('');
  if (session.tabUrl) lines.push(`> **来源**：<${session.tabUrl}>  `);
  lines.push(...buildMetaLines(session, settings, segments));
  lines.push('');
  lines.push('---');
  lines.push('');

  if (!segments.length) {
    lines.push('_未捕获到任何音频内容。_');
    return lines.join('\n');
  }

  lines.push(...(bilingual ? renderBilingual(session, settings, segments) : renderMonolingual(session, segments)));

  lines.push('---');
  lines.push('');
  lines.push('<sub>由「网页视频转文字」Chrome 扩展生成，语音识别与翻译由阿里云百炼 DashScope 提供。</sub>');
  lines.push('');

  return lines.join('\n');
}

/**
 * 纯文本版本（无 Markdown 记号），方便粘到别处。
 * includeTranslation 为真时按「原文 / 译文」交替输出。
 */
export function buildPlainText(session, { includeTranslation = true } = {}) {
  const segments = (session.segments || []).filter((seg) => seg.status === 'done' && seg.text);
  const bilingual = includeTranslation && hasTranslation(session);

  return segments
    .map((seg) => {
      const original = seg.text.trim();
      if (!bilingual) return original;
      const translation = (seg.translation || '').trim();
      return translation ? `${original}\n${translation}` : original;
    })
    .join('\n\n');
}
