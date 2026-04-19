'use strict';

const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const WASM_PATH = path.join(__dirname, 'wasm', 'sha3_wasm_bg.wasm');

class DeepSeekHash {
  constructor() {
    this.instance = null;
    this.memory = null;
    this.exports = null;
  }
  
  async init(wasmPath = WASM_PATH) {
    const wasmBuffer = fs.readFileSync(wasmPath);
    const module = await WebAssembly.compile(wasmBuffer);

    const importObject = {
      wasi_snapshot_preview1: {
        proc_exit: () => {},
        fd_write: () => {},
        fd_read: () => {},
        fd_close: () => {},
        fd_seek: () => {},
      },
      env: {}
    };

    const instance = await WebAssembly.instantiate(module, importObject);
    this.instance = instance;
    this.exports = instance.exports;
    this.memory = this.exports.memory;

    return this;
  }

  _writeToMemory(text) {
    const encoder = new TextEncoder();
    const encoded = encoder.encode(text);
    const length = encoded.length;

    const malloc = this.exports.__wbindgen_export_0;
    const ptr = malloc(length, 1);

    const memoryView = new Uint8Array(this.memory.buffer, ptr, length);
    memoryView.set(encoded);

    return [ptr, length];
  }

  calculateHash(algorithm, challenge, salt, difficulty, expire_at) {
    const prefix = `${salt}_${expire_at}_`;

    const addToStackPointer = this.exports.__wbindgen_add_to_stack_pointer;
    const retptr = addToStackPointer(-16);

    try {
      const [challengePtr, challengeLen] = this._writeToMemory(challenge);
      const [prefixPtr, prefixLen] = this._writeToMemory(prefix);

      this.exports.wasm_solve(
        retptr,
        challengePtr, challengeLen,
        prefixPtr, prefixLen,
        difficulty
      );

      const memoryView = new Uint8Array(this.memory.buffer);
      const status = new Int32Array(memoryView.buffer, retptr, 1)[0];

      if (status === 0) {
        return null;
      }

      const valueBytes = memoryView.slice(retptr + 8, retptr + 16);
      const value = new Float64Array(valueBytes.buffer)[0];
      return Math.floor(value);
    } finally {
      addToStackPointer(16);
    }
  }
}

class DeepSeekPOW {
  constructor() {
    this.hasher = new DeepSeekHash();
  }

  async initialize() {
    await this.hasher.init();
  }

  solveChallenge(config) {
    const answer = this.hasher.calculateHash(
      config.algorithm,
      config.challenge,
      config.salt,
      config.difficulty,
      config.expire_at
    );

    const result = {
      algorithm: config.algorithm,
      challenge: config.challenge,
      salt: config.salt,
      answer: answer,
      signature: config.signature,
      target_path: config.target_path
    };

    return Buffer.from(JSON.stringify(result)).toString('base64');
  }
}

const ALGORITHM = 'DeepSeekHashV1';

async function solvePoWAsync(challenge, progressCallback = null) {
  const { algorithm, challenge: challengeStr, salt, difficulty, signature, expire_at, expireAt } = challenge;
  const expiry = expire_at ?? expireAt;

  if (algorithm !== ALGORITHM) {
    throw new Error(`Unsupported algorithm: ${algorithm}`);
  }

  const pow = new DeepSeekPOW();
  await pow.initialize();

  const startTime = Date.now();
  const answer = pow.hasher.calculateHash(algorithm, challengeStr, salt, difficulty, expiry);

  if (answer === null) {
    throw new Error('No solution found');
  }

  const hashHex = '';

  return {
    algorithm: ALGORITHM,
    challenge: challengeStr,
    salt,
    answer,
    signature,
    meta: {
      difficulty,
      expireAt: expiry,
      duration_ms: Date.now() - startTime,
      hash_hex: hashHex,
      leading_zeros: 0,
      workers: 1
    }
  };
}

function solvePoW(challenge) {
  const { algorithm, challenge: challengeStr, salt, difficulty, expire_at, expireAt } = challenge;
  const expiry = expire_at ?? expireAt;

  if (algorithm !== ALGORITHM) {
    throw new Error(`Unsupported algorithm: ${algorithm}`);
  }

  const hasher = new DeepSeekHash();
  throw new Error('solvePoW sync not supported with WASM; use solvePoWAsync');
}

module.exports = {
  DeepSeekHash,
  DeepSeekPOW,
  solvePoW,
  solvePoWAsync,
  ALGORITHM
};