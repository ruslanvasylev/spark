import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const options = {
    websocketUrl: "",
    outputDir: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--websocket-url":
        options.websocketUrl = next;
        index += 1;
        break;
      case "--output-dir":
        options.outputDir = next;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.websocketUrl) {
    throw new Error("--websocket-url is required");
  }
  if (!options.outputDir) {
    throw new Error("--output-dir is required");
  }

  return options;
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
  if (result.exceptionDetails) {
    const description =
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ??
      "Runtime.evaluate failed";
    throw new Error(description);
  }
  return result.result?.value ?? null;
}

function buildScenarioExpression(scenario) {
  return `
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
          debugViewMode: ${JSON.stringify(scenario.debugViewMode ?? 0)},
        },
        { force: true, rebuild: false },
      );

      spark.enable2DGS = ${JSON.stringify(scenario.enable2DGS)};
      spark.useUegsProjectedEllipse = ${JSON.stringify(
        scenario.useUegsProjectedEllipse,
      )};
      spark.opaqueShellCoverage = ${JSON.stringify(
        scenario.opaqueShellCoverage,
      )};
      spark.falloff = ${JSON.stringify(scenario.falloff)};

      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );

      return JSON.stringify({
        digest: d.captureCanvasDigest(),
        startup: d.getStartupState(),
        debugViewMode: d.getRuntimeState()?.bundleContract?.debugViewMode ?? null,
        renderContract: {
          enable2DGS: spark.enable2DGS ?? null,
          useUegsProjectedEllipse: spark.useUegsProjectedEllipse ?? null,
          opaqueShellCoverage: spark.opaqueShellCoverage ?? null,
          falloff: spark.falloff ?? null,
        },
      });
    })()
  `;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cdp = await openCdp(options.websocketUrl);
  const scenarios = [
    {
      name: "current",
      enable2DGS: false,
      useUegsProjectedEllipse: false,
      opaqueShellCoverage: true,
      falloff: 1,
      debugViewMode: 0,
    },
    {
      name: "projected-ellipse",
      enable2DGS: false,
      useUegsProjectedEllipse: true,
      opaqueShellCoverage: true,
      falloff: 1,
      debugViewMode: 0,
    },
  ];

  try {
    await fs.mkdir(options.outputDir, { recursive: true });
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    const report = [];
    for (const scenario of scenarios) {
      const value = await evaluateJson(cdp, buildScenarioExpression(scenario));
      const state =
        typeof value === "string" ? JSON.parse(value) : { error: "no-state" };
      const screenshot = await cdp.send("Page.captureScreenshot", {
        format: "png",
      });
      const filePath = path.join(options.outputDir, `${scenario.name}.png`);
      await fs.writeFile(filePath, Buffer.from(screenshot.data, "base64"));
      report.push({
        scenario,
        filePath,
        state,
      });
    }

    await fs.writeFile(
      path.join(options.outputDir, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(path.join(options.outputDir, "report.json"));
  } finally {
    cdp.close();
  }
}

void main();
