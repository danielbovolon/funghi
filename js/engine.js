/*
 * HARVEST - audio engine (AudioWorklet)
 *
 * Two processors live in this module:
 *   harvest-engine : the 8-channel mycelial system (grains, FM, pings, low pass gates,
 *                    filters, feedback, element voices, network). Outputs the dry stereo mix.
 *   harvest-master : sums dry + convolution reverb return, tilt EQ, warmth, DC block,
 *                    volume, look-ahead limiter, hard ceiling, recorder, scope.
 *
 * Stability rules (why the system cannot run away):
 *   - Channels hear each other only through their own *generated* sound (taps are written
 *     before the network input is added), so there are no loops between channels.
 *   - Internal feedback gain is divided by the filter's resonance peak: loop gain < 0.92.
 *   - Sympathetic pings reach at most one neighbour with probability <= 0.6: cascades die out.
 *   - Every channel has a peak-following level guard + soft clipper.
 *   - The master has a look-ahead limiter at -1 dBFS and a hard ceiling at 0.98.
 *   - Any NaN/Inf resets all state and fades back in.
 *
 * Keep this file ASCII-only: the standalone build embeds it as a data/blob URL.
 */
const SR = sampleRate, ISR = 1 / SR, TAU = Math.PI * 2, PHI = (1 + Math.sqrt(5)) / 2;
const TS = 4096, SIN = new Float32Array(TS + 1);
for (let i = 0; i <= TS; i++) SIN[i] = Math.sin(i / TS * TAU);
function sn(p) { p -= Math.floor(p); const x = p * TS, i = x | 0; return SIN[i] + (SIN[i + 1] - SIN[i]) * (x - i); }
const TF0 = Math.log2(20), TF1 = Math.log2(SR * .42), TNN = 2048, TSC = TNN / (TF1 - TF0), TANT = new Float32Array(TNN + 2);
for (let i = 0; i <= TNN + 1; i++) TANT[i] = Math.tan(Math.PI * Math.pow(2, TF0 + Math.min(i, TNN) / TSC) * ISR);
const HN = 1024, HANN = new Float32Array(HN + 2);
for (let i = 0; i <= HN + 1; i++) HANN[i] = 0.5 - 0.5 * Math.cos(TAU * Math.min(i, HN) / HN);
function sc(x) { if (x >= 3) return 1; if (x <= -3) return -1; const x2 = x * x; return x * (27 + x2) / (27 + 9 * x2); }
let seed = 0x2545F491;
function rnd() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; }
const clamp = (v, a, b) => v < a ? a : v > b ? b : v, lerp = (a, b, t) => a + (b - a) * t;
const N = 8, TAPN = 65536, TAPM = TAPN - 1, FBN = 1 << 17, FBM = FBN - 1, WN = 4096, WM = WN - 1, MAXG = 12, CBN = 4096, CBM = CBN - 1;

/* parameter keys, shared with the UI. x1..x4 are the element's own controls:
   EARTH rumble weight tremor grit | WATER drips ripple depth flow | AIR breath whistle gust shimmer | FIRE crackle fold flicker heat */
const KEYS = ['dens','size','pitch','scat','cut','res','drive','ffm','ratio','depth','cplx','xmod','rate','decay','gate','voice','fb','echo','width','pmo','level','x1','x2','x3','x4'];
const MD = {dens:.25,size:.3,pitch:.04,scat:.3,cut:.22,res:.15,drive:.2,ffm:.2,ratio:.12,depth:.3,cplx:.3,xmod:.15,rate:.22,decay:.25,gate:.2,voice:.15,fb:.15,echo:.2,width:.2,pmo:.3,level:0,x1:.25,x2:.2,x3:.25,x4:.2};
const MUTK = KEYS.filter(k => k !== 'level');
/* 0 earth, 1 water, 2 air, 3 fire : fixed character multipliers */
const ELT = [
  {oct:-1,densM:.7,sizeM:1.6,pingM:.5,decM:1.5,jit:.25,rev:.15,mode:0,fbT:1.6,panR:.4,drive:.06,res2:1,sendT:.05},
  {oct:1,densM:1.2,sizeM:.6,pingM:1.6,decM:.7,jit:.9,rev:.05,mode:.75,fbT:.5,panR:1.5,drive:0,res2:2,sendT:.02},
  {oct:0,densM:1.3,sizeM:2,pingM:.35,decM:1.2,jit:.6,rev:.45,mode:.2,fbT:1.1,panR:1.9,drive:0,res2:1,sendT:.03},
  {oct:0,densM:1,sizeM:.5,pingM:1.1,decM:.8,jit:.8,rev:.2,mode:.1,fbT:.3,panR:1,drive:.15,res2:1,sendT:.01}
];

class Ch {
  constructor(i) {
    this.i = i; this.el = i % 4; this.p = {}; this.e = {}; this.ph = {}; this.tgt = {}; this.mutated = false;
    for (const k of KEYS) { this.p[k] = .5; this.e[k] = .5; this.ph[k] = [.07 + rnd() * .5, .03 + rnd() * .3, rnd() * TAU, rnd() * TAU]; }
    this.p.level = .7;
    this.buf = null; this.blen = 0;
    this.gOn = new Uint8Array(MAXG); this.gPos = new Float64Array(MAXG); this.gInc = new Float64Array(MAXG);
    this.gN = new Float64Array(MAXG); this.gWs = new Float64Array(MAXG); this.gAmp = new Float32Array(MAXG);
    this.fb = new Float32Array(FBN); this.wb = new Float32Array(WN); this.cb = new Float32Array(CBN);
    this.nw = new Float32Array(N); this.nD = new Int32Array(N); this.nb = new Float32Array(512);
    this.basePan = 0; this.muted = false; this.solo = false; this.life = 0; this.rms = 0;
    this.mel = Math.floor(rnd() * 5); this.scan = rnd(); this.scanDir = 1; this.rate = 1;
    this.pings = 0; this.cool = 2; this.inE = 0; this.melSt = 0;
    this.act = 1; this.actT = 1; this.actCnt = rnd() * 6; this.gA = .5; this.gT = .5;
    this.tremR = 1.5 + rnd() * 5;
    this.reset(); this.derived();
  }
  reset() {
    this.gOn.fill(0); this.gCnt = rnd() * SR * .2;
    this.freq = 130; this.ft = 130; this.cph = 0; this.m1ph = 0; this.m2ph = 0;
    this.env = 0; this.atk = false;
    this.zr = 0; this.zi = 0; this.rr = 0; this.rc = 1; this.rs = 0; this.rX = 0;
    this.ic1 = 0; this.ic2 = 0; this.l1 = 0; this.l2 = 0;
    this.fb.fill(0); this.fbW = 0; this.hpX = 0; this.hpY = 0;
    this.net = 0; this.wb.fill(0); this.wW = 0; this.cb.fill(0); this.cbW = 0;
    this.lfo = rnd(); this.agc = 1; this.pk = 0; this.crk = 0; this.crkD = 0; this.crkCnt = 1; this.bA = 0; this.bB = 0;
    this.pingCnt = SR * (.2 + rnd()); this.symp = -1; this.since = SR;
    this.gl = .707; this.gr = .707; this.mg = 1; this.mgT = 1;
    this.subPh = 0; this.re = 0; this.rt = 0; this.tPh = rnd(); this.hC = 0; this.hV = 0;
    this.dPh = 0; this.dF = 500; this.dK = 1; this.dEnv = 0; this.dD = 0; this.dCnt = SR * rnd();
    this.rPh = rnd(); this.fA = 1; this.fT = 1; this.fC = 0;
    this.nz = (rnd() * 4294967295) >>> 0;
  }
  derived() {
    this.gInt = SR; this.gSize = SR * .1; this.gNorm = .5; this.pitchSt = 0; this.revP = .1; this.shim = 0; this.scanM = 1;
    this.fc = 2000; this.fcMax = SR * .42; this.k = 1; this.g = Math.tan(Math.PI * 2000 * ISR); this.ffm = 0; this.mode = 0;
    this.drvAmt = 0; this.drvG = 1; this.fold = 0; this.m1r = 1; this.I1 = 0; this.I2 = 0; this.m2r = 1.5; this.xm = 0;
    this.voice = .2; this.pInt = SR; this.dec = .999; this.dec2 = .9999; this.resDec = .3; this.atkA = .3; this.gate = 0; this.fbG = 0; this.fbD = 4800;
    this.width = .5; this.pmo = 0; this.lfoR = .1; this.breath = 0; this.bAa = .1; this.bBa = .02; this.crkP = 0; this.lvl = .5;
    this.glA = .01; this.sendScale = .3; this.netA = .2; this.rAmp = .5; this.wD = 500;
    this.rumble = 0; this.weightSt = 0; this.trem = 0; this.grit = 0; this.holdN = 1; this.q = 65536;
    this.drip = 0; this.dripP = 0; this.ripple = 0; this.whistle = 0; this.cD = 100; this.cFb = .5; this.flick = 0;
  }
}

class Engine extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ch = []; for (let i = 0; i < N; i++) this.ch.push(new Ch(i));
    this.taps = []; for (let i = 0; i < N; i++) this.taps.push(new Float32Array(TAPN));
    this.tapW = 0;
    this.W = []; this.M = []; this.D = [];
    for (let i = 0; i < N; i++) { this.W.push([]); this.M.push([]); this.D.push([]); for (let j = 0; j < N; j++) { this.W[i].push(i === j ? 0 : .3); this.M[i].push(i === j ? 0 : 1); this.D[i].push(.5); } }
    this.G = {growth:.35,evolve:.3,myc:.35,spores:.2,abstr:.15,melody:.4,range:.4,pull:.6,glide:.2,pulse:.5,dyn:.4,mut:.35,reach:.5};
    this.freeze = false;
    this.mw = [.25, .25, .25, .25];
    this.setHarm({ratios:[1, 9/8, 6/5, 4/3, 3/2, 5/3, 9/5], root:2, golden:false});
    this.T = 0; this.bc = 0; this.mixG = 1; this.mutCnt = 8;
    this.RN = SR * 16; this.ring = new Float32Array(this.RN); this.rW = 0; this.rFill = 0; this.ringE = 0;
    this.tel = 0; this.sel = 0; this.resets = 0;
    this.port.onmessage = e => this.msg(e.data);
  }
  setHarm(m) {
    this.scale = m.ratios.slice(); this.scaleSt = this.scale.map(r => 12 * Math.log2(r));
    this.rootHz = 65.406 * Math.pow(2, m.root / 12); this.golden = !!m.golden;
  }
  setPos(v) {
    for (let i = 0; i < N; i++) {
      this.ch[i].basePan = clamp(v[i][0] * .85, -1, 1);
      for (let j = 0; j < N; j++) this.D[i][j] = Math.hypot(v[i][0] - v[j][0], v[i][1] - v[j][1]);
    }
  }
  msg(m) {
    const c = m.c != null ? this.ch[m.c] : null;
    switch (m.t) {
      case 'init':
        if (m.seed) seed = (m.seed | 0) || 1;
        m.chans.forEach((s, i) => { const h = this.ch[i]; Object.assign(h.p, s.p); h.el = s.el; h.muted = s.muted; h.solo = s.solo; });
        Object.assign(this.G, m.G); this.mw = m.mw.slice(); this.setHarm(m.harm);
        if (m.W) this.W = m.W.map(r => r.slice()); if (m.M) this.M = m.M.map(r => r.slice()); if (m.pos) this.setPos(m.pos);
        this.freeze = !!m.freeze; this.sel = m.sel; break;
      case 'p': c.p[m.k] = m.v; delete c.tgt[m.k]; break;
      case 'pall': Object.assign(c.p, m.v); c.tgt = {}; break;
      case 'el': c.el = m.v; break;
      case 'g': this.G[m.k] = m.v; break;
      case 'mw': this.mw = m.v.slice(); break;
      case 'harm': this.setHarm(m); break;
      case 'pos': this.setPos(m.v); break;
      case 'W': this.W = m.v.map(r => r.slice()); break;
      case 'M': this.M = m.v.map(r => r.slice()); break;
      case 'freeze': this.freeze = !!m.v; break;
      case 'buf': c.gOn.fill(0); c.buf = m.data; c.blen = m.data.length; c.scan = rnd(); c.life = Math.max(c.life, m.life || .3); break;
      case 'clear': c.gOn.fill(0); c.buf = null; c.blen = 0; break;
      case 'getbuf': this.port.postMessage({t:'chbuf', c:m.c, data:c.buf ? c.buf.slice() : null, name:m.name}); break;
      case 'mute': c.muted = m.v; break;
      case 'solo': c.solo = m.v; break;
      case 'sel': this.sel = m.v; break;
      case 'fuse': this.W[m.a][m.b] = Math.min(1, this.W[m.a][m.b] + .45); this.W[m.b][m.a] = Math.min(1, this.W[m.b][m.a] + .3); this.M[m.a][m.b] = this.M[m.b][m.a] = 1; break;
      case 'panic': this.hardReset(); break;
      case 'wake': for (const h of this.ch) if (h.blen) h.life = Math.max(h.life, m.v || .3); break;
    }
  }
  hardReset() {
    for (const c of this.ch) c.reset();
    for (const t of this.taps) t.fill(0);
    this.resets++;
  }
  quant(st) {
    const o = Math.floor(st / 12), r = st - o * 12; let best = 0, bd = 99;
    for (const s of this.scaleSt) { const d = Math.abs(s - r); if (d < bd) { bd = d; best = s; } }
    if (12 - r < bd) best = 12;
    return o * 12 + best;
  }
  qRatio(r) {
    const a = this.G.abstr;
    if (this.golden) { const k = Math.round(Math.log(r) / Math.log(PHI) * 2) / 2; return lerp(Math.pow(PHI, k), r, a); }
    const R = [.25, .5, 1, 1.5, 2, 3, 4, 5, 6, 7, 8]; let b = 1, bd = 99;
    for (const x of R) { const d = Math.abs(Math.log(x / r)); if (d < bd) { bd = d; b = x; } }
    return lerp(b, r, a * a);
  }
  derive(c, anySolo, nb) {
    const e = c.e, p = c.p, ph = c.ph, G = this.G, E = ELT[c.el], el = c.el, mw = this.mw, life = c.life, T = this.T, dt = nb * ISR;
    /* mutation glide: base settings drift toward targets chosen by mutation events */
    let moved = false;
    for (const k in c.tgt) { const d = c.tgt[k] - p[k]; if (Math.abs(d) < .004) { p[k] = c.tgt[k]; delete c.tgt[k]; } else p[k] += d * dt * (.08 + G.growth * .25); moved = true; }
    if (moved) c.mutated = true;
    const ev = G.evolve * 1.3 * (.4 + .6 * life);
    for (const k of KEYS) {
      let v = p[k]; const m = MD[k];
      if (m && ev > 0) { const q = ph[k]; v += (Math.sin(T * q[0] + q[2]) * .6 + Math.sin(T * q[1] + q[3]) * .4) * m * ev; }
      e[k] = clamp(v, 0, 1);
    }
    /* activity: swells, rests and returns (Dynamics) */
    c.actCnt -= dt;
    if (c.actCnt <= 0) {
      c.actCnt = (3 + rnd() * 12) / (.4 + G.growth);
      const r = rnd(); c.actT = r < .22 ? .03 : r < .55 ? .35 + rnd() * .35 : .8 + rnd() * .2;
    }
    c.act += (c.actT - c.act) * Math.min(1, dt * (.15 + G.growth * .4));
    const actM = lerp(1, c.act, G.dyn);
    /* element voices */
    const x1 = e.x1, x2 = e.x2, x3 = e.x3, x4 = e.x4;
    c.rumble = el === 0 ? x1 * .85 : 0; c.weightSt = el === 0 ? -12 * x2 : 0; c.trem = el === 0 ? x3 * .85 : 0;
    c.grit = el === 0 ? x4 * x4 : 0; c.holdN = 1 + Math.floor(c.grit * 36); c.q = Math.pow(2, 15 - c.grit * 12);
    c.drip = el === 1 ? x1 : 0; c.dripP = c.drip * 14 * (.3 + .7 * life) * actM * ISR; c.ripple = el === 1 ? x2 : 0;
    c.scanM = el === 1 ? .3 + 3 * x4 : 1;
    c.whistle = el === 2 ? x2 : 0; c.shim = el === 2 ? x4 * .6 : 0;
    if (el === 2) { c.gA += (c.gT - c.gA) * Math.min(1, dt * 1.5); if (rnd() < dt / (.4 + rnd() * 2.5)) c.gT = rnd(); }
    const gust = el === 2 ? x3 : 0, gustM = 1 - gust * .8 + gust * .8 * c.gA * 1.3;
    c.flick = el === 3 ? x3 : 0; const heat = el === 3 ? x4 : 0;
    /* grains */
    const dens = clamp(.5 * Math.pow(120, e.dens) * E.densM * (1 + mw[2] * .3) * (.35 + .65 * life) * lerp(1, .25 + .75 * c.act, G.dyn) * (el === 1 ? .7 + x4 * .6 : 1), .2, 80);
    const size = clamp(.012 * Math.pow(150, e.size) * E.sizeM * (1 + mw[0] * .6 - mw[3] * .3), .008, 2.5);
    c.gInt = SR / dens; c.gSize = size * SR; c.gNorm = 1.4 / Math.sqrt(Math.max(1, dens * size));
    c.pitchSt = (e.pitch - .5) * 48 + c.weightSt; c.revP = (el === 1 ? E.rev * (1 - x4) : E.rev) + G.abstr * .25;
    /* filter */
    const fc = clamp(40 * Math.pow(450, e.cut) * Math.pow(2, (mw[2] - mw[0]) * 1.5 + heat * 1.2 + (gust ? (c.gA - .5) * gust * 2 : 0)), 30, SR * .42);
    const Q = Math.min(13, (.5 + 11.5 * Math.pow(e.res, 1.5)) * (1 + mw[1] * .3));
    c.fc = fc; c.fcMax = SR * .42; c.k = 1 / Q; c.g = Math.tan(Math.PI * fc * ISR); c.ffm = e.ffm * 4;
    c.mode = el === 1 ? clamp(1 - x3 * .75 + mw[1] * .2, 0, 1) : clamp(E.mode + mw[1] * .3, 0, 1);
    const drv = clamp(e.drive + E.drive + mw[3] * .3 + (el === 3 ? x2 * .45 : 0), 0, 1);
    c.drvAmt = Math.min(1, drv * 1.5); c.drvG = 1 + drv * drv * 24; c.fold = el === 3 ? lerp(.3, 1, x2) : .3;
    /* FM */
    c.m1r = this.qRatio(.25 * Math.pow(32, e.ratio)); c.I1 = Math.min(12, e.depth * 8 * (1 + mw[3] * .5) * (1 + heat * 1.5)); c.I2 = e.cplx * 5;
    c.m2r = this.golden ? PHI : lerp(1.5, PHI, G.abstr); c.xm = e.xmod; c.voice = e.voice * .6;
    /* pings */
    const pulse = .25 * Math.pow(16, G.pulse);
    const rate = clamp(.05 * Math.pow(300, e.rate) * E.pingM * pulse * (.1 + .9 * life) * (1 + mw[1] * .6) * lerp(1, .2 + .8 * c.act, G.dyn), .02, 20);
    if (Math.abs(rate - c.rate) > 1e-4) { if (c.pingCnt > SR / rate * 2) c.pingCnt = SR / rate * rnd(); c.rate = rate; }
    c.pInt = SR / rate;
    const decay = .02 * Math.pow(200, e.decay) * E.decM;
    c.dec = Math.exp(-4.6 / (decay * SR)); c.dec2 = Math.exp(-4.6 / (decay * 3 * SR)); c.resDec = decay * (.4 + e.res * 1.2); c.atkA = 1 - Math.exp(-1 / (.0015 * SR));
    c.gate = e.gate;
    /* feedback: gain divided by resonance peak -> loop gain always < 0.92 */
    const peak = lerp(Math.max(1, Q), 1, c.mode);
    c.fbG = e.fb * .92 / peak;
    c.fbD = clamp(Math.round(.01 * Math.pow(150, e.echo) * E.fbT * SR), 64, FBN - 256);
    /* stereo */
    c.width = Math.min(1.2, e.width * (1 + mw[2] * .5)); c.pmo = clamp(e.pmo + mw[1] * .25, 0, 1);
    c.lfoR = .03 + E.panR * .4 * (.2 + e.pmo);
    /* noise voices */
    c.breath = ((el === 2 ? x1 * .55 : 0) + mw[2] * .12) * (.3 + .7 * life) * (.6 + .4 * Math.sin(T * 1.3 + c.i)) * gustM;
    const bf = clamp(c.freq, 40, 3000);
    c.bAa = 1 - Math.exp(-TAU * Math.min(bf * 6, SR * .4) * ISR); c.bBa = 1 - Math.exp(-TAU * bf * 1.2 * ISR);
    c.cD = clamp(Math.round(SR / clamp(c.freq * 2, 60, 4000)), 8, CBN - 8); c.cFb = .55 + .4 * c.whistle;
    c.crkP = ((el === 3 ? x1 * 9 : 0) + mw[3] * 3) * life * (.3 + e.scat) * actM * ISR;
    /* level */
    c.lvl = e.level * e.level * 2 * (.25 + .75 * life) * actM * gustM;
    c.glA = 1 - Math.exp(-1 / (Math.max(.001, .003 * Math.pow(200, G.glide)) * SR));
    c.sendScale = .3 + .7 * life; c.rAmp = .55 * (.4 + .6 * life);
    c.netA = 1 - Math.exp(-TAU * (1500 + mw[2] * 8000 + mw[3] * 3000) * ISR);
    c.wD = Math.round((.007 + c.i * .0013) * SR);
    c.mgT = (c.muted || (anySolo && !c.solo)) ? 0 : 1;
    if (c.blen) {
      c.scan += c.scanDir * (.04 + G.growth * .35) * c.scanM * nb / c.blen * (1 + (rnd() - .5) * e.scat);
      if (c.scan > 1) { c.scan = 1; c.scanDir = -1; } if (c.scan < 0) { c.scan = 0; c.scanDir = 1; }
      if (rnd() < e.scat * .012) c.scanDir *= -1;
    }
  }
  mutate() {
    const G = this.G, alive = this.ch.filter(c => c.life > .05);
    if (!alive.length) return;
    const c = alive[Math.floor(rnd() * alive.length)];
    const n = 2 + Math.floor(rnd() * (2 + G.mut * 5));
    for (let k = 0; k < n; k++) {
      const key = MUTK[Math.floor(rnd() * MUTK.length)];
      c.tgt[key] = clamp(c.p[key] + (rnd() - .5) * (.3 + G.mut * .8), .02, .98);
    }
    if (rnd() < G.mut * .12) this.port.postMessage({t:'meta', c:c.i, el:Math.floor(rnd() * 4)});
    this.port.postMessage({t:'mut', c:c.i});
  }
  block(n) {
    const G = this.G, dt = n * ISR, ch = this.ch, W = this.W, M = this.M, D = this.D, myc = G.myc;
    this.T += dt * (.05 + G.growth * .6);
    let anySolo = false; for (const c of ch) if (c.solo) anySolo = true;
    const gr = .01 + G.growth * .12;
    for (const c of ch) {
      let s = 0; for (let i = 0; i < N; i++) if (i !== c.i) s += W[i][c.i] * M[i][c.i] * ch[i].rms;
      c.inE = s;
      c.life = clamp(c.life + dt * gr * ((c.blen ? .5 : 0) + s * myc * 12) - dt * .004 * (c.blen ? 0 : 1), 0, 1);
    }
    if (!this.freeze) {
      const reach = .2 + G.reach * 1.2;
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        if (i === j) continue;
        const base = Math.exp(-D[i][j] / reach) * .85 + .04;
        W[i][j] = clamp(W[i][j] + dt * gr * (.5 * (ch[i].rms * ch[j].rms * 60 - .01) + .35 * (base - W[i][j]) + (rnd() - .5) * .05), .02, 1);
      }
    }
    for (const c of ch) this.derive(c, anySolo, n);
    const mw0 = this.mw[0];
    for (let j = 0; j < N; j++) {
      let col = 0; for (let i = 0; i < N; i++) if (i !== j) col += W[i][j] * M[i][j];
      const norm = .8 * myc * myc / Math.max(1, col), cj = ch[j];
      for (let i = 0; i < N; i++) {
        cj.nw[i] = i === j ? 0 : W[i][j] * M[i][j] * norm;
        cj.nD[i] = clamp(Math.round((.008 + D[i][j] * .12 + ELT[ch[i].el].sendT) * (1 + mw0 * .5) * SR), 256, TAPN - 256);
      }
    }
    if (G.spores > 0 && this.rFill > SR * 2 && this.ringE > .008) {
      for (const c of ch) {
        c.cool -= dt; if (c.cool > 0) continue;
        const p = dt * G.spores * G.spores * (.01 + G.growth * .05) * (c.blen ? .5 : 3) * (.3 + c.inE * 10);
        if (rnd() < p && this.spore(c)) c.cool = 4;
      }
    }
    this.mutCnt -= dt;
    if (this.mutCnt <= 0) {
      this.mutCnt = (5 + rnd() * 18) * (1.6 - G.mut) / (.4 + G.growth);
      if (G.mut > 0 && rnd() < G.mut + .1) this.mutate();
    }
    let lifeSum = 0; for (const c of ch) lifeSum += c.mg * (.15 + c.life * (.3 + .7 * c.act));
    const mixT = 1.3 / Math.sqrt(1 + lifeSum); this.mixG += (mixT - this.mixG) * .05;
  }
  ping(c) {
    if (c.since < SR / 25) return;
    c.since = 0;
    const G = this.G, E = ELT[c.el], scl = this.scale, n = scl.length;
    if (rnd() < G.melody) { const st = rnd() < .7 ? 1 : 2; c.mel += rnd() < .5 ? st : -st; }
    const range = 1 + Math.floor(G.range * 3.99), lim = Math.max(1, Math.floor(n * range / 2));
    if (c.mel > lim) c.mel = lim - 1; if (c.mel < -lim) c.mel = -lim + 1;
    const deg = ((c.mel % n) + n) % n, oct = Math.floor(c.mel / n);
    const baseHz = this.rootHz * Math.pow(2, E.oct + 1);
    let f = baseHz * scl[deg] * Math.pow(2, oct);
    f *= Math.pow(2, (rnd() - .5) * G.abstr * G.abstr * 2.2);
    f = clamp(f, 30, 5000); c.ft = f; c.melSt = 12 * Math.log2(f / baseHz);
    const fr = clamp(f * E.res2, 30, SR * .4), w = TAU * fr * ISR;
    c.rc = Math.cos(w); c.rs = Math.sin(w); c.rr = Math.exp(-4.6 / (Math.max(.01, c.resDec) * SR)); c.rX = 1; c.rt = 1;
    if (c.drip > 0 && rnd() < .5) c.dCnt = 1;
    c.pings++;
    if (rnd() < G.myc * .6) {
      let S = 0; const W = this.W[c.i], M = this.M[c.i];
      for (let j = 0; j < N; j++) if (j !== c.i) S += W[j] * M[j] * (this.ch[j].life > .03 ? 1 : .3);
      let r = rnd() * S;
      for (let j = 0; j < N; j++) {
        if (j === c.i) continue;
        r -= W[j] * M[j] * (this.ch[j].life > .03 ? 1 : .3);
        if (r <= 0) { const t = this.ch[j]; if (t.symp < 0 && t.life > .03) t.symp = t.nD[c.i] + Math.floor(rnd() * .03 * SR); break; }
      }
    }
  }
  spawn(c) {
    let k = -1; for (let j = 0; j < MAXG; j++) if (!c.gOn[j]) { k = j; break; }
    if (k < 0) return;
    const G = this.G;
    let st = c.pitchSt + (rnd() - .5) * G.abstr * G.abstr * 14 + c.melSt * G.pull * .5;
    st = lerp(st, this.quant(st), G.pull);
    if (c.shim > 0 && rnd() < c.shim) st += rnd() < .7 ? 12 : 19;
    const rate = clamp(Math.pow(2, st / 12), .125, 4);
    let dur = c.gSize; const maxDur = (c.blen - 4) / rate * .9;
    if (dur > maxDur) dur = maxDur; if (dur < 48) return;
    const span = dur * rate, room = c.blen - span - 2;
    let start = (c.scan + (rnd() - .5) * c.e.scat * .5) * c.blen - span * .5;
    start = clamp(start, 0, Math.max(0, room));
    const rev = rnd() < c.revP;
    c.gOn[k] = 1; c.gPos[k] = rev ? start + span : start; c.gInc[k] = rev ? -rate : rate;
    c.gN[k] = 0; c.gWs[k] = 1 / dur; c.gAmp[k] = c.gNorm * (.7 + .3 * rnd());
  }
  spore(c) {
    const RN = this.RN, E = ELT[c.el];
    const len = Math.floor(SR * clamp((1 + rnd() * 3) * Math.sqrt(E.sizeM), .6, 5));
    const avail = Math.min(this.rFill, RN) - len - SR * .1;
    if (avail < SR * .3) return false;
    const start = ((this.rW - len - Math.floor(SR * .1 + rnd() * avail)) % RN + RN) % RN;
    const seg = new Float32Array(len); let m = 0;
    for (let i = 0; i < len; i++) { const v = this.ring[(start + i) % RN]; seg[i] = v; const a = v < 0 ? -v : v; if (a > m) m = a; }
    if (m < .005) return false;
    const fade = Math.floor(SR * .03), g = .85 / m;
    for (let i = 0; i < len; i++) { let v = seg[i] * g; if (i < fade) v *= i / fade; if (i > len - fade) v *= (len - i) / fade; seg[i] = v; }
    if (rnd() < .4) seg.reverse();
    let kind;
    if (!c.blen) { c.gOn.fill(0); c.buf = seg; c.blen = len; c.life = Math.max(c.life, .18); c.scan = rnd(); kind = 'new'; }
    else {
      const blen = c.blen, L2 = Math.min(len, blen), at = Math.floor(rnd() * Math.max(1, blen - L2)), amt = .3 + rnd() * .25;
      for (let i = 0; i < L2; i++) { const en = Math.sin(Math.PI * i / L2) * amt; c.buf[at + i] = c.buf[at + i] * (1 - en) + seg[i] * en; }
      kind = 'graft';
    }
    this.port.postMessage({t:'spore', c:c.i, kind, peaks:this.peaks(c.buf)});
    return true;
  }
  peaks(b) {
    const n = 140, p = new Float32Array(n), st = b.length / n; let mx = 0;
    for (let i = 0; i < n; i++) { let m = 0; const a = Math.floor(i * st), z = Math.floor((i + 1) * st), step = Math.max(1, (z - a) >> 6);
      for (let j = a; j < z; j += step) { const v = b[j] < 0 ? -b[j] : b[j]; if (v > m) m = v; } p[i] = m; if (m > mx) mx = m; }
    if (mx > 0) for (let i = 0; i < n; i++) p[i] /= mx;
    return p;
  }
  run(c, n, mL, mR) {
    const e = c.e, E = ELT[c.el], b = c.buf, blen = c.blen, tap = this.taps[c.i], base = this.tapW, taps = this.taps;
    const nb = c.nb; for (let s = 0; s < n; s++) nb[s] = 0;
    for (let k = 0; k < N; k++) {
      const w = c.nw[k]; if (w < 1e-4) continue;
      const t = taps[k], off = base - c.nD[k];
      for (let s = 0; s < n; s++) nb[s] += t[(off + s) & TAPM] * w;
    }
    const gl0 = c.gl, gr0 = c.gr;
    c.lfo += c.lfoR * n * ISR; c.lfo -= Math.floor(c.lfo);
    const pan = clamp(c.basePan * (1 - c.pmo * .5) + c.pmo * .95 * sn(c.lfo), -1, 1);
    const ang = (pan + 1) * Math.PI / 4, gl1 = Math.cos(ang), gr1 = Math.sin(ang);
    c.gl = gl1; c.gr = gr1;
    const jit = E.jit, scat = e.scat, dgl = (gl1 - gl0) / n, dgr = (gr1 - gr0) / n;
    let env = c.env, atk = c.atk, freq = c.freq, ft = c.ft, cph = c.cph, m1ph = c.m1ph, m2ph = c.m2ph;
    let zr = c.zr, zi = c.zi, rX = c.rX, rc = c.rc, rs = c.rs, rr = c.rr;
    let ic1 = c.ic1, ic2 = c.ic2, l1 = c.l1, l2 = c.l2, fbW = c.fbW, hpX = c.hpX, hpY = c.hpY, net = c.net, wW = c.wW;
    let agc = c.agc, pk = c.pk, crk = c.crk, crkD = c.crkD, bA = c.bA, bB = c.bB, mg = c.mg, gCnt = c.gCnt;
    let pingCnt = c.pingCnt, symp = c.symp, since = c.since, crkCnt = c.crkCnt, nz = c.nz;
    let subPh = c.subPh, re = c.re, rt = c.rt, tPh = c.tPh, hC = c.hC, hV = c.hV;
    let dPh = c.dPh, dF = c.dF, dK = c.dK, dEnv = c.dEnv, dD = c.dD, dCnt = c.dCnt, rPh = c.rPh, fA = c.fA, fT = c.fT, fC = c.fC, cbW = c.cbW;
    const atkA = c.atkA, dec = c.dec, dec2 = c.dec2, glA = c.glA, m1r = c.m1r, m2r = c.m2r, I1 = c.I1, I2 = c.I2, xm = c.xm, voice = c.voice;
    const rAmp = c.rAmp, breath = c.breath, bAa = c.bAa, bBa = c.bBa, crkP = c.crkP, sendScale = c.sendScale, netA = c.netA;
    const drvAmt = c.drvAmt, drvG = c.drvG, fold = c.fold, fbuf = c.fb, fbD = c.fbD, fbG = c.fbG;
    const ffm = c.ffm, lfc = Math.log2(c.fc), kk = c.k, mode = c.mode, gate = c.gate, mgT = c.mgT, lvl = c.lvl;
    const wb = c.wb, wD = c.wD, width = c.width * .35;
    const rumble = c.rumble, trem = c.trem, tremI = c.tremR * ISR, grit = c.grit, holdN = c.holdN, q = c.q;
    const dripP = c.dripP, ripple = c.ripple, rippleI = (3 + ripple * 6) * ISR, rippleD = ripple * SR * .0035;
    const whistle = c.whistle, cb = c.cb, cD = c.cD, cFb = c.cFb, flick = c.flick;
    const gOn = c.gOn, gPos = c.gPos, gInc = c.gInc, gN = c.gN, gWs = c.gWs, gAmp = c.gAmp;
    let G1 = c.g, a1 = 1 / (1 + G1 * (G1 + kk)), a2 = G1 * a1, a3 = G1 * a2;
    const lpgK = SR / TAU;
    let gl = gl0, gr = gr0, rms = 0;
    for (let s = 0; s < n; s++) {
      gl += dgl; gr += dgr;
      since++;
      if (--pingCnt <= 0) {
        pingCnt = c.pInt * ((1 - jit) + jit * Math.min(4, -Math.log(rnd() + 1e-9)));
        if (c.life > .03) { c.since = since; c.dCnt = dCnt; this.ping(c); since = c.since; ft = c.ft; dCnt = c.dCnt; if (c.rX) { atk = true; rX = c.rX; rc = c.rc; rs = c.rs; rr = c.rr; rt = 1; c.rX = 0; } }
      }
      if (symp > 0 && --symp <= 0) {
        symp = -1; c.since = since; c.dCnt = dCnt; this.ping(c); since = c.since; ft = c.ft; dCnt = c.dCnt;
        if (c.rX) { atk = true; rX = c.rX; rc = c.rc; rs = c.rs; rr = c.rr; rt = 1; c.rX = 0; }
      }
      if (atk) { env += (1.05 - env) * atkA; if (env >= 1) { env = 1; atk = false; } } else env *= dec;
      let g = 0;
      if (blen) {
        if (--gCnt <= 0) { gCnt = Math.max(16, c.gInt * (1 + (rnd() - .5) * scat * 1.4)); this.spawn(c); }
        for (let k = 0; k < MAXG; k++) {
          if (gOn[k] === 0) continue;
          const p = gPos[k], i = p | 0;
          if (i < 0 || i >= blen - 1) { gOn[k] = 0; continue; }
          const wx = gN[k] * HN, wj = wx | 0;
          g += (b[i] + (b[i + 1] - b[i]) * (p - i)) * (HANN[wj] + (HANN[wj + 1] - HANN[wj]) * (wx - wj)) * gAmp[k];
          gPos[k] = p + gInc[k]; const nn = gN[k] + gWs[k]; gN[k] = nn; if (nn >= 1) gOn[k] = 0;
        }
      }
      freq += (ft - freq) * glA;
      const m1f = freq * m1r;
      m2ph += m1f * m2r * ISR; if (m2ph >= 1 || m2ph < 0) m2ph -= Math.floor(m2ph);
      let x = m2ph * TS, xi = x | 0; const m2 = SIN[xi] + (SIN[xi + 1] - SIN[xi]) * (x - xi);
      m1ph += (m1f + m2 * I2 * m1f) * ISR; if (m1ph >= 1 || m1ph < 0) m1ph -= Math.floor(m1ph);
      x = m1ph * TS; xi = x | 0; const m1 = SIN[xi] + (SIN[xi + 1] - SIN[xi]) * (x - xi);
      cph += (freq + m1 * I1 * m1f + xm * g * freq * 3) * ISR; if (cph >= 1 || cph < 0) cph -= Math.floor(cph);
      x = cph * TS; xi = x | 0;
      let src = g + (SIN[xi] + (SIN[xi + 1] - SIN[xi]) * (x - xi)) * env * voice;
      const zr0 = zr; zr = rr * (zr0 * rc - zi * rs) + rX; zi = rr * (zr0 * rs + zi * rc); rX = 0;
      src += zi * rAmp;
      if (rumble > 0) { /* EARTH: sub body under each ping */
        rt *= dec2; re += (rt - re) * .004;
        subPh += freq * ISR; if (subPh >= 1) subPh -= 1;
        x = subPh * TS; xi = x | 0; src += (SIN[xi] + (SIN[xi + 1] - SIN[xi]) * (x - xi)) * re * rumble;
      }
      if (dripP > 0) { /* WATER: rising drop tones */
        if (--dCnt <= 0) { dCnt = 1 + (-Math.log(rnd() + 1e-9) / dripP) | 0; dF = freq * Math.pow(2, 1 + rnd() * 2.5); const dur = .02 + rnd() * .06;
          dK = Math.exp(Math.log(1.8 + rnd() * 2) / (dur * SR)); dEnv = .35 + rnd() * .45; dD = Math.exp(-4.6 / (dur * SR)); }
        if (dEnv > 1e-4) { dF *= dK; if (dF > SR * .4) dF = SR * .4; dPh += dF * ISR; if (dPh >= 1) dPh -= Math.floor(dPh);
          x = dPh * TS; xi = x | 0; src += (SIN[xi] + (SIN[xi + 1] - SIN[xi]) * (x - xi)) * dEnv; dEnv *= dD; }
      }
      if (breath > 1e-4) {
        nz = (nz * 1664525 + 1013904223) >>> 0; const w = nz / 2147483648 - 1;
        bA += (w - bA) * bAa; bB += (bA - bB) * bBa; src += (bA - bB) * breath;
      }
      if (crkP > 0) {
        if (--crkCnt <= 0) { crkCnt = 1 + (-Math.log(rnd() + 1e-9) / crkP) | 0; crk = .3 + rnd() * .7; crkD = Math.exp(-1 / ((.0004 + rnd() * .004) * SR)); }
        if (crk > 1e-4) { nz = (nz * 1664525 + 1013904223) >>> 0; src += crk * (nz / 2147483648 - 1); crk *= crkD; }
      }
      if (whistle > 0) { /* AIR: comb resonator tuned to the note (feedback < 0.95, output normalised) */
        const cy = src + cb[(cbW - cD) & CBM] * cFb; cb[cbW] = cy; cbW = (cbW + 1) & CBM;
        src += (cy * (1 - cFb) * 2.2 - src) * whistle;
      }
      if (grit > 0) { /* EARTH: sample-and-hold + bit reduction */
        if (--hC <= 0) { hC = holdN; hV = Math.round(src * q) / q; }
        src += (hV - src) * Math.min(1, grit * 3);
      }
      const gen = sc(src);
      tap[(base + s) & TAPM] = gen * sendScale;
      net += (nb[s] - net) * netA;
      const xin = gen + net;
      let sh = xin;
      if (drvAmt > 0) { let d = xin * drvG; d = d > 200 ? 200 : d < -200 ? -200 : d;
        const fx = (d * .25 + 64) * TS, f0 = fx | 0, fi = f0 & (TS - 1), fs = SIN[fi] + (SIN[fi + 1] - SIN[fi]) * (fx - f0);
        const sx = sc(xin); sh = sx + ((sc(d) * (1 - fold) + fs * fold) * .8 - sx) * drvAmt; }
      const v = sh + fbuf[(fbW - fbD) & FBM];
      if (ffm > 0 && (s & 1) === 0) {
        let ti = (lfc + ffm * m1 - TF0) * TSC; ti = ti < 0 ? 0 : ti > TNN ? TNN : ti; const tj = ti | 0;
        G1 = TANT[tj] + (TANT[tj + 1] - TANT[tj]) * (ti - tj);
        a1 = 1 / (1 + G1 * (G1 + kk)); a2 = G1 * a1; a3 = G1 * a2;
      }
      const v3 = v - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
      let f = v2 * (1 - mode) + v1 * kk * mode;
      if (gate > 0) {
        const fl = (1 - gate) * 18000 + gate * (40 + env * env * 15000), a = fl / (fl + lpgK);
        l1 += (f - l1) * a; l2 += (l1 - l2) * a; f = l2 * (1 - gate + gate * env);
      }
      const hy = f - hpX + .995 * hpY; hpX = f; hpY = hy;
      fbuf[fbW] = sc(hy) * fbG; fbW = (fbW + 1) & FBM;
      mg += (mgT - mg) * .002;
      let y = f * lvl * mg;
      if (trem > 0) { tPh += tremI; if (tPh >= 1) tPh -= 1; x = tPh * TS; xi = x | 0; y *= 1 - trem * (.5 + .5 * (SIN[xi] + (SIN[xi + 1] - SIN[xi]) * (x - xi))); }
      if (flick > 0) { if (--fC <= 0) { fC = ((.015 + rnd() * .1) * SR) | 0; fT = rnd() < .45 ? 1 - flick * .9 : 1; } fA += (fT - fA) * .01; y *= fA; }
      const ay = y < 0 ? -y : y; pk = ay > pk ? ay : pk * .99985;
      const tg = pk > .5 ? .5 / pk : 1; agc += (tg - agc) * (tg < agc ? .02 : .0003);
      y = sc(y * agc);
      rms += y * y;
      wb[wW] = y;
      let wd;
      if (ripple > 0) { /* WATER: modulated delay */
        rPh += rippleI; if (rPh >= 1) rPh -= 1; x = rPh * TS; xi = x | 0;
        const dpos = wD + rippleD * (1 + SIN[xi] + (SIN[xi + 1] - SIN[xi]) * (x - xi)), di = dpos | 0, fr = dpos - di;
        const a0 = wb[(wW - di) & WM], b0 = wb[(wW - di - 1) & WM];
        wd = (a0 + (b0 - a0) * fr) * (width + ripple * .3);
      } else wd = wb[(wW - wD) & WM] * width;
      wW = (wW + 1) & WM;
      mL[s] += y * gl + wd; mR[s] += y * gr - wd;
    }
    c.env = env; c.atk = atk; c.freq = freq; c.ft = ft; c.cph = cph; c.m1ph = m1ph; c.m2ph = m2ph;
    c.zr = zr; c.zi = zi; c.rX = 0; c.rc = rc; c.rs = rs; c.rr = rr;
    c.ic1 = ic1; c.ic2 = ic2; c.l1 = l1; c.l2 = l2; c.fbW = fbW; c.hpX = hpX; c.hpY = hpY; c.net = net; c.wW = wW;
    c.agc = agc; c.pk = pk; c.crk = crk; c.crkD = crkD; c.bA = bA; c.bB = bB; c.mg = mg; c.gCnt = gCnt;
    c.pingCnt = pingCnt; c.symp = symp; c.since = since; c.crkCnt = crkCnt; c.nz = nz;
    c.subPh = subPh; c.re = re; c.rt = rt; c.tPh = tPh; c.hC = hC; c.hV = hV;
    c.dPh = dPh; c.dF = dF; c.dK = dK; c.dEnv = dEnv; c.dD = dD; c.dCnt = dCnt; c.rPh = rPh; c.fA = fA; c.fT = fT; c.fC = fC; c.cbW = cbW;
    c.rms = c.rms * .7 + Math.sqrt(rms / n) * .3;
    if (!(c.rms === c.rms) || !(ic1 === ic1) || !(zr === zr) || !(net === net) || !(re === re)) this.hardReset();
  }
  process(_, outputs) {
    const o = outputs[0], L = o[0], R = o[1] || o[0], n = L.length;
    if ((this.bc++ & 3) === 0) this.block(n * 4);
    for (let s = 0; s < n; s++) { L[s] = 0; if (R !== L) R[s] = 0; }
    const tmpR = R === L ? new Float32Array(n) : R;
    for (const c of this.ch) this.run(c, n, L, tmpR);
    this.tapW = (this.tapW + n) & TAPM;
    const g = this.mixG; let e2 = 0;
    for (let s = 0; s < n; s++) {
      let l = L[s] * g, r = tmpR[s] * g;
      if (!(l === l) || !(r === r)) { this.hardReset(); l = 0; r = 0; }
      L[s] = l; if (R !== L) R[s] = r;
      const mono = (l + r) * .5; this.ring[this.rW] = mono; this.rW = (this.rW + 1) % this.RN; e2 += mono * mono;
    }
    this.rFill = Math.min(this.RN, this.rFill + n);
    this.ringE = this.ringE * .9 + Math.sqrt(e2 / n) * .1;
    this.tel += n;
    if (this.tel >= 2048) {
      this.tel = 0;
      const ch = this.ch, sc_ = ch[this.sel], eff = new Float32Array(KEYS.length);
      KEYS.forEach((k, i) => eff[i] = sc_.e[k]);
      let grains = 0; for (const c of ch) for (let k = 0; k < MAXG; k++) grains += c.gOn[k];
      const W = new Float32Array(64); for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) W[i * 8 + j] = this.W[i][j];
      const pm = {};
      for (const c of ch) if (c.mutated) { pm[c.i] = Object.assign({}, c.p); c.mutated = false; }
      this.port.postMessage({t:'tel', life:ch.map(c => c.life), rms:ch.map(c => c.rms), act:ch.map(c => c.act), scan:ch.map(c => c.scan), pings:ch.map(c => c.pings),
        eff, W, grains, resets:this.resets, pm});
      for (const c of ch) c.pings = 0;
    }
    return true;
  }
}
registerProcessor('harvest-engine', Engine);

/* ------------------------------------------------------------------ master */
class Master extends AudioWorkletProcessor {
  constructor() {
    super();
    this.G = {tilt:.5, drive:.15, vol:.7};
    this.tlL = 0; this.tlR = 0; this.dxL = 0; this.dyL = 0; this.dxR = 0; this.dyR = 0;
    this.LA = Math.round(SR * .004); this.laL = new Float32Array(1024); this.laR = new Float32Array(1024); this.laW = 0; this.lg = 1;
    this.laA = 1 - Math.exp(-1 / (.0008 * SR)); this.lrA = 1 - Math.exp(-1 / (.18 * SR));
    this.fade = 0; this.tel = 0; this.grMin = 1; this.pkMax = 0; this.scope = new Float32Array(512); this.scW = 0;
    this.rec = false; this.rL = new Float32Array(16384); this.rR = new Float32Array(16384); this.rI = 0; this.resets = 0;
    this.port.onmessage = e => this.msg(e.data);
  }
  msg(m) {
    if (m.t === 'g') this.G[m.k] = m.v;
    else if (m.t === 'init') Object.assign(this.G, m.G);
    else if (m.t === 'rec') {
      if (m.v) { this.rI = 0; this.rec = true; }
      else { this.rec = false; this.port.postMessage({t:'rec', L:this.rL.slice(0, this.rI), R:this.rR.slice(0, this.rI), done:true}); this.rI = 0; }
    } else if (m.t === 'panic') this.reset();
  }
  reset() { this.laL.fill(0); this.laR.fill(0); this.lg = 1; this.tlL = this.tlR = this.dxL = this.dyL = this.dxR = this.dyR = 0; this.fade = 0; this.resets++; }
  process(inputs, outputs) {
    const o = outputs[0], L = o[0], R = o[1] || o[0], n = L.length;
    const a = inputs[0] || [], b = inputs[1] || [];
    const aL = a[0], aR = a[1] || a[0], bL = b[0], bR = b[1] || b[0];
    const G = this.G, tA = 1 - Math.exp(-TAU * 700 * ISR), tt = (G.tilt - .5) * 2;
    const tLo = Math.pow(10, -tt * 6 / 20), tHi = Math.pow(10, tt * 6 / 20);
    const dg = 1 + G.drive * G.drive * 6, dN = 1.4 / Math.sqrt(dg), vol = G.vol * G.vol * 1.6;
    for (let s = 0; s < n; s++) {
      let l = (aL ? aL[s] : 0) + (bL ? bL[s] : 0), r = (aR ? aR[s] : 0) + (bR ? bR[s] : 0);
      this.tlL += (l - this.tlL) * tA; l = this.tlL * tLo + (l - this.tlL) * tHi;
      this.tlR += (r - this.tlR) * tA; r = this.tlR * tLo + (r - this.tlR) * tHi;
      if (dg > 1.001) { l = sc(l * dg) * dN; r = sc(r * dg) * dN; }
      let y = l - this.dxL + .9995 * this.dyL; this.dxL = l; this.dyL = y; l = y;
      y = r - this.dxR + .9995 * this.dyR; this.dxR = r; this.dyR = y; r = y;
      if (this.fade < 1) this.fade = Math.min(1, this.fade + ISR / 1.5);
      const fv = vol * this.fade * this.fade; l *= fv; r *= fv;
      const pk = Math.max(l < 0 ? -l : l, r < 0 ? -r : r), tg = pk > .89 ? .89 / pk : 1;
      this.lg += (tg - this.lg) * (tg < this.lg ? this.laA : this.lrA);
      this.laL[this.laW] = l; this.laR[this.laW] = r;
      const rd = (this.laW - this.LA) & 1023; this.laW = (this.laW + 1) & 1023;
      let ol = this.laL[rd] * this.lg, or = this.laR[rd] * this.lg;
      if (!(ol === ol) || !(or === or)) { this.reset(); ol = 0; or = 0; }
      ol = ol > .98 ? .98 : ol < -.98 ? -.98 : ol; or = or > .98 ? .98 : or < -.98 ? -.98 : or;
      L[s] = ol; if (R !== L) R[s] = or;
      if (this.lg < this.grMin) this.grMin = this.lg;
      const ap = Math.max(ol < 0 ? -ol : ol, or < 0 ? -or : or); if (ap > this.pkMax) this.pkMax = ap;
      if (s & 1) { this.scope[this.scW] = (ol + or) * .5; this.scW = (this.scW + 1) & 511; }
      if (this.rec) {
        this.rL[this.rI] = ol; this.rR[this.rI] = or; this.rI++;
        if (this.rI >= 16384) { this.port.postMessage({t:'rec', L:this.rL.slice(), R:this.rR.slice()}); this.rI = 0; }
      }
    }
    this.tel += n;
    if (this.tel >= 2048) {
      this.tel = 0;
      const scope = new Float32Array(256); for (let i = 0; i < 256; i++) scope[i] = this.scope[(this.scW - 256 + i) & 511];
      this.port.postMessage({t:'mtel', gr:this.grMin, pk:this.pkMax, scope, resets:this.resets});
      this.grMin = 1; this.pkMax = 0;
    }
    return true;
  }
}
registerProcessor('harvest-master', Master);
