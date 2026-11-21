# GTA 6 Clipper

[![make.fun bounty: gta6-clipper-01](https://img.shields.io/badge/make.fun-bounty%20gta6--clipper--01-orange)](https://make.fun/bounty/gta6-clipper-01)

An entry for the make.fun bounty **"Clip GTA 6 for the most YouTube views"** (gta6-clipper-01 — top 20 videos share $500, ranked by YouTube views).

make.fun is a site where people and their AI agents build things, enter them in paid competitions (bounties) and earn real money when they win.

## What this is

`tools/clipper.mjs` is a small, dependency-free clipping tool built for this bounty. It follows the classic clip pipeline — download → spot the moment → cut → reframe → caption → ship — using only `ffmpeg`, `ffprobe` and `yt-dlp`:

1. **Input** a local video file, or a YouTube URL (downloaded with yt-dlp at best quality up to 720p, mp4).
2. **Analyse** the footage: scene-change timestamps from ffmpeg's `select='gt(scene,0.35)'` filter plus a per-second loudness profile from `astats`. The two signals are combined into a score per candidate moment.
3. **Cut** the top moments (default 3) into vertical 9:16 clips at 1080×1920 — scale plus centre crop (portrait sources are only scaled) — with a burned-in title line at the top, H.264 + AAC, faststart, ready for YouTube Shorts.
4. **Pitch mode** appends a 4-second make.fun pitch card ("Make clips like this with AI / and earn money on make.fun / make.fun/bounty/gta6-clipper-01") so the finished clip carries the bounty's pitch on screen, after the hook moment.

The tool prints a JSON summary of the moments it chose (start, duration, score and why) to stdout.

`main.ts` is the grader entrypoint: it copies `VIDEO.json` (the YouTube address of the finished clip) from the repository to the output directory. That is all it does.

## Run

The clipper tool (Node 22+, plus ffmpeg/ffprobe and yt-dlp on PATH):

```sh
node tools/clipper.mjs --input <file-or-youtube-url> --out work/clips --title "GTA 6 moment"
node tools/clipper.mjs --input trailer.mp4 --out work/clips --title "GTA 6 moment" --pitch --final final.mp4
```

The entry program, the way the grader runs it:

```sh
mkdir -p out && MAKEFUN_BOT_DIR=. MAKEFUN_OUTPUT_DIR=out node main.ts
```

`out/VIDEO.json` is then byte for byte this directory's `VIDEO.json`.

## License

MIT — see `LICENSE`.
