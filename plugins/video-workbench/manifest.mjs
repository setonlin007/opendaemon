/**
 * manifest.json 读写 · 项目目录的事实源
 * schema version 1
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

export const MANIFEST_VERSION = 1;

export function emptyManifest(projectId) {
  return {
    schema_version: MANIFEST_VERSION,
    project_id: projectId,
    phase: "brief",
    phase_progress: {
      brief: "todo",
      content: "todo",
      audio: "todo",
      recording: "todo",
      encode: "todo",
      publish: "todo",
    },
    artifacts: {},
    last_run_id: null,
  };
}

export function readManifest(workspacePath) {
  const p = join(workspacePath, "manifest.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function writeManifest(workspacePath, manifest) {
  if (!existsSync(workspacePath)) mkdirSync(workspacePath, { recursive: true });
  const p = join(workspacePath, "manifest.json");
  writeFileSync(p, JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * 给项目加新版本制品 + 自动指针
 * 例：addArtifactVersion(path, 'final', 1, 'final-v1.mp4', { duration_ms: 200700 })
 */
export function addArtifactVersion(workspacePath, type, version, relPath, metadata = {}) {
  const m = readManifest(workspacePath) || emptyManifest(null);
  if (!m.artifacts[type]) m.artifacts[type] = { current: null, versions: [] };
  m.artifacts[type].versions.push({ v: version, path: relPath, ts: Date.now(), ...metadata });
  m.artifacts[type].current = version;
  writeManifest(workspacePath, m);
  return m;
}

export function setPhase(workspacePath, phase, progress = null) {
  const m = readManifest(workspacePath) || emptyManifest(null);
  m.phase = phase;
  if (progress && m.phase_progress) m.phase_progress[phase] = progress;
  writeManifest(workspacePath, m);
  return m;
}

export function setPhaseProgress(workspacePath, phase, progress) {
  const m = readManifest(workspacePath) || emptyManifest(null);
  if (!m.phase_progress) m.phase_progress = {};
  m.phase_progress[phase] = progress;
  writeManifest(workspacePath, m);
  return m;
}

/**
 * 给新项目创建目录骨架
 * <workspace>/
 *   manifest.json
 *   brief.json (空模板)
 *   scripts -> ~/workspace/skills/video-factory/scripts/  (软链)
 *   .vf-runs/
 *   .trash/
 *   uploads/
 *   recordings-paged/
 *   recordings-mac/
 *   covers/
 *   publish/
 *   public/
 */
export async function bootstrapProjectDir(workspacePath, projectId, slug, title, skillScriptsPath) {
  const fs = await import("fs/promises");
  const { symlinkSync, existsSync: exists } = await import("fs");

  await fs.mkdir(workspacePath, { recursive: true });
  for (const sub of [".vf-runs", ".trash", "uploads", "recordings-paged", "recordings-mac", "covers", "publish", "public"]) {
    await fs.mkdir(join(workspacePath, sub), { recursive: true });
  }

  // brief.json 模板
  const briefPath = join(workspacePath, "brief.json");
  if (!exists(briefPath)) {
    await fs.writeFile(briefPath, JSON.stringify({
      topic: title,
      audience: "",
      duration_target_s: 240,
      tone: "",
      platforms: [],
      materials_strategy: "ai-pick",
      assumptions: [],
    }, null, 2));
  }

  // manifest.json
  const m = emptyManifest(projectId);
  m.slug = slug;
  m.title = title;
  writeManifest(workspacePath, m);

  // scripts symlink
  const scriptsLink = join(workspacePath, "scripts");
  if (!exists(scriptsLink)) {
    try {
      symlinkSync(skillScriptsPath, scriptsLink, "dir");
    } catch (err) {
      // 软链失败不致命，记录就行
      console.warn(`[vf] symlink scripts failed: ${err.message}`);
    }
  }

  return m;
}
