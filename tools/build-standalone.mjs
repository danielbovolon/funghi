// Builds single-file versions of Harvest from index.html + css + js:
//   dist/harvest.html   a complete, self-contained page (open from any web server)
//   dist/artifact.html  the same content without <html>/<head>/<body> wrappers (for claude.ai artifacts)
// The AudioWorklet source is embedded as <script type="text/plain" id="engine-src">; app.js loads it from a blob URL.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = f => readFileSync(join(root, f), 'utf8');
const html = rd('index.html'), css = rd('css/harvest.css'), app = rd('js/app.js'), engine = rd('js/engine.js');

if ([...engine].some(ch => ch.charCodeAt(0) > 127)) throw new Error('js/engine.js must be ASCII-only (it is embedded via btoa).');
for (const [n, s] of [['css', css], ['app.js', app], ['engine.js', engine]]) if (/<\/script/i.test(s)) throw new Error(n + ' contains </script>');

const full = html
  .replace('<link rel="stylesheet" href="css/harvest.css">', () => '<style>\n' + css + '</style>')
  .replace('<script src="js/app.js"></script>', () => '<script type="text/plain" id="engine-src">\n' + engine + '</script>\n<script>\n' + app + '</script>');

const head = full.match(/<head>([\s\S]*?)<\/head>/)[1]
  .replace(/<meta charset[^>]*>\s*/i, '').replace(/<meta name="viewport"[^>]*>\s*/i, '');
const title = head.match(/<title>[\s\S]*?<\/title>/)[0];
const body = full.match(/<body>([\s\S]*?)<\/body>/)[1];
const fragment = title + '\n' + head.replace(title, '').trim() + '\n' + body.trim() + '\n';

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'harvest.html'), full);
writeFileSync(join(root, 'dist', 'artifact.html'), fragment);
console.log('dist/harvest.html  ' + (full.length / 1024).toFixed(0) + ' KB');
console.log('dist/artifact.html ' + (fragment.length / 1024).toFixed(0) + ' KB');
