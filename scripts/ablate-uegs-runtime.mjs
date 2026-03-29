import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

function parseArgs(argv) {
  const options = {
    chromePath: "/usr/bin/google-chrome",
    timeoutMs: 120000,
    virtualTimeBudgetMs: 15000,
    windowSize: "1400,1000",
    pageUrl: "",
    outputJson: "",
    bundleDir: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--page-url":
        options.pageUrl = next;
        i += 1;
        break;
      case "--output-json":
        options.outputJson = next;
        i += 1;
        break;
      case "--bundle-dir":
        options.bundleDir = next;
        i += 1;
        break;
      case "--chrome-path":
        options.chromePath = next;
        i += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(next);
        i += 1;
        break;
      case "--virtual-time-budget-ms":
        options.virtualTimeBudgetMs = Number(next);
        i += 1;
        break;
      case "--window-size":
        options.windowSize = next;
        i += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.pageUrl) {
    throw new Error("--page-url is required");
  }
  if (!options.outputJson) {
    throw new Error("--output-json is required");
  }
  return options;
}

function withJsonStem(outputJson) {
  return outputJson.endsWith(".json")
    ? outputJson.slice(0, -".json".length)
    : outputJson;
}

async function waitForExit(child, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out waiting for Chrome after ${timeoutMs}ms`));
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Chrome exited with code=${code ?? "null"} signal=${signal ?? "null"}`,
        ),
      );
    });
  });
}

function updateQuery(baseUrl, overrides) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(overrides)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function hashFile(filePath) {
  const bytes = await readFile(filePath);
  return {
    filePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  };
}

async function readJsonMaybe(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function hashFileMaybe(filePath) {
  try {
    return await hashFile(filePath);
  } catch {
    return null;
  }
}

async function captureInspectorState({ pageUrl, outputPng, timeoutMs }) {
  const summaryJson = `${outputPng}.json`;
  const capture = spawn(
    "node",
    [
      "scripts/capture-uegs-inspector.mjs",
      "--timeout-ms",
      String(timeoutMs),
      "--page-url",
      pageUrl,
      "--output-png",
      outputPng,
      "--summary-json",
      summaryJson,
      "--hide-overlay",
    ],
    {
      cwd: "/home/ruslan/code/sparkjsdev/spark",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  capture.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  capture.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  let processError = null;
  try {
    await waitForExit(capture, timeoutMs + 15000);
  } catch (error) {
    processError = error instanceof Error ? error.message : String(error);
  }

  return {
    ok: processError == null,
    processError,
    stdout,
    stderr,
    summary: await readJsonMaybe(summaryJson),
    screenshot: await hashFileMaybe(outputPng),
  };
}

async function inspectBundle(bundleDir) {
  if (!bundleDir) {
    return null;
  }

  const inspect = spawn(
    "node",
    [
      "--no-warnings",
      "--loader",
      "ts-node/esm",
      "scripts/inspect-uegs-bundle.ts",
      bundleDir,
    ],
    {
      cwd: "/home/ruslan/code/sparkjsdev/spark",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  inspect.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  inspect.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  await waitForExit(inspect, 120000).catch((error) => {
    if (stderr.trim()) {
      console.error(stderr);
    }
    throw error;
  });

  return JSON.parse(stdout);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const stem = withJsonStem(options.outputJson);
  const bundleInspect = await inspectBundle(options.bundleDir);

  const states = [
    {
      key: "baseline",
      label: "baseline-final",
      overrides: {
        auto: 0,
        overlay: 0,
        sortRadial: 0,
        sort32: 1,
        surface2d: 1,
        bakedShadow: 1,
        directLight: 1,
        skyLight: 1,
        ambientOcclusion: 1,
        debugView: 0,
      },
    },
    {
      key: "bakedShadowMask",
      label: "baked-shadow-mask",
      overrides: {
        auto: 0,
        overlay: 0,
        sortRadial: 0,
        sort32: 1,
        surface2d: 1,
        bakedShadow: 1,
        directLight: 1,
        skyLight: 1,
        ambientOcclusion: 1,
        debugView: 7,
      },
    },
    {
      key: "directLightingShadowed",
      label: "direct-lighting-shadowed",
      overrides: {
        auto: 0,
        overlay: 0,
        sortRadial: 0,
        sort32: 1,
        surface2d: 1,
        bakedShadow: 1,
        directLight: 1,
        skyLight: 1,
        ambientOcclusion: 1,
        debugView: 3,
      },
    },
    {
      key: "directLightingUnshadowed",
      label: "direct-lighting-unshadowed",
      overrides: {
        auto: 0,
        overlay: 0,
        sortRadial: 0,
        sort32: 1,
        surface2d: 1,
        bakedShadow: 0,
        directLight: 1,
        skyLight: 1,
        ambientOcclusion: 1,
        debugView: 3,
      },
    },
    {
      key: "directLightingDisabled",
      label: "direct-lighting-disabled",
      overrides: {
        auto: 0,
        overlay: 0,
        sortRadial: 0,
        sort32: 1,
        surface2d: 1,
        bakedShadow: 0,
        directLight: 0,
        skyLight: 1,
        ambientOcclusion: 1,
        debugView: 3,
      },
    },
    {
      key: "legacySortPolicy",
      label: "legacy-radial-half-sort",
      overrides: {
        auto: 0,
        overlay: 0,
        sortRadial: 1,
        sort32: 0,
        surface2d: 1,
        bakedShadow: 1,
        directLight: 1,
        skyLight: 1,
        ambientOcclusion: 1,
        debugView: 0,
      },
    },
    {
      key: "legacyThin3dShell",
      label: "legacy-thin-3d-shell",
      overrides: {
        auto: 0,
        overlay: 0,
        sortRadial: 0,
        sort32: 1,
        surface2d: 0,
        bakedShadow: 1,
        directLight: 1,
        skyLight: 1,
        ambientOcclusion: 1,
        debugView: 0,
      },
    },
  ];

  const captures = {};
  for (const state of states) {
    const pageUrl = updateQuery(options.pageUrl, state.overrides);
    const outputPng = `${stem}-${state.label}.png`;
    console.error(`ablate:capture-start ${state.label}`);
    const capture = await captureInspectorState({
      pageUrl,
      outputPng,
      timeoutMs: options.timeoutMs,
    });
    captures[state.key] = {
      pageUrl,
      ...state.overrides,
      capture,
    };
    console.error(`ablate:capture-done ${state.label}`);
  }

  const exportedBakedShadowStats =
    bundleInspect?.summary?.payloadTelemetry?.bakedShadow ?? {};
  const shadowed = captures.directLightingShadowed?.capture?.screenshot ?? {};
  const unshadowed =
    captures.directLightingUnshadowed?.capture?.screenshot ?? {};
  const disabled = captures.directLightingDisabled?.capture?.screenshot ?? {};
  const mask = captures.bakedShadowMask?.capture?.screenshot ?? {};
  const uniqueHashes = new Set(
    Object.values(captures).map(
      (capture) => capture?.capture?.screenshot?.sha256 ?? "",
    ),
  );
  const baselineRuntime =
    captures.baseline?.capture?.summary?.runtimeState ?? null;
  const maskRuntime =
    captures.bakedShadowMask?.capture?.summary?.runtimeState ?? null;
  const shadowedRuntime =
    captures.directLightingShadowed?.capture?.summary?.runtimeState ?? null;
  const unshadowedRuntime =
    captures.directLightingUnshadowed?.capture?.summary?.runtimeState ?? null;
  const disabledRuntime =
    captures.directLightingDisabled?.capture?.summary?.runtimeState ?? null;
  const legacySortRuntime =
    captures.legacySortPolicy?.capture?.summary?.runtimeState ?? null;
  const legacyThin3dRuntime =
    captures.legacyThin3dShell?.capture?.summary?.runtimeState ?? null;
  const captureFailures = Object.values(captures).filter(
    (capture) => capture?.capture?.summary?.captureStatus !== "ok",
  ).length;

  const report = {
    pageUrl: options.pageUrl,
    bundleDir: options.bundleDir || null,
    bundleInspect,
    captures,
    comparisons: {
      viewerRuntimeReady:
        captures.baseline?.capture?.summary?.captureStatus === "ok",
      viewerRuntimeFailureCount: captureFailures,
      viewerRuntimeFailureReasons: Object.fromEntries(
        Object.entries(captures).map(([key, capture]) => [
          key,
          capture?.capture?.summary?.error ??
            capture?.capture?.processError ??
            null,
        ]),
      ),
      runtimeSummaryAvailable: baselineRuntime != null,
      runtimeBakedShadowAdvertised:
        baselineRuntime?.sparkRuntime?.bakedShadowTransferAvailable === true,
      runtimeBakedShadowToggleReflected:
        shadowedRuntime?.bundleContract?.bakedShadowRuntimeEnabled === true &&
        unshadowedRuntime?.bundleContract?.bakedShadowRuntimeEnabled === false,
      runtimeDirectLightingToggleReflected:
        shadowedRuntime?.bundleContract?.directLightingRuntimeEnabled ===
          true &&
        disabledRuntime?.bundleContract?.directLightingRuntimeEnabled === false,
      runtimeDebugViewToggleReflected:
        maskRuntime?.bundleContract?.debugViewMode === 7,
      runtimeSortToggleReflected:
        baselineRuntime?.viewpointContract?.runtime?.sortRadial === false &&
        baselineRuntime?.viewpointContract?.runtime?.sort32 === true &&
        legacySortRuntime?.viewpointContract?.runtime?.sortRadial === true &&
        legacySortRuntime?.viewpointContract?.runtime?.sort32 === false,
      runtimeSurface2dToggleReflected:
        baselineRuntime?.renderContract?.runtime?.enable2DGS === true &&
        legacyThin3dRuntime?.renderContract?.runtime?.enable2DGS === false,
      viewerCaptureSurfaceUsable: uniqueHashes.size > 1,
      allViewerCapturesIdentical: uniqueHashes.size === 1,
      exportedBakedShadowTransferAdvertised:
        bundleInspect?.manifest?.bakedGeometryShadowTransferExported === true,
      exportedBakedShadowNonTrivial:
        Number(exportedBakedShadowStats.max ?? 0) >
        Number(exportedBakedShadowStats.min ?? 0) + 1.0e-4,
      bakedShadowMaskChangesImage:
        mask.sha256 !== captures.baseline?.capture?.screenshot?.sha256,
      bakedShadowModulatesDirect: shadowed.sha256 !== unshadowed.sha256,
      directLightingAffectsImage: unshadowed.sha256 !== disabled.sha256,
      legacySortPolicyChangesImage:
        captures.legacySortPolicy?.capture?.screenshot?.sha256 !==
        captures.baseline?.capture?.screenshot?.sha256,
      surface2dPolicyChangesImage:
        captures.legacyThin3dShell?.capture?.screenshot?.sha256 !==
        captures.baseline?.capture?.screenshot?.sha256,
    },
  };

  await writeFile(options.outputJson, JSON.stringify(report, null, 2), "utf8");
  console.error(`ablate:wrote ${options.outputJson}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
