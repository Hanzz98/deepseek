'use strict';

const { EventEmitter } = require('events');

class SSEParser extends EventEmitter {
  constructor() {
    super();
    this._buf = '';
    this._eventType = 'message';
    this._data = '';
    this._id = null;
  }

  feed(chunk) {
    this._buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nlIdx;
    while ((nlIdx = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nlIdx).replace(/\r$/, '');
      this._buf = this._buf.slice(nlIdx + 1);
      this._processLine(line);
    }
  }

  _processLine(line) {
    if (line === '') {
      this._dispatch();
      return;
    }
    if (line.startsWith(':')) return;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      this._handleField(line, '');
      return;
    }
    const field = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 1).replace(/^ /, '');
    this._handleField(field, value);
  }

  _handleField(field, value) {
    switch (field) {
      case 'event':
        this._eventType = value;
        break;
      case 'data':
        this._data = this._data ? this._data + '\n' + value : value;
        break;
      case 'id':
        this._id = value;
        break;
    }
  }

  _dispatch() {
    if (!this._data) return;

    const rawData = this._data;
    const eventType = this._eventType;
    const id = this._id;

    this._data = '';
    this._eventType = 'message';

    if (rawData === '[DONE]') {
      this.emit('done', { id });
      return;
    }

    let parsed = null;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      this.emit('raw', { type: eventType, data: rawData, id });
      return;
    }

    this.emit(eventType, { ...parsed, _sse_id: id });
    this.emit('event', { type: eventType, payload: parsed, id });
  }

  flush() {
    if (this._buf.trim()) this.feed('\n');
    this._buf = '';
  }
}

class CompletionAccumulator {
  constructor() {
    this.reset();
  }

  reset() {
    this.session_id = null;
    this.message_id = null;
    this.parent_id = null;
    this.model = null;
    this.role = 'assistant';
    this.thinking = '';
    this.content = '';
    this.finish_reason = null;
    this.usage = null;
    this.search_results = [];
    this.chunks = [];
    this.created_at = null;
    this.completed_at = null;
    this._started = Date.now();
    this._currentFragmentContent = '';
  }

  ingest(event) {
    this.chunks.push(event);

    const payload = event.payload || event;
    const v = payload.v;

    if (event.type === 'ready' && v) {
      this.message_id = v.response_message_id;
      this.parent_id = v.request_message_id;
      this.model = v.model_type || this.model;
      return;
    }

    if (event.type === 'update_session' || event.type === 'title' || event.type === 'close') {
      return;
    }

    if (v && v.response) {
      const resp = v.response;
      if (resp.message_id) this.message_id = resp.message_id;
      if (resp.parent_id) this.parent_id = resp.parent_id;
      if (resp.model) this.model = resp.model;
      if (resp.accumulated_token_usage) this.usage = resp.accumulated_token_usage;
      if (resp.status === 'FINISHED') this.finish_reason = 'stop';

      if (resp.fragments) {
        for (const frag of resp.fragments) {
          if (frag.type === 'RESPONSE' && frag.content) {
            this.content += frag.content;
          }
        }
      }
    }

    const p = payload.p;
    const o = payload.o;
    const val = payload.v;

    if (p && o) {
      if (p === 'response/fragments/-1/content' && o === 'APPEND' && typeof val === 'string') {
        this.content += val;
      }
      
      if (p === 'response' && o === 'BATCH' && Array.isArray(val)) {
        for (const item of val) {
          if (item.p === 'accumulated_token_usage') this.usage = item.v;
          if (item.p === 'quasi_status' && item.v === 'FINISHED') this.finish_reason = 'stop';
        }
      }
      
      if (p === 'response/status' && o === 'SET') {
        if (val === 'FINISHED') this.finish_reason = 'stop';
      }
    }

    if (typeof v === 'string' && !p && !o) {
      this.content += v;
    }
  }

  finalize() {
    this.completed_at = Date.now();
    this.duration_ms = this.completed_at - this._started;
    return this.toJSON();
  }

  toJSON() {
    return {
      session_id: this.session_id,
      message_id: this.message_id,
      parent_id: this.parent_id,
      model: this.model,
      role: this.role,
      content: this.content,
      thinking: this.thinking || null,
      finish_reason: this.finish_reason,
      usage: this.usage,
      search_results: this.search_results.length ? this.search_results : null,
      timing: {
        created_at: this.created_at,
        completed_at: this.completed_at,
        duration_ms: this.duration_ms,
      },
      chunk_count: this.chunks.length,
    };
  }
}

module.exports = { SSEParser, CompletionAccumulator };
