import { computeStresses, solveDeformation } from "./solver.js";

export function profileToMechanicalSublayers(profile, layerProperties, options = {}) {
  const referenceValue = options.referenceValue ?? 0;
  const sublayers = [];

  for (let i = 0; i < profile.points.length - 1; i += 1) {
    const bottom = profile.points[i];
    const top = profile.points[i + 1];
    const h = top.y - bottom.y;
    if (h <= 0) continue;
    const layerIndex = bottom.layerIndex === top.layerIndex ? bottom.layerIndex : top.layerIndex;

    const properties = layerProperties[layerIndex];
    if (!properties) {
      throw new Error(`Missing mechanical properties for layer ${layerIndex + 1}.`);
    }
    const swellingCoefficient = properties.swellingCoefficient ?? properties.beta ?? 1;

    sublayers.push({
      name: properties.name || bottom.layerName,
      h,
      E: properties.E,
      nu: properties.nu,
      thetaBot: swellingCoefficient * (bottom.value - referenceValue),
      thetaTop: swellingCoefficient * (top.value - referenceValue),
    });
  }

  return sublayers;
}

export function computeStressFromTransportProfile(profile, layerProperties, options = {}) {
  const condition = options.condition || "planestrain";
  const mechanicalLayers = profileToMechanicalSublayers(profile, layerProperties, options);
  const deformation = solveDeformation(mechanicalLayers, condition, options.N0 || 0, options.M0 || 0);
  const stresses = computeStresses(
    mechanicalLayers,
    deformation.epsilon0,
    deformation.kappa,
    deformation.positions,
    condition
  );

  return {
    time: profile.time,
    epsilon0: deformation.epsilon0,
    curvature: deformation.kappa,
    mechanicalLayers,
    stresses: stresses.map((stress, i) => ({
      ...stress,
      name: mechanicalLayers[i].name,
      layerIndex: i,
    })),
    diagnostics: {
      condition,
      determinant: deformation.det,
      sublayerCount: mechanicalLayers.length,
    },
  };
}

export function computeStressHistoryFromTransport(response, layerProperties, options = {}) {
  return response.profiles.map((profile) => computeStressFromTransportProfile(profile, layerProperties, options));
}
