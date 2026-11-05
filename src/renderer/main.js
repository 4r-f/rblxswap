
const $ = (id) => document.getElementById(id);
const defaultTheme = {
  'bg-base': '#101010',
  'bg-accent': '#191919',
  'text-main': '#f0f0f0',
  'good': '#4ade80',
  'bad': '#f87171',
  'bg-img': '',
  'hide-grid': false
};

const state = {
  config: null,
  info: null,
  adapters: [],
  selectedGuid: null,
  plan: null,
  confirmAction: null,
  anticheatProceed: null,
  updateVersion: null,
  updateUrl: null,
  view: 'home',
  settingsTab: 'general',
  busy: false,
  health: null,
  quickMode: false,
  logTarget: 'mac'
};

let colorPicker = null;

// --- helpers --------------------------------------------------------------

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}

function normalizeMac(input) {
  const hex = String(input || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  return hex.length === 12 ? hex.match(/.{2}/g).join('-') : null;
}

function randomMacValue(original, mirror) {
  const source = normalizeMac(original);
  const bytes = [];
  const randomByte = () => crypto.getRandomValues(new Uint8Array(1))[0];

  if (mirror && source) {
    const oui = source.split('-').map((part) => parseInt(part, 16));
    bytes.push((oui[0] & 0xfe) | 0x02, oui[1], oui[2]);
  } else {
    bytes.push((randomByte() & 0xfe) | 0x02, randomByte(), randomByte());
  }

  bytes.push(randomByte(), randomByte(), randomByte());
  return bytes.map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join('-');
}

function toast(title, message, buttons = null, timespan = 6000) {
  api.showToast({ title, message, buttons, timespan });
}

function setStatus(text) {
  const badge = $('botStatus');
  if (badge) badge.textContent = text;
}

function openModal(id) {
  const modal = $(id);
  if (!modal) return;
  modal.style.display = 'flex';
  modal.setAttribute('aria-hidden', 'false');
}

function closeModal(id) {
  const modal = $(id);
  if (!modal) return;
  modal.style.display = 'none';
  modal.setAttribute('aria-hidden', 'true');
}

function closeTopModal() {
  const open = Array.from(document.querySelectorAll('.modal')).filter((modal) => modal.style.display === 'flex');
  if (!open.length) return;

  const top = open[open.length - 1];
  if (top.id === 'helpModal') {
    closeHelp();
    return;
  }

  closeModal(top.id);
}

function mlog(message, color = '#888') {
  const box = $('macLogs');
  if (!box) return;
  if (box.childElementCount === 1 && box.firstElementChild?.dataset.placeholder === '1') {
    box.textContent = '';
  }
  const line = document.createElement('div');
  line.textContent = `> ${message}`;
  line.style.color = color;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function appendLoaderLog(level, message) {
  const box = $('loaderLog');
  if (!box) return;
  const line = document.createElement('div');
  line.textContent = message;
  line.className = `log-${level}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

// --- theme ----------------------------------------------------------------

function applyThemeVar(key, value) {
  const root = document.documentElement;

  if (key === 'bg-img') {
    const layer = $('bg-img-layer');
    const image = typeof value === 'string' ? value : '';
    if (layer) layer.style.backgroundImage = image ? `url(${JSON.stringify(image)})` : 'none';

    const name = $('bgImgName');
    const clear = $('bgImgClear');
    const hidden = $('bgImgHidden');
    if (hidden && hidden.value !== image) hidden.value = image;

    if (name) {
      name.textContent = image ? image.split('/').pop().split('\\').pop() : t('theme.none');
    }
    if (clear) clear.style.display = image ? 'inline-flex' : 'none';
    return;
  }

  if (key === 'hide-grid') {
    root.style.setProperty('--grid-display', value ? 'none' : 'block');
    const check = $('chkHideGrid');
    if (check) check.checked = Boolean(value);
    return;
  }

  root.style.setProperty(`--${key}`, value);
  if (colorPicker) colorPicker.setValue(key, value);
}

function syncThemePickers(theme) {
  for (const picker of document.querySelectorAll('.theme-picker[data-tk]')) {
    const key = picker.dataset.tk;
    if (!(key in theme)) continue;
    const swatch = picker.querySelector('.color-swatch');
    const hexText = picker.querySelector('.hexTxt');
    if (swatch) swatch.style.background = theme[key];
    if (hexText) hexText.textContent = theme[key];
  }
}

function applyTheme() {
  const theme = { ...defaultTheme, ...(state.config?.theme || {}) };
  for (const [key, value] of Object.entries(theme)) applyThemeVar(key, value);
  syncThemePickers(theme);
}

function saveTheme(key, value) {
  if (!state.config) return;
  state.config.theme = { ...state.config.theme, [key]: value };
  api.setConfig({ theme: state.config.theme });
}

function resetTheme() {
  state.config.theme = { ...defaultTheme };
  applyTheme();
  api.setConfig({ theme: state.config.theme });
  toast(t('toast.saved'), t('theme.reset'));
}

function handleBgFile(file) {
  if (!file) return;
  const filePath = file.path;
  if (!filePath) {
    toast(t('toast.error'), 'File path unavailable');
    return;
  }

  const url = `file:///${filePath.replace(/\\/g, '/')}`;
  applyThemeVar('bg-img', url);
  saveTheme('bg-img', url);
}

function clearBg() {
  const input = $('bgImgFile');
  if (input) input.value = '';
  applyThemeVar('bg-img', '');
  saveTheme('bg-img', '');
}

// --- views ----------------------------------------------------------------

function showView(id) {
  for (const view of document.querySelectorAll('.view')) view.classList.remove('active');
  const target = $(`view_${id}`);
  if (!target) return;

  target.classList.add('active');
  state.view = id;

  if (id === 'settings') loadSettingsUI();
  if (id === 'mac') loadAdapters(true);
  if (id === 'home') {
    refreshBackupStatus();
    refreshHealth();
  }
}

function switchSettingsTab(name) {
  state.settingsTab = name;
  for (const tab of ['general', 'custom', 'profiles']) {
    const panel = $(`tab_${tab}`);
    const button = $(`settab_${tab}`);
    if (panel) panel.style.display = tab === name ? 'block' : 'none';
    if (button) button.classList.toggle('active', tab === name);
  }
}

function toggleSetWeao() {
  const isWeao = document.querySelector('input[name="setType"]:checked')?.value === 'weao';
  const box = $('setWeaoOpt');
  if (box) box.style.display = isWeao ? 'block' : 'none';
}

function toggleSpoofMode() {
  const isSimple = document.querySelector('input[name="spoofMode"]:checked')?.value === 'simple';
  const simple = $('mac_simple_ui');
  const advanced = $('mac_advanced_ui');
  if (simple) simple.style.display = isSimple ? 'block' : 'none';
  if (advanced) advanced.style.display = isSimple ? 'none' : 'block';
}

function setRadio(name, value) {
  const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
}

// --- config / settings ----------------------------------------------------

function loadSettingsUI() {
  const config = state.config;
  if (!config) return;

  setRadio('setType', config.launcherType || 'default');
  setRadio('spoofMode', config.spoofMode || 'simple');

  const bind = (id, value) => {
    const element = $(id);
    if (element) element.checked = Boolean(value);
  };

  bind('chkMinimizeClose', config.minimizeClose);
  bind('chkUseTrash', config.useTrash !== false);
  bind('chkAutoClean', config.autoCleanOnExit);
  bind('chkQuickSpoof', config.quickSpoof !== false);
  bind('chkWatcher', config.watcherEnabled !== false);
  bind('chkPreserveSettings', config.preserveSettings);
  bind('chkPreserveFastflags', config.preserveFastflags);
  bind('chkDeleteStudio', config.deleteStudio);
  bind('chkPurgeAuth', config.purgeAuth !== false);
  bind('chkRestorePoint', config.restorePoint);
  bind('chkAllowUnsigned', config.updates?.allowUnsigned);

  const language = $('selLanguage');
  if (language) language.value = config.language || 'en';
  const channel = $('selChannel');
  if (channel) channel.value = config.updates?.channel || 'stable';
  const repo = $('inpUpdateRepo');
  if (repo) repo.value = config.updates?.repo || '';

  refreshFolderLabel();

  toggleSetWeao();
  toggleSpoofMode();
  switchSettingsTab(state.settingsTab);
  applyTheme();
}

function refreshFolderLabel() {
  const folder = $('txtSetWeao');
  if (folder) folder.textContent = state.config?.weblauncherDir || t('settings.folder.none');
}

async function saveSettings() {
  if (!state.config) return;

  const launcherType = document.querySelector('input[name="setType"]:checked')?.value || 'default';
  const spoofMode = document.querySelector('input[name="spoofMode"]:checked')?.value || 'simple';
  const weblauncherDir = launcherType === 'weao' ? state.config.weblauncherDir : null;

  if (launcherType === 'weao' && !weblauncherDir) {
    toast(t('toast.error'), 'Select the WebLauncher folder first');
    switchSettingsTab('general');
    return;
  }

  const repo = String($('inpUpdateRepo')?.value || '').trim();
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    toast(t('toast.error'), t('settings.repo'));
    return;
  }

  const payload = {
    launcherType,
    spoofMode,
    weblauncherDir,
    minimizeClose: $('chkMinimizeClose')?.checked ?? true,
    useTrash: $('chkUseTrash')?.checked ?? true,
    autoCleanOnExit: $('chkAutoClean')?.checked ?? false,
    quickSpoof: $('chkQuickSpoof')?.checked ?? true,
    watcherEnabled: $('chkWatcher')?.checked ?? true,
    preserveSettings: $('chkPreserveSettings')?.checked ?? false,
    preserveFastflags: $('chkPreserveFastflags')?.checked ?? false,
    deleteStudio: $('chkDeleteStudio')?.checked ?? false,
    purgeAuth: $('chkPurgeAuth')?.checked ?? true,
    restorePoint: $('chkRestorePoint')?.checked ?? false,
    language: $('selLanguage')?.value || 'en',
    updates: {
      ...state.config.updates,
      channel: $('selChannel')?.value || 'stable',
      allowUnsigned: $('chkAllowUnsigned')?.checked ?? false,
      repo: repo || state.config.updates.repo
    }
  };

  const result = await api.setConfig(payload);
  if (result?.ok) {
    state.config = result.config;
    initI18n(state.config.language);
    applyTranslations();
    applyTheme();
    refreshFolderLabel();
    toast(t('toast.saved'), t('settings.title'));
    showView('home');
  }
}

async function changeLanguage(language) {
  setLanguage(language);
  state.config.language = language;
  await api.setConfig({ language });
  applyTranslations();
  applyTheme();
  refreshFolderLabel();
  renderMacState();
  await refreshBackupStatus();
}

async function scanWeblauncher() {
  const label = $('txtSetWeao');
  if (label) label.textContent = 'Scanning...';

  const result = await api.scanWeblauncher();
  if (result?.directory) {
    state.config.weblauncherDir = result.directory;
    if (label) label.textContent = result.directory;
    await api.setConfig({ weblauncherDir: result.directory });
  } else if (label) {
    label.textContent = 'Not found. Please browse.';
  }
}

async function browseWeblauncher() {
  const result = await api.selectDirectory();
  if (result?.directory) {
    state.config.weblauncherDir = result.directory;
    const label = $('txtSetWeao');
    if (label) label.textContent = result.directory;
    await api.setConfig({ weblauncherDir: result.directory });
  }
}

// --- adapters / MAC -------------------------------------------------------

async function loadAdapters(force = false) {
  if (!state.config) return;
  if (state.adapters.length && !force) {
    renderMacState();
    return;
  }

  const result = await api.listAdapters();
  state.adapters = Array.isArray(result?.adapters) ? result.adapters : [];

  const select = $('selAdapter');
  if (!select) return;

  select.innerHTML = '';

  if (state.adapters.length === 0) {
    const option = document.createElement('option');
    option.textContent = t('mac.noAdapters');
    option.value = '';
    select.appendChild(option);
    const original = $('macOriginalVal');
    if (original) original.textContent = '—';
    mlog(t('mac.noAdapters'), 'var(--bad)');
    mlog('Run rblxswap as administrator and make sure Wi-Fi/Ethernet is enabled.', '#888');
    return;
  }

  for (const adapter of state.adapters) {
    const option = document.createElement('option');
    option.value = adapter.guid;
    option.textContent = adapter.description || adapter.name;
    select.appendChild(option);
  }

  if (!state.adapters.some((adapter) => adapter.guid === state.selectedGuid)) {
    state.selectedGuid = state.adapters[0].guid;
  }
  select.value = state.selectedGuid;

  const input = $('inpMac');
  if (input && !input.value) {
    input.value = randomMacValue(selectedAdapter()?.mac, $('chkMirror')?.checked !== false);
  }

  renderMacState();
}

function selectedAdapter() {
  return state.adapters.find((adapter) => adapter.guid === state.selectedGuid) || state.adapters[0] || null;
}

function renderMacState() {
  const adapter = selectedAdapter();
  const original = $('macOriginalVal');
  if (original) original.textContent = adapter?.mac || '—';

  const input = $('inpMac');
  const badge = $('macSpoofBadge');
  if (!input || !badge) return;

  if (!input.value) input.value = randomMacValue(adapter?.mac, $('chkMirror')?.checked !== false);

  const isSpoofed = !adapter?.mac || input.value.toUpperCase() !== String(adapter.mac).toUpperCase();
  input.classList.toggle('mac-spoofed', isSpoofed);
  badge.textContent = isSpoofed ? t('mac.spoofed') : t('mac.originalBadge');
  badge.style.color = isSpoofed ? 'var(--good)' : '#999';
  badge.style.background = isSpoofed ? 'rgba(74,222,128,0.15)' : 'rgba(255,255,255,0.06)';
  badge.style.borderColor = isSpoofed ? 'rgba(74,222,128,0.35)' : 'rgba(255,255,255,0.12)';
}

function toggleAllAdapters() {
  const all = $('chkAllAdapters')?.checked === true;
  const select = $('selAdapter');
  const input = $('inpMac');
  if (select) {
    select.disabled = all;
    select.style.opacity = all ? '0.5' : '1';
  }
  if (input) {
    input.disabled = all;
    input.style.opacity = all ? '0.5' : '1';
  }
}

function shuffleMac() {
  const input = $('inpMac');
  if (!input) return;
  input.value = randomMacValue(selectedAdapter()?.mac, $('chkMirror')?.checked !== false);
  input.classList.remove('rolling');
  void input.offsetWidth;
  input.classList.add('rolling');
  renderMacState();
}

function readTargets() {
  return {
    mac: $('chkSpoofMac')?.checked !== false,
    hwid: $('chkSpoofHwid')?.checked !== false,
    volume: $('chkSpoofVolume')?.checked === true
  };
}

async function saveSpoofTargets() {
  const targets = readTargets();
  state.config.spoofTargets = targets;
  await api.setConfig({ spoofTargets: targets });
}

function openAnticheat(detections, onProceed) {
  state.anticheatProceed = onProceed;
  const title = $('acTitle');
  if (title) title.textContent = `${detections.map((item) => item.name).join(' + ')}`;

  const box = $('acSteps');
  if (box) {
    box.innerHTML = '';
    for (const detection of detections) {
      for (const step of detection.steps || []) {
        if (step.c) {
          const row = document.createElement('div');
          row.className = 'ac-cmd';

          const code = document.createElement('code');
          code.textContent = step.c;

          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'ac-copy';
          button.textContent = 'Copy';
          button.addEventListener('click', async () => {
            try {
              await navigator.clipboard.writeText(step.c);
              button.textContent = 'Copied';
              setTimeout(() => { button.textContent = 'Copy'; }, 1200);
            } catch (error) {
              // Clipboard may be unavailable.
            }
          });

          row.appendChild(code);
          row.appendChild(button);
          box.appendChild(row);
        } else {
          const paragraph = document.createElement('p');
          paragraph.className = 'ac-step';
          paragraph.textContent = step.t;
          box.appendChild(paragraph);
        }
      }
    }
  }

  openModal('anticheatModal');
}

function closeAnticheat() {
  state.anticheatProceed = null;
  closeModal('anticheatModal');
}

function proceedAnticheat() {
  const proceed = state.anticheatProceed;
  closeModal('anticheatModal');
  state.anticheatProceed = null;
  if (typeof proceed === 'function') proceed();
}

// --- spoof / restore ------------------------------------------------------

async function runSpoofFlow() {
  const targets = readTargets();
  if (!targets.mac && !targets.hwid && !targets.volume) {
    toast(t('toast.error'), t('mac.nothing'));
    return;
  }

  const advanced = state.config.spoofMode === 'advanced';
  if (advanced && targets.mac && !normalizeMac($('inpMac')?.value)) {
    toast(t('toast.error'), t('mac.invalidMac'));
    return;
  }

  const detected = await api.detectAnticheat();
  const detections = Array.isArray(detected?.detections) ? detected.detections : [];

  if (detections.length > 0) {
    openAnticheat(detections, () => performSpoof(targets));
    return;
  }

  await performSpoof(targets);
}

async function performSpoof(targets) {
  state.logTarget = 'mac';
  closeModal('anticheatModal');
  showView('mac');

  const box = $('macLogs');
  if (box) box.textContent = '';
  setStatus('Spoofing...');

  const advanced = state.config.spoofMode === 'advanced';
  const options = {
    targets,
    allAdapters: !advanced || $('chkAllAdapters')?.checked === true,
    adapterGuid: $('selAdapter')?.value || state.selectedGuid,
    mac: advanced ? $('inpMac')?.value : null,
    mirror: $('chkMirror')?.checked !== false,
    dhcp: advanced ? $('chkDhcp')?.checked === true : false
  };

  const result = await api.runSpoof(options);

  if (result?.ok) {
    toast(t('toast.spoofDone'), t('toast.spoofDone'), [{ label: t('common.ok'), type: 'primary' }], 5000);
    setStatus('Spoofed');
  } else {
    const detail = result?.error || (result?.errors || []).join('\n') || t('toast.error');
    toast(t('toast.spoofFailed'), detail, [{ label: t('common.ok'), type: 'danger' }], 9000);
    setStatus('Error');
  }

  await refreshBackupStatus();
  await refreshHealth();
}

async function revert() {
  const exists = await api.hwidBackupExists();
  if (exists?.exists) {
    openRestore();
    return;
  }

  openConfirm(t('confirm.revert.title'), t('confirm.revert.message'), async () => {
    const result = await api.listAdapters();
    const adapters = Array.isArray(result?.adapters) ? result.adapters : [];
    let errors = 0;

    for (const adapter of adapters) {
      const reset = await api.resetAdapter(adapter.guid);
      if (reset?.ok) await api.restartAdapter(adapter.guid);
      else errors += 1;
    }

    toast(t('toast.saved'), errors ? `${errors} error(s)` : t('common.done'));
    await refreshBackupStatus();
    await refreshHealth();
  });
}

function setHealthChip(element, text, status) {
  if (!element) return;
  element.textContent = text;
  element.className = `health-chip${status ? ` ${status}` : ''}`;
}

async function refreshHealth() {
  let result;
  try {
    result = await api.getHealth();
  } catch (error) {
    return null;
  }
  if (!result?.ok) return null;

  state.health = result;

  if (result.elevated === true) {
    setHealthChip($('healthAdmin'), `${t('home.health.admin')}: ${t('home.health.ok')}`, 'ok');
  } else if (result.elevated === false) {
    setHealthChip($('healthAdmin'), `${t('home.health.admin')}: ${t('home.health.no')}`, 'bad');
  } else {
    setHealthChip($('healthAdmin'), `${t('home.health.admin')}: ${t('home.health.unknown')}`, '');
  }

  setHealthChip(
    $('healthRoblox'),
    `${t('home.health.roblox')}: ${result.robloxRunning ? t('home.health.robloxOpen') : t('home.health.robloxClosed')}`,
    result.robloxRunning ? 'warn' : 'ok'
  );

  setHealthChip(
    $('healthBackup'),
    `${t('home.health.backup')}: ${result.backupExists ? t('home.health.backupYes') : t('home.health.backupNo')}`,
    result.backupExists ? 'ok' : ''
  );

  const banner = $('adminBanner');
  if (banner) banner.style.display = result.elevated === false ? 'flex' : 'none';

  return result;
}

async function quickStart() {
  if (state.busy) return;

  const health = await refreshHealth();

  if (health?.elevated === false) {
    openModal('adminModal');
    return;
  }

  if (health?.robloxRunning) {
    openConfirm(t('quick.robloxTitle'), t('quick.robloxMsg'), () => planCleanupAndShow(true));
    return;
  }

  await planCleanupAndShow(true);
}

async function planCleanupAndShow(quick) {
  if (state.busy) return;

  if (state.config.launcherType === 'weao' && !state.config.weblauncherDir) {
    showView('settings');
    toast(t('toast.error'), 'Select the WebLauncher folder first');
    return;
  }

  state.busy = true;
  state.quickMode = Boolean(quick);
  setStatus('Scanning...');

  try {
    const result = await api.planCleanup({ weblauncherDir: state.config.weblauncherDir });
    const plan = result?.plan;

    if (!plan || !plan.steps?.length) {
      toast(t('plan.title'), t('plan.empty'));
      return;
    }

    state.quickMode = Boolean(quick);
    state.plan = plan;
    renderPlan(plan);
    openModal('planModal');
  } finally {
    state.busy = false;
    setStatus(t('home.status.ready'));
  }
}

async function quickSpoofStep() {
  state.logTarget = 'loader';

  const title = $('loaderTitle');
  const desc = $('loaderDesc');
  const bar = $('loaderBar');
  if (title) {
    title.textContent = t('quick.spoofing');
    title.style.color = 'var(--text-main)';
  }
  if (desc) desc.textContent = t('mac.targets');
  if (bar) bar.style.width = '45%';

  const result = await api.runSpoof({
    targets: { mac: true, hwid: true, volume: false },
    allAdapters: true,
    mac: null,
    mirror: true,
    dhcp: false
  });

  state.logTarget = 'mac';
  if (bar) bar.style.width = '100%';

  await refreshHealth();
  await refreshBackupStatus();

  const spoofed = Boolean(result?.ok);
  const reboot = Boolean(result?.needsReboot);

  state.quickMode = false;

  const postTitle = $('postTitle');
  const postDesc = $('postDesc');
  const postReboot = $('postReboot');

  if (postTitle) postTitle.textContent = t('quick.doneTitle');
  if (postDesc) postDesc.textContent = spoofed ? t('quick.doneDesc') : t('quick.spoofFailed');
  if (postReboot) postReboot.style.display = spoofed && reboot ? 'block' : 'none';

  setStatus(spoofed ? t('common.done') : t('toast.spoofFailed'));
  setTimeout(() => showView('post'), 500);
}

function finishClean(failed, quick) {
  state.quickMode = false;

  const postTitle = $('postTitle');
  const postDesc = $('postDesc');
  const postReboot = $('postReboot');

  if (postTitle) postTitle.textContent = failed ? t('toast.cleanFailed') : t('quick.doneTitle');
  if (postDesc) postDesc.textContent = quick ? t('post.cleanOnly') : t('post.doneDesc');
  if (postReboot) postReboot.style.display = 'none';

  setStatus(failed ? `${failed} error(s)` : t('common.done'));
  setTimeout(() => showView('post'), 400);
}

async function relaunchAdmin() {
  const result = await api.relaunchAdmin();

  if (!result?.ok) {
    toast(t('toast.error'), result?.error || t('admin.desc'), [{ label: t('common.ok'), type: 'danger' }], 8000);
    return;
  }

  closeModal('adminModal');
  closeModal('helpModal');
  setStatus('Restarting...');
}

function closeAdmin() {
  closeModal('adminModal');
  planCleanupAndShow(false);
}

function openHelp(isWelcome = false) {
  const title = $('helpTitle');
  if (title) title.textContent = isWelcome ? t('help.welcome') : t('help.title');
  openModal('helpModal');
}

function closeHelp() {
  closeModal('helpModal');

  if (state.config && !state.config.onboardingDone) {
    state.config.onboardingDone = true;
    api.setConfig({ onboardingDone: true });
  }
}

async function applyRecommended() {
  const result = await api.setConfig({
    launcherType: 'default',
    weblauncherDir: null,
    spoofMode: 'simple',
    minimizeClose: true,
    useTrash: true,
    autoCleanOnExit: false,
    quickSpoof: true,
    watcherEnabled: true,
    preserveSettings: true,
    preserveFastflags: false,
    deleteStudio: false,
    purgeAuth: true,
    restorePoint: false,
    spoofTargets: { mac: true, hwid: true, volume: false }
  });

  if (result?.ok) {
    state.config = result.config;
    loadSettingsUI();
    toast(t('toast.saved'), t('toast.recommended'));
  }
}

async function refreshBackupStatus() {
  const dot = $('backupDot');
  const text = $('backupStatusText');
  if (!dot || !text) return;

  const result = await api.hwidBackupInfo();
  const info = result?.info;

  if (info?.exists) {
    const when = info.savedAt ? new Date(info.savedAt).toLocaleString() : t('common.unknown');
    dot.style.background = 'var(--good)';
    text.textContent = t('home.backup.at', { date: when });
  } else {
    dot.style.background = '#555';
    text.textContent = t('home.backup.none');
  }
}

async function openRestore() {
  const result = await api.hwidBackupInfo();
  const info = result?.info;

  if (!info?.exists) {
    toast(t('toast.backupMissing'), t('home.backup.none'));
    return;
  }

  const when = info.savedAt ? new Date(info.savedAt).toLocaleString() : t('common.unknown');
  const whenLabel = $('restoreWhen');
  if (whenLabel) whenLabel.textContent = t('restore.when', { date: when });

  const rows = [
    ['restoreRowMac', 'restoreMac', info.has?.mac],
    ['restoreRowHwid', 'restoreHwid', info.has?.guids],
    ['restoreRowVol', 'restoreVol', info.has?.volume]
  ];

  for (const [rowId, checkId, present] of rows) {
    const row = $(rowId);
    const check = $(checkId);
    if (row) row.style.display = present ? 'flex' : 'none';
    if (check) check.checked = Boolean(present);
  }

  const hint = $('restoreHwidHint');
  if (hint) {
    hint.textContent = info.serials?.machineGuid ? `(${info.serials.machineGuid.slice(0, 8)}…)` : '';
  }

  openModal('restoreModal');
}

async function executeRestore() {
  const options = {
    mac: $('restoreMac')?.checked === true,
    guids: $('restoreHwid')?.checked === true,
    volume: $('restoreVol')?.checked === true
  };

  if (!options.mac && !options.guids && !options.volume) {
    toast(t('toast.error'), t('mac.nothing'));
    return;
  }

  closeModal('restoreModal');
  showView('mac');

  const box = $('macLogs');
  if (box) box.textContent = '';

  mlog('Restoring selected identifiers...', '#aaa');
  const result = await api.restoreHwid(options);

  for (const item of result?.identifiers || []) {
    mlog(item.restored ? `Restored ${item.name}` : `Skipped ${item.name} (${item.reason})`,
      item.restored ? 'var(--good)' : 'var(--bad)');
  }

  for (const adapter of result?.adapters || []) {
    mlog(adapter.restored ? `Restored ${adapter.name}` : `Failed ${adapter.name} (${adapter.reason})`,
      adapter.restored ? 'var(--good)' : 'var(--bad)');
  }

  if (result?.volume) {
    mlog(result.volume.restored ? `Restored volume serial (${result.volume.drive})` : `Volume not restored (${result.volume.reason})`,
      result.volume.restored ? 'var(--good)' : 'var(--bad)');
  }

  toast(result?.ok ? t('toast.saved') : t('toast.error'),
    result?.ok ? t('common.done') : (result?.reason || t('toast.error')),
    [{ label: t('common.ok'), type: result?.ok ? 'primary' : 'danger' }]);
  await refreshBackupStatus();
  await refreshHealth();
}

// --- confirmation ---------------------------------------------------------

function openConfirm(title, message, action) {
  const titleNode = $('confirmTitle');
  const messageNode = $('confirmMsg');
  if (titleNode) titleNode.textContent = title;
  if (messageNode) messageNode.textContent = message;
  state.confirmAction = action;
  openModal('confirmModal');
}

function executeConfirm() {
  const action = state.confirmAction;
  state.confirmAction = null;
  closeModal('confirmModal');
  if (typeof action === 'function') action();
}

// --- cleanup --------------------------------------------------------------

async function startScan() {
  await planCleanupAndShow(false);
}

function renderPlan(plan) {
  const list = $('planList');
  if (!list) return;
  list.innerHTML = '';

  for (const step of plan.steps) {
    const row = document.createElement('div');
    row.className = 'plan-row';

    const label = document.createElement('div');
    label.className = 'plan-label';
    label.textContent = step.label;

    const meta = document.createElement('div');
    meta.className = 'plan-meta';

    if (step.kind === 'process') {
      meta.textContent = 'processes';
    } else if (step.kind === 'registry') {
      meta.textContent = `${step.keys.length} key(s)`;
    } else {
      meta.textContent = `${step.count} ${t('plan.files')} · ${formatBytes(step.bytes)}`;
    }

    if (step.requiresAdmin) {
      const badge = document.createElement('span');
      badge.className = 'plan-badge admin';
      badge.textContent = t('plan.admin');
      meta.appendChild(document.createTextNode(' '));
      meta.appendChild(badge);
    }

    if (step.danger) {
      const badge = document.createElement('span');
      badge.className = 'plan-badge danger';
      badge.textContent = t('plan.danger');
      meta.appendChild(document.createTextNode(' '));
      meta.appendChild(badge);
    }

    row.appendChild(label);
    row.appendChild(meta);
    list.appendChild(row);
  }

  const totals = $('planTotals');
  if (totals) {
    totals.textContent = `${plan.steps.length} ${t('plan.steps')} · ${plan.totals.count} ${t('plan.files')} · ${formatBytes(plan.totals.bytes)}`;
  }

  const warnings = $('planWarnings');
  if (warnings) {
    if (plan.warnings?.length) {
      warnings.style.display = 'block';
      warnings.textContent = `${t('plan.warnings')}: ${plan.warnings.join(' · ')}`;
    } else {
      warnings.style.display = 'none';
      warnings.textContent = '';
    }
  }

  const target = $('planTarget');
  if (target) {
    target.textContent = plan.target ? `WebLauncher: ${plan.target}` : '';
  }
}

async function confirmClean() {
  const quick = state.quickMode;
  closeModal('planModal');
  showView('loader');

  const title = $('loaderTitle');
  const desc = $('loaderDesc');
  const bar = $('loaderBar');
  const log = $('loaderLog');
  if (title) {
    title.textContent = t('loader.title');
    title.style.color = 'var(--text-main)';
  }
  if (desc) desc.textContent = t('loader.cleaning');
  if (bar) bar.style.width = '0%';
  if (log) log.textContent = '';

  const result = await api.runCleanup({});

  if (result?.ok && result.result) {
    const failed = result.result.failed?.length || 0;

    if (quick && state.config.quickSpoof && failed === 0) {
      await quickSpoofStep();
    } else {
      finishClean(failed, quick);
    }
  } else {
    const titleNode = $('loaderTitle');
    if (titleNode) {
      titleNode.textContent = t('toast.cleanFailed');
      titleNode.style.color = 'var(--bad)';
    }
    toast(t('toast.cleanFailed'), result?.error || t('toast.error'), [{ label: t('common.ok'), type: 'danger' }], 8000);
    setTimeout(() => showView('home'), 2500);
  }
}

// --- updates --------------------------------------------------------------

async function checkUpdates() {
  const status = $('updStatus');
  if (status) status.textContent = t('update.checking');

  const result = await api.checkUpdates();

  if (result?.error) {
    if (status) {
      status.textContent = result.code === 'not-found'
        ? t('update.notFound')
        : result.code === 'rate-limited'
          ? t('update.rateLimited')
          : t('update.failed');
    }
    return;
  }

  if (!result?.updateAvailable) {
    if (status) status.textContent = t('update.upToDate');
    return;
  }

  state.updateVersion = result.version;
  state.updateUrl = result.url;

  if (status) {
    status.textContent = t('update.available', { version: result.version });
    status.style.color = 'var(--good)';
    status.style.cursor = 'pointer';
  }

  const badge = $('vBadge');
  if (badge) {
    badge.style.borderColor = 'var(--good)';
    badge.style.background = 'rgba(74, 222, 128, 0.2)';
  }

  if (state.config.ignoredUpdate !== result.version) {
    const desc = $('updModalDesc');
    if (desc) desc.textContent = t('update.available', { version: result.version });
    openModal('updateModal');
  }
}

async function installLatest() {
  closeModal('updateModal');

  const status = $('updStatus');
  const badge = $('vBadge');
  if (status) status.textContent = t('update.downloading', { percent: 0 });
  if (badge) badge.textContent = t('update.downloading', { percent: 0 });

  const result = await api.installLatest();

  if (result?.ok) {
    if (result.packaged) {
      if (status) status.textContent = t('update.installing');
      toast(t('update.title'), t('update.installing'));
    } else {
      if (status) status.textContent = t('update.dev');
      toast(t('update.title'), t('update.dev'), null, 8000);
    }
    return;
  }

  let message = result?.error || t('update.failed');
  if (result?.error === 'unverified-update') message = t('update.noChecksum');
  if (result?.error === 'not-found' || result?.code === 'not-found') message = t('update.notFound');
  if (result?.error === 'rate-limited' || result?.code === 'rate-limited') message = t('update.rateLimited');
  if (result?.error === 'up-to-date') message = t('update.upToDate');

  if (status) status.textContent = message;
  toast(t('update.failed'), message, [{ label: t('common.ok'), type: 'danger' }], 8000);
}

async function ignoreUpdate() {
  closeModal('updateModal');
  if (!state.updateVersion) return;
  state.config.ignoredUpdate = state.updateVersion;
  await api.setConfig({ ignoredUpdate: state.updateVersion });
}

// --- diagnostics ----------------------------------------------------------

async function openDiagnostics() {
  const result = await api.getDiagnostics();
  const output = $('diagOutput');
  if (output) output.textContent = JSON.stringify(result?.diagnostics || result, null, 2);
  openModal('diagnosticsModal');
}

async function copyDiagnostics() {
  const output = $('diagOutput');
  if (!output) return;
  try {
    await navigator.clipboard.writeText(output.textContent || '');
    const button = $('diagCopy');
    if (button) {
      const original = button.textContent;
      button.textContent = t('diag.copied');
      setTimeout(() => { button.textContent = original; }, 1200);
    }
  } catch (error) {
    // Clipboard unavailable.
  }
}

// --- profiles -------------------------------------------------------------

async function refreshProfiles() {
  const result = await api.listProfiles();
  const profiles = Array.isArray(result?.profiles) ? result.profiles : [];
  const select = $('profileSelect');
  const empty = $('profileEmpty');
  if (!select) return;

  select.innerHTML = '';
  for (const profile of profiles) {
    const option = document.createElement('option');
    option.value = profile.name;
    option.textContent = profile.name;
    select.appendChild(option);
  }

  if (empty) empty.style.display = profiles.length ? 'none' : 'block';
}

async function saveProfile() {
  const name = $('profileName')?.value?.trim();
  if (!name) {
    toast(t('toast.error'), t('profiles.name'));
    return;
  }

  const result = await api.saveProfile(name);
  if (result?.ok) {
    await refreshProfiles();
    toast(t('toast.saved'), name);
  } else {
    toast(t('toast.error'), result?.error || t('toast.error'));
  }
}

async function applyProfile() {
  const name = $('profileSelect')?.value;
  if (!name) return;

  const result = await api.applyProfile(name);
  if (result?.ok) {
    state.config = result.config;
    loadSettingsUI();
    toast(t('toast.saved'), name);
  } else {
    toast(t('toast.error'), result?.error || t('toast.error'));
  }
}

async function deleteProfile() {
  const name = $('profileSelect')?.value;
  if (!name) return;

  const result = await api.deleteProfile(name);
  if (result?.ok) await refreshProfiles();
}

// --- theme export / import ------------------------------------------------

async function exportTheme() {
  const result = await api.exportTheme();
  if (result?.ok) toast(t('theme.export'), result.path);
}

async function importTheme() {
  const result = await api.importTheme();
  if (result?.ok) {
    state.config.theme = result.theme;
    applyTheme();
    toast(t('theme.import'), t('common.done'));
  }
}

// --- misc -----------------------------------------------------------------

function confetti() {
  for (let index = 0; index < 15; index += 1) {
    setTimeout(() => {
      const image = document.createElement('img');
      image.src = '../assets/bao.png';
      image.className = 'bao-confetti';
      image.alt = '';
      image.style.left = `${Math.random() * 100}vw`;
      const scale = 0.5 + Math.random();
      image.style.width = `${32 * scale}px`;
      image.style.height = `${32 * scale}px`;
      image.style.animationDuration = `${1.5 + Math.random()}s`;
      image.style.animationDelay = `${Math.random() * 0.5}s`;
      document.body.appendChild(image);
      setTimeout(() => image.remove(), 3000);
    }, index * 50);
  }
}

function showWelcomeToasts() {
  toast(
    t('toast.welcome.title'),
    t('toast.welcome.message'),
    [{ label: ':bao:', type: 'default', actionKey: 'fun:bao_confetti' }],
    5000
  );

  setTimeout(() => {
    toast(
      t('toast.discord.title'),
      t('toast.discord.message'),
      [{ label: t('toast.discord.button'), type: 'primary', actionKey: 'open:weao-discord' }],
      9000
    );
  }, 800);
}

// --- event wiring ---------------------------------------------------------

const actions = {
  'show-view': (element) => showView(element.dataset.arg),
  'hide-window': () => api.hideWindow(),
  'start-scan': () => startScan(),
  'quick-start': () => quickStart(),
  'relaunch-admin': () => relaunchAdmin(),
  'open-help': () => openHelp(false),
  'close-help': () => closeHelp(),
  'close-admin': () => closeAdmin(),
  'apply-recommended': () => applyRecommended(),
  'open-spoof': () => showView('mac'),
  'open-restore': () => openRestore(),
  revert: () => revert(),
  spoof: () => runSpoofFlow(),
  'shuffle-mac': () => shuffleMac(),
  'save-settings': () => saveSettings(),
  'scan-weblauncher': () => scanWeblauncher(),
  'browse-weblauncher': () => browseWeblauncher(),
  'settings-tab': (element) => switchSettingsTab(element.dataset.arg),
  'check-updates': () => checkUpdates(),
  'install-latest': () => installLatest(),
  'ignore-update': () => ignoreUpdate(),
  'update-later': () => closeModal('updateModal'),
  'reset-theme': () => resetTheme(),
  'choose-bg': () => $('bgImgFile')?.click(),
  'clear-bg': () => clearBg(),
  'open-color': (element) => colorPicker?.open(element),
  'open-diagnostics': () => openDiagnostics(),
  'copy-diagnostics': () => copyDiagnostics(),
  'close-modal': (element) => closeModal(element.dataset.arg),
  'confirm-ok': () => executeConfirm(),
  'confirm-clean': () => confirmClean(),
  'execute-restore': () => executeRestore(),
  'close-anticheat': () => closeAnticheat(),
  'proceed-anticheat': () => proceedAnticheat(),
  'open-logs': () => api.openLogs(),
  'export-theme': () => exportTheme(),
  'import-theme': () => importTheme(),
  'save-profile': () => saveProfile(),
  'apply-profile': () => applyProfile(),
  'delete-profile': () => deleteProfile(),
  'open-discord': () => api.openExternal('https://discord.gg/weaoxyz'),
  'open-update-url': () => state.updateUrl && api.openExternal(state.updateUrl),
  'test-toast': () => toast('Test toast', 'This is a test toast message.', true, 4000),
  confetti: () => confetti()
};

const changes = {
  'set-type': () => toggleSetWeao(),
  'spoof-mode': () => toggleSpoofMode(),
  targets: () => saveSpoofTargets(),
  'hide-grid': (element) => {
    applyThemeVar('hide-grid', element.checked);
    saveTheme('hide-grid', element.checked);
  },
  language: (element) => changeLanguage(element.value),
  adapter: (element) => {
    state.selectedGuid = element.value;
    const input = $('inpMac');
    if (input) input.value = randomMacValue(selectedAdapter()?.mac, $('chkMirror')?.checked !== false);
    renderMacState();
  },
  'all-adapters': () => toggleAllAdapters(),
  'allow-unsigned': () => {},
  channel: () => {},
  'mirror-mode': () => shuffleMac()
};

function bindEvents() {
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;

    const handler = actions[target.dataset.action];
    if (!handler) return;

    event.preventDefault();
    handler(target, event);
  });

  document.addEventListener('change', (event) => {
    const target = event.target.closest('[data-change]');
    if (!target) return;

    const handler = changes[target.dataset.change];
    if (handler) handler(target, event);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeTopModal();
      return;
    }

    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-action]')) {
      event.preventDefault();
      event.target.click();
    }
  });

  const bgInput = $('bgImgFile');
  if (bgInput) {
    bgInput.addEventListener('change', () => handleBgFile(bgInput.files?.[0]));
  }

  const tooltip = $('tooltip');
  document.addEventListener('mousemove', (event) => {
    if (!tooltip) return;

    const target = event.target.closest('[data-tooltip]');
    if (!target) {
      tooltip.style.opacity = '0';
      return;
    }

    tooltip.textContent = target.dataset.tooltip;
    tooltip.style.opacity = '1';

    let x = event.clientX;
    let y = event.clientY + 20;
    const width = tooltip.offsetWidth || 140;
    const height = tooltip.offsetHeight || 28;

    if (x + width / 2 > window.innerWidth - 10) x = window.innerWidth - width / 2 - 10;
    if (x - width / 2 < 10) x = width / 2 + 10;
    if (y + height > window.innerHeight - 10) y = event.clientY - height - 8;

    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  });

  api.onCommand((payload) => {
    if (!payload) return;
    if (payload.command === 'start-clean') {
      showView('home');
      startScan();
    } else if (payload.command === 'open-spoof') {
      showView('mac');
    } else if (payload.command === 'open-restore') {
      openRestore();
    } else if (payload.command === 'confetti') {
      confetti();
    }
  });

  api.onCleanerLog((data) => appendLoaderLog(data.level, data.message));
  api.onCleanerProgress((data) => {
    const bar = $('loaderBar');
    const desc = $('loaderDesc');
    if (bar) bar.style.width = `${data.total ? Math.round(((data.index + 1) / data.total) * 100) : 0}%`;
    if (desc && data.label) desc.textContent = data.label;
  });
  api.onCleanerStatus((data) => {
    const title = $('loaderTitle');
    if (title && data.status) title.textContent = data.status.charAt(0).toUpperCase() + data.status.slice(1);
  });

  api.onSpoofLog((data) => {
    const color = data.level === 'error' ? 'var(--bad)' : data.level === 'success' ? 'var(--good)' : '#aaa';
    if (state.logTarget === 'loader') appendLoaderLog(data.level, data.message);
    else mlog(data.message, color);
  });

  api.onSpoofProgress((data) => {
    if (!data?.step) return;
    setStatus(`${data.step}: ${data.status}`);
    if (state.logTarget === 'loader') {
      const bar = $('loaderBar');
      if (bar) bar.style.width = data.status === 'done' ? '90%' : '70%';
    }
  });

  api.onUpdateProgress((data) => {
    const status = $('updStatus');
    if (status && data.percentage !== undefined) {
      status.textContent = t('update.downloading', { percent: data.percentage });
    }
  });
}

// --- boot -----------------------------------------------------------------

async function init() {
  if (!hasBridge) {
    document.body.classList.add('no-bridge');
    return;
  }

  bindEvents();

  const info = await api.getAppInfo();
  if (!info?.ok) {
    toast(t('toast.error'), info?.error || 'Failed to load');
    return;
  }

  state.info = info;
  state.config = info.config;
  state.selectedGuid = null;

  const badge = $('vBadge');
  if (badge) badge.textContent = info.version;

  initI18n(state.config.language);
  applyTranslations();
  applyTheme();

  colorPicker = createColorPicker({
    onCommit: (key, hex) => {
      applyThemeVar(key, hex);
      saveTheme(key, hex);
    }
  });

  toggleSetWeao();
  toggleSpoofMode();
  toggleAllAdapters();
  setStatus(t('home.status.ready'));

  await Promise.all([refreshBackupStatus(), loadAdapters(false), refreshHealth()]);
  await refreshProfiles();
  checkUpdates();

  if (!state.config.onboardingDone) {
    setTimeout(() => openHelp(true), 400);
  } else {
    showWelcomeToasts();
  }
}

init().catch((error) => {
  console.error(error);
  toast(t('toast.error'), error?.message || 'Failed to start');
});
