import crypto from "node:crypto";

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

const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const CHANNEL_VERSION = "1.0.2";
const BOT_TYPE = "3";

interface WxChannelOpts {
  factoryOpt: ChannelOpts;
  token: string;
  accountId: string;
  userId: string;
}

interface WxMessage {
  msgId: string;
  chatId: string;
  senderId: string;
  senderName?: string;
  content: string;
  timestamp: string;
  isGroup?: boolean;
}

/** X-WECHAT-UIN: 随机 uint32 → 十进制字符串 → base64 */
function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token:string, body:any) {
  const headers: any = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (body !== undefined) {
    headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(body), "utf-8"));
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function apiPost(baseUrl:string, endpoint:string,  body:any, token:string, timeoutMs = 15_000) {
  const url = `${baseUrl.replace(/\/$/, "")}/${endpoint}`;
  const payload = { ...body, base_info: { channel_version: CHANNEL_VERSION } };
  const bodyStr = JSON.stringify(payload);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(token, payload),
      body: bodyStr,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return JSON.parse(text);
  } catch (err:any) {
    clearTimeout(timer);
    if (err.name === "AbortError") return null; // 长轮询超时，正常
    throw err;
  }
}

/** 从消息 item_list 提取纯文本 */
function extractText(msg: any) {
  for (const item of msg.item_list ?? []) {
    if (item.type === 1 && item.text_item?.text) return item.text_item.text;
    if (item.type === 3 && item.voice_item?.text) return `[语音] ${item.voice_item.text}`;
    if (item.type === 2) return "[图片]";
    if (item.type === 4) return `[文件] ${item.file_item?.file_name ?? ""}`;
    if (item.type === 5) return "[视频]";
  }
  return "[空消息]";
}

/** 发送文本消息 */
async function sendMessage(baseUrl:string, token:string, toUserId:string, text:string, contextToken:any) {
  const clientId = `demo-${crypto.randomUUID()}`;
  await apiPost(
    baseUrl,
    "ilink/bot/sendmessage",
    {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        context_token: contextToken,
        item_list: [
          { type: 1, text_item: { text } }, // TEXT
        ],
      },
    },
    token,
  );
  return clientId;
}

export class WxChannel implements Channel {
  name = 'WeChat';
  private opts: WxChannelOpts;
  private connected = false;
  private lastContentToken: string = "";

  constructor(opts: WxChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    try {
      this.connected = true;
      void this.pollMessagesLoop();

      logger.info('WeChat channel connected');
    } catch (err) {
      logger.error({ err }, 'Failed to connect WeChat channel');
      throw err;
    }
  }

  /** 长轮询获取新消息，返回 { msgs, get_updates_buf } */
  private async getUpdates(getUpdatesBuf: any) {
    const resp = await apiPost(
      ILINK_BASE_URL,
      "ilink/bot/getupdates",
      { get_updates_buf: getUpdatesBuf ?? "" },
      this.opts.token,
      38_000, // 长轮询，服务器最多 hold 35s
    );
    return resp ?? { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
  }

  private async pollMessagesLoop(): Promise<void> {
    if (!this.connected || !this.opts.token) return;
    logger.info("🚀 开始微信长轮询收消息...\n");

    let getUpdatesBuf:any = "";
    while (this.connected) {
      try {
        const resp = await this.getUpdates(getUpdatesBuf);
        // 更新 buf（服务器下发的游标，下次请求带上）
        if (resp.get_updates_buf) {
          getUpdatesBuf = resp.get_updates_buf;
        }

        for (const msg of resp.msgs ?? []) {
          // 只处理用户发来的消息（message_type=1）
          if (msg.message_type !== 1) continue;

          const from = msg.from_user_id;
          const text = extractText(msg);
          this.lastContentToken = msg.context_token;

          logger.info(`📩 [${new Date().toLocaleTimeString()}] 收到消息`);
          logger.info(`   From: ${from}`);
          logger.info(`   Text: ${text}`);

          await this.handleMessage(from, text);          
        }
      } catch (err:any) {
        if (err.message?.includes("session timeout") || err.message?.includes("-14")) {
          console.error("❌ Session 已过期，请重新登录: node demo.mjs --login");
          process.exit(1);
        }
        console.error(`⚠️  轮询出错: ${err.message}，3 秒后重试...`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  /**
   * 处理接收到的消息
   */
  private async handleMessage(userId:string, text:string): Promise<void> {
    try {
      const chatJid = `wechat:user:${userId}`;
      const timestamp = new Date().toISOString();

      // 检查是否已注册或需要自动注册
      const groups = this.opts.factoryOpt.registeredGroups();
      if (!groups[chatJid]) {
        this.opts.factoryOpt.onChatMetadata(
          chatJid,
          timestamp,
          undefined,
          'WeChat',
          false,
        );

        // 生成安全的目录名：替换特殊字符，去掉 @ 及其后面的内容
        const safeId = chatJid
          .replace(/[:/]/g, '-')
          .split('@')[0]
          .replace(/[^a-zA-Z0-9._-]/g, '');
        const folder = `${safeId}-group`;
        const name = `wx-c2c-${userId}`;

        this.opts.factoryOpt.autoRegisterGroup(
          chatJid,
          name,
          folder,
          false,
        );
      }

      const newMsg: NewMessage = {
        id: crypto.randomUUID(),
        chat_jid: chatJid,
        sender: userId,
        sender_name: "WxClaw",
        content: text,
        timestamp: timestamp,
        is_from_me: false,
        is_bot_message: false,
      };

      this.opts.factoryOpt.onMessage(chatJid, newMsg);
      logger.debug({userId}, 'WeChat message received');
    } catch (err) {
      logger.error({userId}, 'Error handling WeChat message');
    }
  }

  async sendMessage(chatJid: string, text: string): Promise<void> {
    if (!this.connected || !this.opts.token) {
      logger.warn('WeChat channel not connected, cannot send message');
      return;
    }

    // 从 chatJid (格式: wechat:user:${userId}) 提取 userId
    const prefix = 'wechat:user:';
    if (!chatJid.startsWith(prefix)) {
      logger.warn({ chatJid }, 'Invalid chatJid format for WeChat channel');
      return;
    }
    const userId = chatJid.slice(prefix.length);

    await sendMessage(ILINK_BASE_URL, this.opts.token, userId, text, this.lastContentToken);
    logger.debug({ userId }, 'WeChat message sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('wechat:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    logger.info('WeChat channel disconnected');
  }
}



registerChannel('WeChat', (opts: ChannelOpts) => {
  // 工厂函数里实现 WeChat Channel对象创建
  const envVars = readEnvFile(['WX_TOKEN', 'WX_ACCOUNT_ID', 'WX_USER_ID']);

  const token = process.env.WX_TOKEN || envVars.WX_TOKEN || '';
  const accountId = process.env.WX_ACCOUNT_ID || envVars.WX_ACCOUNT_ID || '';
  const userId = process.env.WX_USER_ID || envVars.WX_USER_ID || '';

  const wx_opts: WxChannelOpts = {
    factoryOpt: opts,
    token: token,
    accountId: accountId,
    userId: userId
  };
  logger.debug(wx_opts, 'Creating WeChat Channel...');
  return new WxChannel(wx_opts);
});
