#!/usr/bin/env node
/**
 * Video Workbench · 把已有的 ~/workspace/projects/<slug>/ 项目目录注册成 vf 项目
 *
 * 自动识别：
 *   - audio-segments.json + public/audio/*.mp3  → audio artifact v1
 *   - recordings-paged/*.webm                    → recording artifact v1
 *   - covers/cover-*.png                         → cover artifacts
 *   - timing.json + script.md/article.md/outline.md → content artifacts
 *
 * 用法：
 *   node plugins/video-workbench/migrate-existing.mjs <slug>
 *   node plugins/video-workbench/migrate-existing.mjs claude-code-guide-v9 --title "Claude Code 新手指南"
 *
 * 不动磁盘文件，只往 vf.db + manifest.json 写元数据。
 */
import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { randomUUID } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 注入 daemon 的 data 目录
const DAEMON_ROOT = join(__dirname, "..", "..");
const DATA_DIR = join(DAEMON_ROOT, "data");

const { initVfDb, createProject, getProjectBySlug, addVersion } = await import("./db.mjs");
const { bootstrapProjectDir, readManifest, writeManifest, emptyManifest, addArtifactVersion, setPhase } = await import("./manifest.mjs");

const slug = process.argv[2];
if (!slug) {
  console.error("Usage: node migrate-existing.mjs <slug> [--title 'xxx']");
  process.exit(1);
}
const titleArg = process.argv.indexOf("--title");
const title = titleArg > 0 ? process.argv[titleArg + 1] : slug;

const projectsRoot = join(homedir(), "workspace", "projects");
const workspacePath = join(projectsRoot, slug);
if (!existsSync(workspacePath)) {
  console.error(`✗ 目录不存在: ${workspacePath}`);
  process.exit(1);
}

initVfDb(DATA_DIR);

// 1. 创建或复用项目
let project = getProjectBySlug(slug);
if (project) {
  console.log(`▶ 已存在 vf 项目，复用 id=${project.id}`);
} else {
  const id = randomUUID();
  project = createProject({ id, slug, title, workspacePath });
  console.log(`✓ 新建 vf 项目 id=${project.id}`);
}

// 2. 确保有 manifest.json
let manifest = readManifest(workspacePath);
if (!manifest) {
  manifest = emptyManifest(project.id);
  manifest.slug = slug;
  manifest.title = title;
  writeManifest(workspacePath, manifest);
  console.log(`✓ 创建 manifest.json`);
}

// 3. 扫描制品
let v = 0;

// 3.1 content (script / article / outline)
for (const fn of ["script.md", "script-v6.md", "article.md", "outline.md", "audio-segments.json", "timing.json"]) {
  const p = join(workspacePath, fn);
  if (existsSync(p)) {
    const type = fn.replace(/\.\w+$/, "").replace(/-v\d+$/, "");
    const ver = 1;
    addVersion({
      projectId: project.id,
      artifactType: type,
      version: ver,
      fileRelPath: fn,
      metadataJson: JSON.stringify({ size: statSync(p).size, mtime: statSync(p).mtimeMs }),
    });
    console.log(`  + ${type} v${ver} ← ${fn}`);
    v++;
  }
}

// 3.2 audio
const audioDir = join(workspacePath, "public", "audio");
if (existsSync(audioDir)) {
  const mp3s = [];
  for (const ch of readdirSync(audioDir)) {
    const chPath = join(audioDir, ch);
    if (statSync(chPath).isDirectory()) {
      for (const f of readdirSync(chPath)) {
        if (f.endsWith(".mp3")) mp3s.push(`public/audio/${ch}/${f}`);
      }
    }
  }
  if (mp3s.length) {
    addVersion({
      projectId: project.id,
      artifactType: "audio",
      version: 1,
      fileRelPath: "public/audio/",
      metadataJson: JSON.stringify({ count: mp3s.length, files: mp3s }),
    });
    console.log(`  + audio v1 ← ${mp3s.length} mp3 files in public/audio/`);
    v++;
  }
}

// 3.3 recording (webm)
const recordingDir = join(workspacePath, "recordings-paged");
if (existsSync(recordingDir)) {
  for (const f of readdirSync(recordingDir)) {
    if (f.endsWith(".webm")) {
      addVersion({
        projectId: project.id,
        artifactType: "recording",
        version: 1,
        fileRelPath: `recordings-paged/${f}`,
        metadataJson: JSON.stringify({ source: "playwright" }),
      });
      console.log(`  + recording v1 ← recordings-paged/${f}`);
      v++;
      break;
    }
  }
}

// 3.4 final mp4（既看项目目录内，也看 daemon data/video/）
const finalCandidates = [];
// 项目目录里的 1920x1080.mp4
for (const f of readdirSync(workspacePath)) {
  if (f.endsWith(".mp4")) {
    finalCandidates.push({ rel: f, source: "project-root", path: join(workspacePath, f) });
  }
}
// daemon data/video/ 下的同 slug 文件
const daemonVideoDir = join(DAEMON_ROOT, "data", "video");
if (existsSync(daemonVideoDir)) {
  for (const f of readdirSync(daemonVideoDir)) {
    if (f.startsWith(slug) && f.endsWith(".mp4")) {
      finalCandidates.push({ rel: f, source: "daemon", path: join(daemonVideoDir, f) });
    }
  }
}

// 排序 + 编版本号（最新的 mtime 为 current）
finalCandidates.sort((a, b) => statSync(a.path).mtimeMs - statSync(b.path).mtimeMs);
let ver = 0;
for (const c of finalCandidates) {
  ver++;
  const isLast = ver === finalCandidates.length;
  addVersion({
    projectId: project.id,
    artifactType: "final",
    version: ver,
    fileRelPath: c.source === "daemon" ? `__daemon_data__/video/${c.rel}` : c.rel,
    setCurrent: isLast,
    metadataJson: JSON.stringify({
      source: c.source,
      size: statSync(c.path).size,
      mtime: statSync(c.path).mtimeMs,
    }),
  });
  console.log(`  + final v${ver} ← ${c.path}${isLast ? " ★ current" : ""}`);
  v++;
}

// 3.5 covers
const coverDir = join(workspacePath, "covers");
if (existsSync(coverDir)) {
  let cv = 0;
  for (const f of readdirSync(coverDir).sort()) {
    if (f.startsWith("cover-") && f.endsWith(".png")) {
      cv++;
      addVersion({
        projectId: project.id,
        artifactType: "cover",
        version: cv,
        fileRelPath: `covers/${f}`,
        setCurrent: false,
        metadataJson: JSON.stringify({ size: statSync(join(coverDir, f)).size }),
      });
      console.log(`  + cover v${cv} ← covers/${f}`);
      v++;
    }
  }
}

// 4. 更新 manifest 阶段
manifest.phase = finalCandidates.length ? "publish" : "encode";
manifest.phase_progress = {
  brief: "done",
  content: existsSync(join(workspacePath, "script.md")) || existsSync(join(workspacePath, "script-v6.md")) ? "done" : "todo",
  audio: existsSync(audioDir) ? "done" : "todo",
  recording: existsSync(recordingDir) ? "done" : "todo",
  encode: finalCandidates.length ? "done" : "todo",
  publish: "todo",
};
writeManifest(workspacePath, manifest);

console.log(`\n✓ 迁移完成 · 共注册 ${v} 个制品版本`);
console.log(`  打开 /video-factory.html 应该能看到这个项目`);
