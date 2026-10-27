// Offline stress test for js/engine.js.
// Runs the engine + master processors outside the browser with extreme and random settings
// and fails if the output ever contains NaN/Inf or exceeds the hard ceiling.
// Usage: node tools/stress-test.mjs [seconds-per-case]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'js', 'engine.js'), 'utf8');
const SECS = Number(process.argv[2] || 30);
const SR = 48000;

const procs = {};
const sandbox = new Function('sampleRate', 'AudioWorkletProcessor', 'registerProcessor', src);
class AWP { constructor() { this.port = { postMessage() {}, onmessage: null }; } }
sandbox(SR, AWP, (name, cls) => { procs[name] = cls; });
const Engine = procs['harvest-engine'], Master = procs['harvest-master'];

const KEYS = ['dens','size','pitch','scat','cut','res','drive','ffm','ratio','depth','cplx','xmod','rate','decay','gate','voice','fb','echo','width','pmo','level','x1','x2','x3','x4'];
const GKEYS = ['growth','evolve','myc','spores','abstr','melody','range','pull','glide','pulse','dyn','mut','reach'];
const noise = s => Float32Array.from({ length: SR * s }, () => Math.random() * 2 - 1);
const sine = s => Float32Array.from({ length: SR * s }, (_, i) => Math.sin(i / SR * 2 * Math.PI * 220));
const randPos = () => Array.from({ length: 8 }, () => [Math.random() * 2 - 1, Math.random() * 2 - 1]);

function make(all) {
  const e = new Engine(), m = new Master();
  e.msg({ t: 'pos', v: randPos() });
  for (let i = 0; i < 8; i++) {
    e.msg({ t: 'buf', c: i, data: i % 2 ? noise(4) : sine(4) });
    const v = {}; KEYS.forEach(k => v[k] = all ?? Math.random()); e.msg({ t: 'pall', c: i, v });
    e.msg({ t: 'el', c: i, v: i % 4 });
  }
  if (all != null) { GKEYS.forEach(k => e.G[k] = all); Object.assign(m.G, { tilt: all, drive: all, vol: all }); }
  return { e, m };
}

function run(name, { e, m }, secs, mutate) {
  const dry = [new Float32Array(128), new Float32Array(128)], out = [new Float32Array(128), new Float32Array(128)];
  let peak = 0, sum = 0, bad = 0;
  const blocks = Math.floor(secs * SR / 128), t0 = performance.now();
  for (let b = 0; b < blocks; b++) {
    if (mutate) mutate(e, m, b);
    e.process([], [dry]);
    m.process([dry, dry], [out]); // second input stands in for the reverb return
    for (let i = 0; i < 128; i++) {
      const l = out[0][i], r = out[1][i];
      if (!Number.isFinite(l) || !Number.isFinite(r)) bad++;
      peak = Math.max(peak, Math.abs(l), Math.abs(r)); sum += l * l + r * r;
    }
  }
  const load = (performance.now() - t0) / (secs * 1000) * 100;
  const ok = bad === 0 && peak <= 0.981;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(26)} peak ${peak.toFixed(3)}  rms ${(10 * Math.log10(sum / (blocks * 256) + 1e-12)).toFixed(1)} dB  cpu ${load.toFixed(0)}%  resets ${e.resets}`);
  return ok;
}

let ok = true;
ok &= run('all controls at maximum', make(1), SECS);
ok &= run('all controls at zero', make(0), SECS / 2);
const fz = make();
ok &= run('random every 0.25 s', fz, SECS * 2, (e, m, b) => {
  if (b % 94) return;
  for (let i = 0; i < 8; i++) { const v = {}; KEYS.forEach(k => v[k] = Math.random()); e.msg({ t: 'pall', c: i, v }); e.msg({ t: 'el', c: i, v: Math.floor(Math.random() * 4) }); }
  GKEYS.forEach(k => e.G[k] = Math.random()); m.G.drive = Math.random(); m.G.vol = Math.random();
  const w = [0, 0, 0, 0].map(Math.random), s = w.reduce((a, c) => a + c); e.mw = w.map(x => x / s);
  e.msg({ t: 'pos', v: randPos() });
});
const fb = make(.5);
for (let i = 0; i < 8; i++) fb.e.msg({ t: 'pall', c: i, v: { res: 1, fb: 1, ffm: 1, depth: 1, cplx: 1, xmod: 1, drive: 1, gate: 0, echo: 0, level: 1 } });
fb.e.G.evolve = 0;
ok &= run('resonance + feedback max', fb, SECS);
console.log(ok ? '\nAll cases stayed finite and under the ceiling.' : '\nSome cases failed.');
process.exit(ok ? 0 : 1);
