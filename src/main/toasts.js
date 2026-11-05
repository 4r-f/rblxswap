'use strict';

const path = require('path');
const { escapeHtml, stripControlChars } = require('../shared/security');
const { MAX_TOASTS } = require('../shared/constants');

/**
 * Custom toast windows. Each toast is a small always-on-top BrowserWindow with
 * a data: URL and its own preload bridge for button actions.
 */
function createToastManager({
  BrowserWindow,
  screen,
  preloadPath,
  iconPath,
  maxToasts = MAX_TOASTS,
  logger = { append: () => {} }
} = {}) {
  const windows = new Map();
  const order = [];
  const actions = new Map();
  let counter = 0;
  let logoDataUrl = null;

  function registerAction(key, handler) {
    if (typeof key === 'string' && typeof handler === 'function') actions.set(key, handler);
  }

  function getLogo() {
    if (logoDataUrl) return logoDataUrl;

    const candidates = [
      path.join(__dirname, '..', '..', 'assets', 'rblxswap_logo_no_bg.png'),
      path.join(__dirname, '..', '..', 'assets', 'rblxswap_logo.png')
    ];

    for (const candidate of candidates) {
      try {
        const raw = require('fs').readFileSync(candidate);
        logoDataUrl = `data:image/png;base64,${raw.toString('base64')}`;
        return logoDataUrl;
      } catch (error) {
        // Try the next candidate.
      }
    }

    return null;
  }

  function displayForCursor() {
    try {
      const point = screen.getCursorScreenPoint();
      return screen.getDisplayNearestPoint(point);
    } catch (error) {
      return screen.getPrimaryDisplay();
    }
  }

  function layout() {
    const display = displayForCursor();
    const area = display.workArea;
    let bottom = area.y + area.height - 20;

    for (let index = order.length - 1; index >= 0; index -= 1) {
      const meta = windows.get(order[index]);
      if (!meta || !meta.window || meta.window.isDestroyed()) continue;

      bottom -= meta.height;
      meta.window.setBounds({
        x: Math.round(area.x + area.width - meta.width - 20),
        y: Math.round(bottom),
        width: meta.width,
        height: meta.height
      });
      bottom -= 12;
    }
  }

  function cleanup(id) {
    const meta = windows.get(id);
    if (meta?.timer) clearTimeout(meta.timer);
    windows.delete(id);
    const index = order.indexOf(id);
    if (index >= 0) order.splice(index, 1);
    layout();
  }

  function close(id, animated = true) {
    const meta = windows.get(id);
    if (!meta || !meta.window || meta.window.isDestroyed()) {
      cleanup(id);
      return;
    }
    if (meta.closing) return;
    meta.closing = true;

    if (meta.timer) {
      clearTimeout(meta.timer);
      meta.timer = null;
    }

    if (animated) {
      meta.window.webContents
        .executeJavaScript('document.getElementById("toastCard")?.classList.add("fade-out")')
        .catch(() => {});
      setTimeout(() => {
        if (!meta.window.isDestroyed()) meta.window.close();
      }, 220);
    } else if (!meta.window.isDestroyed()) {
      meta.window.close();
    }
  }

  function closeOldest() {
    const oldest = order[0];
    if (oldest) close(oldest, false);
  }

  function showToast({ title = '', message = '', buttons = null, timespan = 15_000, callback = null, type = 'info' } = {}) {
    if (windows.size >= maxToasts) closeOldest();

    const id = `toast_${Date.now()}_${++counter}`;
    const safeTitle = escapeHtml(stripControlChars(title, 200));
    const safeMessage = escapeHtml(stripControlChars(message, 4000));
    const logo = getLogo();

    let normalized = null;
    if (buttons === true) {
      normalized = [
        { label: 'Yes', type: 'yes', close: true },
        { label: 'No', type: 'default', close: true }
      ];
    } else if (Array.isArray(buttons) && buttons.length > 0) {
      normalized = buttons.slice(0, 4).map((button) => ({
        label: stripControlChars(button?.label ?? 'OK', 40),
        type: ['yes', 'danger', 'primary', 'warning'].includes(button?.type) ? button.type : 'default',
        actionKey: typeof button?.actionKey === 'string' ? button.actionKey : null,
        close: button?.close !== false
      }));
    }

    const buttonHtml = normalized
      ? `<div class="buttons">${normalized.map((button, index) => (
        `<button class="${button.type}" data-index="${index}" onclick="window.toastActions.click('${id}', ${index})">${escapeHtml(button.label)}</button>`
      )).join('')}</div>`
      : '';

    const toastHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'unsafe-inline'">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:auto;height:auto;overflow:hidden;background:transparent}
body{font-family:'Poppins',-apple-system,'Segoe UI',sans-serif;padding:0}
.toast-card{width:max-content;min-width:280px;max-width:420px;background:rgba(25,25,25,.96);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:14px;color:#f0f0f0;display:flex;flex-direction:column;animation:slideIn .25s ease;box-shadow:0 12px 30px rgba(0,0,0,.45)}
@keyframes slideIn{from{transform:translateX(90px);opacity:0}to{transform:translateX(0);opacity:1}}
@keyframes slideOut{from{transform:translateX(0);opacity:1}to{transform:translateX(90px);opacity:0}}
.toast-card.fade-out{animation:slideOut .22s ease forwards}
.head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.head img{width:18px;height:18px;border-radius:4px;object-fit:cover}
h2{font-size:.95rem}
p{font-size:.78rem;color:#b3b3b3;margin-bottom:12px;line-height:1.4;white-space:pre-wrap}
.buttons{display:flex;gap:8px}
button{flex:1;padding:8px 12px;font-size:.75rem;border:1px solid rgba(255,255,255,.1);border-radius:6px;cursor:pointer;background:rgba(255,255,255,.08);color:#f0f0f0;font-family:inherit}
button:hover{background:rgba(255,255,255,.15)}
button.yes{background:rgba(74,222,128,.2);border-color:rgba(74,222,128,.4)}
button.danger{background:rgba(248,113,113,.2);border-color:rgba(248,113,113,.4)}
button.primary{background:rgba(59,246,131,.2);border-color:rgba(59,246,131,.4)}
button.warning{background:rgba(245,158,11,.2);border-color:rgba(245,158,11,.4)}
</style>
</head>
<body>
<div class="toast-card" id="toastCard">
<div class="head">${logo ? `<img src="${logo}" alt="rblxswap" />` : ''}<h2>${safeTitle}</h2></div>
<p>${safeMessage}</p>
${buttonHtml}
</div>
</body>
</html>`;

    const toastWindow = new BrowserWindow({
      width: 320,
      height: 96,
      x: 0,
      y: 0,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      resizable: false,
      movable: false,
      focusable: false,
      icon: iconPath,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: preloadPath
      }
    });

    const meta = {
      id,
      window: toastWindow,
      width: 320,
      height: 96,
      timer: null,
      callback,
      buttons: normalized,
      closing: false,
      type
    };

    windows.set(id, meta);
    order.push(id);
    layout();

    toastWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(toastHtml)}`);

    toastWindow.webContents.once('did-finish-load', async () => {
      if (!toastWindow || toastWindow.isDestroyed()) return;

      try {
        const measured = await toastWindow.webContents.executeJavaScript(`(() => {
          const card = document.getElementById('toastCard');
          if (!card) return { width: 320, height: 96 };
          const rect = card.getBoundingClientRect();
          return { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
        })()`);

        meta.width = Math.min(Math.max(measured.width, 280), 440);
        meta.height = Math.min(Math.max(measured.height, 88), 320);
        layout();
      } catch (error) {
        // Keep the default size.
      }

      toastWindow.showInactive();
    });

    meta.timer = setTimeout(() => close(id, true), Math.max(1_000, Number(timespan) || 15_000));

    toastWindow.on('closed', () => cleanup(id));

    return id;
  }

  function handleAction(action, toastId, index) {
    const meta = windows.get(toastId);
    if (!meta) return;

    if (action === 'click' && meta.buttons && Number.isInteger(index)) {
      const button = meta.buttons[index];
      if (!button) return;

      const handler = button.actionKey ? actions.get(button.actionKey) : null;
      try {
        if (typeof handler === 'function') handler();
        else if (typeof meta.callback === 'function') meta.callback(index === 0);
      } catch (error) {
        logger.append('warn', `toast action failed: ${error.message}`);
      }

      if (button.close !== false) close(toastId, true);
      return;
    }

    if (action === 'yes' || action === 'no') {
      try {
        if (typeof meta.callback === 'function') meta.callback(action === 'yes');
      } catch (error) {
        logger.append('warn', `toast callback failed: ${error.message}`);
      }
      close(toastId, true);
    }
  }

  function destroyAll() {
    for (const id of [...order]) close(id, false);
  }

  return { showToast, registerAction, handleAction, destroyAll, close, layout };
}

module.exports = { createToastManager };
