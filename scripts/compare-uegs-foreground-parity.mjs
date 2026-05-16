#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  computeForegroundParityReport,
  createMaskImage,
  readImageFile,
  writePngFile,
} from "./lib/uegs-foreground-parity.mjs";

function parseArgs(argv) {
  const options = {
    ueReference: "",
    sparkComposite: "",
    sparkDebug: "",
    ueSplatPreview: "",
    outputJson: "",
    outputMaskPng: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--ue-reference":
        options.ueReference = next;
        index += 1;
        break;
      case "--spark-composite":
        options.sparkComposite = next;
        index += 1;
        break;
      case "--spark-debug":
        options.sparkDebug = next;
        index += 1;
        break;
      case "--ue-splat-preview":
        options.ueSplatPreview = next;
        index += 1;
        break;
      case "--output-json":
        options.outputJson = next;
        index += 1;
        break;
      case "--output-mask-png":
        options.outputMaskPng = next;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.ueReference) {
    throw new Error("--ue-reference is required");
  }
  if (!options.sparkComposite) {
    throw new Error("--spark-composite is required");
  }
  return options;
}

async function readOptionalImage(filePath) {
  return filePath ? await readImageFile(filePath) : null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const ueReference = await readImageFile(options.ueReference);
  const sparkComposite = await readImageFile(options.sparkComposite);
  const sparkDebug = await readOptionalImage(options.sparkDebug);
  const ueSplatPreview = await readOptionalImage(options.ueSplatPreview);

  const { report, objectMask } = computeForegroundParityReport({
    ueReference,
    sparkComposite,
    sparkDebug,
    ueSplatPreview,
  });
  report.inputs = {
    ueReference: options.ueReference,
    sparkComposite: options.sparkComposite,
    sparkDebug: options.sparkDebug || null,
    ueSplatPreview: options.ueSplatPreview || null,
  };

  if (options.outputMaskPng) {
    await mkdir(dirname(options.outputMaskPng), { recursive: true });
    await writePngFile(
      options.outputMaskPng,
      createMaskImage(objectMask, ueReference.width, ueReference.height),
    );
    report.outputs = {
      ...(report.outputs ?? {}),
      objectMaskPng: options.outputMaskPng,
    };
  }

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.outputJson) {
    await mkdir(dirname(options.outputJson), { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(options.outputJson, json);
  }
  process.stdout.write(json);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
