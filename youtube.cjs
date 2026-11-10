const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { existsSync } = require('node:fs');
const { mkdir, rename, rm, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

const hosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const toolsDirectory = join(__dirname, '.tools');
const executable = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const localExecutable = join(toolsDirectory, executable);

function youtubeId(url) {
  const host = url.hostname.replace(/\.$/, '');
  if (!hosts.has(host)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  let id;
  if (host === 'youtu.be' && parts.length === 1) id = parts[0];
  if (host !== 'youtu.be' && url.pathname === '/watch') id = url.searchParams.get('v');
  if (host !== 'youtu.be' && parts.length === 2 && ['shorts', 'live', 'embed'].includes(parts[0])) id = parts[1];
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) {
    throw new Error('請貼上單一 YouTube 影片連結，例如 https://youtu.be/影片ID。');
  }
  return id;
}

async function openYouTube(id, signal) {
  const binary = process.env.YTDLP_PATH || (existsSync(localExecutable) ? localExecutable : executable);
  const env = { ...process.env };
  delete env.DISCORD_TOKEN;
  const child = spawn(binary, [
    '--ignore-config', '--no-plugin-dirs', '--no-cache-dir', '--no-playlist',
    '--no-progress', '--socket-timeout', '10', '--retries', '1', '--extractor-retries', '1',
    '--no-js-runtimes', '--js-runtimes', `node:${process.execPath}`,
    '--match-filters', '!is_live & !is_upcoming',
    '-f', 'bestaudio[protocol=https]/best[protocol=https]', '-o', '-',
    '--', `https://www.youtube.com/watch?v=${id}`,
  ], { signal, env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });

  // The consumer also destroys stdout when playback stops or reaches its limit.
  child.stdout.once('close', () => {
    if (child.exitCode === null && !child.killed) child.kill();
  });
  child.on('error', () => child.stdout.destroy());
  try {
    await once(child, 'spawn', { signal });
  } catch (error) {
    if (error.code === 'ENOENT') {
      error.code = 'YTDLP_MISSING';
    }
    throw error;
  }
  return child.stdout;
}

async function install() {
  const linuxAsset = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime
    ? 'yt-dlp_musllinux' : 'yt-dlp_linux';
  const assets = {
    'win32-x64': 'yt-dlp.exe',
    'win32-arm64': 'yt-dlp_arm64.exe',
    'darwin-x64': 'yt-dlp_macos',
    'darwin-arm64': 'yt-dlp_macos',
    'linux-x64': linuxAsset,
    'linux-arm64': `${linuxAsset}_aarch64`,
  };
  const asset = assets[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error('請依 README 手動安裝適用於這台主機的 yt-dlp。');

  const base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
  async function download(name) {
    const response = await fetch(base + name, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`無法下載 ${name}（HTTP ${response.status}）。`);
    return response;
  }
  console.log(`正在下載並驗證官方 yt-dlp（${asset}）…`);
  const checksum = (await (await download('SHA2-256SUMS')).text())
    .split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .find(([, name]) => name === asset || name === `*${asset}`)?.[0];
  const binary = Buffer.from(await (await download(asset)).arrayBuffer());
  if (createHash('sha256').update(binary).digest('hex') !== checksum) {
    throw new Error('下載檔案與官方 SHA-256 不符，請稍後重試。');
  }
  await mkdir(toolsDirectory, { recursive: true });
  const temporary = join(toolsDirectory, randomUUID());
  try {
    await writeFile(temporary, binary, { flag: 'wx', mode: 0o755 });
    await rename(temporary, localExecutable);
  } finally {
    await rm(temporary, { force: true });
  }
  console.log('YouTube 播放工具安裝完成。');
}

if (require.main === module && process.argv.includes('--install')) {
  install().catch(error => {
    console.error(`安裝失敗：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { youtubeId, openYouTube };
