import fs from "node:fs/promises";
import path from "node:path";
import { verifyUegsViewerPairArtifacts } from "./lib/verify-uegs-helmet-viewers.mjs";

function parseArgs(argv) {
  const options = {
    baseUrl: "http://127.0.0.1:4180/examples/editor",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--base-url":
        options.baseUrl = next;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.json();
}

async function fetchHead(url) {
  const response = await fetch(url, {
    method: "HEAD",
    cache: "no-store",
  });
  return {
    ok: response.ok,
    status: response.status,
    contentLength: response.headers.get("content-length"),
    contentType: response.headers.get("content-type"),
  };
}

async function verifyViewerPage(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Viewer page failed to load ${url}: ${response.status}`);
  }
  const text = await response.text();
  assert(
    text.includes("current-uegs-viewer-bootstrap.js") ||
      text.includes("current-uegs-compare.js"),
    `Viewer page ${url} is missing the expected current UEGS bootstrap script`,
  );
  return {
    status: response.status,
    titlePresent: text.includes("Spark • Current UEGS"),
  };
}

async function verifyFileExists(filePath) {
  await fs.access(filePath);
}

async function verifyRole(baseUrl, role, preset) {
  const manifest = await fetchJson(
    `${new URL(preset.files.manifest, baseUrl).toString()}?cb=${encodeURIComponent(preset.cacheToken)}`,
  );
  const spzHead = await fetchHead(
    `${new URL(preset.files.spz, baseUrl).toString()}?cb=${encodeURIComponent(preset.cacheToken)}`,
  );
  const payloadHead = await fetchHead(
    `${new URL(preset.files.payload, baseUrl).toString()}?cb=${encodeURIComponent(preset.cacheToken)}`,
  );

  assert(spzHead.ok, `${role}: SPZ fetch failed (${spzHead.status})`);
  assert(
    payloadHead.ok,
    `${role}: payload fetch failed (${payloadHead.status})`,
  );
  assert(
    manifest.gaussian_seed_artifact?.gaussian_count === preset.gaussianCount,
    `${role}: manifest gaussian count drifted`,
  );
  assert(
    Boolean(manifest.gaussian_payload_sidecar) ===
      Boolean(preset.payloadSidecarPresent),
    `${role}: payload sidecar presence drifted`,
  );
  assert(
    Boolean(manifest.scene_lighting_contract) ===
      Boolean(preset.sceneLightingPresent),
    `${role}: scene lighting presence drifted`,
  );
  assert(
    Boolean(manifest.gaussian_debug_capture_sidecar) ===
      Boolean(preset.debugCapturePresent),
    `${role}: debug capture presence drifted`,
  );

  if (role === "debug") {
    const lightingHead = await fetchHead(
      `${new URL(preset.files.sceneLighting, baseUrl).toString()}?cb=${encodeURIComponent(preset.cacheToken)}`,
    );
    const debugHead = await fetchHead(
      `${new URL(preset.files.debugCapture, baseUrl).toString()}?cb=${encodeURIComponent(preset.cacheToken)}`,
    );
    assert(
      lightingHead.ok,
      `${role}: scene lighting fetch failed (${lightingHead.status})`,
    );
    assert(
      debugHead.ok,
      `${role}: debug capture fetch failed (${debugHead.status})`,
    );
  }

  await verifyFileExists(path.join(preset.currentDir, "uegs_gaussians.spz"));
  await verifyFileExists(path.join(preset.currentDir, "uegs_manifest.json"));
  await verifyFileExists(
    path.join(preset.currentDir, "uegs_gaussians_payload.bin"),
  );
  if (role === "debug") {
    await verifyFileExists(
      path.join(preset.currentDir, "uegs_scene_lighting.json"),
    );
    await verifyFileExists(
      path.join(preset.currentDir, "uegs_captured_debug_passes.bin"),
    );
  }

  return {
    generatedAt: preset.generatedAt,
    gaussianCount: preset.gaussianCount,
    cacheToken: preset.cacheToken,
    manifestOutputDir: manifest.output_dir ?? null,
    spzHead,
    payloadHead,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const stateUrl = `${options.baseUrl}/assets/current-uegs-viewers.json`;
  const state = await fetchJson(stateUrl);

  const compositePage = `${options.baseUrl}/current-uegs-composite.html`;
  const debugPage = `${options.baseUrl}/current-uegs-debug.html`;
  const comparePage = `${options.baseUrl}/current-uegs-compare.html`;
  const compositePageState = await verifyViewerPage(compositePage);
  const debugPageState = await verifyViewerPage(debugPage);
  const comparePageState = await verifyViewerPage(comparePage);
  const composite = await verifyRole(
    options.baseUrl,
    "composite",
    state.composite,
  );
  const debug = await verifyRole(options.baseUrl, "debug", state.debug);
  const artifactPair = await verifyUegsViewerPairArtifacts({
    compositeDir: state.composite.currentDir,
    debugDir: state.debug.currentDir,
  });

  console.log(
    JSON.stringify(
      {
        stateUrl,
        compositePage,
        debugPage,
        comparePage,
        compositePageState,
        debugPageState,
        comparePageState,
        composite,
        debug,
        artifactPair,
        note: "This verifier freezes viewer-state, alias, and manifest/file drift. Runtime bundle attachment should still be checked with the canonical 4180 viewer or capture harness when doing render debugging.",
      },
      null,
      2,
    ),
  );
}

void main();
