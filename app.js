import { computeGvsPositionSubdivided, computeMultilayerResponse } from "./solver.js";
import { solveTransientTransport } from "./transientTransportSolver.js";
import { computeStressHistoryFromTransport } from "./transportStressCoupling.js";

const defaultState = {
  analysisMode: "thermal",
  thermal: {
    TbotC: 800,
    TtopC: 1300,
    interfaceConductances: [1e4, 1e7],
  },
  layers: [
    { name: "Layer 1", hMm: 3, EGPa: 200, nu: 0.3, thetaMilli: 0, alphaMicro: 15, kWmK: 25, TrefC: 70 },
    { name: "Layer 2", hMm: 2, EGPa: 40, nu: 0.2, thetaMilli: 0, alphaMicro: 11, kWmK: 1, TrefC: 70 },
    { name: "Layer 3", hMm: 1, EGPa: 100, nu: 0.2, thetaMilli: 0, alphaMicro: 11, kWmK: 2, TrefC: 70 },
  ],
};

let state = JSON.parse(JSON.stringify(defaultState));
const defaultTransientState = {
  transportMode: "chemical",
  boundaryMode: "dirichlet",
  boundary: {
    bottomValue: 0,
    topValue: 1e-6,
    transferCoefficient: 5,
    ambientValue: 1e-6,
  },
  time: {
    dt: 0.005,
    tMax: 0.5,
    outputTimesText: "0, 0.1, 0.25, 0.5",
  },
  output: {
    finalProfileTable: "hide",
  },
  stressCoupling: {
    enabled: "off",
    condition: "planestrain",
    referenceValue: 0,
  },
  layers: [
    {
      name: "Layer 1",
      hUm: 10,
      diffusivity: 100,
      elements: 30,
      source: 0,
      reactionRate: 0,
      storageCoefficient: 1,
      initialBottom: 0,
      initialTop: 0,
      EGPa: 100,
      nu: 0.3,
      swellingCoefficient: 1000,
    },
    {
      name: "Layer 2",
      hUm: 10,
      diffusivity: 20,
      elements: 30,
      source: 0,
      reactionRate: 0,
      storageCoefficient: 1,
      initialBottom: 0,
      initialTop: 0,
      EGPa: 80,
      nu: 0.24,
      swellingCoefficient: 4000,
    },
  ],
};
let transientState = JSON.parse(JSON.stringify(defaultTransientState));
let lastTransientResponse = null;
const COLORS = ["#7f1d1d", "#dc2626", "#f97316", "#f59e0b", "#facc15", "#fde047", "#ffedd5", "#991b1b"];

function formatNumber(value, digits = 4) {
  if (!Number.isFinite(value)) return "NaN";
  if (Math.abs(value) < 1e-12) return "0";
  if (Math.abs(value) >= 1e4 || Math.abs(value) < 1e-3) return value.toExponential(3);
  return Number(value.toPrecision(digits)).toString();
}

/** Tick labels: fixed significant digits (e.g. Chart.js axis). */
function formatSignificantDigits(value, significantDigits) {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return "0";
  return value.toPrecision(significantDigits);
}

function getTransientLabels() {
  const isThermal = transientState.transportMode === "thermal";
  return {
    fieldVar:       isThermal ? "Temperature" : "Concentration",
    fieldUnit:      isThermal ? "K" : "mol/μm³",
    diffusivityCol: isThermal ? "α (μm²/hr)" : "D (μm²/hr)",
    diffusivitySym: isThermal ? "α" : "D",
    sourceCol:      isThermal ? "Heat source (K/hr)" : "Source (mol/(μm³·hr))",
    initBottom:     isThermal ? "Initial bottom (K)" : "Initial bottom (mol/μm³)",
    initTop:        isThermal ? "Initial top (K)" : "Initial top (mol/μm³)",
    bottomValue:    isThermal ? "Bottom value (K)" : "Bottom value (mol/μm³)",
    topValue:       isThermal ? "Top value (K)" : "Top value (mol/μm³)",
    ambientValue:   isThermal ? "Ambient top value (K)" : "Ambient top value (mol/μm³)",
    referenceValue: isThermal ? "Reference Value (K)" : "Reference Value (mol/μm³)",
    plotXAxis:      isThermal ? "Temperature (K)" : "Concentration (mol/μm³)",
    plotTitle:      isThermal ? "Position vs temperature" : "Position vs concentration",
    tableHeader:    isThermal ? "Temperature (K)" : "Concentration (mol/μm³)",
  };
}

function destroyChart(id) {
  const chart = window.Chart?.getChart(id);
  if (chart) chart.destroy();
}

function typesetMath() {
  if (window.MathJax?.typesetPromise) {
    window.MathJax.typesetPromise();
  }
}

function syncInterfaceConductances() {
  const expectedInterfaces = Math.max(0, state.layers.length - 1);
  while (state.thermal.interfaceConductances.length < expectedInterfaces) {
    state.thermal.interfaceConductances.push(1e6);
  }
  state.thermal.interfaceConductances = state.thermal.interfaceConductances.slice(0, expectedInterfaces);
}

function readInput(prestressCondition = "biaxial") {
  const base = { prestressCondition, errMode: "classic" };
  if (state.analysisMode === "mismatch") {
    return {
      ...base,
      layers: state.layers.map((layer) => ({
        name: layer.name,
        h: layer.hMm * 1e-3,
        E: layer.EGPa * 1e9,
        nu: layer.nu,
        theta: layer.thetaMilli * 1e-3,
      })),
    };
  }

  const expectedInterfaces = Math.max(0, state.layers.length - 1);
  syncInterfaceConductances();
  const interfaceConductances = state.thermal.interfaceConductances.slice(0, expectedInterfaces);
  if (interfaceConductances.length !== expectedInterfaces) {
    throw new Error(
      `Thermal mode requires ${expectedInterfaces} interface conductance value(s) for ${state.layers.length} layers.`
    );
  }
  if (interfaceConductances.some((value) => !Number.isFinite(value))) {
    throw new Error("Interface conductances must be valid numbers.");
  }
  if (interfaceConductances.some((value) => value <= 0)) {
    throw new Error("Interface conductances must be positive.");
  }

  return {
    ...base,
    layers: state.layers.map((layer) => ({
      name: layer.name,
      h: layer.hMm * 1e-3,
      E: layer.EGPa * 1e9,
      nu: layer.nu,
      alpha: layer.alphaMicro * 1e-6,
      k: layer.kWmK,
      Tref: layer.TrefC,
    })),
    thermal: {
      Tbot: state.thermal.TbotC,
      Ttop: state.thermal.TtopC,
      interfaceConductances,
    },
  };
}

function buildMechanicalLayers(input, temperature) {
  if (!input.thermal) {
    return input.layers.map((layer) => ({
      name: layer.name,
      h: layer.h,
      E: layer.E,
      nu: layer.nu,
      thetaBot: layer.theta,
      thetaTop: layer.theta,
    }));
  }
  return input.layers.map((layer, i) => ({
    name: layer.name,
    h: layer.h,
    E: layer.E,
    nu: layer.nu,
    thetaBot: layer.alpha * (temperature.layers[i].Tbot - layer.Tref),
    thetaTop: layer.alpha * (temperature.layers[i].Ttop - layer.Tref),
  }));
}

function renderTable() {
  const thead = document.getElementById("layer-thead");
  const tbody = document.getElementById("layer-tbody");
  const isMismatch = state.analysisMode === "mismatch";
  thead.innerHTML = isMismatch
    ? `
      <tr>
        <th>#</th>
        <th>Name</th>
        <th><span class="symbol-label">h</span> (mm)</th>
        <th><span class="symbol-label">E</span> (GPa)</th>
        <th><span class="symbol-label">ν</span></th>
        <th><span class="unit-inline"><span class="symbol-label">θ</span> (×10⁻³)</span></th>
        <th>Action</th>
      </tr>
    `
    : `
      <tr>
        <th>#</th>
        <th>Name</th>
        <th><span class="symbol-label">h</span> (mm)</th>
        <th><span class="symbol-label">E</span> (GPa)</th>
        <th><span class="symbol-label">ν</span></th>
        <th><span class="unit-inline"><span class="symbol-label">α</span> (×10⁻⁶/K)</span></th>
        <th><span class="unit-inline"><span class="symbol-label">k</span> (W/m·K)</span></th>
        <th><span class="unit-inline"><span class="symbol-label">T<sub>ref</sub></span> (°C)</span></th>
        <th>Action</th>
      </tr>
    `;
  tbody.innerHTML = "";
  state.layers.forEach((layer, i) => {
    const row = document.createElement("tr");
    row.innerHTML = isMismatch
      ? `
      <td>${i + 1}</td>
      <td><input value="${layer.name}" data-k="name" data-i="${i}" /></td>
      <td><input type="number" step="any" value="${layer.hMm}" data-k="hMm" data-i="${i}" /></td>
      <td><input type="number" step="any" value="${layer.EGPa}" data-k="EGPa" data-i="${i}" /></td>
      <td><input type="number" step="any" value="${layer.nu}" data-k="nu" data-i="${i}" /></td>
      <td><input type="number" step="any" value="${layer.thetaMilli}" data-k="thetaMilli" data-i="${i}" /></td>
      <td><button ${state.layers.length <= 1 ? "disabled" : ""} data-remove="${i}">Remove</button></td>
    `
      : `
      <td>${i + 1}</td>
      <td><input value="${layer.name}" data-k="name" data-i="${i}" /></td>
      <td><input type="number" step="any" value="${layer.hMm}" data-k="hMm" data-i="${i}" /></td>
      <td><input type="number" step="any" value="${layer.EGPa}" data-k="EGPa" data-i="${i}" /></td>
      <td><input type="number" step="any" value="${layer.nu}" data-k="nu" data-i="${i}" /></td>
      <td><input type="number" step="any" value="${layer.alphaMicro}" data-k="alphaMicro" data-i="${i}" /></td>
      <td><input type="number" step="any" value="${layer.kWmK}" data-k="kWmK" data-i="${i}" /></td>
      <td><input type="number" step="any" value="${layer.TrefC}" data-k="TrefC" data-i="${i}" /></td>
      <td><button ${state.layers.length <= 1 ? "disabled" : ""} data-remove="${i}">Remove</button></td>
    `;
    tbody.appendChild(row);
  });
  typesetMath();
}

function renderModeControls() {
  const thermalControls = document.getElementById("thermal-controls");
  const interfaceControls = document.getElementById("interface-conductance-controls");
  const expectedInterfaces = Math.max(0, state.layers.length - 1);
  syncInterfaceConductances();
  thermalControls.hidden = state.analysisMode !== "thermal";
  interfaceControls.innerHTML =
    expectedInterfaces === 0
      ? `<div class="interface-card">No bonded interfaces exist for a single-layer stack.</div>`
      : state.thermal.interfaceConductances
          .map(
            (value, i) => `
        <div class="interface-card">
          <label>
            Interface ${i + 1}: ${state.layers[i].name} / ${state.layers[i + 1].name}<br>
            <span class="unit-inline"><span class="symbol-label">k<sub>int,${i + 1}</sub></span> (W/m²K)</span>
            <input type="number" step="any" value="${value}" data-interface-index="${i}" />
          </label>
        </div>
      `
          )
          .join("");
  typesetMath();
}

function parseOutputTimes(text) {
  const values = text
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));
  if (values.length === 0) {
    throw new Error("Enter at least one output time.");
  }
  return values;
}

function syncTransientInterfaceInitialValues(changedIndex, changedKey) {
  if (changedKey === "initialTop" && transientState.layers[changedIndex + 1]) {
    transientState.layers[changedIndex + 1].initialBottom = transientState.layers[changedIndex].initialTop;
  }
  if (changedKey === "initialBottom" && transientState.layers[changedIndex - 1]) {
    transientState.layers[changedIndex - 1].initialTop = transientState.layers[changedIndex].initialBottom;
  }
}

function renderTransientTable() {
  const tbody = document.getElementById("transient-layer-tbody");
  tbody.innerHTML = "";
  transientState.layers.forEach((layer, i) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${i + 1}</td>
      <td><input value="${layer.name}" data-transient-k="name" data-transient-i="${i}" /></td>
      <td><input type="number" step="any" value="${layer.hUm}" data-transient-k="hUm" data-transient-i="${i}" /></td>
      <td><input type="number" step="any" value="${layer.diffusivity}" data-transient-k="diffusivity" data-transient-i="${i}" /></td>
      <td><input type="number" step="1" value="${layer.elements}" data-transient-k="elements" data-transient-i="${i}" /></td>
      <td><input type="number" step="any" value="${layer.source}" data-transient-k="source" data-transient-i="${i}" /></td>
      <td><input type="number" step="any" value="${layer.reactionRate}" data-transient-k="reactionRate" data-transient-i="${i}" /></td>
      <td><input type="number" step="any" value="${layer.storageCoefficient}" data-transient-k="storageCoefficient" data-transient-i="${i}" /></td>
      <td><input type="number" step="any" value="${layer.initialBottom}" data-transient-k="initialBottom" data-transient-i="${i}" /></td>
      <td><input type="number" step="any" value="${layer.initialTop}" data-transient-k="initialTop" data-transient-i="${i}" /></td>
      <td><button ${transientState.layers.length <= 1 ? "disabled" : ""} data-remove-transient="${i}">Remove</button></td>
    `;
    tbody.appendChild(row);
  });
  applyTransientLabels();
}

function applyTransientLabels() {
  const L = getTransientLabels();
  // boundary spans
  const setSpan = (id, text) => {
    const el = document.querySelector(`#${id} .unit-inline`);
    if (el) el.textContent = text;
  };
  setSpan("transient-bottom-value-label", L.bottomValue);
  setSpan("transient-top-value-label",    L.topValue);
  setSpan("transient-ambient-label",      L.ambientValue);
  // reference value label
  const refSpan = document.querySelector("#transient-stress-reference-label .unit-inline");
  if (refSpan) refSpan.textContent = L.referenceValue;
  // layer table headers
  const setTh = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  setTh("th-diffusivity",    `<span class="symbol-label">${L.diffusivitySym}</span> (μm²/hr)`);
  setTh("th-source",         L.sourceCol);
  setTh("th-initial-bottom", L.initBottom);
  setTh("th-initial-top",    L.initTop);
}

function renderTransientBoundaryControls() {
  const isConvective = transientState.boundaryMode === "convectiveTop";
  const isBackNoFlux = transientState.boundaryMode === "dirichletTopNoFluxBottom";
  document.getElementById("transient-bottom-value-label").hidden = isBackNoFlux;
  document.getElementById("transient-top-value-label").hidden = isConvective;
  document.getElementById("transient-transfer-label").hidden = !isConvective;
  document.getElementById("transient-ambient-label").hidden = !isConvective;
  applyTransientLabels();
}

function renderTransientStressControls() {
  const enabled = transientState.stressCoupling.enabled === "on";
  document.getElementById("transient-stress-condition-label").hidden = !enabled;
  document.getElementById("transient-stress-reference-label").hidden = !enabled;
  document.getElementById("transient-stress-properties").hidden = !enabled;
}

function renderTransientMechTable() {
  const tbody = document.getElementById("transient-mech-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  transientState.layers.forEach((layer, i) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${i + 1}</td>
      <td>${layer.name}</td>
      <td><input type="number" step="any" value="${layer.EGPa}" data-transient-mech-k="EGPa" data-transient-mech-i="${i}" /></td>
      <td><input type="number" step="any" value="${layer.nu}" data-transient-mech-k="nu" data-transient-mech-i="${i}" /></td>
      <td><input type="number" step="any" value="${layer.swellingCoefficient}" data-transient-mech-k="swellingCoefficient" data-transient-mech-i="${i}" /></td>
    `;
    tbody.appendChild(row);
  });
}

function readTransientInput() {
  const outputTimes = parseOutputTimes(transientState.time.outputTimesText);
  const baseBoundary = { bottom: transientState.boundary.bottomValue };
  let boundaryConditions;
  if (transientState.boundaryMode === "dirichletTopNoFluxBottom") {
    boundaryConditions = {
      type: "dirichletTopNoFluxBottom",
      top: transientState.boundary.topValue,
    };
  } else if (transientState.boundaryMode === "dirichlet") {
    boundaryConditions = {
      type: "dirichlet",
      ...baseBoundary,
      top: transientState.boundary.topValue,
    };
  } else {
    boundaryConditions = {
      type: "convectiveTop",
      ...baseBoundary,
      transferCoefficient: transientState.boundary.transferCoefficient,
      ambient: transientState.boundary.ambientValue,
    };
  }

  return {
    layers: transientState.layers.map((layer) => ({
      name: layer.name,
      h: layer.hUm,
      diffusivity: layer.diffusivity,
      elements: Math.round(layer.elements),
      source: layer.source,
      reactionRate: layer.reactionRate,
      storageCoefficient: layer.storageCoefficient,
      initial: { type: "linear", bottom: layer.initialBottom, top: layer.initialTop },
    })),
    boundaryConditions,
    time: {
      dt: transientState.time.dt,
      tMax: transientState.time.tMax,
      outputTimes,
    },
  };
}

function renderTransientResults(response, stressHistory) {
  lastTransientResponse = response;
  const final = response.finalProfile;
  const stressPlot = stressHistory
    ? `<div class="plot-box"><div class="plot-title">Position vs Stress (Swelling Mismatch)</div><canvas id="plot-transient-stress" width="700" height="500"></canvas></div>`
    : "";
  document.getElementById("transient-results").innerHTML = `
    <div class="metrics">
      <div class="metric-card"><div class="metric-label">Final time (hr)</div><div class="metric-value">${formatNumber(final.time, 6)}</div></div>
    </div>
    <div class="controls no-export">
      <label>
        Final profile node table
        <select id="transient-final-profile-display">
          <option value="hide" ${transientState.output.finalProfileTable === "hide" ? "selected" : ""}>Hide node table</option>
          <option value="show" ${transientState.output.finalProfileTable === "show" ? "selected" : ""}>Show all final-profile nodes</option>
        </select>
      </label>
    </div>
    <div id="transient-final-profile-table"></div>
    <div class="plots">
      <div class="plot-box"><div class="plot-title">${getTransientLabels().plotTitle}</div><canvas id="plot-transient-profile" width="700" height="500"></canvas></div>
      ${stressPlot}
    </div>
  `;
  renderTransientFinalProfileTable(response);
  renderTransientProfileChart("plot-transient-profile", response.profiles);
  if (stressHistory) {
    renderTransientStressChart("plot-transient-stress", stressHistory);
  }
}

function renderTransientStressChart(canvasId, stressHistory) {
  destroyChart(canvasId);
  const datasets = stressHistory.map((item, i) => {
    const points = [];
    item.stresses.forEach((stress) => {
      points.push({ x: stress.stressBot / 1e6, y: stress.yb });
      points.push({ x: stress.stressTop / 1e6, y: stress.yt });
    });
    return {
      label: `t = ${formatNumber(item.time, 5)}`,
      data: points,
      borderColor: COLORS[i % COLORS.length],
      backgroundColor: COLORS[i % COLORS.length],
      borderWidth: 2.5,
      pointRadius: 0,
      showLine: true,
    };
  });
  return new Chart(canvasId, {
    type: "scatter",
    data: { datasets },
    options: chartOptions("Stress (MPa)", "Position (μm)", true),
  });
}

function renderTransientFinalProfileTable(response) {
  const container = document.getElementById("transient-final-profile-table");
  if (!container) return;
  if (!response || transientState.output.finalProfileTable !== "show") {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = `
    <h3>Final Profile Nodes</h3>
    <table>
      <thead>
        <tr><th>Position (μm)</th><th>${getTransientLabels().tableHeader}</th><th>Layer</th></tr>
      </thead>
      <tbody>
        ${response.finalProfile.points
          .map(
            (point) => `
          <tr>
            <td>${formatNumber(point.y, 6)}</td>
            <td>${formatNumber(point.value, 6)}</td>
            <td>${point.layerName}</td>
          </tr>
        `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderTransientProfileChart(canvasId, profiles) {
  destroyChart(canvasId);
  const datasets = profiles.map((profile, i) => ({
    label: `t = ${formatNumber(profile.time, 5)}`,
    data: profile.points.map((point) => ({ x: point.value, y: point.y })),
    borderColor: COLORS[i % COLORS.length],
    backgroundColor: COLORS[i % COLORS.length],
    borderWidth: 2.5,
    pointRadius: 0,
    showLine: true,
  }));
  const base = chartOptions(getTransientLabels().plotXAxis, "Position (μm)", true);
  return new Chart(canvasId, {
    type: "scatter",
    data: { datasets },
    options: {
      ...base,
      scales: {
        ...base.scales,
        x: {
          ...base.scales.x,
          ticks: {
            ...base.scales.x.ticks,
            callback: (value) => formatSignificantDigits(value, 3),
          },
        },
      },
    },
  });
}

function renderStressRows(stresses) {
  return stresses
    .map(
      (layer) => `
      <tr>
        <td>${layer.name}</td>
        <td>${formatNumber(layer.stressBot / 1e6)}</td>
        <td>${formatNumber(layer.stressTop / 1e6)}</td>
        <td>${formatNumber(layer.yb * 1e3)}</td>
        <td>${formatNumber(layer.yt * 1e3)}</td>
      </tr>
    `
    )
    .join("");
}

function renderErrRows(interfaceDelamination) {
  return interfaceDelamination.length === 0
      ? `<tr><td colspan="4">No interfaces (single-layer stack).</td></tr>`
      : interfaceDelamination
          .map(
            (item, i) => `
      <tr>
        <td>${i + 1} (${item.between[0]} / ${item.between[1]})</td>
        <td>${formatNumber(item.modes.classic)}</td>
        <td>${formatNumber(item.modes.planestrain)}</td>
        <td>${formatNumber(item.modes.biaxial)}</td>
      </tr>
    `
          )
          .join("");
}

function renderTemperatureRows(temperature, layerNames) {
  return temperature
    ? temperature.layers
        .map(
          (t, i) => `
      <tr>
        <td>${layerNames[i]}</td>
        <td>${formatNumber(t.Tbot, 5)}</td>
        <td>${formatNumber(t.Ttop, 5)}</td>
      </tr>
    `
        )
        .join("")
    : `<tr><td colspan="3">No thermal model requested (direct mismatch strain input).</td></tr>`;
}

function renderResults(psResult, bxResult, mechanicalLayers) {
  const psRadius = Math.abs(psResult.curvature) > 1e-20 ? 1 / psResult.curvature : Infinity;
  const bxRadius = Math.abs(bxResult.curvature) > 1e-20 ? 1 / bxResult.curvature : Infinity;
  const layerNames = state.layers.map((layer) => layer.name);
  document.getElementById("results").innerHTML = `
    <div class="metrics">
      <div class="metric-card"><div class="metric-label">Plane Strain <span class="symbol-label">ε<sub>0</sub></span> (—)</div><div class="metric-value">${formatNumber(psResult.epsilon0, 6)}</div></div>
      <div class="metric-card"><div class="metric-label">Plane Strain Curvature <span class="symbol-label">κ</span></div><div class="metric-value">${formatNumber(psResult.curvature, 6)} m⁻¹</div></div>
      <div class="metric-card"><div class="metric-label">Plane Strain Radius <span class="symbol-label">1/κ</span></div><div class="metric-value">${Number.isFinite(psRadius) ? formatNumber(psRadius, 6) : "∞"} m</div></div>
      <div class="metric-card"><div class="metric-label">Biaxial <span class="symbol-label">ε<sub>0</sub></span> (—)</div><div class="metric-value">${formatNumber(bxResult.epsilon0, 6)}</div></div>
      <div class="metric-card"><div class="metric-label">Biaxial Curvature <span class="symbol-label">κ</span></div><div class="metric-value">${formatNumber(bxResult.curvature, 6)} m⁻¹</div></div>
      <div class="metric-card"><div class="metric-label">Biaxial Radius <span class="symbol-label">1/κ</span></div><div class="metric-value">${Number.isFinite(bxRadius) ? formatNumber(bxRadius, 6) : "∞"} m</div></div>
      ${bxResult.temperature ? `<div class="metric-card"><div class="metric-label">Heat Flux <span class="symbol-label">q</span></div><div class="metric-value">${formatNumber(bxResult.temperature.heatFlux, 6)} W/m²</div></div>` : ""}
    </div>

    <h3>Plane Strain Layer Stresses (MPa)</h3>
    <table>
      <thead>
        <tr><th>Layer</th><th><span class="symbol-label">σ<sub>bottom</sub></span> (MPa)</th><th><span class="symbol-label">σ<sub>top</sub></span> (MPa)</th><th><span class="symbol-label">y<sub>bottom</sub></span> (mm)</th><th><span class="symbol-label">y<sub>top</sub></span> (mm)</th></tr>
      </thead>
      <tbody>${renderStressRows(psResult.layerStress)}</tbody>
    </table>

    <h3>Biaxial Layer Stresses (MPa)</h3>
    <table>
      <thead>
        <tr><th>Layer</th><th><span class="symbol-label">σ<sub>bottom</sub></span> (MPa)</th><th><span class="symbol-label">σ<sub>top</sub></span> (MPa)</th><th><span class="symbol-label">y<sub>bottom</sub></span> (mm)</th><th><span class="symbol-label">y<sub>top</sub></span> (mm)</th></tr>
      </thead>
      <tbody>${renderStressRows(bxResult.layerStress)}</tbody>
    </table>

    <h3>Interfacial Delamination Driving Force G (J/m²)</h3>
    <table>
      <thead>
        <tr><th>Interface</th><th>Classic (J/m²)</th><th>Plane Strain (J/m²)</th><th>Biaxial (J/m²)</th></tr>
      </thead>
      <tbody>${renderErrRows(bxResult.interfaceDelamination)}</tbody>
    </table>

    <h3>Temperature Profile</h3>
    <table>
      <thead>
        <tr><th>Layer</th><th><span class="symbol-label">T<sub>bottom</sub></span> (°C)</th><th><span class="symbol-label">T<sub>top</sub></span> (°C)</th></tr>
      </thead>
      <tbody>${renderTemperatureRows(bxResult.temperature, layerNames)}</tbody>
    </table>

    <div class="plots">
      ${bxResult.temperature ? `<div class="plot-box"><div class="plot-title">Position vs Temperature</div><canvas id="plot-temp" width="700" height="500"></canvas></div>` : ""}
      <div class="plot-box"><div class="plot-title">Position vs Stress <span class="line-convention"><span class="line-swatch solid">Plane strain deformation</span><span class="line-swatch dotted">Biaxial</span></span></div><canvas id="plot-stress" width="700" height="500"></canvas></div>
      ${bxResult.interfaceDelamination.length > 0 ? `<div class="plot-box"><div class="plot-title">Energy Release Rate vs Condition</div><canvas id="plot-err" width="700" height="500"></canvas></div>
      <div class="plot-box"><div class="plot-title">Position of Delamination vs Energy Release Rate</div><canvas id="plot-g-position" width="700" height="500"></canvas></div>` : ""}
    </div>
  `;
  typesetMath();
  if (bxResult.temperature) renderTemperatureChart("plot-temp", bxResult.temperature.layers, bxResult.layerStress, layerNames);
  renderStressComparisonChart("plot-stress", psResult.layerStress, bxResult.layerStress, layerNames);
  if (bxResult.interfaceDelamination.length > 0) {
    renderErrChart("plot-err", bxResult.interfaceDelamination);
    renderGvsPositionChart("plot-g-position", mechanicalLayers, layerNames);
  }
}

function renderStressComparisonChart(canvasId, psStress, bxStress, names) {
  destroyChart(canvasId);
  const datasets = [];
  psStress.forEach((layer, i) => {
    datasets.push({
      label: `Plane Strain ${names[i]}`,
      data: [{ x: layer.stressBot / 1e6, y: layer.yb * 1e3 }, { x: layer.stressTop / 1e6, y: layer.yt * 1e3 }],
      borderColor: COLORS[i % COLORS.length],
      backgroundColor: COLORS[i % COLORS.length],
      borderWidth: 2.5,
      pointRadius: 3,
      showLine: true,
    });
    const bx = bxStress[i];
    datasets.push({
      label: `Biaxial ${names[i]}`,
      data: [{ x: bx.stressBot / 1e6, y: bx.yb * 1e3 }, { x: bx.stressTop / 1e6, y: bx.yt * 1e3 }],
      borderColor: COLORS[i % COLORS.length],
      backgroundColor: COLORS[i % COLORS.length],
      borderDash: [2, 5],
      borderWidth: 2,
      pointRadius: 3,
      showLine: true,
    });
  });
  addStressInterfaceConnectors(datasets, psStress, bxStress);
  const options = chartOptions("Stress (MPa)", "Position (mm)", true);
  const allStress = [...psStress, ...bxStress].flatMap((layer) => [layer.stressBot / 1e6, layer.stressTop / 1e6]);
  const maxAbsStress = Math.max(...allStress.map((value) => Math.abs(value)), 0);
  if (maxAbsStress < 1e-6) {
    options.scales.x.min = -1;
    options.scales.x.max = 1;
    options.scales.x.ticks.callback = (value) => formatNumber(value);
  }
  options.plugins.legend.labels.generateLabels = () =>
    names.map((name, i) => ({
      text: name,
      fillStyle: COLORS[i % COLORS.length],
      strokeStyle: COLORS[i % COLORS.length],
      fontColor: "#ffffff",
      lineWidth: 4,
      hidden: false,
      datasetIndex: i * 2,
    }));
  options.plugins.legend.onClick = () => {};
  return new Chart(canvasId, {
    type: "scatter",
    data: { datasets },
    options,
  });
}

function addStressInterfaceConnectors(datasets, psStress, bxStress) {
  for (let i = 0; i < psStress.length - 1; i += 1) {
    const psLower = psStress[i];
    const psUpper = psStress[i + 1];
    const bxLower = bxStress[i];
    const bxUpper = bxStress[i + 1];
    const yInterface = psLower.yt * 1e3;
    const layerColor = COLORS[i % COLORS.length];

    datasets.push({
      label: null,
      data: [
        { x: psLower.stressTop / 1e6, y: yInterface },
        { x: psUpper.stressBot / 1e6, y: yInterface },
      ],
      borderColor: layerColor,
      borderWidth: 2.5,
      pointRadius: 0,
      showLine: true,
      clip: true,
    });
    datasets.push({
      label: null,
      data: [
        { x: bxLower.stressTop / 1e6, y: yInterface },
        { x: bxUpper.stressBot / 1e6, y: yInterface },
      ],
      borderColor: layerColor,
      borderDash: [2, 5],
      borderWidth: 2,
      pointRadius: 0,
      showLine: true,
      clip: true,
    });
  }
}

function renderTemperatureChart(canvasId, temperatures, stressPositions, names) {
  destroyChart(canvasId);
  const datasets = temperatures.map((temperature, i) => ({
    label: names[i],
    data: [
      { x: temperature.Tbot, y: stressPositions[i].yb * 1e3 },
      { x: temperature.Ttop, y: stressPositions[i].yt * 1e3 },
    ],
    borderColor: COLORS[i % COLORS.length],
    backgroundColor: COLORS[i % COLORS.length],
    borderWidth: 2.5,
    pointRadius: 3,
    showLine: true,
  }));
  return new Chart(canvasId, {
    type: "scatter",
    data: { datasets },
    options: chartOptions("Temperature (°C)", "Position (mm)", true),
  });
}

function renderErrChart(canvasId, interfaces) {
  destroyChart(canvasId);
  const clean = (value) => (Math.abs(value) < 1e-12 ? 0 : value);
  const classic = interfaces.map((item) => clean(item.modes.classic));
  const planeStrain = interfaces.map((item) => clean(item.modes.planestrain));
  const biaxial = interfaces.map((item) => clean(item.modes.biaxial));
  const maxG = Math.max(...classic, ...planeStrain, ...biaxial, 0);
  const options = chartOptions("Interface", "G (J/m²)", true);
  options.scales.y.min = 0;
  options.scales.y.suggestedMax = maxG > 0 ? maxG * 1.15 : 1;
  options.scales.y.ticks.callback = (value) => formatNumber(value);

  return new Chart(canvasId, {
    type: "bar",
    data: {
      labels: interfaces.map((item, i) => `Interface ${i + 1}`),
      datasets: [
        { label: "Classic", data: classic, backgroundColor: COLORS[0] },
        { label: "Plane Strain", data: planeStrain, backgroundColor: COLORS[1] },
        { label: "Biaxial", data: biaxial, backgroundColor: COLORS[2] },
      ],
    },
    options,
  });
}

function renderStoneyVerificationCharts() {
  const film = { name: "Film", h: 2.5e-6, E: 100e9, nu: 0.25 };
  const substrate = { name: "Substrate", h: 500e-6, E: 200e9, nu: 0.27 };
  const EbarSub = substrate.E / (1 - substrate.nu);
  const EbarFilm = film.E / (1 - film.nu);
  const stressSweep = [];
  for (let i = 0; i <= 60; i += 1) {
    const sigma = (-600e6) + (1200e6 * i) / 60;
    const theta = -sigma / EbarFilm;
    const exact = computeMultilayerResponse({
      prestressCondition: "biaxial",
      layers: [
        { ...substrate, theta: 0 },
        { ...film, theta },
      ],
    });
    const stoney = (6 * sigma * film.h) / (EbarSub * substrate.h * substrate.h);
    stressSweep.push({ sigma: sigma / 1e6, exact: exact.curvature, stoney });
  }

  destroyChart("plot-stoney-stress");
  new Chart("plot-stoney-stress", {
    type: "scatter",
    data: {
      datasets: [
        {
          label: "Exact multilayer solution",
          data: stressSweep.map((item) => ({ x: item.sigma, y: item.exact })),
          borderColor: COLORS[0],
          backgroundColor: COLORS[0],
          borderWidth: 3,
          pointRadius: 0,
          showLine: true,
        },
        {
          label: "Stoney equation",
          data: stressSweep.map((item) => ({ x: item.sigma, y: item.stoney })),
          borderColor: COLORS[1],
          backgroundColor: COLORS[1],
          borderDash: [6, 4],
          borderWidth: 3,
          pointRadius: 0,
          showLine: true,
        },
      ],
    },
    options: chartOptions("Film stress, σf (MPa)", "Curvature, κ (m⁻¹)", true),
  });

  const ratioSweep = [];
  const theta = 3e-3;
  const sigmaFilm = -EbarFilm * theta;
  for (let i = 0; i <= 80; i += 1) {
    const thicknessRatio = 10 ** (-3 + (3 * i) / 80);
    const filmH = substrate.h * thicknessRatio;
    const exact = computeMultilayerResponse({
      prestressCondition: "biaxial",
      layers: [
        { ...substrate, theta: 0 },
        { ...film, h: filmH, theta },
      ],
    });
    const stoney = (6 * sigmaFilm * filmH) / (EbarSub * substrate.h * substrate.h);
    ratioSweep.push({
      thicknessRatio,
      exactOverStoney: exact.curvature / stoney,
    });
  }

  destroyChart("plot-stoney-ratio");
  new Chart("plot-stoney-ratio", {
    type: "scatter",
    data: {
      datasets: [
        {
          label: "Exact / Stoney",
          data: ratioSweep.map((item) => ({ x: item.thicknessRatio, y: item.exactOverStoney })),
          borderColor: COLORS[0],
          backgroundColor: COLORS[0],
          borderWidth: 3,
          pointRadius: 0,
          showLine: true,
        },
        {
          label: "Perfect agreement",
          data: [
            { x: ratioSweep[0].thicknessRatio, y: 1 },
            { x: ratioSweep[ratioSweep.length - 1].thicknessRatio, y: 1 },
          ],
          borderColor: COLORS[1],
          backgroundColor: COLORS[1],
          borderDash: [5, 4],
          borderWidth: 2,
          pointRadius: 0,
          showLine: true,
        },
        {
          label: "5% bounds",
          data: [
            { x: ratioSweep[0].thicknessRatio, y: 0.95 },
            { x: ratioSweep[ratioSweep.length - 1].thicknessRatio, y: 0.95 },
          ],
          borderColor: COLORS[2],
          backgroundColor: COLORS[2],
          borderDash: [2, 4],
          borderWidth: 2,
          pointRadius: 0,
          showLine: true,
        },
        {
          label: "5% bounds",
          data: [
            { x: ratioSweep[0].thicknessRatio, y: 1.05 },
            { x: ratioSweep[ratioSweep.length - 1].thicknessRatio, y: 1.05 },
          ],
          borderColor: COLORS[2],
          backgroundColor: COLORS[2],
          borderDash: [2, 4],
          borderWidth: 2,
          pointRadius: 0,
          showLine: true,
        },
      ],
    },
    options: {
      ...chartOptions("Film/substrate thickness ratio, hf/hs", "κexact / κStoney", true),
      scales: {
        ...chartOptions("Film/substrate thickness ratio, hf/hs", "κexact / κStoney", true).scales,
        x: {
          ...chartOptions("Film/substrate thickness ratio, hf/hs", "κexact / κStoney", true).scales.x,
          type: "logarithmic",
        },
      },
    },
  });
}

function renderGvsPositionChart(canvasId, mechanicalLayers, names) {
  destroyChart(canvasId);
  const { positions, Gvalues } = computeGvsPositionSubdivided(mechanicalLayers, 20);
  const maxG = Math.max(...Gvalues, 1);
  const curvePoints = positions.map((position, i) => ({ x: Gvalues[i], y: position * 1e3 }));
  const datasets = [];
  let yBottomForSegments = 0;
  mechanicalLayers.forEach((layer, layerIndex) => {
    const yTop = yBottomForSegments + layer.h * 1e3;
    const layerPoints = curvePoints.filter((point) => point.y >= yBottomForSegments - 1e-9 && point.y <= yTop + 1e-9);
    if (layerPoints.length > 0) {
      datasets.push({
        label: names[layerIndex],
        data: layerPoints,
        borderColor: COLORS[layerIndex % COLORS.length],
        backgroundColor: COLORS[layerIndex % COLORS.length],
        borderWidth: 3,
        pointRadius: 0,
        showLine: true,
        clip: true,
      });
    }
    yBottomForSegments = yTop;
  });
  let y = 0;
  mechanicalLayers.forEach((layer, i) => {
    y += layer.h;
    if (i < mechanicalLayers.length - 1) {
      datasets.push({
        label: null,
        data: [{ x: 0, y: y * 1e3 }, { x: maxG * 1.15, y: y * 1e3 }],
        borderColor: COLORS[2],
        borderDash: [4, 4],
        pointRadius: 0,
        showLine: true,
        clip: true,
      });
    }
  });
  const labelPlugin = {
    id: "gPositionLabels",
    afterDraw(chart) {
      const ctx = chart.ctx;
      const yScale = chart.scales.y;
      ctx.save();
      ctx.beginPath();
      ctx.rect(chart.chartArea.left, chart.chartArea.top, chart.chartArea.width, chart.chartArea.height);
      ctx.clip();
      ctx.font = "600 13px Arial, sans-serif";
      ctx.fillStyle = "#dbeafe";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      let yBottom = 0;
      mechanicalLayers.forEach((layer, i) => {
        const yTop = yBottom + layer.h;
        ctx.fillText(names[i], chart.chartArea.right - 10, yScale.getPixelForValue(((yBottom + yTop) / 2) * 1e3));
        yBottom = yTop;
      });
      ctx.restore();
    },
  };
  return new Chart(canvasId, {
    type: "scatter",
    data: { datasets },
    plugins: [labelPlugin],
    options: chartOptions("Energy release rate, G (J/m²)", "Position of delamination (mm)", false),
  });
}

function chartOptions(xTitle, yTitle, showLegend) {
  return {
    responsive: false,
    animation: false,
    color: "#dbeafe",
    clip: true,
    layout: {
      padding: { top: 8, right: 14, bottom: 8, left: 8 },
    },
    plugins: {
      legend: {
        display: showLegend,
        position: "top",
        align: "center",
        labels: {
          color: "#dbeafe",
          filter: (item) => item.text != null && item.text !== "null",
          boxWidth: 32,
          boxHeight: 3,
          padding: 14,
          font: { size: 13, weight: "600" },
        },
      },
    },
    scales: {
      x: {
        title: { display: true, text: xTitle, color: "#ffffff", font: { size: 18, weight: "700" } },
        ticks: { color: "#cbd5e1", font: { size: 13 } },
        grid: { color: "rgba(161, 161, 170, 0.18)", drawTicks: false },
        border: { color: "rgba(226, 232, 240, 0.55)" },
      },
      y: {
        title: { display: true, text: yTitle, color: "#ffffff", font: { size: 18, weight: "700" } },
        ticks: { color: "#cbd5e1", font: { size: 13 } },
        grid: { color: "rgba(161, 161, 170, 0.18)", drawTicks: false },
        border: { color: "rgba(226, 232, 240, 0.55)" },
      },
    },
  };
}

function runSolver() {
  const errorBox = document.getElementById("error-box");
  errorBox.textContent = "";
  try {
    const psInput = readInput("planestrain");
    const bxInput = readInput("biaxial");
    const psResult = computeMultilayerResponse(psInput);
    const bxResult = computeMultilayerResponse(bxInput);
    const mechanicalLayers = buildMechanicalLayers(bxInput, bxResult.temperature);
    renderResults(psResult, bxResult, mechanicalLayers);
  } catch (error) {
    document.getElementById("results").innerHTML = "";
    errorBox.textContent = error.message || String(error);
  }
}

function runTransientSolver() {
  const errorBox = document.getElementById("transient-error-box");
  errorBox.textContent = "";
  try {
    const response = solveTransientTransport(readTransientInput());
    let stressHistory = null;
    if (transientState.stressCoupling.enabled === "on") {
      const mechanicalProps = transientState.layers.map((layer) => ({
        name: layer.name,
        E: layer.EGPa * 1e9,
        nu: layer.nu,
        swellingCoefficient: layer.swellingCoefficient,
      }));
      stressHistory = computeStressHistoryFromTransport(response, mechanicalProps, {
        condition: transientState.stressCoupling.condition,
        referenceValue: transientState.stressCoupling.referenceValue,
      });
    }
    renderTransientResults(response, stressHistory);
  } catch (error) {
    document.getElementById("transient-results").innerHTML = "";
    errorBox.textContent = error.message || String(error);
  }
}

function setWorkspaceMode(mode) {
  document.querySelectorAll(".page-steady").forEach((element) => {
    element.hidden = mode !== "steady";
  });
  document.querySelectorAll(".page-transient").forEach((element) => {
    element.hidden = mode !== "transient";
  });
}

document.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const transientIndex = Number(target.dataset.transientI);
  const transientKey = target.dataset.transientK;
  if (Number.isInteger(transientIndex) && transientKey && transientState.layers[transientIndex]) {
    if (transientKey === "name") {
      transientState.layers[transientIndex][transientKey] = target.value;
      renderTransientMechTable();
      return;
    }
    const numeric = Number(target.value);
    transientState.layers[transientIndex][transientKey] = Number.isFinite(numeric) ? numeric : 0;
    syncTransientInterfaceInitialValues(transientIndex, transientKey);
    if (transientKey === "initialBottom" || transientKey === "initialTop") {
      renderTransientTable();
    }
    return;
  }

  const interfaceIndex = Number(target.dataset.interfaceIndex);
  if (Number.isInteger(interfaceIndex)) {
    const numeric = Number(target.value);
    state.thermal.interfaceConductances[interfaceIndex] = Number.isFinite(numeric) ? numeric : 0;
    return;
  }
  const i = Number(target.dataset.i);
  const key = target.dataset.k;
  if (!Number.isInteger(i) || !key || !state.layers[i]) return;
  if (key === "name") {
    state.layers[i][key] = target.value;
    return;
  }
  const numeric = Number(target.value);
  state.layers[i][key] = Number.isFinite(numeric) ? numeric : 0;
});

document.getElementById("transient-transport-mode").addEventListener("change", (event) => {
  transientState.transportMode = event.target.value;
  applyTransientLabels();
});

document.getElementById("transient-boundary-mode").addEventListener("change", (event) => {
  transientState.boundaryMode = event.target.value;
  renderTransientBoundaryControls();
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  if (target.id === "transient-final-profile-display") {
    transientState.output.finalProfileTable = target.value;
    renderTransientFinalProfileTable(lastTransientResponse);
  }
  if (target.id === "transient-stress-enabled") {
    transientState.stressCoupling.enabled = target.value;
    renderTransientStressControls();
    renderTransientMechTable();
  }
  if (target.id === "transient-stress-condition") {
    transientState.stressCoupling.condition = target.value;
  }
});

document.getElementById("transient-stress-reference").addEventListener("input", (event) => {
  const value = Number(event.target.value);
  transientState.stressCoupling.referenceValue = Number.isFinite(value) ? value : 0;
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const mechIndexRaw = target.getAttribute("data-transient-mech-i");
  if (mechIndexRaw == null) return;
  const i = Number(mechIndexRaw);
  const key = target.getAttribute("data-transient-mech-k");
  if (!Number.isInteger(i) || !key || !transientState.layers[i]) return;
  const numeric = Number(target.value);
  transientState.layers[i][key] = Number.isFinite(numeric) ? numeric : 0;
});

document.getElementById("workspace-mode").addEventListener("change", (event) => {
  setWorkspaceMode(event.target.value);
  if (event.target.value === "transient") {
    runTransientSolver();
  } else {
    runSolver();
  }
});

document.getElementById("transient-bottom-value").addEventListener("input", (event) => {
  const value = Number(event.target.value);
  transientState.boundary.bottomValue = Number.isFinite(value) ? value : 0;
});
document.getElementById("transient-top-value").addEventListener("input", (event) => {
  const value = Number(event.target.value);
  transientState.boundary.topValue = Number.isFinite(value) ? value : 0;
});
document.getElementById("transient-transfer").addEventListener("input", (event) => {
  const value = Number(event.target.value);
  transientState.boundary.transferCoefficient = Number.isFinite(value) ? value : 0;
});
document.getElementById("transient-ambient").addEventListener("input", (event) => {
  const value = Number(event.target.value);
  transientState.boundary.ambientValue = Number.isFinite(value) ? value : 0;
});
document.getElementById("transient-dt").addEventListener("input", (event) => {
  const value = Number(event.target.value);
  transientState.time.dt = Number.isFinite(value) ? value : 0;
});
document.getElementById("transient-tmax").addEventListener("input", (event) => {
  const value = Number(event.target.value);
  transientState.time.tMax = Number.isFinite(value) ? value : 0;
});
document.getElementById("transient-output-times").addEventListener("input", (event) => {
  transientState.time.outputTimesText = event.target.value;
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  if (target.id === "add-transient-layer") {
    const previousTop = transientState.layers[transientState.layers.length - 1].initialTop;
    transientState.layers.push({
      name: `Layer ${transientState.layers.length + 1}`,
      hUm: 10,
      diffusivity: 50,
      elements: 20,
      source: 0,
      reactionRate: 0,
      storageCoefficient: 1,
      initialBottom: previousTop,
      initialTop: previousTop,
      EGPa: 100,
      nu: 0.3,
      swellingCoefficient: 1000,
    });
    renderTransientTable();
    renderTransientMechTable();
    return;
  }

  if (target.id === "run-transient-analysis") {
    runTransientSolver();
    return;
  }

  if (target.id === "reset-transient-defaults") {
    transientState = JSON.parse(JSON.stringify(defaultTransientState));
    document.getElementById("transient-transport-mode").value = transientState.transportMode;
    document.getElementById("transient-boundary-mode").value = transientState.boundaryMode;
    document.getElementById("transient-bottom-value").value = String(transientState.boundary.bottomValue);
    document.getElementById("transient-top-value").value = String(transientState.boundary.topValue);
    document.getElementById("transient-transfer").value = String(transientState.boundary.transferCoefficient);
    document.getElementById("transient-ambient").value = String(transientState.boundary.ambientValue);
    document.getElementById("transient-dt").value = String(transientState.time.dt);
    document.getElementById("transient-tmax").value = String(transientState.time.tMax);
    document.getElementById("transient-output-times").value = transientState.time.outputTimesText;
    document.getElementById("transient-stress-enabled").value = transientState.stressCoupling.enabled;
    document.getElementById("transient-stress-condition").value = transientState.stressCoupling.condition;
    document.getElementById("transient-stress-reference").value = String(transientState.stressCoupling.referenceValue);
    renderTransientTable();
    renderTransientBoundaryControls();
    renderTransientStressControls();
    renderTransientMechTable();
    runTransientSolver();
    return;
  }

  const removeTransientIndexRaw = target.getAttribute("data-remove-transient");
  if (removeTransientIndexRaw != null) {
    const removeIndex = Number(removeTransientIndexRaw);
    if (Number.isInteger(removeIndex) && transientState.layers[removeIndex] && transientState.layers.length > 1) {
      transientState.layers.splice(removeIndex, 1);
      renderTransientTable();
      renderTransientMechTable();
    }
    return;
  }

  if (target.id === "add-layer") {
    state.layers.push({
      name: `Layer ${state.layers.length + 1}`,
      hMm: 0.001,
      EGPa: 100,
      nu: 0.3,
      thetaMilli: 0,
      alphaMicro: 10,
      kWmK: 10,
      TrefC: 25,
    });
    renderTable();
    renderModeControls();
    return;
  }

  if (target.id === "run-analysis") {
    runSolver();
    return;
  }

  if (target.id === "reset-defaults") {
    state = JSON.parse(JSON.stringify(defaultState));
    document.getElementById("analysis-mode").value = state.analysisMode;
    document.getElementById("thermal-tbot").value = String(state.thermal.TbotC);
    document.getElementById("thermal-ttop").value = String(state.thermal.TtopC);
    renderTable();
    renderModeControls();
    runSolver();
    return;
  }

  const removeIndexRaw = target.getAttribute("data-remove");
  if (removeIndexRaw != null) {
    const removeIndex = Number(removeIndexRaw);
    if (Number.isInteger(removeIndex) && state.layers[removeIndex] && state.layers.length > 1) {
      state.layers.splice(removeIndex, 1);
      syncInterfaceConductances();
      renderTable();
      renderModeControls();
    }
  }
});

document.getElementById("analysis-mode").addEventListener("change", (event) => {
  state.analysisMode = event.target.value;
  renderTable();
  renderModeControls();
  runSolver();
});

document.getElementById("open-solver-logic").addEventListener("click", () => {
  const modal = document.getElementById("solver-logic-modal");
  modal.classList.add("active");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  typesetMath();
});

document.getElementById("close-solver-logic").addEventListener("click", closeSolverLogicModal);
document.getElementById("solver-logic-modal").addEventListener("click", (event) => {
  if (event.target.id === "solver-logic-modal") {
    closeSolverLogicModal();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeSolverLogicModal();
    closeTransientSolverLogicModal();
    closeStoneyModal();
  }
});

function closeSolverLogicModal() {
  const modal = document.getElementById("solver-logic-modal");
  modal.classList.remove("active");
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

document.getElementById("open-transient-solver-logic").addEventListener("click", () => {
  const modal = document.getElementById("transient-solver-logic-modal");
  modal.classList.add("active");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  typesetMath();
});

document.getElementById("close-transient-solver-logic").addEventListener("click", closeTransientSolverLogicModal);
document.getElementById("transient-solver-logic-modal").addEventListener("click", (event) => {
  if (event.target.id === "transient-solver-logic-modal") {
    closeTransientSolverLogicModal();
  }
});

function closeTransientSolverLogicModal() {
  const modal = document.getElementById("transient-solver-logic-modal");
  modal.classList.remove("active");
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

document.getElementById("open-stoney-verification").addEventListener("click", () => {
  const modal = document.getElementById("stoney-modal");
  modal.classList.add("active");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  renderStoneyVerificationCharts();
  typesetMath();
});

document.getElementById("close-stoney-verification").addEventListener("click", closeStoneyModal);
document.getElementById("stoney-modal").addEventListener("click", (event) => {
  if (event.target.id === "stoney-modal") {
    closeStoneyModal();
  }
});

function closeStoneyModal() {
  const modal = document.getElementById("stoney-modal");
  modal.classList.remove("active");
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

document.getElementById("export-report-pdf").addEventListener("click", exportReportPdf);

async function exportReportPdf() {
  const source = document.getElementById("report-export-root");
  const exportButton = document.getElementById("export-report-pdf");
  const originalText = exportButton.textContent;

  exportButton.textContent = "Preparing PDF...";
  exportButton.disabled = true;
  document.body.classList.add("pdf-exporting");

  try {
    await window.MathJax?.typesetPromise?.();

    const width = Math.ceil(source.scrollWidth);
    const height = Math.ceil(source.scrollHeight);
    const filename = `LayerSlayerV2-report-${new Date().toISOString().slice(0, 10)}.pdf`;

    const canvas = await window.html2canvas(source, {
      scale: 1.5,
      backgroundColor: "#030303",
      useCORS: true,
      windowWidth: width,
      windowHeight: height,
      ignoreElements: (element) => element.classList?.contains("no-export"),
    });
    const pdf = new window.jspdf.jsPDF({
      orientation: canvas.width >= canvas.height ? "landscape" : "portrait",
      unit: "px",
      format: [canvas.width, canvas.height],
      hotfixes: ["px_scaling"],
    });
    pdf.addImage(canvas.toDataURL("image/jpeg", 0.98), "JPEG", 0, 0, canvas.width, canvas.height);
    pdf.save(filename);
  } catch (error) {
    document.getElementById("error-box").textContent = `PDF export failed: ${error.message || error}`;
  } finally {
    document.body.classList.remove("pdf-exporting");
    exportButton.textContent = originalText;
    exportButton.disabled = false;
  }
}

document.getElementById("thermal-tbot").addEventListener("input", (event) => {
  const value = Number(event.target.value);
  state.thermal.TbotC = Number.isFinite(value) ? value : 0;
});
document.getElementById("thermal-ttop").addEventListener("input", (event) => {
  const value = Number(event.target.value);
  state.thermal.TtopC = Number.isFinite(value) ? value : 0;
});

document.getElementById("analysis-mode").value = state.analysisMode;
document.getElementById("thermal-tbot").value = String(state.thermal.TbotC);
document.getElementById("thermal-ttop").value = String(state.thermal.TtopC);
document.getElementById("workspace-mode").value = "steady";
document.getElementById("transient-transport-mode").value = transientState.transportMode;
document.getElementById("transient-boundary-mode").value = transientState.boundaryMode;
document.getElementById("transient-bottom-value").value = String(transientState.boundary.bottomValue);
document.getElementById("transient-top-value").value = String(transientState.boundary.topValue);
document.getElementById("transient-transfer").value = String(transientState.boundary.transferCoefficient);
document.getElementById("transient-ambient").value = String(transientState.boundary.ambientValue);
document.getElementById("transient-dt").value = String(transientState.time.dt);
document.getElementById("transient-tmax").value = String(transientState.time.tMax);
document.getElementById("transient-output-times").value = transientState.time.outputTimesText;
document.getElementById("transient-stress-enabled").value = transientState.stressCoupling.enabled;
document.getElementById("transient-stress-condition").value = transientState.stressCoupling.condition;
document.getElementById("transient-stress-reference").value = String(transientState.stressCoupling.referenceValue);
renderTable();
renderModeControls();
renderTransientTable();
renderTransientBoundaryControls();
renderTransientStressControls();
renderTransientMechTable();
setWorkspaceMode("steady");
runSolver();
