'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { HttpClient, DeepSeekError } = require('./src/http-client');
const {
  TokenBucketRateLimiter,
  ConcurrencyLimiter,
  RetryPolicy,
  withRetry
} = require('./src/rate-limiter');
const { solvePoWAsync } = require('./src/pow-solver');
const { SSEParser, CompletionAccumulator } = require('./src/sse-parser');
const { SessionManager } = require('./src/session-manager');

const API = {
  LOGIN: '/api/v0/users/login',
  LOGOUT: '/api/v0/users/logout',
  USER_INFO: '/api/v0/users/current',
  POW_CHALLENGE: '/api/v0/chat/create_pow_challenge',
  CREATE_SESSION: '/api/v0/chat_session/create',
  LIST_SESSIONS: '/api/v0/chat_session/list',
  RENAME_SESSION: '/api/v0/chat_session/update_title',
  DELETE_SESSION: '/api/v0/chat_session/delete',
  CHAT_COMPLETION: '/api/v0/chat/completion',
  CLEAR_SESSION: '/api/v0/chat/clear_context',
  UPLOAD_FILE: '/api/v0/file/upload_file',
  FETCH_FILES: '/api/v0/file/fetch_files',
  PREVIEW_FILE: '/api/v0/file/preview',
};

class DeepSeekClient {
  constructor(opts = {}) {
    this._http = new HttpClient({
      baseUrl: opts.baseUrl || 'https://chat.deepseek.com',
      timeout: opts.timeout || 30000,
      userAgent: opts.userAgent || undefined,
      token: opts.token || null,
    });

    this._rateLimiter = new TokenBucketRateLimiter({
      tokensPerSecond: opts.requestsPerSecond ?? 1.5,
      maxBurst: opts.burstSize ?? 4,
    });

    this._concurrency = new ConcurrencyLimiter(opts.concurrency ?? 2);

    this._retry = new RetryPolicy({
      maxRetries: opts.maxRetries ?? 3,
      baseDelayMs: opts.baseDelayMs ?? 1000,
    });

    this._sessions = new SessionManager();
    this._deviceId = opts.deviceId || crypto.randomUUID();
    this._powCache = null;
    this._userInfo = null;
  }

  async _call(fn) {
    await this._rateLimiter.acquire();
    return this._concurrency.run(() => withRetry(fn, this._retry));
  }

  async login(email, password) {
    const res = await this._call(() =>
      this._http.request('POST', API.LOGIN, {
        body: {
          email,
          password,
          device_id: this._deviceId,
          os: 'web',
          locale: 'en_US'
        },
      })
    );

    const bizData = res?.data?.biz_data;
    const user = bizData?.user;
    const token = user?.token ?? null;

    if (!token) {
      throw new DeepSeekError('Login failed: no token in response', {
        code: 'AUTH_NO_TOKEN',
        data: res,
      });
    }

    this._http.token = token;
    this._userInfo = user;

    return {
      ok: true,
      token,
      device_id: this._deviceId,
      user: this._userInfo,
    };
  }

  async logout() {
    try {
      await this._call(() => this._http.request('POST', API.LOGOUT, { body: {} }));
    } finally {
      this._http.token = null;
      this._userInfo = null;
      this._powCache = null;
    }
    return { ok: true };
  }

  async getUser() {
    const res = await this._call(() => this._http.request('GET', API.USER_INFO));
    this._userInfo = res?.data || res;
    return this._userInfo;
  }

  async _fetchPowChallenge(targetPath = API.CHAT_COMPLETION) {
    const res = await this._call(() =>
      this._http.request('POST', API.POW_CHALLENGE, {
        body: { target_path: targetPath },
      })
    );
    return res?.data?.biz_data?.challenge ?? res?.data?.challenge ?? res?.data ?? res;
  }

  async _acquirePowAnswer(targetPath) {
    const challenge = await this._fetchPowChallenge(targetPath);
    const powResult = await solvePoWAsync(challenge);
    return { ...powResult, target_path: targetPath };
  }

  async createChatSession(opts = {}) {
    const res = await this._call(() => this._http.request('POST', API.CREATE_SESSION, { body: {} }));

    const chatSession = res?.data?.biz_data?.chat_session;
    const sessionId = chatSession?.id;

    if (!sessionId) {
      throw new DeepSeekError('Create session failed: no session ID returned', {
        code: 'SESSION_CREATE_FAILED',
        data: res,
      });
    }

    const session = this._sessions.create({
      id: sessionId,
      title: chatSession.title || null,
      agent_id: chatSession.agent || 'chat',
      model_type: chatSession.model_type || null,
      created_at: chatSession.inserted_at ? chatSession.inserted_at * 1000 : Date.now(),
    });

    return {
      session_id: sessionId,
      session: session.toJSON(),
      raw: chatSession,
    };
  }

  async listRemoteSessions(opts = {}) {
    const res = await this._call(() =>
      this._http.request('GET', API.LIST_SESSIONS, {
        headers: opts.page ? { 'X-Page': String(opts.page) } : {},
      })
    );
    return res?.data || res;
  }

  async renameSession(sessionId, title) {
    const res = await this._call(() =>
      this._http.request('POST', API.RENAME_SESSION, {
        body: { chat_session_id: sessionId, title },
      })
    );
    const session = this._sessions.get(sessionId);
    if (session) session.title = title;
    return { ok: true, session_id: sessionId, title, raw: res?.data };
  }

  async deleteSession(sessionId) {
    const res = await this._call(() =>
      this._http.request('POST', API.DELETE_SESSION, {
        body: { chat_session_id: sessionId },
      })
    );
    this._sessions.delete(sessionId);
    return { ok: true, session_id: sessionId, raw: res?.data };
  }

  sendMessage(sessionId, message, opts = {}) {
    return new Promise(async (resolve, reject) => {
      let powData;
      try {
        powData = await this._acquirePowAnswer(API.CHAT_COMPLETION);
      } catch (err) {
        return reject(err);
      }

      await this._rateLimiter.acquire();

      const session = this._sessions.get(sessionId);
      const parentId = opts.parentMessageId !== undefined
        ? opts.parentMessageId
        : (session?.getRemoteLastMessageId() ?? null);

      const payload = {
        chat_session_id: sessionId,
        parent_message_id: parentId,
        prompt: message,
        ref_file_ids: opts.refFileIds || [],
        thinking_enabled: opts.thinkingEnabled !== false,
        search_enabled: opts.searchEnabled || false,
      };
      if (opts.model) payload.model = opts.model;
      if (opts.prefixId) payload.prefix_id = opts.prefixId;

      const powHeaderPayload = {
        algorithm: powData.algorithm,
        challenge: powData.challenge,
        salt: powData.salt,
        answer: powData.answer,
        signature: powData.signature,
        target_path: powData.target_path,
      };
      const powHeaderBase64 = Buffer.from(JSON.stringify(powHeaderPayload)).toString('base64');

      let streamRes;
      try {
        streamRes = await this._http.stream('POST', API.CHAT_COMPLETION, {
          body: payload,
          headers: {
            'Content-Type': 'application/json',
            'X-Ds-Pow-Response': powHeaderBase64,
          },
        });
      } catch (err) {
        return reject(err);
      }

      const parser = new SSEParser();
      const accumulator = new CompletionAccumulator();
      let settled = false;
      let remoteMessageId = null;
      let remoteParentId = null;

      const settle = (fn) => {
        if (settled) return;
        settled = true;
        parser.removeAllListeners();
        fn();
      };

      parser.on('ready', (data) => {
        if (data.request_message_id) remoteParentId = data.request_message_id;
        if (data.response_message_id) remoteMessageId = data.response_message_id;
        accumulator.ingest({ type: 'ready', payload: data });
      });

      parser.on('event', (event) => {
        accumulator.ingest(event);
      });

      parser.on('done', () => {
        parser.flush();
        const result = accumulator.finalize();

        if (session) {
          session.addUserMessage(message, remoteParentId);
          session.addAssistantMessage(result, remoteMessageId);
          if (remoteMessageId) session.setRemoteLastMessageId(remoteMessageId);
        }

        settle(() =>
          resolve({
            ...result,
            session_id: sessionId,
            pow_meta: powData.meta,
            local_session: session ? session.toJSON() : null,
          })
        );
      });

      streamRes.on('data', (chunk) => parser.feed(chunk));
      streamRes.on('error', (err) =>
        settle(() => reject(new DeepSeekError(err.message, { code: 'STREAM_ERROR' })))
      );
      streamRes.on('end', () => {
        parser.flush();
        if (!settled) {
          const result = accumulator.finalize();
          if (session) {
            session.addUserMessage(message, remoteParentId);
            session.addAssistantMessage(result, remoteMessageId);
            if (remoteMessageId) session.setRemoteLastMessageId(remoteMessageId);
          }
          settle(() =>
            resolve({
              ...result,
              session_id: sessionId,
              pow_meta: powData.meta,
              local_session: session ? session.toJSON() : null,
            })
          );
        }
      });
    });
  }

  async chat(sessionId, message, opts = {}) {
    return this._concurrency.run(() =>
      withRetry(() => this.sendMessage(sessionId, message, opts), {
        ...this._retry,
        retryOn: [429, 500, 502, 503]
      })
    );
  }

  async quickChat(message, opts = {}) {
    const { session_id } = await this.createChatSession(opts);
    return this.chat(session_id, message, opts);
  }

  getLocalSession(sessionId) {
    const s = this._sessions.get(sessionId);
    return s ? s.toJSON() : null;
  }

  listLocalSessions() {
    return this._sessions.toJSON();
  }

  /**
   * Upload file ke DeepSeek
   * @param {Buffer|string} fileData - Data file (Buffer) atau path file
   * @param {string} filename - Nama file
   * @param {string} mimeType - MIME type (contoh: 'image/jpeg')
   * @returns {Promise<Object>} Informasi file yang diupload
   */
  async uploadFile(fileData, filename, mimeType = 'application/octet-stream') {
    let buffer;
    if (typeof fileData === 'string') {
      buffer = fs.readFileSync(fileData);
      if (!filename) {
        filename = path.basename(fileData);
      }
    } else {
      buffer = fileData;
      if (!filename) {
        throw new Error('filename is required when passing Buffer');
      }
    }

    const fileSize = buffer.length;

    const powData = await this._acquirePowAnswer(API.UPLOAD_FILE);

    const powHeaderPayload = {
      algorithm: powData.algorithm,
      challenge: powData.challenge,
      salt: powData.salt,
      answer: powData.answer,
      signature: powData.signature,
      target_path: powData.target_path,
    };
    const powHeaderBase64 = Buffer.from(JSON.stringify(powHeaderPayload)).toString('base64');

    const form = new FormData();
    form.append('file', buffer, {
      filename: filename,
      contentType: mimeType,
    });

    const res = await this._call(() => {
      const headers = {
        ...form.getHeaders(),
        'x-file-size': String(fileSize),
        'x-ds-pow-response': powHeaderBase64,
        'x-thinking-enabled': '0',
      };
      return this._http.request('POST', API.UPLOAD_FILE, {
        body: form,
        headers: headers,
      });
    });

    const fileInfo = res?.data?.biz_data || res?.data || res;

    return {
      id: fileInfo.id,
      name: fileInfo.file_name,
      size: fileInfo.file_size,
      status: fileInfo.status,
      previewable: fileInfo.previewable,
      created_at: fileInfo.inserted_at,
      updated_at: fileInfo.updated_at,
      raw: fileInfo,
    };
  }

  /**
   * Mendapatkan status file berdasarkan ID
   * @param {string|string[]} fileIds - ID file atau array ID file
   * @returns {Promise<Object[]>} Array informasi file
   */
  async getFileStatus(fileIds) {
    const ids = Array.isArray(fileIds) ? fileIds : [fileIds];
    const params = new URLSearchParams();
    params.append('file_ids', ids.join(','));

    const res = await this._call(() =>
      this._http.request('GET', `${API.FETCH_FILES}?${params.toString()}`)
    );

    const files = res?.data?.biz_data?.files || res?.data?.files || [];
    return files.map(f => ({
      id: f.id,
      name: f.file_name,
      size: f.file_size,
      status: f.status,
      previewable: f.previewable,
      token_usage: f.token_usage,
      error_code: f.error_code,
      created_at: f.inserted_at,
      updated_at: f.updated_at,
      raw: f,
    }));
  }

  /**
   * Menunggu hingga file selesai diproses (status SUCCESS atau gagal)
   * @param {string} fileId - ID file
   * @param {Object} options - Opsi polling
   * @param {number} options.maxAttempts - Maksimum percobaan (default 10)
   * @param {number} options.intervalMs - Interval antar percobaan dalam ms (default 2000)
   * @returns {Promise<Object>} Informasi file final
   */
  async waitForFileReady(fileId, options = {}) {
    const maxAttempts = options.maxAttempts || 10;
    const intervalMs = options.intervalMs || 2000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const files = await this.getFileStatus(fileId);
      const file = files[0];

      if (!file) {
        throw new DeepSeekError(`File ${fileId} not found`, { code: 'FILE_NOT_FOUND' });
      }

      if (file.status === 'SUCCESS' || file.status === 'CONTENT_EMPTY' || file.error_code) {
        return file;
      }

      if (attempt < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }

    const files = await this.getFileStatus(fileId);
    return files[0];
  }

  /**
   * Mendapatkan URL preview untuk file
   * @param {string} fileId - ID file
   * @returns {Promise<string>} URL preview
   */
  async getPreviewUrl(fileId) {
    const params = new URLSearchParams({
      file_id: fileId,
      unsent: 'true',
    });

    const res = await this._call(() =>
      this._http.request('GET', `${API.PREVIEW_FILE}?${params.toString()}`)
    );

    const url = res?.data?.biz_data?.url || res?.data?.url;
    if (!url) {
      throw new DeepSeekError('Failed to get preview URL', { code: 'PREVIEW_URL_FAILED' });
    }
    return url;
  }

  /**
   * Upload file dan tunggu siap, lalu kembalikan info lengkap
   * @param {Buffer|string} fileData - Data file
   * @param {string} filename - Nama file
   * @param {string} mimeType - MIME type
   * @returns {Promise<Object>} Info file lengkap termasuk token usage
   */
  async uploadAndWaitForFile(fileData, filename, mimeType) {
    const uploaded = await this.uploadFile(fileData, filename, mimeType);
    const readyFile = await this.waitForFileReady(uploaded.id);
    return {
      ...uploaded,
      ...readyFile,
      preview_url: readyFile.previewable ? await this.getPreviewUrl(uploaded.id) : null,
    };
  }

  toJSON() {
    return {
      authenticated: !!this._http.token,
      device_id: this._deviceId,
      user: this._userInfo,
      rate_limiter: {
        tokens_per_second: this._rateLimiter.tokensPerSecond,
        max_burst: this._rateLimiter.maxBurst,
      },
      concurrency: this._concurrency.limit,
      sessions: this._sessions.toJSON(),
      cookies: this._http.cookies.toJSON(),
    };
  }
}

module.exports = {
  DeepSeekClient,
  DeepSeekError,
  solvePoW: require('./src/pow-solver').solvePoW,
  solvePoWAsync: require('./src/pow-solver').solvePoWAsync,
  SSEParser,
  CompletionAccumulator,
  SessionManager,
  TokenBucketRateLimiter,
};