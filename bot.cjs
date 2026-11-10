const { existsSync, writeFileSync } = require('node:fs');
const { createInterface } = require('node:readline/promises');
const { Writable } = require('node:stream');
const {
  ChannelType, Client, Events, GatewayIntentBits, MessageFlags,
  OAuth2Scopes, PermissionFlagsBits, SlashCommandBuilder,
} = require('discord.js');
const {
  AudioPlayerStatus, createAudioPlayer, entersState,
  joinVoiceChannel, NoSubscriberBehavior, VoiceConnectionStatus,
} = require('@discordjs/voice');
const { audioUrl, checkFfmpeg, playResource } = require('./audio.cjs');
const { youtubeId } = require('./youtube.cjs');

const command = new SlashCommandBuilder()
  .setName('music').setDescription('在語音頻道播放音樂')
  .addSubcommand(sub => sub.setName('play').setDescription('播放或加入佇列')
    .addStringOption(option => option.setName('url').setDescription('YouTube 影片連結或公開 HTTPS 音檔直連').setMaxLength(2000))
    .addAttachmentOption(option => option.setName('file').setDescription('上傳音檔，例如 MP3 或 WAV')))
  .addSubcommand(sub => sub.setName('queue').setDescription('查看播放佇列'))
  .addSubcommand(sub => sub.setName('pause').setDescription('暫停播放'))
  .addSubcommand(sub => sub.setName('resume').setDescription('繼續播放'))
  .addSubcommand(sub => sub.setName('skip').setDescription('跳到下一首'))
  .addSubcommand(sub => sub.setName('stop').setDescription('停止、清空佇列並離開語音頻道'))
  .toJSON();

const voicePermissions = [
  PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak,
];
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const sessions = new Map();

function reply(interaction, content, ephemeral = false) {
  return interaction.reply({
    content, allowedMentions: { parse: [] },
    ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
  });
}

function closeSession(session) {
  if (sessions.get(session.guildId) !== session) return;
  sessions.delete(session.guildId);
  session.pending.length = 0;
  session.current?.controller.abort();
  session.current = null;
  session.player.stop(true);
  if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) session.connection.destroy();
}

function finishTrack(session, track) {
  if (!track || session.current !== track) return;
  session.current = null;
  track.controller.abort();
  session.player.stop(true);
  void startNext(session);
}

async function notifyFailure(track, reason) {
  try {
    await track.receipt;
    await track.interaction.followUp({
      content: `無法播放「${track.title}」。${reason}`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  } catch {
    console.error('無法將播放失敗通知送回 Discord。');
  }
}

async function startNext(session) {
  if (session.current || sessions.get(session.guildId) !== session) return;
  const track = session.pending.shift();
  if (!track) return closeSession(session);
  session.current = track;
  try {
    await session.ready;
  } catch {
    if (session.current === track) {
      for (const waiting of [track, ...session.pending]) {
        void notifyFailure(waiting, '連不上語音頻道，請確認頻道權限和主機的網路連線。');
      }
      closeSession(session);
    }
    return;
  }
  if (session.current !== track) return;

  const openingTimeout = setTimeout(() => track.controller.abort(), track.videoId ? 45_000 : 25_000);
  try {
    const resource = await playResource(track);
    if (session.current === track) session.player.play(resource);
  } catch (error) {
    if (session.current !== track) return;
    let reason = '請確認音檔格式、大小與連結是否有效。';
    if (track.videoId) reason = '請確認影片公開且可播放。如果多部公開影片都失敗，請在主機重新執行 npm run setup:youtube。';
    if (error.code === 'YTDLP_MISSING') reason = '請先在主機執行 npm run setup:youtube，安裝影片播放工具。';
    if (error.name === 'AbortError') reason = '讀取來源逾時，請稍後重試。';
    void notifyFailure(track, reason);
    finishTrack(session, track);
  } finally {
    clearTimeout(openingTimeout);
  }
}

function openSession(guild, channel) {
  const connection = joinVoiceChannel({
    channelId: channel.id, guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator, selfDeaf: true,
  });
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  const session = {
    guildId: guild.id, channelId: channel.id, connection, player,
    pending: [], current: null,
    ready: entersState(connection, VoiceConnectionStatus.Ready, 20_000),
  };
  sessions.set(guild.id, session);
  connection.subscribe(player);
  player.on(AudioPlayerStatus.Idle, oldState => finishTrack(session, oldState.resource?.metadata));
  player.on('error', error => {
    const track = error.resource?.metadata;
    if (!track || session.current !== track) return;
    void notifyFailure(track, '音訊中斷或格式無法解碼。');
    // The voice library also transitions failed resources to Idle.
    queueMicrotask(() => finishTrack(session, track));
  });
  connection.on('error', () => console.error(`Discord 語音連線錯誤（伺服器 ${guild.id}）`));
  connection.on(VoiceConnectionStatus.Destroyed, () => closeSession(session));
  connection.on(VoiceConnectionStatus.Disconnected, () => {
    void entersState(connection, VoiceConnectionStatus.Ready, 15_000)
      .catch(() => closeSession(session));
  });
  return session;
}

async function handleCommand(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'music' || !interaction.guild) return;
  const { guild } = interaction;
  const subcommand = interaction.options.getSubcommand();
  let session = sessions.get(guild.id);

  if (subcommand === 'queue') {
    if (!session?.current) return reply(interaction, '目前沒有歌曲。');
    const waiting = session.pending.slice(0, 10).map((track, index) => `${index + 1}. ${track.title}`);
    if (session.pending.length > waiting.length) waiting.push(`另有 ${session.pending.length - waiting.length} 首。`);
    return reply(interaction, [`目前歌曲　${session.current.title}`, ...waiting].join('\n'));
  }

  const channel = guild.voiceStates.cache.get(interaction.user.id)?.channel;
  if (channel?.type !== ChannelType.GuildVoice) return reply(interaction, '請先加入一般語音頻道。', true);
  if (session && session.channelId !== channel.id) return reply(interaction, '請先加入機器人所在的語音頻道。', true);

  if (subcommand === 'play') {
    const file = interaction.options.getAttachment('file');
    const link = interaction.options.getString('url');
    if (Boolean(file) === Boolean(link)) return reply(interaction, '請貼上一個 YouTube 影片連結或音檔直連，也可上傳一個音檔。', true);
    if (file?.size > 100 * 1024 * 1024) return reply(interaction, '單一音檔上限為 100 MB。', true);
    if (!channel.permissionsFor(client.user)?.has(voicePermissions)) {
      return reply(interaction, '機器人需要這個頻道的「檢視頻道」、「連線」和「說話」權限。', true);
    }
    if (session?.pending.length >= 20) return reply(interaction, '佇列已滿，最多可等待 20 首。', true);
    let url;
    let videoId;
    try {
      url = audioUrl(file?.url ?? link);
      videoId = youtubeId(url);
    } catch (error) {
      return reply(interaction, error.message, true);
    }
    const title = (file?.name || (videoId && `YouTube · ${videoId}`) || url.pathname.split('/').at(-1) || url.hostname)
      .replace(/[\r\n]/g, ' ').slice(0, 120);
    session ??= openSession(guild, channel);
    const message = session.current ? `已加入佇列第 ${session.pending.length + 1} 首「${title}」。` : `準備播放「${title}」。`;
    const receipt = reply(interaction, message);
    session.pending.push({ url, videoId, title, interaction, receipt, controller: new AbortController() });
    void startNext(session);
    return receipt;
  }

  if (!session?.current) return reply(interaction, '目前沒有歌曲。', true);
  if (subcommand === 'stop') {
    closeSession(session);
    return reply(interaction, '已停止播放、清空佇列並離開語音頻道。');
  }
  if (subcommand === 'skip') {
    const { title } = session.current;
    finishTrack(session, session.current);
    return reply(interaction, `已跳過「${title}」。`);
  }
  if (subcommand === 'pause') {
    return reply(interaction, session.player.pause() ? '已暫停。' : '目前沒有可暫停的音訊。', true);
  }
  return reply(interaction, session.player.unpause() ? '已繼續播放。' : '目前沒有暫停的音訊。', true);
}

async function register(guild) {
  try {
    const existing = (await guild.commands.fetch()).find(entry => entry.name === command.name && entry.type === 1);
    if (!existing?.equals(command, true)) await guild.commands.create(command);
    console.log(`已就緒　${guild.name}（/music）`);
  } catch (error) {
    console.error(`無法在 ${guild.name} 註冊 /music（${error.code ?? error.name}）。請確認已授權 applications.commands。`);
  }
}

client.once(Events.ClientReady, async readyClient => {
  console.log(`已上線　${readyClient.user.tag}`);
  console.log('伺服器邀請連結');
  console.log(readyClient.generateInvite({
    scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
    permissions: voicePermissions,
  }));
  for (const guild of readyClient.guilds.cache.values()) await register(guild);
});
client.on(Events.GuildCreate, register);
client.on(Events.GuildDelete, guild => {
  const session = sessions.get(guild.id);
  if (session) closeSession(session);
});
client.on(Events.VoiceStateUpdate, (oldState, state) => {
  if (state.id !== client.user?.id) return;
  const session = sessions.get(state.guild.id);
  if (session && oldState.channelId === session.channelId && state.channelId !== session.channelId) {
    closeSession(session);
  }
});
client.on(Events.Error, error => console.error(`Discord 連線錯誤（${error.code ?? error.name}）`));
client.on(Events.InteractionCreate, interaction => {
  handleCommand(interaction).catch(async error => {
    console.error(`指令處理失敗（${error.code ?? error.name}）`);
    if (!interaction.replied && !interaction.deferred) {
      await reply(interaction, '指令執行失敗，請稍後再試。', true).catch(() => {});
    }
  });
});

async function loadToken() {
  if (process.env.DISCORD_TOKEN?.trim()) return process.env.DISCORD_TOKEN.trim();
  if (!process.stdin.isTTY || !process.stdout.isTTY || existsSync('.env')) {
    throw new Error('請在 .env 或主機的環境變數中設定 DISCORD_TOKEN。');
  }
  const silentOutput = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  silentOutput.isTTY = true;
  const input = createInterface({ input: process.stdin, output: silentOutput, terminal: true, historySize: 0 });
  input.on('SIGINT', () => process.exit(130));
  process.stdout.write('請貼上 Discord Bot Token（輸入時不顯示），然後按 Enter\n> ');
  try {
    const token = (await input.question('')).trim();
    process.stdout.write('\n');
    if (!/^[\w.-]+$/.test(token)) throw new Error('Token 格式無效，請重新執行 npm start。');
    await client.login(token);
    writeFileSync('.env', `DISCORD_TOKEN=${token}\n`, { flag: 'wx', mode: 0o600 });
    console.log('已將 Token 儲存在本機 .env。');
    return token;
  } finally {
    input.close();
  }
}

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  checkFfmpeg();
  if (process.argv.includes('--check')) {
    console.log('FFmpeg 已成功將測試音訊轉成 Ogg Opus。');
    return;
  }
  const token = await loadToken();
  if (!client.token) await client.login(token);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    for (const session of sessions.values()) closeSession(session);
    client.destroy();
  });
}

main().catch(error => {
  client.destroy();
  const message = error.code === 'TokenInvalid' || error.code === 4004
    ? 'Bot Token 無效。請從 Discord Developer Portal 的 Bot 頁面重新取得，並更新 .env。'
    : error instanceof Error && /^[\u3000-\u9fff]/.test(error.message)
      ? error.message
      : `啟動失敗（${error.code ?? error.name}），請確認網路及本機設定。`;
  console.error(message);
  process.exitCode = 1;
});
