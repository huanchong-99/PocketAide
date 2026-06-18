// Feishu (Lark) wrapper: long-connection event receiving + interactive card send/update.
// Uses @larksuiteoapi/node-sdk WSClient (no public webhook URL needed).
const lark = require('@larksuiteoapi/node-sdk');

// Feishu's `markdown` element renders only a SUBSET of markdown: bold/italic/
// strikethrough/links/lists/fenced-code-blocks render, but ATX headings (#) and
// inline code (backticks) do NOT. Downgrade those to bold so structure/emphasis
// still reads, while protecting fenced code blocks (which DO render) from rewrite.
function toFeishuMd(md) {
  if (!md) return md;
  const blocks = [];
  let s = String(md).replace(/```[\s\S]*?```/g, (m) => {
    blocks.push(m);
    return ' <<CB' + (blocks.length - 1) + '>> ';
  });
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, '**$1**'); // headings -> bold
  s = s.replace(/`([^`\n]+)`/g, '**$1**');                                  // inline code -> bold
  s = s.replace(/ <<CB(\d+)>> /g, (_, i) => blocks[Number(i)]);             // restore code blocks
  return s;
}

function card(markdown, header) {
  const c = {
    config: { wide_screen_mode: true },
    elements: [{ tag: 'markdown', content: toFeishuMd(markdown) }],
  };
  if (header) c.header = { title: { tag: 'plain_text', content: header } };
  return c;
}

// Pull plain text out of an im.message.receive_v1 payload, stripping @-mention markers.
function extractText(message) {
  try {
    if (message.message_type !== 'text') return null;
    const obj = JSON.parse(message.content);
    return String(obj.text || '').replace(/@_user_\d+/g, '').trim();
  } catch (_) {
    return null;
  }
}

// 取出 image 消息的 image_key（下载图片要用）。非 image 类型返回 null。
function extractImage(message) {
  try {
    if (message.message_type !== 'image') return null;
    const obj = JSON.parse(message.content);
    return obj.image_key || null;
  } catch (_) {
    return null;
  }
}

class Feishu {
  constructor({ appId, appSecret }) {
    this.client = new lark.Client({
      appId, appSecret, appType: lark.AppType.SelfBuild, domain: lark.Domain.Feishu,
    });
    this.wsClient = new lark.WSClient({ appId, appSecret, domain: lark.Domain.Feishu });
  }

  // onMessage(data) where data is the im.message.receive_v1 event body.
  start(onMessage) {
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try { await onMessage(data); } catch (e) { console.error('[feishu] handler error:', e.message); }
      },
    });
    this.wsClient.start({ eventDispatcher: dispatcher });
  }

  async sendCard(openId, markdown, header) {
    const res = await this.client.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: openId, msg_type: 'interactive', content: JSON.stringify(card(markdown, header)) },
    });
    return res && res.data && res.data.message_id;
  }

  async updateCard(messageId, markdown, header) {
    await this.client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card(markdown, header)) },
    });
  }

  // Send a plain text bubble (not a card); returns message_id. For lightweight "send then recall" pings.
  async sendText(openId, text) {
    const res = await this.client.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text }) },
    });
    return res && res.data && res.data.message_id;
  }

  // Recall (withdraw) a message sent by this bot. Only valid within 24h of sending; throws on failure.
  async recallMessage(messageId) {
    await this.client.im.message.delete({ path: { message_id: messageId } });
  }

  // 下载消息中的图片资源到 destPath（绝对路径）。需应用开"读取消息中的资源文件"权限，失败抛错。
  async downloadImage(messageId, imageKey, destPath) {
    const res = await this.client.im.messageResource.get({
      params: { type: 'image' },
      path: { message_id: messageId, file_key: imageKey },
    });
    await res.writeFile(destPath);   // SDK 自带：流直接落盘
    return destPath;
  }
}

module.exports = { Feishu, extractText, extractImage, card, toFeishuMd };
