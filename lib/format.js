/** 时间、体积、文件名等展示层的格式化工具，popup / offscreen / 导出共用。 */

/** 123 -> "02:03"；3723 -> "01:02:03" */
export function formatClock(totalSeconds) {
  const sec = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 同上，但总是带上小时位，用于时间戳标注：3723 -> "01:02:03" */
export function formatTimestamp(totalSeconds) {
  const sec = Math.max(0, Math.floor(totalSeconds || 0));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
}

/** "12 分 15 秒" 这样的中文时长描述。 */
export function formatDurationCn(totalSeconds) {
  const sec = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (h) parts.push(`${h} 小时`);
  if (m) parts.push(`${m} 分`);
  parts.push(`${s} 秒`);
  return parts.join(' ');
}

export function formatDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 20260923-1108 形式的时间戳，用于文件名。 */
export function formatFileStamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 去掉控制字符与 Windows / macOS 文件名里的非法字符。
 * 控制字符用码点判断而不是写进正则字符类，避免源码里出现不可见字符。
 */
function stripUnsafeChars(input) {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0);
    out += code < 32 || code === 127 ? ' ' : ch;
  }
  return out;
}

export function sanitizeFilename(name, fallback = 'transcript') {
  const cleaned = stripUnsafeChars(name || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

/**
 * 按模板生成导出文件名。
 * 支持占位符：{title} {date} {time} {site} {model}
 */
export function buildFilename(template, session) {
  const startedAt = session.startedAt || Date.now();
  let site = '';
  try {
    site = session.tabUrl ? new URL(session.tabUrl).hostname.replace(/^www\./, '') : '';
  } catch {
    site = '';
  }

  const stamp = formatFileStamp(startedAt);
  const values = {
    title: session.tabTitle || '未命名页面',
    date: stamp.split('-')[0],
    time: stamp.split('-')[1] || '',
    site,
    model: session.model || 'asr',
  };

  const rendered = (template || '{title}-{date}')
    .replace(/\{(\w+)\}/g, (match, key) => (key in values ? values[key] : match));

  return `${sanitizeFilename(rendered)}.md`;
}
