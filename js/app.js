/*
 * HARVEST - user interface and control layer.
 * The DSP lives in js/engine.js (AudioWorklet). This file builds the page, keeps the state,
 * talks to the worklets by message, runs the map, the store/player and file export.
 */
(() => {
"use strict";
const $ = s => document.querySelector(s);
const PHI = (1 + Math.sqrt(5)) / 2, GA = Math.PI * 2 * (1 - 1 / PHI);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v, R = Math.random, lerp = (a, b, t) => a + (b - a) * t;
const pick = a => a[Math.floor(R() * a.length)];
const css = getComputedStyle(document.documentElement);
const COL = {}; ['basalt','slate','moss','rule','rule2','bone','sage','dim','earth','water','air','fire'].forEach(k => COL[k] = css.getPropertyValue('--' + k).trim());
const ELN = ['EARTH','WATER','AIR','FIRE'], ELC = [COL.earth, COL.water, COL.air, COL.fire];
const NOTES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
const st2r = s => 2 ** (s / 12);
const phiScale = [0,.5,1,1.5,2,2.5].map(k => { let r = PHI ** k; while (r >= 2) r /= 2; return r; }).sort((a, b) => a - b);
const SCALES = {PENTA:[0,3,5,7,10].map(st2r), DORIAN:[0,2,3,5,7,9,10].map(st2r), LYDIAN:[0,2,4,6,7,9,11].map(st2r),
  PHRYGIAN:[0,1,3,5,7,8,10].map(st2r), HARMONICS:[8,9,10,11,12,13,14,15].map(n => n / 8), 'φ GOLDEN':phiScale};
const fHz = x => x >= 1000 ? (x / 1000).toFixed(2) + ' kHz' : x.toFixed(x < 10 ? 2 : 0) + ' Hz';
const fS = x => x >= 1 ? x.toFixed(2) + ' s' : (x * 1000).toFixed(0) + ' ms';
const pct = v => Math.round(v * 100) + '%';
const fmtT = (s, t) => { s = Math.max(0, s); const m = Math.floor(s / 60), x = s - m * 60; return String(m).padStart(2, '0') + ':' + (t ? x.toFixed(1).padStart(4, '0') : String(Math.floor(x)).padStart(2, '0')); };

/* ------------------------------------------------------------- parameters */
const KEYS = ['dens','size','pitch','scat','cut','res','drive','ffm','ratio','depth','cplx','xmod','rate','decay','gate','voice','fb','echo','width','pmo','level','x1','x2','x3','x4'];
const PD = {
  dens:{l:'Density',f:v => (.5 * 120 ** v).toFixed(1) + ' /s',h:'How many grains per second are cut from the recording.'},
  size:{l:'Size',f:v => fS(.012 * 150 ** v),h:'Length of each grain. Short = dust and clicks, long = smeared phrases.'},
  pitch:{l:'Pitch',f:v => ((v - .5) * 48).toFixed(1) + ' st',h:'Transposes the grains. Pull (harmony) snaps them into the scale.'},
  scat:{l:'Scatter',f:pct,h:'Randomises where grains are taken from and when they start.'},
  cut:{l:'Cutoff',f:v => fHz(40 * 450 ** v),h:'Filter cutoff.'},
  res:{l:'Resonance',f:v => 'Q ' + (.5 + 11.5 * v ** 1.5).toFixed(1),h:'Emphasis at the cutoff. Capped below self-oscillation, so it cannot run away.'},
  drive:{l:'Drive',f:pct,h:'Waveshaping: saturates the sound before the filter.'},
  ffm:{l:'Filter FM',f:v => (v * 4).toFixed(1) + ' oct',h:'The FM modulator sweeps the filter cutoff at audio rate.'},
  ratio:{l:'Ratio',f:v => '×' + (.25 * 32 ** v).toFixed(2),h:'Modulator frequency relative to the note. Snaps to clean ratios unless Abstract is up.'},
  depth:{l:'FM depth',f:v => 'I ' + (v * 8).toFixed(1),h:'FM index: how bright and metallic the ping tone gets.'},
  cplx:{l:'Complex',f:v => 'I₂ ' + (v * 5).toFixed(1),h:'A second modulator that modulates the first one: complex FM.'},
  xmod:{l:'Cross-mod',f:pct,h:'The recording itself modulates the FM tone.'},
  rate:{l:'Ping rate',f:v => { const x = .05 * 300 ** v; return (x < 1 ? x.toFixed(2) : x.toFixed(1)) + ' Hz'; },h:'How often the channel pings. Life, Pulse and Dynamics scale it.'},
  decay:{l:'Decay',f:v => fS(.02 * 200 ** v),h:'How long each ping rings and how long the gate stays open.'},
  gate:{l:'LP gate',f:pct,h:'Low pass gate depth: closes level and brightness between pings.'},
  voice:{l:'Tone',f:pct,h:'Level of the FM tone inside each ping.'},
  fb:{l:'Feedback',f:pct,h:'Feedback through the filter. Always kept below unity gain, so it rings but never runs away.'},
  echo:{l:'Echo time',f:v => fS(.01 * 150 ** v),h:'Delay time of the feedback loop.'},
  width:{l:'Width',f:pct,h:'Stereo width.'},
  pmo:{l:'Pan motion',f:pct,h:'How far the channel drifts across the stereo field. Its home position is its place on the map.'},
  level:{l:'Level',f:v => v <= 0 ? '−∞ dB' : (20 * Math.log10(v * v * 2)).toFixed(1) + ' dB',h:'Channel level. Each channel also has its own automatic level guard.'}
};
/* each element has its own four controls and its own sound */
const EX = [
  [['Rumble','Sub-bass body under every ping, like ground being struck.'],['Weight','Pulls the grains up to an octave down: heavier, slower matter.'],['Tremor','Slow trembling of the level.'],['Grit','Sample-rate and bit reduction: gravel, sand, dust.']],
  [['Drips','Rising water-drop tones scattered through the channel.'],['Ripple','A modulated delay: the sound wobbles like light on water.'],['Depth','Narrow band-pass at 0, full low-pass at 100%.'],['Flow','How fast and how forward the grains stream through the recording.']],
  [['Breath','Filtered noise that breathes with each note.'],['Whistle','A resonant comb tuned to the note: reeds, bottles, hollow pipes.'],['Gust','Random swells of level and brightness.'],['Shimmer','Chance that a grain jumps an octave or more up.']],
  [['Crackle','How many embers pop.'],['Fold','How hard the wavefolder bends the sound.'],['Flicker','Fast random gating, like a flame.'],['Heat','More FM depth and brightness.']]
];
const ELDESC = ['low octave, long slow grains, warm low-pass, long echoes','high octave, resonant pings, band-pass, moving pan','long airy grains, bright and wide','short grains, wavefolding, crackle'];
/* every element starts from its own settings; each channel remembers its settings per element */
const ELDEF = [
  {dens:.42,size:.7,pitch:.44,scat:.25,cut:.45,res:.25,drive:.1,ffm:0,ratio:.3,depth:.12,cplx:0,xmod:.05,rate:.32,decay:.62,gate:.25,voice:.3,fb:.22,echo:.62,width:.4,pmo:.15,level:.72,x1:.5,x2:.3,x3:.2,x4:.12},
  {dens:.55,size:.42,pitch:.55,scat:.45,cut:.65,res:.55,drive:0,ffm:.1,ratio:.5,depth:.2,cplx:.1,xmod:0,rate:.52,decay:.36,gate:.4,voice:.4,fb:.15,echo:.3,width:.6,pmo:.5,level:.72,x1:.5,x2:.4,x3:.6,x4:.45},
  {dens:.6,size:.76,pitch:.55,scat:.5,cut:.72,res:.3,drive:0,ffm:.05,ratio:.62,depth:.1,cplx:.05,xmod:0,rate:.26,decay:.7,gate:.15,voice:.25,fb:.1,echo:.5,width:.8,pmo:.45,level:.72,x1:.5,x2:.35,x3:.5,x4:.3},
  {dens:.5,size:.3,pitch:.5,scat:.6,cut:.7,res:.3,drive:.3,ffm:.2,ratio:.55,depth:.35,cplx:.2,xmod:.1,rate:.5,decay:.25,gate:.45,voice:.35,fb:.12,echo:.2,width:.5,pmo:.3,level:.72,x1:.5,x2:.4,x3:.35,x4:.3}
];
const ROWS = [['EL','',['x1','x2','x3','x4']],['GRAIN','slices of the recording',['dens','size','pitch','scat']],['TONE','shape and filter',['cut','res','drive','ffm']],
  ['FM','tone of each ping',['ratio','depth','cplx','xmod']],['PULSE','pings and gate',['rate','decay','gate','voice']],['SPACE','feedback, stereo',['fb','echo','width','pmo']]];
const GD = {
  growth:{l:'Growth',d:.35,f:pct,h:'Speed of everything: how fast channels come alive, drift and scan through their recordings.'},
  evolve:{l:'Evolve',d:.3,f:pct,h:'How far every setting wobbles on its own. The glowing dot on each knob shows where it is right now.'},
  myc:{l:'Mycelium',d:.35,f:pct,h:'How strongly channels hear each other and trigger each other’s pings.'},
  spores:{l:'Spores',d:.2,f:pct,h:'How often the system samples its own output and grafts it into channels. Empty channels get their first sound this way.'},
  abstr:{l:'Abstract',d:.15,f:pct,h:'Moves pitch away from the scale toward free, inharmonic tones.'},
  wander:{l:'Wander',d:.1,f:pct,h:'Lets the element seed drift across the pad by itself.'},
  dyn:{l:'Dynamics',d:.45,f:pct,h:'Channels swell, rest and return on their own. At 0 everything plays steadily.'},
  mut:{l:'Mutation',d:.35,f:pct,h:'How often the system rewrites its own settings: knobs move by themselves, and channels may change element.'},
  reach:{l:'Reach',d:.5,f:pct,h:'How far a hypha reaches on the map. Low = only close neighbours connect; high = everything hears everything.'},
  reverb:{l:'Reverb',d:.34,f:pct,h:'Send into the 6-second convolution reverb. Air makes it brighter, Earth darker.'},
  tilt:{l:'Tilt',d:.5,f:v => ((v - .5) * 12).toFixed(1) + ' dB',h:'Dark ↔ bright tilt EQ on the master.'},
  drive:{l:'Warmth',d:.15,f:pct,h:'Gentle saturation on the master before the limiter.'},
  melody:{l:'Melody',d:.4,f:pct,h:'Chance the melodic walk takes a step on each ping.'},
  range:{l:'Range',d:.4,f:v => (1 + Math.floor(v * 3.99)) + ' oct',h:'Octave range of the melodic walk.'},
  pull:{l:'Pull',d:.6,f:pct,h:'How strongly grain pitch is pulled into the scale.'},
  glide:{l:'Glide',d:.2,f:v => fS(.003 * 200 ** v),h:'Portamento between ping notes.'},
  pulse:{l:'Pulse',d:.5,f:v => '×' + (.25 * 16 ** v).toFixed(2),h:'Multiplies every channel’s ping rate.'},
  vol:{l:'Volume',d:.7,f:v => v <= 0 ? '−∞ dB' : (20 * Math.log10(v * v * 1.6)).toFixed(1) + ' dB',h:'Master volume, before the limiter.'}
};
const MASTER_K = ['tilt','drive','vol'], MAIN_K = ['reverb','wander'];
const G = {}; for (const k in GD) G[k] = GD[k].d;
let root = 2, scale = 'DORIAN';
const pad = {x:0, y:0, tx:0, ty:0, trail:[]}; let MW = [.25,.25,.25,.25];

/* ------------------------------------------------------------- channels + map */
const N = 8;
const chans = [...Array(N)].map((_, i) => ({
  i, el:i % 4, pe:ELDEF.map(d => ({...d})), get p() { return this.pe[this.el]; },
  name:'', peaks:null, gen:false, muted:false, solo:false, life:0, rms:0, act:1, scan:0, flash:0, eff:null, grafts:0, ui:{}
}));
let sel = 0;
const pos = [...Array(N)].map(() => ({x:0, y:0, tx:0, ty:0}));
let W = [...Array(N)].map(() => Array(N).fill(.3));
let Mk = [...Array(N)].map((_, i) => [...Array(N)].map((_, j) => i === j ? 0 : 1));
let freeze = false, tool = 'move', shapeName = 'spiral';
const SHAPES = {
  spiral: rot => [...Array(N)].map((_, i) => { const r = .3 + .62 * Math.sqrt((i + .5) / N), a = i * GA + rot; return [r * Math.cos(a), r * Math.sin(a)]; }),
  ring: rot => [...Array(N)].map((_, i) => { const a = i / N * Math.PI * 2 + rot; return [.86 * Math.cos(a), .8 * Math.sin(a)]; }),
  grid: rot => [...Array(N)].map((_, i) => { const x = -.72 + (i % 4) * .48, y = (i < 4 ? -.42 : .42); const c = Math.cos(rot * .15), s = Math.sin(rot * .15); return [x * c - y * s * .3 + (R() - .5) * .06, y * c + x * s * .3 + (R() - .5) * .06]; }),
  clusters: rot => { const k = 2 + Math.floor(R() * 2), cs = [...Array(k)].map((_, j) => { const a = j / k * Math.PI * 2 + rot; return [.58 * Math.cos(a), .52 * Math.sin(a)]; });
    return [...Array(N)].map((_, i) => { const c = cs[i % k], a = (i / N) * Math.PI * 2 * PHI + R() * .6, r = .2 + R() * .14; return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]; }); },
  river: rot => { const ph = rot * 3; return [...Array(N)].map((_, i) => [-.86 + i * 1.72 / (N - 1), .5 * Math.sin(i * .95 + ph) + (R() - .5) * .1]); },
  scatter: () => { const pts = []; let guard = 0; while (pts.length < N && guard++ < 4000) { const p = [(R() * 2 - 1) * .88, (R() * 2 - 1) * .84]; if (pts.every(q => Math.hypot(p[0] - q[0], p[1] - q[1]) > .42)) pts.push(p); } while (pts.length < N) pts.push([(R() * 2 - 1) * .8, (R() * 2 - 1) * .8]); return pts; }
};
const SHAPE_H = {spiral:'Golden-angle spiral, opening outward. No node sits in the centre.',ring:'All eight channels on one ring: every channel has two close neighbours.',grid:'Two rows of four: a regular lattice.',
  clusters:'Two or three colonies: strong links inside, weak links between.',river:'A chain along a stream: sound flows from neighbour to neighbour.',scatter:'Random constellation with a minimum spacing.'};

let ctx = null, node = null, master = null, revIn = null, conv = null, tone = null, wet = null, irBuf = null;
let running = false, engineState = 'none', enginePromise = null, seedPlan = [], presetName = '';
const post = (m, tr) => { if (node) node.port.postMessage(m, tr || []); };
const postM = m => { if (master) master.port.postMessage(m); };
const harmMsg = () => ({t:'harm', ratios:SCALES[scale], root, golden:scale === 'φ GOLDEN'});
const engG = () => { const o = {}; for (const k in G) if (!MASTER_K.includes(k) && !MAIN_K.includes(k)) o[k] = G[k]; return o; };
function setG(k, v) {
  G[k] = v;
  if (MASTER_K.includes(k)) postM({t:'g', k, v});
  else if (k === 'reverb') updateReverb();
  else if (k !== 'wander') post({t:'g', k, v});
}

/* ------------------------------------------------------------- guide */
const guide = $('#guide');
const DEF_GUIDE = 'Hover any control to see what it does. Drag knobs up/down (Shift = fine, double-click = reset). Keys: Space grow · N seed · R record · 1–8 channel · M mute · K/J/L play, back, forward.';
function help(label, text, val) { guide.textContent = ''; const b = document.createElement('b'); b.textContent = label; guide.append(b, document.createTextNode(text || '')); if (val != null) { const e = document.createElement('em'); e.textContent = val; guide.append(e); } }
function idleGuide() { guide.textContent = DEF_GUIDE; }
function hover(el, label, text) { el.addEventListener('pointerenter', () => help(label, ' ' + (typeof text === 'function' ? text() : text))); el.addEventListener('pointerleave', idleGuide); }
idleGuide();
function status(t) { $('#status').textContent = t; }

/* ------------------------------------------------------------- controls */
function knob(o) {
  const w = document.createElement('div'); w.className = 'kn';
  const k = document.createElement('div'); k.className = 'knob'; k.tabIndex = 0; k.setAttribute('role', 'slider');
  k.setAttribute('aria-valuemin', '0'); k.setAttribute('aria-valuemax', '100'); k.innerHTML = '<i></i><b></b>';
  const lb = document.createElement('label'), out = document.createElement('output');
  w.append(k, lb, out);
  const L = () => typeof o.label === 'function' ? o.label() : o.label, H = () => typeof o.help === 'function' ? o.help() : o.help;
  const show = () => { const v = o.get(); k.style.setProperty('--v', v); k.setAttribute('aria-valuenow', Math.round(v * 100)); out.textContent = o.fmt(v); lb.textContent = L(); k.setAttribute('aria-label', L()); };
  const set = v => { v = clamp(v, 0, 1); o.set(v); show(); help(L().toUpperCase(), ' ' + H(), o.fmt(v)); };
  let sy = 0, sv = 0;
  k.addEventListener('pointerdown', e => { k.setPointerCapture(e.pointerId); sy = e.clientY; sv = o.get(); e.preventDefault(); k.focus(); });
  k.addEventListener('pointermove', e => { if (k.hasPointerCapture(e.pointerId)) set(sv + (sy - e.clientY) / (e.shiftKey ? 700 : 160)); });
  k.addEventListener('dblclick', () => set(o.def()));
  k.addEventListener('wheel', e => { e.preventDefault(); set(o.get() - Math.sign(e.deltaY) * (e.shiftKey ? .005 : .02)); }, {passive:false});
  k.addEventListener('keydown', e => { const s = e.shiftKey ? .005 : .025; if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { set(o.get() + s); e.preventDefault(); } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { set(o.get() - s); e.preventDefault(); } });
  const hv = () => help(L().toUpperCase(), ' ' + H(), o.fmt(o.get()));
  w.addEventListener('pointerenter', hv); k.addEventListener('focus', hv); w.addEventListener('pointerleave', idleGuide);
  show();
  return {el:w, show, mod:v => { k.style.setProperty('--m', v); k.style.setProperty('--mo', 1); }, nomod:() => k.style.setProperty('--mo', 0),
    color:c => { k.style.setProperty('--c', c); w.style.setProperty('--c', c); }, moving:on => w.classList.toggle('moving', on)};
}
function slider(el, o) {
  if (o.color) el.style.setProperty('--c', o.color);
  const show = () => { el.style.setProperty('--v', o.get()); el.setAttribute('aria-valuenow', Math.round(o.get() * 100)); if (o.out) o.out.textContent = o.fmt(o.get()); };
  const set = v => { o.set(clamp(v, 0, 1)); show(); help(o.label.toUpperCase(), ' ' + o.help, o.fmt(o.get())); };
  el.tabIndex = 0; el.setAttribute('role', 'slider'); el.setAttribute('aria-label', o.label);
  const at = e => { const r = el.getBoundingClientRect(); set((e.clientX - r.left) / r.width); };
  el.addEventListener('pointerdown', e => { e.stopPropagation(); el.setPointerCapture(e.pointerId); at(e); });
  el.addEventListener('pointermove', e => { if (el.hasPointerCapture(e.pointerId)) at(e); });
  el.addEventListener('click', e => e.stopPropagation());
  el.addEventListener('dblclick', () => set(o.def));
  el.addEventListener('keydown', e => { if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { set(o.get() + .02); e.preventDefault(); } if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { set(o.get() - .02); e.preventDefault(); } });
  el.addEventListener('pointerenter', () => help(o.label.toUpperCase(), ' ' + o.help, o.fmt(o.get()))); el.addEventListener('pointerleave', idleGuide);
  show(); return {show};
}
function glyph(el, col) {
  const up = el === 2 || el === 3, tri = up ? 'M8 2 L14.5 13.5 L1.5 13.5 Z' : 'M8 14 L1.5 2.5 L14.5 2.5 Z';
  const bar = el === 2 ? '<line x1="4.2" y1="9.4" x2="11.8" y2="9.4" stroke="' + col + '" stroke-width="1.5"/>' : el === 0 ? '<line x1="4.2" y1="6.6" x2="11.8" y2="6.6" stroke="' + col + '" stroke-width="1.5"/>' : '';
  return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="' + tri + '" fill="none" stroke="' + col + '" stroke-width="1.5"/>' + bar + '</svg>';
}

/* ------------------------------------------------------------- header */
const growBtn = $('#grow'), recBtn = $('#rec');
const volS = slider($('#volS'), {label:'Volume', help:GD.vol.h, get:() => G.vol, set:v => setG('vol', v), fmt:GD.vol.f, def:GD.vol.d, out:$('#volO')});
$('#calm').addEventListener('click', () => { calm(); status('Cleared every feedback, echo and reverb tail. Fading back in.'); });
hover($('#calm'), 'CALM', 'Clears all feedback, echo and reverb tails at once and fades back in over 1.5 s. Settings stay as they are.');
hover($('.safety'), 'SAFETY', 'Every channel has its own level guard and soft clipper; the master has a look-ahead limiter at −1 dBFS and a hard ceiling. Feedback is always held below unity gain.');
hover($('#seedBtn'), 'SEED', 'Loads a new random preset: new generated nature sounds, new elements and settings per channel, a new map shape, a new key. Recordings you loaded yourself stay.');
$('#seedBtn').addEventListener('click', () => newSeed());
function calm() { post({t:'panic'}); postM({t:'panic'}); resetReverb(); }

/* ------------------------------------------------------------- strips */
function buildStrips() {
  const host = $('#strips');
  chans.forEach(c => {
    const s = document.createElement('div'); s.className = 'strip';
    s.innerHTML = '<div class="sh"><span class="g"></span><span class="no">' + (c.i + 1) + '</span><span class="eln"></span></div><div class="sn none">empty</div><canvas></canvas><div class="life"><i></i><b></b></div><div class="slider"><i></i></div><div class="sbtns"><button class="sb ld">LOAD</button><button class="sb mu" aria-pressed="false">M</button><button class="sb solo" aria-pressed="false">S</button></div><input type="file" accept="audio/*" hidden>';
    const u = c.ui; u.strip = s; u.g = s.querySelector('.g'); u.eln = s.querySelector('.eln'); u.sn = s.querySelector('.sn'); u.wave = s.querySelector('canvas');
    u.lifeI = s.querySelector('.life i'); u.lifeB = s.querySelector('.life b'); u.mu = s.querySelector('.mu'); u.so = s.querySelector('.solo');
    const fi = s.querySelector('input');
    s.querySelector('.ld').addEventListener('click', e => { e.stopPropagation(); fi.click(); });
    fi.addEventListener('change', () => { if (fi.files[0]) loadFile(c, fi.files[0]); fi.value = ''; });
    u.mu.addEventListener('click', e => { e.stopPropagation(); setMute(c, !c.muted); });
    u.so.addEventListener('click', e => { e.stopPropagation(); setSolo(c, !c.solo); });
    u.level = slider(s.querySelector('.slider'), {label:'Level · ch ' + (c.i + 1), help:PD.level.h, get:() => c.p.level, set:v => { c.p.level = v; post({t:'p', c:c.i, k:'level', v}); if (c.i === sel) chanK.level && chanK.level.show(); }, fmt:PD.level.f, def:.72});
    s.addEventListener('click', () => select(c.i));
    hover(s, 'CHANNEL ' + (c.i + 1), () => ELN[c.el] + ' · life ' + Math.round(c.life * 100) + '% · ' + (c.name || 'empty: it grows from the network and from spores') + '. Click to edit.');
    s.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); s.style.outline = '1px dashed ' + COL.bone; });
    s.addEventListener('dragleave', () => s.style.outline = '');
    s.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); s.style.outline = ''; const f = e.dataTransfer.files[0]; if (f) loadFile(c, f); });
    host.appendChild(s);
  });
}
function paintStrip(c) { const u = c.ui; u.strip.style.setProperty('--c', ELC[c.el]); u.g.innerHTML = glyph(c.el, ELC[c.el]); u.eln.textContent = ELN[c.el]; u.strip.querySelector('.slider').style.setProperty('--c', ELC[c.el]); u.level.show(); u.mu.setAttribute('aria-pressed', c.muted); u.so.setAttribute('aria-pressed', c.solo); }
function setMute(c, v) { c.muted = v; c.ui.mu.setAttribute('aria-pressed', v); post({t:'mute', c:c.i, v}); }
function setSolo(c, v) { c.solo = v; c.ui.so.setAttribute('aria-pressed', v); post({t:'solo', c:c.i, v}); }
function setName(c, name) { c.name = name; c.ui.sn.textContent = name || 'empty'; c.ui.sn.classList.toggle('none', !name); c.ui.sn.title = name; if (c.i === sel) paintChan(); }

/* ------------------------------------------------------------- channel editor */
const chanK = {}, rowEls = [];
function buildChan() {
  const host = $('#rows');
  ROWS.forEach(([name, desc, keys], ri) => {
    const r = document.createElement('div'); r.className = 'row' + (ri === 0 ? ' elrow' : '');
    const l = document.createElement('div'); l.className = 'rl'; l.innerHTML = '<b></b><span></span>'; l.querySelector('b').textContent = name; l.querySelector('span').textContent = desc;
    r.appendChild(l); rowEls.push(l);
    keys.forEach(k => {
      const xi = k[0] === 'x' ? +k[1] - 1 : -1;
      const kn = knob({
        label:xi >= 0 ? () => EX[chans[sel].el][xi][0] : PD[k].l,
        help:xi >= 0 ? () => EX[chans[sel].el][xi][1] + ' (' + ELN[chans[sel].el].toLowerCase() + ' only)' : PD[k].h,
        get:() => chans[sel].p[k], set:v => { chans[sel].p[k] = v; post({t:'p', c:sel, k, v}); },
        fmt:xi >= 0 ? pct : PD[k].f, def:() => ELDEF[chans[sel].el][k]});
      chanK[k] = kn; r.appendChild(kn.el);
    });
    host.appendChild(r);
  });
  const es = $('#elsel');
  ELN.forEach((n, i) => {
    const b = document.createElement('button'); b.className = 'elb'; b.style.setProperty('--c', ELC[i]); b.innerHTML = glyph(i, ELC[i]) + '<span>' + n + '</span>';
    b.addEventListener('click', () => setElement(chans[sel], i));
    hover(b, n, n.charAt(0) + n.slice(1).toLowerCase() + ': ' + ELDESC[i] + '. Each element keeps its own settings for this channel, so switching back restores them.');
    es.appendChild(b);
  });
  const cf = $('#cFile');
  $('#cLoad').addEventListener('click', () => cf.click());
  cf.addEventListener('change', () => { if (cf.files[0]) loadFile(chans[sel], cf.files[0]); cf.value = ''; });
  $('#cClear').addEventListener('click', () => { const c = chans[sel]; c.peaks = null; c.grafts = 0; c.gen = false; setName(c, ''); post({t:'clear', c:sel}); drawWaves(); });
  $('#cMut').addEventListener('click', () => { const c = chans[sel]; KEYS.forEach(k => { if (k !== 'level') c.p[k] = clamp(c.p[k] + (R() - .5) * .3, 0, 1); }); post({t:'pall', c:sel, v:c.p}); paintChan(); status('Channel ' + (sel + 1) + ' mutated.'); });
  $('#cSave').addEventListener('click', () => { const c = chans[sel]; if (!c.peaks) { status('Channel ' + (sel + 1) + ' has no sound yet.'); return; } post({t:'getbuf', c:sel, name:c.name || 'channel ' + (sel + 1)}); });
  hover($('#cLoad'), 'LOAD', 'Load a recording into this channel (WAV, AIFF, MP3, FLAC, OGG). You can also drop files on a node or a strip.');
  hover($('#cSave'), 'SAVE SOUND', 'Saves this channel’s current sound, including everything spores have grafted into it, as a WAV file.');
  hover($('#cClear'), 'CLEAR', 'Removes this channel’s sound. It keeps living from the network and may receive spores.');
  hover($('#cMut'), 'MUTATE', 'Nudges every setting of this channel at random.');
}
function setElement(c, el) {
  c.el = el; post({t:'el', c:c.i, v:el}); post({t:'pall', c:c.i, v:c.p}); paintStrip(c); if (c.i === sel) paintChan();
}
function paintChan() {
  const c = chans[sel], col = ELC[c.el];
  $('#chan').style.setProperty('--cc', col); $('#cnum').textContent = c.i + 1;
  $('#ctitle').textContent = 'CHANNEL · ' + ELN[c.el]; $('#cname').textContent = c.name || 'empty · grows from the network';
  rowEls[0].querySelector('b').textContent = ELN[c.el]; rowEls[0].querySelector('span').textContent = 'its own voice';
  [...$('#elsel').children].forEach((b, i) => b.setAttribute('aria-pressed', i === c.el));
  KEYS.forEach(k => { if (chanK[k]) { chanK[k].color(col); chanK[k].show(); chanK[k].nomod(); } });
}
function select(i) { sel = i; chans.forEach(c => c.ui.strip.setAttribute('aria-current', c.i === i)); post({t:'sel', v:i}); paintChan(); drawWaves(); }

/* ------------------------------------------------------------- system + harmony */
const gK = {};
function buildGlobals() {
  const ok = $('#orgk');
  ['growth','evolve','dyn','mut','myc','reach','spores','abstr','wander','reverb','tilt','drive'].forEach(k => { const kn = knob({label:GD[k].l, help:GD[k].h, get:() => G[k], set:v => setG(k, v), fmt:GD[k].f, def:() => GD[k].d}); gK[k] = kn; ok.appendChild(kn.el); });
  const hk = $('#harmk');
  ['melody','range','pull','glide','pulse'].forEach(k => { const kn = knob({label:GD[k].l, help:GD[k].h, get:() => G[k], set:v => setG(k, v), fmt:GD[k].f, def:() => GD[k].d}); gK[k] = kn; hk.appendChild(kn.el); });
  const rr = $('#roots');
  NOTES.forEach((n, i) => { const b = document.createElement('button'); b.className = 'chip'; b.textContent = n;
    b.addEventListener('click', () => { root = i; paintHarm(); post(harmMsg()); }); hover(b, 'ROOT ' + n, 'The key every channel’s melody and grain pitch is drawn to.'); rr.appendChild(b); });
  const sc = $('#scales');
  const SH = {PENTA:'Minor pentatonic: open, no clashes.', DORIAN:'Dorian: minor with a bright sixth.', LYDIAN:'Lydian: bright, floating raised fourth.', PHRYGIAN:'Phrygian: dark, with a flat second.', HARMONICS:'Partials 8–15 of the natural harmonic series.', 'φ GOLDEN':'Pitches from powers of the golden ratio; FM ratios snap to φ.'};
  Object.keys(SCALES).forEach(s => { const b = document.createElement('button'); b.className = 'chip'; b.textContent = s;
    b.addEventListener('click', () => { scale = s; paintHarm(); post(harmMsg()); }); hover(b, s, SH[s]); sc.appendChild(b); });
}
function paintHarm() { [...$('#roots').children].forEach((c, j) => c.setAttribute('aria-pressed', j === root)); [...$('#scales').children].forEach(c => c.setAttribute('aria-pressed', c.textContent === scale)); }
function paintGlobals() { for (const k in gK) gK[k].show(); volS.show(); paintHarm(); }

/* ------------------------------------------------------------- audio graph */
function makeIR(sec) {
  /* the original Harvest reverb: 6 s of noise that darkens as it decays */
  const sr = ctx.sampleRate, len = Math.floor(sr * sec), b = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); let y = 0;
    for (let i = 0; i < len; i++) { const t = i / len, a = .6 - .55 * t; y += a * ((R() * 2 - 1) - y); d[i] = y * Math.pow(1 - t, 2.2) * (i < sr * .012 ? i / (sr * .012) : 1); } }
  return b;
}
function updateReverb() {
  if (!ctx || !revIn) return;
  const t = ctx.currentTime;
  revIn.gain.setTargetAtTime(G.reverb * G.reverb * 1.3 * (1 + MW[2] * .5), t, .08);
  tone.frequency.setTargetAtTime(clamp(1200 * 2 ** ((MW[2] + MW[1] - MW[0]) * 3 + 1.5), 200, 18000), t, .2);
}
function resetReverb() {
  if (!ctx || !conv) return;
  const t = ctx.currentTime; wet.gain.cancelScheduledValues(t); wet.gain.setTargetAtTime(0, t, .01);
  setTimeout(() => {
    const old = conv; conv = ctx.createConvolver(); conv.buffer = irBuf; revIn.disconnect(); revIn.connect(conv).connect(tone); old.disconnect();
    const t2 = ctx.currentTime; wet.gain.setValueAtTime(0, t2); wet.gain.linearRampToValueAtTime(.9, t2 + 1.5);
  }, 80);
}
function engineURLs() {
  const inline = document.getElementById('engine-src');
  if (inline) { const s = inline.textContent; return [URL.createObjectURL(new Blob([s], {type:'text/javascript'})), 'data:text/javascript;base64,' + btoa(s)]; }
  return ['js/engine.js'];
}
function ensureEngine() {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({latencyHint:'playback'});
    if (!ctx.audioWorklet) throw new Error('This browser has no AudioWorklet support. Use a current Chrome, Edge, Firefox or Safari.');
    let ok = false; for (const u of engineURLs()) { try { await ctx.audioWorklet.addModule(u); ok = true; break; } catch (e) { /* try next */ } }
    if (!ok) throw new Error('The audio engine could not load. Serve the folder over http(s), not file://.');
    node = new AudioWorkletNode(ctx, 'harvest-engine', {numberOfInputs:0, numberOfOutputs:1, outputChannelCount:[2]});
    master = new AudioWorkletNode(ctx, 'harvest-master', {numberOfInputs:2, numberOfOutputs:1, outputChannelCount:[2]});
    revIn = ctx.createGain(); conv = ctx.createConvolver(); irBuf = makeIR(6); conv.buffer = irBuf;
    tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 5000; wet = ctx.createGain(); wet.gain.value = .9;
    node.connect(master, 0, 0); node.connect(revIn); revIn.connect(conv).connect(tone).connect(wet).connect(master, 0, 1); master.connect(ctx.destination);
    node.port.onmessage = e => onEngine(e.data); master.port.onmessage = e => onMaster(e.data);
    sendAll(); updateReverb();
    if (!running) await ctx.suspend();
    engineState = 'ready';
  })().catch(err => { engineState = 'failed'; enginePromise = null; status(err.message || 'Audio could not start.'); throw err; });
  return enginePromise;
}
function sendAll() {
  post({t:'init', seed:(R() * 2147483647) | 0, chans:chans.map(c => ({p:c.p, el:c.el, muted:c.muted, solo:c.solo})), G:engG(), mw:MW, harm:harmMsg(),
    W, M:Mk, pos:pos.map(p => [p.x, p.y]), freeze, sel});
  postM({t:'init', G:{tilt:G.tilt, drive:G.drive, vol:G.vol}});
}
async function grow() {
  try { await ensureEngine(); } catch (e) { return; }
  if (!running) {
    if (!chans.some(c => c.peaks)) placeSeeds();
    running = true; await ctx.resume();
    growBtn.setAttribute('aria-pressed', 'true'); $('#growTxt').textContent = 'PAUSE'; status('Growing · ' + presetName);
  } else {
    running = false; if (rec.on) stopRec(); await ctx.suspend();
    growBtn.setAttribute('aria-pressed', 'false'); $('#growTxt').textContent = 'GROW'; status('Paused.');
  }
  updateHint();
}
growBtn.addEventListener('click', grow);
hover(growBtn, 'GROW', 'Starts the system. The preset’s generated nature sounds sprout first and spread through the network.');
function sendBuf(c, data, name, gen) {
  c.peaks = peaksOf(data, 140); c.grafts = 0; c.gen = !!gen; setName(c, name);
  post({t:'buf', c:c.i, data, life:.3}, [data.buffer]);
  drawWaves(); updateHint();
}
function toMono(ab) {
  const n = Math.min(ab.length, Math.floor(ab.sampleRate * 180)), m = new Float32Array(n), ch = ab.numberOfChannels;
  for (let c = 0; c < ch; c++) { const d = ab.getChannelData(c); for (let i = 0; i < n; i++) m[i] += d[i] / ch; }
  let pk = 0; for (let i = 0; i < n; i++) { const a = Math.abs(m[i]); if (a > pk) pk = a; }
  if (pk > 0) { const g = .9 / pk; for (let i = 0; i < n; i++) m[i] *= g; }
  return m;
}
async function loadFile(c, file) {
  try { await ensureEngine(); } catch (e) { return; }
  try { const ab = await ctx.decodeAudioData(await file.arrayBuffer()); sendBuf(c, toMono(ab), file.name.replace(/\.[^.]+$/, ''), false); status('Loaded “' + file.name + '” into channel ' + (c.i + 1) + '.'); select(c.i); }
  catch (e) { status('Could not read ' + file.name + '. Try WAV, AIFF, MP3, FLAC or OGG.'); }
}
function sowFiles(files, near) {
  const fs = [...files].filter(f => f.type.startsWith('audio') || /\.(wav|aiff?|mp3|flac|ogg|m4a|webm|opus)$/i.test(f.name));
  if (!fs.length) { status('Those files are not audio.'); return; }
  const order = near != null ? [near, ...chans.map(c => c.i).filter(i => i !== near)] : chans.map(c => c.i);
  const free = order.filter(i => (!chans[i].peaks || chans[i].gen) && i !== near);
  fs.forEach((f, k) => { const i = k === 0 && near != null ? near : (free.shift() ?? order[k % N]); loadFile(chans[i], f); });
}
function peaksOf(d, n) { const p = new Float32Array(n), st = d.length / n; let mx = 0; for (let i = 0; i < n; i++) { let m = 0; const a = Math.floor(i * st), z = Math.floor((i + 1) * st), s = Math.max(1, (z - a) >> 6); for (let j = a; j < z; j += s) { const v = Math.abs(d[j]); if (v > m) m = v; } p[i] = m; if (m > mx) mx = m; } if (mx) for (let i = 0; i < n; i++) p[i] /= mx; return p; }

/* ------------------------------------------------------------- generated seed sounds */
const SEEDS = {
  rain:{name:'rain on slate', el:1}, stream:{name:'mountain stream', el:1}, wind:{name:'wind in reeds', el:2}, embers:{name:'embers', el:3},
  stones:{name:'struck stones', el:0}, glass:{name:'glass and ice', el:2}, thunder:{name:'distant thunder', el:0}
};
function svf(sr) { let a = 0, b = 0; return (x, f, q) => { const g = Math.tan(Math.PI * Math.min(f, sr * .45) / sr), k = 1 / q, a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2, v3 = x - b, v1 = a1 * a + a2 * v3, v2 = b + a2 * a + a3 * v3; a = 2 * v1 - a; b = 2 * v2 - b; return v1; }; }
function smoothWalk(len, rate, sr) { const o = new Float32Array(len); let v = R(), t = R(), c = 0; for (let i = 0; i < len; i++) { if (--c <= 0) { t = R(); c = sr / rate * (.5 + R()); } v += (t - v) * (rate * 2 / sr); o[i] = v; } return o; }
function genSeed(type, sr) {
  const len = Math.floor(sr * (7 + R() * 4)), d = new Float32Array(len), T = i => i / sr;
  const add = (t0, n, fn) => { for (let i = 0; i < n && t0 + i < len; i++) d[t0 + i] += fn(i / sr, i); };
  if (type === 'rain') {
    let y = 0, y2 = 0; for (let i = 0; i < len; i++) { y += .05 * ((R() * 2 - 1) - y); y2 += .3 * (y - y2); d[i] = (y - y2 * .5) * 1.4 * (.55 + .45 * Math.sin(T(i) * .9)); }
    const n = 150 + R() * 150; for (let k = 0; k < n; k++) { const f0 = 500 + R() * 2600, amp = .2 + R() * .7, dec = .01 + R() * .05; let ph = 0; add(Math.floor(R() * len), sr * .2, t => { ph += 2 * Math.PI * f0 * (1 + t * 12) / sr; return Math.sin(ph) * amp * Math.exp(-t / dec); }); }
    for (let k = 0; k < 7; k++) { const f = 90 + R() * 160; add(Math.floor(R() * len), sr * 1.5, t => (Math.sin(2 * Math.PI * f * t + Math.sin(2 * Math.PI * f * 1.414 * t) * 1.6 * Math.exp(-t * 3)) * .5 + Math.sin(2 * Math.PI * f * 2.76 * t) * .2) * Math.exp(-t / .45)); }
  } else if (type === 'stream') {
    const env = smoothWalk(len, .4, sr); let y = 0; for (let i = 0; i < len; i++) { y += .12 * ((R() * 2 - 1) - y); d[i] = y * .5 * (.4 + .6 * env[i]); }
    const n = 300 + R() * 300; for (let k = 0; k < n; k++) { const f0 = 300 + R() * 1200, rise = 1.5 + R() * 2.5, dur = .012 + R() * .05, amp = .15 + R() * .5; let ph = 0;
      add(Math.floor(R() * len), sr * dur * 3, t => { ph += 2 * Math.PI * f0 * Math.pow(rise, t / dur) / sr; return Math.sin(ph) * amp * Math.exp(-t / dur); }); }
  } else if (type === 'wind') {
    const f1 = svf(sr), f2 = svf(sr), f3 = svf(sr), g = smoothWalk(len, .3, sr), c = smoothWalk(len, .2, sr), w = smoothWalk(len, .5, sr);
    const q = 1.5 + R() * 4, wf = 600 + R() * 1600, wf2 = wf * (1.2 + R() * .6);
    for (let i = 0; i < len; i++) { const n = R() * 2 - 1; d[i] = f1(n, 250 + c[i] * 1600, q) * (.2 + g[i]) * 1.2 + f2(n, wf * (1 + c[i] * .1), 40) * w[i] * 2.5 + f3(n, wf2, 60) * (1 - w[i]) * g[i] * 2; }
  } else if (type === 'embers') {
    let y = 0; const env = smoothWalk(len, .25, sr); for (let i = 0; i < len; i++) { y += .004 * ((R() * 2 - 1) - y); d[i] = y * 6 * (.4 + .6 * env[i]); }
    const n = 200 + R() * 350; for (let k = 0; k < n; k++) { const amp = Math.pow(R(), 3) * 1.2 + .05, dur = .0003 + R() * .004, tonal = R() < .2, f = 1200 + R() * 3000;
      add(Math.floor(R() * len), sr * dur * 5, t => (tonal ? Math.sin(2 * Math.PI * f * t) : R() * 2 - 1) * amp * Math.exp(-t / dur)); }
  } else if (type === 'stones') {
    const P = [1, 2.32, 4.25, 6.63, 9.38], n = 8 + R() * 10;
    for (let k = 0; k < n; k++) { const f0 = 140 + R() * 500, decs = P.map((_, j) => (.2 + R() * .8) / (1 + j * .7)), amps = P.map((_, j) => (.6 + R() * .4) / (1 + j * .6)), amp = .4 + R() * .6;
      add(Math.floor(R() * len), sr * 1.4, t => { let s = 0; for (let j = 0; j < 5; j++) s += Math.sin(2 * Math.PI * f0 * P[j] * t) * amps[j] * Math.exp(-t / decs[j]); return (s + (t < .004 ? (R() * 2 - 1) * (1 - t / .004) : 0)) * amp; }); }
    const f = svf(sr), env = smoothWalk(len, .6, sr); for (let i = 0; i < len; i++) d[i] += f(R() * 2 - 1, 1800 + env[i] * 1500, 3) * Math.max(0, env[i] - .55) * 1.2;
  } else if (type === 'glass') {
    const n = 7 + R() * 8, ratio = pick([1.4, 2.76, 3.5, PHI * 2]);
    for (let k = 0; k < n; k++) { const f = 400 + R() * 2200, dec = .8 + R() * 2, idx = 2 + R() * 3, amp = .3 + R() * .6;
      add(Math.floor(R() * len), sr * 3, t => Math.sin(2 * Math.PI * f * t + Math.sin(2 * Math.PI * f * ratio * t) * idx * Math.exp(-t * 4)) * amp * Math.exp(-t / dec) * Math.min(1, t * 400)); }
    for (let k = 0; k < 60; k++) { const f = 4000 + R() * 5000; add(Math.floor(R() * len), sr * .02, t => Math.sin(2 * Math.PI * f * t) * .15 * Math.exp(-t / .003)); }
  } else { /* thunder */
    let y = 0, y2 = 0; for (let i = 0; i < len; i++) { y += .003 * ((R() * 2 - 1) - y); y2 += .02 * ((R() * 2 - 1) - y2); d[i] = y * 4 + y2 * .15; }
    const n = 2 + R() * 3; for (let k = 0; k < n; k++) { const t0 = Math.floor(R() * len * .7), atk = .1 + R() * .4, dec = 1.5 + R() * 3; let a = 0, b = 0;
      add(t0, sr * (atk + dec * 2), t => { a += .006 * ((R() * 2 - 1) - a); b += .08 * ((R() * 2 - 1) - b); return (a * 9 + b * (t < .3 ? 1.2 : .2)) * Math.min(1, t / atk) * Math.exp(-Math.max(0, t - atk) / dec); }); }
  }
  let m = 0; for (let i = 0; i < len; i++) m = Math.max(m, Math.abs(d[i])); if (m > 0) for (let i = 0; i < len; i++) d[i] *= .9 / m;
  const f = Math.floor(sr * .02); for (let i = 0; i < f; i++) { d[i] *= i / f; d[len - 1 - i] *= i / f; }
  return d;
}
function placeSeeds() {
  if (!ctx) return;
  chans.forEach(c => { if (c.gen) { c.peaks = null; c.gen = false; setName(c, ''); post({t:'clear', c:c.i}); } });
  seedPlan.forEach(s => { const c = chans[s.ch]; if (c.peaks) return; sendBuf(c, genSeed(s.type, ctx.sampleRate), 'seed · ' + SEEDS[s.type].name, true); });
}

/* ------------------------------------------------------------- random presets */
function jitter(def, a) { const p = {}; for (const k of KEYS) p[k] = k === 'level' ? def[k] : clamp(def[k] + (R() - .5) * 2 * a, .02, .98); return p; }
function randomPreset() {
  let els; do { els = chans.map(() => Math.floor(R() * 4)); } while (new Set(els).size < 3);
  chans.forEach((c, i) => { c.pe = ELDEF.map(d => jitter(d, .17)); c.el = els[i]; c.muted = false; c.solo = false; });
  const rr = (a, b) => a + R() * (b - a);
  Object.assign(G, {growth:rr(.22,.55), evolve:rr(.2,.6), dyn:rr(.25,.75), mut:rr(.2,.6), myc:rr(.22,.6), reach:rr(.3,.75), spores:rr(.1,.45),
    abstr:Math.pow(R(), 2) * .6, wander:rr(0,.35), reverb:rr(.22,.55), tilt:rr(.4,.6), drive:rr(.05,.3), melody:rr(.2,.7), range:rr(.2,.7), pull:rr(.3,.9), glide:rr(0,.5), pulse:rr(.3,.7)});
  root = Math.floor(R() * 12); scale = pick(Object.keys(SCALES));
  let px = R() * 2 - 1, py = R() * 2 - 1; const L = Math.abs(px) + Math.abs(py); if (L > 1) { px /= L; py /= L; }
  pad.x = pad.tx = px; pad.y = pad.ty = py; padWeights();
  const sh = pick(Object.keys(SHAPES)); applyShape(sh, false, true);
  const types = Object.keys(SEEDS), n = R() < .55 ? 2 : 1, chosen = [];
  while (chosen.length < n) { const t = pick(types); if (!chosen.includes(t)) chosen.push(t); }
  const taken = new Set();
  seedPlan = chosen.map(t => {
    let cands = chans.filter(c => !taken.has(c.i) && c.el === SEEDS[t].el);
    if (!cands.length) { cands = chans.filter(c => !taken.has(c.i)); const c0 = pick(cands); c0.el = SEEDS[t].el; cands = [c0]; }
    const c = pick(cands); taken.add(c.i); return {type:t, ch:c.i};
  });
  presetName = chosen.map(t => SEEDS[t].name).join(' + ') + ' · ' + NOTES[root] + ' ' + scale.toLowerCase() + ' · ' + sh;
}
async function newSeed() {
  randomPreset();
  chans.forEach(c => { paintStrip(c); }); paintChan(); paintGlobals();
  if (ctx && engineState === 'ready') { sendAll(); calm(); placeSeeds(); updateReverb(); }
  status('New seed · ' + presetName); updateHint();
}

/* ------------------------------------------------------------- engine messages */
let tel = {grains:0, resets:0}, mtel = {gr:1, pk:0, scope:null}, lastResets = 0, resetFlash = 0, sporeN = 0, mutN = 0;
function onEngine(m) {
  if (m.t === 'tel') {
    chans.forEach((c, i) => { c.life = m.life[i]; c.rms = m.rms[i]; c.act = m.act[i]; c.scan = m.scan[i]; if (m.pings[i]) { c.flash = 1; spawnPulses(i, m.pings[i]); } });
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) W[i][j] = m.W[i * 8 + j];
    chans[sel].eff = m.eff; tel = m;
    for (const i in m.pm) { const c = chans[i]; Object.assign(c.p, m.pm[i]); c.ui.level.show(); if (+i === sel) { KEYS.forEach(k => chanK[k] && chanK[k].show()); } c.mutT = performance.now(); }
    if (m.resets > lastResets) { lastResets = m.resets; resetFlash = 2.5; }
  } else if (m.t === 'spore') {
    const c = chans[m.c]; c.peaks = m.peaks; c.gen = false;
    if (m.kind === 'new') { c.grafts = 0; setName(c, 'spore · from the network'); } else { c.grafts++; setName(c, (c.name || 'sound').replace(/ \+\d+ grafts?$/, '') + ' +' + c.grafts + (c.grafts > 1 ? ' grafts' : ' graft')); }
    sporeN++; bursts.push({i:m.c, r:0, a:1, c:COL.bone}); updateHint();
  } else if (m.t === 'mut') {
    mutN++; bursts.push({i:m.c, r:0, a:1, c:ELC[chans[m.c].el]}); chans[m.c].mutT = performance.now();
  } else if (m.t === 'meta') {
    const c = chans[m.c]; if (c.el !== m.el) { setElement(c, m.el); status('Channel ' + (c.i + 1) + ' turned into ' + ELN[m.el].toLowerCase() + '.'); }
  } else if (m.t === 'chbuf') {
    if (!m.data) { status('That channel has no sound to save.'); return; }
    saveWav(safe(m.name) + '.wav', wav24([m.data], ctx.sampleRate));
  }
}
function onMaster(m) {
  if (m.t === 'mtel') mtel = m;
  else if (m.t === 'rec') recChunk(m);
}

/* ------------------------------------------------------------- map */
const net = $('#net'), netc = $('#netc'), nx = netc.getContext('2d');
let NW = 0, NH = 0, DPR = 1, geo = null; const bursts = [], parts = [];
const FONT = getComputedStyle(document.body).fontFamily;
function sizeNet() {
  DPR = Math.min(2, window.devicePixelRatio || 1); const r = net.getBoundingClientRect(); NW = r.width; NH = r.height; if (!NW || !NH) return;
  netc.width = NW * DPR; netc.height = NH * DPR;
  geo = document.createElement('canvas'); geo.width = netc.width; geo.height = netc.height;
  const g = geo.getContext('2d'); g.scale(DPR, DPR);
  /* flower-of-life lattice across the whole field: no centre */
  const rr = Math.max(46, Math.min(NW, NH) / 6), dx = rr, dy = rr * Math.sqrt(3) / 2;
  g.strokeStyle = 'rgba(59,71,66,.33)'; g.lineWidth = 1;
  for (let row = -1, y = -dy; y < NH + dy; row++, y += dy) for (let x = (row & 1 ? dx / 2 : 0) - dx; x < NW + dx; x += dx) { g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.stroke(); }
  g.fillStyle = COL.dim; g.font = '9px ' + FONT; g.fillText('φ 1.618 · 137.5°', 10, NH - 40);
}
function XY(i) { const p = pos[i]; return [NW / 2 + p.x * (NW / 2 - 46), NH / 2 + 12 + p.y * (NH / 2 - 62)]; }
function toNorm(x, y) { return [clamp((x - NW / 2) / (NW / 2 - 46), -1, 1), clamp((y - NH / 2 - 12) / (NH / 2 - 62), -1, 1)]; }
function nodeR(c) { return 10 + c.life * 15; }
function spawnPulses(i, count) {
  for (let k = 0; k < Math.min(3, count); k++) { let S = 0; for (let j = 0; j < N; j++) if (j !== i) S += W[i][j] * Mk[i][j]; let r = R() * S;
    for (let j = 0; j < N; j++) { if (j === i) continue; r -= W[i][j] * Mk[i][j]; if (r <= 0) { if (parts.length < 200) parts.push({a:i, b:j, u:0, s:.6 + R() * .6, c:ELC[chans[i].el]}); break; } } }
}
function curve(i, j, t) { const [x1, y1] = XY(i), [x2, y2] = XY(j), mx = (x1 + x2) / 2, my = (y1 + y2) / 2, dx = x2 - x1, dy = y2 - y1, bend = .18 * Math.sin(i * 1.7 + j * 2.3) + Math.sin(t * .12 + i + j) * .03;
  return [x1, y1, mx - dy * bend, my + dx * bend, x2, y2]; }
function bez(c, u) { const v = 1 - u; return [v * v * c[0] + 2 * v * u * c[2] + u * u * c[4], v * v * c[1] + 2 * v * u * c[3] + u * u * c[5]]; }
let edgeCache = {};
function drawNet(ts) {
  if (!geo) sizeNet(); if (!geo) return;
  const t = ts / 1000; nx.setTransform(DPR, 0, 0, DPR, 0, 0); nx.clearRect(0, 0, NW, NH); nx.drawImage(geo, 0, 0, NW, NH);
  edgeCache = {};
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    if (!Mk[i][j] && !Mk[j][i]) continue;
    const w = (W[i][j] * Mk[i][j] + W[j][i] * Mk[j][i]) * .5 * (.2 + G.myc * 1.4); if (w < .015) continue;
    const c = curve(i, j, t); edgeCache[i + '-' + j] = c;
    const hot = hoverEdge === i + '-' + j;
    nx.strokeStyle = hot ? COL.earth : COL.bone; nx.globalAlpha = hot ? .9 : clamp(w * .6, .07, .6) * (running ? 1 : .55); nx.lineWidth = .5 + w * 2.2 + (hot ? 1 : 0);
    nx.beginPath(); nx.moveTo(c[0], c[1]); nx.quadraticCurveTo(c[2], c[3], c[4], c[5]); nx.stroke();
    nx.globalAlpha *= .45; nx.lineWidth = .6;
    for (let h = 1; h < 4; h++) { const [bx, by] = bez(c, h / 4), a = (i * 7 + j * 3 + h) * GA; nx.beginPath(); nx.moveTo(bx, by); nx.lineTo(bx + Math.cos(a) * w * 14, by + Math.sin(a) * w * 14); nx.stroke(); }
  }
  nx.globalAlpha = 1;
  for (let k = parts.length - 1; k >= 0; k--) { const p = parts[k]; p.u += .014 * p.s; if (p.u >= 1) { parts.splice(k, 1); continue; }
    const i = Math.min(p.a, p.b), j = Math.max(p.a, p.b), c = edgeCache[i + '-' + j]; if (!c) { parts.splice(k, 1); continue; }
    const [x, y] = bez(c, p.a < p.b ? p.u : 1 - p.u); nx.fillStyle = p.c; nx.globalAlpha = Math.sin(p.u * Math.PI); nx.beginPath(); nx.arc(x, y, 2, 0, Math.PI * 2); nx.fill(); }
  nx.globalAlpha = 1;
  const now = performance.now();
  chans.forEach(c => {
    const [x, y] = XY(c.i), col = ELC[c.el], r = nodeR(c);
    if (c.flash > 0) { nx.strokeStyle = col; nx.globalAlpha = c.flash * .8; nx.lineWidth = 1.2; nx.beginPath(); nx.arc(x, y, r + 6 + (1 - c.flash) * 18, 0, Math.PI * 2); nx.stroke(); c.flash = Math.max(0, c.flash - .035); }
    nx.globalAlpha = 1;
    const halo = clamp(c.rms * 6, 0, 1); if (halo > .02) { nx.fillStyle = col; nx.globalAlpha = halo * .22; nx.beginPath(); nx.arc(x, y, r + 4 + halo * 10, 0, Math.PI * 2); nx.fill(); nx.globalAlpha = 1; }
    nx.fillStyle = COL.basalt; nx.beginPath(); nx.arc(x, y, r, 0, Math.PI * 2); nx.fill();
    nx.fillStyle = col; nx.globalAlpha = .18 + c.life * .5; nx.beginPath(); nx.moveTo(x, y); nx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * c.life); nx.closePath(); nx.fill(); nx.globalAlpha = 1;
    nx.strokeStyle = col; nx.lineWidth = c.peaks ? 1.8 : 1; nx.setLineDash(c.peaks ? [] : [2, 3]); nx.beginPath(); nx.arc(x, y, r, 0, Math.PI * 2); nx.stroke(); nx.setLineDash([]);
    if (G.dyn > .05 && running) { nx.strokeStyle = col; nx.globalAlpha = .5; nx.lineWidth = 2; nx.beginPath(); nx.arc(x, y, r + 3, Math.PI * .75, Math.PI * .75 + Math.PI * 1.5 * c.act); nx.stroke(); nx.globalAlpha = 1; }
    if (c.i === sel) { nx.strokeStyle = COL.bone; nx.lineWidth = 1; nx.beginPath(); nx.arc(x, y, r + 7, -.9, .9); nx.stroke(); nx.beginPath(); nx.arc(x, y, r + 7, Math.PI - .9, Math.PI + .9); nx.stroke(); }
    nx.fillStyle = c.muted ? COL.dim : COL.bone; nx.font = '700 12px ' + FONT; nx.textAlign = 'center'; nx.textBaseline = 'middle'; nx.fillText(c.muted ? '–' : String(c.i + 1), x, y + .5);
    nx.font = '9px ' + FONT; nx.fillStyle = c.mutT && now - c.mutT < 2500 ? col : c.i === sel ? COL.bone : COL.dim;
    nx.fillText(ELN[c.el] + ' · ' + Math.round(c.life * 100) + '%', x, y + r + 13);
  });
  for (let k = bursts.length - 1; k >= 0; k--) { const b = bursts[k], [x, y] = XY(b.i); b.r += 1.4; b.a -= .012; if (b.a <= 0) { bursts.splice(k, 1); continue; }
    nx.strokeStyle = b.c; nx.globalAlpha = b.a; nx.setLineDash([1, 4]); nx.beginPath(); nx.arc(x, y, b.r, 0, Math.PI * 2); nx.stroke(); nx.setLineDash([]); }
  nx.globalAlpha = 1;
  if (drag && drag.mode === 'link' && drag.moved) { const [x, y] = XY(drag.i); nx.strokeStyle = COL.bone; nx.setLineDash([4, 3]); nx.beginPath(); nx.moveTo(x, y); nx.lineTo(drag.x, drag.y); nx.stroke(); nx.setLineDash([]); }
  if (drag && drag.mode === 'cut') { nx.fillStyle = COL.fire; nx.globalAlpha = .7; nx.beginPath(); nx.arc(drag.x, drag.y, 4, 0, Math.PI * 2); nx.fill(); nx.globalAlpha = 1; }
}
function hitNode(x, y) { let best = null, bd = 1e9; for (let i = 0; i < N; i++) { const [a, b] = XY(i), d = Math.hypot(a - x, b - y); if (d < Math.max(18, nodeR(chans[i]) + 6) && d < bd) { bd = d; best = i; } } return best; }
function hitEdge(x, y) { let best = null, bd = 9; for (const key in edgeCache) { const c = edgeCache[key]; for (let u = 0; u <= 1; u += .05) { const [bx, by] = bez(c, u), d = Math.hypot(bx - x, by - y); if (d < bd) { bd = d; best = key; } } } return best; }
const rel = e => { const r = netc.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
let drag = null, hoverEdge = null, posSent = 0;
function sendPos(force) { const t = performance.now(); if (force || t - posSent > 40) { posSent = t; post({t:'pos', v:pos.map(p => [p.x, p.y])}); } }
function cutEdge(key) { const [i, j] = key.split('-').map(Number); Mk[i][j] = Mk[j][i] = 0; post({t:'M', v:Mk}); help('CUT', ' Hypha ' + (i + 1) + ' ↔ ' + (j + 1) + ' cut. Use LINK to join them again.'); }
netc.addEventListener('pointerdown', e => {
  const [x, y] = rel(e), h = hitNode(x, y);
  netc.setPointerCapture(e.pointerId);
  if (tool === 'cut') { drag = {mode:'cut', x, y, i:h, moved:false}; if (h == null) { const ed = hitEdge(x, y); if (ed) cutEdge(ed); } return; }
  if (h == null) { drag = null; return; }
  drag = {mode:tool, i:h, x, y, sx:x, sy:y, moved:false};
});
netc.addEventListener('pointermove', e => {
  const [x, y] = rel(e);
  if (drag) {
    if (Math.hypot(x - (drag.sx ?? x), y - (drag.sy ?? y)) > 5) drag.moved = true;
    drag.x = x; drag.y = y;
    if (drag.mode === 'move' && drag.moved) { const [nx_, ny_] = toNorm(x, y); const p = pos[drag.i]; p.x = p.tx = nx_; p.y = p.ty = ny_; sendPos(); }
    if (drag.mode === 'cut') { drag.moved = true; const ed = hitEdge(x, y); if (ed) cutEdge(ed); }
    return;
  }
  const h = hitNode(x, y);
  hoverEdge = h == null ? hitEdge(x, y) : null;
  if (h != null) { const c = chans[h]; help('CHANNEL ' + (h + 1), ' ' + ELN[c.el] + ' · life ' + Math.round(c.life * 100) + '% · ' + (c.name || 'empty') + '. Click to edit · ' + (tool === 'move' ? 'drag to move it (position sets pan and how far its sound travels)' : tool === 'link' ? 'drag to another node to grow a hypha' : 'use on lines to cut them') + ' · double-click to mute.'); }
  else if (hoverEdge) { const [i, j] = hoverEdge.split('-').map(Number); help('HYPHA ' + (i + 1) + ' ↔ ' + (j + 1), ' Scroll to make it stronger or weaker' + (tool === 'cut' ? ', click to cut it.' : '. Choose CUT to remove it.'), Math.round(W[i][j] * 100) + '% / ' + Math.round(W[j][i] * 100) + '%'); }
  else help('MAP', ' One system, no centre. Lines are hyphae: brighter = stronger. Distance on the map sets delay, pan and how strongly channels connect. Pulses show pings travelling.');
});
netc.addEventListener('pointerleave', () => { hoverEdge = null; if (!drag) idleGuide(); });
netc.addEventListener('pointerup', e => {
  if (!drag) return; const d = drag; drag = null; const [x, y] = rel(e);
  if (d.mode === 'cut') { if (!d.moved && d.i != null) select(d.i); return; }
  if (!d.moved) { select(d.i); return; }
  if (d.mode === 'move') { sendPos(true); return; }
  const h = hitNode(x, y);
  if (d.mode === 'link' && h != null && h !== d.i) { W[d.i][h] = Math.min(1, W[d.i][h] + .45); W[h][d.i] = Math.min(1, W[h][d.i] + .3); Mk[d.i][h] = Mk[h][d.i] = 1; post({t:'fuse', a:d.i, b:h}); help('LINKED', ' Hypha ' + (d.i + 1) + ' → ' + (h + 1) + ' grown.'); }
});
netc.addEventListener('dblclick', e => { const [x, y] = rel(e), h = hitNode(x, y); if (h != null) setMute(chans[h], !chans[h].muted); });
netc.addEventListener('wheel', e => { if (!hoverEdge) return; e.preventDefault(); const [i, j] = hoverEdge.split('-').map(Number), dv = -Math.sign(e.deltaY) * .05;
  W[i][j] = clamp(W[i][j] + dv, .02, 1); W[j][i] = clamp(W[j][i] + dv, .02, 1); post({t:'W', v:W}); help('HYPHA ' + (i + 1) + ' ↔ ' + (j + 1), ' strength', Math.round(W[i][j] * 100) + '%'); }, {passive:false});
let dragDepth = 0;
net.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('#drop').hidden = false; });
net.addEventListener('dragover', e => e.preventDefault());
net.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
net.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('#drop').hidden = true; const [x, y] = rel(e); sowFiles(e.dataTransfer.files, hitNode(x, y)); });
document.addEventListener('dragover', e => e.preventDefault()); document.addEventListener('drop', e => e.preventDefault());
function updateHint() { $('#hint').hidden = running && chans.some(c => c.peaks); }

function buildMapBar() {
  const tl = $('#tools');
  [['move','MOVE','Drag nodes around the map. Position sets each channel’s pan, its delay to the others and which channels connect.'],['link','LINK','Drag from one node to another to grow or rejoin a hypha.'],['cut','CUT','Click or swipe across lines to cut hyphae.']].forEach(([k, l, h]) => {
    const b = document.createElement('button'); b.className = 'tool'; b.textContent = l; b.dataset.k = k; b.setAttribute('aria-pressed', k === tool);
    b.addEventListener('click', () => { tool = k; net.dataset.tool = k; [...tl.querySelectorAll('.tool')].forEach(x => x.setAttribute('aria-pressed', x.dataset.k === k)); });
    hover(b, l, h); tl.appendChild(b);
  });
  const sh = $('#shapes');
  Object.keys(SHAPES).forEach(k => { const b = document.createElement('button'); b.className = 'tool'; b.textContent = k.toUpperCase(); b.dataset.k = k;
    b.addEventListener('click', () => { applyShape(k, true, false); status('Map shape: ' + k + '.'); }); hover(b, k.toUpperCase(), SHAPE_H[k] + ' Links regrow toward the new distances.'); sh.appendChild(b); });
  $('#reshape').addEventListener('click', reshape);
  hover($('#reshape'), 'RESHAPE', 'Gives the system a completely new body: a random shape, new hyphae strengths and a few random cuts.');
  $('#freeze').addEventListener('click', () => { freeze = !freeze; $('#freeze').setAttribute('aria-pressed', freeze); post({t:'freeze', v:freeze}); });
  hover($('#freeze'), 'FREEZE LINKS', 'Stops hyphae from growing and fading by themselves, so your edits to the map stay exactly as they are.');
}
function paintShapes() { [...$('#shapes').querySelectorAll('.tool')].forEach(b => b.setAttribute('aria-pressed', b.dataset.k === shapeName)); }
function applyShape(k, animate, quiet) {
  shapeName = k; const pts = SHAPES[k](R() * Math.PI * 2);
  pos.forEach((p, i) => { p.tx = pts[i][0]; p.ty = pts[i][1]; if (!animate) { p.x = p.tx; p.y = p.ty; } });
  if (!quiet) { const reach = .2 + G.reach * 1.2; for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j) { const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]); W[i][j] = clamp(lerp(W[i][j], Math.exp(-d / reach) * .85, .6), .02, 1); } post({t:'W', v:W}); }
  else { const reach = .2 + G.reach * 1.2; for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { if (i === j) { W[i][j] = 0; Mk[i][j] = 0; continue; } const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]); W[i][j] = clamp(Math.exp(-d / reach) * .8 + R() * .15, .02, 1); Mk[i][j] = 1; }
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) if (R() < .12) Mk[i][j] = Mk[j][i] = 0; }
  sendPos(true); if ($('#shapes').children.length) paintShapes();
}
function reshape() {
  const k = pick(Object.keys(SHAPES).filter(s => s !== shapeName));
  applyShape(k, true, true); post({t:'W', v:W}); post({t:'M', v:Mk});
  const cuts = Mk.flat().filter((v, i) => v === 0 && i % 9 !== 0).length / 2;
  status('New shape: ' + k + ' · ' + cuts + ' hyphae cut.'); bursts.push(...chans.map(c => ({i:c.i, r:0, a:1, c:COL.bone})));
}

/* ------------------------------------------------------------- element pad */
const padEl = $('#pad'), padc = $('#padc'), px = padc.getContext('2d'); let padDrag = false, PS = 0, mwSent = 0;
const CORN = [[0, 1], [-1, 0], [1, 0], [0, -1]]; /* earth bottom, water left, air right, fire top */
function sizePad() { const r = padEl.getBoundingClientRect(); PS = r.width; if (PS) { padc.width = PS * DPR; padc.height = PS * DPR; } }
function padWeights() { let s = 0; const w = CORN.map(([cx, cy]) => { const d = Math.hypot(pad.x - cx, pad.y - cy); return Math.pow(Math.max(0, 1.5 - d), 2.2); }); w.forEach(v => s += v); MW = w.map(v => v / (s || 1)); }
function drawPad() {
  if (!PS) sizePad(); if (!PS) return;
  px.setTransform(DPR, 0, 0, DPR, 0, 0); px.clearRect(0, 0, PS, PS);
  const c = PS / 2, Rr = PS * .36, P = (x, y) => [c + x * Rr, c + y * Rr];
  CORN.forEach(([cx, cy], k) => { const [x, y] = P(cx, cy), g = px.createRadialGradient(x, y, 0, x, y, Rr * 1.3); g.addColorStop(0, ELC[k]); g.addColorStop(1, 'rgba(0,0,0,0)'); px.globalAlpha = .06 + MW[k] * .4; px.fillStyle = g; px.fillRect(0, 0, PS, PS); });
  px.globalAlpha = 1; px.strokeStyle = COL.rule2; px.lineWidth = 1; px.beginPath(); [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(([x, y], i) => { const [a, b] = P(x, y); i ? px.lineTo(a, b) : px.moveTo(a, b); }); px.closePath(); px.stroke();
  px.beginPath(); px.arc(c, c, Rr / Math.SQRT2, 0, Math.PI * 2); px.stroke(); px.beginPath(); px.arc(c, c, Rr / Math.SQRT2 / PHI, 0, Math.PI * 2); px.stroke();
  CORN.forEach(([cx, cy], k) => { const x = cx < 0 ? 3 : cx > 0 ? PS - 3 : c, y = cy < 0 ? 9 : cy > 0 ? PS - 9 : c - 7; px.textAlign = cx < 0 ? 'left' : cx > 0 ? 'right' : 'center'; px.textBaseline = 'middle';
    px.fillStyle = MW[k] > .4 ? ELC[k] : COL.sage; px.font = '600 9px ' + FONT; px.fillText(ELN[k], x, y);
    px.fillStyle = COL.dim; px.font = '9px ' + FONT; px.fillText(Math.round(MW[k] * 100), x, cy < 0 ? y + 12 : cy > 0 ? y - 12 : y + 13); });
  pad.trail.push([pad.x, pad.y]); if (pad.trail.length > 80) pad.trail.shift();
  px.strokeStyle = COL.bone; px.globalAlpha = .3; px.beginPath(); pad.trail.forEach(([x, y], i) => { const [a, b] = P(x, y); i ? px.lineTo(a, b) : px.moveTo(a, b); }); px.stroke(); px.globalAlpha = 1;
  const [x, y] = P(pad.x, pad.y); px.fillStyle = COL.basalt; px.strokeStyle = COL.bone; px.lineWidth = 1.6; px.beginPath(); px.arc(x, y, 7, 0, Math.PI * 2); px.fill(); px.stroke();
  px.fillStyle = COL.bone; px.beginPath(); px.arc(x, y, 2, 0, Math.PI * 2); px.fill();
}
function padSet(e) { const r = padc.getBoundingClientRect(); let x = ((e.clientX - r.left) / r.width - .5) / .36, y = ((e.clientY - r.top) / r.height - .5) / .36; const L = Math.abs(x) + Math.abs(y); if (L > 1) { x /= L; y /= L; } pad.x = pad.tx = x; pad.y = pad.ty = y; padWeights(); padHelp(); }
function padHelp() { help('ELEMENTS', ' Pulls the whole system toward each element.', 'earth ' + Math.round(MW[0] * 100) + ' · water ' + Math.round(MW[1] * 100) + ' · air ' + Math.round(MW[2] * 100) + ' · fire ' + Math.round(MW[3] * 100)); }
padc.addEventListener('pointerdown', e => { padDrag = true; padc.setPointerCapture(e.pointerId); padSet(e); });
padc.addEventListener('pointermove', e => { if (padDrag) padSet(e); });
padc.addEventListener('pointerup', () => padDrag = false);
padc.addEventListener('pointerenter', padHelp); padc.addEventListener('pointerleave', idleGuide);

/* ------------------------------------------------------------- displays + main loop */
const scope = $('#scope'), sx = scope.getContext('2d');
function drawScope() {
  const w = 120, h = 34; if (scope.width !== w * DPR) { scope.width = w * DPR; scope.height = h * DPR; }
  sx.setTransform(DPR, 0, 0, DPR, 0, 0); sx.clearRect(0, 0, w, h); sx.strokeStyle = COL.rule; sx.beginPath(); sx.moveTo(0, h / 2); sx.lineTo(w, h / 2); sx.stroke();
  if (!running || !mtel.scope) return;
  sx.strokeStyle = COL.bone; sx.lineWidth = 1; sx.beginPath(); const s = mtel.scope; for (let i = 0; i < s.length; i++) { const x = i / (s.length - 1) * w, y = h / 2 - s[i] * h * .48; i ? sx.lineTo(x, y) : sx.moveTo(x, y); } sx.stroke();
}
function fitCanvas(cv) { const r = cv.getBoundingClientRect(); if (!r.width) return null; const W_ = Math.round(r.width * DPR), H_ = Math.round(r.height * DPR); if (cv.width !== W_ || cv.height !== H_) { cv.width = W_; cv.height = H_; } const g = cv.getContext('2d'); g.setTransform(DPR, 0, 0, DPR, 0, 0); g.clearRect(0, 0, r.width, r.height); return [g, r.width, r.height]; }
function waveTo(cv, c, big) {
  const f = fitCanvas(cv); if (!f) return; const [g, w, h] = f;
  if (!c.peaks) { g.strokeStyle = COL.rule2; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke(); g.setLineDash([]);
    if (big) { g.fillStyle = COL.dim; g.font = '10px ' + FONT; g.fillText('no sound yet · this channel grows from the network and from spores', 8, h / 2 - 6); } return; }
  const n = c.peaks.length; g.fillStyle = ELC[c.el]; g.globalAlpha = .6;
  for (let i = 0; i < n; i++) { const v = c.peaks[i] * h * .46; g.fillRect(i / n * w, h / 2 - v, Math.max(1, w / n - .5), Math.max(1, v * 2)); }
  g.globalAlpha = 1;
  if (running) { const sp = (c.eff && c.i === sel ? c.eff[3] : c.p.scat) * w * .25; g.fillStyle = COL.bone; g.globalAlpha = .12; g.fillRect(c.scan * w - sp, 0, sp * 2, h); g.globalAlpha = 1; g.fillRect(c.scan * w - .5, 0, 1.5, h); }
}
function drawWaves() { chans.forEach(c => waveTo(c.ui.wave, c, false)); waveTo($('#cwave'), chans[sel], true); }
const pill = $('#pill');
let frame = 0, lastT = 0, revT = 0;
function loop(ts) {
  frame++; const dt = Math.min(.1, (ts - lastT) / 1000 || 0); lastT = ts;
  if (G.wander > 0 && !padDrag) { const s = G.wander * G.wander; pad.tx = clamp(pad.tx + (R() - .5) * s * .12, -1, 1); pad.ty = clamp(pad.ty + (R() - .5) * s * .12, -1, 1); const L = Math.abs(pad.tx) + Math.abs(pad.ty); if (L > 1) { pad.tx /= L; pad.ty /= L; } }
  if (!padDrag) { pad.x += (pad.tx - pad.x) * .03; pad.y += (pad.ty - pad.y) * .03; }
  padWeights(); if (ts - mwSent > 50) { mwSent = ts; post({t:'mw', v:MW}); }
  if (ts - revT > 120) { revT = ts; updateReverb(); }
  let movedPos = false; pos.forEach(p => { if (drag && drag.mode === 'move') return; const dx = p.tx - p.x, dy = p.ty - p.y; if (Math.abs(dx) + Math.abs(dy) > .001) { p.x += dx * .06; p.y += dy * .06; movedPos = true; } });
  if (movedPos) sendPos();
  drawNet(ts); drawPad(); drawPlayer();
  if (frame % 2 === 0) {
    drawScope(); drawWaves();
    chans.forEach(c => { c.ui.lifeI.style.width = (c.life * 100) + '%'; c.ui.lifeB.style.left = clamp(c.rms * 300, 0, 98) + '%'; });
    const ef = chans[sel].eff, mv = chans[sel].mutT && performance.now() - chans[sel].mutT < 2500;
    if (running && ef) KEYS.forEach((k, i) => { if (chanK[k]) { chanK[k].mod(ef[i]); chanK[k].moving(mv); } });
    const gr = 20 * Math.log10(Math.max(1e-4, mtel.gr)), pk = mtel.pk > 0 ? 20 * Math.log10(mtel.pk) : -99;
    $('#limI').style.width = clamp(-gr / 12 * 100, 0, 100) + '%';
    $('#limTxt').textContent = 'LIMITER ' + (gr > -.05 ? '0.0' : gr.toFixed(1)) + ' dB · PEAK ' + (pk < -90 ? '−∞' : pk.toFixed(1));
    if (resetFlash > 0) { resetFlash -= dt * 2; pill.dataset.s = 'reset'; pill.textContent = 'SELF-RESET'; }
    else if (!running) { pill.dataset.s = 'idle'; pill.textContent = engineState === 'failed' ? 'NO AUDIO' : 'DORMANT'; }
    else if (gr < -3) { pill.dataset.s = 'lim'; pill.textContent = 'LIMITING'; } else { pill.dataset.s = 'ok'; pill.textContent = 'STABLE'; }
    let hy = 0; for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j && Mk[i][j] && W[i][j] * G.myc > .1) hy++;
    const alive = chans.filter(c => c.life > .05).length;
    $('#nstat').innerHTML = 'ALIVE ' + alive + '/8 · HYPHAE ' + hy + '/56<br>GRAINS ' + (tel.grains || 0) + ' · SPORES ' + sporeN + ' · MUTATIONS ' + mutN + '<br>' + NOTES[root] + ' ' + scale + ' · ' + shapeName.toUpperCase();
    if (rec.on) $('#rtime').textContent = fmtT(rec.len / ctx.sampleRate, true);
  }
  requestAnimationFrame(loop);
}
new ResizeObserver(() => { geo = null; sizeNet(); sizePad(); }).observe(net);
addEventListener('resize', () => { geo = null; sizeNet(); sizePad(); });

/* ------------------------------------------------------------- recording */
const rec = {on:false, L:[], R:[], len:0};
recBtn.addEventListener('click', () => { rec.on ? stopRec() : startRec(); });
hover(recBtn, 'RECORD', 'Records the master output, exactly what you hear, into the store as 24-bit WAV.');
function startRec() { if (!running) { status('Press GROW first, then record.'); return; } rec.L = []; rec.R = []; rec.len = 0; rec.on = true; postM({t:'rec', v:true}); recBtn.setAttribute('aria-pressed', 'true'); $('#recTxt').textContent = 'STOP'; status('Recording the master output…'); }
function stopRec() { rec.on = false; postM({t:'rec', v:false}); recBtn.setAttribute('aria-pressed', 'false'); $('#recTxt').textContent = 'RECORD'; }
function recChunk(m) { rec.L.push(m.L); rec.R.push(m.R); rec.len += m.L.length; if (m.done) finishTake(); }
function cat(a, n) { const o = new Float32Array(n); let p = 0; for (const x of a) { o.set(x.subarray(0, Math.min(x.length, n - p)), p); p += x.length; if (p >= n) break; } return o; }
function wav24(chs, sr) {
  const nc = chs.length, n = chs[0].length, ba = 3 * nc, bytes = n * ba, ab = new ArrayBuffer(44 + bytes), dv = new DataView(ab), ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + bytes, true); ws(8, 'WAVE'); ws(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nc, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * ba, true); dv.setUint16(32, ba, true); dv.setUint16(34, 24, true); ws(36, 'data'); dv.setUint32(40, bytes, true);
  const u = new Uint8Array(ab); let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) { let v = Math.round(clamp(chs[c][i], -1, 1) * 8388607); if (v < 0) v += 16777216; u[o++] = v & 255; u[o++] = (v >> 8) & 255; u[o++] = (v >> 16) & 255; }
  return ab;
}
function snap() { return {root, scale, G:{...G}, pad:{x:pad.x, y:pad.y}, W:W.map(r => [...r]), M:Mk.map(r => [...r]), pos:pos.map(p => [p.x, p.y]), shape:shapeName, freeze, chans:chans.map(c => ({el:c.el, pe:c.pe.map(p => ({...p}))}))}; }
function recall(s) {
  if (!s) return; root = s.root; scale = s.scale; Object.assign(G, s.G); pad.x = pad.tx = s.pad.x; pad.y = pad.ty = s.pad.y; W = s.W.map(r => [...r]);
  if (s.M) Mk = s.M.map(r => [...r]); if (s.pos) s.pos.forEach((p, i) => { pos[i].tx = p[0]; pos[i].ty = p[1]; }); if (s.shape) shapeName = s.shape; freeze = !!s.freeze; $('#freeze').setAttribute('aria-pressed', freeze);
  s.chans.forEach((x, i) => { const c = chans[i]; c.el = x.el; if (x.pe) c.pe = x.pe.map(p => ({...ELDEF[0], ...p})); else if (x.p) Object.assign(c.p, x.p); paintStrip(c); });
  sendAll(); updateReverb(); paintGlobals(); paintChan(); paintShapes(); status('Settings recalled from the take.');
}

/* ------------------------------------------------------------- store */
let takes = [], filt = 'ALL', dbh = null, takeN = 0, dl = null;
async function finishTake() {
  const sr = ctx.sampleRate, len = rec.len; $('#rtime').textContent = '00:00.0';
  if (len < sr * .3) { status('Take too short to keep.'); return; }
  const L = cat(rec.L, len), Rr = cat(rec.R, len); rec.L = rec.R = [];
  const dom = MW.indexOf(Math.max(...MW)); takeN = Math.max(takeN, takes.length) + 1;
  const mono = new Float32Array(len); for (let i = 0; i < len; i++) mono[i] = (L[i] + Rr[i]) * .5;
  const tk = {id:Date.now().toString(36) + Math.floor(R() * 1e4), name:'harvest ' + String(takeN).padStart(3, '0') + ' · ' + ELN[dom].toLowerCase(), created:Date.now(), dur:len / sr, sr, el:dom, star:false,
    patch:snap(), wav:wav24([L, Rr], sr), peaks:Array.from(peaksOf(mono, 64)), scaleInfo:NOTES[root] + ' ' + scale};
  takes.unshift(tk); await dbPut(tk); renderLib(); selectTake(tk); status('Kept ' + fmtT(tk.dur, true) + ' as “' + tk.name + '”.');
}
function openDB() { return new Promise((res, rej) => { let r; try { r = indexedDB.open('harvest-store', 1); } catch (e) { rej(e); return; } r.onupgradeneeded = () => r.result.createObjectStore('takes', {keyPath:'id'}); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function dbPut(tk) { try { if (!dbh) return; await new Promise((res, rej) => { const tx = dbh.transaction('takes', 'readwrite'); tx.objectStore('takes').put(tk); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } catch (e) { status('This browser would not store the take; it stays for this session.'); } }
async function dbDel(id) { try { if (!dbh) return; await new Promise(res => { const tx = dbh.transaction('takes', 'readwrite'); tx.objectStore('takes').delete(id); tx.oncomplete = res; tx.onerror = res; }); } catch (e) { /* ignore */ } }
async function dbAll() { try { if (!dbh) return []; return await new Promise((res, rej) => { const q = dbh.transaction('takes').objectStore('takes').getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); }); } catch (e) { return []; } }
(async () => { try { dbh = await openDB(); takes = (await dbAll()).sort((a, b) => b.created - a.created); takeN = takes.length; } catch (e) { dbh = null; } renderLib(); if (takes[0]) selectTake(takes[0]); })();
const FILTERS = ['ALL','★','EARTH','WATER','AIR','FIRE'];
function buildFilters() { const f = $('#filters'); FILTERS.forEach(k => { const b = document.createElement('button'); b.className = 'chip'; b.textContent = k; b.setAttribute('aria-pressed', k === filt);
  b.addEventListener('click', () => { filt = k; [...f.querySelectorAll('.chip')].forEach(c => c.setAttribute('aria-pressed', c.textContent === k)); renderLib(); }); f.appendChild(b); }); }
async function decodeTake(tk) { await ensureEngine(); return await ctx.decodeAudioData(tk.wav.slice(0)); }
function renderLib() {
  const lib = $('#lib'); lib.textContent = '';
  const list = takes.filter(t => filt === 'ALL' || (filt === '★' ? t.star : ELN[t.el] === filt));
  $('#exportAll').hidden = !takes.length;
  if (!list.length) { const d = document.createElement('div'); d.className = 'libempty';
    d.innerHTML = takes.length ? 'No takes match this filter.' : 'Takes you record appear here and open in the player above: see the whole waveform, click or drag to jump, skip 5 s with the arrows or J / L. Rename a take, star the keepers, load it into the selected channel with <b>→ CH</b> so it becomes new food for the system, bring back the settings it grew from with <b>RECALL</b>, or <b>SAVE</b> it as a 24-bit WAV.' + (dbh ? '' : '<br><br>This browser blocks local storage, so takes last for this session only.');
    lib.appendChild(d); return; }
  list.forEach(tk => {
    const row = document.createElement('div'); row.className = 'take'; row.setAttribute('aria-current', !!(P.tk && P.tk.id === tk.id));
    row.addEventListener('click', e => { if (e.target.closest('button,input')) return; selectTake(tk); });
    const st = document.createElement('button'); st.className = 'star'; st.textContent = '★'; st.setAttribute('aria-pressed', tk.star); st.setAttribute('aria-label', 'Star take');
    st.addEventListener('click', () => { tk.star = !tk.star; dbPut(tk); renderLib(); });
    const meta = document.createElement('div'); meta.style.minWidth = '0';
    const inp = document.createElement('input'); inp.value = tk.name; inp.id = 'tk-' + tk.id; inp.setAttribute('aria-label', 'Take name');
    inp.addEventListener('change', () => { tk.name = inp.value.trim() || tk.name; dbPut(tk); if (P.tk === tk) $('#pName').textContent = tk.name; });
    const sub = document.createElement('div'); sub.className = 'sub';
    sub.textContent = fmtT(tk.dur, true) + ' · ' + ELN[tk.el] + ' · ' + (tk.scaleInfo || '') + ' · ' + new Date(tk.created).toLocaleString([], {month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit'});
    meta.append(inp, sub);
    const cv = document.createElement('canvas');
    const acts = document.createElement('div'); acts.className = 'acts';
    const mk = (t, h, fn) => { const b = document.createElement('button'); b.className = 'btn'; b.textContent = t; b.title = h; b.addEventListener('click', fn); acts.appendChild(b); return b; };
    mk('→ CH', 'Load this take into the selected channel', async () => { try { const b = await decodeTake(tk); sendBuf(chans[sel], toMono(b), tk.name, false); status('“' + tk.name + '” is now growing in channel ' + (sel + 1) + '.'); } catch (e) { status('Could not load this take.'); } });
    mk('RECALL', 'Bring back the settings this take was recorded with', () => recall(tk.patch));
    mk('SAVE', 'Save as a 24-bit WAV file', () => saveWav(safe(tk.name) + '.wav', tk.wav));
    const del = mk('DEL', 'Delete this take', () => { if (del.dataset.arm) { if (P.tk === tk) closePlayer(); takes = takes.filter(t => t !== tk); dbDel(tk.id); renderLib(); status('Take deleted.'); }
      else { del.dataset.arm = 1; del.textContent = 'SURE?'; del.style.color = COL.fire; del.style.borderColor = COL.fire; setTimeout(() => { if (del.isConnected) { delete del.dataset.arm; del.textContent = 'DEL'; del.style.color = ''; del.style.borderColor = ''; } }, 2500); } });
    row.append(st, meta, cv, acts); lib.appendChild(row);
    requestAnimationFrame(() => { const f = fitCanvas(cv); if (!f) return; const [g, w, h] = f; g.fillStyle = ELC[tk.el]; const n = tk.peaks.length;
      tk.peaks.forEach((v, i) => { const hh = Math.max(.5, v * h * .46); g.fillRect(i / n * w, h / 2 - hh, Math.max(1, w / n - .3), hh * 2); }); });
  });
}

/* ------------------------------------------------------------- player */
const P = {ctx:null, buf:null, src:null, playing:false, startAt:0, offset:0, tk:null, peaks:null, scrub:false};
const peakCache = new Map();
function wavPeaks(tk, n) {
  if (peakCache.has(tk.id)) return peakCache.get(tk.id);
  const dv = new DataView(tk.wav), nc = dv.getUint16(22, true), ba = dv.getUint16(32, true), frames = Math.floor((tk.wav.byteLength - 44) / ba);
  const p = new Float32Array(n), per = frames / n, step = Math.max(1, Math.floor(per / 160)); let mx = 0;
  for (let b = 0; b < n; b++) { let m = 0; const a = Math.floor(b * per), z = Math.min(frames, Math.floor((b + 1) * per));
    for (let f = a; f < z; f += step) { const o = 44 + f * ba; let v = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16); v = Math.abs(v); if (v > m) m = v; }
    p[b] = m / 8388607; if (p[b] > mx) mx = p[b]; }
  if (mx > 0) for (let b = 0; b < n; b++) p[b] /= mx;
  peakCache.set(tk.id, p); return p;
}
async function selectTake(tk) {
  pStop(); P.tk = tk; P.buf = null; P.offset = 0; P.peaks = wavPeaks(tk, 900);
  $('#pName').textContent = tk.name; renderLib();
  try { if (!P.ctx) P.ctx = new (window.AudioContext || window.webkitAudioContext)(); P.buf = await P.ctx.decodeAudioData(tk.wav.slice(0)); } catch (e) { status('Could not open this take for playback.'); }
}
function closePlayer() { pStop(); P.tk = null; P.buf = null; P.peaks = null; $('#pName').textContent = 'no take selected'; }
function pPos() { if (!P.buf) return 0; return P.playing ? clamp(P.ctx.currentTime - P.startAt, 0, P.buf.duration) : P.offset; }
function pStart(off) {
  if (!P.buf) return; if (P.src) { P.src.onended = null; try { P.src.stop(); } catch (e) { /* already stopped */ } }
  if (P.ctx.state !== 'running') P.ctx.resume();
  off = clamp(off, 0, Math.max(0, P.buf.duration - .01));
  const s = P.ctx.createBufferSource(); s.buffer = P.buf; s.connect(P.ctx.destination); s.start(0, off);
  P.src = s; P.startAt = P.ctx.currentTime - off; P.playing = true; $('#pPlay').textContent = '❚❚';
  s.onended = () => { if (P.src === s) { P.playing = false; P.offset = 0; P.src = null; $('#pPlay').textContent = '▶'; } };
}
function pStop() { if (P.src) { P.src.onended = null; try { P.src.stop(); } catch (e) { /* noop */ } P.src = null; } if (P.playing) P.offset = pPos(); P.playing = false; $('#pPlay').textContent = '▶'; }
function pToggle() { if (!P.tk) { if (takes[0]) selectTake(takes[0]).then(() => pStart(0)); return; } if (P.playing) pStop(); else pStart(P.offset); }
function pSeek(t) { if (!P.buf) return; t = clamp(t, 0, P.buf.duration); if (P.playing) pStart(t); else P.offset = t; }
$('#pPlay').addEventListener('click', pToggle);
$('#pBack').addEventListener('click', () => pSeek(pPos() - 5));
$('#pFwd').addEventListener('click', () => pSeek(pPos() + 5));
$('#pStart').addEventListener('click', () => pSeek(0));
$('#pSave').addEventListener('click', () => { if (P.tk) saveWav(safe(P.tk.name) + '.wav', P.tk.wav); else status('Select a take first.'); });
const pw = $('#pwave');
const pwAt = e => { const r = pw.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
let pwHover = -1;
pw.addEventListener('pointerdown', e => { if (!P.buf) return; pw.setPointerCapture(e.pointerId); P.scrub = true; pSeek(pwAt(e) * P.buf.duration); });
pw.addEventListener('pointermove', e => { pwHover = pwAt(e); if (P.scrub && P.buf) pSeek(pwHover * P.buf.duration); if (P.buf) help('PLAYER', ' Click or drag to jump.', fmtT(pwHover * P.buf.duration, true)); });
pw.addEventListener('pointerup', () => P.scrub = false);
pw.addEventListener('pointerleave', () => { pwHover = -1; idleGuide(); });
function drawPlayer() {
  const f = fitCanvas(pw); if (!f) return; const [g, w, h] = f;
  if (!P.peaks) { g.fillStyle = COL.dim; g.font = '10px ' + FONT; g.textBaseline = 'middle'; g.fillText(takes.length ? 'select a take below' : 'record a take: it opens here', 10, h / 2); return; }
  const dur = P.tk.dur, t = pPos(), frac = dur ? t / dur : 0, n = P.peaks.length, bw = w / n, col = ELC[P.tk.el];
  for (let i = 0; i < n; i++) { const v = Math.max(.5, P.peaks[i] * h * .45), x = i * bw; g.fillStyle = x / w < frac ? col : COL.rule2; g.fillRect(x, h / 2 - v, Math.max(1, bw - .2), v * 2); }
  g.fillStyle = COL.rule; for (let s = 0; s <= dur; s += dur > 120 ? 30 : dur > 30 ? 10 : 5) { const x = s / dur * w; g.fillRect(x, h - 4, 1, 4); }
  if (pwHover >= 0) { g.fillStyle = COL.sage; g.globalAlpha = .5; g.fillRect(pwHover * w, 0, 1, h); g.globalAlpha = 1; }
  g.fillStyle = COL.bone; g.fillRect(frac * w - 1, 0, 2, h);
  $('#pTime').textContent = fmtT(t, true) + ' / ' + fmtT(dur, true);
}

/* ------------------------------------------------------------- files out */
const safe = s => s.replace(/[^\w\-· ]+/g, '').replace(/[· ]+/g, '_').slice(0, 80) || 'harvest';
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u) { let c = 0xFFFFFFFF; for (let i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zip(files) {
  const enc = new TextEncoder(), parts = [], cen = []; let off = 0; const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const nm = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
    const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(10, time, true); lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, sz, true); lh.setUint32(22, sz, true); lh.setUint16(26, nm.length, true); parts.push(lh.buffer, nm, f.data);
    const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(12, time, true); ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, sz, true); ch.setUint32(24, sz, true); ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true); cen.push(ch.buffer, nm); off += 30 + nm.length + sz;
  }
  const cl = cen.reduce((a, b) => a + (b.byteLength ?? b.length), 0);
  const e = new DataView(new ArrayBuffer(22)); e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cl, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...cen, e.buffer], {type:'application/zip'});
}
/* Inside the claude.ai viewer, files leave through the platform's save dialog (WAV is wrapped in a zip there).
   Everywhere else (GitHub Pages, local server) a normal browser download is used. */
async function offer(name, blob) {
  if (dl) {
    try { await dl.save({filename:name, data:blob}); status('Saved ' + name + '.'); }
    catch (err) { const c = err && err.code; status(c === 'declined' ? 'Save cancelled.' : c === 'rate_limited' ? 'A save is already waiting for confirmation.' : c === 'too_large' ? 'That file is too large for this destination.' : 'Saving is not available in this view.'); }
    return;
  }
  try { const a = document.createElement('a'), u = URL.createObjectURL(blob); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 8000); status('Downloaded ' + name + '.'); }
  catch (e) { status('This browser blocked the download.'); }
}
function saveWav(name, ab) {
  if (dl) offer(name.replace(/\.wav$/, '') + '.zip', zip([{name, data:new Uint8Array(ab)}]));
  else offer(name, new Blob([ab], {type:'audio/wav'}));
}
$('#exportAll').addEventListener('click', () => {
  const files = takes.map((t, i) => ({name:String(i + 1).padStart(3, '0') + '_' + safe(t.name) + '.wav', data:new Uint8Array(t.wav)}));
  const man = takes.map((t, i) => ({file:files[i].name, name:t.name, starred:t.star, element:ELN[t.el], duration_s:+t.dur.toFixed(3), sample_rate:t.sr, bit_depth:24, scale:t.scaleInfo, created:new Date(t.created).toISOString(), settings:t.patch}));
  files.push({name:'harvest-manifest.json', data:new TextEncoder().encode(JSON.stringify({instrument:'Harvest', exported:new Date().toISOString(), takes:man}, null, 2))});
  offer('harvest-store-' + new Date().toISOString().slice(0, 10) + '.zip', zip(files));
});
(function tryDl(n) { try { if (window.claude && window.claude.use) { window.claude.use('downloads').then(d => { dl = d; }).catch(() => {}); return; } } catch (e) { /* not in viewer */ } if (n < 12) setTimeout(() => tryDl(n + 1), 400); })(0);

/* ------------------------------------------------------------- keyboard */
document.addEventListener('keydown', e => {
  if (e.target.closest('input,textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (e.key === ' ' && !e.target.closest('button,[role=slider]')) { e.preventDefault(); grow(); }
  else if (k === 'r') rec.on ? stopRec() : startRec();
  else if (k === 'n') newSeed();
  else if (k === 'k') pToggle();
  else if (k === 'j') pSeek(pPos() - 5);
  else if (k === 'l') pSeek(pPos() + 5);
  else if (e.key >= '1' && e.key <= '8') select(+e.key - 1);
  else if (k === 'm') setMute(chans[sel], !chans[sel].muted);
});

/* ------------------------------------------------------------- boot */
randomPreset();
buildStrips(); buildChan(); buildGlobals(); buildMapBar(); buildFilters();
chans.forEach(paintStrip); paintGlobals(); paintShapes(); select(seedPlan[0] ? seedPlan[0].ch : 0); renderLib();
status('Preset · ' + presetName);
requestAnimationFrame(() => { sizeNet(); sizePad(); drawWaves(); requestAnimationFrame(loop); });
})();
