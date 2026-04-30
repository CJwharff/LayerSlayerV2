import { validateAndNormalizeInput } from "./model.js";

function integrateThetaTerms(yb, yt, thetaBot, thetaTop) {
  const h = yt - yb;
  const dTheta = thetaTop - thetaBot;
  const intTheta = h * (thetaBot + thetaTop) / 2;
  const intThetaY =
    thetaBot * (yt * yt - yb * yb) / 2 +
    (h > 0
      ? dTheta * ((yt * yt * yt - yb * yb * yb) / 3 - yb * (yt * yt - yb * yb) / 2) / h
      : 0);
  return { intTheta, intThetaY };
}

export function getModuli(E, nu, condition) {
  if (condition === "biaxial") {
    return { Ebar: E / (1 - nu), cbar: 1 };
  }
  if (condition === "planestrain") {
    return { Ebar: E / (1 - nu * nu), cbar: 1 + nu };
  }
  return { Ebar: E, cbar: 1 };
}

export function buildPositions(layers) {
  let y = 0;
  return layers.map((layer) => {
    const yb = y;
    y += layer.h;
    return { yb, yt: y };
  });
}

export function solveDeformation(layers, condition, N0 = 0, M0 = 0) {
  const positions = buildPositions(layers);
  let a11 = 0;
  let a12 = 0;
  let a22 = 0;
  let b1 = 0;
  let b2 = 0;

  layers.forEach((layer, i) => {
    const { Ebar, cbar } = getModuli(layer.E, layer.nu, condition);
    const { yb, yt } = positions[i];
    const { intTheta, intThetaY } = integrateThetaTerms(
      yb,
      yt,
      layer.thetaBot || 0,
      layer.thetaTop || 0
    );
    const h = layer.h;

    a11 += Ebar * h;
    a12 += -Ebar * (yt * yt - yb * yb) / 2;
    a22 += Ebar * (yt * yt * yt - yb * yb * yb) / 3;
    b1 += cbar * Ebar * intTheta;
    b2 += -cbar * Ebar * intThetaY;
  });

  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 1e-50) {
    return { epsilon0: 0, kappa: 0, positions, det };
  }

  const epsilon0 = (a22 * (b1 + N0) - a12 * (b2 + M0)) / det;
  const kappa = (-a12 * (b1 + N0) + a11 * (b2 + M0)) / det;
  return { epsilon0, kappa, positions, det };
}

export function computeStresses(layers, epsilon0, kappa, positions, condition) {
  return layers.map((layer, i) => {
    const { Ebar, cbar } = getModuli(layer.E, layer.nu, condition);
    const { yb, yt } = positions[i];
    return {
      yb,
      yt,
      stressBot: Ebar * (epsilon0 - kappa * yb - cbar * (layer.thetaBot || 0)),
      stressTop: Ebar * (epsilon0 - kappa * yt - cbar * (layer.thetaTop || 0)),
    };
  });
}

export function solveThermal(layers, interfaceConductances, Tbot, Ttop) {
  let totalResistance = 0;
  layers.forEach((layer) => {
    totalResistance += layer.h / layer.k;
  });
  interfaceConductances.forEach((kInt) => {
    totalResistance += 1 / kInt;
  });

  const heatFlux = (Ttop - Tbot) / totalResistance;
  const temperatures = [];
  let temperatureCursor = Tbot;

  layers.forEach((layer, i) => {
    const layerTbot = temperatureCursor;
    const layerTtop = layerTbot + heatFlux * layer.h / layer.k;
    temperatures.push({ Tbot: layerTbot, Ttop: layerTtop });
    temperatureCursor = layerTtop;
    if (i < layers.length - 1) {
      temperatureCursor += heatFlux / interfaceConductances[i];
    }
  });

  return { temperatures, heatFlux };
}

export function intactResultants(layers, epsilon0, kappa, positions, condition, i0, i1, yRef) {
  let N = 0;
  let M = 0;
  for (let i = i0; i <= i1; i += 1) {
    const layer = layers[i];
    const { Ebar, cbar } = getModuli(layer.E, layer.nu, condition);
    const { yb, yt } = positions[i];
    const { intTheta, intThetaY } = integrateThetaTerms(
      yb,
      yt,
      layer.thetaBot || 0,
      layer.thetaTop || 0
    );

    const intSigma =
      Ebar * (epsilon0 * layer.h - kappa * (yt * yt - yb * yb) / 2 - cbar * intTheta);
    const intSigmaY =
      Ebar *
      (epsilon0 * (yt * yt - yb * yb) / 2 - kappa * (yt * yt * yt - yb * yb * yb) / 3 - cbar * intThetaY);
    N += intSigma;
    M += -intSigmaY;
  }
  return { N, M: M + yRef * N };
}

export function computeERR(layers, interfaceIndex, prestressCondition, crackCondition, M0 = 0) {
  const intact = solveDeformation(layers, prestressCondition, 0, M0);
  const yCrack = intact.positions[interfaceIndex].yt;

  const lower = intactResultants(
    layers,
    intact.epsilon0,
    intact.kappa,
    intact.positions,
    prestressCondition,
    0,
    interfaceIndex,
    0
  );
  const upper = intactResultants(
    layers,
    intact.epsilon0,
    intact.kappa,
    intact.positions,
    prestressCondition,
    interfaceIndex + 1,
    layers.length - 1,
    yCrack
  );

  const lowerZeroMisfit = layers
    .slice(0, interfaceIndex + 1)
    .map((layer) => ({ ...layer, thetaBot: 0, thetaTop: 0 }));
  const upperZeroMisfit = layers
    .slice(interfaceIndex + 1)
    .map((layer) => ({ ...layer, thetaBot: 0, thetaTop: 0 }));

  const lowerChange = solveDeformation(lowerZeroMisfit, crackCondition, -lower.N, -lower.M);
  const upperChange = solveDeformation(upperZeroMisfit, crackCondition, -upper.N, -upper.M);

  const prefactor = crackCondition === "biaxial" ? 1.0 : 0.5;
  return Math.abs(
    prefactor *
      ((-lower.N) * lowerChange.epsilon0 +
        (-lower.M) * lowerChange.kappa +
        (-upper.N) * upperChange.epsilon0 +
        (-upper.M) * upperChange.kappa)
  );
}

export function classicERR(layers, interfaceIndex) {
  return computeERR(layers, interfaceIndex, "biaxial", "planestrain");
}

export function biaxialERR(layers, interfaceIndex) {
  return computeERR(layers, interfaceIndex, "biaxial", "biaxial");
}

export function planeStrainERR(layers, interfaceIndex) {
  return computeERR(layers, interfaceIndex, "planestrain", "planestrain");
}

export function computeGvsPositionSubdivided(layers, nSub = 20) {
  const subdividedLayers = [];
  layers.forEach((layer) => {
    const subH = layer.h / nSub;
    const dTheta = (layer.thetaTop - layer.thetaBot) / nSub;
    for (let j = 0; j < nSub; j += 1) {
      subdividedLayers.push({
        h: subH,
        E: layer.E,
        nu: layer.nu,
        thetaBot: layer.thetaBot + j * dTheta,
        thetaTop: layer.thetaBot + (j + 1) * dTheta,
      });
    }
  });

  const positions = [];
  let cumulativeH = 0;
  for (let i = 0; i < subdividedLayers.length - 1; i += 1) {
    cumulativeH += subdividedLayers[i].h;
    positions.push(cumulativeH);
  }
  const Gvalues = positions.map((_, i) => planeStrainERR(subdividedLayers, i));
  return { positions, Gvalues };
}

export function computeMultilayerResponse(rawInput) {
  const input = validateAndNormalizeInput(rawInput);
  let mechanicalLayers;
  let temperature = null;

  if (input.thermal) {
    const thermalLayers = input.layers.map((layer) => ({ h: layer.h, k: layer.k }));
    const thermal = solveThermal(
      thermalLayers,
      input.thermal.interfaceConductances,
      input.thermal.Tbot,
      input.thermal.Ttop
    );

    mechanicalLayers = input.layers.map((layer, i) => ({
      name: layer.name,
      h: layer.h,
      E: layer.E,
      nu: layer.nu,
      thetaBot: layer.alpha * (thermal.temperatures[i].Tbot - layer.Tref),
      thetaTop: layer.alpha * (thermal.temperatures[i].Ttop - layer.Tref),
    }));
    temperature = {
      heatFlux: thermal.heatFlux,
      layers: thermal.temperatures,
    };
  } else {
    mechanicalLayers = input.layers.map((layer) => ({
      name: layer.name,
      h: layer.h,
      E: layer.E,
      nu: layer.nu,
      thetaBot: layer.thetaBot,
      thetaTop: layer.thetaTop,
    }));
  }

  const deformation = solveDeformation(
    mechanicalLayers,
    input.prestressCondition,
    input.N0,
    input.M0
  );
  const stresses = computeStresses(
    mechanicalLayers,
    deformation.epsilon0,
    deformation.kappa,
    deformation.positions,
    input.prestressCondition
  );

  const interfaceDelamination = [];
  for (let i = 0; i < Math.max(0, mechanicalLayers.length - 1); i += 1) {
    const modes = {
      classic: classicERR(mechanicalLayers, i),
      planestrain: planeStrainERR(mechanicalLayers, i),
      biaxial: biaxialERR(mechanicalLayers, i),
    };
    interfaceDelamination.push({
      interfaceIndex: i,
      between: [mechanicalLayers[i].name, mechanicalLayers[i + 1].name],
      G: modes[input.errMode],
      modes,
    });
  }

  return {
    epsilon0: deformation.epsilon0,
    curvature: deformation.kappa,
    layerStress: stresses.map((stress, i) => ({
      layerIndex: i,
      name: mechanicalLayers[i].name,
      yb: stress.yb,
      yt: stress.yt,
      stressBot: stress.stressBot,
      stressTop: stress.stressTop,
    })),
    temperature,
    interfaceDelamination,
    diagnostics: {
      determinant: deformation.det,
      prestressCondition: input.prestressCondition,
      crackCondition: input.crackCondition,
      errMode: input.errMode,
    },
  };
}
