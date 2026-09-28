// Deterministic source catalog assembly; no network or credentials.
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';
const key = text => 'm_' + createHash('sha256').update(text.trim()).digest('hex').slice(0, 12);
const files = ['entrypoints/background.ts', 'entrypoints/live.content.ts', 'entrypoints/watch.content.ts',
  'src/core/adapter-diagnostic.ts', 'src/core/connection.ts', 'src/local/directory-errors.ts',
  'src/local/translation-profile.ts', 'src/local/load-diagnostics.ts', 'src/ui/theme.ts', 'src/core/model-summary.ts'];
const backend = {};
for (const file of files) {
  const tree = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = node => {
    let text;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
    if (ts.isTemplateExpression(node)) text = node.head.text + node.templateSpans.map((span, i) => '{p' + i + '}' + span.literal.text).join('');
    if (text && /\p{Script=Han}/u.test(text) && !/<[a-z][\s>]/i.test(text)) backend[key(text)] = text.trim();
    ts.forEachChild(node, visit);
  };
  visit(tree);
}
await writeFile('src/i18n/backend-messages.json', JSON.stringify(backend, null, 2) + '\n');
const source = { 'locale.auto': '跟随浏览器', 'locale.label': '界面语言',
  'locale.saveError': '界面语言未能保存，请重试', 'error.unknown': '操作未完成，请检查设置后重试。',
  'extension.name': 'DanLingo · 弹幕翻译', 'extension.description': '在 Niconico、YouTube 与 Bilibili 原生页面翻译弹幕和直播聊天。',
  'extension.shortcut': '开启或关闭弹幕翻译' };
for (const file of (await readdir('src/i18n')).filter(file => file.endsWith('-messages.json'))) {
  const values = JSON.parse(await readFile('src/i18n/' + file, 'utf8'));
  for (const [id, text] of Object.entries(values)) {
    if (source[id] && source[id] !== text) throw new Error('Conflicting localization key: ' + id);
    source[id] = text;
  }
}
await mkdir('src/i18n/locales', { recursive: true });
await writeFile('src/i18n/locales/zh-CN.json', JSON.stringify(source, null, 2) + '\n');
console.log(JSON.stringify({ sourceMessages: Object.keys(source).length, backendMessages: Object.keys(backend).length }));
