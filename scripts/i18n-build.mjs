// Rebuild packaged browser metadata and apply reviewed wording without network access.
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
const source = JSON.parse(await readFile('src/i18n/locales/zh-CN.json', 'utf8'));
const keys = Object.keys(source).sort();
const parameters = value => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]).sort().join(',');
for (const file of (await readdir('src/i18n/locales')).filter(name => name.endsWith('.json'))) {
  const code = file.slice(0, -5), path = 'src/i18n/locales/' + file;
  const catalog = JSON.parse(await readFile(path, 'utf8'));
  try { Object.assign(catalog, JSON.parse(await readFile('src/i18n/overrides/' + file, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (JSON.stringify(Object.keys(catalog).sort()) !== JSON.stringify(keys)) throw new Error('Incomplete locale: ' + code);
  for (const key of keys) {
    if (typeof catalog[key] !== 'string' || !catalog[key].trim() || parameters(catalog[key]) !== parameters(source[key])) throw new Error('Invalid message: ' + code + ':' + key);
  }
  await writeFile(path, JSON.stringify(catalog, null, 2) + '\n');
  const directory = 'public/_locales/' + code.replaceAll('-', '_'); await mkdir(directory, { recursive: true });
  await writeFile(directory + '/messages.json', JSON.stringify({
    extensionName: { message: catalog['extension.name'] },
    extensionDescription: { message: catalog['extension.description'] },
    extensionShortcut: { message: catalog['extension.shortcut'] },
  }, null, 2) + '\n');
}
console.log(JSON.stringify({ locales: 20, messages: keys.length, metadata: 'public/_locales' }));
