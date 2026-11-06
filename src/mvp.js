'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus']);
const DEFAULT_MOOD = '默认';
const STATE_VERSION = 13;

const MOOD_RULES = [
  { mood: '紧张', words: ['危险', '追杀', '逃跑', '快跑', '小心', '冲突', '打架', '绑架', '枪', '杀', '来不及', '怎么办', '救命', '别过来', 'danger', 'chase', 'run away', 'hurry', 'hurry up', 'careful', 'kidnap', 'kidnapped', 'gun', 'kill', 'killed', 'fight', 'fighting', "we're running out of time", 'what do we do', "don't come", "i'm scared", "i'm afraid", 'please help', 'help me', 'get out of here', 'we have to go', "they're coming", "we're trapped"] },
  { mood: '愤怒', words: ['愤怒', '怒火', '压迫', '反派', '威胁', '逼迫', '仇恨', '报复', '受够了', '别逼我', '无法原谅', '你竟敢', '怎么敢', 'angry', 'rage', 'threat', 'threaten', 'pressure', 'revenge', 'hate', 'bully', 'bullying', 'slap', 'slapped', 'humiliate', 'cruel', 'cruelty', 'hit me', 'told us to get out', "i've had enough", 'unforgivable', 'how dare', "how could you", 'you betrayed me', 'you lied to me', 'leave me alone', 'you have no right', "it's your fault", "i can't believe you"] },
  { mood: '悬疑', words: ['秘密', '线索', '调查', '监控', '真相', '发现', '证据', '怀疑', '凶手', '跟踪', 'secret', 'clue', 'investigate', 'investigation', 'monitor', 'truth', 'evidence', 'suspect', 'killer', 'follow', 'rumor', 'rumour', "something's wrong", 'what happened', 'who did this', "what's going on", "it doesn't make sense", 'bad feeling', 'we need to find out'] },
  { mood: '爽感', words: ['打脸', '反击', '报复', '赢了', '闭嘴', '滚', '道歉', '胜利', '反转', 'fight back', 'hit back', 'shut up', 'get out', 'apologize', 'apology', 'winner', 'victory', 'stand up', 'dare', 'we did it', 'we won', 'i won', 'finally', 'you lose', 'in your face', 'you got what you deserved', "that's what you get"] },
  { mood: '欢快', words: ['开心', '高兴', '欢乐', '轻松', '活泼', '笑', '庆祝', '太好了', '好开心', '笑死', 'happy', 'cheerful', 'fun', 'laugh', 'laughing', 'celebrate', 'celebration', 'smile', "that's great", 'so happy', "i'm so happy", 'this is amazing', 'great news', "we're safe", 'we made it', 'good news', "can't stop laughing"] },
  { mood: '浪漫', words: ['爱', '喜欢', '恋爱', '浪漫', '心动', '告白', '吻', '婚礼', '想和你', '只爱你', '心里只有', 'love', 'loves', 'romance', 'romantic', 'kiss', 'wedding', 'marry', 'married', 'wife', 'husband', 'i love you', 'i want to be with', 'you are mine', 'you mean everything to me', 'you are my world', 'will you marry me'] },
  { mood: '励志', words: ['梦想', '努力', '坚持', '成长', '成功', '希望', '加油', '不能放弃', '一定要', '相信自己', 'dream', 'work hard', 'keep going', 'growth', 'success', 'successful', 'hope', 'courage', 'support', "won't give up", 'i can do', 'i can do this', 'we can do this', 'keep fighting', 'believe in yourself', 'you can do it', "we'll get through this"] },
  { mood: '伤感', words: ['伤心', '难过', '哭', '眼泪', '离开', '失去', '对不起', '遗憾', '心痛', '不想离开', '再也见不到', '无法挽回', 'sad', 'sadness', 'sorry', 'cry', 'crying', 'tears', 'leave', 'left', 'lost', 'loss', 'regret', 'heartbroken', 'pain', 'stay for a couple of days', 'find a place', "can't let go", 'never see again', "it's over", 'goodbye', 'i lost you', 'you left me', "i can't go on", 'nothing will ever be the same', 'i wish you were here'] },
  { mood: '温情', words: ['谢谢', '家人', '妈妈', '爸爸', '拥抱', '爱你', '温柔', '陪着', '回家', '有我在', '我陪你', '别怕', '辛苦了', 'thank', 'thanks', 'family', 'mother', 'mom', 'father', 'dad', 'grandpa', 'grandmother', 'hug', 'gentle', 'stay with', 'go home', 'care', 'will you still come', 'we will', 'neither of you is going anywhere', 'not making us leave', 'stuck with me', 'real home', 'eat up', "nobody's holding back", "i'm here", 'you are not alone', "i'm here for you", 'i forgive you', "it's okay", 'take care', "i'm proud of you", "we're family"] },
  { mood: '忧郁', words: ['阴暗', '神秘', '诡异', '沉重', '孤独', 'dark', 'strange', 'lonely', 'heavy', 'gloomy', 'mysterious', 'mystery', 'nothing matters', "what's the point", "i'm all alone", 'no one cares', "it's too late", 'i feel empty'] },
];

function usage() {
  return `用法:\n  node src/cli.js --videos <视频文件或目录> --music <BGM目录> --output <输出目录> [选项]\n\n选项:\n  --transcripts <目录>  读取与视频同名的 JSON 字幕时间段\n  --transcribe           调用 tools/transcribe.py + faster-whisper（需另行安装 Python/依赖）\n  --mood <标签>          覆盖自动情绪判断，必须匹配 BGM 子目录\n  --duck-db <-10>        对白时 BGM 增益，默认 -10\n  --freeze-tail <秒:帧>  片尾定格时长，定格期间不铺 BGM，默认 0:00\n  --fade-in <秒>         首部淡入，默认 2\n  --fade-out <秒>        尾部淡出，默认 2\n  --overwrite            明确允许覆盖已有输出\n  --ffmpeg <路径>        指定 ffmpeg 可执行文件\n  --ffprobe <路径>       指定 ffprobe 可执行文件\n  --help                 显示帮助\n\n输出文件: <集名>_final.<原视频扩展名>（原视频画面 + 原音 + BGM）、_bgm.wav、_timeline.csv、_transcript.json。\nBGM 目录约定:\n  BGM/悬疑/*.mp3   BGM/紧张/*.wav   BGM/默认/*.mp3\n  也支持直接放在 BGM/ 根目录，根目录曲目视为“默认”。`;
}

function parseArgs(argv) {
  const options = {
    videos: null,
    music: null,
    output: null,
    transcripts: null,
    transcribe: false,
    mood: null,
    autoDuck: false,
    duckDb: -10,
    freezeTail: '0:00',
    fadeIn: 2,
    fadeOut: 2,
    overwrite: false,
    ffmpeg: process.env.FFMPEG || 'ffmpeg',
    ffprobe: process.env.FFPROBE || 'ffprobe',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--transcribe' || arg === '--overwrite' || arg === '--auto-duck') {
      options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`无法识别参数: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
    if (!(key in options)) throw new Error(`无法识别参数: ${arg}`);
    if (['duckDb', 'fadeIn', 'fadeOut'].includes(key)) {
      options[key] = Number(value);
      if (!Number.isFinite(options[key]) || options[key] < 0 && key !== 'duckDb') {
        throw new Error(`${arg} 必须是有效数字`);
      }
    } else {
      options[key] = value;
    }
  }

  for (const key of ['videos', 'music', 'output']) {
    if (!options[key]) throw new Error(`缺少必填参数 --${key}`);
  }
  if (options.duckDb > 0) throw new Error('--duck-db 应为 0 或负数');
  if (!/^\d+:\d+$/.test(options.freezeTail)) throw new Error('--freeze-tail 格式应为 秒:帧，例如 2:15');
  return options;
}

function naturalCompare(a, b) {
  return new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' }).compare(a, b);
}

function normalizeMood(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function normalizePath(value) {
  return path.resolve(value);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function listTopLevelFiles(inputPath, extensions) {
  const stat = await fs.stat(inputPath);
  if (stat.isFile()) {
    if (!extensions.has(path.extname(inputPath).toLowerCase())) {
      throw new Error(`不支持的文件类型: ${inputPath}`);
    }
    return [normalizePath(inputPath)];
  }
  const entries = await fs.readdir(inputPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(inputPath, entry.name))
    .sort((a, b) => naturalCompare(path.basename(a), path.basename(b)));
}

async function scanVideos(inputPath) {
  const files = await listTopLevelFiles(inputPath, VIDEO_EXTENSIONS);
  if (!files.length) throw new Error(`没有找到支持的视频文件: ${inputPath}`);
  return files;
}

async function scanMusic(musicDir) {
  const stat = await fs.stat(musicDir);
  if (!stat.isDirectory()) throw new Error('BGM 参数必须是目录: ' + musicDir);

  const groups = new Map();
  const rootEntries = await fs.readdir(musicDir, { withFileTypes: true });
  const rootTracks = rootEntries
    .filter((entry) => entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(musicDir, entry.name));
  if (rootTracks.length) groups.set(DEFAULT_MOOD, rootTracks);

  for (const entry of rootEntries.filter((item) => item.isDirectory())) {
    const moodDir = path.join(musicDir, entry.name);
    const tracks = (await fs.readdir(moodDir, { withFileTypes: true }))
      .filter((item) => item.isFile() && AUDIO_EXTENSIONS.has(path.extname(item.name).toLowerCase()))
      .map((item) => path.join(moodDir, item.name));
    if (tracks.length) groups.set(entry.name, [...(groups.get(entry.name) || []), ...tracks]);
  }

  for (const tracks of groups.values()) tracks.sort((a, b) => naturalCompare(path.basename(a), path.basename(b)));
  if (!groups.size) throw new Error('BGM 目录没有找到音频文件: ' + musicDir);
  return groups;
}
async function runProcess(command, args, { cwd, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(signal ? { signal } : {}) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => reject(Object.assign(error, { command, args })));
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const error = new Error(`${command} 退出码 ${code}: ${stderr.trim() || stdout.trim()}`);
      error.code = code;
      error.command = command;
      error.args = args;
      reject(error);
    });
  });
}

async function probeMedia(filePath, ffprobe, signal) {
  const { stdout } = await runProcess(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,codec_name,sample_rate,channels,avg_frame_rate,r_frame_rate',
    '-of', 'json',
    filePath,
  ], { signal });
  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new Error('ffprobe 返回了无效 JSON: ' + filePath);
  }
  const duration = Number(info.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取有效时长: ' + filePath);
  const streams = Array.isArray(info.streams) ? info.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const frameRate = [video?.avg_frame_rate, video?.r_frame_rate].map((value) => {
    const [numerator, denominator = '1'] = String(value || '').split('/').map(Number);
    const rate = numerator / denominator;
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  }).find(Boolean) || null;
  return {
    duration,
    frameRate,
    streams,
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
    hasVideo: streams.some((stream) => stream.codec_type === 'video'),
  };
}
async function inspectMusicCatalog(groups, ffprobe, ffmpeg, signal, state) {
  const files = [...groups.values()].flatMap((tracks) => tracks);
  const checked = new Map();
  let cursor = 0;
  let skipped = 0;
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
    while (cursor < files.length) {
      const file = files[cursor++];
      const filePath = normalizePath(file);
      const stat = await fs.stat(file);
      const fingerprint = 'sample5s-v1:' + stat.size + ':' + stat.mtimeMs;
      let playable = state.musicCatalog[filePath]?.fingerprint === fingerprint
        ? state.musicCatalog[filePath].playable
        : null;
      if (playable === null) {
        try {
          const info = await probeMedia(file, ffprobe, signal);
          if (info.hasAudio) {
            const sampleDuration = Math.min(5, info.duration);
            const sampleStart = Math.max(0, (info.duration - sampleDuration) / 2);
            const { stderr } = await runProcess(ffmpeg, [
              '-hide_banner', '-nostats', '-ss', formatNumber(sampleStart), '-i', file,
              '-t', formatNumber(sampleDuration), '-af', 'volumedetect', '-f', 'null', '-',
            ], { signal });
            const mean = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
            const peak = stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
            playable = Boolean(mean && peak && Number.isFinite(Number(mean[1])) && Number(mean[1]) > -90 && Number.isFinite(Number(peak[1])));
          } else {
            playable = false;
          }
        } catch (error) {
          if (signal?.aborted || error.code === 'ENOENT') throw error;
          playable = false;
        }
        state.musicCatalog[filePath] = { fingerprint, playable };
      }
      checked.set(file, playable);
      if (!playable) skipped += 1;
    }
  }));
  const usableGroups = new Map([...groups].flatMap(([mood, tracks]) => {
    const usable = tracks.filter((file) => checked.get(file));
    return usable.length ? [[mood, usable]] : [];
  }));
  if (!usableGroups.size) throw new Error('背景音乐目录中没有可用的非静音音轨，已检查 ' + files.length + ' 首并跳过 ' + skipped + ' 首');
  return { groups: usableGroups, checked: files.length, skipped };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function freezeTailDuration(value, frameRate) {
  const match = /^(\d+):(\d+)$/.exec(String(value || '0:00').trim());
  if (!match) throw new Error('片尾定格时长格式应为 秒:帧，例如 2:15');
  const seconds = Number(match[1]);
  const frames = Number(match[2]);
  if (!frames) return seconds;
  if (!frameRate) throw new Error('视频帧率不可读，无法按帧设置片尾定格时长');
  if (frames >= Math.ceil(frameRate)) throw new Error(`片尾帧数必须小于视频帧率（约 ${Math.ceil(frameRate)} 帧/秒）`);
  return seconds + frames / frameRate;
}

function normalizeTranscript(raw, duration) {
  const source = Array.isArray(raw) ? raw : raw?.segments;
  if (!Array.isArray(source)) throw new Error('字幕 JSON 必须是数组，或包含 segments 数组');
  return source
    .map((segment) => ({
      start: Number(segment.start),
      end: Number(segment.end),
      text: String(segment.text || '').trim(),
    }))
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
    .map((segment) => ({
      start: clamp(segment.start, 0, duration),
      end: clamp(segment.end, 0, duration),
      text: segment.text,
    }))
    .filter((segment) => segment.end > segment.start)
    .sort((a, b) => a.start - b.start);
}

async function findTranscript(videoPath, transcriptDir, duration) {
  if (!transcriptDir) return null;
  const stem = path.parse(videoPath).name;
  const candidates = [
    path.join(transcriptDir, `${stem}.json`),
    path.join(transcriptDir, `${stem}.transcript.json`),
  ];
  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) continue;
    const raw = JSON.parse(await fs.readFile(candidate, 'utf8'));
    return { path: candidate, segments: normalizeTranscript(raw, duration), source: 'sidecar' };
  }
  return null;
}

async function runTranscriber(videoPath, outputPath, options) {
  const venvPython = path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe');
  const python = process.env.PYTHON || (await pathExists(venvPython) ? venvPython : 'python');
  const script = options.transcriberScript || path.resolve(__dirname, '..', 'tools', 'transcribe.py');
  if (options.transcriberExecutable && !(await pathExists(options.transcriberExecutable))) {
    throw new Error(`内置转录组件不存在：${options.transcriberExecutable}`);
  }
  const model = options.modelPath || process.env.FASTER_WHISPER_MODEL || 'small';
  const language = options.language || process.env.FASTER_WHISPER_LANGUAGE || 'auto';
  const args = ['--input', videoPath, '--output', outputPath, '--model', model, '--language', language, '--device', 'cpu', '--compute-type', 'int8'];
  await runProcess(options.transcriberExecutable || python, options.transcriberExecutable ? args : [script, ...args], { signal: options.signal });
  const raw = JSON.parse(await fs.readFile(outputPath, 'utf8'));
  const probe = await probeMedia(videoPath, options.ffprobe, options.signal);
  return { path: outputPath, segments: normalizeTranscript(raw, probe.duration), source: raw.provider || 'sidecar', language: raw.language, languageProbability: raw.language_probability };
}

function mergeIntervals(segments, duration, padding = 0.12) {
  const intervals = segments
    .map((segment) => ({ start: clamp(segment.start - padding, 0, duration), end: clamp(segment.end + padding, 0, duration) }))
    .filter((segment) => segment.end > segment.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const interval of intervals) {
    const previous = merged[merged.length - 1];
    if (!previous || interval.start > previous.end) merged.push({ ...interval });
    else previous.end = Math.max(previous.end, interval.end);
  }
  return merged;
}

function findMoodFolder(mood, groups) {
  const wanted = normalizeMood(mood);
  if (!wanted) return null;
  const names = [...groups.keys()];
  const exact = names.find((name) => normalizeMood(name) === wanted);
  if (exact) return exact;

  const aliases = {
    紧张: ['紧张', '激烈', '冲突'],
    愤怒: ['愤怒', '压迫', '反派'],
    悬疑: ['悬疑', '忧郁', '阴暗', '神秘'],
    爽感: ['爽感', '爽', '打脸', '酷感', '放克'],
    欢快: ['欢快', '活泼', '轻松'],
    浪漫: ['浪漫', '爱情', '温柔'],
    励志: ['励志', '成长', '希望'],
    伤感: ['伤感', '悲伤', '悲情', '失落', '离别'],
    温情: ['温情', '治愈', '平静', '陪伴', '温柔'],
    默认: ['默认', 'default', '平静', '治愈'],
  };
  const candidates = [mood, ...(aliases[mood] || [])].map(normalizeMood).filter(Boolean);
  for (const candidate of candidates) {
    const match = names.find((name) => normalizeMood(name).includes(candidate));
    if (match) return match;
  }
  return null;
}

const NEGATION_PATTERN = /(?:不|没|未|别|无|不是|从不|从没|never|not|no|don't|didn't|won't)\s*$/i;
const WEAK_ENGLISH_CUES = new Set(['mom', 'mother', 'dad', 'father', 'family', 'wife', 'husband', 'love', 'happy', 'sad', 'sorry', 'thank', 'thanks', 'care', 'home']);

function moodWordHits(text, rule) {
  const searchableText = String(text || '').toLowerCase();
  return rule.words.filter((word) => {
    const keyword = word.toLowerCase();
    let match;
    if (/^[a-z ]+$/.test(keyword)) {
      const phrase = keyword.replace(/ +/g, '\\s+');
      match = new RegExp(`\\b${phrase}\\b`).exec(searchableText);
    } else {
      const index = searchableText.indexOf(keyword);
      match = index < 0 ? null : { index };
    }
    if (!match) return false;
    return !NEGATION_PATTERN.test(searchableText.slice(Math.max(0, match.index - 8), match.index));
  });
}

function moodCandidates(text, groups) {
  return MOOD_RULES.map((rule) => {
    const hits = moodWordHits(text, rule);
    const usableHits = hits.length === 1 && WEAK_ENGLISH_CUES.has(hits[0]) ? [] : hits;
    const phraseHits = usableHits.filter((hit) => hit.length >= 3 || hit.includes(' ')).length;
    return { mood: findMoodFolder(rule.mood, groups), hits: usableHits, score: usableHits.length + phraseHits * 0.25 };
  }).filter((result) => result.mood && result.score > 0).sort((a, b) => b.score - a.score || b.hits.length - a.hits.length);
}

function inferMood(transcript, groups, override) {
  if (override) {
    const folder = findMoodFolder(override, groups);
    if (!folder) throw new Error(`找不到指定情绪目录“${override}”，已有目录: ${[...groups.keys()].join(', ')}`);
    return { mood: folder, reason: `人工覆盖: ${override}` };
  }

  const text = (transcript?.segments || []).map((segment) => segment.text).join(' ');
  const hits = moodCandidates(text, groups);
  if (hits.length) return { mood: hits[0].mood, reason: `对白情绪线索: ${hits[0].hits.join('、')}` };
  const fallback = findMoodFolder(DEFAULT_MOOD, groups) || [...groups.keys()][0];
  return { mood: fallback, reason: text ? '未命中情绪关键词，使用回退曲目' : '无转录内容，使用回退曲目' };
}

function chooseTrack(groups, mood, trackUses, episodeTracks) {
  const allTracks = [...new Set([...groups.values()].flat())];
  const unused = allTracks.filter((track) => !episodeTracks.has(track));
  const preferred = (groups.get(mood) || []).filter((track) => !episodeTracks.has(track));
  const candidates = preferred.length ? preferred : unused;
  if (!candidates.length) throw new Error('没有可用于新配乐片段的不同曲目');
  return [...candidates].sort((a, b) => {
    const useDiff = (trackUses.get(a) || 0) - (trackUses.get(b) || 0);
    return useDiff || naturalCompare(path.basename(a), path.basename(b));
  })[0];
}

const MIN_MULTI_TRACK_DURATION = 45;
const DEFAULT_TRANSITION_FADE_SECONDS = 1;

function classifyMoodText(text, groups) {
  const result = moodCandidates(text, groups)[0];
  if (result) return { mood: result.mood, hits: result.hits };
  return { mood: null, hits: [] };
}

// 字幕通常只有句段起止时间；按标点和转折词按字数分配时间，避免整句同时命中多个情绪时丢掉变化。
function splitTranscriptSegment(segment) {
  const text = String(segment.text || '').trim();
  const matches = [...text.matchAll(/[。！？!?；;]+|(?:，|,)\s*(?=(?:(?:但是|可是|不过|然而|没想到|却|但)(?![a-zA-Z])|(?:but|however|yet|though|although|instead)\b))|\s+(?=(?:but|however|yet|though|although|instead)\b)/gi)];
  if (!text || !matches.length) return [segment];
  const clauses = [];
  let cursor = 0;
  for (const match of matches) {
    const clause = text.slice(cursor, match.index).trim();
    if (clause) clauses.push(clause);
    cursor = match.index + match[0].length;
  }
  const tail = text.slice(cursor).trim();
  if (tail) clauses.push(tail);
  if (clauses.length < 2) return [segment];
  const start = Number(segment.start) || 0;
  const end = Number(segment.end) || start;
  const total = clauses.reduce((sum, clause) => sum + clause.length, 0);
  let offset = start;
  return clauses.map((clause, index) => {
    const next = index === clauses.length - 1 ? end : offset + (end - start) * clause.length / total;
    const item = { ...segment, start: offset, end: next, text: clause };
    offset = next;
    return item;
  });
}

function pickSectionMood(moodRuns, start, end, fallbackMood) {
  const scores = new Map();
  for (const run of moodRuns) {
    const overlap = Math.max(0, Math.min(end, run.end) - Math.max(start, run.start));
    if (!overlap) continue;
    const score = (run.hitCount || run.segmentCount) * (1 + overlap);
    scores.set(run.mood, (scores.get(run.mood) || 0) + score);
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || fallbackMood;
}

const MIN_MOOD_RUN_SECONDS = 3;
const MIN_MOOD_RUN_HITS = 2;

function collectMoodRuns(classified) {
  const runs = [];
  for (const item of classified.filter((segment) => segment.mood).sort((a, b) => a.start - b.start)) {
    const current = runs.at(-1);
    if (current?.mood === item.mood) {
      current.end = Math.max(current.end, item.end);
      current.hitCount += item.hits.length;
      current.segmentCount += 1;
    } else {
      runs.push({ mood: item.mood, start: item.start, end: item.end, hitCount: item.hits.length, segmentCount: 1 });
    }
  }

  const stableRuns = runs.filter((run) => run.end - run.start >= MIN_MOOD_RUN_SECONDS || run.segmentCount >= 2 || run.hitCount >= MIN_MOOD_RUN_HITS);
  return stableRuns.reduce((merged, run) => {
    const previous = merged.at(-1);
    if (previous?.mood === run.mood) {
      previous.end = Math.max(previous.end, run.end);
      previous.hitCount += run.hitCount;
      previous.segmentCount += run.segmentCount;
    } else {
      merged.push({ ...run });
    }
    return merged;
  }, []);
}

function sectionReason(classified, start, end, options) {
  const words = [...new Set(classified
    .filter((item) => Math.min(end, item.end) > Math.max(start, item.start))
    .flatMap((item) => item.hits))].slice(0, 4);
  if (words.length) return '片段对白关键词: ' + words.join('、');
  if (options.mood) return '人工覆盖: ' + options.mood;
  return '未检测到明确情绪关键词，使用默认情绪';
}

function buildMusicPlan({ duration, transcript, groups, options, trackUses }) {
  const availableTracks = new Set([...groups.values()].flat()).size;
  const requestedSegmentLimit = Number(options.maxTracksPerEpisode ?? 3);
  const configuredSegmentLimit = Number.isSafeInteger(requestedSegmentLimit) && requestedSegmentLimit >= 0 ? requestedSegmentLimit : 3;
  const maxSegments = Math.min(configuredSegmentLimit > 0 ? configuredSegmentLimit : availableTracks, availableTracks);
  const requestedMinimum = Number(options.minTracksPerEpisode ?? 1);
  const minimumSegments = Number.isSafeInteger(requestedMinimum) && requestedMinimum >= 1 ? requestedMinimum : 1;
  if (minimumSegments > maxSegments) throw new Error(`可用的不同 BGM 曲目只有 ${maxSegments} 首，无法达到每集最低 ${minimumSegments} 段`);
  const episodeTracks = new Set();
  const baseMood = inferMood(transcript, groups, options.mood);
  const rawSegments = transcript?.segments || [];
  const classified = rawSegments.flatMap(splitTranscriptSegment).map((segment) => options.mood
    ? { ...segment, mood: baseMood.mood, hits: [] }
    : { ...segment, ...classifyMoodText(segment.text, groups) });
  const moodRuns = collectMoodRuns(classified);
  const candidates = [];
  for (let index = 1; index < moodRuns.length; index += 1) {
    const previous = moodRuns[index - 1];
    const current = moodRuns[index];
    if (previous.mood === current.mood) continue;
    candidates.push({
      boundary: clamp((previous.end + current.start) / 2, 0, duration),
      score: previous.hitCount + current.hitCount + Math.min(current.end - current.start, 30) / 30,
    });
  }
  const minimumSegmentDuration = Math.min(12, duration / Math.max(1, maxSegments));
  const boundaries = [];
  for (const candidate of candidates.sort((a, b) => b.score - a.score || a.boundary - b.boundary)) {
    if (boundaries.length >= maxSegments - 1) break;
    if (candidate.boundary < minimumSegmentDuration || duration - candidate.boundary < minimumSegmentDuration) continue;
    if (boundaries.some((boundary) => Math.abs(boundary - candidate.boundary) < minimumSegmentDuration)) continue;
    boundaries.push(candidate.boundary);
  }
  boundaries.sort((a, b) => a - b);
  const points = [0, ...boundaries, duration];
  const ranges = points.slice(1).map((end, index) => [points[index], end]);
  const segments = ranges.map(([start, end]) => {
    const mood = pickSectionMood(moodRuns, start, end, baseMood.mood);
    const track = chooseTrack(groups, mood, trackUses, episodeTracks);
    episodeTracks.add(track);
    trackUses.set(track, (trackUses.get(track) || 0) + 1);
    return {
      start,
      end,
      mood,
      reason: start > 0
        ? '台词情绪转折；' + sectionReason(classified, start, end, options)
        : sectionReason(classified, start, end, options),
      track,
    };
  });
  return { baseMood, segments };
}

function clipIntervals(intervals, start, end) {
  return intervals
    .map((interval) => ({ start: Math.max(start, interval.start), end: Math.min(end, interval.end) }))
    .filter((interval) => interval.end > interval.start);
}

function buildDuckExpression(intervals, duckDb) {
  const duckVolume = formatNumber(Math.pow(10, duckDb / 20));
  return intervals.reduceRight((next, interval) => {
    const start = formatNumber(interval.start);
    const end = formatNumber(interval.end);
    const fade = Math.min(0.12, Math.max(0.001, (interval.end - interval.start) / 2));
    const downEnd = Math.min(interval.end, interval.start + fade);
    const upStart = Math.max(interval.start, interval.end - fade);
    const current = 'if(lt(t,' + formatNumber(downEnd) + '),1-(1-' + duckVolume + ')*(t-' + start + ')/' + formatNumber(fade) +
      ',if(lt(t,' + formatNumber(upStart) + '),' + duckVolume +
      ',if(lt(t,' + end + '),' + duckVolume + '+(1-' + duckVolume + ')*(t-' + formatNumber(upStart) + ')/' + formatNumber(fade) + ',1)))';
    return 'if(between(t,' + start + ',' + end + '),' + current + ',' + next + ')';
  }, '1');
}

function transitionFadeSeconds(options) {
  const requested = Number(options?.transitionFadeDuration);
  return Number.isFinite(requested) ? Math.max(0, requested) : DEFAULT_TRANSITION_FADE_SECONDS;
}

function buildMultiTrackFilter(segments, duration, options, intervals, hasDialogue = true) {
  const shortest = Math.min(...segments.map((segment) => segment.end - segment.start));
  const crossfade = segments.length > 1 && options.transitionFadeEnabled !== false
    ? Math.min(transitionFadeSeconds(options), shortest / 2)
    : 0;
  const graph = [];
  segments.forEach((segment, index) => {
    const renderStart = index === 0 ? 0 : Math.max(0, segment.start - crossfade / 2);
    const renderEnd = index === segments.length - 1 ? duration : Math.min(duration, segment.end + crossfade / 2);
    const renderDuration = renderEnd - renderStart;
    const localIntervals = clipIntervals(intervals, renderStart, renderEnd)
      .map((interval) => ({ start: interval.start - renderStart, end: interval.end - renderStart }));
    const filters = [
      'atrim=start=0:duration=' + formatNumber(renderDuration),
      'asetpts=PTS-STARTPTS',
      'aresample=48000',
      'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
    ];
    const fadeIn = index === 0 ? clamp(Number(options.fadeIn) || 0, 0, renderDuration) : Math.min(crossfade, renderDuration);
    const fadeOut = index === segments.length - 1 ? clamp(Number(options.fadeOut) || 0, 0, renderDuration) : Math.min(crossfade, renderDuration);
    if (options.autoDuck && localIntervals.length && options.duckDb < 0) {
      filters.push("volume=volume='" + buildDuckExpression(localIntervals, options.duckDb) + "':eval=frame");
    }
    filters.push('loudnorm=I=' + (hasDialogue ? -28 : -18) + ':TP=-1.5:LRA=11:print_format=none');
    filters.push('aresample=48000');
    filters.push('aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo');
    filters.push('asetpts=N/SR/TB');
    if (fadeIn > 0) filters.push('afade=t=in:st=0:d=' + formatNumber(fadeIn));
    if (fadeOut > 0) filters.push('afade=t=out:st=' + formatNumber(Math.max(0, renderDuration - fadeOut)) + ':d=' + formatNumber(fadeOut));
    if (renderStart > 0) filters.push('adelay=' + Math.round(renderStart * 1000) + ':all=1');
    graph.push('[' + index + ':a]' + filters.join(',') + '[seg' + index + ']');
  });
  graph.push(segments.map((_, index) => '[seg' + index + ']').join('') +
    'amix=inputs=' + segments.length + ':duration=longest:dropout_transition=0:normalize=0,' +
    'atrim=start=0:duration=' + formatNumber(duration) + ',asetpts=PTS-STARTPTS,alimiter=limit=0.891:level=0:latency=1,' +
    'aresample=48000,asetpts=N/SR/TB[aout]');
  return graph.join(';');
}

function formatNumber(value) {
  return Number(value.toFixed(3)).toString();
}

function buildAudioFilter(duration, options, intervals) {
  const filters = [];
  const fadeIn = clamp(Number(options.fadeIn) || 0, 0, duration);
  const fadeOut = clamp(Number(options.fadeOut) || 0, 0, duration);
  if (fadeIn > 0) filters.push('afade=t=in:st=0:d=' + formatNumber(fadeIn));
  if (fadeOut > 0) filters.push('afade=t=out:st=' + formatNumber(Math.max(0, duration - fadeOut)) + ':d=' + formatNumber(fadeOut));
  if (options.autoDuck && intervals.length && options.duckDb < 0) {
    const duckVolume = formatNumber(Math.pow(10, options.duckDb / 20));
    const expressions = intervals.map(({ start, end }) => {
      const fade = Math.min(0.12, Math.max(0.001, (end - start) / 2));
      const downEnd = Math.min(end, start + fade);
      const upStart = Math.max(start, end - fade);
      return 'if(lt(t,' + formatNumber(downEnd) + '),1-(1-' + duckVolume + ')*(t-' + formatNumber(start) + ')/' + formatNumber(fade) +
        ',if(lt(t,' + formatNumber(upStart) + '),' + duckVolume +
        ',if(lt(t,' + formatNumber(end) + '),' + duckVolume + '+(1-' + duckVolume + ')*(t-' + formatNumber(upStart) + ')/' + formatNumber(fade) + ',1)))';
    });
    const expression = expressions.reduceRight((next, current, index) =>
      'if(between(t,' + formatNumber(intervals[index].start) + ',' + formatNumber(intervals[index].end) + '),' + current + ',' + next + ')', '1');
    filters.push("volume=volume='" + expression + "':eval=frame");
  }
  filters.push('alimiter=limit=0.891:level=0:latency=1');
  return filters.join(',');
}
function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function timelineCsv({ episode, segments, options, intervals, freezeTailSeconds }) {
  const headers = ['episode', 'segment', 'start_sec', 'end_sec', 'bgm_file', 'mood', 'selection_reason', 'fade_in_sec', 'fade_out_sec', 'duck_db', 'duck_segments', 'freeze_tail', 'freeze_tail_sec'];
  const rows = segments.map((segment, index) => [
    episode,
    index + 1,
    formatNumber(segment.start),
    formatNumber(segment.end),
    path.relative(options.music, segment.track),
    segment.mood,
    segment.reason,
    formatNumber(options.fadeIn),
    formatNumber(options.fadeOut),
    formatNumber(options.autoDuck ? options.duckDb : 0),
    JSON.stringify(options.autoDuck ? clipIntervals(intervals, segment.start, segment.end).map((interval) => ({
      start: Number(formatNumber(interval.start)),
      end: Number(formatNumber(interval.end)),
    })) : []),
    options.freezeTail || '0:00',
    formatNumber(freezeTailSeconds),
  ]);
  return [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n') + '\n';
}

async function readState(statePath) {
  if (!(await pathExists(statePath))) return { version: STATE_VERSION, episodes: {}, trackUses: {}, musicCatalog: {} };
  try {
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    return {
      version: STATE_VERSION,
      episodes: state.episodes && typeof state.episodes === 'object' ? state.episodes : {},
      trackUses: state.trackUses && typeof state.trackUses === 'object' ? state.trackUses : {},
      musicCatalog: state.musicCatalog && typeof state.musicCatalog === 'object' ? state.musicCatalog : {},
    };
  } catch {
    throw new Error(`状态文件损坏，请备份后删除再重跑: ${statePath}`);
  }
}

async function writeState(statePath, state) {
  const tempPath = `${statePath}.part`;
  await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, statePath);
}

function finalAudioFormat(videoPath) {
  const extension = path.extname(videoPath).toLowerCase();
  if (extension === '.webm') return ['libopus', '128k'];
  if (extension === '.avi') return ['libmp3lame', '192k'];
  return ['aac', '192k'];
}

function buildFinalMixFilter(hasOriginalAudio) {
  const stereo = 'aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
  const limiter = 'alimiter=limit=0.891:level=0:latency=1';
  if (!hasOriginalAudio) return '[1:a:0]' + stereo + ',' + limiter + '[aout]';
  return '[0:a:0]' + stereo + '[dialogue];[1:a:0]' + stereo + '[bgm];' +
    '[dialogue][bgm]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,' + limiter + '[aout]';
}

async function renderFinalVideo(videoPath, bgmPath, outputPath, probe, options) {
  const extension = path.extname(videoPath).toLowerCase();
  const [audioCodec, audioBitrate] = finalAudioFormat(videoPath);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath, '-i', bgmPath,
    '-filter_complex', buildFinalMixFilter(probe.hasAudio), '-map', '0:v:0', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', audioCodec, '-b:a', audioBitrate, '-ar', '48000', '-ac', '2',
    '-t', formatNumber(probe.duration)];
  if (['.mp4', '.m4v', '.mov'].includes(extension)) args.push('-movflags', '+faststart');
  args.push(outputPath);
  await runProcess(options.ffmpeg, args, { signal: options.signal });
}

async function finalVideoIsValid(outputPath, duration, ffprobe, ffmpeg, signal) {
  if (!(await pathExists(outputPath))) return false;
  try {
    const info = await probeMedia(outputPath, ffprobe, signal);
    if (!info.hasVideo || !info.hasAudio || Math.abs(info.duration - duration) > 0.2) return false;
    await runProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', outputPath, '-f', 'null', '-'], { signal });
    return true;
  } catch {
    return false;
  }
}

async function outputIsValid(outputPath, duration, ffprobe, ffmpeg, signal) {
  if (!(await pathExists(outputPath))) return false;
  try {
    const info = await probeMedia(outputPath, ffprobe, signal);
    const audio = info.streams.find((stream) => stream.codec_type === 'audio');
    if (!audio || audio.codec_name !== 'pcm_s16le' || Number(audio.sample_rate) !== 48000 || Number(audio.channels) !== 2 || Math.abs(info.duration - duration) > 0.05) return false;
    const { stderr } = await runProcess(ffmpeg, ['-hide_banner', '-nostats', '-i', outputPath, '-af', 'volumedetect', '-f', 'null', '-'], { signal });
    const peak = stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
    const mean = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
    // shortcut: treat mean levels at or below -70 dB as silence; if ultra-quiet BGM is supported, make this configurable.
    return Boolean(peak && mean && Number.isFinite(Number(peak[1])) && Number.isFinite(Number(mean[1])) && Number(peak[1]) <= -0.9 && Number(mean[1]) > -70);
  } catch {
    return false;
  }
}

async function removeIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function renderEpisode({ videoPath, outputDir, groups, state, options, catalogSignature }) {
  const episode = path.parse(videoPath).name;
  const outputPath = path.join(outputDir, episode + '_bgm.wav');
  const timelinePath = path.join(outputDir, episode + '_timeline.csv');
  const finalVideoPath = path.join(outputDir, episode + '_final' + (path.extname(videoPath).toLowerCase() || '.mp4'));
  const tempFinalVideoPath = path.join(outputDir, episode + '_final.part' + (path.extname(videoPath).toLowerCase() || '.mp4'));
  const asrTranscriptPath = path.join(outputDir, episode + '_transcript.json');
  const tempTranscriptOutputPath = asrTranscriptPath + '.part';
  const stateKey = normalizePath(videoPath);
  const sourceStat = await fs.stat(videoPath);
  const existing = state.episodes[stateKey];
  const tempTranscriptPath = path.join(outputDir, '.tmp-' + episode + '-' + process.pid + '.transcript.json');
  const tempOutputPath = outputPath + '.part.wav';
  const tempTimelinePath = timelinePath + '.part';
  const selectedOutputs = {
    outputAudio: options.outputAudio !== false,
    outputVideo: options.outputVideo !== false,
    outputTimeline: options.outputTimeline !== false,
    outputTranscript: options.outputTranscript !== false,
  };
  const needsAudio = selectedOutputs.outputAudio || selectedOutputs.outputVideo;



  try {
    const probe = await probeMedia(videoPath, options.ffprobe, options.signal);
    if (!probe.hasVideo) throw new Error('输入没有视频流: ' + videoPath);
    const freezeTailSeconds = freezeTailDuration(options.freezeTail, probe.frameRate);
    if (freezeTailSeconds >= probe.duration) throw new Error('片尾定格时长必须小于视频总时长');
    const musicDuration = probe.duration - freezeTailSeconds;
    const transcript = await findTranscript(videoPath, options.transcripts, probe.duration);
    const transcriptStat = transcript ? await fs.stat(transcript.path) : null;
    const transcriptRequired = Boolean(options.transcribe && probe.hasAudio);
    const ownsAsrTranscript = existing?.transcriptPath === asrTranscriptPath;
    const transcriptionModel = options.transcribe ? (options.modelPath || process.env.FASTER_WHISPER_MODEL || 'small') : null;
    const transcriptionLanguage = options.transcribe ? (options.language || process.env.FASTER_WHISPER_LANGUAGE || 'auto') : null;
    const signature = createHash('sha256').update(JSON.stringify({
      version: STATE_VERSION,
      finalVideo: true,
      sourceSize: sourceStat.size,
      sourceMtimeMs: sourceStat.mtimeMs,
      catalogSignature,
      mood: options.mood,
      minTracksPerEpisode: options.minTracksPerEpisode,
      transcribe: options.transcribe,
      transcriptionModel,
      transcriptionLanguage,
      transcript: transcriptStat && [transcript.path, transcriptStat.size, transcriptStat.mtimeMs],
      duckDb: options.duckDb,
      autoDuck: options.autoDuck,
      freezeTail: options.freezeTail || '0:00',
      maxTracksPerEpisode: options.maxTracksPerEpisode > 0 ? options.maxTracksPerEpisode : undefined,
      fadeIn: options.fadeIn,
      fadeOut: options.fadeOut,
      transitionFadeEnabled: options.transitionFadeEnabled !== false,
      transitionFadeDuration: transitionFadeSeconds(options),
    })).digest('hex');

    if (!options.overwrite && selectedOutputs.outputTranscript && transcriptRequired && await pathExists(asrTranscriptPath) && !ownsAsrTranscript) {
      throw new Error('转录输出已存在，拒绝覆盖非本程序创建的文件: ' + asrTranscriptPath);
    }

    const transcriptOutputValid = !selectedOutputs.outputTranscript || !transcriptRequired || (ownsAsrTranscript && await pathExists(asrTranscriptPath));
    if (!options.overwrite && existing?.status === 'completed' && existing.signature === signature &&
      (!selectedOutputs.outputAudio || (existing.outputPath === outputPath && await outputIsValid(outputPath, musicDuration, options.ffprobe, options.ffmpeg, options.signal))) &&
      (!selectedOutputs.outputVideo || (existing.finalVideoPath === finalVideoPath && await finalVideoIsValid(finalVideoPath, probe.duration, options.ffprobe, options.ffmpeg, options.signal))) &&
      (!selectedOutputs.outputTimeline || (existing.timelinePath === timelinePath && await pathExists(timelinePath))) && transcriptOutputValid) {
      state.episodes[stateKey] = {
        ...existing, episode, status: 'completed', videoPath, ...selectedOutputs,
        outputPath: selectedOutputs.outputAudio ? outputPath : existing.outputPath || '',
        finalVideoPath: selectedOutputs.outputVideo ? finalVideoPath : existing.finalVideoPath || '',
        timelinePath: selectedOutputs.outputTimeline ? timelinePath : existing.timelinePath || '',
        transcriptPath: selectedOutputs.outputTranscript ? existing.transcriptPath || (transcriptRequired ? asrTranscriptPath : '') : existing.transcriptPath || '',
        transcribe: Boolean(options.transcribe),
      };
      await writeState(path.join(outputDir, '.mvp-state.json'), state);
      return {
        status: 'skipped', episode,
        outputPath: selectedOutputs.outputAudio ? outputPath : '',
        finalVideoPath: selectedOutputs.outputVideo ? finalVideoPath : '',
        timelinePath: selectedOutputs.outputTimeline ? timelinePath : '',
        transcriptPath: selectedOutputs.outputTranscript && transcriptRequired ? asrTranscriptPath : undefined,
        ...selectedOutputs, duration: probe.duration,
      };
    }

    const ownsOutput = existing?.outputPath === outputPath;
    const ownsTimeline = existing?.timelinePath === timelinePath;
    const ownsFinalVideo = existing?.finalVideoPath === finalVideoPath;
    const outputExists = selectedOutputs.outputAudio && await pathExists(outputPath);
    const timelineExists = selectedOutputs.outputTimeline && await pathExists(timelinePath);
    const finalVideoExists = selectedOutputs.outputVideo && await pathExists(finalVideoPath);
    if (!options.overwrite && (outputExists && !ownsOutput || timelineExists && !ownsTimeline || finalVideoExists && !ownsFinalVideo)) {
      throw new Error('输出已存在，若要覆盖请加 --overwrite: ' + episode);
    }

    state.episodes[stateKey] = {
      ...existing, episode, status: 'processing', signature, sourceSize: sourceStat.size, sourceMtimeMs: sourceStat.mtimeMs,
      videoPath, ...selectedOutputs,
      outputPath: selectedOutputs.outputAudio ? outputPath : existing?.outputPath || '',
      finalVideoPath: selectedOutputs.outputVideo ? finalVideoPath : existing?.finalVideoPath || '',
      timelinePath: selectedOutputs.outputTimeline ? timelinePath : existing?.timelinePath || '',
      transcriptPath: selectedOutputs.outputTranscript ? existing?.transcriptPath || (transcriptRequired ? asrTranscriptPath : '') : existing?.transcriptPath || '',
      transcribe: Boolean(options.transcribe), updatedAt: new Date().toISOString(),
    };
    await writeState(path.join(outputDir, '.mvp-state.json'), state);



    let activeTranscript = transcript;
    if (!activeTranscript && options.transcribe && probe.hasAudio) {
      activeTranscript = await runTranscriber(videoPath, tempTranscriptPath, options);
    }

    const intervals = mergeIntervals(activeTranscript?.segments || [], probe.duration);
    const musicPlan = buildMusicPlan({
      duration: musicDuration,
      transcript: activeTranscript,
      groups,
      options,
      trackUses: new Map(Object.entries(state.trackUses)),
    });
    const filter = buildMultiTrackFilter(musicPlan.segments, musicDuration, options, intervals, probe.hasAudio);

    await removeIfExists(tempOutputPath);
    await removeIfExists(tempFinalVideoPath);
    await removeIfExists(tempTimelinePath);
    if (needsAudio) {
      const ffmpegArgs = ['-hide_banner', '-loglevel', 'error', '-y'];
      for (const segment of musicPlan.segments) ffmpegArgs.push('-stream_loop', '-1', '-i', segment.track);
      ffmpegArgs.push(
        '-filter_complex', filter,
        '-map', '[aout]',
        '-t', formatNumber(musicDuration),
        '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le',
        tempOutputPath,
      );
      await runProcess(options.ffmpeg, ffmpegArgs, { signal: options.signal });
      if (!(await outputIsValid(tempOutputPath, musicDuration, options.ffprobe, options.ffmpeg, options.signal))) throw new Error('输出 WAV 校验失败');
    }
    if (selectedOutputs.outputVideo) {
      await renderFinalVideo(videoPath, tempOutputPath, tempFinalVideoPath, probe, options);
      if (!(await finalVideoIsValid(tempFinalVideoPath, probe.duration, options.ffprobe, options.ffmpeg, options.signal))) throw new Error('最终成片校验失败');
    }
    if (selectedOutputs.outputTimeline) {
      const csv = timelineCsv({ episode, segments: musicPlan.segments, options, intervals, freezeTailSeconds });
      await fs.writeFile(tempTimelinePath, '\uFEFF' + csv, 'utf8');
    }
    if (selectedOutputs.outputAudio) await fs.rename(tempOutputPath, outputPath);
    if (selectedOutputs.outputVideo) await fs.rename(tempFinalVideoPath, finalVideoPath);
    if (selectedOutputs.outputTimeline) await fs.rename(tempTimelinePath, timelinePath);
    const saveTranscript = Boolean(selectedOutputs.outputTranscript && options.transcribe && activeTranscript);
    if (saveTranscript) {
      const savedTranscript = {
        source: activeTranscript.source,
        ...(activeTranscript.language ? { language: activeTranscript.language, language_probability: activeTranscript.languageProbability } : {}),
        segments: activeTranscript.segments,
      };
      await fs.writeFile(tempTranscriptOutputPath, JSON.stringify(savedTranscript, null, 2) + '\n', 'utf8');
      await fs.rename(tempTranscriptOutputPath, asrTranscriptPath);
    }

    for (const segment of musicPlan.segments) state.trackUses[segment.track] = (state.trackUses[segment.track] || 0) + 1;
    const moods = musicPlan.segments.map((segment) => segment.mood);
    const tracks = musicPlan.segments.map((segment) => segment.track);
    state.episodes[stateKey] = {
      ...state.episodes[stateKey], status: 'completed', signature, sourceSize: sourceStat.size, sourceMtimeMs: sourceStat.mtimeMs,
      episode, videoPath, ...selectedOutputs,
      outputPath: selectedOutputs.outputAudio ? outputPath : existing?.outputPath || '',
      finalVideoPath: selectedOutputs.outputVideo ? finalVideoPath : existing?.finalVideoPath || '',
      timelinePath: selectedOutputs.outputTimeline ? timelinePath : existing?.timelinePath || '',
      transcriptPath: saveTranscript ? asrTranscriptPath : existing?.transcriptPath || '',
      duration: probe.duration, mood: moods.join(' → '), moods, track: tracks[0], tracks,
      transcriptSource: activeTranscript?.source || 'none', transcribe: Boolean(options.transcribe), duckSegments: intervals.length, segments: musicPlan.segments.length,
      updatedAt: new Date().toISOString(),
    };
    await writeState(path.join(outputDir, '.mvp-state.json'), state);
    return {
      status: 'completed', episode,
      outputPath: selectedOutputs.outputAudio ? outputPath : '',
      finalVideoPath: selectedOutputs.outputVideo ? finalVideoPath : '',
      timelinePath: selectedOutputs.outputTimeline ? timelinePath : '',
      transcriptPath: saveTranscript ? asrTranscriptPath : undefined,
      ...selectedOutputs, duration: probe.duration, mood: moods.join(' → '), moods, tracks,
    };

  } catch (error) {
    await removeIfExists(tempOutputPath);
    await removeIfExists(tempFinalVideoPath);
    await removeIfExists(tempTimelinePath);
    const interrupted = options.signal?.aborted || error.name === 'AbortError' || error.code === 'ABORT_ERR';
    state.episodes[stateKey] = {
      ...state.episodes[stateKey], status: interrupted ? 'interrupted' : 'failed', sourceSize: sourceStat.size, sourceMtimeMs: sourceStat.mtimeMs,
      error: interrupted ? '用户中断' : error.message, updatedAt: new Date().toISOString(),
    };
    await writeState(path.join(outputDir, '.mvp-state.json'), state);
    throw error;
  } finally {
    await removeIfExists(tempOutputPath);
    await removeIfExists(tempTranscriptPath);
    await removeIfExists(tempTranscriptOutputPath);
  }
}
async function runBatch(options, logger = console) {
  const videosPath = normalizePath(options.videos);
  const musicPath = normalizePath(options.music);
  const outputPath = normalizePath(options.output);
  options.videos = videosPath;
  options.music = musicPath;
  options.output = outputPath;
  await ensureDirectory(outputPath);
  if (options.signal?.aborted) throw Object.assign(new Error('用户中断'), { name: 'AbortError', code: 'ABORT_ERR' });
  const [videos, scannedGroups] = await Promise.all([scanVideos(videosPath), scanMusic(musicPath)]);
  const statePath = path.join(outputPath, '.mvp-state.json');
  const state = await readState(statePath);
  const inspected = await inspectMusicCatalog(scannedGroups, options.ffprobe, options.ffmpeg, options.signal, state);
  const groups = inspected.groups;
  await writeState(statePath, state);
  logger.progress?.({ stage: 'scanned', total: videos.length, videosPath, musicPath, outputPath });
  const seenNames = new Set();
  for (const video of videos) {
    const key = path.parse(video).name.toLowerCase();
    if (seenNames.has(key)) throw new Error('视频文件名重复，无法安全生成同名输出: ' + path.basename(video));
    seenNames.add(key);
  }
  const catalogRows = await Promise.all([...scannedGroups.values()].flat().map(async (file) => {
    const stat = await fs.stat(file);
    return [normalizePath(file), stat.size, stat.mtimeMs];
  }));
  const catalogSignature = createHash('sha256').update(JSON.stringify(catalogRows)).digest('hex');
  const results = [];
  logger.log('背景音乐检查完成：可用 ' + (inspected.checked - inspected.skipped) + ' 首，跳过无法解码或近似静音的 ' + inspected.skipped + ' 首');
  logger.log('视频 ' + videos.length + ' 集，BGM ' + [...groups.entries()].map(([mood, tracks]) => mood + ':' + tracks.length).join(' / '));

  for (let index = 0; index < videos.length; index += 1) {
    const videoPath = videos[index];
    const progress = { index: index + 1, total: videos.length, episode: path.parse(videoPath).name, videoPath };
    logger.progress?.({ ...progress, status: 'processing' });
    logger.log('[' + (index + 1) + '/' + videos.length + '] ' + path.basename(videoPath));
    try {
      const result = await renderEpisode({ videoPath, outputDir: outputPath, groups, state, options, catalogSignature });
      results.push(result);
      logger.progress?.({ ...progress, ...result });
      logger.log('  ' + result.status + ': ' + result.outputPath);
    } catch (error) {
      const interrupted = options.signal?.aborted || error.name === 'AbortError' || error.code === 'ABORT_ERR';
      const result = { status: interrupted ? 'interrupted' : 'failed', episode: path.parse(videoPath).name, error: interrupted ? '用户中断' : error.message };
      results.push(result);
      logger.progress?.({ ...progress, ...result });
      logger.error('  ' + (interrupted ? 'interrupted' : 'failed') + ': ' + result.error);
      if (interrupted) break;
    }
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    videos: videos.length,
    completed: results.filter((item) => item.status === 'completed').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    failed: results.filter((item) => item.status === 'failed').length,
    interrupted: results.filter((item) => item.status === 'interrupted').length,
    results,
  };
  await fs.writeFile(path.join(outputPath, 'run-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  logger.progress?.({ stage: 'finished', summary });
  return summary;
}
module.exports = {
  AUDIO_EXTENSIONS,
  DEFAULT_TRANSITION_FADE_SECONDS,
  VIDEO_EXTENSIONS,
  buildAudioFilter,
  buildMusicPlan,
  buildMultiTrackFilter,
  findMoodFolder,
  freezeTailDuration,
  inferMood,
  mergeIntervals,
  normalizeTranscript,
  parseArgs,
  runBatch,
  scanMusic,
  scanVideos,
  usage,
};




