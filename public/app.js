const state = {
  procedures: [],
  selectedProcedureId: "",
  extractedProcedure: null
};

const elements = {
  apiStatus: document.querySelector("#api-status"),
  procedureSelect: document.querySelector("#procedure-select"),
  procedurePanel: document.querySelector("#procedure-panel"),
  radarLabel: document.querySelector("#radar-label"),
  rawTextInput: document.querySelector("#raw-text-input"),
  imageUpload: document.querySelector("#image-upload"),
  ocrButton: document.querySelector("#ocr-btn"),
  ocrLoading: document.querySelector("#ocr-loading"),
  extractButton: document.querySelector("#extract-btn"),
  extractLoading: document.querySelector("#extract-loading"),
  verifyButton: document.querySelector("#verify-btn"),
  archiveButton: document.querySelector("#archive-btn"),
  canvas: document.querySelector("#radar-canvas")
};

const RADAR_RANGE_NM = 20;
const KSLC_16L_THRESHOLD = { latitude: 40.803, longitude: -111.977 };
const canvasContext = elements.canvas.getContext("2d");

async function loadProcedures() {
  try {
    const response = await fetch("/api/procedures");

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const payload = await response.json();
    state.procedures = payload.procedures;
    elements.apiStatus.textContent = "API Online";
    elements.apiStatus.className = "text-emerald-300";

    renderProcedureOptions();
    selectProcedure(state.procedures[0]?.id || "");
  } catch (error) {
    elements.apiStatus.textContent = "API Offline";
    elements.apiStatus.className = "text-red-300";
    elements.procedureSelect.innerHTML = '<option value="">Unable to load procedures</option>';
    elements.procedurePanel.innerHTML = `
      <p class="text-sm text-red-200">Unable to load procedure data.</p>
      <p class="mt-2 text-xs text-slate-400">${error.message}</p>
    `;
    drawRadar();
  }
}

async function loadSampleData() {
  await loadProcedures();
}

function renderProcedureOptions() {
  elements.procedureSelect.innerHTML = state.procedures
    .map((procedure) => {
      const label = `${procedure.airline.icao} ${procedure.airport.iata} - ${formatLabel(procedure.operation)}`;
      return `<option value="${procedure.id}">${label}</option>`;
    })
    .join("");
}

function selectProcedure(procedureId) {
  state.selectedProcedureId = procedureId;
  elements.procedureSelect.value = procedureId;
  state.extractedProcedure = null;
  elements.verifyButton.classList.add("hidden");

  const procedure = getSelectedProcedure();
  updateArchiveButtonVisibility(procedure);
  visualizeProcedure(procedure);
}

function visualizeProcedure(procedure) {
  const validation = validateProcedureSchema(procedure);

  if (!validation.isValid) {
    renderDataIntegrityError(validation);
    clearRadarCanvas();
    return;
  }

  renderProcedurePanel(procedure);
  drawRadar(procedure);
}

async function extractAndVisualize() {
  const rawText = elements.rawTextInput.value.trim();

  if (rawText === "") {
    renderDataIntegrityError({
      errors: ["Raw chart text is required before extraction."]
    });
    clearRadarCanvas();
    return;
  }

  setExtractionLoading(true);

  try {
    const apiKey = getAdminApiKey();
    const response = await fetch("/api/extract", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey
      },
      body: JSON.stringify({
        text: rawText
      })
    });

    const payload = await response.json();
    handleForbiddenResponse(response);

    if (!response.ok) {
      throw new Error(payload.error || `Extraction failed with status ${response.status}`);
    }

    const procedure = normalizeExtractedProcedure(payload);
    state.extractedProcedure = procedure;
    state.selectedProcedureId = "";
    elements.procedureSelect.value = "";
    elements.archiveButton.classList.add("hidden");
    visualizeProcedure(procedure);
    resetVerifyButton();
    elements.verifyButton.classList.remove("hidden");
  } catch (error) {
    state.extractedProcedure = null;
    elements.verifyButton.classList.add("hidden");
    renderDataIntegrityError({
      errors: [error.message]
    });
    clearRadarCanvas();
  } finally {
    setExtractionLoading(false);
  }
}

function setExtractionLoading(isLoading) {
  elements.extractButton.disabled = isLoading;
  elements.extractLoading.classList.toggle("hidden", !isLoading);
}

function getAdminApiKey() {
  let apiKey = localStorage.getItem("emproview_admin_key");

  if (apiKey === null) {
    apiKey = window.prompt("Admin Authentication Required. Enter API Key:");

    if (apiKey !== null) {
      localStorage.setItem("emproview_admin_key", apiKey);
    }
  }

  return apiKey || "";
}

function handleForbiddenResponse(response) {
  if (response.status === 403) {
    localStorage.removeItem("emproview_admin_key");
    alert("Invalid API Key");
    throw new Error("Invalid API Key");
  }
}

async function verifyAndPublishProcedure() {
  if (!state.extractedProcedure) {
    renderDataIntegrityError({
      errors: ["No AI extracted procedure is available to verify."]
    });
    clearRadarCanvas();
    return;
  }

  elements.verifyButton.disabled = true;

  try {
    const apiKey = getAdminApiKey();
    const response = await fetch("/api/verify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey
      },
      body: JSON.stringify(state.extractedProcedure)
    });
    const payload = await response.json();
    handleForbiddenResponse(response);

    if (!response.ok) {
      throw new Error(payload.error || `Verification failed with status ${response.status}`);
    }

    await loadSampleData();
    elements.verifyButton.classList.remove("hidden");
    elements.verifyButton.textContent = "Published Successfully";
    elements.verifyButton.disabled = true;
  } catch (error) {
    renderDataIntegrityError({
      errors: [error.message]
    });
    clearRadarCanvas();
    elements.verifyButton.disabled = false;
  }
}

function resetVerifyButton() {
  elements.verifyButton.textContent = "Verify & Publish";
  elements.verifyButton.disabled = false;
}

function updateArchiveButtonVisibility(procedure) {
  const isVerifiedProcedure = procedure?.verification?.humanReviewed === true && procedure?.verification?.displayEligible === true;
  elements.archiveButton.classList.toggle("hidden", !isVerifiedProcedure);
}

async function archiveActiveProcedure() {
  const procedure = getSelectedProcedure();
  const currentAirportCode = getProcedureAirportCode(procedure);
  const currentRunway = procedure?.procedureRows?.[0]?.runways?.[0];

  if (!procedure || !currentAirportCode || !currentRunway) {
    renderDataIntegrityError({
      errors: ["No active verified airport/runway procedure is selected for archive."]
    });
    clearRadarCanvas();
    return;
  }

  if (!confirm("Archive this procedure? This will clear it for new updates.")) {
    return;
  }

  elements.archiveButton.disabled = true;

  try {
    const apiKey = getAdminApiKey();
    const response = await fetch(
      `/api/procedures/${encodeURIComponent(currentAirportCode)}/${encodeURIComponent(currentRunway)}`,
      {
        method: "DELETE",
        headers: {
          "x-api-key": apiKey
        }
      }
    );
    const payload = await response.json();
    handleForbiddenResponse(response);

    if (!response.ok) {
      throw new Error(payload.error || `Archive failed with status ${response.status}`);
    }

    await loadSampleData();
    clearRadarCanvas();
    elements.archiveButton.classList.add("hidden");
  } catch (error) {
    renderDataIntegrityError({
      errors: [error.message]
    });
    clearRadarCanvas();
  } finally {
    elements.archiveButton.disabled = false;
  }
}

function getProcedureAirportCode(procedure) {
  return procedure?.source?.airportCode || procedure?.airport?.icao || procedure?.airportCode || "";
}

async function scanImageWithOcr() {
  const file = elements.imageUpload.files[0];

  if (!file) {
    renderDataIntegrityError({
      errors: ["Select an image file before scanning OCR."]
    });
    clearRadarCanvas();
    return;
  }

  setOcrLoading(true);

  try {
    const apiKey = getAdminApiKey();
    const formData = new FormData();
    formData.append("image", file);

    const response = await fetch("/api/ocr", {
      method: "POST",
      headers: {
        "x-api-key": apiKey
      },
      body: formData
    });
    const payload = await response.json();
    handleForbiddenResponse(response);

    if (!response.ok) {
      throw new Error(payload.error || `OCR failed with status ${response.status}`);
    }

    elements.rawTextInput.value = payload.text || "";
  } catch (error) {
    renderDataIntegrityError({
      errors: [error.message]
    });
    clearRadarCanvas();
  } finally {
    setOcrLoading(false);
  }
}

function setOcrLoading(isLoading) {
  elements.ocrButton.disabled = isLoading;
  elements.ocrLoading.classList.toggle("hidden", !isLoading);
}

function normalizeExtractedProcedure(extractedProcedure) {
  const airportCode = extractedProcedure.airportCode || "UNKNOWN";
  const airportIata = airportCode.length === 4 && airportCode.startsWith("K") ? airportCode.slice(1) : airportCode;
  const airlineName = extractedProcedure.airline || "AI Extracted Procedure";
  const aircraft = extractedProcedure.aircraft || "UNKNOWN";

  return {
    id: `ai-extracted-${Date.now()}`,
    airline: {
      name: airlineName,
      icao: "AI"
    },
    source: {
      airportCode,
      chartTitle: extractedProcedure.procedureType || "Live AI Extraction",
      chartDate: new Date().toISOString().slice(0, 10),
      sourceType: "ai_structured_output"
    },
    airport: {
      icao: airportCode,
      iata: airportIata,
      name: airportCode,
      city: "Unknown",
      state: "Unknown",
      country: "Unknown"
    },
    procedureType: extractedProcedure.procedureType,
    operation: "ai_extraction",
    aircraft,
    applicableAircraft: [aircraft],
    verification: {
      status: "ai_unverified",
      humanReviewed: false,
      displayEligible: true
    },
    procedureRows: extractedProcedure.procedureRows.map((row, index) => ({
      rowId: `ai-row-${index + 1}`,
      runways: row.runways,
      triggerFix: row.geometry.segments[0]?.label || "UNKNOWN",
      triggerDescription: "AI extracted chart text",
      condition: "ai_extracted_engine_out",
      instructionText: row.instructionText,
      turnDirection: "not_applicable",
      assignedHeadingDegrees: row.assignedHeadingDegrees,
      routeFixes: row.geometry.segments.map((segment) => segment.label),
      holdInstruction: row.geometry.segments.some((segment) => segment.segmentType === "hold") ? "Hold as extracted." : "none",
      geometry: {
        displayMode: extractedProcedure.procedureType,
        startReference: airportCode,
        endReference: row.geometry.segments.at(-1)?.label || airportCode,
        pathLabel: `${airportCode} extracted route`,
        segments: row.geometry.segments
      }
    }))
  };
}

function getSelectedProcedure() {
  return state.procedures.find((procedure) => procedure.id === state.selectedProcedureId);
}

function validateProcedureSchema(procedure) {
  const errors = [];

  if (!isObject(procedure)) {
    return {
      isValid: false,
      errors: ["Procedure record is missing or not an object."]
    };
  }

  requireString(procedure.id, "procedure.id", errors);
  requireString(procedure.procedureType, "procedure.procedureType", errors);
  requireString(procedure.operation, "procedure.operation", errors);
  requireArray(procedure.applicableAircraft, "procedure.applicableAircraft", errors);

  requireString(procedure.airline?.name, "procedure.airline.name", errors);
  requireString(procedure.airline?.icao, "procedure.airline.icao", errors);
  requireString(procedure.source?.airportCode, "procedure.source.airportCode", errors);
  requireString(procedure.source?.chartTitle, "procedure.source.chartTitle", errors);
  requireString(procedure.source?.chartDate, "procedure.source.chartDate", errors);
  requireString(procedure.source?.sourceType, "procedure.source.sourceType", errors);
  requireString(procedure.airport?.icao, "procedure.airport.icao", errors);
  requireString(procedure.airport?.iata, "procedure.airport.iata", errors);
  requireString(procedure.airport?.name, "procedure.airport.name", errors);
  requireString(procedure.airport?.city, "procedure.airport.city", errors);
  requireString(procedure.airport?.state, "procedure.airport.state", errors);
  requireString(procedure.airport?.country, "procedure.airport.country", errors);
  requireString(procedure.verification?.status, "procedure.verification.status", errors);
  requireBoolean(procedure.verification?.humanReviewed, "procedure.verification.humanReviewed", errors);
  requireBoolean(procedure.verification?.displayEligible, "procedure.verification.displayEligible", errors);

  if (!requireArray(procedure.procedureRows, "procedure.procedureRows", errors)) {
    return {
      isValid: false,
      errors
    };
  }

  procedure.procedureRows.forEach((row, rowIndex) => {
    const rowPath = `procedure.procedureRows[${rowIndex}]`;

    if (!isObject(row)) {
      errors.push(`${rowPath} must be an object.`);
      return;
    }

    requireString(row.rowId, `${rowPath}.rowId`, errors);
    requireArray(row.runways, `${rowPath}.runways`, errors);
    requireString(row.triggerFix, `${rowPath}.triggerFix`, errors);
    requireString(row.triggerDescription, `${rowPath}.triggerDescription`, errors);
    requireString(row.condition, `${rowPath}.condition`, errors);
    requireString(row.instructionText, `${rowPath}.instructionText`, errors);
    requireString(row.turnDirection, `${rowPath}.turnDirection`, errors);
    if (procedure.procedureType === "heading_turn") {
      requireNumber(row.assignedHeadingDegrees, `${rowPath}.assignedHeadingDegrees`, errors);
    } else {
      requireNullableNumber(row.assignedHeadingDegrees, `${rowPath}.assignedHeadingDegrees`, errors);
    }
    requireArray(row.routeFixes, `${rowPath}.routeFixes`, errors);
    requireString(row.holdInstruction, `${rowPath}.holdInstruction`, errors);

    if (!isObject(row.geometry)) {
      errors.push(`${rowPath}.geometry must be an object.`);
      return;
    }

    requireString(row.geometry.displayMode, `${rowPath}.geometry.displayMode`, errors);
    requireString(row.geometry.startReference, `${rowPath}.geometry.startReference`, errors);
    requireString(row.geometry.endReference, `${rowPath}.geometry.endReference`, errors);
    requireString(row.geometry.pathLabel, `${rowPath}.geometry.pathLabel`, errors);

    if (!requireArray(row.geometry.segments, `${rowPath}.geometry.segments`, errors)) {
      return;
    }

    row.geometry.segments.forEach((segment, segmentIndex) => {
      const segmentPath = `${rowPath}.geometry.segments[${segmentIndex}]`;

      if (!isObject(segment)) {
        errors.push(`${segmentPath} must be an object.`);
        return;
      }

      requireString(segment.segmentType, `${segmentPath}.segmentType`, errors);
      requireString(segment.label, `${segmentPath}.label`, errors);
      requireSegmentHeading(segment, `${segmentPath}.headingDegrees`, errors);
      requireOptionalNullableNumber(segment.distanceNM, `${segmentPath}.distanceNM`, errors);
    });
  });

  return {
    isValid: errors.length === 0,
    errors
  };
}

function requireString(value, fieldName, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${fieldName} is required and must be a non-empty string.`);
    return false;
  }

  return true;
}

function requireNumber(value, fieldName, errors) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    errors.push(`${fieldName} is required and must be a number.`);
    return false;
  }

  return true;
}

function requireNullableNumber(value, fieldName, errors) {
  if (value === null || value === 0) {
    return true;
  }

  return requireNumber(value, fieldName, errors);
}

function requireOptionalNullableNumber(value, fieldName, errors) {
  if (value === null || value === undefined || value === 0) {
    return true;
  }

  return requireNumber(value, fieldName, errors);
}

function requireSegmentHeading(segment, fieldName, errors) {
  if (typeof segment.headingDegrees === "number" && !Number.isNaN(segment.headingDegrees)) {
    return true;
  }

  const hasSpatialTrigger = segment.spatialTrigger !== null && segment.spatialTrigger !== undefined;
  const hasComputedSpatialTrigger =
    segment.computedSpatialTrigger?.computedTurnPoint !== null && segment.computedSpatialTrigger?.computedTurnPoint !== undefined;
  const hasTargetWaypoint = typeof segment.targetWaypoint === "string" && segment.targetWaypoint.trim() !== "";

  if (segment.headingDegrees === null && (hasSpatialTrigger || hasComputedSpatialTrigger || hasTargetWaypoint)) {
    return true;
  }

  errors.push(`${fieldName} is required unless spatialTrigger or targetWaypoint is present.`);
  return false;
}

function requireBoolean(value, fieldName, errors) {
  if (typeof value !== "boolean") {
    errors.push(`${fieldName} is required and must be a boolean.`);
    return false;
  }

  return true;
}

function requireArray(value, fieldName, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${fieldName} is required and must be a non-empty array.`);
    return false;
  }

  return true;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function renderProcedurePanel(procedure) {
  resetProcedureDisplayState();

  if (!procedure) {
    elements.radarLabel.textContent = "Awaiting procedure";
    elements.procedurePanel.innerHTML = '<p class="text-sm text-slate-400">No procedure selected.</p>';
    return;
  }

  elements.radarLabel.textContent = `${procedure.airline.icao} ${procedure.airport.iata} ${formatLabel(procedure.procedureType)}`;

  const rows = procedure.procedureRows
    .map((row) => {
      const heading =
        row.assignedHeadingDegrees > 0 ? `${row.assignedHeadingDegrees} deg` : row.geometry.pathLabel;

      return `
        <article class="procedure-card">
          <div class="mb-2 flex items-center justify-between gap-3">
            <h4 class="font-semibold text-cyan-100">RWY ${row.runways.join(", ")}</h4>
            <span class="text-xs uppercase tracking-[0.18em] text-slate-400">${heading}</span>
          </div>
          <p class="text-sm text-slate-200">${row.instructionText}</p>
          <dl class="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-400">
            <div>
              <dt class="uppercase tracking-[0.15em] text-slate-500">Trigger</dt>
              <dd class="text-slate-200">${row.triggerDescription}</dd>
            </div>
            <div>
              <dt class="uppercase tracking-[0.15em] text-slate-500">Fixes</dt>
              <dd class="text-slate-200">${row.routeFixes.join(" -> ")}</dd>
            </div>
          </dl>
        </article>
      `;
    })
    .join("");

  elements.procedurePanel.innerHTML = `
    <div class="mb-4 flex items-start justify-between gap-3">
      <div>
        <p class="text-xs uppercase tracking-[0.25em] text-cyan-300">${procedure.airline.name}</p>
        <h3 class="mt-1 text-xl font-semibold text-slate-50">${procedure.source.chartTitle}</h3>
        <p class="mt-1 text-sm text-slate-400">${procedure.airport.name} (${procedure.airport.icao}/${procedure.airport.iata})</p>
      </div>
      <span class="status-pill">${formatLabel(procedure.verification.status)}</span>
    </div>

    <div class="mb-4 grid grid-cols-2 gap-3 text-sm">
      <div class="rounded-lg bg-slate-900/80 p-3">
        <p class="text-xs uppercase tracking-[0.2em] text-slate-500">Type</p>
        <p class="mt-1 text-slate-100">${formatLabel(procedure.procedureType)}</p>
      </div>
      <div class="rounded-lg bg-slate-900/80 p-3">
        <p class="text-xs uppercase tracking-[0.2em] text-slate-500">Aircraft</p>
        <p class="mt-1 text-slate-100">${getAircraftDisplay(procedure)}</p>
      </div>
    </div>

    <div class="space-y-3">${rows}</div>
  `;
}

function getAircraftDisplay(procedure) {
  if (typeof procedure.aircraft === "string" && procedure.aircraft.trim() !== "") {
    return procedure.aircraft;
  }

  return procedure.applicableAircraft.join(", ");
}

function resetProcedureDisplayState() {
  elements.radarLabel.className = "rounded border border-cyan-400/30 px-3 py-1 text-xs text-cyan-200";
  elements.procedurePanel.setAttribute("role", "status");
  elements.procedurePanel.setAttribute("aria-live", "polite");
  elements.procedurePanel.dataset.displayState = "normal";
  elements.procedurePanel.className =
    "min-h-0 flex-1 overflow-y-auto rounded-lg border border-slate-700 bg-slate-950/70 p-4";
}

function renderDataIntegrityError(validation) {
  elements.radarLabel.textContent = "DATA INTEGRITY ERROR";
  elements.radarLabel.className = "rounded border border-red-400 bg-red-950 px-3 py-1 text-xs font-bold text-red-100";
  elements.procedurePanel.setAttribute("role", "alert");
  elements.procedurePanel.setAttribute("aria-live", "assertive");
  elements.procedurePanel.dataset.displayState = "error";
  elements.procedurePanel.className =
    "min-h-0 flex-1 overflow-y-auto rounded-lg border-2 border-red-500 bg-red-950/80 p-4 shadow-[0_0_40px_rgba(239,68,68,0.35)]";
  elements.procedurePanel.innerHTML = `
    <section class="rounded-lg border-2 border-red-400 bg-red-600 p-5 text-white">
      <p class="text-xs font-black uppercase tracking-[0.35em]">Hard Fail State</p>
      <h3 class="mt-3 text-2xl font-black uppercase leading-tight">
        DATA INTEGRITY ERROR: Corrupted Procedure Schema
      </h3>
      <p class="mt-4 text-sm font-semibold">
        Procedure display has been blocked. Radar vectors and verified procedure details are hidden until the schema is repaired.
      </p>
    </section>
    <section class="mt-4 rounded-lg border border-red-400/60 bg-slate-950/80 p-4">
      <p class="text-xs font-bold uppercase tracking-[0.25em] text-red-200">Validation Failures</p>
      <ul class="mt-3 list-disc space-y-2 pl-5 text-sm text-red-100">
        ${validation.errors.map((error) => `<li>${error}</li>`).join("")}
      </ul>
    </section>
  `;
}

function drawRadar(procedure) {
  resizeCanvas();

  const width = elements.canvas.width;
  const height = elements.canvas.height;
  const centerX = width * 0.48;
  const centerY = height * 0.56;
  const pixelsPerNM = (Math.min(elements.canvas.width, elements.canvas.height) / 2) / RADAR_RANGE_NM;

  canvasContext.clearRect(0, 0, width, height);
  drawRangeRings(centerX, centerY, pixelsPerNM);
  drawRunways(centerX, centerY);
  drawTargets();

  if (procedure) {
    drawProcedureVector(procedure, centerX, centerY, pixelsPerNM);
  }
}

function clearRadarCanvas() {
  resizeCanvas();
  canvasContext.clearRect(0, 0, elements.canvas.width, elements.canvas.height);
}

function resizeCanvas() {
  const bounds = elements.canvas.getBoundingClientRect();
  elements.canvas.width = Math.max(1, Math.floor(bounds.width));
  elements.canvas.height = Math.max(1, Math.floor(bounds.height));
}

function drawRangeRings(centerX, centerY, pixelsPerNM) {
  canvasContext.strokeStyle = "rgba(34, 211, 238, 0.24)";
  canvasContext.lineWidth = 1;

  [5, 10, 15, 20].forEach((rangeNM) => {
    canvasContext.beginPath();
    canvasContext.arc(centerX, centerY, rangeNM * pixelsPerNM, 0, Math.PI * 2);
    canvasContext.stroke();
  });

  canvasContext.fillStyle = "rgba(226, 232, 240, 0.72)";
  canvasContext.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
  canvasContext.fillText("KSFO", centerX + 16, centerY - 12);
}

function drawRunways(centerX, centerY) {
  canvasContext.save();
  canvasContext.translate(centerX, centerY);
  canvasContext.rotate((-28 * Math.PI) / 180);
  canvasContext.strokeStyle = "rgba(226, 232, 240, 0.9)";
  canvasContext.lineWidth = 7;
  canvasContext.beginPath();
  canvasContext.moveTo(-65, 0);
  canvasContext.lineTo(65, 0);
  canvasContext.stroke();
  canvasContext.strokeStyle = "rgba(15, 23, 42, 0.9)";
  canvasContext.lineWidth = 2;
  canvasContext.beginPath();
  canvasContext.moveTo(-65, 0);
  canvasContext.lineTo(65, 0);
  canvasContext.stroke();
  canvasContext.restore();
}

function drawTargets() {
  const targets = [
    { x: 0.22, y: 0.28, label: "AAL752" },
    { x: 0.72, y: 0.24, label: "DAL107B" },
    { x: 0.78, y: 0.68, label: "UAL443" }
  ];

  targets.forEach((target) => {
    const x = getCanvasWidth() * target.x;
    const y = getCanvasHeight() * target.y;

    canvasContext.fillStyle = "rgba(34, 211, 238, 0.95)";
    canvasContext.beginPath();
    canvasContext.arc(x, y, 4, 0, Math.PI * 2);
    canvasContext.fill();
    canvasContext.fillStyle = "rgba(203, 213, 225, 0.9)";
    canvasContext.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    canvasContext.fillText(target.label, x + 8, y - 8);
  });
}

function drawProcedureVector(procedure, centerX, centerY, pixelsPerNM) {
  if (procedure.procedureType === "conditional_route") {
    drawSequentialFlightPath(
      centerX,
      centerY,
      procedure.procedureRows[0].geometry.segments,
      "rgba(96, 165, 250, 0.95)",
      "rgba(219, 234, 254, 0.95)",
      pixelsPerNM
    );
    return;
  }

  procedure.procedureRows.forEach((row) => {
    drawSequentialFlightPath(
      centerX,
      centerY,
      row.geometry.segments,
      "rgba(248, 113, 113, 0.95)",
      "rgba(254, 226, 226, 0.95)",
      pixelsPerNM
    );
  });
}

function drawSequentialFlightPath(centerX, centerY, segments, strokeColor, labelColor, pixelsPerNM) {
  let currentPosition = { x: centerX, y: centerY };
  let finalHeadingRadians = 0;
  let pathHasDrawableSegments = false;
  let pathIsOpen = false;

  canvasContext.strokeStyle = strokeColor;
  canvasContext.lineWidth = 3;

  segments.forEach((segment) => {
    const cogoPath = drawCogoTurnPath(currentPosition, segment, strokeColor, labelColor, pixelsPerNM, centerX, centerY);

    if (cogoPath) {
      if (pathIsOpen && pathHasDrawableSegments) {
        canvasContext.stroke();
        pathIsOpen = false;
        pathHasDrawableSegments = false;
      }

      currentPosition = cogoPath.currentPosition;
      finalHeadingRadians = cogoPath.finalHeadingRadians;
      return;
    }

    const resolvedHeading = resolveSegmentHeading(segment);

    if (resolvedHeading === null) {
      drawNullHeadingSegment(currentPosition, segment, labelColor);
      return;
    }

    if (!pathIsOpen) {
      canvasContext.beginPath();
      canvasContext.moveTo(currentPosition.x, currentPosition.y);
      pathIsOpen = true;
    }

    const headingRadians = degreesToRadians(resolvedHeading);
    const distanceNM = getSegmentDistanceNM(segment);
    const distance = distanceNM * pixelsPerNM;
    const nextPosition = {
      x: currentPosition.x + Math.sin(headingRadians) * distance,
      y: currentPosition.y - Math.cos(headingRadians) * distance
    };

    canvasContext.lineTo(nextPosition.x, nextPosition.y);
    drawSegmentLabel(nextPosition, segment.label, labelColor);
    pathHasDrawableSegments = true;

    currentPosition = nextPosition;
    finalHeadingRadians = headingRadians;
  });

  if (pathIsOpen && pathHasDrawableSegments) {
    canvasContext.stroke();
    drawArrowHead(currentPosition.x, currentPosition.y, finalHeadingRadians - Math.PI / 2, strokeColor);
  }

  if (segments.some((segment) => segment.segmentType === "hold")) {
    drawHoldPattern(currentPosition.x, currentPosition.y, strokeColor);
  }
}

function drawCogoTurnPath(currentPosition, segment, strokeColor, labelColor, pixelsPerNM, centerX, centerY) {
  console.log("CANVAS RENDERER EXECUTING NEW PATH LOGIC");

  const computedPoint = segment.computedSpatialTrigger?.computedTurnPoint;
  const resultingAction = segment.computedSpatialTrigger?.resultingAction || segment.spatialTrigger?.resultingAction;
  const outboundHeading = Number(resultingAction?.magneticHeading);

  if (!computedPoint || typeof outboundHeading !== "number" || Number.isNaN(outboundHeading)) {
    return null;
  }

  const triggerPosition = geoPointToCanvasPosition(computedPoint, centerX, centerY, pixelsPerNM);
  const headingRadians = degreesToRadians(outboundHeading);
  const outboundDistance = 12 * pixelsPerNM;
  const outboundPosition = {
    x: triggerPosition.x + Math.sin(headingRadians) * outboundDistance,
    y: triggerPosition.y - Math.cos(headingRadians) * outboundDistance
  };
  const turnDirection = resultingAction.turnDirection ? resultingAction.turnDirection.toUpperCase() : "TURN";
  const runwayX = currentPosition.x;
  const runwayY = currentPosition.y;
  const turnPointX = triggerPosition.x;
  const turnPointY = triggerPosition.y;
  const outboundEndX = outboundPosition.x;
  const outboundEndY = outboundPosition.y;

  canvasContext.save();
  canvasContext.strokeStyle = strokeColor;
  canvasContext.lineWidth = 2;
  canvasContext.beginPath();
  canvasContext.moveTo(runwayX, runwayY);
  if (Number.isFinite(turnPointX) && Number.isFinite(turnPointY)) {
    canvasContext.lineTo(turnPointX, turnPointY);
    if (Number.isFinite(outboundEndX) && Number.isFinite(outboundEndY)) {
      canvasContext.lineTo(outboundEndX, outboundEndY);
    }
  }
  canvasContext.stroke();
  canvasContext.restore();

  drawArrowHead(outboundPosition.x, outboundPosition.y, headingRadians - Math.PI / 2, strokeColor);
  drawTurnJoint(triggerPosition, strokeColor);
  drawSegmentLabel(triggerPosition, `${segment.label} ${turnDirection}`, labelColor);
  drawSegmentLabel(outboundPosition, `${outboundHeading} deg`, labelColor);

  return {
    currentPosition: outboundPosition,
    finalHeadingRadians: headingRadians
  };
}

function geoPointToCanvasPosition(point, centerX, centerY, pixelsPerNM) {
  const latitude = Number(point.latitude);
  const longitude = Number(point.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { x: centerX, y: centerY };
  }

  const deltaNorthNm = (latitude - KSLC_16L_THRESHOLD.latitude) * 60;
  const deltaEastNm =
    (longitude - KSLC_16L_THRESHOLD.longitude) * 60 * Math.cos(degreesToRadians(KSLC_16L_THRESHOLD.latitude));

  return {
    x: centerX + deltaEastNm * pixelsPerNM,
    y: centerY - deltaNorthNm * pixelsPerNM
  };
}

function drawTurnJoint(position, strokeColor) {
  canvasContext.save();
  canvasContext.strokeStyle = strokeColor;
  canvasContext.lineWidth = 2;
  canvasContext.beginPath();
  canvasContext.arc(position.x, position.y, 5, 0, Math.PI * 2);
  canvasContext.stroke();
  canvasContext.restore();
}

function resolveSegmentHeading(segment) {
  if (typeof segment.headingDegrees === "number" && !Number.isNaN(segment.headingDegrees)) {
    return segment.headingDegrees;
  }

  const actionHeading =
    segment.computedSpatialTrigger?.resultingAction?.magneticHeading ??
    segment.spatialTrigger?.resultingAction?.magneticHeading;

  if (typeof actionHeading === "number" && !Number.isNaN(actionHeading)) {
    return actionHeading;
  }

  return null;
}

function drawNullHeadingSegment(position, segment, labelColor) {
  const computedPoint = segment.computedSpatialTrigger?.computedTurnPoint;
  const waypointLabel = segment.targetWaypoint || segment.label || "COGO constraint";

  canvasContext.save();
  canvasContext.fillStyle = labelColor;
  canvasContext.strokeStyle = labelColor;
  canvasContext.setLineDash([4, 4]);
  canvasContext.beginPath();
  canvasContext.arc(position.x, position.y, 7, 0, Math.PI * 2);
  canvasContext.stroke();
  canvasContext.setLineDash([]);
  canvasContext.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";

  if (computedPoint) {
    canvasContext.fillText(`${waypointLabel} ${formatComputedPoint(computedPoint)}`, position.x + 10, position.y - 10);
  } else {
    canvasContext.fillText(`${waypointLabel} heading unavailable`, position.x + 10, position.y - 10);
  }

  canvasContext.restore();
}

function formatComputedPoint(point) {
  const latitude = Number(point.latitude);
  const longitude = Number(point.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return "";
  }

  return `(${latitude.toFixed(4)}, ${longitude.toFixed(4)})`;
}

function getSegmentDistanceNM(segment) {
  if (segment.distanceNM === null || segment.distanceNM === undefined) {
    return 5;
  }

  if (typeof segment.distanceNM === "number" && !Number.isNaN(segment.distanceNM)) {
    return segment.distanceNM;
  }

  return 5;
}

function drawSegmentLabel(position, label, labelColor) {
  canvasContext.fillStyle = labelColor;
  canvasContext.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
  canvasContext.fillText(label, position.x + 8, position.y);
}

function drawHoldPattern(x, y, strokeColor) {
  canvasContext.strokeStyle = strokeColor.replace("0.95", "0.7");
  canvasContext.beginPath();
  canvasContext.ellipse(x + 52, y, 72, 42, -0.45, 0, Math.PI * 2);
  canvasContext.stroke();
}

function drawArrowHead(x, y, radians, color) {
  canvasContext.save();
  canvasContext.translate(x, y);
  canvasContext.rotate(radians);
  canvasContext.fillStyle = color;
  canvasContext.beginPath();
  canvasContext.moveTo(0, 0);
  canvasContext.lineTo(-12, -6);
  canvasContext.lineTo(-12, 6);
  canvasContext.fill();
  canvasContext.closePath();
  canvasContext.restore();
}

function degreesToRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function formatLabel(value) {
  return value
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getCanvasWidth() {
  return elements.canvas.getBoundingClientRect().width;
}

function getCanvasHeight() {
  return elements.canvas.getBoundingClientRect().height;
}

elements.procedureSelect.addEventListener("change", (event) => {
  selectProcedure(event.target.value);
});

elements.extractButton.addEventListener("click", () => {
  extractAndVisualize();
});

elements.ocrButton.addEventListener("click", () => {
  scanImageWithOcr();
});

elements.verifyButton.addEventListener("click", () => {
  verifyAndPublishProcedure();
});

elements.archiveButton.addEventListener("click", () => {
  archiveActiveProcedure();
});

window.addEventListener("resize", () => {
  drawRadar(getSelectedProcedure());
});

loadProcedures();
