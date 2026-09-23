/**
 * Service Worker：编排层。
 *
 * 它自己不碰音频，也不发识别请求，只负责：
 *   - 管理 offscreen 文档的生命周期（MV3 里拿标签页音频必须先有它）
 *   - 通过 chrome.tabCapture 换取当前标签页的音轨 id
 *   - 维护工具栏角标、按需注入页面悬浮条
 *   - 把 popup / 内容脚本的请求转成对 offscreen 的调用
 *
 * 真正的音频处理与语音识别都在 offscreen.js 里。
 */

import { getSettings, validateSettings } from './lib/settings.js';

const SESSION_KEY = 'session';
const OFFSCREEN_PATH = 'offscreen.html';

let creatingOffscreen = null;

/* ------------------------------------------------------------- offscreen */

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
        justification: '捕获标签页正在播放的音频，并把它播回扬声器，用于语音转文字。',
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }

  await creatingOffscreen;
}

/** 向 offscreen 文档发消息；文档不存在或已崩溃时返回 null。 */
async function callOffscreen(message) {
  try {
    if (!(await chrome.offscreen.hasDocument())) return null;
    const response = await chrome.runtime.sendMessage(message);
    return response ?? null;
  } catch (err) {
    console.warn('[转录] 与 offscreen 通信失败', err);
    return null;
  }
}

/* ------------------------------------------------------------ 会话状态 */

async function readSession() {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  return stored[SESSION_KEY] || null;
}

async function writeSession(session) {
  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

/**
 * 存储里写着「录制中」，但 offscreen 已经不管这次会话了 —— 说明后台页面被
 * 回收过，把它标记为中断，免得 popup 一直显示成进行中。
 *
 * 判断依据是 offscreen 报的 alive 而不是 capturing：starting（会话已建立、
 * 音频图还没接上）和 finishing（音频已断、识别/翻译还在跑）这两种中间态都没有
 * capture，但会话明明是活的。只看 capturing 会把它们全部误判成中断 ——
 * 后者尤其致命，它意味着每次「停止」只要还有翻译在排队，就会闪出一条
 * 「浏览器回收了后台页面」的错误。
 */
async function reconcileSession(session, offscreen) {
  if (!session) return null;
  if (!['starting', 'recording', 'finishing'].includes(session.status)) return session;
  if (offscreen?.alive) return session;

  const patched = {
    ...session,
    status: 'done',
    endedAt: session.endedAt || Date.now(),
    error: session.error || '录制被中断：浏览器回收了后台页面。',
  };
  await writeSession(patched);
  return patched;
}

/* --------------------------------------------------------------- 角标 */

async function refreshBadge() {
  const session = await readSession();
  const offscreen = await callOffscreen({ type: 'OFFSCREEN_STATUS' });
  // starting 也点亮角标：否则从落盘 starting 到 capture 就位这几百毫秒里，
  // 角标会先熄灭再亮起，看起来像闪了一下。
  const active = Boolean(offscreen?.capturing || offscreen?.starting);

  if (active) {
    await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    await chrome.action.setBadgeText({ text: 'REC' });
    await chrome.action.setTitle({ title: '正在转录当前标签页音频…点击查看' });
    return;
  }

  const done = (session?.segments || []).filter((seg) => seg.status === 'done' && seg.text).length;
  if (done > 0) {
    await chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' });
    await chrome.action.setBadgeText({ text: String(done) });
    await chrome.action.setTitle({
      title: `已转录 ${done} 段${session?.error ? ` · ${session.error}` : ''}`,
    });
  } else {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: '网页视频转文字' });
  }
}

/* ------------------------------------------------------- 页面悬浮状态条 */

/**
 * 用 executeScript 按需注入，而不是在 manifest 里声明 content_scripts。
 * 这样权限只需 activeTab，用户安装时不会看到「读取所有网站数据」的警告。
 * 悬浮条的样式打包在 shadow DOM 里，所以不需要 insertCSS。
 */
async function injectOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/overlay.js'] });
  } catch (err) {
    // chrome:// 页面、扩展商店等禁止注入，静默跳过
    console.debug('[转录] 悬浮条注入失败（该页面不允许注入）', err?.message);
  }
}

/* -------------------------------------------------------------- 主要动作 */

async function handleStart(message) {
  const settings = await getSettings();
  const invalid = validateSettings(settings);
  if (invalid) return { ok: false, error: invalid, needsSetup: true };

  let tab = null;
  if (message.tabId) {
    tab = await chrome.tabs.get(message.tabId).catch(() => null);
  }
  if (!tab) {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (!tab?.id) return { ok: false, error: '找不到要捕获的标签页。' };

  if (/^(chrome|edge|about|devtools|chrome-extension):/i.test(tab.url || '')) {
    return { ok: false, error: '浏览器内部页面无法捕获音频，请切换到播放视频的普通网页。' };
  }

  // 已经有一份会话在跑，先停掉
  const existing = await callOffscreen({ type: 'OFFSCREEN_STATUS' });
  if (existing?.capturing) {
    await callOffscreen({ type: 'OFFSCREEN_STOP' });
  }

  try {
    await ensureOffscreen();
  } catch (err) {
    return { ok: false, error: `无法创建后台音频页面：${err.message}` };
  }

  // 换音轨 id 必须紧挨着 getUserMedia：这个 id 只能用一次，几秒内不用就失效
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (err) {
    return {
      ok: false,
      error:
        `无法捕获该标签页音频：${err.message}\n` +
        '请确认：① 页面地址是 https:// 开头；② 页面确实正在播放声音；' +
        '③ 没有别的程序（录屏软件等）正占用这个标签页。',
    };
  }

  const response = await callOffscreen({
    type: 'OFFSCREEN_START',
    streamId,
    // settings 必须由这一层读好传过去：offscreen 文档里没有 chrome.storage
    settings,
    meta: {
      tabId: tab.id,
      tabTitle: tab.title || '',
      tabUrl: tab.url || '',
      favIconUrl: tab.favIconUrl || '',
    },
  });

  if (!response?.ok) {
    return { ok: false, error: response?.error || '启动音频捕获失败。' };
  }

  await injectOverlay(tab.id);
  await refreshBadge();
  return { ok: true, captureRate: response.captureRate, sessionId: response.sessionId };
}

async function handleStop() {
  const response = await callOffscreen({ type: 'OFFSCREEN_STOP' });
  await refreshBadge();
  return response?.ok ? { ok: true } : { ok: true, warning: '录制进程已不在运行。' };
}

async function handleGetState() {
  const [settings, raw, offscreen] = await Promise.all([
    getSettings(),
    readSession(),
    callOffscreen({ type: 'OFFSCREEN_STATUS' }),
  ]);
  const session = await reconcileSession(raw, offscreen);

  return {
    ok: true,
    session,
    capturing: Boolean(offscreen?.capturing),
    pending: (offscreen?.pending || 0) + (offscreen?.pendingTranslate || 0),
    pendingAsr: offscreen?.pending || 0,
    pendingTranslate: offscreen?.pendingTranslate || 0,
    // API Key 不回传给 popup，只回传「有没有配」
    hasApiKey: Boolean(settings.apiKey?.trim()),
    // 这里只挑导出 Markdown 和界面展示需要的字段，不把整个设置对象给出去
    settings: {
      model: settings.model,
      language: settings.language,
      chunkSeconds: settings.chunkSeconds,
      engine: settings.engine,
      autoDownload: settings.autoDownload,
      filenameTemplate: settings.filenameTemplate,
      translateEnabled: settings.translateEnabled,
      translateModel: settings.translateModel,
      translateTarget: settings.translateTarget,
      vocabMode: settings.vocabMode,
      vocabLevel: settings.vocabLevel,
      phoneticStyle: settings.phoneticStyle,
    },
  };
}

async function handleClear() {
  const offscreen = await callOffscreen({ type: 'OFFSCREEN_STATUS' });
  // 用 alive 而不是 capturing：收尾期间（识别/翻译还在跑）清空的话，
  // offscreen 紧接着的 persist() 会把这份会话又写回存储，看起来像「清不掉」。
  if (offscreen?.alive) {
    return { ok: false, error: '正在录制或收尾中，请先停止并等结果出完再清空。' };
  }
  await chrome.storage.local.remove(SESSION_KEY);
  await refreshBadge();
  return { ok: true };
}

/**
 * offscreen 文档唯一的落盘通道。
 *
 * offscreen 只暴露 chrome.runtime，碰不到 chrome.storage，所以整个会话状态
 * 由它发过来、由这里写下去。写下去之后 popup 和页面悬浮条会通过
 * chrome.storage.onChanged 自动收到更新。
 */
async function handleSessionUpdate(message) {
  if (!message.session) return { ok: false, error: '缺少会话数据。' };
  await writeSession(message.session);
  return { ok: true };
}

/**
 * 录制结束后的自动下载。
 *
 * 由 SW 用 chrome.downloads 完成，而不是在 offscreen 文档里点 <a download> ——
 * 那个文档是隐藏的、也没有用户手势，触发不成功时完全没有反馈。
 */
async function handleDownloadMarkdown(message) {
  const filename = message.filename || 'transcript.md';

  // 首选 blob URL：长度只有几十个字符，与文本多少无关。
  // （SW 里没有 URL.createObjectURL，所以 blob 是 offscreen 文档建好后传过来的。）
  if (message.url) {
    try {
      const downloadId = await chrome.downloads.download({
        url: message.url,
        filename,
        saveAs: false,
      });
      return { ok: true, downloadId, via: 'blob' };
    } catch (err) {
      console.warn('[转录] blob URL 下载失败，改用 data URL 重试', err);
    }
  }

  if (!message.markdown) return { ok: false, error: '没有可下载的内容。' };

  // 兜底。能work，但 Markdown 里的中文经 encodeURIComponent 会膨胀约 9 倍
  // （每个汉字 3 字节 UTF-8 → 9 个字符），长转录拼出的 URL 可能超过 Chrome
  // 约 2MB 的长度上限，所以只当备选，不作首选。
  const url = `data:text/markdown;charset=utf-8,${encodeURIComponent(message.markdown)}`;

  try {
    const downloadId = await chrome.downloads.download({ url, filename, saveAs: false });
    return { ok: true, downloadId, via: 'data' };
  } catch (err) {
    console.error('[转录] 自动下载失败', err);
    return { ok: false, error: `自动下载失败：${err.message}` };
  }
}

/* ------------------------------------------------------------- 消息路由 */

const routes = {
  START_CAPTURE: handleStart,
  STOP_CAPTURE: handleStop,
  GET_STATE: handleGetState,
  CLEAR_SESSION: handleClear,
  SESSION_UPDATE: handleSessionUpdate,
  DOWNLOAD_MARKDOWN: handleDownloadMarkdown,
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const route = routes[message?.type];
  if (!route) return false;

  route(message)
    .then(sendResponse)
    .catch((err) => {
      console.error('[转录] 处理失败', message?.type, err);
      sendResponse({ ok: false, error: err?.message || String(err) });
    });

  return true;
});

/* --------------------------------------------------------- 生命周期与状态 */

// offscreen 文档建立的保活长连接，存在即说明有录制在跑
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'capture-keepalive') return;
  port.onMessage.addListener(() => {
    /* 收到心跳即为续命，无需处理 */
  });
  port.onDisconnect.addListener(() => {
    /* 连接断开说明 offscreen 已销毁，角标由 refreshBadge 纠正 */
  });
});

/**
 * 会话状态每次变化都会触发这里（offscreen 每识别完一段就写一次），
 * 合并一下再刷新，避免频繁往返 offscreen 查状态。
 */
let badgeTimer = null;

function scheduleBadgeRefresh() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(refreshBadge, 150);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[SESSION_KEY]) return;
  scheduleBadgeRefresh();
});

chrome.runtime.onStartup.addListener(async () => {
  const session = await readSession();
  // 浏览器刚重启，不可能有 offscreen 文档在跑，所有「进行中」的状态都是残留，
  // starting 也要算进来，否则启动到一半被重启的会话会永远停在 starting。
  if (session && ['starting', 'recording', 'finishing'].includes(session.status)) {
    await writeSession({
      ...session,
      status: 'done',
      endedAt: session.endedAt || Date.now(),
      error: session.error || '浏览器重启，上次录制被中断。',
    });
  }
  refreshBadge();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: '' });
});

// SW 冷启动时也校正一次角标
refreshBadge();
