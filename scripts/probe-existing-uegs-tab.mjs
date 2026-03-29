import { writeFile } from "node:fs/promises";

function parseArgs(argv) {
  const options = {
    websocketUrl: "",
    outputJson: "",
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

async function waitForUegsDebug(cdp, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ready = await evaluateJson(
      cdp,
      `(() => document.readyState === "complete" && Boolean(window.uegsDebug))()`,
    );
    if (ready) {
      return;
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for window.uegsDebug");
}

async function waitForInteractiveUegsRuntime(cdp, timeoutMs = 45000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await evaluateJson(
      cdp,
      "(() => window.uegsDebug?.getStartupState?.() ?? null)()",
    );
    if (state?.startupState && state.startupState !== "bootstrapping") {
      return state;
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for interactive UEGS runtime state");
}

async function readInspectorDomState(cdp) {
  return await evaluateJson(
    cdp,
    `(() => ({
      href: location.href,
      readyState: document.readyState,
      statusText: document.getElementById("status")?.textContent ?? null,
      summaryText: document.getElementById("summary")?.textContent ?? null,
      hasUegsDebug: Boolean(window.uegsDebug),
      hasSpark: Boolean(window.spark),
      startupState: window.uegsDebug?.getStartupState?.() ?? null,
    }))()`,
  );
}

async function captureScenario(cdp, scenario) {
  const expression = `
    (async () => {
      const d = window.uegsDebug;
      if (!d) {
        return { error: "missing uegsDebug" };
      }

      if (${JSON.stringify(scenario.pageUrl)} !== null) {
        location.href = ${JSON.stringify(scenario.pageUrl)};
        return { navigated: true };
      }

      await d.applyRuntimeConfiguration(
        {
          bakedShadow: ${scenario.bakedShadow},
          directLighting: ${scenario.directLighting},
          skyLighting: ${scenario.skyLighting},
          ambientOcclusion: ${scenario.ambientOcclusion},
          debugViewMode: ${scenario.debugViewMode},
        },
        { force: true, rebuild: true },
      );
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));

      return {
        digest: d.captureCanvasDigest(),
        runtimeState: d.getRuntimeState(),
      };
    })()
  `;
  return await evaluateJson(cdp, expression);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cdp = await openCdp(options.websocketUrl);
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.reload", { ignoreCache: true });
    await sleep(4500);
    let startupDiagnostics = null;
    try {
      await waitForUegsDebug(cdp);
      startupDiagnostics = {
        interactiveState: await waitForInteractiveUegsRuntime(cdp),
      };
    } catch (error) {
      startupDiagnostics = {
        error: error instanceof Error ? error.message : String(error),
        domState: await readInspectorDomState(cdp),
      };
      throw Object.assign(
        new Error(
          `Inspector startup failed: ${JSON.stringify(startupDiagnostics)}`,
        ),
        { cause: error },
      );
    }

    const baseline = await captureScenario(cdp, {
      pageUrl: null,
      bakedShadow: true,
      directLighting: true,
      skyLighting: true,
      ambientOcclusion: true,
      debugViewMode: 0,
      sortRadial: false,
      sort32: true,
      stochastic: false,
      surface2d: false,
    });
    const baseColor = await captureScenario(cdp, {
      pageUrl: null,
      bakedShadow: true,
      directLighting: true,
      skyLighting: true,
      ambientOcclusion: true,
      debugViewMode: 1,
      sortRadial: false,
      sort32: true,
      stochastic: false,
      surface2d: false,
    });
    const bakedShadowMask = await captureScenario(cdp, {
      pageUrl: null,
      bakedShadow: true,
      directLighting: true,
      skyLighting: true,
      ambientOcclusion: true,
      debugViewMode: 7,
      sortRadial: false,
      sort32: true,
      stochastic: false,
      surface2d: false,
    });
    const allLightingOff = await captureScenario(cdp, {
      pageUrl: null,
      bakedShadow: false,
      directLighting: false,
      skyLighting: false,
      ambientOcclusion: false,
      debugViewMode: 0,
      sortRadial: false,
      sort32: true,
      stochastic: false,
      surface2d: false,
    });

    const report = {
      baseline,
      baseColor,
      bakedShadowMask,
      allLightingOff,
      comparisons: {
        baselineVsBaseColor:
          baseline?.digest?.hash32 === baseColor?.digest?.hash32,
        baselineVsBakedShadowMask:
          baseline?.digest?.hash32 === bakedShadowMask?.digest?.hash32,
        baselineVsAllLightingOff:
          baseline?.digest?.hash32 === allLightingOff?.digest?.hash32,
      },
      startupDiagnostics,
    };

    await writeFile(
      options.outputJson,
      JSON.stringify(report, null, 2),
      "utf8",
    );
    console.log(options.outputJson);
  } finally {
    cdp.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
