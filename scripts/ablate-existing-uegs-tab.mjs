import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const options = {
    websocketUrl: "",
    outputJson: "",
    screenshotDir: "",
    scenarioSet: "render-contracts",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--websocket-url":
        options.websocketUrl = next;
        index += 1;
        break;
      case "--output-json":
        options.outputJson = next;
        index += 1;
        break;
      case "--screenshot-dir":
        options.screenshotDir = next;
        index += 1;
        break;
      case "--scenario-set":
        options.scenarioSet = next;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.websocketUrl) {
    throw new Error("--websocket-url is required");
  }
  if (!options.outputJson) {
    throw new Error("--output-json is required");
  }
  return options;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms: ${label}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId != null) {
      clearTimeout(timeoutId);
    }
  }
}

async function openCdp(websocketUrl) {
  const ws = new WebSocket(websocketUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) {
      return;
    }
    const handlers = pending.get(message.id);
    if (!handlers) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      handlers.reject(new Error(JSON.stringify(message.error)));
      return;
    }
    handlers.resolve(message.result ?? {});
  });

  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      ws.close();
    },
  };
}

async function evaluateJson(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return result.result?.value ?? null;
}

async function evaluateString(cdp, expression) {
  const value = await evaluateJson(cdp, expression);
  return typeof value === "string" ? value : null;
}

async function readSparkBaseline(cdp) {
  const value = await evaluateString(
    cdp,
    `(() => JSON.stringify({
      minAlpha: window.spark?.minAlpha ?? null,
      maxStdDev: window.spark?.maxStdDev ?? null,
    }))()`,
  );
  return value ? JSON.parse(value) : { minAlpha: null, maxStdDev: null };
}

function getScenarioSet(name) {
  switch (name) {
    case "current-only":
      return [
        {
          name: "current",
          enable2DGS: false,
          useUegsProjectedEllipse: false,
          opaqueShellCoverage: false,
          falloff: 1,
        },
      ];
    case "render-contracts":
      return [
        {
          name: "current",
          enable2DGS: false,
          useUegsProjectedEllipse: false,
          opaqueShellCoverage: false,
          falloff: 1,
        },
        {
          name: "projected-ellipse",
          enable2DGS: false,
          useUegsProjectedEllipse: true,
          opaqueShellCoverage: false,
          falloff: 1,
        },
        {
          name: "surface-2d",
          enable2DGS: true,
          useUegsProjectedEllipse: false,
          opaqueShellCoverage: false,
          falloff: 1,
        },
      ];
    case "coverage":
      return [
        {
          name: "current",
          enable2DGS: false,
          useUegsProjectedEllipse: false,
          opaqueShellCoverage: false,
          falloff: 1,
          minAlpha: null,
          maxStdDev: null,
        },
        {
          name: "current-minalpha-0p01",
          enable2DGS: false,
          useUegsProjectedEllipse: false,
          opaqueShellCoverage: false,
          falloff: 1,
          minAlpha: 0.01,
          maxStdDev: null,
        },
        {
          name: "current-minalpha-0p02",
          enable2DGS: false,
          useUegsProjectedEllipse: false,
          opaqueShellCoverage: false,
          falloff: 1,
          minAlpha: 0.02,
          maxStdDev: null,
        },
        {
          name: "projected-ellipse",
          enable2DGS: false,
          useUegsProjectedEllipse: true,
          opaqueShellCoverage: false,
          falloff: 1,
          minAlpha: null,
          maxStdDev: null,
        },
        {
          name: "projected-ellipse-minalpha-0p01",
          enable2DGS: false,
          useUegsProjectedEllipse: true,
          opaqueShellCoverage: false,
          falloff: 1,
          minAlpha: 0.01,
          maxStdDev: null,
        },
      ];
    default:
      throw new Error(`Unsupported scenario set: ${name}`);
  }
}

async function applyScenario(cdp, scenario, baseline = {}) {
  const expression = `
    (async () => {
      const d = window.uegsDebug;
      const spark = window.spark;
      if (!d || !spark) {
        return { error: "missing runtime hooks" };
      }

      await d.applyRuntimeConfiguration(
        {
          bakedShadow: true,
          directLighting: true,
          skyLighting: true,
          ambientOcclusion: true,
          debugViewMode: 0,
        },
        { force: true, rebuild: true },
      );

      spark.enable2DGS = ${scenario.enable2DGS ? "true" : "false"};
      spark.useUegsProjectedEllipse = ${scenario.useUegsProjectedEllipse ? "true" : "false"};
      spark.opaqueShellCoverage = ${scenario.opaqueShellCoverage ? "true" : "false"};
      spark.falloff = ${JSON.stringify(scenario.falloff)};
      spark.minAlpha = ${JSON.stringify(scenario.minAlpha ?? baseline.minAlpha ?? null)};
      spark.maxStdDev = ${JSON.stringify(scenario.maxStdDev ?? baseline.maxStdDev ?? null)};

      await d.awaitRenderSync({ minActiveSplatsVersion: 0, stableFrames: 2, timeoutMs: 10000 });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      return JSON.stringify({
        digest: d.captureCanvasDigest(),
        runtimeState: d.getRuntimeState(),
      });
    })()
  `;
  const value = await evaluateString(cdp, expression);
  return value ? JSON.parse(value) : null;
}

async function captureCanvasPng(cdp, filePath) {
  const dataUrl = await evaluateString(
    cdp,
    "(() => window.uegsDebug?.captureCanvasPng?.() ?? null)()",
  );
  if (!dataUrl?.startsWith("data:image/png;base64,")) {
    throw new Error("Canvas PNG capture did not return a PNG data URL");
  }
  await fs.writeFile(
    filePath,
    Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64"),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cdp = await openCdp(options.websocketUrl);
  const scenarios = getScenarioSet(options.scenarioSet);
  const report = [];

  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const baseline = await readSparkBaseline(cdp);

    if (options.screenshotDir) {
      await fs.mkdir(options.screenshotDir, { recursive: true });
    }

    for (const scenario of scenarios) {
      console.error(`Applying scenario: ${scenario.name}`);
      const state = await withTimeout(
        applyScenario(cdp, scenario, baseline),
        60000,
        `applyScenario(${scenario.name})`,
      );
      if (!state || state.error) {
        report.push({
          scenario,
          error: state?.error ?? "unknown",
        });
        continue;
      }

      const result = {
        scenario,
        digest: state.digest,
        runtimeState: state.runtimeState,
      };

      if (options.screenshotDir) {
        const screenshotPath = path.join(
          options.screenshotDir,
          `${scenario.name}.png`,
        );
        await sleep(150);
        console.error(`Capturing canvas: ${scenario.name}`);
        await withTimeout(
          captureCanvasPng(cdp, screenshotPath),
          15000,
          `captureCanvasPng(${scenario.name})`,
        );
        result.screenshotPath = screenshotPath;
      }

      report.push(result);
    }

    const finalScenario = scenarios[0];
    console.error(`Restoring scenario: ${finalScenario.name}`);
    await withTimeout(
      applyScenario(cdp, finalScenario, baseline),
      60000,
      `restoreScenario(${finalScenario.name})`,
    );

    await fs.writeFile(
      options.outputJson,
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    cdp.close();
  }
}

void main();
