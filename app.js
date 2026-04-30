import { computeGvsPositionSubdivided, computeMultilayerResponse } from "./solver.js";

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
const COLORS = ["#7f1d1d", "#dc2626", "#f97316", "#f59e0b", "#facc15", "#fde047", "#ffedd5", "#991b1b"];

function formatNumber(value, digits = 4) {
  if (!Number.isFinite(value)) return "NaN";
  if (Math.abs(value) < 1e-12) return "0";
  if (Math.abs(value) >= 1e4 || Math.abs(value) < 1e-3) return value.toExponential(3);
  return Number(value.toPrecision(digits)).toString();
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
      <div class="metric-card"><div class="metric-label">Plane Strain <span class="symbol-label">ε<sub>0</sub></span></div><div class="metric-value">${formatNumber(psResult.epsilon0, 6)}</div></div>
      <div class="metric-card"><div class="metric-label">Plane Strain Curvature <span class="symbol-label">κ</span></div><div class="metric-value">${formatNumber(psResult.curvature, 6)} m⁻¹</div></div>
      <div class="metric-card"><div class="metric-label">Plane Strain Radius <span class="symbol-label">1/κ</span></div><div class="metric-value">${Number.isFinite(psRadius) ? formatNumber(psRadius, 6) : "∞"} m</div></div>
      <div class="metric-card"><div class="metric-label">Biaxial <span class="symbol-label">ε<sub>0</sub></span></div><div class="metric-value">${formatNumber(bxResult.epsilon0, 6)}</div></div>
      <div class="metric-card"><div class="metric-label">Biaxial Curvature <span class="symbol-label">κ</span></div><div class="metric-value">${formatNumber(bxResult.curvature, 6)} m⁻¹</div></div>
      <div class="metric-card"><div class="metric-label">Biaxial Radius <span class="symbol-label">1/κ</span></div><div class="metric-value">${Number.isFinite(bxRadius) ? formatNumber(bxRadius, 6) : "∞"} m</div></div>
      ${bxResult.temperature ? `<div class="metric-card"><div class="metric-label">Heat Flux <span class="symbol-label">q</span></div><div class="metric-value">${formatNumber(bxResult.temperature.heatFlux, 6)} W/m²</div></div>` : ""}
    </div>

    <h3>Plane Strain Layer Stresses (MPa)</h3>
    <table>
      <thead>
        <tr><th>Layer</th><th><span class="symbol-label">σ<sub>bottom</sub></span></th><th><span class="symbol-label">σ<sub>top</sub></span></th><th><span class="symbol-label">y<sub>bottom</sub></span> (mm)</th><th><span class="symbol-label">y<sub>top</sub></span> (mm)</th></tr>
      </thead>
      <tbody>${renderStressRows(psResult.layerStress)}</tbody>
    </table>

    <h3>Biaxial Layer Stresses (MPa)</h3>
    <table>
      <thead>
        <tr><th>Layer</th><th><span class="symbol-label">σ<sub>bottom</sub></span></th><th><span class="symbol-label">σ<sub>top</sub></span></th><th><span class="symbol-label">y<sub>bottom</sub></span> (mm)</th><th><span class="symbol-label">y<sub>top</sub></span> (mm)</th></tr>
      </thead>
      <tbody>${renderStressRows(bxResult.layerStress)}</tbody>
    </table>

    <h3>Interfacial Delamination Driving Force G (J/m²)</h3>
    <table>
      <thead>
        <tr><th>Interface</th><th>Classic</th><th>Plane Strain</th><th>Biaxial</th></tr>
      </thead>
      <tbody>${renderErrRows(bxResult.interfaceDelamination)}</tbody>
    </table>

    <h3>Temperature Profile</h3>
    <table>
      <thead>
        <tr><th>Layer</th><th><span class="symbol-label">T<sub>bottom</sub></span></th><th><span class="symbol-label">T<sub>top</sub></span></th></tr>
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

document.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
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

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

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
    closeStoneyModal();
  }
});

function closeSolverLogicModal() {
  const modal = document.getElementById("solver-logic-modal");
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
renderTable();
renderModeControls();
runSolver();
