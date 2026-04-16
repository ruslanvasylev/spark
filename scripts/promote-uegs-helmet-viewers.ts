import path from "node:path";
import { promoteUegsHelmetViewers } from "./lib/promote-uegs-helmet-viewers.js";

function parseArgs(argv: string[]) {
  let compositeDir = "";
  let debugDir = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--composite-dir":
        compositeDir = next;
        index += 1;
        break;
      case "--debug-dir":
        debugDir = next;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!compositeDir) {
    throw new Error("--composite-dir is required");
  }
  if (!debugDir) {
    throw new Error("--debug-dir is required");
  }
  return {
    compositeDir: path.resolve(compositeDir),
    debugDir: path.resolve(debugDir),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await promoteUegsHelmetViewers({
    assetsRoot: path.resolve("examples/editor/assets"),
    compositeDir: args.compositeDir,
    debugDir: args.debugDir,
  });
  console.log(JSON.stringify(result, null, 2));
}

void main();
