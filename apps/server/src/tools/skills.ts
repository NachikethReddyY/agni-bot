/** Skill tools with Progressive Disclosure.
 *
 * Level 0: skills_list() returns a compact catalog (name, description) for
 *   advertising in the system prompt.
 * Level 1: skills_load({ name }) returns the full SKILL.md body on demand.
 * Level 2: skills_resource({ skill_name, relative_path }) reads a supplementary
 *   file (references/, scripts/, etc.) from inside an already-loaded skill dir.
 *
 * Each skill lives at ~/.agni/skills/<name>/SKILL.md with optional YAML
 * frontmatter for name/description/category metadata.
 */
import { homePath } from "../home";
import { join, resolve, relative } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";

const SKILLS_DIR = homePath("skills");

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  category: string | null;
  body: string;
  dirPath: string;
  resources: string[];
}

/** Parse metadata from the top of a skill markdown file.
 * Supports both YAML frontmatter (--- delimited) and plain key: value
 * header lines (e.g. "name: html-communicator") used by fleet skills.
 * Returns { data: { name?, description?, category? }, body }.
 */
function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const data: Record<string, string> = {};
  let body = raw;

  const frontMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (frontMatch) {
    const block = frontMatch[1] ?? "";
    for (const line of block.split("\n")) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim().replace(/^"|"$|^'|'$/g, "");
      if (key) data[key] = value;
    }
    body = raw.slice(frontMatch[0].length).trimStart();
    return { data, body };
  }

  // Plain header: key: value lines at the very top, until a blank line or heading.
  const lines = raw.split("\n");
  let headerEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") { headerEnd = i; break; }
    if (line.startsWith("#")) { headerEnd = i; break; }
    const colon = line.indexOf(":");
    if (colon < 0) { headerEnd = i; break; }
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim().replace(/^"|"$|^'|'$/g, "");
    if (key && value) data[key] = value;
    headerEnd = i + 1;
  }
  body = lines.slice(headerEnd).join("\n").trimStart();
  return { data, body };
}

export function loadSkillRegistry(): Map<string, SkillEntry> {
  const registry = new Map<string, SkillEntry>();
  let entries: string[];
  try { entries = readdirSync(SKILLS_DIR); } catch { return registry; }
  for (const entry of entries) {
    const dirPath = join(SKILLS_DIR, entry);
    let st: ReturnType<typeof statSync>;
    try { st = statSync(dirPath); } catch { continue; }
    if (!st.isDirectory()) continue;
    const skillMd = join(dirPath, "SKILL.md");
    let raw: string;
    try { raw = readFileSync(skillMd, "utf8"); } catch { continue; }
    const { data, body } = parseFrontmatter(raw);
    const name = data.name ?? entry;
    const id = data.name ?? entry;
    // Collect Level 2 resources from references/ and scripts/
    const resources: string[] = [];
    for (const sub of ["references", "scripts"]) {
      const subDir = join(dirPath, sub);
      try {
        for (const f of readdirSync(subDir)) resources.push(`${sub}/${f}`);
      } catch { /* no such subdir */ }
    }
    registry.set(name, {
      id,
      name,
      description: data.description ?? "",
      category: data.category ?? null,
      body,
      dirPath,
      resources,
    });
  }
  return registry;
}

/** Level 0: compact catalog — name + description only, for system prompt injection. */
export function skillsList(): { skills: { name: string; description: string }[] } {
  const registry = loadSkillRegistry();
  const skills = Array.from(registry.values()).map((s) => ({
    name: s.name,
    description: s.description,
  }));
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills };
}

/** Level 1: load the full SKILL.md body for a skill by name. */
export interface SkillsLoadArgs { name: string; }

export interface SkillsLoadResult {
  name: string;
  description: string;
  category: string | null;
  instructions: string;
  available_resources: string[];
}

export function skillsLoad(args: SkillsLoadArgs): SkillsLoadResult | null {
  const registry = loadSkillRegistry();
  const skill = registry.get(args.name);
  if (!skill) return null;
  return {
    name: skill.name,
    description: skill.description,
    category: skill.category,
    instructions: skill.body,
    available_resources: skill.resources,
  };
}

/** Level 2: read a supplementary resource file inside a skill directory. */
export interface SkillsResourceArgs {
  skill_name: string;
  relative_path: string;
}

export interface SkillsResourceResult {
  skill_name: string;
  path: string;
  content: string;
}

export function skillsResource(args: SkillsResourceArgs): SkillsResourceResult | null {
  const registry = loadSkillRegistry();
  const skill = registry.get(args.skill_name);
  if (!skill) return null;
  const safePath = resolve(skill.dirPath, args.relative_path);
  const skillDirResolved = resolve(skill.dirPath);
  if (!safePath.startsWith(skillDirResolved + "/") && safePath !== skillDirResolved) {
    return null;
  }
  if (!skill.resources.includes(args.relative_path)) {
    return null;
  }
  let content: string;
  try { content = readFileSync(safePath, "utf8"); } catch { return null; }
  return { skill_name: skill.name, path: args.relative_path, content };
}

/** Build the Level 0 catalog block for injection into the system prompt. */
export function skillsCatalogBlock(): string {
  const { skills } = skillsList();
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return `<available_skills>
You have access to specialized procedural skills. Whenever a user's request matches one
of the skills below, you MUST call the \`skills_load\` tool with its exact name BEFORE
writing code or running bash commands, and then follow its instructions.

${lines}
</available_skills>`;
}
