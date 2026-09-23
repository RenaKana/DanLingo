import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { basename, delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function checkedExecutable(path, source) {
  const absolute = resolve(path);
  let valid = false;
  try {
    valid = existsSync(absolute) && statSync(absolute).isFile();
    if (valid) accessSync(absolute, constants.X_OK);
  } catch { valid = false; }
  if (!valid) throw new Error(`${source} browser executable does not exist or is not a file: ${absolute}`);
  return absolute;
}

function checkedBrandExecutable(path, brand, source) {
  const absolute = checkedExecutable(path, source);
  const leaf = basename(absolute).toLowerCase();
  if (brand === 'edge' && /^(?:chrome|chromium)(?:\.exe)?$/u.test(leaf)) {
    throw new Error(`The selected executable is Chrome/Chromium but the requested browser brand is Edge: ${absolute}`);
  }
  if (brand === 'chrome' && /^msedge(?:\.exe)?$/u.test(leaf)) {
    throw new Error(`The selected executable is Edge but the requested browser brand is Chrome: ${absolute}`);
  }
  return absolute;
}

function explicitExecutable(executablePath) {
  return executablePath || process.env.DANLINGO_TEST_BROWSER || process.env.DANLINGO_E2E_EXECUTABLE || null;
}

function normalizeBrowserName(browserName) {
  const name = String(browserName || 'chromium').toLowerCase();
  if (['edge', 'msedge'].includes(name)) return 'edge';
  if (['chrome', 'google-chrome'].includes(name)) return 'chrome';
  if (['chromium', ''].includes(name)) return 'chromium';
  throw new Error(`Unsupported browser brand "${browserName}"; use chromium, chrome, or edge.`);
}

export async function loadPlaywright() {
  const configuredPath = process.env.DANLINGO_PLAYWRIGHT_MODULE;
  if (configuredPath) {
    const modulePath = resolve(configuredPath);
    let valid = false;
    try { valid = existsSync(modulePath) && statSync(modulePath).isFile(); } catch { /* Explain the configured path below. */ }
    if (!valid) throw new Error(`DANLINGO_PLAYWRIGHT_MODULE does not point to an existing file: ${modulePath}`);
    try { return await import(pathToFileURL(modulePath).href); }
    catch (error) { throw new Error(`Could not load Playwright from DANLINGO_PLAYWRIGHT_MODULE: ${modulePath}`, { cause: error }); }
  }

  let moduleUrl;
  try { moduleUrl = import.meta.resolve('playwright'); }
  catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    throw new Error('Playwright is not installed. Install it in this project or set DANLINGO_PLAYWRIGHT_MODULE to an existing module file. No browser or package is downloaded.', { cause: error });
  }
  try { return await import(moduleUrl); }
  catch (error) { throw new Error(`Could not load the installed Playwright module: ${moduleUrl}`, { cause: error }); }
}

export function browserLaunchOptions(browserName = 'chromium', options = {}) {
  const brand = normalizeBrowserName(browserName);
  const selectedPath = explicitExecutable(options.executablePath);
  if (selectedPath) {
    const path = checkedBrandExecutable(selectedPath, brand, 'Configured');
    return { executablePath: path };
  }
  if (brand === 'edge') return { channel: 'msedge' };
  if (brand === 'chrome') return { channel: 'chrome' };
  return {};
}

function executableCandidates(brand) {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
    .filter(Boolean);
  const relative = brand === 'edge'
    ? ['Microsoft/Edge/Application/msedge.exe']
    : brand === 'chrome'
      ? ['Google/Chrome/Application/chrome.exe']
      : [];
  const candidates = roots.flatMap(root => relative.map(path => join(root, path)));
  const names = brand === 'edge' ? ['msedge.exe', 'msedge'] : brand === 'chrome' ? ['chrome.exe', 'chrome', 'google-chrome'] : ['chromium', 'chromium-browser'];
  for (const name of names) {
    for (const directory of (process.env.PATH || '').split(delimiter).filter(Boolean)) candidates.push(join(directory, name));
  }
  if (process.platform === 'linux' && brand === 'chromium') candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser');
  return candidates;
}

export function browserExecutablePath(browserName = 'chromium', options = {}) {
  const brand = normalizeBrowserName(browserName);
  const selectedPath = explicitExecutable(options.executablePath);
  if (selectedPath) return checkedBrandExecutable(selectedPath, brand, 'Configured');

  if (brand === 'chromium' && options.playwrightBrowser?.executablePath) {
    return checkedBrandExecutable(options.playwrightBrowser.executablePath(), brand, 'Playwright');
  }
  for (const candidate of executableCandidates(brand)) {
    try { if (existsSync(candidate) && statSync(candidate).isFile()) return resolve(candidate); }
    catch { /* Continue through known install locations and PATH. */ }
  }
  throw new Error(`No installed ${brand} executable was found. Set DANLINGO_TEST_BROWSER or DANLINGO_E2E_EXECUTABLE to an existing browser file.`);
}
