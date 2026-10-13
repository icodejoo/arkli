'use strict';
/**
 * Arkli WebMessageListener spike 页面脚本。
 * 用 URL 参数选测试：?t=probe,latency,up,oneshot,down,frames,b64,life,cancel
 * 其它参数：n 延迟次数、rounds 轮数、sizes 上传尺寸、r 重复次数、chunk 分块字节数。
 * 所有结果以 `SPIKE <kind> <json>` 打到 console，由原生转进 logcat（tag ArkliSpike）。
 */

/** 日志前缀 */
const TAG = 'SPIKE';
/** 默认分块：1MB */
const DEFAULT_CHUNK = 1 << 20;
/** base64 兜底分块：192KB */
const B64_CHUNK = 192 * 1024;
/** crypto.getRandomValues 单次上限 */
const RANDOM_MAX = 65536;
/** 二进制帧头长度 */
const HEADER = 8;
/** 单次调用超时（毫秒） */
const CALL_TIMEOUT = 60000;
/** 状态存储键（生命周期测试用） */
const STAGE_KEY = 'spike.stage';

const P = new URLSearchParams(location.search);
/** 要跑的测试列表 */
const TESTS = (P.get('t') || '').split(',').filter(Boolean);
/** 新通道对象 */
const nat = window.ArkliNative;
/** 旧通道对象 */
const leg = window.ArkliLegacy;

/** 写日志到 console 与页面 */
function log(kind, obj) {
  const line = `${TAG} ${kind} ${JSON.stringify(obj)}`;
  console.log(line);
  const d = document.getElementById('log');
  if (d) d.textContent += line + '\n';
}

/** 解析尺寸串，如 64k、5m */
function parseSize(s) {
  const m = /^(\d+)([km]?)$/.exec(s);
  return +m[1] * (m[2] === 'm' ? 1048576 : m[2] === 'k' ? 1024 : 1);
}

/** 取数组中位数 */
function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/** 延迟统计：均值、P50、P95、最大 */
function stats(a) {
  const s = [...a].sort((x, y) => x - y);
  const avg = s.reduce((x, y) => x + y, 0) / s.length;
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { n: s.length, avg: +avg.toFixed(3), p50: +q(0.5).toFixed(3), p95: +q(0.95).toFixed(3), max: +s[s.length - 1].toFixed(3) };
}

/** 睡一会 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 新通道 ----------
/** 挂起请求表 */
const pend = new Map();
/** 请求自增号 */
let seq = 0;
/** 等待下行二进制的回调 */
let binWaiter = null;
/** 收到的非预期消息类型计数 */
const msgKinds = { string: 0, arraybuffer: 0, other: 0 };

if (nat) {
  nat.onmessage = (ev) => {
    const d = ev.data;
    if (typeof d === 'string' && d.charCodeAt(0) === 1) {
      // latin1 字符串帧：标记字符 + 每字符一个字节
      msgKinds.string++;
      const n = d.length - 1;
      const u8 = new Uint8Array(n);
      for (let i = 0; i < n; i++) u8[i] = d.charCodeAt(i + 1);
      if (binWaiter) binWaiter(u8.buffer);
    } else if (typeof d === 'string') {
      msgKinds.string++;
      const m = JSON.parse(d);
      const p = pend.get(m.id);
      if (p) { pend.delete(m.id); m.ok ? p.res(m.data) : p.rej(m.error); }
    } else if (d instanceof ArrayBuffer) {
      msgKinds.arraybuffer++;
      if (binWaiter) binWaiter(d);
    } else {
      msgKinds.other++;
    }
  };
}

/** 新通道调用；返回带 id 的 promise 便于取消 */
function ncall(method, params = {}, id = 'n' + (seq++)) {
  const p = new Promise((res, rej) => {
    const t = setTimeout(() => { pend.delete(id); rej({ code: 'TIMEOUT', message: method }); }, CALL_TIMEOUT);
    pend.set(id, { res: (d) => { clearTimeout(t); res(d); }, rej: (e) => { clearTimeout(t); rej(e); } });
    nat.postMessage(JSON.stringify({ v: 2, id, method, params }));
  });
  p.id = id;
  return p;
}

// ---------- 旧通道 ----------
/** 旧通道挂起表 */
const lpend = new Map();
window.__spikeLegacyDispatch = (json) => {
  const m = JSON.parse(json);
  const p = lpend.get(m.id);
  if (p) { lpend.delete(m.id); p(m); }
};
/** 旧通道调用 */
function lcall(method, params = {}) {
  return new Promise((res) => {
    const id = 'l' + (seq++);
    lpend.set(id, res);
    leg.postMessage(JSON.stringify({ v: 1, id, method, params }));
  });
}

// ---------- 工具函数 ----------
/** 生成随机数据（不计入计时） */
function genData(size) {
  const u = new Uint8Array(size);
  for (let o = 0; o < size; o += RANDOM_MAX) crypto.getRandomValues(u.subarray(o, Math.min(o + RANDOM_MAX, size)));
  return u;
}

/** 十六进制 sha256 */
async function sha256Hex(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 页面 JS 堆已用 MB */
function jsHeapMb() {
  return performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : -1;
}

// ---------- 测试 ----------
/** 1. 能力探测 */
async function tProbe() {
  const info = { ua: navigator.userAgent, hasNative: typeof nat, hasLegacy: typeof leg, secure: isSecureContext, origin: location.origin };
  if (nat) { try { info.hello = await ncall('spike.hello'); } catch (e) { info.helloErr = e; } }
  log('probe', info);
  // 晚注册验证：页面已加载后才 addWebMessageListener，对象出现了吗？重载后呢？
  if (P.get('late') === '1') {
    await sleep(2500);
    log('late', { afterRegister: typeof window.ArkliNative });
    if (!sessionStorage.getItem('spike.lateReloaded')) {
      sessionStorage.setItem('spike.lateReloaded', '1');
      location.reload();
    } else {
      log('late', { afterReload: typeof window.ArkliNative });
    }
  }
}

/** 2. 延迟对比：新旧通道交替跑多轮 */
async function tLatency() {
  const N = +P.get('n') || 100;
  const R = +P.get('rounds') || 3;
  const warm = 20;
  const run = async (fn) => {
    for (let i = 0; i < warm; i++) await fn();
    const t = [];
    for (let i = 0; i < N; i++) { const s = performance.now(); await fn(); t.push(performance.now() - s); }
    return stats(t);
  };
  for (let r = 0; r < R; r++) {
    const order = r % 2 === 0 ? ['native', 'legacy'] : ['legacy', 'native'];
    for (const ch of order) {
      const st = ch === 'native' ? await run(() => ncall('native.ping')) : await run(() => lcall('native.ping'));
      log('latency', { round: r, channel: ch, ...st });
    }
  }
}

/** 分块上传（二进制帧）。返回耗时与校验信息 */
async function uploadBin(u8, chunk, oneShot) {
  const t0 = performance.now();
  const { handle } = await ncall('native.file.openWrite', { name: 't.bin', mime: 'application/octet-stream', size: u8.length });
  const t1 = performance.now();
  let s = 0;
  const step = oneShot ? u8.length : chunk;
  for (let o = 0; o < u8.length; o += step) {
    const len = Math.min(step, u8.length - o);
    const f = new ArrayBuffer(HEADER + len);
    const dv = new DataView(f);
    dv.setUint32(0, handle);
    dv.setUint32(4, s++);
    new Uint8Array(f, HEADER).set(u8.subarray(o, o + len));
    nat.postMessage(f);
  }
  const t2 = performance.now();
  const closed = await ncall('native.file.closeWrite', { handle });
  const t3 = performance.now();
  return { handle, closed, openMs: t1 - t0, sendMs: t2 - t1, drainMs: t3 - t2, totalMs: t3 - t0 };
}

/** latin1 字符串帧上传：标记字符 + 8 字符帧头 + 载荷，纯文本消息，不依赖 ArrayBuffer 特性 */
async function uploadLatin1(u8, chunk) {
  const t0 = performance.now();
  const { handle } = await ncall('native.file.openWrite', { name: 't.bin', size: u8.length });
  const t1 = performance.now();
  let s = 0;
  const hdr = (v) => String.fromCharCode((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  for (let o = 0; o < u8.length; o += chunk) {
    const end = Math.min(o + chunk, u8.length);
    const parts = ['\x01', hdr(handle), hdr(s++)];
    for (let i = o; i < end; i += 0x8000) parts.push(String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + 0x8000, end))));
    nat.postMessage(parts.join(''));
  }
  const t2 = performance.now();
  const closed = await ncall('native.file.closeWrite', { handle });
  const t3 = performance.now();
  return { handle, closed, openMs: t1 - t0, sendMs: t2 - t1, drainMs: t3 - t2, totalMs: t3 - t0 };
}

/** 2b. 页面直接发 ArrayBuffer 会怎样（特性不支持时观察行为） */
async function tAbProbe() {
  const r = {};
  const kind = P.get('kind') || 'ab';
  const make = { ab: () => new ArrayBuffer(16), u8: () => new Uint8Array(16), blob: () => new Blob(['abc']), num: () => 42, obj: () => ({ a: 1 }) }[kind];
  log('abprobe-before', { kind });
  try { nat.postMessage(make()); r[kind] = 'no-throw'; } catch (e) { r[kind] = 'throw ' + e; }
  await sleep(800);
  log('abprobe', r);
}

/** 按原生探测的特性选默认上传模式：支持 ArrayBuffer 才发二进制帧，否则 latin1（避免旧 WebView 崩溃） */
async function defaultMode() {
  const h = await ncall('spike.hello');
  return h.features.WEB_MESSAGE_ARRAY_BUFFER ? 'bin' : 'latin1';
}

/** 3. 页面到原生二进制上传 */
async function tUp() {
  const sizes = (P.get('sizes') || '64k,1m,5m,20m,50m').split(',').map(parseSize);
  const reps = +P.get('r') || 3;
  const chunk = +P.get('chunk') || DEFAULT_CHUNK;
  const mode = P.get('mode') || await defaultMode();
  for (const size of sizes) {
    const data = genData(size);
    const srcSha = await sha256Hex(data);
    const runs = [];
    for (let i = 0; i < reps; i++) {
      await ncall('spike.mem.begin');
      const heap0 = jsHeapMb();
      const u = mode === 'latin1' ? await uploadLatin1(data, chunk) : await uploadBin(data, chunk, false);
      const heap1 = jsHeapMb();
      const mem = await ncall('spike.mem.end');
      const h = await ncall('spike.file.sha', { handle: u.handle });
      runs.push({ ...u, mem, heap0, heap1, ok: h.sha256 === srcSha && u.closed.size === size && u.closed.badSeq === 0, hashMs: h.hashMs });
    }
    const tot = runs.map((r) => r.totalMs);
    const med = median(tot);
    log('up', {
      mode, size, chunk, reps, allOk: runs.every((r) => r.ok),
      totalMsMedian: +med.toFixed(1), totalMsAll: tot.map((x) => +x.toFixed(0)),
      mbps: +((size / 1048576) / (med / 1000)).toFixed(2),
      sendMsMedian: +median(runs.map((r) => r.sendMs)).toFixed(1), drainMsMedian: +median(runs.map((r) => r.drainMs)).toFixed(1),
      frames: runs[0].closed.frames, badSeq: runs.map((r) => r.closed.badSeq),
      nativeRssPeakMb: runs[runs.length - 1].mem.rssPeakMb, nativeRssBaseMb: runs[runs.length - 1].mem.base.rssMb,
      nativeJavaPeakMb: runs[runs.length - 1].mem.javaPeakMb, nativeNativePeakMb: runs[runs.length - 1].mem.nativePeakMb,
      jsHeapBefore: runs[0].heap0, jsHeapAfter: runs[0].heap1, srcSha: srcSha.slice(0, 12),
    });
  }
}

/** 3b. 不分块一次发整块，找上限 */
async function tOneshot() {
  const mode = P.get('mode') || await defaultMode();
  const sizes = (P.get('sizes') || '1m,5m,20m,50m,100m,200m').split(',').map(parseSize);
  for (const size of sizes) {
    try {
      const data = genData(size);
      const srcSha = await sha256Hex(data);
      const u = mode === 'latin1' ? await uploadLatin1(data, size) : await uploadBin(data, size, true);
      const h = await ncall('spike.file.sha', { handle: u.handle });
      log('oneshot', { mode, size, ok: h.sha256 === srcSha && u.closed.size === size, totalMs: +u.totalMs.toFixed(0), mbps: +((size / 1048576) / (u.totalMs / 1000)).toFixed(2) });
    } catch (e) {
      log('oneshot', { size, error: String(e && (e.message || e.code || e)) });
      break;
    }
  }
}

/** 等一帧下行二进制 */
function waitBin() {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { binWaiter = null; rej(new Error('bin timeout')); }, CALL_TIMEOUT);
    binWaiter = (b) => { clearTimeout(t); binWaiter = null; res(b); };
  });
}

/** 校验下行数据规则：字节 i = (i*7+3)&0xff */
function checkPattern(u8) {
  for (let i = 0; i < u8.length; i++) if (u8[i] !== ((i * 7 + 3) & 0xff)) return false;
  return true;
}

/** 4. 原生到页面下行：bin(ArrayBuffer)、b64(JSON)、latin1(字符串)、fetch(PathHandler) 对比 */
async function tDown() {
  const sizes = (P.get('sizes') || '1m,5m,20m').split(',').map(parseSize);
  const reps = +P.get('r') || 5;
  const modes = (P.get('modes') || 'bin,b64,latin1,fetch').split(',');
  for (const size of sizes) {
    for (const mode of modes) {
      const ms = []; let ok = true; let err = null;
      for (let i = 0; i < reps && !err; i++) {
        try {
          let buf; let s;
          if (mode === 'bin' || mode === 'latin1') {
            const w = waitBin();
            s = performance.now();
            const call = ncall(mode === 'bin' ? 'spike.down' : 'spike.downLatin1', { size });
            buf = await Promise.race([w, call.then(() => new Promise(() => {}))]);
            ms.push(performance.now() - s);
            await call;
          } else if (mode === 'b64') {
            s = performance.now();
            const r = await ncall('spike.downB64', { size });
            const bin = atob(r.b64);
            const u = new Uint8Array(bin.length);
            for (let k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k);
            buf = u.buffer;
            ms.push(performance.now() - s);
          } else {
            await ncall('spike.makeFile', { size, name: 'down.bin' });
            s = performance.now();
            const r = await fetch('/spike-cache/down.bin?x=' + mode + i);
            buf = await r.arrayBuffer();
            ms.push(performance.now() - s);
          }
          if (i === 0) ok = buf.byteLength === size && checkPattern(new Uint8Array(buf));
        } catch (e) { err = String(e && (e.message || e.code || JSON.stringify(e))); }
      }
      const base = { size, mode, reps };
      if (err) { log('down', { ...base, error: err }); continue; }
      const med = median(ms);
      log('down', { ...base, ok, msMedian: +med.toFixed(1), mbps: +((size / 1048576) / (med / 1000)).toFixed(2), all: ms.map((x) => +x.toFixed(0)) });
    }
  }
}

/** 5. iframe 来源限制 */
async function tFrames() {
  const results = {};
  window.addEventListener('message', (e) => {
    if (e.data && e.data.spikeFrame) results[e.data.spikeFrame] = e.data.r;
  });
  const probe = (name) => `(function(){var r={n:typeof ArkliNative,l:typeof ArkliLegacy,o:String(location.origin)};`
    + `try{if(typeof ArkliLegacy!=='undefined')ArkliLegacy.postMessage(JSON.stringify({id:'xf',method:'native.ping',params:{}}))}catch(e){r.legacyErr=String(e)}`
    + `try{if(typeof ArkliNative!=='undefined')ArkliNative.postMessage(JSON.stringify({id:'xf',method:'native.ping',params:{}}))}catch(e){r.nativeErr=String(e)}`
    + `parent.postMessage({spikeFrame:'${name}',r:r},'*')})()`;
  const mk = (attrs) => { const f = document.createElement('iframe'); Object.assign(f, attrs); document.body.appendChild(f); return f; };
  // srcdoc：继承父页面来源
  mk({ srcdoc: `<script>${probe('srcdoc')}<\/script>` });
  // data: URL：不透明来源
  mk({ src: 'data:text/html,' + encodeURIComponent(`<script>${probe('data')}<\/script>`) });
  // sandbox 的 srcdoc：不透明来源
  const sb = document.createElement('iframe');
  sb.setAttribute('sandbox', 'allow-scripts');
  sb.srcdoc = `<script>${probe('sandbox-srcdoc')}<\/script>`;
  document.body.appendChild(sb);
  // 真跨源：evil.example 由原生拦截后用 frame.html 响应
  mk({ src: 'https://evil.example/frame.html' });
  // about:blank：从父页面直接探测
  const ab = mk({ src: 'about:blank' });
  results['about:blank'] = { n: typeof ab.contentWindow.ArkliNative, l: typeof ab.contentWindow.ArkliLegacy };
  await sleep(2500);
  // srcdoc 再从父页面直接读一次
  const sd = document.querySelector('iframe[srcdoc]');
  results['srcdoc-from-parent'] = { n: typeof sd.contentWindow.ArkliNative, l: typeof sd.contentWindow.ArkliLegacy };
  // Worker 里有没有注入对象
  const w = new Worker(URL.createObjectURL(new Blob(['postMessage({n:typeof ArkliNative,l:typeof ArkliLegacy})'])));
  results.worker = await new Promise((res) => { w.onmessage = (e) => res(e.data); setTimeout(() => res('timeout'), 2000); });
  log('frames', results);
}

/** 把 Uint8Array 转 base64 */
function toB64(u8) {
  let s = '';
  for (let o = 0; o < u8.length; o += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(o, o + 0x8000));
  return btoa(s);
}

/** 6. base64 JSON 兜底：串行等回包 与 流水线两种 */
async function tB64() {
  const sizes = (P.get('sizes') || '5m,20m').split(',').map(parseSize);
  const reps = +P.get('r') || 3;
  for (const size of sizes) {
    const data = genData(size);
    const srcSha = await sha256Hex(data);
    for (const mode of ['pipeline', 'serial']) {
      const runs = [];
      let ok = true;
      for (let i = 0; i < reps; i++) {
        const t0 = performance.now();
        const { handle } = await ncall('native.file.openWrite', { name: 'b.bin', size });
        let s = 0;
        const ps = [];
        for (let o = 0; o < size; o += B64_CHUNK) {
          const call = ncall('spike.file.writeB64', { handle, seq: s++, data: toB64(data.subarray(o, Math.min(o + B64_CHUNK, size))) });
          if (mode === 'serial') await call; else ps.push(call);
        }
        await Promise.all(ps);
        const closed = await ncall('native.file.closeWrite', { handle });
        runs.push(performance.now() - t0);
        const h = await ncall('spike.file.sha', { handle });
        ok = ok && h.sha256 === srcSha && closed.badSeq === 0;
      }
      const med = median(runs);
      log('b64', { size, mode, reps, ok, chunk: B64_CHUNK, msMedian: +med.toFixed(0), msAll: runs.map((x) => +x.toFixed(0)), mbps: +((size / 1048576) / (med / 1000)).toFixed(2) });
    }
  }
}

/** 7. 生命周期：重载、hash 导航、渲染进程崩溃重建 */
async function tLife() {
  const stage = +(localStorage.getItem(STAGE_KEY) || 0);
  const hello = nat ? await ncall('spike.hello').catch((e) => ({ err: e })) : null;
  const ping = nat ? await ncall('native.ping').then(() => 'ok', (e) => 'fail ' + JSON.stringify(e)) : 'no-object';
  log('life', { stage, nativeType: typeof nat, session: hello && hello.session, ping, late: P.get('late') });
  if (stage === 0) {
    localStorage.setItem(STAGE_KEY, '1');
    if (nat) await ncall('spike.reload');
  } else if (stage === 1) {
    location.hash = '#/spa-nav';
    await sleep(300);
    log('life', { stage: '1b-hash-nav', ping: await ncall('native.ping').then(() => 'ok', () => 'fail') });
    localStorage.setItem(STAGE_KEY, '2');
    await ncall('spike.crash');
  } else {
    log('life', { stage: 'recovered', ping });
    localStorage.removeItem(STAGE_KEY);
    log('done', { t: 'life' });
  }
}

/** 8. 取消：sleep 5s，200ms 后取消，期望 CANCELLED */
async function tCancel() {
  const t0 = performance.now();
  const call = ncall('spike.sleep', { ms: 5000 });
  await sleep(200);
  const c = await ncall('native.task.cancel', { id: call.id });
  let res;
  try { res = await call; } catch (e) { res = e; }
  log('cancel', { cancelResp: c, result: res, ms: +(performance.now() - t0).toFixed(0) });
}

/** 造一个 pattern 填充的 Blob：每 1MB 一块相同数据（1MB 是 256 的倍数，全局规则一致），不先拼成整块 ArrayBuffer */
function makePatternBlob(size) {
  const unit = new Uint8Array(DEFAULT_CHUNK);
  for (let i = 0; i < unit.length; i++) unit[i] = (i * 7 + 3) & 0xff;
  const parts = [];
  for (let o = 0; o < size; o += DEFAULT_CHUNK) parts.push(unit.subarray(0, Math.min(DEFAULT_CHUNK, size - o)));
  return new Blob(parts);
}

/** latin1 编码一段 Uint8Array 为字符串 */
function latin1Of(u8) {
  const parts = [];
  for (let i = 0; i < u8.length; i += 0x8000) parts.push(String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + 0x8000, u8.length))));
  return parts.join('');
}

/** 8 字符帧头里的 4 字节大端整数 */
const hdr4 = (v) => String.fromCharCode((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);

/**
 * 8. 内存对比：同一个 Blob，chunk=逐块 slice().arrayBuffer() 后发送；one=整块读出后一次发送。
 * 宿主脚本在 pre 毫秒空闲期取基线，上传期间与结束后取样两个进程的 VmRSS/VmHWM。
 */
async function tUpBlob() {
  const size = parseSize(P.get('size') || '50m');
  const mode = P.get('mode') || 'chunk';
  await sleep(+P.get('pre') || 3000);
  const blob = makePatternBlob(size);
  await ncall('spike.mem.begin');
  const t0 = performance.now();
  const { handle } = await ncall('native.file.openWrite', { name: 'b.bin', size });
  if (mode === 'chunk') {
    let s = 0;
    for (let o = 0; o < size; o += DEFAULT_CHUNK) {
      const ab = await blob.slice(o, Math.min(o + DEFAULT_CHUNK, size)).arrayBuffer();
      nat.postMessage('\x01' + hdr4(handle) + hdr4(s++) + latin1Of(new Uint8Array(ab)));
    }
  } else {
    const ab = await blob.arrayBuffer();
    nat.postMessage('\x01' + hdr4(handle) + hdr4(0) + latin1Of(new Uint8Array(ab)));
  }
  const t1 = performance.now();
  const closed = await ncall('native.file.closeWrite', { handle });
  const t2 = performance.now();
  const mem = await ncall('spike.mem.end');
  const chk = await ncall('spike.file.checkPattern', { handle });
  log('upblob', { mode, size, ms: +(t2 - t0).toFixed(0), mbps: +((size / 1048576) / ((t2 - t0) / 1000)).toFixed(2), sendMs: +(t1 - t0).toFixed(0), size2: closed.size, bad: chk.bad, mem });
  await sleep(+P.get('post') || 2500);
}

/** 9. 回环 HTTP 上传：fetch POST Blob 到 127.0.0.1 */
async function tLoop() {
  const size = parseSize(P.get('size') || '50m');
  await sleep(+P.get('pre') || 3000);
  const blob = makePatternBlob(size);
  const { port, token } = await ncall('spike.loop.open');
  await ncall('spike.mem.begin');
  const t0 = performance.now();
  let res;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/up`, { method: 'POST', headers: { 'x-token': token }, body: blob });
    res = { status: r.status, body: await r.json() };
  } catch (e) { res = { error: String(e) }; }
  const ms = performance.now() - t0;
  const mem = await ncall('spike.mem.end');
  log('loop', { size, ms: +ms.toFixed(0), mbps: +((size / 1048576) / (ms / 1000)).toFixed(2), res, mem });
  await sleep(+P.get('post') || 2500);
}

/** 10. 拦截器能否读到 POST body：页面 POST 到同源假路径，原生只记录 WebResourceRequest 能给的信息 */
async function tPostProbe() {
  const body = new Blob([new Uint8Array(1024 * 1024)]);
  const r = await fetch('/post-probe', { method: 'POST', body });
  log('postprobe', { status: r.status, text: await r.text() });
}

/** 测试表 */
const RUNNERS = { upblob: tUpBlob, loop: tLoop, postprobe: tPostProbe, abprobe: tAbProbe, probe: tProbe, latency: tLatency, up: tUp, oneshot: tOneshot, down: tDown, frames: tFrames, b64: tB64, life: tLife, cancel: tCancel };

/** 入口：按顺序跑，每个测试都捕获异常并打日志 */
(async () => {
  log('start', { tests: TESTS, nat: typeof nat, leg: typeof leg, late: P.get('late') });
  for (const t of TESTS) {
    try { await RUNNERS[t](); } catch (e) { log('error', { t, e: String(e && (e.message || e.code || JSON.stringify(e))) }); }
  }
  if (!TESTS.includes('life')) log('done', { t: TESTS.join(',') });
})();
