const VALID_CONDITIONS = new Set(["biaxial", "planestrain"]);
const VALID_ERR_MODES = new Set(["classic", "biaxial", "planestrain"]);

function assertFiniteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
}

function assertPositive(value, label) {
  assertFiniteNumber(value, label);
  if (value <= 0) {
    throw new Error(`${label} must be > 0.`);
  }
}

function normalizeCondition(value, fallback) {
  const normalized = (value || fallback || "").toLowerCase();
  if (!VALID_CONDITIONS.has(normalized)) {
    throw new Error(
      `Invalid condition "${value}". Use one of: ${Array.from(VALID_CONDITIONS).join(", ")}.`
    );
  }
  return normalized;
}

function normalizeErrMode(value) {
  const normalized = (value || "classic").toLowerCase();
  if (!VALID_ERR_MODES.has(normalized)) {
    throw new Error(
      `Invalid errMode "${value}". Use one of: ${Array.from(VALID_ERR_MODES).join(", ")}.`
    );
  }
  return normalized;
}

function normalizeMechanicalLayer(layer, index) {
  const prefix = `layers[${index}]`;
  assertPositive(layer.h, `${prefix}.h`);
  assertPositive(layer.E, `${prefix}.E`);
  assertFiniteNumber(layer.nu, `${prefix}.nu`);
  if (layer.nu <= -1 || layer.nu >= 0.5) {
    throw new Error(`${prefix}.nu must satisfy -1 < nu < 0.5.`);
  }

  let thetaBot = layer.thetaBot;
  let thetaTop = layer.thetaTop;
  if (thetaBot == null && thetaTop == null && layer.theta != null) {
    thetaBot = layer.theta;
    thetaTop = layer.theta;
  }
  assertFiniteNumber(thetaBot ?? NaN, `${prefix}.thetaBot or theta`);
  assertFiniteNumber(thetaTop ?? NaN, `${prefix}.thetaTop or theta`);

  return {
    name: layer.name || `Layer ${index + 1}`,
    h: layer.h,
    E: layer.E,
    nu: layer.nu,
    thetaBot,
    thetaTop,
  };
}

function normalizeThermalLayer(layer, index) {
  const prefix = `layers[${index}]`;
  assertPositive(layer.h, `${prefix}.h`);
  assertPositive(layer.E, `${prefix}.E`);
  assertFiniteNumber(layer.nu, `${prefix}.nu`);
  if (layer.nu <= -1 || layer.nu >= 0.5) {
    throw new Error(`${prefix}.nu must satisfy -1 < nu < 0.5.`);
  }
  assertFiniteNumber(layer.alpha, `${prefix}.alpha`);
  assertPositive(layer.k, `${prefix}.k`);
  assertFiniteNumber(layer.Tref, `${prefix}.Tref`);

  return {
    name: layer.name || `Layer ${index + 1}`,
    h: layer.h,
    E: layer.E,
    nu: layer.nu,
    alpha: layer.alpha,
    k: layer.k,
    Tref: layer.Tref,
  };
}

export function validateAndNormalizeInput(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Input must be an object.");
  }
  if (!Array.isArray(input.layers) || input.layers.length < 1) {
    throw new Error("Input must include a non-empty layers array.");
  }

  const useThermalModel = !!input.thermal;
  const layers = input.layers.map((layer, index) =>
    useThermalModel ? normalizeThermalLayer(layer, index) : normalizeMechanicalLayer(layer, index)
  );

  const prestressCondition = normalizeCondition(input.prestressCondition, "biaxial");
  const crackCondition = normalizeCondition(input.crackCondition, "planestrain");
  const errMode = normalizeErrMode(input.errMode);

  const N0 = input.N0 == null ? 0 : input.N0;
  const M0 = input.M0 == null ? 0 : input.M0;
  assertFiniteNumber(N0, "N0");
  assertFiniteNumber(M0, "M0");

  if (!useThermalModel) {
    return {
      layers,
      thermal: null,
      prestressCondition,
      crackCondition,
      errMode,
      N0,
      M0,
    };
  }

  const thermal = input.thermal;
  assertFiniteNumber(thermal.Tbot, "thermal.Tbot");
  assertFiniteNumber(thermal.Ttop, "thermal.Ttop");
  if (!Array.isArray(thermal.interfaceConductances)) {
    throw new Error("thermal.interfaceConductances must be an array.");
  }
  if (thermal.interfaceConductances.length !== Math.max(0, layers.length - 1)) {
    throw new Error(
      `thermal.interfaceConductances must have length ${Math.max(0, layers.length - 1)}.`
    );
  }
  thermal.interfaceConductances.forEach((value, i) => {
    assertPositive(value, `thermal.interfaceConductances[${i}]`);
  });

  return {
    layers,
    thermal: {
      Tbot: thermal.Tbot,
      Ttop: thermal.Ttop,
      interfaceConductances: thermal.interfaceConductances,
    },
    prestressCondition,
    crackCondition,
    errMode,
    N0,
    M0,
  };
}
