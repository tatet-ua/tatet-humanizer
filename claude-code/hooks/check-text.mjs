#!/usr/bin/env node
/**
 * PostToolUse hook для Claude Code.
 *
 * Після кожного Write або Edit перевіряє текстові файли на символи, які
 * видають машинну генерацію, і повертає результат назад моделі через
 * hookSpecificOutput.additionalContext. Не блокує запис: модель бачить
 * зауваження і виправляє сама.
 *
 * Вхід: JSON на stdin від Claude Code.
 * Вихід: JSON на stdout або нічого, якщо все чисто.
 *
 * Налаштування через змінні оточення:
 *   TH_EXT   - розширення через кому (типово md,txt,html,htm)
 *   TH_QUIET - 1, щоб не показувати повідомлення користувачу
 */

import { readFileSync } from 'fs';
import { extname, basename } from 'path';

const EXT = (process.env.TH_EXT || 'md,txt,html,htm')
  .split(',').map(s => '.' + s.trim().replace(/^\./, '').toLowerCase());

// Артефакти копіпасту з чат-інтерфейсів. Одне входження = вирок.
const HARD = [
  [/:contentReference\[oaicite:\d+\]/g, 'ChatGPT: contentReference'],
  [/oai_citation/g, 'ChatGPT: oai_citation'],
  [/[?&]utm_source=chatgpt\.com/g, 'ChatGPT: мітка в посиланні'],
  [/[?&]referrer=grok\.com|grok_card:\/\//g, 'Grok: службова мітка'],
  [/【\d+†[^】]*】/g, 'DeepSeek: розмітка виноски'],
  [/\[cite_start\]|\[cite:\s*\d+\]/g, 'Gemini: розмітка цитати'],
  [/INSERT_SOURCE_URL/g, 'плейсхолдер замість посилання'],
  [/\d{4}-XX-XX/g, 'дата-заглушка'],
];

const INVISIBLE = /[​-‍⁠﻿-]/g;

const NAMES = {
  0x2014: 'довге тире', 0x2013: 'середнє тире',
  0x201C: 'англійська лапка', 0x201D: 'англійська лапка',
  0x201E: 'нижня лапка', 0x2018: 'одинарна лапка',
  0x2019: 'похилий апостроф', 0x00AB: 'ялинка', 0x00BB: 'ялинка',
  0x2026: 'три крапки одним символом', 0x2022: 'буліт',
  0x2192: 'стрілка', 0x21D2: 'стрілка', 0x2194: 'стрілка',
  0x2500: 'псевдографіка', 0x2502: 'псевдографіка',
  0x00A0: 'нерозривний пробіл', 0x202F: 'вузький пробіл',
  0x2009: 'тонкий пробіл', 0x200A: 'волосяний пробіл',
  0x2248: 'приблизно', 0x2264: 'менше або рівно', 0x2265: 'більше або рівно',
  0x2260: 'не дорівнює', 0x00D7: 'знак множення', 0x2212: 'знак мінус',
  0x2713: 'галочка', 0x2714: 'галочка', 0x2605: 'зірка', 0x2606: 'зірка',
  0x2030: 'проміле', 0x00B4: 'гострий наголос', 0x2011: 'нерозривний дефіс',
  0x00B1: 'плюс-мінус', 0x00B0: 'градус',
  0x00BD: 'дріб одним символом', 0x00BC: 'дріб одним символом',
  0x00BE: 'дріб одним символом', 0xFE0F: 'селектор емодзі',
};

// Один список. Окремого режиму для статей більше немає: автор статті теж
// набирає текст на клавіатурі, а типографіку ставить верстальник.
const FORBIDDEN = '[\\u2019\\u2018\\u201C\\u201D\\u201E\\u2026\\u2022\\u2192\\u21D2\\u2194\\u00A0\\u202F\\u2009\\u200A\\u2248\\u2264\\u2265\\u2260\\u00D7\\u2212\\u2713\\u2714\\u2605\\u2030\\u00B4\\u2011\\u00BD\\u00BC\\u00BE\\u2014\\u2013\\u00AB\\u00BB\\u00B1\\u00B0\\u2500-\\u257F\\u2600-\\u27BF\\u2B00-\\u2BFF\\uFE0F]';

function read(stream) {
  return new Promise(resolve => {
    let d = '';
    stream.setEncoding('utf8');
    stream.on('data', c => (d += c));
    stream.on('end', () => resolve(d));
    setTimeout(() => resolve(d), 3000).unref?.();
  });
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

const raw = await read(process.stdin);
let input;
try { input = JSON.parse(raw); } catch { process.exit(0); }

const file =
  input?.tool_response?.filePath ||
  input?.tool_input?.file_path ||
  '';
if (!file) process.exit(0);

if (!EXT.includes(extname(file).toLowerCase())) process.exit(0);
if (/[\\/](node_modules|\.git|dist|build|vendor)[\\/]/.test(file)) process.exit(0);

let text;
try { text = readFileSync(file, 'utf8'); } catch { process.exit(0); }

// Файл сам описує ознаки ШІ: там ці рядки є предметом опису.
if (/tatet-humanizer|plain-text-output|Signs of AI writing/.test(text)) process.exit(0);

const hard = [];
for (const [re, label] of HARD) {
  const m = text.match(re);
  if (m) hard.push(`${label} (${m.length})`);
}

const invis = (text.match(INVISIBLE) || []).length;

const re = new RegExp(FORBIDDEN, 'gu');
const counts = new Map();
for (const ch of text.match(re) || []) {
  const cp = ch.codePointAt(0);
  counts.set(cp, (counts.get(cp) || 0) + 1);
}
for (const ch of text.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g) || []) {
  const cp = ch.codePointAt(0);
  counts.set(cp, (counts.get(cp) || 0) + 1);
}

const total = [...counts.values()].reduce((a, b) => a + b, 0);
if (!hard.length && !invis && !total) process.exit(0);

const per1k = text.length ? Math.round(total * 1000 / text.length * 100) / 100 : 0;
const name = basename(file);
const lines = [];

if (hard.length || invis) {
  lines.push(`У файлі ${name} знайдено артефакти копіпасту з чат-інтерфейсу.`);
  hard.forEach(h => lines.push(`  - ${h}`));
  if (invis) lines.push(`  - невидимі символи або приватна зона Unicode (${invis})`);
  lines.push('Це прямий слід, а не стилістика. Прибрати обов\'язково.');
}

if (total) {
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([cp, n]) => {
      const label = NAMES[cp] || 'емодзі або спецсимвол';
      return `  - ${label} U+${cp.toString(16).toUpperCase().padStart(4, '0')}: ${n}`;
    });
  lines.push(
    `У файлі ${name} знайдено ${total} символів, яких немає на клавіатурі ` +
    `(щільність ${per1k} на 1000 знаків):`
  );
  lines.push(...top);
  if (counts.size > 8) lines.push(`  ... та ще ${counts.size - 8} видів`);
  lines.push(
    'Замінити на клавіатурні відповідники: прямий апостроф, прямі лапки, ' +
    'три крапки окремо, дефіс замість тире, x замість знаку множення. ' +
    'Символи всередині блоків коду, URL і цитованих даних не чіпати.'
  );
}

const message = lines.join('\n');

out({
  suppressOutput: true,
  ...(process.env.TH_QUIET === '1' ? {} : {
    systemMessage: hard.length || invis
      ? `tatet-humanizer: у ${name} артефакти копіпасту з чату`
      : `tatet-humanizer: у ${name} ${total} спецсимволів (${per1k} на 1000)`
  }),
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: message,
  },
});
