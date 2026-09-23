/**
 * 页面内悬浮状态条。
 *
 * 由 Service Worker 在开始录制时用 chrome.scripting.executeScript 按需注入，
 * 所以 manifest 里不需要声明 content_scripts，也就不需要「读取所有网站数据」的权限。
 *
 * 样式全部塞进 Shadow DOM，既不污染页面，也不会被页面样式影响。
 */

(() => {
  const HOST_ID = '__web-video-asr-overlay__';
  const SESSION_KEY = 'session';

  // 同一个 isolated world 里重复注入时，只做一次初始化
  if (window.__webVideoAsrOverlayReady) {
    window.__webVideoAsrOverlaySync?.();
    return;
  }
  window.__webVideoAsrOverlayReady = true;

  const STYLE = `
    :host { all: initial; }
    .pill {
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 8px 10px 8px 12px;
      border-radius: 999px;
      background: rgba(24, 24, 27, 0.94);
      color: #f4f4f5;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.32), 0 0 0 1px rgba(255, 255, 255, 0.08);
      font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
            "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      backdrop-filter: blur(12px);
      user-select: none;
      transition: opacity 0.2s ease, transform 0.2s ease;
    }
    .pill.hidden { opacity: 0; transform: translateY(8px); pointer-events: none; }

    .dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: #ef4444;
      animation: blink 1.4s ease-in-out infinite;
      flex: none;
    }
    .pill.finishing .dot { background: #6366f1; animation: none; }
    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
    @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }

    .text { white-space: nowrap; font-variant-numeric: tabular-nums; }
    .text b { font-weight: 700; }
    .text span { opacity: 0.62; }

    button {
      flex: none;
      padding: 4px 11px;
      border: none;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.14);
      color: #fff;
      font: 600 12px/1.4 inherit;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    button:hover { background: rgba(239, 68, 68, 0.85); }
    button:disabled { opacity: 0.5; cursor: default; }
  `;

  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = STYLE;

  const pill = document.createElement('div');
  pill.className = 'pill hidden';

  const dot = document.createElement('span');
  dot.className = 'dot';

  const text = document.createElement('span');
  text.className = 'text';

  const stopButton = document.createElement('button');
  stopButton.textContent = '停止';
  stopButton.addEventListener('click', async () => {
    stopButton.disabled = true;
    stopButton.textContent = '停止中…';
    try {
      await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
    } catch {
      stopButton.disabled = false;
      stopButton.textContent = '停止';
    }
  });

  pill.append(dot, text, stopButton);
  shadow.append(style, pill);

  /**
   * 全屏播放时只有全屏元素子树会被渲染，悬浮条得跟着搬进去才看得见。
   */
  function mount() {
    const target = document.fullscreenElement || document.body || document.documentElement;
    if (host.parentNode !== target) target.appendChild(host);
  }

  document.addEventListener('fullscreenchange', mount);
  mount();

  let session = null;
  let tickTimer = null;

  function formatClock(totalSeconds) {
    const sec = Math.max(0, Math.floor(totalSeconds || 0));
    const pad = (n) => String(n).padStart(2, '0');
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function paint() {
    const status = session?.status;
    // starting 是「会话已建立、音频图还没接上」的中间态，也要显示，
    // 否则开始录制的那一下悬浮条会先消失再出现。
    const starting = status === 'starting';
    const active = starting || status === 'recording' || status === 'finishing';

    if (!active) {
      pill.classList.add('hidden');
      clearInterval(tickTimer);
      tickTimer = null;
      return;
    }

    mount();
    pill.classList.remove('hidden');
    // 启动中沿用「非录制」的配色，避免还没真正录就显示成红色的录制态
    pill.classList.toggle('finishing', status === 'finishing' || starting);

    const elapsed = status === 'recording' || starting
      ? (Date.now() - session.startedAt) / 1000
      : session.durationSec || 0;

    const total = session.segments?.length || 0;
    const done = (session.segments || []).filter((seg) => seg.status === 'done').length;

    text.innerHTML = '';
    const time = document.createElement('b');
    time.textContent = formatClock(elapsed);
    const info = document.createElement('span');
    info.textContent = starting
      ? '  正在启动…'
      : status === 'finishing'
        ? `  正在收尾 · ${done}/${total} 段`
        : `  已识别 ${done}/${total} 段`;
    text.append(time, info);

    stopButton.disabled = status === 'finishing';
    stopButton.textContent = status === 'finishing' ? '收尾中…' : '停止';

    if ((status === 'recording' || starting) && !tickTimer) {
      tickTimer = setInterval(paint, 1000);
    }
  }

  async function sync() {
    try {
      const stored = await chrome.storage.local.get(SESSION_KEY);
      session = stored[SESSION_KEY] || null;
      paint();
    } catch {
      /* 扩展被重载时 storage 会短暂不可用，忽略 */
    }
  }

  // 重复注入的第二次调用走这里
  window.__webVideoAsrOverlaySync = sync;

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SESSION_KEY]) return;
    session = changes[SESSION_KEY].newValue || null;
    paint();
  });

  sync();
})();
