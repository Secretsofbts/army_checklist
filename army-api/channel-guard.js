// Сторож канала: банит тех, кто вышел.
// Отдельный бот (не путать с BOT_TOKEN чек-листа).
// Запускается только если заданы GUARD_BOT_TOKEN и CHANNEL_ID.

function startChannelGuard() {
  const token = String(process.env.GUARD_BOT_TOKEN || process.env.CHANNEL_GUARD_BOT_TOKEN || '').trim();
  const channelId = String(process.env.CHANNEL_ID || '').trim();

  if (!token || !channelId) {
    console.log('Channel guard: выключен (нет GUARD_BOT_TOKEN или CHANNEL_ID)');
    return null;
  }

  if (token === String(process.env.BOT_TOKEN || '').trim()) {
    console.error('Channel guard: GUARD_BOT_TOKEN не должен совпадать с BOT_TOKEN чек-листа');
    return null;
  }

  let Bot;
  try {
    Bot = require('grammy').Bot;
  } catch (e) {
    console.error('Channel guard: не установлен grammy', e.message || e);
    return null;
  }

  const bot = new Bot(token);

  bot.on('chat_member', async function (ctx) {
    try {
      const update = ctx.chatMember;
      if (!update) return;
      const chatId = String(update.chat && update.chat.id);
      if (chatId !== String(channelId)) return;

      const oldStatus = update.old_chat_member && update.old_chat_member.status;
      const newStatus = update.new_chat_member && update.new_chat_member.status;
      const user = update.new_chat_member && update.new_chat_member.user;
      if (!user || user.is_bot) return;

      if (oldStatus === 'member' && (newStatus === 'left' || newStatus === 'kicked')) {
        try {
          await ctx.api.banChatMember(channelId, user.id);
          console.log('Channel guard: заблокирован', user.id, user.first_name || '');
        } catch (err) {
          console.error('Channel guard: не удалось заблокировать', user.id, err.message || err);
        }
      }
    } catch (e) {
      console.error('Channel guard: ошибка обработки', e.message || e);
    }
  });

  bot.catch(function (err) {
    console.error('Channel guard: bot error', err.error || err);
  });

  bot.start({
    allowed_updates: ['chat_member'],
    onStart: function () {
      console.log('Channel guard: запущен, канал', channelId);
    }
  }).catch(function (e) {
    console.error('Channel guard: не запустился', e.message || e);
  });

  return bot;
}

module.exports = { startChannelGuard };
