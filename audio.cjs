const { spawn, spawnSync } = require('node:child_process');
const { lookup } = require('node:dns');
const { once } = require('node:events');
const { get } = require('node:https');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const ipaddr = require('ipaddr.js');
const { createAudioResource, StreamType } = require('@discordjs/voice');
const { openYouTube } = require('./youtube.cjs');

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_SECONDS = 30 * 60;

function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    return require('ffmpeg-static') || 'ffmpeg';
  } catch {
    return 'ffmpeg';
  }
}

function checkFfmpeg() {
  const result = spawnSync(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=48000', '-t', '0.1',
    '-c:a', 'libopus', '-f', 'ogg', 'pipe:1',
  ], { windowsHide: true, timeout: 10_000 });
  if (result.status !== 0 || result.stdout?.subarray(0, 4).toString() !== 'OggS') {
    throw new Error('無法使用 FFmpeg 輸出 Opus。請安裝含 libopus 的 FFmpeg，並設定 FFMPEG_PATH。');
  }
}

function audioUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('請輸入有效的 YouTube 網址或 HTTPS 音檔直連。');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      ipaddr.isValid(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.')) {
    throw new Error('請使用公開的 YouTube 網址或 HTTPS 音檔直連。');
  }
  return url;
}

// Supply the checked address directly to the TLS socket so there is no second DNS lookup.
function publicLookup(hostname, options, callback) {
  lookup(hostname, { all: true, family: 4 }, (error, addresses) => {
    if (error) return callback(error);
    const entry = addresses.find(({ address }) => ipaddr.parse(address).range() === 'unicast');
    if (!entry) return callback(new Error('音檔網址必須指向公開的 IPv4 位址。'));
    if (options.all) return callback(null, [entry]);
    callback(null, entry.address, entry.family);
  });
}

async function openAudio(url, signal, redirects = 0) {
  const response = await new Promise((resolve, reject) => {
    const request = get(url, { lookup: publicLookup, signal, agent: false }, (incoming) => {
      request.setTimeout(0);
      resolve(incoming);
    });
    request.on('error', reject);
    request.setTimeout(15_000, () => request.destroy(new Error('音檔來源逾時。')));
  });

  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.destroy();
    if (redirects >= 4 || !response.headers.location) throw new Error('音檔網址重新導向失敗。');
    return openAudio(audioUrl(new URL(response.headers.location, url)), signal, redirects + 1);
  }
  if (response.statusCode !== 200 || /^text\/|^application\/(?:json|xhtml)/i.test(response.headers['content-type'] ?? '')) {
    response.destroy();
    throw new Error('來源沒有傳回可播放的音檔。請改用音檔附件或直連。');
  }
  if (Number(response.headers['content-length']) > MAX_BYTES) {
    response.destroy();
    throw new Error('單一音檔上限為 100 MB。');
  }
  return response;
}

async function playResource(track) {
  const { signal } = track.controller;
  const response = track.videoId
    ? await openYouTube(track.videoId, signal)
    : await openAudio(track.url, signal);
  const ffmpeg = spawn(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-map', '0:a:0',
    '-t', String(MAX_SECONDS), '-c:a', 'libopus', '-b:a', '96k',
    '-ar', '48000', '-ac', '2', '-f', 'ogg', 'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });

  let bytes = 0;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > MAX_BYTES ? new Error('單一音檔上限為 100 MB。') : null, chunk);
    },
  });
  const abort = () => {
    response.destroy();
    ffmpeg.kill();
  };
  const firstOutput = once(ffmpeg.stdout, 'readable', { signal });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();

  ffmpeg.on('error', () => {
    if (!signal.aborted) ffmpeg.stdout.destroy(new Error('無法啟動 FFmpeg。'));
  });
  ffmpeg.once('close', () => signal.removeEventListener('abort', abort));
  pipeline(response, limit, ffmpeg.stdin).catch((error) => {
    if (signal.aborted || ['EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code)) return;
    ffmpeg.stdout.destroy(error);
    ffmpeg.kill();
  });
  try {
    await firstOutput;
    if (!ffmpeg.stdout.readableLength) throw new Error('無法解碼音檔。');
    return createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus, metadata: track });
  } catch (error) {
    abort();
    throw error;
  }
}

module.exports = { audioUrl, checkFfmpeg, playResource };
