import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const currentViewerBootstrap = readFileSync(
  "examples/editor/current-uegs-viewer-bootstrap.js",
  "utf8",
);
const existingTabAblationScript = readFileSync(
  "scripts/ablate-existing-uegs-tab.mjs",
  "utf8",
);

test("current UEGS viewer bootstrap defaults to Gaussian coverage rather than opaque shell coverage", () => {
  assert.match(
    currentViewerBootstrap,
    /setDefault\("opaqueShellCoverage",\s*0\)/,
    "current viewer wrappers should not advertise opaque-shell coverage by default; UEGS render contracts own this live value",
  );
  assert.doesNotMatch(
    currentViewerBootstrap,
    /setDefault\("opaqueShellCoverage",\s*1\)/,
    "stale opaque-shell URL defaults can mask the true Gaussian baked-final contract",
  );
});

test("existing-tab UEGS ablations do not reintroduce opaque shell coverage", () => {
  assert.doesNotMatch(
    existingTabAblationScript,
    /opaqueShellCoverage:\s*true/,
    "render ablations should isolate ellipse/2D/coverage knobs without forcing opaque shell disks",
  );
});
