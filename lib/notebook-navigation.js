// Each observer owns its tree. Shared heading descriptions can be cached by
// the editor, while current and visible state stay local to each subscription.
class NotebookNavigation {
  constructor() {
    this.headings = null;
    this.headers = [];
    this.stateKey = null;
  }

  update(headings, activeCellIndex, visibleCellIndexes) {
    const structural = this.headings !== headings;
    const stateKey = `${activeCellIndex}:${visibleCellIndexes.join(",")}`;
    let stateChanges;
    if (structural) {
      this.headings = headings;
      this.headers = buildNavigationTree(headings, activeCellIndex, visibleCellIndexes);
    } else {
      stateChanges =
        stateKey === this.stateKey
          ? []
          : updateNavigationState(this.headers, activeCellIndex, visibleCellIndexes);
    }
    this.stateKey = stateKey;
    const scrollBoundary =
      this.headers.length &&
      visibleCellIndexes.length &&
      visibleCellIndexes[visibleCellIndexes.length - 1] < this.headers[0].cellIndex
        ? "start"
        : null;
    return { headers: structural ? this.headers : null, stateChanges, scrollBoundary };
  }
}

function buildNavigationTree(headings, activeCellIndex, visibleCellIndexes) {
  const headers = [];
  const stack = [];
  let lastItem = null;
  const visibleCells = new Set(visibleCellIndexes);

  headings.forEach((heading, index) => {
    const current = heading.cellIndex === activeCellIndex;
    const item = {
      ...heading,
      children: [],
      startPoint: { row: index, column: 0 },
      endPoint: { row: index, column: 0 },
      lastRow: headings.length,
      currentCount: current ? 1 : 0,
      stackCount: current ? 1 : 0,
      visibility: visibleCells.has(heading.cellIndex) ? 1 : 0,
    };

    while (stack.length && stack[stack.length - 1].level >= item.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(item);
    else headers.push(item);

    stack.push(item);
    if (lastItem) lastItem.lastRow = item.startPoint.row - 1;
    lastItem = item;
  });

  updateNavigationState(headers, activeCellIndex, visibleCellIndexes);
  return headers;
}

function updateNavigationState(headers, activeCellIndex, visibleCellIndexes) {
  const changes = [];
  const visibleCells = new Set(visibleCellIndexes);
  const update = (items, parentPath) => {
    let hasCurrent = false;
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const path = [...parentPath, index];
      const childCurrent = update(item.children, path);
      const currentCount = item.cellIndex === activeCellIndex ? 1 : 0;
      const stackCount = currentCount || childCurrent ? 1 : 0;
      const visibility = visibleCells.has(item.cellIndex) ? 1 : 0;
      if (
        item.currentCount !== currentCount ||
        item.stackCount !== stackCount ||
        item.visibility !== visibility
      ) {
        Object.assign(item, { currentCount, stackCount, visibility });
        changes.push({ path, currentCount, stackCount, visibility });
      }
      hasCurrent ||= stackCount > 0;
    }
    return hasCurrent;
  };
  update(headers, []);
  // Expansion must reach ancestors before their descendants.
  return changes.reverse();
}

module.exports = { NotebookNavigation, buildNavigationTree };
