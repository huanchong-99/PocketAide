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

// 飞书卡片 markdown 组件不支持 GFM 表格(官方限制: 表格不在其支持语法列表内),
// 表格里的 | 会原样显示成字符(用户反馈"发过去的表格没法渲染, 监控项目却可以")。
// 监控项目能渲染正是用了飞书原生 table 组件(tag:table)。这里在构造卡片前把 GFM 表格
// 提取出来转成原生 table 组件, 其余文本仍走 markdown 组件——表格可正常渲染, 其它格式
// (粗体/列表/代码块/标题)完全不变。向后兼容: 无表格时输出与原 card() 逐字节一致。
function splitMarkdownByTables(md) {
  const out = [];
  const lines = String(md).split('\n');
  let textBuf = [];
  const flushText = () => {
    if (!textBuf.length) return;
    const t = textBuf.join('\n');
    textBuf = [];
    if (t.replace(/\s/g, '').length) out.push({ type: 'text', content: t });
  };
  // 一行像不像表格行: 含 | 且去首尾 | 后仍能切出 >=2 段
  const isTableRow = (l) => {
    const s = l.trim();
    if (!s.includes('|')) return false;
    const body = s.replace(/^\|+/, '').replace(/\|+$/, '');
    return body.split('|').length >= 2;
  };
  // 分隔行: | :--- | ---: | :--: |(每段是 -、左右可选冒号)
  const isSeparator = (l) => {
    const s = l.trim().replace(/^\|+/, '').replace(/\|+$/, '');
    if (!s.includes('-')) return false;
    return s.split('|').every((c) => /^:?-{1,}:?\s*$/.test(c.trim()));
  };
  const parseRow = (l) => {
    const s = l.trim().replace(/^\|+/, '').replace(/\|+$/, '');
    return s.split('|').map((c) => c.trim());
  };
  // 飞书 table 单元格不渲染 markdown, 转纯文本(去掉行内标记, 保留字面内容)
  const cellText = (c) => c
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // [txt](url) -> txt
    .replace(/\*\*(.+?)\*\*/g, '$1')           // **x** -> x
    .replace(/__(.+?)__/g, '$1')               // __x__ -> x
    .replace(/~~(.+?)~~/g, '$1')               // ~~x~~ -> x
    .replace(/`([^`]+)`/g, '$1')               // `x` -> x
    .replace(/\*([^*]+)\*/g, '$1')             // *x* -> x
    .trim();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isTableRow(line) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      flushText();
      const header = parseRow(line).map(cellText);
      const rows = [];
      let j = i + 2;                            // 跳过表头 + 分隔行
      while (j < lines.length && isTableRow(lines[j])) {
        const cells = parseRow(lines[j]).map(cellText);
        const row = {};
        header.forEach((_, idx) => { row['c' + idx] = cells[idx] !== undefined ? cells[idx] : ''; });
        rows.push(row);
        j++;
      }
      out.push({
        type: 'table',
        columns: header.map((_, idx) => ({ name: 'c' + idx, display_name: header[idx] || '', data_type: 'text' })),
        rows,
      });
      i = j;
    } else {
      textBuf.push(line);
      i++;
    }
  }
  flushText();
  return out;
}

function card(markdown, header) {
  const segs = splitMarkdownByTables(markdown);
  const elements = segs.length
    ? segs.map((seg) => (seg.type === 'table'
        ? { tag: 'table', columns: seg.columns, rows: seg.rows }
        : { tag: 'markdown', content: toFeishuMd(seg.content) }))
    : [{ tag: 'markdown', content: toFeishuMd(markdown) }];
  const c = {
    config: { wide_screen_mode: true },
    elements,
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
