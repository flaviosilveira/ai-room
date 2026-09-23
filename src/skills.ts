import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Skills the human can see from the console: the project's own, the user's,
 * and those of installed Claude Code plugins. Found by their SKILL.md; read
 * only, never run — running one is an agent's job.
 */
export type SkillSource = "project" | "user" | "plugin";

export interface Skill {
  name: string;
  description: string;
  source: SkillSource;
  /** Where it was found, for the listing. */
  origin: string;
  path: string;
}

/** name and description from a SKILL.md frontmatter, folded blocks included. */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const field = (key: string): string | undefined => {
    const at = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (at === -1) return undefined;
    const inline = lines[at].slice(key.length + 1).trim();
    if (inline && !/^[>|][-+]?$/.test(inline)) return inline.replace(/^["']|["']$/g, "");
    const block: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (!/^\s+\S/.test(line)) break;
      block.push(line.trim());
    }
    return block.join(" ") || undefined;
  };
  return { name: field("name"), description: field("description") };
}

/** SKILL.md files under a root, a few levels deep (plugins group skills by category). */
function skillFiles(root: string, depth = 3): string[] {
  const found: string[] = [];
  const walk = (dir: string, level: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === "SKILL.md") found.push(full);
      else if ((entry.isDirectory() || entry.isSymbolicLink()) && level < depth) walk(full, level + 1);
    }
  };
  walk(root, 0);
  return found;
}

function pluginRoots(home: string): { root: string; origin: string }[] {
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(home, ".claude", "plugins", "installed_plugins.json"), "utf8")) as {
      plugins?: Record<string, { installPath?: string }[]>;
    };
    return Object.entries(registry.plugins ?? {}).flatMap(([id, installs]) =>
      installs
        .filter((install) => install.installPath)
        .map((install) => ({ root: path.join(install.installPath!, "skills"), origin: id.split("@")[0] }))
    );
  } catch {
    return [];
  }
}

export function discoverSkills(cwd: string = process.cwd(), home: string = os.homedir()): Skill[] {
  const roots: { root: string; source: SkillSource; origin: string }[] = [
    ...[".claude/skills", ".agents/skills", "skills"].map((rel) => ({ root: path.join(cwd, rel), source: "project" as const, origin: rel })),
    ...[".claude/skills", ".agents/skills", ".codex/skills"].map((rel) => ({
      root: path.join(home, rel),
      source: "user" as const,
      origin: `~/${rel}`,
    })),
    ...pluginRoots(home).map(({ root, origin }) => ({ root, source: "plugin" as const, origin })),
  ];

  // First one wins: a project skill shadows a user or plugin skill of the same name.
  const skills = new Map<string, Skill>();
  for (const { root, source, origin } of roots) {
    for (const file of skillFiles(root)) {
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const meta = parseSkillFrontmatter(text);
      const name = meta.name ?? path.basename(path.dirname(file));
      if (skills.has(name)) continue;
      skills.set(name, { name, description: meta.description ?? "", source, origin, path: file });
    }
  }
  return [...skills.values()];
}

const SOURCE_TITLE: Record<SkillSource, string> = { project: "projeto", user: "usuário", plugin: "plugins" };

export function renderSkills(skills: Skill[], width = process.stdout.columns || 100): string {
  if (!skills.length) return "nenhuma skill encontrada (projeto, ~/.claude/skills, ~/.agents/skills ou plugins).";
  const nameWidth = Math.min(28, Math.max(...skills.map((s) => s.name.length)) + 2);
  const lines: string[] = [];
  for (const source of ["project", "user", "plugin"] as SkillSource[]) {
    const group = skills.filter((s) => s.source === source).sort((a, b) => a.name.localeCompare(b.name));
    if (!group.length) continue;
    lines.push(`${SOURCE_TITLE[source]} (${group.length})`);
    for (const skill of group) {
      const room = Math.max(20, width - nameWidth - skill.origin.length - 6);
      const description = skill.description.length > room ? `${skill.description.slice(0, room - 1)}…` : skill.description;
      lines.push(`  ${skill.name.padEnd(nameWidth - 1)} ${description.padEnd(room)}  ${skill.origin}`);
    }
  }
  return lines.join("\n");
}
