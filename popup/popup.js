/**
 * Popup：控制台 + 实时结果展示。
 *
 * 数据来源是 chrome.storage.local 里的 session，由 offscreen 文档产出内容、
 * Service Worker 负责写入。popup 只读不写，所以关掉再打开不会丢状态，
 * 也不会有并发写入问题。
 */

import { buildMarkdown } from '../lib/markdown.js';
import { buildFilename, formatClock, formatTimestamp } from '../lib/format.js';

const el = {
  pulse: document.getElementById('pulse'),
  banner: document.getElementById('banner'),
  bannerText: document.getElementById('bannerText'),
  bannerAction: document.getElementById('bannerAction'),
  btnToggle: document.getElementById('btnToggle'),
  toggleLabel: document.getElementById('toggleLabel'),
  hint: document.getElementById('hint'),
  meta: document.getElementById('meta'),
  metaDuration: document.getElementById('metaDuration'),
  metaSegments: document.getElementById('metaSegments'),
  metaModel: document.getElementById('metaModel'),
  metaModelSep: document.getElementById('metaModelSep'),
  metaPending: document.getElementById('metaPending'),
  source: document.getElementById('source'),
  sourceIcon: document.getElementById('sourceIcon'),
  sourceTitle: document.getElementById('sourceTitle'),
  btnCopy: document.getElementById('btnCopy'),
  btnDownload: document.getElementById('btnDownload'),
  btnClear: document.getElementById('btnClear'),
  btnOptions: document.getElementById('btnOptions'),
  transcript: document.getElementById('transcript'),
  toast: document.getElementById('toast'),
};

/** @type {{session: object|null, capturing: boolean, pending: number, pendingAsr: number, pendingTranslate: number, hasApiKey: boolean, settings: object}} */
let state = {
  session: null,
  capturing: false,
  pending: 0,
  pendingAsr: 0,
  pendingTranslate: 0,
  hasApiKey: false,
  settings: {},
};

let toastTimer = null;
let clockTimer = null;
let pollTimer = null;
/** 用户手动往上翻之后就不再自动滚到底部 */
let stickToBottom = true;

/* --------------------------------------------------------------- 通信 */

/** SW 可能刚被回收、正在冷启动，第一次 sendMessage 失败就重试一次。 */
async function send(message, retry = true) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    if (!retry) throw err;
    await new Promise((resolve) => setTimeout(resolve, 180));
    return chrome.runtime.sendMessage(message);
  }
}

async function refresh() {
  const response = await send({ type: 'GET_STATE' });
  if (!response?.ok) return;
  state = {
    session: response.session,
    capturing: response.capturing,
    pending: response.pending,
    pendingAsr: response.pendingAsr || 0,
    pendingTranslate: response.pendingTranslate || 0,
    hasApiKey: response.hasApiKey,
    settings: response.settings || {},
  };
  render();
}

/* --------------------------------------------------------------- 渲染 */

function render() {
  renderControl();
  renderMeta();
  renderSource();
  renderTranscript();
}

/**
 * 来源页面那一行。只在会话切换时重建 —— 录制期间 renderMeta 每秒都会跑，
 * 每次都重设 img.src 会让图标反复重新请求。
 */
let renderedSourceId = null;

function renderSource() {
  const session = state.session;

  if (!session || !session.tabUrl) {
    el.source.hidden = true;
    renderedSourceId = null;
    return;
  }

  if (renderedSourceId === session.id) return;
  renderedSourceId = session.id;

  el.source.hidden = false;
  el.source.href = session.tabUrl;
  el.source.title = session.tabUrl;
  el.sourceTitle.textContent = session.tabTitle || session.tabUrl;

  el.sourceIcon.classList.remove('broken');
  if (session.favIconUrl) {
    el.sourceIcon.src = session.favIconUrl;
    el.sourceIcon.hidden = false;
  } else {
    el.sourceIcon.hidden = true;
  }
}

function renderControl() {
  const session = state.session;
  const status = session?.status;
  const starting = status === 'starting';
  const finishing = status === 'finishing';
  const recording = !starting && (state.capturing || status === 'recording');

  el.btnToggle.disabled = false;
  el.btnToggle.classList.toggle('recording', recording);
  el.btnToggle.classList.toggle('busy', finishing || starting);
  el.pulse.classList.toggle('on', recording);

  if (!state.hasApiKey) {
    el.btnToggle.disabled = true;
    el.toggleLabel.textContent = '开始转录';
    showBanner('还没有配置 DashScope API Key，无法调用语音识别。', { action: '去设置' });
    el.hint.innerHTML = '在阿里云百炼控制台创建 API Key 后填入设置页即可开始使用。';
  } else if (starting) {
    // 会话已建立、音频图还没接上。此时 offscreen 报的 capturing 还是 false，
    // 不能按「未在录制」渲染，否则按钮会变回可点的「开始转录」。
    el.btnToggle.disabled = true;
    el.toggleLabel.textContent = '正在启动…';
    hideBanner();
    el.hint.textContent = '正在建立音频捕获通道，请稍候。';
  } else if (finishing) {
    el.btnToggle.disabled = true;
    el.toggleLabel.textContent = `正在处理剩余 ${state.pending || state.session?.segments?.length || 0} 段…`;
    hideBanner();
    el.hint.textContent = '音频已采集完毕，正在等待最后的识别与翻译完成，请不要关闭页面。';
  } else if (recording) {
    el.toggleLabel.textContent = '停止转录';
    hideBanner();
    el.hint.textContent = '正在捕获当前标签页的音频。切换到别的标签页不会中断录制，但请保持该页面处于播放状态。';
  } else if (session?.error) {
    // 启动失败、或录制被浏览器回收而中断 —— 重开 popup 时也得能看到原因
    el.toggleLabel.textContent = '开始转录';
    showBanner(session.error);
    el.hint.textContent = '已识别的内容会保留，可以直接重新开始一次录制。';
  } else {
    el.toggleLabel.textContent = '开始转录';
    hideBanner();
    el.hint.innerHTML =
      '先让网页里的视频开始播放，再点上面的按钮。插件会捕获<strong>当前标签页</strong>的音频。';
  }

  const hasText = (session?.segments || []).some((seg) => seg.status === 'done' && seg.text);
  el.btnCopy.disabled = !hasText;
  el.btnDownload.disabled = !hasText;
  el.btnClear.disabled = !session || recording || finishing || starting;
}

function renderMeta() {
  const session = state.session;
  if (!session) {
    el.meta.hidden = true;
    return;
  }

  el.meta.hidden = false;
  const elapsed = state.capturing
    ? (Date.now() - session.startedAt) / 1000
    : session.durationSec || 0;
  el.metaDuration.textContent = formatClock(elapsed);

  const total = session.segments?.length || 0;
  const done = (session.segments || []).filter((seg) => seg.status === 'done').length;
  el.metaSegments.textContent = state.pending ? `${done}/${total} 段` : `${total} 段`;

  const model = state.settings.model;
  el.metaModel.hidden = !model;
  el.metaModelSep.hidden = !model;
  el.metaModel.textContent = model || '';

  // 识别和翻译是两条并行队列，分开显示才能看出卡在哪一环
  const busy = [];
  if (state.pendingAsr) busy.push(`识别 ${state.pendingAsr}`);
  if (state.pendingTranslate) busy.push(`翻译 ${state.pendingTranslate}`);
  el.metaPending.hidden = busy.length === 0;
  el.metaPending.textContent = busy.join(' · ');
}

function renderTranscript() {
  // 识别中的片段也要显示（骨架屏），这样长音频被切成多段时有明确进度反馈
  const segments = state.session?.segments || [];

  if (!segments.length) {
    if (!el.transcript.querySelector('.empty')) {
      el.transcript.replaceChildren(buildEmptyState());
    }
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const seg of segments) {
    fragment.appendChild(buildSegmentNode(seg));
  }
  el.transcript.replaceChildren(fragment);

  if (stickToBottom) {
    el.transcript.scrollTop = el.transcript.scrollHeight;
  }
}

function buildEmptyState() {
  const wrap = document.createElement('div');
  wrap.className = 'empty';
  wrap.innerHTML =
    '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path fill="currentColor" d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3m7 9a7 7 0 0 1-6 6.92V21h-2v-2.08A7 7 0 0 1 5 12h2a5 5 0 0 0 10 0z"/></svg>';
  const p = document.createElement('p');
  p.textContent = '还没有转录内容';
  const span = document.createElement('span');
  span.textContent = '识别结果会按时间顺序实时出现在这里';
  wrap.append(p, span);
  return wrap;
}

function buildSegmentNode(seg) {
  const row = document.createElement('div');
  row.className = 'seg';

  const ts = document.createElement('span');
  ts.className = 'seg-ts';
  ts.textContent = formatTimestamp(seg.startSec);
  row.appendChild(ts);

  const main = document.createElement('div');
  main.className = 'seg-main';
  row.appendChild(main);

  if (seg.status === 'pending') {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton';
    skeleton.append(document.createElement('i'), document.createElement('i'));
    main.appendChild(skeleton);
    return row;
  }

  const body = document.createElement('p');
  body.className = 'seg-body';

  if (seg.status === 'error') {
    row.classList.add('error');
    body.textContent = `识别失败：${seg.error || '未知错误'}`;
  } else if (!seg.text) {
    row.classList.add('seg-empty');
    body.textContent = '（该片段无语音内容）';
  } else {
    body.textContent = seg.text;
  }
  main.appendChild(body);

  // 没有文本就没必要谈翻译；skipped 状态（未开翻译 / 语言相同）不占版面
  if (seg.status === 'done' && seg.text) {
    if (['pending', 'done', 'error'].includes(seg.translateStatus)) {
      main.appendChild(buildTranslationNode(seg));
    }
    const vocabNode = buildVocabNode(seg);
    if (vocabNode) main.appendChild(vocabNode);
  }

  return row;
}

function buildTranslationNode(seg) {
  const line = document.createElement('p');
  line.className = 'seg-trans';

  if (seg.translateStatus === 'pending') {
    line.classList.add('pending');
    const skeleton = document.createElement('span');
    skeleton.className = 'skeleton inline';
    skeleton.appendChild(document.createElement('i'));
    line.appendChild(skeleton);
  } else if (seg.translateStatus === 'error') {
    line.classList.add('error');
    line.textContent = `翻译失败：${seg.translateError || '未知错误'}`;
  } else {
    line.textContent = seg.translation || '';
  }

  return line;
}

function buildVocabNode(seg) {
  if (!seg.vocab?.length) return null;

  const list = document.createElement('ul');
  list.className = 'seg-vocab';

  for (const item of seg.vocab) {
    const li = document.createElement('li');

    const word = document.createElement('b');
    word.textContent = item.word;

    if (item.ipa) {
      const ipa = document.createElement('i');
      ipa.textContent = item.ipa;
      li.append(word, ipa);
    } else {
      li.appendChild(word);
    }

    const meaning = document.createElement('span');
    meaning.textContent = `${item.pos ? `${item.pos} ` : ''}${item.meaning}`;
    li.appendChild(meaning);

    list.appendChild(li);
  }

  return list;
}

/* --------------------------------------------------------------- 提示 */

function showBanner(text, { action, kind = 'error' } = {}) {
  el.banner.hidden = false;
  el.banner.classList.toggle('info', kind === 'info');
  el.bannerText.textContent = text;
  el.bannerAction.hidden = !action;
  if (action) el.bannerAction.textContent = action;
}

function hideBanner() {
  el.banner.hidden = true;
}

function toast(text, isError = false) {
  el.toast.hidden = false;
  el.toast.textContent = text;
  el.toast.classList.toggle('error', isError);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 2200);
}

/* --------------------------------------------------------------- 动作 */

async function toggleCapture() {
  el.btnToggle.disabled = true;

  try {
    if (state.capturing || state.session?.status === 'recording') {
      el.toggleLabel.textContent = '正在停止…';
      await send({ type: 'STOP_CAPTURE' });
      toast('已停止，正在识别剩余片段');
    } else {
      el.toggleLabel.textContent = '正在启动…';
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const response = await send({ type: 'START_CAPTURE', tabId: tab?.id });
      if (!response?.ok) {
        toast(response?.error || '启动失败', true);
        if (response?.needsSetup) {
          showBanner(response.error, { action: '去设置' });
        }
      } else {
        stickToBottom = true;
        toast('开始录制，正在捕获标签页音频');
      }
    }
  } catch (err) {
    toast(err?.message || '操作失败', true);
  }

  await refresh();
  startPolling();
}

function currentMarkdown() {
  if (!state.session) return '';
  return buildMarkdown(state.session, state.settings);
}

async function copyMarkdown() {
  const markdown = currentMarkdown();
  if (!markdown) return toast('还没有可复制的内容', true);

  try {
    await navigator.clipboard.writeText(markdown);
    toast('Markdown 已复制到剪贴板');
  } catch {
    // 剪贴板权限被拒时退回到 textarea + execCommand
    const textarea = document.createElement('textarea');
    textarea.value = markdown;
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    toast(ok ? 'Markdown 已复制到剪贴板' : '复制失败，请改用「下载 .md」', !ok);
  }
}

async function downloadMarkdown() {
  const markdown = currentMarkdown();
  if (!markdown) return toast('还没有可导出的内容', true);

  const filename = buildFilename(state.settings.filenameTemplate || '{title}-{date}', state.session);
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);

  toast(`已导出 ${filename}`);
}

async function clearSession() {
  const response = await send({ type: 'CLEAR_SESSION' });
  if (!response?.ok) return toast(response?.error || '清空失败', true);
  stickToBottom = true;
  await refresh();
  toast('已清空');
}

/* --------------------------------------------------------------- 轮询 */

/** 录制期间每 2 秒拿一次开关状态和待识别数量（进度只存在于 offscreen 内存里）。 */
function startPolling() {
  clearInterval(clockTimer);
  clearInterval(pollTimer);

  const busy = state.capturing || ['starting', 'recording', 'finishing'].includes(state.session?.status);
  if (!busy) return;

  clockTimer = setInterval(renderMeta, 1000);
  pollTimer = setInterval(refresh, 2000);
}

/* --------------------------------------------------------------- 绑定 */

el.btnToggle.addEventListener('click', toggleCapture);
el.btnCopy.addEventListener('click', copyMarkdown);
el.btnDownload.addEventListener('click', downloadMarkdown);
el.btnClear.addEventListener('click', clearSession);
el.btnOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
el.bannerAction.addEventListener('click', () => chrome.runtime.openOptionsPage());

// 站点图标可能被对方服务器拒绝或本来就取不到，静默退化成纯文字
el.sourceIcon.addEventListener('error', () => el.sourceIcon.classList.add('broken'));

el.transcript.addEventListener('scroll', () => {
  const { scrollTop, scrollHeight, clientHeight } = el.transcript;
  stickToBottom = scrollHeight - scrollTop - clientHeight < 24;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.session) return;
  state.session = changes.session.newValue || null;
  // starting 也算「有事在做」，否则按钮会在启动窗口里闪回可点的「开始转录」
  state.capturing = ['starting', 'recording'].includes(state.session?.status);
  startPolling();
  render();
});

window.addEventListener('unload', () => {
  clearInterval(clockTimer);
  clearInterval(pollTimer);
});

refresh().then(startPolling);
