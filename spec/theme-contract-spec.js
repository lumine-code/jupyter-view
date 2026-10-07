const path = require("path");

describe("notebook surface theme ownership", () => {
  it("keeps cell content readable with independent UI and syntax palettes", () => {
    const stylesheet = lumine.themes.requireStylesheet(
      path.join(__dirname, "..", "styles", "main.css"),
    );
    const container = document.createElement("div");
    container.className = "jupyter-view";
    container.style.cssText =
      "--syntax-text-color: rgb(10,20,30); --syntax-background-color: rgb(240,230,220); --text-color: rgb(200,210,220); --tool-panel-background-color: rgb(50,60,70);";
    container.innerHTML =
      '<div class="jupyter-cell"><div class="cell-gutter">Gutter</div><div class="cell-content"><div class="markdown-rendered">Markdown</div><div class="jupyter-outputs"><pre>Output</pre></div></div></div>';
    jasmine.attachToDOM(container);
    try {
      const cell = container.querySelector(".jupyter-cell");
      expect(getComputedStyle(cell).backgroundColor).toBe("rgb(240, 230, 220)");
      expect(getComputedStyle(cell).color).toBe("rgb(10, 20, 30)");
      expect(getComputedStyle(container.querySelector(".jupyter-outputs pre")).color).toBe(
        "rgb(10, 20, 30)",
      );
      const gutter = container.querySelector(".cell-gutter");
      expect(getComputedStyle(gutter).color).toBe("rgb(200, 210, 220)");
      expect(getComputedStyle(gutter).backgroundColor).toBe("rgb(50, 60, 70)");
      cell.classList.add("dragging");
      const draggingBackground = getComputedStyle(cell).backgroundColor;
      container.style.setProperty("--text-color", "rgb(100,110,120)");
      expect(getComputedStyle(cell).backgroundColor).toBe(draggingBackground);
      container.style.setProperty("--syntax-background-color", "rgb(210,220,230)");
      expect(getComputedStyle(cell).backgroundColor).not.toBe(draggingBackground);
    } finally {
      container.remove();
      stylesheet.dispose();
    }
  });
});
