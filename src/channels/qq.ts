import { logger } from '../logger.js';
import {
  RegisteredGroup,
  NewMessage,
  Channel,
  OnInboundMessage,
  OnChatMetadata,
} from '../types.js';

import { registerChannel, type ChannelOpts } from './registry.js';
import { readEnvFile } from '../env.js';

// QQ Bot API types
interface QQConfig {
  appId: string;
  clientSecret: string;
  sandbox?: boolean;
  autoRegister?: boolean;
}

interface QQMessage {
  id: string;
  author: {
    id: string;
  };
  content: string;
  timestamp: string;
  group_id?: string;
  attachments?: Array<{
    content_type: string;
    url: string;
    filename: string;
  }>;
}

interface QQPayload {
  op: number;
  t?: string;
  s?: number;
  d?: {
    heartbeat_interval?: number;
    session_id?: string;
    user?: { id: string; username: string };
    id?: string;
    author?: { id: string };
    content?: string;
    timestamp?: string;
    group_id?: string;
    group_openid?: string;
    user_openid?: string;
    attachments?: QQMessage['attachments'];
  };
}

// QQ Gateway Opcodes
const Opcode = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

// QQ Intents - USER_MESSAGE includes GROUP_AT_MESSAGE_CREATE and C2c_MESSAGE_CREATE
const Intents = {
  USER_MESSAGE: 1 << 25,
};

interface QQChannelOpts {
  factoryOpt: ChannelOpts;
  appId: string;
  clientSecret: string;
  sandbox?: boolean;
  autoRegister?: boolean;
}

/**
 * QQ Channel - QQ机器人 WebSocket 模式消息渠道
 *
 * 通过 QQ 开放平台 WebSocket 与机器人进行交互。
 * 支持 Markdown 消息格式。
 *
 * 配置要求:
 * - QQ_APP_ID: 机器人的 AppID
 * - QQ_CLIENT_SECRET: 机器人的 ClientSecret
 * - QQ_SANDBOX: 是否使用沙箱模式 (可选，默认 true)
 */
export class QQChannel implements Channel {
  name = 'qq';

  private ws: WebSocket | null = null;
  private connected = false;
  private opts: QQChannelOpts;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;

  private sessionId = '';
  private sequence: number | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private acked = true;
  private accessToken: string | null = null;
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private gatewayUrl: string | null = null;

  constructor(opts: QQChannelOpts) {
    this.opts = opts;
    logger.info(
      {
        appId: opts.appId.slice(0, 8) + '...',
        sandbox: opts.sandbox,
        autoRegister: opts.autoRegister,
      },
      'QQ channel created',
    );
  }

  async connect(): Promise<void> {
    try {
      // Step 1: Get access token
      await this.ensureAccessToken();

      // Step 2: Get gateway URL
      await this.fetchGatewayUrl();

      // Step 3: Connect to WebSocket
      await this.connectWebSocket();

      logger.info('QQ channel connected');
    } catch (err) {
      logger.error({ err }, 'Failed to connect QQ channel');
      throw err;
    }
  }

  /**
   * Get access token from QQ API
   */
  private async ensureAccessToken(): Promise<void> {
    const result = await fetch('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appId: this.opts.appId,
        clientSecret: this.opts.clientSecret,
      }),
    });

    if (!result.ok) {
      const errorText = await result.text();
      throw new Error(
        `Failed to get QQ access token: ${result.status} ${errorText}`,
      );
    }

    const data = (await result.json()) as {
      access_token?: string;
      expires_in?: number;
    };

    if (!data.access_token) {
      throw new Error('No access_token in QQ API response');
    }

    this.accessToken = data.access_token;
    logger.debug({ expiresIn: data.expires_in }, 'QQ access token obtained');

    // Schedule token refresh before expiry
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
    }
    // Refresh 60 seconds before expiry
    const refreshTime = ((data.expires_in || 7200) - 60) * 1000;
    this.tokenRefreshTimer = setTimeout(() => {
      this.ensureAccessToken().catch((err) => {
        logger.error({ err }, 'Failed to refresh QQ access token');
      });
    }, refreshTime);
  }

  /**
   * Fetch WebSocket gateway URL
   */
  private async fetchGatewayUrl(): Promise<void> {
    const endpoint =
      this.opts.sandbox !== false
        ? 'https://sandbox.api.sgroup.qq.com'
        : 'https://api.sgroup.qq.com';

    const result = await fetch(`${endpoint}/gateway`, {
      method: 'GET',
      headers: {
        Authorization: `QQBot ${this.accessToken}`,
        'X-Union-Appid': this.opts.appId,
      },
    });

    if (!result.ok) {
      const errorText = await result.text();
      throw new Error(
        `Failed to get QQ gateway URL: ${result.status} ${errorText}`,
      );
    }

    const data = (await result.json()) as { url?: string };
    if (!data.url) {
      throw new Error('No url in QQ gateway response');
    }

    this.gatewayUrl = data.url;
    logger.debug({ gatewayUrl: this.gatewayUrl }, 'QQ gateway URL obtained');
  }

  /**
   * Connect to WebSocket gateway
   */
  private connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.gatewayUrl) {
        reject(new Error('No gateway URL'));
        return;
      }

      logger.debug(
        { gatewayUrl: this.gatewayUrl },
        'Connecting to QQ gateway...',
      );

      this.ws = new WebSocket(this.gatewayUrl);

      const timeout = setTimeout(() => {
        reject(new Error('QQ WebSocket connection timeout'));
      }, 30000);

      this.ws.addEventListener('open', () => {
        logger.debug('QQ WebSocket connected, waiting for HELLO...');
      });

      this.ws.addEventListener('message', (event: MessageEvent) => {
        this.handleWebSocketMessage(event.data.toString())
          .then(() => {
            // Resolve on first READY or RESUMED
            if (this.connected) {
              clearTimeout(timeout);
              resolve();
            }
          })
          .catch((err) => {
            logger.error({ err }, 'Error handling QQ WebSocket message');
          });
      });

      this.ws.addEventListener('close', (event) => {
        const e = event as unknown as { code: number; reason: string };
        logger.warn({ code: e.code, reason: e.reason }, 'QQ WebSocket closed');
        this.cleanup();
        // Attempt to reconnect after a delay
        setTimeout(() => {
          if (!this.connected) {
            this.connect().catch((err) => {
              logger.error({ err }, 'QQ reconnection failed');
            });
          }
        }, 5000);
      });

      this.ws.addEventListener('error', (event) => {
        const e = event as unknown as { error: Error };
        logger.error({ err: e.error }, 'QQ WebSocket error');
        clearTimeout(timeout);
        reject(e.error);
      });
    });
  }

  /**
   * Handle incoming WebSocket message
   */
  private async handleWebSocketMessage(rawData: string): Promise<void> {
    const payload: QQPayload = JSON.parse(rawData);
    logger.debug(
      { op: payload.op, t: payload.t },
      'QQ WebSocket message received',
    );

    switch (payload.op) {
      case Opcode.HELLO:
        // Start heartbeat and send IDENTIFY
        this.startHeartbeat(payload.d?.heartbeat_interval || 45000);

        if (this.sessionId) {
          // RESUME existing session
          this.send({
            op: Opcode.RESUME,
            d: {
              token: `QQBot ${this.accessToken}`,
              session_id: this.sessionId,
              seq: this.sequence,
            },
          });
        } else {
          // New session - IDENTIFY
          this.send({
            op: Opcode.IDENTIFY,
            d: {
              token: `QQBot ${this.accessToken}`,
              intents: Intents.USER_MESSAGE,
              shard: [0, 1],
            },
          });
        }
        break;

      case Opcode.HEARTBEAT_ACK:
        this.acked = true;
        break;

      case Opcode.INVALID_SESSION:
        logger.warn('QQ session invalid, will reconnect with new session');
        this.sessionId = '';
        this.sequence = null;
        break;

      case Opcode.RECONNECT:
        logger.warn('QQ server requested reconnect');
        this.ws?.close();
        break;

      case Opcode.DISPATCH:
        this.sequence = payload.s ?? null;
        await this.handleDispatch(payload);
        break;
    }
  }

  /**
   * Handle dispatch events
   */
  private async handleDispatch(payload: QQPayload): Promise<void> {
    const { t, d } = payload;

    if (t === 'READY') {
      this.sessionId = d?.session_id ?? '';
      this.connected = true;
      logger.info({ sessionId: this.sessionId }, 'QQ bot ready');
      // Flush queued messages
      await this.flushOutgoingQueue();
      return;
    }

    if (t === 'RESUMED') {
      this.connected = true;
      logger.info('QQ session resumed');
      await this.flushOutgoingQueue();
      return;
    }

    // Handle messages
    if (t === 'GROUP_AT_MESSAGE_CREATE' || t === 'C2C_MESSAGE_CREATE') {
      await this.handleMessage(t, d!);
    }
  }

  /**
   * Handle incoming message
   */
  private async handleMessage(
    eventType: string,
    data: NonNullable<QQPayload['d']>,
  ): Promise<void> {
    try {
      const isGroup = eventType === 'GROUP_AT_MESSAGE_CREATE';
      const messageId = data.id || '';
      const senderId = data.author?.id || data.user_openid || '';
      const content = data.content || '';
      const timestamp = data.timestamp || new Date().toISOString();

      // Build JID: qq:{group_openid} for group, qq:c2c:{user_openid} for direct
      const chatJid = isGroup
        ? `qq:${data.group_openid || data.group_id}`
        : `qq:c2c:${data.user_openid || senderId}`;

      logger.debug(
        {
          messageId,
          senderId,
          chatJid,
          isGroup,
          content: content.slice(0, 100),
        },
        'QQ message received',
      );

      if (!content.trim()) {
        logger.debug('QQ message has no content, skipping');
        return;
      }

      // Auto-register logic
      const groups = this.opts.factoryOpt.registeredGroups();
      if (!groups[chatJid] && this.opts.autoRegister !== false) {
        // Notify chat metadata
        this.opts.factoryOpt.onChatMetadata(
          chatJid,
          timestamp,
          isGroup ? data.group_openid : senderId,
          'qq',
          isGroup,
        );

        const safeId = chatJid.replace(/[:/]/g, '-');
        const folder = `${safeId}-group`;
        const name = isGroup
          ? `QQ群-${data.group_openid?.slice(0, 8)}`
          : `QQ私聊-${senderId.slice(0, 8)}`;

        const requiresTrigger = isGroup;
        // Auto register group
        this.opts.factoryOpt.autoRegisterGroup(
          chatJid,
          name,
          folder,
          requiresTrigger,
        );
      }

      // Deliver message if registered or auto-register enabled
      if (groups[chatJid] || this.opts.autoRegister !== false) {
        // Remove @ mentions from content for group messages
        let cleanContent = content;
        if (isGroup) {
          // Remove <@!bot_id> mentions
          cleanContent = content.replace(/<@!\d+>/g, '').trim();
        }

        const msg: NewMessage = {
          id: messageId || `qq-${Date.now()}`,
          chat_jid: chatJid,
          sender: senderId,
          sender_name: senderId,
          content: cleanContent,
          timestamp,
          is_from_me: false,
          is_bot_message: false,
        };

        this.opts.factoryOpt.onMessage(chatJid, msg);
      }
    } catch (err) {
      logger.error({ err, data }, 'Error handling QQ message');
    }
  }

  /**
   * Start heartbeat timer
   */
  private startHeartbeat(interval: number): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.acked = true; // Start with acked = true
    this.heartbeatTimer = setInterval(() => {
      if (!this.acked) {
        logger.warn('QQ heartbeat not acked, connection may be zombie');
        this.ws?.close();
        return;
      }

      this.send({
        op: Opcode.HEARTBEAT,
        d: this.sequence,
      });
      this.acked = false;
    }, interval);
  }

  /**
   * Send message to WebSocket
   */
  private send(data: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  /**
   * Cleanup on disconnect
   */
  private cleanup(): void {
    this.connected = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Clean internal thinking blocks
    let cleanText = text;
    const startTag = '<internal>';
    const endTag = '</internal>';
    let start = cleanText.indexOf(startTag);
    while (start !== -1) {
      const end = cleanText.indexOf(endTag, start);
      if (end === -1) break;
      cleanText =
        cleanText.slice(0, start) + cleanText.slice(end + endTag.length);
      start = cleanText.indexOf(startTag);
    }
    cleanText = cleanText.trim();

    if (!cleanText) {
      return;
    }

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: cleanText });
      logger.info(
        { jid, length: cleanText.length, queueSize: this.outgoingQueue.length },
        'QQ disconnected, message queued',
      );
      return;
    }

    try {
      await this.sendMessageToQQ(jid, cleanText);
      logger.info({ jid, length: cleanText.length }, 'QQ message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text: cleanText });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send QQ message, queued',
      );
    }
  }

  /**
   * Actually send message to QQ API
   */
  private async sendMessageToQQ(jid: string, text: string): Promise<void> {
    if (!this.accessToken) {
      throw new Error('No QQ access token');
    }

    const endpoint =
      this.opts.sandbox !== false
        ? 'https://sandbox.api.sgroup.qq.com'
        : 'https://api.sgroup.qq.com';

    // Parse JID to determine if group or C2C
    const isGroup = jid.startsWith('qq:') && !jid.startsWith('qq:c2c:');
    const isOpenId = jid.startsWith('qq:');
    const targetId = isOpenId
      ? jid.startsWith('qq:c2c:')
        ? jid.slice(7)
        : jid.slice(3)
      : jid;

    // Message sequence counter (required by QQ API)
    const msgSeq = Date.now() % 65536;

    // Split long messages (QQ has limit for markdown)
    const maxLength = 4500;
    const messages = this.splitMessage(text, maxLength);

    for (let i = 0; i < messages.length; i++) {
      const msgContent = messages[i];
      const seqNum = (msgSeq + i) % 65536;

      // Build message payload - proactive message (no msg_id since we don't track original)
      // msg_seq is required by QQ API
      const payload: {
        content?: string;
        msg_type: number;
        msg_seq: number;
        markdown?: { content: string };
      } = {
        msg_type: 2, // MARKDOWN type
        msg_seq: seqNum,
        markdown: {
          content: msgContent || ' ',
        },
      };

      const url = isGroup
        ? `${endpoint}/v2/groups/${targetId}/messages`
        : `${endpoint}/v2/users/${targetId}/messages`;

      logger.debug({ url, isGroup, targetId }, 'Sending QQ message');

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `QQBot ${this.accessToken}`,
          'X-Union-Appid': this.opts.appId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        // If markdown fails, try plain text
        if (response.status === 400 || response.status === 422) {
          logger.warn(
            { status: response.status, error: errorText },
            'QQ markdown message failed, trying plain text',
          );

          const plainPayload = {
            content: msgContent.replace(/\\/g, ''),
            msg_type: 0, // TEXT type
            msg_seq: seqNum,
          };

          const retryResponse = await fetch(url, {
            method: 'POST',
            headers: {
              Authorization: `QQBot ${this.accessToken}`,
              'X-Union-Appid': this.opts.appId,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(plainPayload),
          });

          if (!retryResponse.ok) {
            const retryError = await retryResponse.text();
            throw new Error(
              `QQ API error (plain text): ${retryResponse.status} ${retryError}`,
            );
          }

          logger.debug({ jid, index: i }, 'QQ plain text message sent');
          continue;
        }

        throw new Error(`QQ API error: ${response.status} ${errorText}`);
      }

      logger.debug(
        { jid, index: i, total: messages.length },
        'QQ markdown message sent',
      );

      // Small delay between messages to avoid rate limiting
      if (i < messages.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  /**
   * Split message into chunks respecting line breaks
   */
  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) {
      return [text];
    }

    const chunks: string[] = [];
    const lines = text.split('\n');
    let currentChunk = '';

    for (const line of lines) {
      if (currentChunk.length + line.length + 1 > maxLength) {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }
        // Handle very long single lines
        if (line.length > maxLength) {
          let remaining = line;
          while (remaining.length > maxLength) {
            chunks.push(remaining.slice(0, maxLength));
            remaining = remaining.slice(maxLength);
          }
          if (remaining) {
            currentChunk = remaining;
          }
        } else {
          currentChunk = line;
        }
      } else {
        currentChunk += (currentChunk ? '\n' : '') + line;
      }
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('qq:');
  }

  async disconnect(): Promise<void> {
    this.cleanup();
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    logger.info('QQ channel disconnected');
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing QQ outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        try {
          await this.sendMessageToQQ(item.jid, item.text);
          logger.info(
            { jid: item.jid, length: item.text.length },
            'Queued QQ message sent',
          );
        } catch (err) {
          this.outgoingQueue.unshift(item);
          logger.warn(
            { jid: item.jid, err },
            'Failed to send queued QQ message, will retry',
          );
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('qq', (opts: ChannelOpts) => {
  // 工厂函数里实现 QQ Channel对象创建
  const envVars = readEnvFile(['QQ_APPID', 'QQ_APPSEC']);
  const appId = process.env.QQ_APPID || envVars.QQ_APPID || '';
  const clientSecret = process.env.QQ_APPSEC || envVars.QQ_APPSEC || '';
  const qq_opts: QQChannelOpts = {
    factoryOpt: opts,
    appId: appId,
    clientSecret: clientSecret,
    sandbox: false,
    autoRegister: true,
  };
  logger.debug(qq_opts, 'Creating QQ Channel...');
  return new QQChannel(qq_opts);
});
