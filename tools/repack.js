#!/usr/bin/env node
/*
 * dd-zh asar 补丁工具（无第三方依赖）
 *
 *   node repack.js build  --asar <原 app.asar> --out <新文件> --src <src 目录>
 *   node repack.js verify --asar <已打补丁文件> --orig <原 app.asar> --src <src 目录>
 *   node repack.js status --asar <app.asar>
 *   node repack.js exe    --exe <frontend\Docker Desktop.exe> --from <hex> --to <hex>
 *
 * 原理：不改主程序逻辑字符串，向两个 UI 目录各新增一个同源脚本 dd-zh.js
 * （页面 CSP 为 script-src 'self'，内联脚本会被拦截，因此必须用外部文件），
 * 并在 index.html 头部注入 <script src="/dd-zh.js">。其余文件内容原样保留
 * （偏移量不变），仅重写头部并重算新增/替换文件的 integrity。
 * 注意：Docker 的 Electron 内嵌了 asar 头部 JSON 的 sha256 并在启动时校验，
 * 改头部必须用 exe 子命令同步改写 exe 内嵌哈希。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GUI_DIRS = ['build/desktop-ui-2-build', 'build/desktop-ui-build'];
const TRANSLATOR_NAME = 'dd-zh.js';
const MARKER = 'dd-zh-injected-v1';
const BLOCK_SIZE = 4194304; // 4 MiB，与 asar 规范一致

function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/* ---------------- asar 头部读写 ---------------- */

function readHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const b = Buffer.alloc(16);
    fs.readSync(fd, b, 0, 16, 0);
    const pickleSize = b.readUInt32LE(0);          // 恒为 4
    const headerBufLen = b.readUInt32LE(4);        // 头部 pickle 总长
    const jsonLen = b.readUInt32LE(12);
    if (pickleSize !== 4) throw new Error('不是有效的 asar 文件（pickle 前缀异常）');
    const jsonBuf = Buffer.alloc(jsonLen);
    fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
    const header = JSON.parse(jsonBuf.toString('utf8'));
    const fileSize = fs.fstatSync(fd).size;
    return { header, headerBufLen, jsonLen, jsonBytes: jsonBuf, dataStart: 8 + headerBufLen, fileSize };
  } finally {
    fs.closeSync(fd);
  }
}

function buildHeaderBytes(jsonString) {
  // Chromium pickle 规则: [uint32 4][uint32 headerBufLen][uint32 payloadSize]
  // [uint32 jsonLen][json][对齐填充]。payloadSize = 4 + align4(jsonLen)。
  const json = jsonString;
  const L = Buffer.byteLength(json, 'utf8');
  const pad = (4 - (L % 4)) % 4;
  const payloadSize = 4 + L + pad;
  const headerBufLen = 4 + payloadSize;

  const out = Buffer.alloc(8 + headerBufLen); // 默认全 0，即对齐填充
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(headerBufLen, 4);
  out.writeUInt32LE(payloadSize, 8);
  out.writeUInt32LE(L, 12);
  out.write(json, 16, L, 'utf8');
  return out;
}

/* ---------------- integrity ---------------- */

function computeIntegrity(buf) {
  const hash = sha256hex(buf);
  const blocks = [];
  for (let off = 0; off < buf.length; off += BLOCK_SIZE) {
    blocks.push(crypto.createHash('sha256').update(buf.subarray(off, Math.min(off + BLOCK_SIZE, buf.length))).digest('hex'));
  }
  return { algorithm: 'SHA256', hash, blockSize: BLOCK_SIZE, blocks };
}

/* ---------------- 树遍历辅助 ---------------- */

function nodeAt(header, rel) {
  let n = header; // 根节点即 {files: ...}
  for (const part of rel.split('/')) {
    if (!n || !n.files) return null;
    n = n.files[part];
  }
  return n && !n.files ? n : null;
}

function dirAt(header, rel) {
  let n = header;
  for (const part of rel.split('/')) {
    if (!n || !n.files) return null;
    n = n.files[part];
  }
  return n && n.files ? n : null;
}

function cloneHeaderPreservingOrder(node) {
  if (node.files) {
    const out = {};
    for (const k of Object.keys(node.files)) out[k] = cloneHeaderPreservingOrder(node.files[k]);
    return { files: out };
  }
  return { ...node };
}

function collectFiles(node, relPrefix, acc) {
  for (const k of Object.keys(node.files)) {
    const v = node.files[k];
    const rel = relPrefix + '/' + k;
    if (v.files) collectFiles(v, rel, acc);
    else acc.push({ rel, node: v });
  }
  return acc;
}

function readAsarFile(asarPath, node, dataStart) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const buf = Buffer.alloc(node.size);
    fs.readSync(fd, buf, 0, node.size, dataStart + Number(node.offset));
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/* ---------------- 注入 ---------------- */

function buildTranslatorBundle(srcDir) {
  const tpl = fs.readFileSync(path.join(srcDir, 'translator.js'), 'utf8');
  const dict = JSON.parse(fs.readFileSync(path.join(srcDir, 'zh-cn.dict.json'), 'utf8'));
  const exact = dict.exact || {};
  const code = tpl.replace('/*__DICT__*/ {}', JSON.stringify(exact));
  return Buffer.from('/* ' + MARKER + ' */\n' + code, 'utf8');
}

function injectIntoHtml(html) {
  const tag = '<script src="/' + TRANSLATOR_NAME + '"></script>';
  const patterns = [
    /<script\s+type="module"/i,           // 主 bundle 之前
    /<\/head>/i,
    /<meta\s+charset/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) return html.slice(0, m.index) + tag + html.slice(m.index);
  }
  throw new Error('index.html 中找不到注入点');
}

/* ---------------- build ---------------- */

function cmdBuild(args) {
  const { asarPath, outPath, srcDir } = args;
  const translatorBuf = buildTranslatorBundle(srcDir);

  const orig = readHeader(asarPath);
  const origFiles = collectFiles(orig.header, '', []);

  // 校验数据区紧凑无间隙：最后一个打包文件必须正好结束于文件末尾
  let lastEnd = 0;
  for (const f of origFiles) {
    if (f.node.unpacked) continue;
    lastEnd = Math.max(lastEnd, Number(f.node.offset) + f.node.size);
  }
  const bodySize = orig.fileSize - orig.dataStart;
  if (lastEnd !== bodySize) {
    throw new Error(`asar 数据区不是紧凑排布（末尾 ${lastEnd} ≠ ${bodySize}），布局假设不成立，中止`);
  }

  // 生成补丁：每个 UI 目录替换 index.html、新增 dd-zh.js
  const blobs = [];
  const patchPlan = new Map(); // rel -> blob index（替换）
  const addPlan = new Map();   // rel -> blob index（新增文件）
  for (const dir of GUI_DIRS) {
    const relHtml = dir + '/index.html';
    const relJs = dir + '/' + TRANSLATOR_NAME;
    if (nodeAt(orig.header, relJs)) {
      console.error('[已打补丁] ' + relJs + ' 已存在，请先 uninstall 再 install');
      process.exit(3);
    }
    const node = nodeAt(orig.header, relHtml);
    if (!node) { console.error('[警告] 未找到 ' + relHtml + '，跳过该 UI'); continue; }
    const html = readAsarFile(asarPath, node, orig.dataStart).toString('utf8');
    const injected = Buffer.from(injectIntoHtml(html), 'utf8');
    patchPlan.set('/' + relHtml, blobs.length);
    blobs.push(injected);
    addPlan.set('/' + relJs, blobs.length);
    blobs.push(translatorBuf);
  }
  if (!patchPlan.size) throw new Error('没有可注入的目标文件');

  // 追加区起始偏移 = 原数据区末尾（相对 dataStart）
  let appendOffset = bodySize;
  const newOffsets = new Map();
  for (let i = 0; i < blobs.length; i++) {
    newOffsets.set(i, appendOffset);
    appendOffset += blobs[i].length;
  }

  // 新头部：保持原键顺序；替换节点改 size/offset/integrity，新增节点插入目录
  const newHeader = cloneHeaderPreservingOrder(orig.header);
  for (const [rel, idx] of patchPlan) {
    const node = nodeAt(newHeader, rel.slice(1));
    node.size = blobs[idx].length;
    node.offset = String(newOffsets.get(idx));
    node.integrity = computeIntegrity(blobs[idx]);
  }
  for (const [rel, idx] of addPlan) {
    const dirPath = rel.slice(1, rel.lastIndexOf('/'));
    const fileName = rel.slice(rel.lastIndexOf('/') + 1);
    const dirNode = dirAt(newHeader, dirPath);
    if (!dirNode) throw new Error('目录不存在: ' + dirPath);
    dirNode.files[fileName] = {
      size: blobs[idx].length,
      offset: String(newOffsets.get(idx)),
      integrity: computeIntegrity(blobs[idx]),
    };
  }

  const jsonStr = JSON.stringify(newHeader);
  const headerBytes = buildHeaderBytes(jsonStr);
  const headerHash = sha256hex(Buffer.from(jsonStr, 'utf8'));

  // 写出：新头部 + 原数据区（原样复制，偏移相对新头部依然成立）+ 追加 blob
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const body = Buffer.alloc(bodySize);
  const bfd = fs.openSync(asarPath, 'r');
  try {
    let got = 0;
    while (got < bodySize) {
      const n = fs.readSync(bfd, body, got, bodySize - got, orig.dataStart + got);
      if (n <= 0) throw new Error('读取原始数据区中断');
      got += n;
    }
  } finally {
    fs.closeSync(bfd);
  }
  const out = Buffer.concat([headerBytes, body, ...blobs]);
  fs.writeFileSync(outPath, out);
  console.log(JSON.stringify({
    ok: true,
    out: outPath,
    dataStart: headerBytes.length,
    bodyBytes: bodySize,
    appended: blobs.map((b) => b.length),
    patched: Array.from(patchPlan.keys()),
    added: Array.from(addPlan.keys()),
    jsonLen: Buffer.byteLength(jsonStr, 'utf8'),
    headerHash,
    origFiles: origFiles.length,
    totalSize: out.length,
  }, null, 2));
}

/* ---------------- verify ---------------- */

function cmdVerify(args) {
  const { asarPath, origPath, srcDir } = args;
  const translatorBuf = buildTranslatorBundle(srcDir);
  const patched = readHeader(asarPath);
  const orig = readHeader(origPath);

  const pFiles = collectFiles(patched.header, '', []);
  const oFiles = collectFiles(orig.header, '', []);
  const expectedAdded = GUI_DIRS.map((d) => '/' + d + '/' + TRANSLATOR_NAME);
  const expectedCount = oFiles.length + expectedAdded.filter((r) => nodeAt(patched.header, r.slice(1))).length;
  if (pFiles.length !== expectedCount) throw new Error(`文件数不一致 ${pFiles.length} vs 期望 ${expectedCount}`);

  let checked = 0;
  const mismatch = [];
  const byRel = new Map(oFiles.map((f) => [f.rel, f]));
  const patchRels = new Set(GUI_DIRS.map((d) => '/' + d + '/index.html'));
  const addRels = new Set(expectedAdded);
  for (const f of pFiles) {
    if (addRels.has(f.rel)) {
      const got = readAsarFile(asarPath, f.node, patched.dataStart);
      if (!got.equals(translatorBuf)) mismatch.push(f.rel + ' 内容与预期不符');
      const iv = computeIntegrity(got);
      if (JSON.stringify(iv) !== JSON.stringify(f.node.integrity)) mismatch.push(f.rel + ' integrity 与内容不符');
    } else if (patchRels.has(f.rel)) {
      const o = byRel.get(f.rel);
      if (!o) { mismatch.push(f.rel + ' 不存在于原始包'); continue; }
      const expect = Buffer.from(injectIntoHtml(readAsarFile(origPath, o.node, orig.dataStart).toString('utf8')), 'utf8');
      const got = readAsarFile(asarPath, f.node, patched.dataStart);
      if (!got.equals(expect)) mismatch.push(f.rel + ' 内容与预期不符');
      const iv = computeIntegrity(got);
      if (JSON.stringify(iv) !== JSON.stringify(f.node.integrity)) mismatch.push(f.rel + ' integrity 与内容不符');
    } else {
      const o = byRel.get(f.rel);
      if (!o) { mismatch.push(f.rel + ' 不存在于原始包'); continue; }
      if (f.node.unpacked) continue; // 外部文件
      const a = { ...f.node }, b = { ...o.node };
      if (JSON.stringify(a) !== JSON.stringify(b)) { mismatch.push(f.rel + ' 头节点被改动'); continue; }
      const got = readAsarFile(asarPath, f.node, patched.dataStart);
      const want = readAsarFile(origPath, o.node, orig.dataStart);
      if (!got.equals(want)) mismatch.push(f.rel + ' 内容被改动');
      if (computeIntegrity(got).hash !== f.node.integrity.hash) mismatch.push(f.rel + ' integrity 校验失败');
    }
    checked++;
  }
  if (mismatch.length) {
    console.error(JSON.stringify({ ok: false, checked, mismatch: mismatch.slice(0, 20) }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, checked, files: pFiles.length }, null, 2));
}

/* ---------------- status ---------------- */

function cmdStatus(args) {
  const { asarPath } = args;
  const info = readHeader(asarPath);
  const pkgNode = nodeAt(info.header, 'package.json');
  const version = pkgNode ? JSON.parse(readAsarFile(asarPath, pkgNode, info.dataStart).toString('utf8')).version : null;
  let patched = false;
  for (const dir of GUI_DIRS) {
    if (nodeAt(info.header, dir + '/' + TRANSLATOR_NAME)) { patched = true; break; }
  }
  console.log(JSON.stringify({
    ok: true,
    version,
    patched,
    headerHash: sha256hex(info.jsonBytes),
    dataStart: info.dataStart,
    fileSize: info.fileSize,
  }));
}

/*
 * Docker 对其 Electron 前端做了反篡改：frontend\Docker Desktop.exe 内嵌
 * sha256(app.asar 头部 JSON) 的 hex 字符串，启动时原生校验（asar_util.cc
 * "Integrity check failed for asar archive entry '<header>'"）。改头部必须
 * 同步改写该哈希（等长 64 字符原位替换）。
 *
 *   node repack.js exe --exe <frontend\Docker Desktop.exe> --from <旧hex> --to <新hex>
 */
function cmdExe(args) {
  const { exePath, fromHash, toHash } = args;
  const isHex = (s) => /^[0-9a-fA-F]{64}$/.test(s || '');
  if (!isHex(toHash)) throw new Error('to 必须是 64 位十六进制 sha256');
  const fromList = String(fromHash || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(isHex);
  if (!fromList.length) throw new Error('from 必须是 64 位十六进制 sha256（可逗号分隔多个候选）');
  const to = Buffer.from(toHash.toLowerCase(), 'ascii');
  const buf = fs.readFileSync(exePath);
  let at = -1, usedFrom = null;
  for (const h of fromList) {
    if (h === toHash.toLowerCase()) continue;
    const i = buf.indexOf(Buffer.from(h, 'ascii'));
    if (i !== -1) { at = i; usedFrom = h; break; }
  }
  if (at === -1) {
    if (buf.indexOf(to) !== -1) {
      console.log(JSON.stringify({ ok: true, state: 'already', exe: exePath }));
      return;
    }
    throw new Error('exe 中未找到任何旧头部哈希：请先 uninstall 恢复，或检查备份版本');
  }
  if (buf.indexOf(Buffer.from(usedFrom, 'ascii'), at + 1) !== -1) throw new Error('旧头部哈希在 exe 中出现多次，拒绝盲改');
  const fd = fs.openSync(exePath, 'r+');
  try {
    fs.writeSync(fd, to, 0, to.length, at);
  } finally {
    fs.closeSync(fd);
  }
  console.log(JSON.stringify({ ok: true, state: 'patched', exe: exePath, offset: at }));
}

/* ---------------- main ---------------- */

function main() {
  const argv = process.argv.slice(2);
  const mode = argv[0];
  const get = (name) => {
    const i = argv.indexOf('--' + name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const args = {
    asarPath: get('asar'),
    outPath: get('out'),
    srcDir: path.resolve(get('src') || '.'),
    origPath: get('orig'),
    exePath: get('exe'),
    fromHash: get('from'),
    toHash: get('to'),
  };
  if (mode === 'build') return cmdBuild(args);
  if (mode === 'verify') return cmdVerify(args);
  if (mode === 'status') return cmdStatus(args);
  if (mode === 'exe') return cmdExe(args);
  console.error('用法: repack.js <build|verify|status|exe> --asar <app.asar> [--out <file>] [--orig <orig>] [--src <dir>] [--exe <前端exe> --from <hex> --to <hex>]');
  process.exit(2);
}

main();
