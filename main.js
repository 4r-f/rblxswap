const APP_VERSION = "v0.3.0"; //? also update in package.json, and in the github release body/title for update checking to work (or else it will just assume any release is new lol)

///////////////

const { app, BrowserWindow, nativeTheme, ipcMain, dialog, Tray, Menu, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const fsPromises = fs.promises;
const execFileAsync = promisify(execFile);
const https = require('https');

const hwid = require('./hwid'); //? hardware id backup / spoof / restore engine

const isDev = !app.isPackaged;
let mainWindow;
const toastWindows = new Map();
let toastOrder = [];
let bypassRunning = false;
let appIsQuitting = false;
let tray = null;
let robloxPoller = null;
let wasRobloxRunning = false;
let robloxGracePeriod = 0;
let toastIdCounter = 0;
let toastLogoDataUrl = null;

function getConfigPath() {
	return path.join(app.getPath('userData'), 'config.json');
}

function getConfig() {
	try {
		const p = getConfigPath();
		if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
	} catch (e) {}
	return { 
		launcherType: 'default', weblauncherDir: null,
		minimizeClose: true,
		preserveSettings: true,
		preserveFastflags: false,
		deleteStudio: false,
		purgeAuth: true,
		restorePoint: false,
		spoofTargets: { mac: true, hwid: true, volume: false },
		theme: {
			"bg-base": "#101010",
			"bg-accent": "#191919",
			"text-main": "#f0f0f0",
			"good": "#4ade80",
			"bad": "#f87171",
			"bg-img": "",
			"hide-grid": false
		},
		spoofMode: 'simple'
	};
}

function setConfig(newConfig) {
	try {
		const current = getConfig();
		const updated = { ...current, ...newConfig };
		fs.writeFileSync(getConfigPath(), JSON.stringify(updated, null, 2), 'utf8');
		return updated;
	} catch (e) {}
	return newConfig;
}

function createWindow() {
	const windowOptions = {
		width: 480,
		height: 400,
		frame: false,
		transparent: true,
		resizable: false,
		fullscreenable: false,
		show: false,
		titleBarStyle: 'hidden',
		alwaysOnTop: false,
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			nodeIntegration: false,
			contextIsolation: true,
			devTools: isDev
		}
	};

	mainWindow = new BrowserWindow(windowOptions);

	mainWindow.once('ready-to-show', () => {
		mainWindow.show();
	});

	mainWindow.setMenuBarVisibility(false);
	mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

	mainWindow.on('closed', () => {
		mainWindow = null;
	});

	mainWindow.on('close', (e) => {
		if (!appIsQuitting) {
			e.preventDefault();
			const config = getConfig();
			if (config.minimizeClose) {
				mainWindow.hide();
				showToast('rblxswap', 'Application minimized to system tray.', false, 5000);
			} else {
				mainWindow.hide();
			}
		}
	});

	if (process.platform === 'win32') {
		nativeTheme.themeSource = 'dark';
	}
}

function sendToRenderer(channel, payload) {
	if (!mainWindow || mainWindow.isDestroyed()) {
		return;
	}
	mainWindow.webContents.send(channel, payload);
}

function emitLog(level, message) {
	sendToRenderer('bypass:log', {
		level,
		message,
		timestamp: Date.now()
	});
}

function emitStatus(status, progress) {
	sendToRenderer('bypass:status', {
		status,
		progress
	});
}

async function pathExists(targetPath) {
	try {
		await fsPromises.access(targetPath, fs.constants.F_OK);
		return true;
	} catch (error) {
		return false;
	}
}

async function collectFiles(rootDir, filenameMatcher, maxDepth = 5, currentDepth = 0) {
	if (currentDepth > maxDepth) return [];
	if (!(await pathExists(rootDir))) return [];

	const collected = [];
	let entries = [];
	try {
		entries = await fsPromises.readdir(rootDir, { withFileTypes: true });
	} catch (error) {
		return [];
	}

	for (const entry of entries) {
		const fullPath = path.join(rootDir, entry.name);
		if (entry.isFile() && filenameMatcher.test(entry.name)) {
			collected.push(fullPath);
			continue;
		}

		if (entry.isDirectory() && !entry.name.startsWith('.')) {
			const nested = await collectFiles(fullPath, filenameMatcher, maxDepth, currentDepth + 1);
			if (nested.length) collected.push(...nested);
		}
	}

	return collected;
}

async function backupFilesByPaths(pathsToBackup) {
	const backups = [];
	for (const filePath of pathsToBackup) {
		try {
			const data = await fsPromises.readFile(filePath);
			backups.push({ filePath, data });
		} catch (error) {}
	}
	return backups;
}

async function restoreBackups(backups, successLabel) {
	for (const file of backups) {
		try {
			await fsPromises.mkdir(path.dirname(file.filePath), { recursive: true });
			await fsPromises.writeFile(file.filePath, file.data);
			emitLog('success', `${successLabel}: ${path.basename(file.filePath)}`);
		} catch (error) {
			emitLog('warn', `Failed to restore ${path.basename(file.filePath)}: ${error.message}`);
		}
	}
}

function escapeHtml(input) {
	return String(input)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function getToastLogoDataUrl() {
	if (toastLogoDataUrl) return toastLogoDataUrl;

	const candidates = [
		path.join(__dirname, 'assets', 'rblxswap_logo no bg.png'),
		path.join(__dirname, 'assets', 'rblxswap_logo_no_bg.png'),
		path.join(__dirname, 'assets', 'rblxswap_logo.png')
	];

	for (const candidatePath of candidates) {
		if (!fs.existsSync(candidatePath)) continue;
		try {
			const raw = fs.readFileSync(candidatePath);
			const ext = path.extname(candidatePath).toLowerCase();
			const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
			toastLogoDataUrl = `data:${mime};base64,${raw.toString('base64')}`;
			return toastLogoDataUrl;
		} catch (error) {}
	}

	return null;
}

function layoutToastWindows() {
	const primaryDisplay = screen.getPrimaryDisplay();
	const workArea = primaryDisplay.workArea;
	let currentBottom = workArea.y + workArea.height - 20;

	for (let i = toastOrder.length - 1; i >= 0; i--) {
		const toastId = toastOrder[i];
		const meta = toastWindows.get(toastId);
		if (!meta || !meta.window || meta.window.isDestroyed()) continue;

		currentBottom -= meta.height;
		const x = Math.round(workArea.x + workArea.width - meta.width - 20);
		const y = Math.round(currentBottom);
		meta.window.setBounds({ x, y, width: meta.width, height: meta.height });
		currentBottom -= 12;
	}
}

function cleanupToast(toastId) {
	const meta = toastWindows.get(toastId);
	if (meta && meta.timer) {
		clearTimeout(meta.timer);
	}
	toastWindows.delete(toastId);
	toastOrder = toastOrder.filter((id) => id !== toastId);
	layoutToastWindows();
}

function closeToastById(toastId, animated = true) {
	const meta = toastWindows.get(toastId);
	if (!meta || !meta.window || meta.window.isDestroyed()) {
		cleanupToast(toastId);
		return;
	}
	if (meta.closing) return;
	meta.closing = true;

	if (meta.timer) {
		clearTimeout(meta.timer);
		meta.timer = null;
	}

	if (animated) {
		meta.window.webContents.executeJavaScript('document.getElementById("toastCard")?.classList.add("fade-out")').catch(() => {});
		setTimeout(() => {
			if (!meta.window.isDestroyed()) meta.window.close();
		}, 220);
	} else if (!meta.window.isDestroyed()) {
		meta.window.close();
	}
}

async function removeDirectory(targetPath, label) {
	try {
		const exists = await pathExists(targetPath);
		if (!exists) {
			emitLog('info', `${label} already clean`);
			return false;
		}

		await fsPromises.rm(targetPath, { recursive: true, force: true });
		emitLog('success', `${label} removed`);
		return true;
	} catch (error) {
		emitLog('warn', `Failed to remove ${label}: ${error.message}`);
		return false;
	}
}

async function terminateRobloxProcesses() {
	if (process.platform !== 'win32') {
		emitLog('warn', 'Process termination step skipped (Windows only)');
		return;
	}

	const processNames = [
		'RobloxPlayerBeta.exe',
		'RobloxPlayerLauncher.exe',
		'RobloxStudioBeta.exe',
		'RobloxCrashHandler.exe',
		'RobloxPlayerBeta'
	];

	let terminatedAny = false;

	for (const name of processNames) {
		try {
			await execFileAsync('taskkill', ['/IM', name, '/F']);
			emitLog('success', `Terminated ${name}`);
			terminatedAny = true;
		} catch (error) {
			if (error.code === 'ENOENT') {
				emitLog('warn', 'taskkill command unavailable; skipping process termination step');
				return;
			}
			const stderr = error?.stderr || '';
			if (stderr.includes('not found') || stderr.includes('No tasks are running')) {
				// emitLog('info', `${name} was not running`);
			} else {
				emitLog('warn', `Unable to terminate ${name}: ${error.message}`);
			}
		}
	}

	if (!terminatedAny) {
		emitLog('info', 'No Roblox processes were running');
	}
}

async function cleanLauncherInstallations(localAppData) {
	const launchers = ['Fishstrap', 'Bloxstrap', 'Voidstrap'];
	const launcherSubFolders = ['Logs', 'Downloads']; //? now we handle versions separately
	let detected = false;

	for (const launcherName of launchers) {
		const launcherRoot = path.join(localAppData, launcherName);
		const exists = await pathExists(launcherRoot);
		if (!exists) {
			continue;
		}

		detected = true;
		emitLog('info', `Detected ${launcherName} installation`);
		for (const folderName of launcherSubFolders) {
			await removeDirectory(path.join(launcherRoot, folderName), `${launcherName} / ${folderName}`);
		}
	}

	if (!detected) {
		emitLog('info', 'No Fishstrap/Bloxstrap/Voidstrap folders detected');
	}
}

async function deletePrefetchArtifacts() { //? PROBABLY not needed but eh whatever
	const systemRoot = process.env.SystemRoot || 'C:/Windows';
	const prefetchDir = path.join(systemRoot, 'Prefetch');

	if (!(await pathExists(prefetchDir))) {
		emitLog('warn', 'Prefetch directory not accessible, so we skip!');
		return;
	}

	try {
		const entries = await fsPromises.readdir(prefetchDir);
		const targets = entries.filter((fileName) =>
			(fileName.startsWith('ROBLOXCRASHHANDLER.EXE-') || fileName.startsWith('ROBLOXPLAYERBETA.EXE-')) &&
			fileName.toUpperCase().endsWith('.PF')
		);

		if (targets.length === 0) {
			emitLog('info', 'No Roblox prefetch files detected');
			return;
		}

		await Promise.all(
			targets.map(async (fileName) => {
				const targetPath = path.join(prefetchDir, fileName);
				try {
					await fsPromises.rm(targetPath, { force: true });
					emitLog('success', `Deleted Prefetch ${fileName}`);
				} catch (error) {
					emitLog('warn', `Failed to delete Prefetch ${fileName}: ${error.message}`);
				}
			})
		);
	} catch (error) {
		emitLog('warn', `Unable to enumerate thru prefetch: ${error.message}`);
	}
}

async function deleteRegistryKey() {
	try {
		await execFileAsync('reg', ['delete', 'HKCU\\Software\\ROBLOX Corporation', '/f']);
		emitLog('success', 'Removed Roblox registry keys');
	} catch (error) {
		if (error.code === 1) {
			emitLog('info', 'Registry keys already absent');
		} else {
			emitLog('warn', `Failed to delete registry key: ${error.message}`);
		}
	}
}

async function cleanRobloxRoaming() {
	const appData = process.env.APPDATA;
	if (!appData) { // just in case bro 😭😭😭😭
		emitLog('warn', 'APPDATA environment variable missing??? tf??????????????');
		return;
	}

	const base = path.join(appData, 'Roblox');
	const subfolders = ['logs', 'http'];
	const exists = await pathExists(base);

	if (!exists) {
		emitLog('info', 'Roaming/Roblox not found');
		return;
	}

	for (const folder of subfolders) {
		await removeDirectory(path.join(base, folder), `Roaming Roblox / ${folder}`);
	}
}

async function cleanTempCaches() {
	const tempRoot = process.env.TEMP || os.tmpdir();
	await removeDirectory(path.join(tempRoot, 'Roblox'), 'Temp Roblox cache');
	await removeDirectory(path.join(tempRoot, 'RobloxLogs'), 'Temp RobloxLogs cache');

	try {
		const entries = await fsPromises.readdir(tempRoot, { withFileTypes: true });
		const matches = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith('Roblox'));
		if (matches.length === 0) {
			emitLog('info', 'No additional Roblox temp directories detected');
			return;
		}

		for (const match of matches) {
			await removeDirectory(path.join(tempRoot, match.name), `Temp ${match.name}`);
		}
	} catch (error) {
		emitLog('warn', `Unable to clear temp: ${error.message}`);
	}
}

async function removeProgramDataRoblox() {
	const programData = process.env.PROGRAMDATA;
	if (!programData) { // again, just in case... although if this is missing something is really wrong with their system ngl
		emitLog('warn', 'PROGRAMDATA environment variable missing??? tf WTFF x2 ??????????????');
		return;
	}

	await removeDirectory(path.join(programData, 'Roblox'), 'ProgramData Roblox');
}

async function findExeShallow(dir, exeName, currentDepth = 0, maxDepth = 3) { // thanks geepeetee
	if (currentDepth > maxDepth) return null;
	try {
		const entries = await fsPromises.readdir(dir, { withFileTypes: true });
		let dirs = [];
		for (const entry of entries) {
			if (entry.name === exeName) return dir;
			if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
				dirs.push(path.join(dir, entry.name));
			}
		}
		for (const subDir of dirs) {
			const found = await findExeShallow(subDir, exeName, currentDepth + 1, maxDepth);
			if (found) return found;
		}
	} catch (e) {}
	return null;
}

async function cleanWebLauncher(targetDir) {
	if (!targetDir) return;

	emitLog('info', `Cleaning weao weblauncher at ${targetDir}`);
	
	const baddirs = ['content', 'ExtraContent', 'PlatformContent', 'RobloxPlayerBeta.exe.WebView2', 'shaders', 'ssl', 'WebView2RuntimeInstaller'];
	const badfiles = ['RobloxCrashHandler.exe', 'RobloxPlayerBeta.dll', 'RobloxPlayerBeta.exe', 'WebView2Loader.dll', 'COPYRIGHT.txt'];

	for (const d of baddirs) {
		await removeDirectory(path.join(targetDir, d), `WebLauncher / ${d}`);
	}
	
	for (const f of badfiles) {
		try {
			const targetPath = path.join(targetDir, f);
			if (await pathExists(targetPath)) {
				await fsPromises.rm(targetPath, { force: true });
				emitLog('success', `WebLauncher / removed file ${f}`);
			}
		} catch (e) {
			emitLog('warn', `Failed to remove ${f}: ${e.message}`);
		}
	}
}

async function runCleaner(weblauncherDir) {
	const localAppData = process.env.LOCALAPPDATA;
	const appData = process.env.APPDATA;
	if (!localAppData) { // you alraedy kno
		throw new Error('LOCALAPPDATA environment variable is not defined????????????????????????????????????????? WTF');
	}

	emitLog('info', 'YO VEO ROBLOX... Bypassing np');
	
	const config = getConfig();
	let preservedSettingsFiles = [];
	let preservedFastflagFiles = [];
	
	//? backup user settings before cleanup so they can be restored afterward.
	if (config.preserveSettings) {
		const settingsRoots = [path.join(localAppData, 'Roblox')];
		if (appData) settingsRoots.push(path.join(appData, 'Roblox'));

		let settingsPaths = [];
		for (const root of settingsRoots) {
			const found = await collectFiles(root, /^GlobalBasicSettings_\d+\.xml$/i, 6);
			if (found.length) settingsPaths.push(...found);
		}

		preservedSettingsFiles = await backupFilesByPaths(Array.from(new Set(settingsPaths)));
		if (preservedSettingsFiles.length) {
			emitLog('info', `Backed up ${preservedSettingsFiles.length} GlobalBasicSettings file(s)`);
		} else {
			emitLog('info', 'No GlobalBasicSettings files found to preserve');
		}
	}
	
	if (config.preserveFastflags) {
		const launcherRoots = [
			path.join(localAppData, 'Bloxstrap'),
			path.join(localAppData, 'Fishstrap'),
			path.join(localAppData, 'Voidstrap')
		];
		if (weblauncherDir) launcherRoots.push(weblauncherDir);

		let fastflagPaths = [];
		for (const root of launcherRoots) {
			const found = await collectFiles(root, /^Client(Settings|AppSettings)\.json$/i, 6);
			if (found.length) fastflagPaths.push(...found);
		}

		preservedFastflagFiles = await backupFilesByPaths(Array.from(new Set(fastflagPaths)));
		if (preservedFastflagFiles.length) {
			emitLog('info', `Backed up ${preservedFastflagFiles.length} fastflag file(s)`);
		} else {
			emitLog('info', 'No fastflag files found to preserve');
		}
	}

	//?         label,                         progress
	emitStatus('terminating Roblox processes', 5);
	await terminateRobloxProcesses();

	// wait a few sec for roblox to completely shut off
	emitStatus('waiting for roblox', 5);
	await new Promise((resolve) => setTimeout(resolve, 2000));

	emitStatus('detecting launchers', 15);
	await cleanLauncherInstallations(localAppData);
	if (weblauncherDir) {
		await cleanWebLauncher(weblauncherDir);
	}

	emitStatus('purging Roblox install', 35);
	const targetLocalRoblox = path.join(localAppData, 'Roblox');
	if (!config.deleteStudio) {
		const versionsPath = path.join(targetLocalRoblox, 'Versions');
		if (await pathExists(versionsPath)) {
			try {
				const entries = await fsPromises.readdir(versionsPath, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.isDirectory()) {
						const vf = path.join(versionsPath, entry.name);
						const hasStudio = await pathExists(path.join(vf, 'RobloxStudioBeta.exe'));
						if (hasStudio) { //? dont delete studio!
							emitLog('info', `Skipping Studio dir ${entry.name}`);
						} else {
							await removeDirectory(vf, `Roblox Version ${entry.name}`);
						}
					}
				}
				
				await removeDirectory(path.join(targetLocalRoblox, 'Downloads'), 'Roblox Downloads');
				await removeDirectory(path.join(targetLocalRoblox, 'Logs'), 'Roblox Logs');
			} catch (e) {}
		}
	} else { //? delete studio, user doesnt care
		await removeDirectory(targetLocalRoblox, 'Roblox install folder');
	}

	const launcherRootsToCleanStudioFor = [
		path.join(localAppData, 'Bloxstrap', 'Versions'),
		path.join(localAppData, 'Fishstrap', 'Versions'),
		path.join(localAppData, 'Voidstrap', 'Versions')
	];
	for (const lbRoot of launcherRootsToCleanStudioFor) {
		if (await pathExists(lbRoot)) {
			if (!config.deleteStudio) {
				try {
					const entries = await fsPromises.readdir(lbRoot, { withFileTypes: true });
					for (const entry of entries) {
						if (entry.isDirectory()) {
							const vf = path.join(lbRoot, entry.name);
							const hasStudio = await pathExists(path.join(vf, 'RobloxStudioBeta.exe'));
							if (hasStudio) {
								emitLog('info', `Skipping Studio install in ${lbRoot}`);
							} else {
								await removeDirectory(vf, `Launcher Version ${entry.name}`);
							}
						}
					}
				} catch (e) {}
			} else {
				await removeDirectory(lbRoot, 'Launcher Versions');
			}
		}
	}

	if (process.env.ProgramFiles) {
		const targetPF = path.join(process.env.ProgramFiles, 'Roblox');
		if (!config.deleteStudio) {
			const versionsPath = path.join(targetPF, 'Versions');
			if (await pathExists(versionsPath)) {
				try {
					const entries = await fsPromises.readdir(versionsPath, { withFileTypes: true });
					for (const entry of entries) {
						if (entry.isDirectory()) {
							const vf = path.join(versionsPath, entry.name);
							const hasStudio = await pathExists(path.join(vf, 'RobloxStudioBeta.exe'));
							if (!hasStudio) {
								await removeDirectory(vf, `PF Version ${entry.name}`);
							}
						}
					}
				} catch (e) {}
			}
		} else {
			await removeDirectory(targetPF, 'Program Files Roblox');
		}
	}

	if (process.env['ProgramFiles(x86)']) {
		const targetPFx = path.join(process.env['ProgramFiles(x86)'], 'Roblox');
		if (!config.deleteStudio) {
			const versionsPath = path.join(targetPFx, 'Versions');
			if (await pathExists(versionsPath)) {
				try {
					const entries = await fsPromises.readdir(versionsPath, { withFileTypes: true });
					for (const entry of entries) {
						if (entry.isDirectory()) {
							const vf = path.join(versionsPath, entry.name);
							const hasStudio = await pathExists(path.join(vf, 'RobloxStudioBeta.exe'));
							if (!hasStudio) {
								await removeDirectory(vf, `PFx86 Version ${entry.name}`);
							}
						}
					}
				} catch (e) {}
			}
		} else {
			await removeDirectory(targetPFx, 'Program Files (x86) Roblox');
		}
	}


	emitStatus('cleaning Roaming cache', 45);
	await cleanRobloxRoaming();

	emitStatus('clearing Prefetch cache', 60);
	await deletePrefetchArtifacts();

	emitStatus('removing registry keys', 75);
	await deleteRegistryKey();

	emitStatus('clearing temp cache', 88);
	await cleanTempCaches();

	emitStatus('cleaning ProgramData', 94);
	await removeProgramDataRoblox();

	if (config.purgeAuth !== false) {
		emitStatus('purging auth tokens & telemetry', 97);
		try {
			const purge = await hwid.purgeRobloxTraces();
			emitLog('success', `Cleared ${purge.files} local token/log file(s)`);
			for (const r of purge.registry || []) {
				emitLog(r.deleted ? 'success' : 'info', r.deleted ? `Removed ${r.key}` : `${r.key} already absent`);
			}
			for (const err of purge.errors || []) emitLog('warn', err);
		} catch (e) {
			emitLog('warn', `Trace purge failed: ${e.message}`);
		}
	}

	if (config.preserveSettings && preservedSettingsFiles.length) {
		await restoreBackups(preservedSettingsFiles, 'Restored settings file');
	}
	
	if (config.preserveFastflags && preservedFastflagFiles.length) {
		await restoreBackups(preservedFastflagFiles, 'Restored fastflags file');
	}

	emitStatus('complete', 100);
	emitLog('success', 'Bypassed np thx');
}

const toastActionRegistry = new Map();
function registerToastAction(key, fn) { toastActionRegistry.set(key, fn); }
async function showToast(title, message, buttons, timespan = 15000, callback = null) {
	const toastId = `toast_${Date.now()}_${++toastIdCounter}`;
	const logoUrl = getToastLogoDataUrl();
	const safeTitle = escapeHtml(title); //! you never know am i rite ;-;
	const safeMessage = escapeHtml(message);

	let normalizedButtons = null; //? nomralized format for btns
	if (buttons === true) {
		//? legacy behavior
		normalizedButtons = [
			{ label: 'Yes', type: 'yes', action: null, close: true },
			{ label: 'No', type: 'default', action: null, close: true },
		]
	} else if (Array.isArray(buttons) && buttons.length > 0) {
		// console.log('normalizing buttons:', JSON.stringify(buttons));
		normalizedButtons = buttons.map((btn, index) => ({
			label:     btn.label     ?? 'OK',
			type:      btn.type      ?? 'default',  // 'yes' | 'danger' | 'default'
			action:    btn.action    ?? null,       // for direct calls (not ipc cuz ipc is tart)
			actionKey: btn.actionKey ?? null,       // for renderer ipc calls yay
			close:     btn.close     !== false      // default = true
		}));
	}

	const buttonsJson = normalizedButtons
		? escapeHtml(JSON.stringify(normalizedButtons))
		: null;

	const buttonHTML = normalizedButtons
		? `<div class="buttons">
			${normalizedButtons.map((btn, i) =>
				`<button class="${btn.type}" data-index="${i}" onclick="window.toastActions.click('${toastId}', ${i})">${escapeHtml(btn.label)}</button>`
			).join('')}
		</div>
		` : '';

	const toastHTML = `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		html, body { width: auto; height: auto; overflow: hidden; background: transparent; }
		body {
			font-family: 'Poppins', -apple-system, sans-serif;
			padding: 0;
			background: transparent;
		}
		.toast-card {
			width: max-content;
			min-width: 280px;
			max-width: 420px;
			background: rgba(25, 25, 25, 0.95);
			backdrop-filter: blur(10px);
			border: 1px solid rgba(255,255,255,0.12);
			border-radius: 14px;
			padding: 14px;
			color: #f0f0f0;
			display: flex;
			flex-direction: column;
			animation: slideIn 0.25s ease;
			box-shadow: 0 12px 30px rgba(0,0,0,0.45);
		}
		@keyframes slideIn { from { transform: translateX(90px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
		@keyframes slideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(90px); opacity: 0; } }
		.toast-card.fade-out { animation: slideOut 0.22s ease forwards; }
		.head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
		.head img { width: 18px; height: 18px; border-radius: 4px; object-fit: cover; }
		h2 { font-size: 0.95rem; }
		p { font-size: 0.78rem; color: #b3b3b3; margin-bottom: 12px; line-height: 1.4; white-space: pre-wrap; }
		
		.buttons { display: flex; gap: 8px; }
		button { flex: 1; padding: 8px 12px; font-size: 0.75rem; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; cursor: pointer; transition: all 0.2s; background: rgba(255,255,255,0.08); color: #f0f0f0; font-family: inherit; }
		button:hover { background: rgba(255,255,255,0.15); }
		
		button.yes { background: rgba(74, 222, 128, 0.2); border-color: rgba(74, 222, 128, 0.4); }
		button.yes:hover { background: rgba(74, 222, 128, 0.3); }
		button.danger { background: rgba(248, 113, 113, 0.2); border-color: rgba(248, 113, 113, 0.4); }
		button.danger:hover { background: rgba(248, 113, 113, 0.3); }
		button.primary { background: rgba(59, 246, 131, 0.2); border-color: rgba(59, 246, 131, 0.4); }
		button.primary:hover { background: rgba(59, 246, 131, 0.3); }
		button.warning { background: rgba(245, 158, 11, 0.2); border-color: rgba(245, 158, 11, 0.4); }
		button.warning:hover { background: rgba(245, 158, 11, 0.3); }
	</style>
</head>
<body>
	<div class="toast-card" id="toastCard">
		<div class="head">
			${logoUrl ? `<img src="${logoUrl}" alt="rblxswap" />` : ''}
			<h2>${safeTitle}</h2>
		</div>
		<p>${safeMessage}</p>
		${buttonHTML}
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
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			preload: path.join(__dirname, 'preload-toast.js')
		}
	});

	const meta = {
		id: toastId,
		window: toastWindow,
		width: 320,
		height: 96,
		timer: null,
		callback,
		buttons: normalizedButtons,
		closing: false
	};
	toastWindows.set(toastId, meta);
	toastOrder.push(toastId);
	layoutToastWindows();

	toastWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(toastHTML)}`);

	toastWindow.webContents.once('did-finish-load', async () => {
		if (!toastWindow || toastWindow.isDestroyed()) return;
		try {
			const measured = await toastWindow.webContents.executeJavaScript(`(() => {
				const card = document.getElementById('toastCard');
				if (!card) return { width: 320, height: 96 };
				const rect = card.getBoundingClientRect();
				return {
					width: Math.ceil(rect.width),
					height: Math.ceil(rect.height)
				};
			})()`);

			meta.width = Math.min(Math.max(measured.width, 280), 440);
			meta.height = Math.min(Math.max(measured.height, 88), 320);
			layoutToastWindows();
		} catch (error) {}

		toastWindow.showInactive();
	});

	meta.timer = setTimeout(() => {
		closeToastById(toastId, true);
	}, timespan);

	toastWindow.on('closed', () => {
		cleanupToast(toastId);
	});

	return toastId;
}

function handleToastAction(action, toastId, buttonIndex) {
	const meta = toastWindows.get(toastId);
	if (!meta) return;

	if (action === 'click' && meta.buttons && buttonIndex !== null) {
		const btn = meta.buttons[buttonIndex];
		if (btn) {
			//* try registry action first, then inline function
			const fn = btn.actionKey
				? toastActionRegistry.get(btn.actionKey)
				: btn.action;
			if (typeof fn === 'function') {
				try { fn(); } catch (e) {}
			} else if (typeof meta.callback === 'function') {
				try { meta.callback(buttonIndex === 0); } catch (e) {}
			}
			if (btn.close !== false) closeToastById(toastId, true);
		}
	} else if (action === 'yes' || action === 'no') {
		//? legacy
		if (action === 'yes') {
			mainWindow.show();
			mainWindow.focus();
			mainWindow.webContents.executeJavaScript('show_view("home")');
		}

		if (meta && typeof meta.callback === 'function') {
			try { meta.callback(action === 'yes'); } catch (error) {}
		}

		closeToastById(toastId, true);
	}
}

app.whenReady().then(() => {
	createWindow();

	//? HKLM spoofing needs elevation; warn early if we aren't admin
	if (process.platform === 'win32') {
		hwid.isElevated().then((elevated) => {
			if (!elevated) {
				showToast('Not running as admin', 'Hardware ID & MAC spoofing need admin rights. Relaunch rblxswap as administrator, or those steps will fail.', false, 9000);
			}
		}).catch(() => {});
	}

	//*------
	registerToastAction('open:weao-discord', () => {
		require('electron').shell.openExternal('https://discord.gg/weaoxyz');
	});
	registerToastAction('open:main-window', () => {
		mainWindow?.show();
		mainWindow?.focus();
		mainWindow?.webContents.executeJavaScript('show_view("home")');
	});
	registerToastAction('roblox:start-clean', () => {
		if (!mainWindow || mainWindow.isDestroyed()) createWindow();
		mainWindow.show();
		mainWindow.focus();
		const run = () => mainWindow.webContents.executeJavaScript('start_clean()').catch(() => {});
		if (mainWindow.webContents.isLoading()) {
			mainWindow.webContents.once('did-finish-load', run);
		} else {
			run();
		}
	});
	registerToastAction('fun:bao_confetti', () => {
		mainWindow?.webContents.executeJavaScript(`(() => {
			trigger_bao_confetti();
		})()`);
	});
	//*------

	tray = new Tray(path.join(__dirname, 'icon.ico'));
	const contextMenu = Menu.buildFromTemplate([
			{ label: 'Open rblxswap', click: () => { mainWindow.show(); mainWindow.focus(); } },
			{ label: 'Test toast', click: () => { showToast('Test Toast', 'This is a test toast message.', true); } },
			{ label: 'Exit', click: () => { appIsQuitting = true; app.quit(); } }
	]);
	tray.setToolTip('rblxswap');
	tray.setContextMenu(contextMenu);
	tray.on('double-click', () => {
			mainWindow.show();
			mainWindow.focus();
	});

	robloxPoller = setInterval(() => {
		execFile('tasklist', ['/FI', 'IMAGENAME eq RobloxPlayerBeta.exe', '/NH'], (err, stdout) => {
			if (err) return;
			const isCurrentlyRunning = stdout.includes('RobloxPlayerBeta.exe');
			if (!wasRobloxRunning && isCurrentlyRunning) {
				wasRobloxRunning = true;
				robloxGracePeriod = 0;
			} else if (wasRobloxRunning && !isCurrentlyRunning) {
				robloxGracePeriod++;
				if (robloxGracePeriod >= 1) { //? 1 * 5 (interval) = 5 second grace period
					wasRobloxRunning = false;
					robloxGracePeriod = 0;
					showToast('Roblox Closed', 'Would you like to spoof and clean traces before your next session?', [
						{ label: 'Yes', type: 'yes', actionKey: 'roblox:start-clean', close: true },
						{ label: 'No', type: 'default', close: true }
					]);
				}
			} else if (wasRobloxRunning) {
				robloxGracePeriod = 0; //? reset grace period if it comes back
			}
		});
	}, 5000);

	app.on('activate', () => {
			if (BrowserWindow.getAllWindows().length === 0) {
					createWindow();
			}
	});
});

//app.on('window-all-closed', () => {});
ipcMain.handle('show-toast', (e, { title, message, buttons, timespan }) => {
	return showToast(title, message, buttons, timespan);
});

ipcMain.handle('select-directory', async () => {
	const result = await dialog.showOpenDialog(mainWindow, {
		properties: ['openDirectory'],
		title: 'Select your WEAO RDD WebLauncher directory (it has weblauncher.exe inside it)',
		defaultPath: app.getPath('downloads')
	});
	return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('hide-window', () => { 
	if(mainWindow) {
		mainWindow.hide();
		showToast('rblxswap', 'Application minimized to system tray.', false, 5000);
	}
});

ipcMain.handle('scan-weblauncher', async () => {
	const userProfile = process.env.USERPROFILE;
	const localAppData = process.env.LOCALAPPDATA;
	const roots = [
		path.join(userProfile, 'Desktop'),
		path.join(userProfile, 'Downloads'),
		localAppData,
		path.join(userProfile, 'Documents')
	];

	for (const root of roots) {
		const targetDir = await findExeShallow(root, 'weblauncher.exe', 0, 3);
		if (targetDir) return targetDir;
	}
	return null;
});

ipcMain.handle('get-config', () => getConfig());
ipcMain.handle('set-config', (e, conf) => setConfig(conf));
ipcMain.handle('get-version', () => APP_VERSION);

ipcMain.handle('check-updates', async () => {
	return new Promise((resolve) => {
		https.get('https://api.github.com/repos/focat69/rblxswap/releases/latest', { headers: { 'User-Agent': 'rblxswap-updater' } }, (res) => {
			let data = '';
			res.on('data', chunk => data += chunk);
			res.on('end', () => {
				try {
					// const release = JSON.parse(data);
					// if (!((release.body || '').includes(APP_VERSION) || (release.name || '').includes(APP_VERSION))) {
					// 	//? extract version from body (vX.Y.Z)
					// 	const versionMatch = release.body.match(/v\d+\.\d+\.\d+/) || release.name.match(/v\d+\.\d+\.\d+/);
					// 	const latestVersion = versionMatch ? versionMatch[0] : release.tag_name;

					// 	resolve({ updateAvailable: true, version: latestVersion, url: release.html_url });
					// } else {
					// 	resolve({ updateAvailable: false, version: APP_VERSION });
					// }
					//! so i'm slow and i can just use the tag name
					const release = JSON.parse(data);
					if (release.tag_name !== APP_VERSION) {
						resolve({ updateAvailable: true, version: release.tag_name, url: release.html_url });
					} else {
						resolve({ updateAvailable: false, version: APP_VERSION });
					}
				} catch(e) { resolve({ error: true }); }
			});
		}).on('error', () => resolve({ error: true }));
	});
});

async function downloadFileToTemp(url, sendProgress) {
	return new Promise((resolve, reject) => {
		const tmp = path.join(os.tmpdir(), `rblxswap_update_${Date.now()}.exe`);
		const opts = new URL(url);
		const req = https.get({ hostname: opts.hostname, path: opts.pathname + (opts.search || ''), headers: { 'User-Agent': 'rblxswap-updater' } }, (res) => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				resolve(downloadFileToTemp(res.headers.location, sendProgress));
				return;
			}
			if (res.statusCode !== 200) {
				reject(new Error('Download failed: ' + res.statusCode));
				return;
			}
			
			const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
			let downloadedBytes = 0;
			
			res.on('data', (chunk) => {
				downloadedBytes += chunk.length;
				if (sendProgress && totalBytes > 0) {
					const pct = Math.round((downloadedBytes / totalBytes) * 100);
					sendProgress({ percentage: pct, downloaded: downloadedBytes, total: totalBytes });
				}
			});

			const file = fs.createWriteStream(tmp);
			res.pipe(file);
			file.on('finish', () => file.close(() => resolve(tmp)));
			file.on('error', (err) => reject(err));
		});
		req.on('error', (err) => reject(err));
	});
}

function psEscape(str) {
	return String(str).replace(/'/g, "''");
}

// function spawnDetached(tempPath, targetExe) {
// 	//* copy to a second temp location first so the source file stays valid
// 	//* then wait for the original to be released, replace it, and relaunch
// 	const ps = `
// 		try {
// 			$src = '${psEscape(tempPath)}';
// 			$dst = '${psEscape(targetExe)}';
// 			$attempts = 0;
// 			while ($true) {
// 				try {
// 					# fails === still locked
// 					$stream = [System.IO.File]::Open($dst, 'Open', 'ReadWrite', 'None')
// 					$stream.Close()
// 					$stream.Dispose()
// 					# file !== locked, safe to replace
// 					Copy-Item -Path $src -Destination $dst -Force -ErrorAction Stop
// 					Remove-Item -Path $src -Force -ErrorAction SilentlyContinue
// 					Start-Process -FilePath $dst
// 					break
// 				} catch {
// 					Start-Sleep -Milliseconds 300
// 					$attempts++
// 					if ($attempts -ge 60) {
// 						# gave up waiting, just try to launch whatever is there :/
// 						Remove-Item -Path $src -Force -ErrorAction SilentlyContinue
// 						Start-Process -FilePath $dst
// 						break
// 					}
// 				}
// 			}
// 		} catch {
// 			Start-Process -FilePath '${psEscape(targetExe)}'
// 		}
// 	`;

// 	const child = require('child_process').spawn(
// 		'powershell.exe',
// 		['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps],
// 		{ detached: true, windowsHide: true, stdio: 'ignore' }
// 	);
// 	try { child.unref(); } catch (e) {}
// }

function spawnDetached(tempPath) {
	//* this function genuinely making my eyes bleed
	//* anyways

	const targetExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
	const exeName = path.basename(targetExe);
	const scriptPath = path.join(os.tmpdir(), 'rblxswap_updater.ps1');
	const batPath = path.join(os.tmpdir(), 'rblxswap_updater.bat');

	const script = `
$host.UI.RawUI.WindowTitle = "rblxswap updater"
$host.UI.RawUI.BackgroundColor = "Black"
$host.UI.RawUI.ForegroundColor = "White"
Clear-Host

Write-Host ""
Write-Host "  ================================" -ForegroundColor DarkGray
Write-Host "   rblxswap update helper :bao:" -ForegroundColor White
Write-Host "  ================================" -ForegroundColor DarkGray
Write-Host ""

$src = '${tempPath.replace(/\\/g, '\\\\')}'
$dst = '${targetExe.replace(/\\/g, '\\\\')}'

Write-Host "  Waiting for rblxswap to close..." -ForegroundColor Gray

$attempts = 0
$updated = $false
while ($true) {
	try {
		$stream = [System.IO.File]::Open($dst, 'Open', 'ReadWrite', 'None')
		$stream.Close()
		$stream.Dispose()
		Write-Host "  Applying update..." -ForegroundColor Yellow
		Copy-Item -Path $src -Destination $dst -Force -ErrorAction Stop
		Remove-Item -Path $src -Force -ErrorAction SilentlyContinue
		$updated = $true
		break
	} catch {
		$attempts++
		if ($attempts -ge 60) {
			Write-Host "  Timed out waiting. Launching anyway..." -ForegroundColor Red
			Remove-Item -Path $src -Force -ErrorAction SilentlyContinue
			break
		}
		Start-Sleep -Milliseconds 300
	}
}

if ($updated) {
	Write-Host "  Update applied!" -ForegroundColor Green
}

Write-Host "  Launching ${exeName}..." -ForegroundColor Gray
Start-Process -FilePath $dst
Write-Host ""
Write-Host "  Done! This window will close in 10 seconds." -ForegroundColor DarkGray
Write-Host "  It may take a moment for the new instance to open, so please be patient :)" -ForegroundColor DarkGray
Write-Host "  If it still doesn't open, try launching rblxswap manually and make sure the update was applied (version number should be different)" -ForegroundColor DarkGray
Write-Host ""
Start-Sleep -Seconds 10
`;

	//? we use bat cuz only powershell alone leads to race conditions where the script file is still locked by the powershell
	//? process when it tries to relaunch, causing it to fail. the bat acts as a middleman that launches the ps script and then 
	//? immediately exits, allowing the ps script to do its thing without worrying about being locked itself.
	const bat = `@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath.replace(/\\/g, '\\\\')}"
`;

	try {
		fs.writeFileSync(scriptPath, script, 'utf8');
		fs.writeFileSync(batPath, bat, 'utf8');
	} catch (e) {
		console.error('[update] failed to write update files:', e);
		return;
	}

	console.log('[update] target exe:', targetExe);

	const child = require('child_process').spawn(
		'cmd.exe',
		['/c', batPath],
		{ detached: true, windowsHide: true, stdio: 'ignore' } //? cmd hidden, ps opens its own window
	);
	child.on('error', (e) => console.error('[update] spawn error:', e));
	try { child.unref(); } catch (e) {}
}

ipcMain.handle('update:download', async (e, url) => {
	try {
		const sendProgress = (data) => {
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send('update:status', data);
			}
		};
		const tmp = await downloadFileToTemp(url, sendProgress);
		
		if (!app.isPackaged) {
			emitLog('info', 'folk it isnt packaged i cant actually replace');
			showToast('Update', '100% updated yep yep (check temp np)', false, 6000);
			return { success: true };
		}

		showToast('Update', 'Applying update...', false, 6000);
		appIsQuitting = true;
		spawnDetached(tmp);
		setTimeout(() => app.quit(), 800);
		return { success: true };
	} catch (error) {
		emitLog('warn', `Update download failed: ${error.message}`);
		return { success: false, message: error.message };
	}
});

ipcMain.handle('update:downloadLatest', async () => {
	try {
		const info = await new Promise((resolve, reject) => {
			https.get('https://api.github.com/repos/focat69/rblxswap/releases/latest', { headers: { 'User-Agent': 'rblxswap-updater' } }, (res) => {
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
				});
			}).on('error', reject);
		});

		const asset = (info.assets || []).find(a => (a.name || '').toLowerCase().endsWith('.exe')) || (info.assets || [])[0];
		if (!asset || !asset.browser_download_url) return { success: false, message: 'No exe found' };

		const sendProgress = (data) => {
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send('update:status', data);
			}
		};
		const tmp = await downloadFileToTemp(asset.browser_download_url, sendProgress);
		if (!app.isPackaged) {
			emitLog('info', 'folk it isnt packaged i cant actually replace');
			showToast('Update', '100% updated yep yep (check temp np)', false, 6000);
			return { success: true };
		}

		showToast('Update', 'Applying update...', false, 6000);
		appIsQuitting = true;
		spawnDetached(tmp);
		setTimeout(() => app.quit(), 800);
		return { success: true };
	} catch (error) {
		emitLog('warn', `Update latest failed: ${error.message}`);
		return { success: false, message: error.message };
	}
});

ipcMain.handle('open-external', async (e, url) => {
	require('electron').shell.openExternal(url);
});

ipcMain.on('toast-action', (_event, payload) => {
	if (!payload || typeof payload !== 'object') return;
	handleToastAction(payload.action, payload.toastId, payload.index ?? null);
});

ipcMain.handle('bypass:run', async (event, weblauncherDir) => {
	if (bypassRunning) { // again, debounce safety precaution for silly people
		emitLog('warn', 'WHO IS THIS???'); // already running bud
		return { success: false, reason: 'busy' };
	}

	bypassRunning = true;
	emitStatus('starting', 0);

	try {
		await runCleaner(weblauncherDir);
		sendToRenderer('bypass:complete', { success: true });
		return { success: true };
	} catch (error) {
		emitLog('error', error.message || 'Unexpected fail');
		emitStatus('error', 100);
		sendToRenderer('bypass:complete', { success: false, message: error.message });
		return { success: false, message: error.message };
	} finally {
		bypassRunning = false;
	}
});

// mac address & auth handling
//! special thanks & credit to https://github.com/centerepic/ByeBanAsync for MAC spoofing logic / registry techniques!
//! i originally did it wrong and it was a nightmare lol
ipcMain.handle('mac:get-adapters', async () => {
	//? -Physical = real hardware NICs; fall back to any MAC-bearing non-pseudo adapter
	const script = `
		$ErrorActionPreference = 'SilentlyContinue'
		$a = @(Get-NetAdapter -Physical | Where-Object { $_.MacAddress })
		if ($a.Count -eq 0) {
			$a = @(Get-NetAdapter | Where-Object { $_.MacAddress -and $_.InterfaceDescription -notmatch 'Loopback|Teredo|ISATAP|Tunnel|WAN Miniport|Kernel Debug' })
		}
		ConvertTo-Json -InputObject @($a | Select-Object Name, InterfaceDescription, MacAddress, Status) -Compress
	`;
	try {
		const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script]);
		const parsed = JSON.parse(stdout || '[]');
		//? ConvertTo-Json collapses a single adapter to an object — normalize to array
		return Array.isArray(parsed) ? parsed : [parsed];
	} catch (err) {
		return [];
	}
});

ipcMain.handle('mac:get-stats', async () => {
	try {
		const { stdout } = await execFileAsync('powershell', [
			'-NoProfile',
			'-Command',
			'@(Get-NetAdapterStatistics | Select-Object Name, ReceivedBytes, SentBytes) | ConvertTo-Json -Compress'
		]);
		return JSON.parse(stdout || '[]');
	} catch (err) {
		return [];
	}
});

ipcMain.handle('mac:spoof', async (e, adapterDesc, newMac) => {
	//* we use the this key (4d36e972-e3...) to target network adapters! why? 
	//* because adapter names can be localized and also can be changed by the user, 
	//* but the description is consistent and unchangeable 
	//* (at least without modifying driver files which is a whole other level of pain!)
	const script = `
		$adapters = Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e972-e325-11ce-bfc1-08002be10318}\\0*" -ErrorAction SilentlyContinue | Where-Object { $_.DriverDesc -eq '${adapterDesc.replace(/'/g, "''")}' }
		if ($adapters) {
				$path = $adapters[0].PSPath
				Set-ItemProperty -Path $path -Name "NetworkAddress" -Value "${newMac.replace(/-/g, '')}" -ErrorAction Stop
				Write-Output "SUCCESS"
		} else {
				Write-Output "NOT_FOUND"
		}
	`; //? GUID spoofing lives in hwid:spoof now (backup + v4 validation)
	try {
		const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script]);
		return stdout.trim() === 'SUCCESS';
	} catch (error) {
		return false;
	}
});

ipcMain.handle('mac:reset', async (e, adapterDesc) => {
	const script = `
		$adapters = Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e972-e325-11ce-bfc1-08002be10318}\\0*" -ErrorAction SilentlyContinue | Where-Object { $_.DriverDesc -eq '${adapterDesc.replace(/'/g, "''")}' }
		if ($adapters) {
				$path = $adapters[0].PSPath
				Remove-ItemProperty -Path $path -Name "NetworkAddress" -ErrorAction SilentlyContinue
				Write-Output "SUCCESS"
		} else {
				Write-Output "NOT_FOUND"
		}
	`;
	try {
		const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script]);
		return stdout.trim() === 'SUCCESS';
	} catch (error) {
		return false;
	}
});

ipcMain.handle('mac:restart-adapter', async (e, adapterName) => {
	// disables/enables adapter to apply changes
	const script = `
		Disable-NetAdapter -Name '${adapterName.replace(/'/g, "''")}' -Confirm:$false -ErrorAction Continue
		Enable-NetAdapter -Name '${adapterName.replace(/'/g, "''")}' -Confirm:$false -ErrorAction Continue
		Write-Output "SUCCESS"
	`;
	try {
		const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script]);
		return stdout.trim() === 'SUCCESS';
	} catch (error) {
		return false;
	}
});

ipcMain.handle('mac:dhcp-refresh', async () => { //? to get new localip np
	try {
		await execFileAsync('ipconfig', ['/release']);
		await execFileAsync('ipconfig', ['/renew']);
		return true;
	} catch (error) {
		return false;
	}
});

// hardware identifier spoofing (MachineGuid / HwProfileGuid / MachineId / volume serial)
ipcMain.handle('hwid:detect-anticheat', async () => {
	try {
		return await hwid.detectAnticheats();
	} catch (error) {
		return [];
	}
});

ipcMain.handle('hwid:restore-point', async (e, desc) => {
	try {
		return await hwid.createSystemRestorePoint(desc || 'rblxswap pre-spoof');
	} catch (error) {
		return { ok: false, message: error.message };
	}
});

ipcMain.handle('hwid:backup-exists', () => hwid.backupExists());

ipcMain.handle('hwid:backup-info', () => hwid.backupInfo());

ipcMain.handle('hwid:backup', async () => {
	try {
		const { created } = await hwid.createBackup();
		return { success: true, created };
	} catch (error) {
		return { success: false, message: error.message };
	}
});

ipcMain.handle('hwid:spoof', async (e, opts) => {
	try {
		const results = await hwid.spoofIdentifiers(opts || {});
		return { success: results.some(r => r.ok), results };
	} catch (error) {
		return { success: false, message: error.message };
	}
});

ipcMain.handle('hwid:restore', async (e, opts) => {
	try {
		return await hwid.restoreIdentifiers(opts || {});
	} catch (error) {
		return { ok: false, reason: error.message };
	}
});

ipcMain.handle('hwid:purge-roblox', async () => {
	try {
		return { success: true, ...(await hwid.purgeRobloxTraces()) };
	} catch (error) {
		return { success: false, message: error.message };
	}
});
