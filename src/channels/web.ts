import crypto from 'crypto';
import http from 'http';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { WEB_CHAT_HTML } from './web-frontend.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

interface PendingResponse {
  resolve: (text: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WebChannel implements Channel {
  name = 'web';

  private server: http.Server | null = null;
  private opts: {
    onMessage: OnInboundMessage;
    onChatMetadata: OnChatMetadata;
    registeredGroups: () => Record<string, RegisteredGroup>;
  };
  private password: string;
  private port: number;
  private connected = false;

  // Map of chatJid -> queued response messages from agent
  private responseQueues = new Map<string, string[]>();
  // Map of chatJid -> pending long-poll response
  private pendingPolls = new Map<string, PendingResponse>();

  constructor(
    password: string,
    port: number,
    opts: {
      onMessage: OnInboundMessage;
      onChatMetadata: OnChatMetadata;
      registeredGroups: () => Record<string, RegisteredGroup>;
    },
  ) {
    this.password = password;
    this.port = port;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    return new Promise<void>((resolve) => {
      this.server!.listen(this.port, () => {
        this.connected = true;
        logger.info({ port: this.port }, 'Web chat server started');
        console.log(`\n  Web chat: http://localhost:${this.port}\n`);
        resolve();
      });
    });
  }

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const url = new URL(req.url || '/', `http://localhost:${this.port}`);
    const pathname = url.pathname;

    // CORS headers for all responses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization',
    );

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(WEB_CHAT_HTML);
      return;
    }

    if (pathname === '/api/send' && req.method === 'POST') {
      this.handleSend(req, res);
      return;
    }

    if (pathname === '/api/poll' && req.method === 'POST') {
      this.handlePoll(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk: Buffer) => {
        data += chunk.toString();
        if (data.length > 1_000_000) {
          reject(new Error('Request body too large'));
        }
      });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }

  private jsonResponse(
    res: http.ServerResponse,
    status: number,
    data: unknown,
  ): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private async handleSend(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = JSON.parse(await this.readBody(req));
      const { password, message, sessionId } = body as {
        password?: string;
        message?: string;
        sessionId?: string;
      };

      if (!password || password !== this.password) {
        this.jsonResponse(res, 401, { error: 'Invalid password' });
        return;
      }

      if (!message || typeof message !== 'string' || !message.trim()) {
        this.jsonResponse(res, 400, { error: 'Message required' });
        return;
      }

      // Each browser session gets a unique chat JID
      const sid = sessionId || crypto.randomUUID();
      const chatJid = `web:${sid}`;
      const timestamp = new Date().toISOString();

      // Auto-register this web session as a group if not already registered
      const groups = this.opts.registeredGroups();
      if (!groups[chatJid]) {
        // Store metadata so the orchestrator can discover it
        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          `Web Chat ${sid.slice(0, 8)}`,
          'web',
          false,
        );

        // We need to auto-register. We'll use the IPC-style approach:
        // Store the message and let it be picked up. But first we need the group registered.
        // For web chats, we auto-register with no trigger requirement.
        const { setRegisteredGroup } = await import('../db.js');
        const { resolveGroupFolderPath } = await import('../group-folder.js');
        const folderName = `web-${sid.slice(0, 8)}`;

        // Create the group folder
        const fs = await import('fs');
        const path = await import('path');
        const groupDir = resolveGroupFolderPath(folderName);
        fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

        const group: RegisteredGroup = {
          name: `Web Chat ${sid.slice(0, 8)}`,
          folder: folderName,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: timestamp,
          requiresTrigger: false,
        };
        setRegisteredGroup(chatJid, group);

        // Reload registered groups in memory (the orchestrator reads from DB)
        // We need to update the in-memory state too
        groups[chatJid] = group;
      }

      // Prepend trigger to ensure it always activates
      let content = message.trim();
      if (!TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }

      // Deliver the message
      this.opts.onMessage(chatJid, {
        id: crypto.randomUUID(),
        chat_jid: chatJid,
        sender: `web-user-${sid.slice(0, 8)}`,
        sender_name: 'User',
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info({ chatJid, sid: sid.slice(0, 8) }, 'Web message received');
      this.jsonResponse(res, 200, { ok: true, sessionId: sid });
    } catch (err) {
      logger.error({ err }, 'Web /api/send error');
      this.jsonResponse(res, 500, { error: 'Internal error' });
    }
  }

  private async handlePoll(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = JSON.parse(await this.readBody(req));
      const { password, sessionId } = body as {
        password?: string;
        sessionId?: string;
      };

      if (!password || password !== this.password) {
        this.jsonResponse(res, 401, { error: 'Invalid password' });
        return;
      }

      if (!sessionId) {
        this.jsonResponse(res, 400, { error: 'sessionId required' });
        return;
      }

      const chatJid = `web:${sessionId}`;

      // Check if there are already queued messages
      const queue = this.responseQueues.get(chatJid);
      if (queue && queue.length > 0) {
        const messages = queue.splice(0);
        this.jsonResponse(res, 200, { messages });
        return;
      }

      // Cancel any existing pending poll for this session
      const existing = this.pendingPolls.get(chatJid);
      if (existing) {
        clearTimeout(existing.timer);
        existing.resolve('[]');
      }

      // Long poll — wait up to 30s for a response
      const timeout = 30_000;
      const promise = new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          this.pendingPolls.delete(chatJid);
          resolve('[]');
        }, timeout);

        this.pendingPolls.set(chatJid, { resolve, timer });
      });

      const result = await promise;
      // Check if response already sent (race with timeout)
      if (!res.writableEnded) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(`{"messages":${result}}`);
      }
    } catch (err) {
      logger.error({ err }, 'Web /api/poll error');
      if (!res.writableEnded) {
        this.jsonResponse(res, 500, { error: 'Internal error' });
      }
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Check if there's a pending long-poll waiting
    const pending = this.pendingPolls.get(jid);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingPolls.delete(jid);
      pending.resolve(JSON.stringify([text]));
      return;
    }

    // Otherwise queue the message
    const queue = this.responseQueues.get(jid) || [];
    queue.push(text);
    this.responseQueues.set(jid, queue);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('web:');
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      // Clear all pending polls
      for (const [, pending] of this.pendingPolls) {
        clearTimeout(pending.timer);
        pending.resolve('[]');
      }
      this.pendingPolls.clear();

      this.server.close();
      this.server = null;
      this.connected = false;
      logger.info('Web chat server stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    // Send a typing indicator as a special message
    const pending = this.pendingPolls.get(jid);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingPolls.delete(jid);
      pending.resolve(JSON.stringify([{ typing: true }]));
    }
  }
}

registerChannel('web', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['WEB_CHAT_PASSWORD', 'WEB_CHAT_PORT']);
  const password =
    process.env.WEB_CHAT_PASSWORD || envVars.WEB_CHAT_PASSWORD || '';
  if (!password) {
    logger.warn('Web: WEB_CHAT_PASSWORD not set');
    return null;
  }
  const port = parseInt(
    process.env.WEB_CHAT_PORT || envVars.WEB_CHAT_PORT || '3100',
    10,
  );
  return new WebChannel(password, port, opts);
});
