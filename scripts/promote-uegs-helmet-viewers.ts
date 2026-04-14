import fs from "node:fs/promises";
import path from "node:path";

type Role = "composite" | "debug";

type RoleConfig = {
  role: Role;
  inputDir: string;
  currentDirName: string;
  requiredFiles: string[];
  requirePayloadSidecar: boolean;
  requireSceneLighting: boolean;
  requireDebugCapture: boolean;
};

type ViewerState = {
  schema: string;
  updatedAt: string;
  composite: Record<string, unknown>;
  debug: Record<string, unknown>;
};

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

async function readManifest(bundleDir: string) {
  const manifestPath = path.join(bundleDir, "uegs_manifest.json");
  const text = await fs.readFile(manifestPath, "utf8");
  return JSON.parse(text) as Record<string, any>;
}

async function ensureExists(filePath: string) {
  await fs.access(filePath);
}

async function ensureSymlink(targetPath: string, linkPath: string) {
  await fs.rm(linkPath, { force: true, recursive: true });
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  const stats = await fs.lstat(targetPath);
  await fs.symlink(targetPath, linkPath, stats.isDirectory() ? "dir" : "file");
}

function makeCacheToken(bundleDir: string, generatedAt: string | undefined, gaussianCount: number | null) {
  const bundleSlug = path.basename(bundleDir).slice(-8);
  const generatedSlug = (generatedAt ?? new Date().toISOString()).replace(/[^0-9A-Za-z]+/g, "");
  const countSlug = Number.isFinite(gaussianCount) ? String(gaussianCount) : "unknown";
  return `${generatedSlug}-${bundleSlug}-${countSlug}`;
}

async function validateRole(config: RoleConfig) {
  const manifest = await readManifest(config.inputDir);
  for (const fileName of config.requiredFiles) {
    await ensureExists(path.join(config.inputDir, fileName));
  }

  if (config.requirePayloadSidecar && !manifest.gaussian_payload_sidecar) {
    throw new Error(`${config.role}: manifest is missing gaussian_payload_sidecar`);
  }
  if (config.requireSceneLighting && !manifest.scene_lighting_contract) {
    throw new Error(`${config.role}: manifest is missing scene_lighting_contract`);
  }
  if (config.requireDebugCapture && !manifest.gaussian_debug_capture_sidecar) {
    throw new Error(`${config.role}: manifest is missing gaussian_debug_capture_sidecar`);
  }

  return manifest;
}

async function promoteRole(
  assetsRoot: string,
  config: RoleConfig,
  manifest: Record<string, any>,
) {
  const currentDir = path.join(assetsRoot, config.currentDirName);
  await fs.mkdir(currentDir, { recursive: true });

  const linkTargets: Record<string, string> = {
    "uegs_gaussians.spz": path.join(config.inputDir, "uegs_gaussians.spz"),
    "uegs_manifest.json": path.join(config.inputDir, "uegs_manifest.json"),
    "uegs_gaussians_payload.bin": path.join(config.inputDir, "uegs_gaussians_payload.bin"),
    bundle: config.inputDir,
  };
  if (config.requireSceneLighting) {
    linkTargets["uegs_scene_lighting.json"] = path.join(
      config.inputDir,
      "uegs_scene_lighting.json",
    );
  }
  if (config.requireDebugCapture) {
    linkTargets["uegs_captured_debug_passes.bin"] = path.join(
      config.inputDir,
      "uegs_captured_debug_passes.bin",
    );
  }

  for (const [name, target] of Object.entries(linkTargets)) {
    await ensureSymlink(target, path.join(currentDir, name));
  }

  return {
    artifactDir: config.inputDir,
    currentDir,
    generatedAt: manifest.generated_at ?? null,
    gaussianCount:
      manifest.gaussian_seed_artifact?.gaussian_count ??
      manifest.gaussian_runtime_asset?.gaussian_count ??
      null,
    payloadSidecarPresent: Boolean(manifest.gaussian_payload_sidecar),
    sceneLightingPresent: Boolean(manifest.scene_lighting_contract),
    debugCapturePresent: Boolean(manifest.gaussian_debug_capture_sidecar),
    cacheToken: makeCacheToken(
      config.inputDir,
      manifest.generated_at,
      manifest.gaussian_seed_artifact?.gaussian_count ?? null,
    ),
    files: {
      dir: `/examples/editor/assets/${config.currentDirName}`,
      spz: `/examples/editor/assets/${config.currentDirName}/uegs_gaussians.spz`,
      manifest: `/examples/editor/assets/${config.currentDirName}/uegs_manifest.json`,
      payload: `/examples/editor/assets/${config.currentDirName}/uegs_gaussians_payload.bin`,
      sceneLighting: config.requireSceneLighting
        ? `/examples/editor/assets/${config.currentDirName}/uegs_scene_lighting.json`
        : null,
      debugCapture: config.requireDebugCapture
        ? `/examples/editor/assets/${config.currentDirName}/uegs_captured_debug_passes.bin`
        : null,
      bundle: `/examples/editor/assets/${config.currentDirName}/bundle`,
    },
  };
}

async function writeViewerState(assetsRoot: string, state: ViewerState) {
  const statePath = path.join(assetsRoot, "current-uegs-viewers.json");
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function writeLegacyCompositeAliases(
  assetsRoot: string,
  compositeCurrentDir: string,
) {
  const legacyLinks: Record<string, string> = {
    "current-baked-helmet-preview.spz": path.join(
      compositeCurrentDir,
      "uegs_gaussians.spz",
    ),
    "current-baked-helmet-preview-manifest.json": path.join(
      compositeCurrentDir,
      "uegs_manifest.json",
    ),
    "current-baked-helmet-preview-payload.bin": path.join(
      compositeCurrentDir,
      "uegs_gaussians_payload.bin",
    ),
    "current-baked-helmet-preview-bundle": path.join(compositeCurrentDir, "bundle"),
    "uegs_manifest.json": path.join(compositeCurrentDir, "uegs_manifest.json"),
    "uegs_gaussians_payload.bin": path.join(
      compositeCurrentDir,
      "uegs_gaussians_payload.bin",
    ),
  };
  for (const [name, target] of Object.entries(legacyLinks)) {
    await ensureSymlink(target, path.join(assetsRoot, name));
  }
}

async function writeLegacyDebugAliases(assetsRoot: string, debugCurrentDir: string) {
  const legacyLinks: Record<string, string> = {
    "current-debug-helmet-preview-lighting.json": path.join(
      debugCurrentDir,
      "uegs_scene_lighting.json",
    ),
    "current-debug-helmet-preview-payload.bin": path.join(
      debugCurrentDir,
      "uegs_gaussians_payload.bin",
    ),
    "current-debug-helmet-preview-manifest.json": path.join(
      debugCurrentDir,
      "uegs_manifest.json",
    ),
    "current-debug-helmet-preview.spz": path.join(
      debugCurrentDir,
      "uegs_gaussians.spz",
    ),
    "current-debug-helmet-preview-bundle": path.join(debugCurrentDir, "bundle"),
    "current-debug-helmet-preview-debug-capture.bin": path.join(
      debugCurrentDir,
      "uegs_captured_debug_passes.bin",
    ),
    "uegs_scene_lighting.json": path.join(debugCurrentDir, "uegs_scene_lighting.json"),
    "uegs_captured_debug_passes.bin": path.join(
      debugCurrentDir,
      "uegs_captured_debug_passes.bin",
    ),
  };
  for (const [name, target] of Object.entries(legacyLinks)) {
    await ensureSymlink(target, path.join(assetsRoot, name));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const assetsRoot = path.resolve("examples/editor/assets");
  await fs.mkdir(assetsRoot, { recursive: true });

  const compositeConfig: RoleConfig = {
    role: "composite",
    inputDir: args.compositeDir,
    currentDirName: "current-composite",
    requiredFiles: [
      "uegs_manifest.json",
      "uegs_gaussians.spz",
      "uegs_gaussians_payload.bin",
    ],
    requirePayloadSidecar: true,
    requireSceneLighting: false,
    requireDebugCapture: false,
  };
  const debugConfig: RoleConfig = {
    role: "debug",
    inputDir: args.debugDir,
    currentDirName: "current-debug",
    requiredFiles: [
      "uegs_manifest.json",
      "uegs_gaussians.spz",
      "uegs_gaussians_payload.bin",
      "uegs_scene_lighting.json",
      "uegs_captured_debug_passes.bin",
    ],
    requirePayloadSidecar: true,
    requireSceneLighting: true,
    requireDebugCapture: true,
  };

  const compositeManifest = await validateRole(compositeConfig);
  const debugManifest = await validateRole(debugConfig);

  const compositeState = await promoteRole(assetsRoot, compositeConfig, compositeManifest);
  const debugState = await promoteRole(assetsRoot, debugConfig, debugManifest);

  await writeViewerState(assetsRoot, {
    schema: "spark-current-uegs-viewers-v1",
    updatedAt: new Date().toISOString(),
    composite: {
      ...compositeState,
      viewerUrl: "/examples/editor/current-uegs-composite.html",
    },
    debug: {
      ...debugState,
      viewerUrl: "/examples/editor/current-uegs-debug.html",
    },
  });

  await writeLegacyCompositeAliases(assetsRoot, compositeState.currentDir);
  await writeLegacyDebugAliases(assetsRoot, debugState.currentDir);

  console.log(
    JSON.stringify(
      {
        assetsRoot,
        composite: compositeState,
        debug: debugState,
      },
      null,
      2,
    ),
  );
}

void main();
