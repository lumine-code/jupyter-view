// Cell reordering is an embedded, document-local interaction. It deliberately
// stays outside the application/x-lumine-drag workspace transfer protocol and
// is claimed by the notebook container before the global unhandled-drop guard.
const CELL_DRAG_MIME = "application/x-jupyter-cell";
const CELL_DRAG_VERSION = 1;

function cellDragTypeForDocument(documentId) {
  return `${CELL_DRAG_MIME};v=${CELL_DRAG_VERSION};d=${encodeURIComponent(documentId)}`;
}

function inspectCellDrag(dataTransfer) {
  for (const type of Array.from(dataTransfer?.types || [])) {
    if (typeof type !== "string" || !type.toLowerCase().startsWith(`${CELL_DRAG_MIME};`)) {
      continue;
    }
    const fields = Object.create(null);
    try {
      for (const part of type.slice(CELL_DRAG_MIME.length + 1).split(";")) {
        const separator = part.indexOf("=");
        if (separator > 0) {
          fields[part.slice(0, separator).toLowerCase()] = decodeURIComponent(
            part.slice(separator + 1),
          );
        }
      }
    } catch {
      continue;
    }
    if (Number(fields.v) !== CELL_DRAG_VERSION || !fields.d) continue;
    return { type, sourceDocumentId: fields.d };
  }
  return null;
}

function hasCellDrag(dataTransfer) {
  return inspectCellDrag(dataTransfer) != null;
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.sourceDocumentId !== "string" || !payload.sourceDocumentId) return null;
  if (typeof payload.primaryCellId !== "string" || !payload.primaryCellId) return null;
  if (!Array.isArray(payload.cellIds) || payload.cellIds.length === 0) return null;
  if (payload.cellIds.some((cellId) => typeof cellId !== "string" || !cellId)) return null;
  if (new Set(payload.cellIds).size !== payload.cellIds.length) return null;
  if (!payload.cellIds.includes(payload.primaryCellId)) return null;
  return {
    sourceDocumentId: payload.sourceDocumentId,
    primaryCellId: payload.primaryCellId,
    cellIds: [...payload.cellIds],
  };
}

function writeCellDrag(dataTransfer, payload) {
  const normalized = normalizePayload(payload);
  if (!normalized) throw new TypeError("Invalid notebook cell drag payload");
  for (const type of Array.from(dataTransfer?.types || [])) {
    if (typeof type === "string" && type.toLowerCase().startsWith(CELL_DRAG_MIME)) {
      dataTransfer.clearData?.(type);
    }
  }
  dataTransfer.setData(
    cellDragTypeForDocument(normalized.sourceDocumentId),
    JSON.stringify(normalized),
  );
  return normalized;
}

function readCellDrag(dataTransfer) {
  const offer = inspectCellDrag(dataTransfer);
  if (!offer) return null;
  try {
    const payload = normalizePayload(JSON.parse(dataTransfer.getData(offer.type)));
    return payload?.sourceDocumentId === offer.sourceDocumentId ? payload : null;
  } catch {
    return null;
  }
}

module.exports = {
  CELL_DRAG_MIME,
  CELL_DRAG_VERSION,
  cellDragTypeForDocument,
  hasCellDrag,
  inspectCellDrag,
  readCellDrag,
  writeCellDrag,
};
