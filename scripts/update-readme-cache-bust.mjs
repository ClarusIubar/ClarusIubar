import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const readmePath = "README.md";
const assetPaths = [
  { path: "metrics/contribution-activity.svg", pattern: /src="\.\/metrics\/contribution-activity\.svg(?:\?v=[^"]*)?"/ },
  { path: "metrics/metrics.languages.linguist.svg", pattern: /src="\.\/metrics\/metrics\.languages\.linguist\.svg(?:\?v=[^"]*)?"/ },
];

function cacheKey(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

const readme = await readFile(readmePath, "utf8");
const updated = (await Promise.all(
  assetPaths.map(async ({ path: assetPath, pattern }) => {
    const key = cacheKey(await readFile(assetPath));
    return { assetPath, pattern, key };
  }),
)).reduce((content, { assetPath, pattern, key }) => {
  if (!pattern.test(content)) {
    throw new Error(`Could not find README image reference for ${assetPath}.`);
  }
  return content.replace(pattern, `src="./${assetPath}?v=${key}"`);
}, readme);

await writeFile(readmePath, updated, "utf8");
console.log("Updated README metric asset cache keys.");
