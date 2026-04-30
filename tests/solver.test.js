import test from "node:test";
import assert from "node:assert/strict";
import {
  computeMultilayerResponse,
  solveThermal,
  solveDeformation,
  computeStresses,
  classicERR,
  planeStrainERR,
  biaxialERR,
} from "../solver.js";

function relErr(value, reference) {
  if (Math.abs(reference) < 1e-20) {
    return Math.abs(value);
  }
  return Math.abs((value - reference) / reference);
}

function expectClose(value, reference, tolerance, label) {
  const error = relErr(value, reference);
  assert.ok(
    error <= tolerance,
    `${label} outside tolerance. value=${value}, ref=${reference}, relErr=${error}, tol=${tolerance}`
  );
}

test("Zero mismatch gives near-zero stress/curvature/ERR", () => {
  const response = computeMultilayerResponse({
    layers: [
      { name: "L1", h: 500e-6, E: 200e9, nu: 0.3, theta: 0 },
      { name: "L2", h: 100e-6, E: 100e9, nu: 0.25, theta: 0 },
      { name: "L3", h: 50e-6, E: 150e9, nu: 0.2, theta: 0 },
    ],
    prestressCondition: "biaxial",
    errMode: "classic",
  });

  assert.ok(Math.abs(response.curvature) < 1e-20);
  response.layerStress.forEach((layer) => {
    assert.ok(Math.abs(layer.stressBot) < 1e-3);
    assert.ok(Math.abs(layer.stressTop) < 1e-3);
  });
  response.interfaceDelamination.forEach((item) => {
    assert.ok(item.modes.classic < 1e-12);
    assert.ok(item.modes.planestrain < 1e-12);
    assert.ok(item.modes.biaxial < 1e-12);
  });
});

test("Identical layers with identical mismatch are stress-free with zero curvature and zero ERR", () => {
  const response = computeMultilayerResponse({
    layers: [
      { name: "L1", h: 100e-6, E: 150e9, nu: 0.3, theta: 2e-3 },
      { name: "L2", h: 100e-6, E: 150e9, nu: 0.3, theta: 2e-3 },
      { name: "L3", h: 100e-6, E: 150e9, nu: 0.3, theta: 2e-3 },
    ],
    prestressCondition: "biaxial",
  });

  assert.ok(Math.abs(response.curvature) < 1e-12);
  response.layerStress.forEach((layer) => {
    assert.ok(Math.abs(layer.stressBot) < 1e-3);
    assert.ok(Math.abs(layer.stressTop) < 1e-3);
  });
  response.interfaceDelamination.forEach((item) => {
    assert.ok(item.modes.classic < 1e-10);
    assert.ok(item.modes.planestrain < 1e-10);
    assert.ok(item.modes.biaxial < 1e-10);
  });
});

test("Stoney limit check (thin film over thick substrate)", () => {
  const substrate = { h: 500e-6, E: 200e9, nu: 0.27, theta: 0 };
  const film = { h: 2.5e-6, E: 100e9, nu: 0.25, theta: 3e-3 };
  const response = computeMultilayerResponse({
    layers: [
      { ...substrate, name: "Substrate" },
      { ...film, name: "Film" },
    ],
    prestressCondition: "biaxial",
  });

  const EbarSub = substrate.E / (1 - substrate.nu);
  const EbarFilm = film.E / (1 - film.nu);
  const sigmaFilm = -EbarFilm * film.theta;
  const kappaStoney = 6 * sigmaFilm * film.h / (EbarSub * substrate.h * substrate.h);
  const ratio = response.curvature / kappaStoney;

  assert.ok(Math.abs(1 - ratio) < 0.08, `Exact/Stoney ratio too large: ${ratio}`);
});

test("Dimensional consistency under uniform length scaling", () => {
  const base = computeMultilayerResponse({
    layers: [
      { name: "Substrate", h: 500e-6, E: 200e9, nu: 0.27, theta: 0 },
      { name: "Film", h: 5e-6, E: 100e9, nu: 0.25, theta: 3e-3 },
    ],
    prestressCondition: "biaxial",
  });
  const scale = 10;
  const scaled = computeMultilayerResponse({
    layers: [
      { name: "Substrate", h: 500e-6 * scale, E: 200e9, nu: 0.27, theta: 0 },
      { name: "Film", h: 5e-6 * scale, E: 100e9, nu: 0.25, theta: 3e-3 },
    ],
    prestressCondition: "biaxial",
  });

  base.layerStress.forEach((layer, i) => {
    expectClose(scaled.layerStress[i].stressBot, layer.stressBot, 1e-10, `Scaled stressBot layer ${i + 1}`);
    expectClose(scaled.layerStress[i].stressTop, layer.stressTop, 1e-10, `Scaled stressTop layer ${i + 1}`);
  });
  expectClose(scaled.curvature, base.curvature / scale, 1e-10, "Curvature inverse length scaling");
  expectClose(
    scaled.interfaceDelamination[0].modes.classic,
    base.interfaceDelamination[0].modes.classic * scale,
    1e-10,
    "Energy release rate length scaling"
  );
});

test("Stoney approximation breaks down as film thickness approaches substrate thickness", () => {
  const substrate = { h: 500e-6, E: 200e9, nu: 0.27, theta: 0 };
  const film = { h: 250e-6, E: 100e9, nu: 0.25, theta: 3e-3 };
  const response = computeMultilayerResponse({
    layers: [
      { ...substrate, name: "Substrate" },
      { ...film, name: "Film" },
    ],
    prestressCondition: "biaxial",
  });

  const EbarSub = substrate.E / (1 - substrate.nu);
  const EbarFilm = film.E / (1 - film.nu);
  const sigmaFilm = -EbarFilm * film.theta;
  const kappaStoney = (6 * sigmaFilm * film.h) / (EbarSub * substrate.h * substrate.h);
  const ratio = response.curvature / kappaStoney;

  assert.ok(Math.abs(1 - ratio) > 0.2, `Stoney should break down for thick films, ratio=${ratio}`);
});

test("Ch.14 benchmark values remain within 1% of LayerSlayer references", () => {
  const rawLayers = [
    { h: 0.003, E: 200e9, nu: 0.3, alpha: 15e-6, k: 25, Tref: 70, name: "Layer 1" },
    { h: 0.002, E: 40e9, nu: 0.2, alpha: 11e-6, k: 1, Tref: 70, name: "Layer 2" },
    { h: 0.001, E: 100e9, nu: 0.2, alpha: 11e-6, k: 2, Tref: 70, name: "Layer 3" },
  ];
  const interfaceConductances = [1e4, 1e7];
  const Tbot = 800;
  const Ttop = 1300;
  const ref = {
    q: 183817,
    ps: { e0: 0.0141377, kappa: -0.122875 },
    bx: { e0: 0.0106298, kappa: -0.295937 },
    psStress: [[-21.3841, -34.9019], [180.689, -11.2705], [-28.2016, -141.776]],
    bxStress: [[-91.4918, 67.6344], [152.138, -20.4672], [-51.1933, -140.575]],
    err: [{ classic: 221.259, ps: 286.205, bx: 366.795 }, { classic: 120.827, ps: 98.5194, bx: 196.835 }],
  };

  const thermal = solveThermal(
    rawLayers.map((layer) => ({ h: layer.h, k: layer.k })),
    interfaceConductances,
    Tbot,
    Ttop
  );
  expectClose(thermal.heatFlux, ref.q, 0.01, "Heat flux");

  const mechLayers = rawLayers.map((layer, i) => ({
    h: layer.h,
    E: layer.E,
    nu: layer.nu,
    thetaBot: layer.alpha * (thermal.temperatures[i].Tbot - layer.Tref),
    thetaTop: layer.alpha * (thermal.temperatures[i].Ttop - layer.Tref),
  }));

  const ps = solveDeformation(mechLayers, "planestrain");
  const bx = solveDeformation(mechLayers, "biaxial");
  expectClose(ps.epsilon0, ref.ps.e0, 0.01, "Plane-strain epsilon0");
  expectClose(ps.kappa, ref.ps.kappa, 0.01, "Plane-strain kappa");
  expectClose(bx.epsilon0, ref.bx.e0, 0.01, "Biaxial epsilon0");
  expectClose(bx.kappa, ref.bx.kappa, 0.01, "Biaxial kappa");

  const psStress = computeStresses(mechLayers, ps.epsilon0, ps.kappa, ps.positions, "planestrain");
  const bxStress = computeStresses(mechLayers, bx.epsilon0, bx.kappa, bx.positions, "biaxial");

  psStress.forEach((layer, i) => {
    expectClose(layer.stressBot / 1e6, ref.psStress[i][0], 0.01, `PS stressBot layer ${i + 1}`);
    expectClose(layer.stressTop / 1e6, ref.psStress[i][1], 0.01, `PS stressTop layer ${i + 1}`);
  });
  bxStress.forEach((layer, i) => {
    expectClose(layer.stressBot / 1e6, ref.bxStress[i][0], 0.01, `BX stressBot layer ${i + 1}`);
    expectClose(layer.stressTop / 1e6, ref.bxStress[i][1], 0.01, `BX stressTop layer ${i + 1}`);
  });

  for (let i = 0; i < mechLayers.length - 1; i += 1) {
    expectClose(classicERR(mechLayers, i), ref.err[i].classic, 0.01, `Classic ERR iface ${i + 1}`);
    expectClose(planeStrainERR(mechLayers, i), ref.err[i].ps, 0.01, `PlaneStrain ERR iface ${i + 1}`);
    expectClose(biaxialERR(mechLayers, i), ref.err[i].bx, 0.01, `Biaxial ERR iface ${i + 1}`);
  }
});
