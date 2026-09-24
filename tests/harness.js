// Runs js/parser.worker.js inside Node (no browser) so parser changes can be checked from the CLI.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const JS = path.join(__dirname, '..', 'js');

function loadWorker() {
  const ctx = { console, Float32Array, Uint32Array, Uint8Array, Int8Array, Math, Set, Map, Infinity, JSON };
  ctx.self = ctx;
  ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), ctx, { filename: f }); };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(JS, 'parser.worker.js'), 'utf8'), ctx, { filename: 'parser.worker.js' });
  return ctx;
}

function parseText(text, name) {
  const ctx = loadWorker();
  let out = null;
  ctx.postMessage = (m) => { if (m.type !== 'progress') out = m; };
  return ctx.onmessage({ data: { file: { text: async () => text }, name } }).then(() => {
    if (!out || out.type === 'error') throw new Error(out ? out.message : 'no result');
    return out.result;
  });
}

const parseFile = (file) => parseText(fs.readFileSync(file, 'utf8'), path.basename(file));

module.exports = { parseText, parseFile };
