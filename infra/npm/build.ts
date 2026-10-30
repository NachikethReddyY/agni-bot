/**
 * Stage the `agni-bot` npm package in dist/npm.
 *
 * The package mirrors the repo layout (apps/server/src, apps/web/dist,
 * infra/env.example) so every relative path the server uses still resolves,
 * and ships @agni/protocol as a bundled dependency since it is not published.
 *
 *   bun run npm:build              then: cd dist/npm && npm publish
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const out = join(root, "dist", "npm");
const read = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

if (!existsSync(join(root, "apps/web/dist/index.html"))) {
  throw new Error("apps/web/dist is missing; run `bun run web:build` first");
}

rmSync(out, { recursive: true, force: true });
const copy = (from: string, to = from) => cpSync(join(root, from), join(out, to), { recursive: true });
copy("apps/server/src");
copy("apps/web/dist");
copy("infra/env.example");
copy("infra/npm/README.md", "README.md");

const pkg = read("infra/npm/package.json");
const server = read("apps/server/package.json");
const protocol = read("packages/protocol/package.json");

// Its own deps (zod) come from the top-level dependencies below; listing them
// here makes npm treat them as bundled too and install an empty zod.
copy("packages/protocol/src", "node_modules/@agni/protocol/src");
writeFileSync(
  join(out, "node_modules/@agni/protocol/package.json"),
  `${JSON.stringify({ ...protocol, version: pkg.version, scripts: undefined, devDependencies: undefined, dependencies: undefined }, null, 2)}\n`,
);

pkg.dependencies = {
  ...protocol.dependencies,
  ...server.dependencies,
  "@agni/protocol": pkg.version,
};
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`staged agni-bot@${pkg.version} in ${out}`);
