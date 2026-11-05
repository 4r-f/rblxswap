/**
 * Custom HSV color picker used by the theme editor.
 * Returns an object with open(pickerElement) and close().
 */
function createColorPicker({ onCommit } = {}) {
  const popover = document.getElementById('colorPickr');
  const canvas = document.getElementById('cpCanvas');
  const cursor = document.getElementById('cpCvnCrsr');
  const hueTrack = document.getElementById('cpHueTrack');
  const hueThumb = document.getElementById('cpHueThmb');
  const hexInput = document.getElementById('cpHexInp');
  const preview = document.getElementById('cpPreview');

  if (!popover || !canvas || !hexInput) {
    return { open() {}, close() {} };
  }

  const context = canvas.getContext('2d');
  let hue = 0;
  let saturation = 1;
  let brightness = 0;
  let activePicker = null;
  let draggingCanvas = false;
  let draggingHue = false;

  function hsvToHex(h, s, v) {
    let r;
    let g;
    let b;
    const i = Math.floor(h / 60) % 6;
    const f = h / 60 - Math.floor(h / 60);
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);

    if (i === 0) { r = v; g = t; b = p; }
    else if (i === 1) { r = q; g = v; b = p; }
    else if (i === 2) { r = p; g = v; b = t; }
    else if (i === 3) { r = p; g = q; b = v; }
    else if (i === 4) { r = t; g = p; b = v; }
    else { r = v; g = p; b = q; }

    const toHex = (value) => Math.round(value * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  function hexToHsv(hex) {
    const clean = String(hex).replace('#', '');
    if (clean.length !== 6) return null;

    const r = parseInt(clean.slice(0, 2), 16) / 255;
    const g = parseInt(clean.slice(2, 4), 16) / 255;
    const b = parseInt(clean.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let h = 0;
    const s = max === 0 ? 0 : delta / max;
    const v = max;

    if (delta !== 0) {
      if (max === r) h = ((g - b) / delta + (g < b ? 6 : 0)) * 60;
      else if (max === g) h = ((b - r) / delta + 2) * 60;
      else h = ((r - g) / delta + 4) * 60;
    }

    return { h, s, v };
  }

  function drawCanvas(h) {
    const width = canvas.width;
    const height = canvas.height;
    const horizontal = context.createLinearGradient(0, 0, width, 0);
    horizontal.addColorStop(0, '#fff');
    horizontal.addColorStop(1, `hsl(${h},100%,50%)`);
    context.fillStyle = horizontal;
    context.fillRect(0, 0, width, height);

    const vertical = context.createLinearGradient(0, 0, 0, height);
    vertical.addColorStop(0, 'rgba(0,0,0,0)');
    vertical.addColorStop(1, 'rgba(0,0,0,1)');
    context.fillStyle = vertical;
    context.fillRect(0, 0, width, height);
  }

  function positionCursor() {
    const rect = canvas.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    cursor.style.left = `${rect.left - popoverRect.left + saturation * rect.width}px`;
    cursor.style.top = `${rect.top - popoverRect.top + brightness * rect.height}px`;
  }

  function positionHueThumb() {
    hueThumb.style.left = `${(hue / 360) * 100}%`;
  }

  function commit() {
    if (!activePicker) return;

    const hex = hsvToHex(hue, saturation, 1 - brightness);
    hexInput.value = hex.replace('#', '').toUpperCase();
    preview.style.background = hex;

    const swatch = activePicker.querySelector('.color-swatch');
    const hexText = activePicker.querySelector('.hexTxt');
    if (swatch) swatch.style.background = hex;
    if (hexText) hexText.textContent = hex;

    if (typeof onCommit === 'function') {
      onCommit(activePicker.dataset.tk, hex);
    }
  }

  function pickCanvas(event) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(event.clientX - rect.left, rect.width));
    const y = Math.max(0, Math.min(event.clientY - rect.top, rect.height));
    saturation = x / rect.width;
    brightness = y / rect.height;
    positionCursor();
    commit();
  }

  function pickHue(event) {
    const rect = hueTrack.getBoundingClientRect();
    const x = Math.max(0, Math.min(event.clientX - rect.left, rect.width));
    hue = (x / rect.width) * 360;
    drawCanvas(hue);
    positionHueThumb();
    commit();
  }

  canvas.addEventListener('mousedown', (event) => {
    draggingCanvas = true;
    pickCanvas(event);
  });

  hueTrack.addEventListener('mousedown', (event) => {
    draggingHue = true;
    pickHue(event);
  });

  document.addEventListener('mousemove', (event) => {
    if (draggingCanvas) pickCanvas(event);
    if (draggingHue) pickHue(event);
  });

  document.addEventListener('mouseup', () => {
    draggingCanvas = false;
    draggingHue = false;
  });

  hexInput.addEventListener('input', () => {
    const raw = hexInput.value.replace(/[^0-9a-fA-F]/g, '');
    hexInput.value = raw;
    if (raw.length !== 6 || !activePicker) return;

    const hsv = hexToHsv(raw);
    if (!hsv) return;

    hue = hsv.h;
    saturation = hsv.s;
    brightness = 1 - hsv.v;
    drawCanvas(hue);
    positionCursor();
    positionHueThumb();
    preview.style.background = `#${raw}`;

    const swatch = activePicker.querySelector('.color-swatch');
    const hexText = activePicker.querySelector('.hexTxt');
    if (swatch) swatch.style.background = `#${raw}`;
    if (hexText) hexText.textContent = `#${raw}`;

    if (typeof onCommit === 'function') onCommit(activePicker.dataset.tk, `#${raw}`);
  });

  document.addEventListener('mousedown', (event) => {
    if (popover.style.display !== 'none'
      && !popover.contains(event.target)
      && !event.target.closest('.theme-picker')) {
      popover.style.display = 'none';
      activePicker = null;
    }
  });

  function open(pickerElement) {
    if (!pickerElement) return;

    if (activePicker === pickerElement && popover.style.display !== 'none') {
      popover.style.display = 'none';
      activePicker = null;
      return;
    }

    activePicker = pickerElement;
    const hexText = pickerElement.querySelector('.hexTxt');
    let startHex = hexText ? hexText.textContent.trim() : '#888888';
    if (!startHex.startsWith('#')) startHex = `#${startHex}`;

    const hsv = hexToHsv(startHex) || { h: 0, s: 0, v: 1 };
    hue = hsv.h;
    saturation = hsv.s;
    brightness = 1 - hsv.v;

    drawCanvas(hue);
    positionHueThumb();
    popover.style.display = 'block';

    const rect = pickerElement.getBoundingClientRect();
    let top = rect.bottom + 6;
    let left = rect.left;
    const width = popover.offsetWidth || 224;
    const height = popover.offsetHeight || 220;

    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    if (top + height > window.innerHeight - 8) top = rect.top - height - 6;

    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;

    requestAnimationFrame(() => {
      positionCursor();
      hexInput.value = startHex.replace('#', '').toUpperCase();
      preview.style.background = startHex;
    });
  }

  function close() {
    popover.style.display = 'none';
    activePicker = null;
  }

  function setValue(key, hex) {
    const picker = document.querySelector(`.theme-picker[data-tk="${key}"]`);
    if (!picker) return;
    const swatch = picker.querySelector('.color-swatch');
    const hexText = picker.querySelector('.hexTxt');
    if (swatch) swatch.style.background = hex;
    if (hexText) hexText.textContent = hex;
  }

  return { open, close, setValue };
}
