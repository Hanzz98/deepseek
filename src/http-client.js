'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');

class DeepSeekError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'DeepSeekError';
    this.code = opts.code || 'UNKNOWN';
    this.status = opts.status || null;
    this.requestId = opts.requestId || null;
    this.data = opts.data || null;
    Error.captureStackTrace(this, DeepSeekError);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      status: this.status,
      request_id: this.requestId,
      data: this.data,
    };
  }
}

class CookieJar {
  constructor() {
    this._cookies = new Map();
  }

  set(setCookieHeader, domain) {
    const parts = setCookieHeader.split(';').map(s => s.trim());
    const [name, value] = parts[0].split('=');
    if (!name) return;
    this._cookies.set(name.trim(), {
      value: value ?? '',
      domain,
      path: '/',
      expires: null,
    });
  }

  setMany(headers, domain) {
    const raw = headers['set-cookie'];
    if (!raw) return;
    const arr = Array.isArray(raw) ? raw : [raw];
    arr.forEach(c => this.set(c, domain));
  }

  serialize() {
    return Array.from(this._cookies.entries())
      .map(([k, v]) => `${k}=${v.value}`)
      .join('; ');
  }

  get(name) {
    return this._cookies.get(name)?.value ?? null;
  }

  toJSON() {
    const out = {};
    for (const [k, v] of this._cookies) out[k] = v.value;
    return out;
  }
}

function buildUserAgent() {
  return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
}

class HttpClient {
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl || 'https://chat.deepseek.com';
    this.timeout = opts.timeout || 30000;
    this.userAgent = opts.userAgent || buildUserAgent();
    this.cookies = new CookieJar();
    this.token = opts.token || null;
    this._reqCounter = 0;
    this._hostname = new URL(this.baseUrl).hostname;
  }

  _buildHeaders(extra = {}) {
    const h = {
      'Accept': '*/*',
      'User-Agent': this.userAgent,
      'Origin': this.baseUrl,
      'Referer': `${this.baseUrl}/`,
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'x-app-version': '20241129.1',
      'x-client-platform': 'web',
      'x-client-version': '1.8.0',
      'x-client-locale': 'en_US',
      'x-client-timezone-offset': '25200',
    };
    const cookies = this.cookies.serialize();
    if (cookies) h['Cookie'] = cookies;
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return Object.assign(h, extra);
  }

  _parseResponse(rawBody, statusCode, responseHeaders) {
    const requestId = responseHeaders['x-request-id'] || null;
    let parsed;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      if (statusCode >= 400) {
        throw new DeepSeekError(`HTTP ${statusCode}: non-JSON response`, {
          code: 'HTTP_ERROR',
          status: statusCode,
          requestId,
          data: { raw: rawBody.slice(0, 500) },
        });
      }
      return { raw: rawBody };
    }

    if (statusCode >= 400) {
      throw new DeepSeekError(
        parsed?.message || parsed?.error?.message || `HTTP ${statusCode}`,
        {
          code: parsed?.code || 'HTTP_ERROR',
          status: statusCode,
          requestId,
          data: parsed,
        }
      );
    }

    if (parsed?.code !== undefined && parsed.code !== 0) {
      throw new DeepSeekError(parsed.msg || parsed.message || 'API error', {
        code: `API_${parsed.code}`,
        status: statusCode,
        requestId,
        data: parsed,
      });
    }

    return parsed;
  }

  _prepareBody(body, existingHeaders) {
    if (!body) return { bodyBuffer: null, headers: {} };

    if (typeof body.getHeaders === 'function') {
      const formHeaders = body.getHeaders();
      
      const headers = { ...formHeaders };
      return { bodyBuffer: body, headers };
    }

    if (Buffer.isBuffer(body) || typeof body === 'string') {
      return {
        bodyBuffer: body,
        headers: {
          'Content-Type': existingHeaders['Content-Type'] || 'application/octet-stream',
        },
      };
    }

    const json = JSON.stringify(body);
    return {
      bodyBuffer: Buffer.from(json),
      headers: { 'Content-Type': 'application/json' },
    };
  }

  request(method, path, opts = {}) {
    return new Promise((resolve, reject) => {
      const reqId = ++this._reqCounter;
      const url = new URL(path.startsWith('http') ? path : `${this.baseUrl}${path}`);

      const { bodyBuffer, headers: bodyHeaders } = this._prepareBody(
        opts.body,
        opts.headers || {}
      );

      let headers = this._buildHeaders({
        ...bodyHeaders,
        ...(opts.headers || {}),
      });

      if (bodyBuffer && !(bodyBuffer instanceof require('stream').Stream)) {
        headers['Content-Length'] = Buffer.byteLength(bodyBuffer);
      }

      const reqOpts = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: method.toUpperCase(),
        headers,
        timeout: opts.timeout || this.timeout,
      };

      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(reqOpts, res => {
        this.cookies.setMany(res.headers, url.hostname);
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(this._parseResponse(raw, res.statusCode, res.headers));
          } catch (e) {
            reject(e);
          }
        });
        res.on('error', reject);
      });

      req.on('error', err => {
        reject(
          new DeepSeekError(err.message, {
            code: err.code || 'NETWORK_ERROR',
            data: { reqId },
          })
        );
      });
      req.on('timeout', () => {
        req.destroy();
        reject(
          new DeepSeekError('Request timeout', {
            code: 'TIMEOUT',
            data: { reqId },
          })
        );
      });

      if (bodyBuffer) {
        if (bodyBuffer instanceof require('stream').Stream) {
          bodyBuffer.pipe(req);
        } else {
          req.write(bodyBuffer);
          req.end();
        }
      } else {
        req.end();
      }
    });
  }

  stream(method, path, opts = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path.startsWith('http') ? path : `${this.baseUrl}${path}`);

      const bodyStr = opts.body ? JSON.stringify(opts.body) : null;
      const headers = this._buildHeaders({
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        ...(opts.headers || {}),
      });

      const reqOpts = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: method.toUpperCase(),
        headers,
      };

      const req = https.request(reqOpts, res => {
        this.cookies.setMany(res.headers, url.hostname);

        if (res.statusCode >= 400) {
          const errChunks = [];
          res.on('data', c => errChunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(errChunks).toString('utf8');
            let parsed;
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = { raw };
            }
            reject(
              new DeepSeekError(parsed?.message || `HTTP ${res.statusCode}`, {
                code: `HTTP_${res.statusCode}`,
                status: res.statusCode,
                data: parsed,
              })
            );
          });
          return;
        }

        resolve(res);
      });

      req.on('error', err => {
        reject(
          new DeepSeekError(err.message, {
            code: err.code || 'NETWORK_ERROR',
          })
        );
      });

      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }
}

module.exports = {
  HttpClient,
  CookieJar,
  DeepSeekError,
};