#!/usr/bin/env node
// clipper.mjs — a tiny GTA 6 clip studio in one file (Node, stdlib only).
//
// Pipeline: download -> spot the moment -> cut -> reframe -> caption -> ship.
//   input    a local video file, or a YouTube URL fetched with yt-dlp
//            (best mp4 at most 720p tall)
//   analyse  scene-change timestamps (ffmpeg select='gt(scene,0.35)' with
//            showinfo) plus a per-second loudness profile (astats RMS),
//            combined into one score per candidate moment
//   cut      the top N moments (default 3) as vertical 9:16 clips,
//            1080x1920, scale + centre crop, a title line burned in at
//            the top, H.264 + AAC, faststart
//   pitch    with --pitch, a 4 second make.fun pitch card is appended
//            (dark lavfi colour source + drawtext + silent AAC track)
//
// Usage:
//   node tools/clipper.mjs --input <file|url> [--out clips] [--count 3]
//                          [--duration 12] [--title "Hook title"]
//   node tools/clipper.mjs --input trailer.mp4 --start 83 --duration 36
//                          --title "Hook title" --pitch --final final.mp4
//
// A JSON summary of the chosen moments is printed to stdout.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const PITCH_LINES = [
  'Make clips like this with AI',
  'and earn money on make.fun',
  'make.fun/bounty/gta6-clipper-01',
];

// ---------- small helpers ----------

function parseArgs(argv) {
  const args = { out: 'clips', count: 3, duration: 12, title: 'GTA 6 moment', pitch: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pitch') args.pitch = true;
    else if (a === '--input') args.input = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--count') args.count = Number(argv[++i]);
    else if (a === '--duration') args.duration = Number(argv[++i]);
    else if (a === '--start') args.start = Number(argv[++i]);
    else if (a === '--title') args.title = argv[++i];
    else if (a === '--title-duration') args.titleDuration = Number(argv[++i]);
    else if (a === '--final') args.final = argv[++i];
    else if (a === '--crop-x') args.cropX = Number(argv[++i]);
    else if (a === '--keep-source') args.keepSource = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.input) throw new Error('--input <file-or-youtube-url> is required');
  return args;
}

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} failed (${r.status}): ${(r.stderr || '').slice(-800)}`);
  }
  return r;
}

function probe(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-show_entries', 'stream=codec_type,width,height', '-of', 'json', file,
  ], { encoding: 'utf8' });
  const info = JSON.parse(out);
  const video = info.streams.find((s) => s.codec_type === 'video') || {};
  return { duration: Number(info.format.duration), width: video.width || 0, height: video.height || 0 };
}

function escapeDrawtext(text) {
  return text.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/%/g, '\\%');
}

function titleFilter(title, titleDuration) {
  const enable = titleDuration ? `:enable='between(t,0,${titleDuration})'` : '';
  return `drawtext=fontfile=${FONT}:text='${escapeDrawtext(title)}':fontsize=54:` +
    `fontcolor=white:borderw=3:bordercolor=black:box=1:boxcolor=black@0.45:boxborderw=18:` +
    `x=(w-text_w)/2:y=60${enable}`;
}

// ---------- source ----------

function fetchSource(input, workDir) {
  if (!/^https?:\/\//.test(input)) {
    if (!existsSync(input)) throw new Error(`input file not found: ${input}`);
    return resolve(input);
  }
  const target = join(workDir, 'source.mp4');
  const format = ['-f', 'best[height<=720][ext=mp4]/best[height<=720]/best',
    '--merge-output-format', 'mp4', '-o', target, input];
  const first = run('yt-dlp', format, { allowFail: true });
  if (first.status !== 0 || !existsSync(target)) {
    // YouTube often answers the default client with a bot check; the
    // android player client usually passes without any cookies.
    run('yt-dlp', ['--extractor-args', 'youtube:player_client=android', ...format]);
  }
  return target;
}

// ---------- analysis ----------

function sceneTimes(file, duration) {
  const r = run('ffmpeg', [
    '-i', file, '-vf', "select='gt(scene,0.35)',showinfo", '-f', 'null', '-',
  ], { allowFail: true });
  const times = [];
  for (const m of (r.stderr || '').matchAll(/pts_time:([0-9.]+)/g)) {
    const t = Number(m[1]);
    if (t > 0.5 && t < duration - 1) times.push(t);
  }
  return [...new Set(times.map((t) => Math.round(t * 10) / 10))].sort((a, b) => a - b);
}

function loudnessPerSecond(file, duration) {
  // One astats window per second of audio (reset is in samples; assume the
  // common 48 kHz case is close enough — the profile is only a ranking
  // signal, and we re-read the real sample rate when ffprobe reports it).
  const r = run('ffmpeg', [
    '-i', file, '-vn',
    '-af', 'aresample=48000,astats=metadata=1:reset=48000,ametadata=print:key=lavfi.astats.Overall.RMS_level',
    '-f', 'null', '-',
  ], { allowFail: true });
  const levels = [];
  for (const m of (r.stderr || '').matchAll(/RMS_level=(-?[0-9.]+|-inf)/g)) {
    levels.push(m[1] === '-inf' ? -70 : Number(m[1]));
  }
  const seconds = Math.max(1, Math.floor(duration));
  const perSecond = new Array(seconds).fill(-70);
  for (let i = 0; i < Math.min(levels.length, seconds); i++) perSecond[i] = levels[i];
  return perSecond;
}

function scoreMoments(scenes, loudness, duration, clipLen) {
  const loud = loudness.map((v) => Math.max(0, Math.min(1, (v + 55) / 35))); // -55..-20 dB -> 0..1
  const candidates = new Map();
  const addCandidate = (start, why) => {
    const s = Math.max(0, Math.min(start, Math.max(0, duration - clipLen)));
    const key = Math.round(s);
    if (!candidates.has(key)) candidates.set(key, { start: key, whys: [] });
    candidates.get(key).whys.push(why);
  };
  for (const t of scenes) addCandidate(t - 1, 'scene change (new shot starts just after)');
  // Also seed candidates at local loudness peaks, in case a great moment
  // happens inside one long shot with no cut.
  for (let i = 2; i < loud.length - 2; i++) {
    if (loud[i] > 0.55 && loud[i] >= loud[i - 1] && loud[i] >= loud[i + 1]) {
      addCandidate(i - 2, 'loudness peak (impact / music hit)');
    }
  }
  if (candidates.size === 0) addCandidate(duration * 0.25, 'fallback: quarter point (no signal found)');

  const scored = [...candidates.values()].map((c) => {
    const end = Math.min(loud.length, c.start + clipLen);
    const slice = loud.slice(c.start, end);
    const avgLoud = slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : 0;
    const nearbyScenes = scenes.filter((t) => t >= c.start - 2 && t <= c.start + clipLen).length;
    const score = Math.round((avgLoud * 0.7 + Math.min(1, nearbyScenes / 4) * 0.3) * 1000) / 1000;
    return {
      start: c.start,
      duration: Math.min(clipLen, duration - c.start),
      score,
      why: `${c.whys.join('; ')}; avg loudness ${(avgLoud * 100).toFixed(0)}%, ${nearbyScenes} cuts in window`,
    };
  });
  // De-duplicate overlapping windows, best score first.
  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of scored) {
    if (picked.every((p) => Math.abs(p.start - c.start) >= clipLen)) picked.push(c);
    if (picked.length >= 12) break;
  }
  return picked.sort((a, b) => a.start - b.start);
}

// ---------- rendering ----------

function verticalFilter(title, titleDuration, cropX = 0.5) {
  // cropX: 0 = hard left, 0.5 = centre, 1 = hard right. Use a biased crop
  // when the shot's subject sits off-centre in the landscape source.
  return [
    'scale=1080:1920:force_original_aspect_ratio=increase',
    `crop=1080:1920:(iw-ow)*${cropX}:(ih-oh)/2`,
    'setsar=1',
    'fps=30',
    'format=yuv420p',
    title ? titleFilter(title, titleDuration) : null,
  ].filter(Boolean).join(',');
}

function cutClip(source, start, duration, title, titleDuration, outFile, cropX) {
  run('ffmpeg', [
    '-y', '-ss', String(start), '-i', source, '-t', String(duration),
    '-vf', verticalFilter(title, titleDuration, cropX),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', outFile,
  ]);
}

function pitchCard(outFile) {
  const lines = PITCH_LINES.map((line, i) => {
    const size = i === 2 ? 44 : 58;
    const y = 760 + i * 130;
    return `drawtext=fontfile=${FONT}:text='${escapeDrawtext(line)}':fontsize=${size}:` +
      `fontcolor=white:x=(w-text_w)/2:y=${y}`;
  }).join(',');
  run('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=0x111111:s=1080x1920:r=30:d=4',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-t', '4', '-vf', `${lines},setsar=1,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', outFile,
  ]);
}

function appendPitch(clipFile, outFile, workDir) {
  const card = join(workDir, 'pitch-card.mp4');
  pitchCard(card);
  run('ffmpeg', [
    '-y', '-i', clipFile, '-i', card,
    '-filter_complex', '[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]',
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outFile,
  ]);
}

// ---------- main ----------

function main() {
  const args = parseArgs(process.argv);
  const outDir = resolve(args.out);
  const workDir = join(outDir, '.work');
  mkdirSync(workDir, { recursive: true });

  const source = fetchSource(args.input, workDir);
  const info = probe(source);

  let moments;
  if (typeof args.start === 'number') {
    moments = [{
      start: args.start,
      duration: Math.min(args.duration, info.duration - args.start),
      score: null,
      why: 'chosen by hand from the analysed candidates (see session notes)',
    }];
  } else {
    const scenes = sceneTimes(source, info.duration);
    const loudness = loudnessPerSecond(source, info.duration);
    moments = scoreMoments(scenes, loudness, info.duration, args.duration).slice(0, args.count);
  }

  const outputs = [];
  for (let i = 0; i < moments.length; i++) {
    const m = moments[i];
    const clipFile = join(workDir, `moment-${i + 1}.mp4`);
    cutClip(source, m.start, m.duration, args.title, args.titleDuration || 0, clipFile, args.cropX ?? 0.5);
    let finalFile = clipFile;
    if (args.pitch) {
      finalFile = args.final && moments.length === 1
        ? resolve(args.final)
        : join(outDir, `clip-${i + 1}.mp4`);
      appendPitch(clipFile, finalFile, workDir);
    } else if (args.final && moments.length === 1) {
      finalFile = resolve(args.final);
      run('cp', [clipFile, finalFile]);
    } else {
      finalFile = join(outDir, `clip-${i + 1}.mp4`);
      run('cp', [clipFile, finalFile]);
    }
    outputs.push({ ...m, file: finalFile });
  }

  const summary = {
    source: basename(source),
    sourceDuration: Math.round(info.duration * 10) / 10,
    sourceSize: `${info.width}x${info.height}`,
    moments: outputs,
  };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main();
