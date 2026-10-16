import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const source = new URL("node_modules/stockfish/", root);
const target = new URL("public/engine/", root);
const { version } = JSON.parse(
  await readFile(new URL("package.json", source), "utf8"),
);
if (version !== "19.0.1")
  throw new Error(
    "Update the engine adapter and asset filenames before upgrading Stockfish.",
  );
await mkdir(target, { recursive: true });
for (const name of [
  "stockfish-19-lite-single.js",
  "stockfish-19-lite-single.wasm",
]) {
  await copyFile(new URL(`bin/${name}`, source), new URL(name, target));
}
await copyFile(new URL("Copying.txt", source), new URL("Copying.txt", target));
await writeFile(
  new URL("SOURCE.txt", target),
  `Stockfish.js 19.0.1 — Stockfish 19 lite single-threaded\nCopyright Stockfish contributors, Nathan Rugg and contributors. GPL-3.0.\nLicense: Copying.txt (in this directory)\nCorresponding source, build scripts and network references for this exact version:\nhttps://github.com/nmrugg/stockfish.js/tree/v19.0.1\nSource archive: https://github.com/nmrugg/stockfish.js/archive/refs/tags/v19.0.1.tar.gz\nUpstream: https://github.com/official-stockfish/Stockfish\nThe engine files are copied unchanged from npm stockfish@19.0.1.\n`,
);
console.log(`Prepared Stockfish ${version} in ${fileURLToPath(target)}`);
