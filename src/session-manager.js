'use strict';

const crypto = require('crypto');

class Message {
  constructor(opts) {
    this.id = opts.id || crypto.randomUUID();
    this.remote_id = opts.remote_id || null;
    this.parent_id = opts.parent_id || null;
    this.remote_parent_id = opts.remote_parent_id || null;
    this.role = opts.role;
    this.content = opts.content || '';
    this.thinking = opts.thinking || null;
    this.finish_reason = opts.finish_reason || null;
    this.model = opts.model || null;
    this.usage = opts.usage || null;
    this.search_results = opts.search_results || null;
    this.created_at = opts.created_at || Date.now();
    this.timing = opts.timing || null;
  }

  toJSON() {
    return {
      id: this.id,
      remote_id: this.remote_id,
      parent_id: this.parent_id,
      remote_parent_id: this.remote_parent_id,
      role: this.role,
      content: this.content,
      thinking: this.thinking,
      finish_reason: this.finish_reason,
      model: this.model,
      usage: this.usage,
      search_results: this.search_results,
      created_at: this.created_at,
      timing: this.timing,
    };
  }
}

class ChatSession {
  constructor(opts) {
    this.id = opts.id;
    this.title = opts.title || null;
    this.character_id = opts.character_id || 1;
    this.agent_id = opts.agent_id || 'chat';
    this.model = opts.model || null;
    this.messages = [];
    this.created_at = opts.created_at || Date.now();
    this.updated_at = Date.now();
    this._lastLocalMessageId = null;
    this._lastRemoteMessageId = null;
  }

  addUserMessage(content, remoteParentId = null) {
    const msg = new Message({
      role: 'user',
      content,
      remote_parent_id: remoteParentId,
    });
    this.messages.push(msg);
    this._lastLocalMessageId = msg.id;
    this.updated_at = Date.now();
    return msg;
  }

  addAssistantMessage(completionResult, remoteMessageId = null) {
    const msg = new Message({
      id: completionResult.message_id ? String(completionResult.message_id) : undefined,
      remote_id: remoteMessageId,
      parent_id: this._lastLocalMessageId,
      remote_parent_id: completionResult.parent_id || null,
      role: 'assistant',
      content: completionResult.content,
      thinking: completionResult.thinking,
      finish_reason: completionResult.finish_reason,
      model: completionResult.model,
      usage: completionResult.usage,
      search_results: completionResult.search_results,
      timing: completionResult.timing,
    });
    this.messages.push(msg);
    this._lastLocalMessageId = msg.id;
    this._lastRemoteMessageId = remoteMessageId;
    this.updated_at = Date.now();
    if (completionResult.model) this.model = completionResult.model;
    return msg;
  }

  getLastMessageId() {
    return this._lastLocalMessageId;
  }

  getRemoteLastMessageId() {
    return this._lastRemoteMessageId;
  }

  setRemoteLastMessageId(id) {
    this._lastRemoteMessageId = id;
  }

  getHistory() {
    return this.messages.map(m => m.toJSON());
  }

  toJSON() {
    return {
      id: this.id,
      title: this.title,
      character_id: this.character_id,
      agent_id: this.agent_id,
      model: this.model,
      message_count: this.messages.length,
      created_at: this.created_at,
      updated_at: this.updated_at,
      messages: this.getHistory(),
    };
  }
}

class SessionManager {
  constructor() {
    this._sessions = new Map();
  }

  create(opts) {
    const session = new ChatSession(opts);
    this._sessions.set(session.id, session);
    return session;
  }

  get(id) {
    return this._sessions.get(id) || null;
  }

  delete(id) {
    return this._sessions.delete(id);
  }

  list() {
    return Array.from(this._sessions.values()).map(s => ({
      id: s.id,
      title: s.title,
      model: s.model,
      message_count: s.messages.length,
      created_at: s.created_at,
      updated_at: s.updated_at,
    }));
  }

  toJSON() {
    return {
      session_count: this._sessions.size,
      sessions: this.list(),
    };
  }
}

module.exports = { SessionManager, ChatSession, Message };