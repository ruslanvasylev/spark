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

type Manifest = Record<string, any>;

export type PromoteUegsHelmetViewersArgs = {
  assetsRoot: string;
  compositeDir: string;
  debugDir: string;
};

async function readManifest(bundleDir: string) {
  const manifestPath = path.join(bundleDir, "uegs_manifest.json");
  const text = await fs.readFile(manifestPath, "utf8");
  return JSON.parse(text) as Manifest;
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

function makeCacheToken(
  bundleDir: string,
  generatedAt: string | undefined,
  gaussianCount: number | null,
) {
  const bundleSlug = path.basename(bundleDir).slice(-8);
  const generatedSlug = (generatedAt ?? new Date().toISOString()).replace(
    /[^0-9A-Za-z]+/g,
    "",
  );
  const countSlug = Number.isFinite(gaussianCount) ? String(gaussianCount) : "unknown";
  return `${generatedSlug}-${bundleSlug}-${countSlug}`;
}

function buildCompositeConfig(inputDir: string, manifest: Manifest): RoleConfig {
  const hasSceneLighting = Boolean(manifest.scene_lighting_contract);
  return {
    role: "composite",
    inputDir,
    currentDirName: "current-composite",
    requiredFiles: [
      "uegs_manifest.json",
      "uegs_gaussians.spz",
      "uegs_gaussians_payload.bin",
      ...(hasSceneLighting ? ["uegs_scene_lighting.json"] : []),
    ],
    requirePayloadSidecar: true,
    requireSceneLighting: hasSceneLighting,
    requireDebugCapture: false,
  };
}

function buildDebugConfig(inputDir: string): RoleConfig {
  return {
    role: "debug",
    inputDir,
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
}

async function validateRole(config: RoleConfig, manifest: Manifest) {
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
}

async function promoteRole(
  assetsRoot: string,
  config: RoleConfig,
  manifest: Manifest,
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

  const gaussianCount =
    manifest.gaussian_seed_artifact?.gaussian_count ??
    manifest.gaussian_runtime_asset?.gaussian_count ??
    null;

  return {
    artifactDir: config.inputDir,
    currentDir,
    generatedAt: manifest.generated_at ?? null,
    gaussianCount,
    payloadSidecarPresent: Boolean(manifest.gaussian_payload_sidecar),
    sceneLightingPresent: Boolean(manifest.scene_lighting_contract),
    debugCapturePresent: Boolean(manifest.gaussian_debug_capture_sidecar),
    cacheToken: makeCacheToken(config.inputDir, manifest.generated_at, gaussianCount),
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
  compositeState: { sceneLightingPresent: boolean },
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
  if (compositeState.sceneLightingPresent) {
    legacyLinks["uegs_scene_lighting.json"] = path.join(
      compositeCurrentDir,
      "uegs_scene_lighting.json",
    );
    legacyLinks["current-baked-helmet-preview-lighting.json"] = path.join(
      compositeCurrentDir,
      "uegs_scene_lighting.json",
    );
  }
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

export async function promoteUegsHelmetViewers({
  assetsRoot,
  compositeDir,
  debugDir,
}: PromoteUegsHelmetViewersArgs) {
  const resolvedAssetsRoot = path.resolve(assetsRoot);
  const resolvedCompositeDir = path.resolve(compositeDir);
  const resolvedDebugDir = path.resolve(debugDir);

  await fs.mkdir(resolvedAssetsRoot, { recursive: true });

  const compositeManifest = await readManifest(resolvedCompositeDir);
  const debugManifest = await readManifest(resolvedDebugDir);
  const compositeConfig = buildCompositeConfig(resolvedCompositeDir, compositeManifest);
  const debugConfig = buildDebugConfig(resolvedDebugDir);

  await validateRole(compositeConfig, compositeManifest);
  await validateRole(debugConfig, debugManifest);

  const compositeState = await promoteRole(
    resolvedAssetsRoot,
    compositeConfig,
    compositeManifest,
  );
  const debugState = await promoteRole(resolvedAssetsRoot, debugConfig, debugManifest);

  await writeViewerState(resolvedAssetsRoot, {
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

  await writeLegacyCompositeAliases(
    resolvedAssetsRoot,
    compositeState.currentDir,
    compositeState,
  );
  await writeLegacyDebugAliases(resolvedAssetsRoot, debugState.currentDir);

  return {
    assetsRoot: resolvedAssetsRoot,
    composite: compositeState,
    debug: debugState,
  };
}
