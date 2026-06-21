// src/profileSync.ts
// Sync review profiles from a configured GitLab repository into a local cache.
//
// This lets a team manage profiles centrally — curated by managers/tech-leads and
// reviewed via GitLab merge requests — instead of a per-workspace
// .vscode-reviewer/profiles folder. When `revvy.profiles.repoUrl` is set, the
// rule loader reads profiles from the synced cache dir (see getRulesPath in
// extension.ts) and this folder becomes the single source of truth.
//
// Transport reuses BaseHttpClient so corporate proxy / noProxy / TLS settings
// apply exactly as they do for the GitLab/GitHub/Jira clients.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as yaml from 'js-yaml';
import { BaseHttpClient } from './http/baseClient';
import { Credentials } from './http/credentials';
import type { ImpactTemplate } from './reviewer';

interface GitLabTreeEntry {
  name: string;
  path: string;
  type: 'blob' | 'tree';
}

export interface ProfilesRepoConfig {
  /** Repo web URL, e.g. https://gitlab.com/org/revvy-profiles */
  repoUrl: string;
  /** Branch or tag to read from (pin a tag for reproducibility). */
  ref: string;
  /** Subfolder holding the YAML profiles ('' = repo root). */
  subPath: string;
  /** Subfolder holding template YAML(s), e.g. impact analysis ('' = disabled). */
  templatesPath: string;
}

export interface ProfileSyncResult {
  count: number;
  templateCount: number;
  cacheDir: string;
  ref: string;
  project: string;
}

/** Read the profiles-repo settings. Returns null when no repo is configured. */
export function getProfilesRepoConfig(): ProfilesRepoConfig | null {
  const cfg = vscode.workspace.getConfiguration('revvy.profiles');
  const repoUrl = (cfg.get<string>('repoUrl', '') || '').trim();
  if (!repoUrl) { return null; }
  return {
    repoUrl,
    ref: (cfg.get<string>('ref', 'main') || 'main').trim(),
    subPath: (cfg.get<string>('path', '') || '').trim().replace(/^\/+|\/+$/g, ''),
    templatesPath: (cfg.get<string>('templatesPath', 'templates') || '').trim().replace(/^\/+|\/+$/g, ''),
  };
}

/** Stable per-(repo, ref, path) cache directory under the extension's global storage. */
export function getProfilesCacheDir(
  context: vscode.ExtensionContext,
  repo: ResolvedProfilesRepo,
): string {
  const key = crypto
    .createHash('sha1')
    .update(`${repo.host}/${repo.project}@${repo.ref}#${repo.subPath}`)
    .digest('hex')
    .slice(0, 16);
  return path.join(context.globalStorageUri.fsPath, 'profiles', key);
}

/** Concrete API coordinates resolved from the configured repo URL + settings. */
export interface ResolvedProfilesRepo {
  host: string;          // e.g. https://gitlab.com
  project: string;       // group/subgroup/project
  ref: string;           // branch or tag
  subPath: string;       // subfolder of profiles ('' = root)
  templatesPath: string; // subfolder of templates ('' = disabled)
}

/**
 * Resolve the configured repo into concrete API coordinates. Accepts either a
 * bare repo URL (https://host/group/project) OR a GitLab browse URL
 * (.../-/tree/<ref>/<path> or .../-/blob/<ref>/<file>) — common when a user
 * copies the address bar — and extracts the project, ref and subfolder.
 *
 * Explicit `ref`/`path` settings win; values embedded in a browse URL fill in
 * when those settings are left at their defaults. Returns null when no repo is
 * configured. Pure/sync — no network.
 */
export function resolveProfilesRepo(): ResolvedProfilesRepo | null {
  const cfg = getProfilesRepoConfig();
  if (!cfg) { return null; }

  const u = new URL(cfg.repoUrl);
  const host = `${u.protocol}//${u.host}`;
  let pathName = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '');

  // GitLab browse URLs embed the ref/path after a "/-/" segment.
  let urlRef: string | undefined;
  let urlPath: string | undefined;
  const dash = pathName.indexOf('/-/');
  if (dash >= 0) {
    const after = pathName.slice(dash + 3);   // e.g. "tree/main/profiles"
    pathName = pathName.slice(0, dash);       // e.g. "group/project"
    const m = after.match(/^(?:tree|blob)\/([^/]+)(?:\/(.+))?$/);
    if (m) {
      urlRef = decodeURIComponent(m[1]);
      urlPath = m[2] ? decodeURIComponent(m[2]).replace(/\/+$/, '') : undefined;
    }
  }

  const project = pathName.replace(/\.git$/i, '');
  if (!project) { throw new Error(`Invalid profiles repo URL: ${cfg.repoUrl}`); }

  const ref = (cfg.ref && cfg.ref !== 'main') ? cfg.ref : (urlRef || cfg.ref || 'main');
  const subPath = cfg.subPath || urlPath || '';
  return { host, project, ref, subPath, templatesPath: cfg.templatesPath };
}

/** Cache dir for synced template YAML(s) — kept separate from profiles so the
 *  rule loader never tries to parse a template as a profile. */
export function getTemplatesCacheDir(
  context: vscode.ExtensionContext,
  repo: ResolvedProfilesRepo,
): string {
  const key = crypto
    .createHash('sha1')
    .update(`${repo.host}/${repo.project}@${repo.ref}#${repo.templatesPath}`)
    .digest('hex')
    .slice(0, 16);
  return path.join(context.globalStorageUri.fsPath, 'templates', key);
}

/** Minimal GitLab fetcher reusing the shared proxy/TLS-aware transport. */
class ProfileRepoClient extends BaseHttpClient {
  constructor(private token?: string) { super(); }

  async getJson<T>(url: string): Promise<T> {
    return JSON.parse(await this.fetch(url)) as T;
  }

  async getText(url: string): Promise<string> {
    return this.fetch(url);
  }

  private async fetch(url: string): Promise<string> {
    const headers: Record<string, string> = {};
    if (this.token) { headers['PRIVATE-TOKEN'] = this.token; }
    const res = await this.request(url, { headers });
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `${res.status} — the profiles repo is private. Store a GitLab token via ` +
        `"Revvy: Reset GitLab Credentials" (needs read_repository scope).`,
      );
    }
    if (res.status === 404) {
      throw new Error(`404 — repo, ref, or path not found (${url}).`);
    }
    if (res.status >= 400) {
      throw new Error(`GitLab ${res.status} for ${url}: ${res.body.slice(0, 200)}`);
    }
    return res.body;
  }
}

/**
 * Fetch every `.yaml`/`.yml` profile from the configured repo path and write
 * them into the cache dir. Atomic: writes to a temp dir then swaps, so a failed
 * sync never half-updates the active profile set.
 */
export async function syncProfiles(
  context: vscode.ExtensionContext,
  credentials: Credentials,
): Promise<ProfileSyncResult> {
  const repo = resolveProfilesRepo();
  if (!repo) {
    throw new Error('No profiles repository configured (set revvy.profiles.repoUrl).');
  }

  const { host, project, ref, subPath } = repo;
  const enc = encodeURIComponent(project);
  // Token is optional — public repos need none. We never prompt here.
  const token = await credentials.getToken('gitlab').catch(() => undefined);
  const client = new ProfileRepoClient(token || undefined);

  // 1. List YAML files at the configured path.
  const treeUrl =
    `${host}/api/v4/projects/${enc}/repository/tree` +
    `?ref=${encodeURIComponent(ref)}&per_page=100` +
    (subPath ? `&path=${encodeURIComponent(subPath)}` : '');
  const tree = await client.getJson<GitLabTreeEntry[]>(treeUrl);
  const yamlEntries = (Array.isArray(tree) ? tree : []).filter(
    e => e.type === 'blob' && /\.ya?ml$/i.test(e.name),
  );
  if (yamlEntries.length === 0) {
    throw new Error(
      `No .yaml profiles found in ${project}@${ref}${subPath ? '/' + subPath : ''}.`,
    );
  }

  // 2. Fetch each file's raw content into a temp dir.
  const cacheDir = getProfilesCacheDir(context, repo);
  const tmpDir = cacheDir + '.tmp';
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  let count = 0;
  for (const entry of yamlEntries) {
    const rawUrl =
      `${host}/api/v4/projects/${enc}/repository/files/` +
      `${encodeURIComponent(entry.path)}/raw?ref=${encodeURIComponent(ref)}`;
    const content = await client.getText(rawUrl);
    fs.writeFileSync(path.join(tmpDir, entry.name), content, 'utf8');
    count++;
  }

  // 3. Atomic swap tmp → cache.
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.renameSync(tmpDir, cacheDir);

  // 4. Templates (best-effort) — never fail the whole sync if the folder is
  //    absent. Stored in a separate cache dir so the rule loader never sees them.
  let templateCount = 0;
  if (repo.templatesPath) {
    try {
      const tplTreeUrl =
        `${host}/api/v4/projects/${enc}/repository/tree` +
        `?ref=${encodeURIComponent(ref)}&per_page=100&path=${encodeURIComponent(repo.templatesPath)}`;
      const tplTree = await client.getJson<GitLabTreeEntry[]>(tplTreeUrl);
      // Templates may be structured YAML or a plain-text/markdown report layout.
      const tplEntries = (Array.isArray(tplTree) ? tplTree : []).filter(
        e => e.type === 'blob' && /\.(ya?ml|txt|md)$/i.test(e.name),
      );
      const tplCacheDir = getTemplatesCacheDir(context, repo);
      const tplTmp = tplCacheDir + '.tmp';
      fs.rmSync(tplTmp, { recursive: true, force: true });
      fs.mkdirSync(tplTmp, { recursive: true });
      for (const entry of tplEntries) {
        const rawUrl =
          `${host}/api/v4/projects/${enc}/repository/files/` +
          `${encodeURIComponent(entry.path)}/raw?ref=${encodeURIComponent(ref)}`;
        fs.writeFileSync(path.join(tplTmp, entry.name), await client.getText(rawUrl), 'utf8');
        templateCount++;
      }
      fs.rmSync(tplCacheDir, { recursive: true, force: true });
      fs.renameSync(tplTmp, tplCacheDir);
      console.log(`[Revvy] synced ${templateCount} template file(s) from ${repo.templatesPath}/`);
    } catch (e: any) {
      console.log(`[Revvy] template sync skipped (path "${repo.templatesPath}"): ${e.message ?? e}`);
    }
  }

  return { count, templateCount, cacheDir, ref, project };
}

/**
 * Load the impact-analysis template from the synced templates cache.
 * Returns the first valid template found, or null when none is configured/synced.
 * Accepts sections as objects ({key,title,hint}) or plain strings (title only).
 */
export function loadImpactTemplate(context: vscode.ExtensionContext): ImpactTemplate | null {
  const repo = resolveProfilesRepo();
  if (!repo || !repo.templatesPath) { return null; }

  const dir = getTemplatesCacheDir(context, repo);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => /\.(ya?ml|txt|md)$/i.test(f));
    // Prefer structured YAML when both exist; otherwise plain-text templates.
    files.sort((a, b) => Number(/\.ya?ml$/i.test(b)) - Number(/\.ya?ml$/i.test(a)));
  } catch {
    return null;
  }

  const slug = (s: string) =>
    s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

  for (const f of files) {
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    if (!raw.trim()) { continue; }

    // Only attempt YAML parsing for .yaml/.yml files; .txt/.md are treated as
    // raw template text directly (so ASCII-box report layouts work as-is).
    let data: any;
    if (/\.ya?ml$/i.test(f)) {
      try { data = yaml.load(raw); } catch { data = undefined; }
    }

    const obj = (data && typeof data === 'object') ? data : undefined;
    const t = obj ? (obj.impact_template ?? obj.template ?? obj) : undefined;
    const label = (t && typeof t.label === 'string') ? t.label : 'Impact Analysis';
    const instructions = (t && typeof t.instructions === 'string') ? t.instructions : undefined;

    // 1. Structured mode: a list of sections.
    if (t && Array.isArray(t.sections) && t.sections.length > 0) {
      const sections = t.sections
        .map((s: any) => {
          const title = (typeof s === 'string' ? s : String(s?.title ?? s?.key ?? '')).trim();
          const rawKey = typeof s === 'string' ? s : String(s?.key ?? s?.title ?? '');
          return {
            key: slug(rawKey),
            title,
            hint: (s && typeof s.hint === 'string') ? s.hint : undefined,
          };
        })
        .filter((s: any) => s.key && s.title);
      if (sections.length > 0) {
        console.log(`[Revvy] impact template loaded (structured, ${sections.length} sections) from ${f}`);
        return { label, instructions, sections };
      }
    }

    // 2. Explicit free-form field in a YAML doc.
    const explicit =
      (t && typeof t.format === 'string' && t.format.trim() && t.format) ||
      (t && typeof t.body === 'string' && t.body.trim() && t.body) ||
      (typeof data === 'string' && data.trim() && data) ||
      '';
    if (explicit) {
      console.log(`[Revvy] impact template loaded (free-form field) from ${f}`);
      return { label, instructions, format: explicit };
    }

    // 3. Fallback: the whole file IS the template (any plain-text file works,
    //    valid YAML or not — e.g. an ASCII-box report layout).
    console.log(`[Revvy] impact template loaded (raw file) from ${f}`);
    return { label: 'Impact Analysis', format: raw };
  }
  console.log('[Revvy] no impact template found in the synced templates folder.');
  return null;
}
