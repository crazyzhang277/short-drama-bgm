'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ANALYSIS_VERSION, ANALYSIS_SETTINGS, MODEL_SHA256, analyzeTrack, cachePath, filterLibrary, fingerprint, readLibrary, writeLibrary, reviewTrack, summarizeFrames, trackStatus } = require('../src/music-library');
const { buildMusicPlan, inferMood, normalizeTranscript, parseSceneCandidates, runBatch } = require('../src/mvp');

const groups = new Map([['默认', ['neutral.wav']], ['浪漫', ['romance.wav']], ['愤怒', ['angry.wav']], ['紧张', ['tense.wav']]]);
const frames = (seconds, vocalScore = 0, label = 'Singing') => Array.from({ length: Math.ceil(seconds / 0.975) }, (_, index) => ({ time: index * 0.975, categories: [{ label: 'Music', score: 0.95 }, { label, score: vocalScore }] }));

test('short explicit emotion survives planning; contractions, topic words and polite fear do not create false moods', () => {
  const choices = new Map([...groups, ['爽感', ['win.wav']], ['欢快', ['happy.wav']], ['伤感', ['sad.wav']]]);
  const infer = (text) => inferMood({ segments: [{ start: 1, end: 2.5, text }] }, choices);
  assert.equal(infer("I won't let you hurt them again.").detectedMood, '愤怒');
  assert.equal(infer('I won!').detectedMood, '爽感');
  assert.equal(infer("I'm scared!").detectedMood, '紧张');
  assert.equal(infer("You're forcing him to sign.").detectedMood, '愤怒');
  assert.equal(infer('Please call an ambulance!').detectedMood, '紧张');
  assert.equal(infer('What are you hiding?').detectedMood, '悬疑');
  for (const text of ["I'm afraid so.", "I'm not scared.", 'The babies cry when hungry.', 'Grandmother has arrived.', 'Margaret Fun is her name.', "Don't touch the blade.", 'Help me choose a colour.', "As long as they're safe, I'll do anything."]) {
    assert.equal(infer(text).detectedMood, '平静', text);
    assert.equal(infer(text).moodSource, 'neutral-bed', text);
  }
  assert.equal(infer("They're stable and in very good hands.").detectedMood, '温情');
  assert.equal(infer('The kids are not safe.').detectedMood, '紧张');
  const plan = buildMusicPlan({ duration: 60, transcript: { segments: [{ start: 1, end: 2.5, text: 'I love you.' }] },
    groups: choices, options: { maxTracksPerEpisode: 3 }, trackUses: new Map() });
  assert.equal(plan.segments[0].detectedMood, '浪漫');
  assert.equal(plan.segments.at(-1).detectedMood, '平静', 'one short cue must not colour the entire episode');
  assert.equal(plan.segments.at(-1).moodSource, 'neutral-bed');
  assert.equal(plan.segments.at(-1).moodConfidence, 'low');
  assert.equal(plan.segments.at(-1).mood, '默认');
});

test('local conflict, emergency and reassurance remain distinct and music fallback keeps the detected emotion', () => {
  const transcript = { segments: [
    { start: 1, end: 3, text: 'You stole our children!' },
    { start: 20, end: 22, text: 'Call the police!' },
    { start: 40, end: 42, text: "I'm here. Don't be afraid." },
  ] };
  const result = buildMusicPlan({ duration: 55, transcript, groups, options: { maxTracksPerEpisode: 3 }, trackUses: new Map() });
  assert.deepEqual(result.segments.map(s => s.detectedMood), ['愤怒', '紧张', '温情']);
  const fallback = buildMusicPlan({ duration: 12, transcript: { segments: [transcript.segments[0]] },
    groups: new Map([['默认', ['neutral.wav']]]), options: {}, trackUses: new Map() });
  assert.equal(fallback.segments[0].detectedMood, '愤怒');
  assert.equal(fallback.segments[0].mood, '默认');
  assert.match(fallback.segments[0].reason, /愤怒.*无可用.*回退/);
});

test('topic words, medical cues and negated phrases stay conservative', () => {
  for (const text of ['The wedding comes first. Grandma loves you.', "They're always fighting in there. We'll monitor the baby.", "I don't love you and I'm not happy.", "This isn't about being cruel.", '我不爱你，也不喜欢这场婚礼。']) {
    assert.equal(inferMood({ segments: [{ start: 0, end: 8, text }] }, groups).mood, '默认', text);
  }
  assert.equal(inferMood({ segments: [{ text: "I’m not angry. How dare you!" }] }, groups).mood, '愤怒');
  assert.equal(inferMood({ segments: [{ text: "I don't love you. I love you." }] }, groups).mood, '浪漫');
});

test('word timestamps survive normalization; old transcripts are never divided by character count', () => {
  const old = { start: 0, end: 60, text: 'I love you, but how dare you!' };
  const normalized = normalizeTranscript({ segments: [{ ...old, words: [{ start: 1, end: 8, word: 'I love you,' }, { start: 32, end: 35, word: ' but' }, { start: 35, end: 56, word: ' how dare you!' }] }] }, 60);
  assert.equal(normalized[0].words[1].start, 32);
  assert.equal(normalizeTranscript({ segments: [{ ...old, words: [{ start: 0, end: 1, word: 'I' }, { start: 10, end: 99, word: 'love you' }] }] }, 60)[0].words, undefined);
  const plan = (segments) => buildMusicPlan({ duration: 60, transcript: { segments }, groups, options: {}, trackUses: new Map() });
  assert.equal(plan([old]).segments.length, 1);
  const precise = plan(normalized);
  assert.deepEqual(precise.segments.map((segment) => segment.mood), ['浪漫', '愤怒']);
  assert.ok(precise.segments[1].start > 30);
  assert.equal(precise.segments[1].timingSource, 'word');
});

test('scene candidates deduplicate shots and preserve the emotion-first behavior when switched off', () => {
  const parsed = parseSceneCandidates('lavfi.scd.score: 25, lavfi.scd.time: 0.03\nlavfi.scd.score: 15, lavfi.scd.time: 20\nlavfi.scd.score: 30, lavfi.scd.time: 20.2\nblack_start:39 black_end:40 black_duration:1', 60);
  assert.deepEqual(parsed.map((cut) => cut.time), [20, 40]);
  assert.equal(parsed[0].score, 30);
  const plan = buildMusicPlan({ duration: 60, transcript: null, groups, options: { scenePriority: false }, trackUses: new Map(), sceneCuts: parsed });
  assert.equal(plan.segments.length, 1);
  assert.equal(plan.sceneCandidates.length, 2);
  assert.ok(plan.sceneCandidates.every((cut) => !cut.used));
});

test('intensity precedes reuse count; missing target music falls back only to neutral or silence', () => {
  const choices = new Map([['紧张', ['quiet.wav', 'strong.wav']]]);
  const metadata = new Map([['quiet.wav', { intensity: 1 }], ['strong.wav', { intensity: 3, cueIn: 12, status: 'confirmed' }]]);
  const result = buildMusicPlan({ duration: 50, groups: choices, transcript: null, options: { mood: '紧张', trackMetadata: metadata }, trackUses: new Map([['strong.wav', 100]]) });
  assert.equal(result.segments[0].track, 'strong.wav');
  assert.equal(result.segments[0].cueIn, 12);
  const noEvidence = buildMusicPlan({ duration: 50, groups: choices, transcript: null, options: {}, trackUses: new Map() });
  assert.equal(noEvidence.segments[0].track, null);
});

test('sustained conflict ends at a shot with a long pause; cuts alone keep the same music', () => {
  const transcript = { segments: [
    { start: 1, end: 3, text: 'Back off!' },
    { start: 5, end: 7, text: 'Stop making a scene.' },
    { start: 18, end: 20, text: 'You are trying to force an answer out of me.' },
    { start: 24, end: 26, text: 'We should talk later.' },
    { start: 30, end: 33, text: 'All the babies are stable for now.' },
    { start: 36, end: 40, text: 'Is there any danger? We will monitor you.' },
  ] };
  const plan = (sceneCuts) => buildMusicPlan({ duration: 55, transcript, groups, options: {}, trackUses: new Map(), sceneCuts });
  assert.deepEqual(plan([{ time: 29.9, kind: 'cut', score: 15 }]).segments.map((segment) => segment.mood), ['愤怒', '默认']);
  assert.equal(plan([{ time: 29.9, kind: 'cut', score: 15 }]).segments[1].start, 29.9);
  const ordinaryCut = plan([{ time: 24.5, kind: 'cut', score: 15 }]);
  assert.ok(ordinaryCut.segments.every(segment => segment.start !== 24.5), 'ordinary cuts alone cannot force a music switch');
  assert.equal(ordinaryCut.segments.at(-1).detectedMood, '温情', 'new reassurance evidence is a real emotion change');
  const isolated = buildMusicPlan({ duration: 60, transcript: { segments: [{ start: 1, end: 2, text: 'Back off.' }, { start: 40, end: 42, text: 'Stop making a scene.' }] }, groups, options: {}, trackUses: new Map() });
  assert.equal(isolated.segments[0].mood, '默认');
});

test('contextual music suggestions handle emergency, coercion, grief and split ASR without an unknown label', () => {
  const choices = new Map([...groups, ['悬疑', ['mystery.wav']], ['伤感', ['sad.wav']], ['温情', ['warm.wav']]]);
  const cases = [
    ['The contractions are too frequent. Get a stretcher! We must save her.', '紧张'],
    ['You sent someone to steal our newborns! What gives you the right?', '愤怒'],
    ["I can't let them spread lies.", '愤怒'],
    ["We're divorced. I gave birth all by myself.", '伤感'],
    ['The DNA results are here. Take a sample for the paternity test.', '悬疑'],
    ['The kids are safe and sound. That is all behind you now.', '温情'],
    ["Tell me when something's wrong. Don't carry it all by yourself.", '温情'],
  ];
  for (const [text, expected] of cases) assert.equal(inferMood({ segments: [{ text }] }, choices).detectedMood, expected, text);
  const plan = (segments, sceneCuts = []) => buildMusicPlan({ duration: 48, transcript: { segments }, groups: choices,
    options: { maxTracksPerEpisode: 3 }, trackUses: new Map(), sceneCuts });
  const split = plan([{ start: 0, end: 1.5, text: 'She is using the press' }, { start: 1.5, end: 3, text: 'to force your' },
    { start: 3, end: 4, text: 'hand.' }, { start: 6, end: 10, text: 'I never agreed to this.' }]);
  assert.equal(split.segments[0].detectedMood, '愤怒');
  const continued = plan([{ start: 0, end: 2, text: 'You stole my children!' }, { start: 3, end: 7, text: 'Explain yourself.' },
    { start: 8, end: 12, text: 'That was your decision?' }, { start: 13, end: 20, text: 'We need to talk about this.' }]);
  assert.ok(continued.segments.every(segment => segment.detectedMood === '愤怒'));
  const reset = plan([{ start: 0, end: 2, text: 'You stole my children!' }, { start: 24, end: 27, text: 'Good morning.' },
    { start: 28, end: 32, text: 'The meeting starts at nine.' }], [{ time: 22, score: 50, kind: 'cut' }]);
  assert.equal(reset.segments.at(-1).detectedMood, '平静', 'conflict must not leak across a required scene cut');
  for (const result of [split, continued, reset, plan([])]) for (const segment of result.segments) {
    assert.ok(segment.detectedMood && segment.moodSource && segment.moodConfidence);
    assert.doesNotMatch(segment.reason, /未确定/);
  }
  const emergency = plan([{ start: 1, end: 4, text: 'The contractions are too frequent. We need to deliver immediately.' },
    { start: 10, end: 13, text: "As long as they're safe, I'll do anything." },
    { start: 31, end: 34, text: "All safe. They're stable now." }]);
  assert.deepEqual(emergency.segments.map(segment => segment.detectedMood), ['紧张', '温情']);
});

test('all human vocal classes and low-score uncertainty are excluded by strict screening', () => {
  for (const label of ['Singing', 'Speech', 'Rapping', 'Humming', 'Choir', 'Chant', 'Vocal music', 'Child speech, kid speaking', 'Whispering']) assert.equal(summarizeFrames(frames(5, 0.7, label), 5).status, 'vocal', label);
  assert.equal(summarizeFrames(frames(5, 0.02), 5).status, 'unknown');
  assert.equal(summarizeFrames(frames(5, 0.005), 5).status, 'instrumental');
  assert.equal(summarizeFrames([{ time: 0, categories: [{ label: 'Speech', score: 0 }] }], 1).status, 'unknown');
  assert.throws(() => summarizeFrames([], 1), /有效分析帧/);
});

test('strict cache rejects old versions, changed settings, incomplete scans, and unknown results', () => {
  const entry = { fingerprint: '1:2', analysis: { status: 'instrumental', version: ANALYSIS_VERSION, settings: ANALYSIS_SETTINGS, modelSha256: MODEL_SHA256, complete: true } };
  assert.equal(trackStatus(entry, '1:2'), 'instrumental');
  assert.equal(trackStatus(entry, 'changed'), 'unknown');
  for (const patch of [{ version: 'old' }, { settings: {} }, { modelSha256: 'changed' }, { complete: false }, { status: 'unknown' }]) assert.equal(trackStatus({ ...entry, analysis: { ...entry.analysis, ...patch } }, '1:2'), 'unknown');
});

test('manual review persists without changing music, invalidates confirmation when file changes and retains disable', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-library-review-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'music.mp3');
  await fs.writeFile(file, 'original');
  const tracks = new Map([['默认', [file]]]);
  const options = { music: root, libraryCacheDir: path.join(root, 'cache') };
  assert.equal((await filterLibrary(tracks, options)).groups.size, 0);
  await reviewTrack(root, tracks, { file, action: 'confirm' }, options);
  assert.equal((await filterLibrary(tracks, options)).counts.confirmed, 1);
  await reviewTrack(root, tracks, { file, action: 'metadata', cueIn: 3, intensity: 1 }, options);
  assert.equal((await filterLibrary(tracks, options)).files[0].cueIn, 3);
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
  await fs.writeFile(file, 'updated content');
  assert.equal((await filterLibrary(tracks, options)).groups.size, 0);
  await reviewTrack(root, tracks, { file, action: 'disable' }, options);
  await fs.writeFile(file, 'second update');
  assert.equal((await filterLibrary(tracks, { ...options, strictInstrumental: false })).groups.size, 0);
  await assert.rejects(reviewTrack(root, tracks, { file: path.join(root, 'outside'), action: 'confirm' }, options), /不属于当前曲库/);
  await assert.rejects(reviewTrack(root, tracks, { file, action: 'metadata', cueIn: -1, intensity: 3 }, options), /入点/);
  await fs.writeFile(cachePath(root, options), 'broken cache');
  await assert.rejects(readLibrary(root, options), /缓存损坏/);
});

test('missing model leaves unknown music excluded and unchanged cache is reused', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-model-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'track.wav');
  await fs.writeFile(file, 'fixture');
  const options = { music: root, libraryCacheDir: path.join(root, 'cache'), vocalModelPath: path.join(root, 'missing.tflite') };
  const tracks = new Map([['默认', [file]]]);
  const failed = await filterLibrary(tracks, options, { analyze: true });
  assert.equal(failed.counts.unknown, 1);
  assert.equal(failed.groups.size, 0);
  const library = await readLibrary(root, options);
  library.files[file] = { fingerprint: fingerprint(await fs.stat(file)), analysis: { version: ANALYSIS_VERSION, modelSha256: MODEL_SHA256, settings: ANALYSIS_SETTINGS, complete: true, status: 'instrumental' } };
  await writeLibrary(root, library, options);
  assert.equal((await filterLibrary(tracks, options, { analyze: true })).counts.instrumental, 1);
});

test('screening off admits vocal, unknown and failed tracks without analyzing or changing review metadata', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-screening-toggle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = ['instrumental', 'vocal', 'unknown', 'failed', 'disabled'].map((name) => path.join(root, name + '.wav'));
  await promisify(execFile)(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', files[0]], { windowsHide: true });
  for (const file of files.slice(1)) await fs.copyFile(files[0], file);
  const options = { music: root, libraryCacheDir: path.join(root, 'cache'), vocalModelPath: path.join(root, 'missing.tflite'), ffmpeg: 'must-not-decode-for-vocals', createAudioClassifier() { throw new Error('must not classify'); } };
  const library = { version: 1, files: {} };
  for (let i = 0; i < files.length; i += 1) library.files[files[i]] = { fingerprint: fingerprint(await fs.stat(files[i])), disabled: i === 4, cueIn: .25, intensity: 3,
    analysis: { version: ANALYSIS_VERSION, modelSha256: MODEL_SHA256, settings: ANALYSIS_SETTINGS, status: ['instrumental', 'vocal', 'unknown', 'unknown', 'instrumental'][i], complete: i !== 3, ...(i === 3 ? { reason: 'previous analysis failed' } : {}) } };
  await writeLibrary(root, library, options);
  const tracks = new Map([['默认', files]]);
  assert.deepEqual((await filterLibrary(tracks, { ...options, strictInstrumental: true })).groups.get('默认'), [files[0]]);
  const relaxed = await filterLibrary(tracks, { ...options, strictInstrumental: false });
  assert.deepEqual(relaxed.groups.get('默认'), files.slice(0, 4));
  assert.deepEqual(relaxed.files.map((file) => file.status), ['instrumental', 'vocal', 'unknown', 'unknown', 'disabled']);
  assert.deepEqual(await readLibrary(root, options), library);
  assert.deepEqual((await filterLibrary(tracks, { ...options, strictInstrumental: true })).groups.get('默认'), [files[0]]);
});

test('full-track decoding detects vocals after a long intro, rejects sparse model output and aborts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-full-vocals-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'long-intro.wav');
  const ffmpeg = process.env.FFMPEG || 'ffmpeg';
  await promisify(execFile)(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=31', file], { windowsHide: true });
  let calls = 0;
  const result = await analyzeTrack(file, ffmpeg, { classify: async (bytes) => frames(bytes.length / 64000, calls++ > 0 ? 0.9 : 0) });
  assert.equal(result.status, 'vocal');
  assert.equal(result.duration, 31);
  assert.ok(result.intervals[0].start >= 28.8);
  await assert.rejects(analyzeTrack(file, ffmpeg, { classify: async () => frames(1) }), /覆盖整段/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(analyzeTrack(file, ffmpeg, {}, controller.signal), { name: 'AbortError' });
  const midTrack = new AbortController();
  await assert.rejects(analyzeTrack(file, ffmpeg, { classify: async (bytes) => { midTrack.abort(); return frames(bytes.length / 64000); } }, midTrack.signal), { name: 'AbortError' });
});
