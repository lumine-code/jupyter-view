const etch = require("@lumine-code/etch");
const NotebookView = require("../lib/notebook-view");

describe("notebook horizontal overlay clearance", () => {
  let view, container, controller;

  afterEach(() => {
    const element = view?.element;
    view?.destroy();
    controller?.dispose();
    element?.remove();
  });

  async function mount({ scrollPastEnd = false, layout = "overlay" } = {}) {
    lumine.config.set("editor.scrollPastEnd", scrollPastEnd);
    const cells = Array.from({ length: 8 }, (_, index) => ({
      id: `row-${index}`,
      type: "raw",
      source: `Notebook row ${index}`,
      outputs: [],
      status: "idle",
    }));
    view = new NotebookView({ cells, activeCellIndex: 0, editor: null });
    etch.updateSync(view);
    view.element.style.cssText = "position:absolute;left:20px;top:20px;width:300px;height:240px";
    container = view.cellsContainer;
    container.dataset.scrollbarLayout = layout;
    container.style.cssText = "flex:none;width:300px;height:180px;padding:0;overflow:auto";
    for (const cell of view.cellViews.values())
      cell.element.style.cssText = "width:900px;height:60px;min-height:60px;overflow:hidden";
    jasmine.attachToDOM(view.element);
    controller = lumine.scrollbars.attach(container);
    view.applyScrollPastEnd();
    await settle((geometry) => geometry.layout === layout);
  }

  async function settle(condition = () => true) {
    let stableFrames = 0;
    await globalThis.waitForFrames(
      () => {
        const geometry = lumine.scrollbars.getGeometry(container);
        const manager = controller.manager;
        const stable =
          controller.publicGeometry &&
          geometry.scrollHeight === container.scrollHeight &&
          geometry.viewportHeight === container.clientHeight &&
          view._scrollEndInset === geometry.scrollEndInset &&
          !manager.pending &&
          !manager.writeRequest &&
          manager.dirty.size === 0 &&
          view._frames.pending.size === 0 &&
          condition(geometry);
        stableFrames = stable ? stableFrames + 1 : 0;
        return stableFrames >= 2;
      },
      { frames: 120, description: "settled notebook overlay geometry" },
    );
  }

  for (const layout of ["overlay", "gutter"]) {
    it(`reveals the final cell above the ${layout} rail without scroll-past-end`, async () => {
      await mount({ layout });
      const nativeScroll = container.scrollTo.bind(container);
      spyOn(container, "scrollTo").and.callFake((options) =>
        nativeScroll({ ...options, behavior: "instant" }),
      );
      view.scrollToCell(7);
      const last = view.cellViews.get("row-7").element;
      expect(last.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        controller.horizontal.element.getBoundingClientRect().top + 0.5,
      );
      expect(view._scrollEndInset).toBe(
        layout === "overlay" ? controller.geometry.horizontalSize : 0,
      );
      expect(view.scrollViewportHeight()).toBe(
        container.clientHeight - (layout === "overlay" ? controller.geometry.horizontalSize : 0),
      );
    });
  }

  it("does not rewrite scroll-past-end padding when the overlay reserve changes its content box", async () => {
    await mount({ scrollPastEnd: true });
    const apply = spyOn(view, "applyScrollPastEnd").and.callThrough();
    for (const cell of view.cellViews.values()) cell.element.style.width = "200px";
    await settle((geometry) => geometry.scrollEndInset === 0);
    for (const cell of view.cellViews.values()) cell.element.style.width = "900px";
    await settle((geometry) => geometry.scrollEndInset === geometry.horizontalSize);
    expect(apply).not.toHaveBeenCalled();
    expect(parseFloat(getComputedStyle(container).paddingBottom)).toBe(
      container.clientHeight - 50 + view._scrollEndInset,
    );
  });

  it("updates scroll-past-end for a native gutter's changing client height without double reserve", async () => {
    await mount({ scrollPastEnd: true, layout: "gutter" });
    expect(parseFloat(getComputedStyle(container).paddingBottom)).toBe(container.clientHeight - 50);
    for (const cell of view.cellViews.values()) cell.element.style.width = "200px";
    await settle((geometry) => !geometry.canScrollHorizontally);
    expect(parseFloat(getComputedStyle(container).paddingBottom)).toBe(container.clientHeight - 50);
    for (const cell of view.cellViews.values()) cell.element.style.width = "900px";
    await settle((geometry) => geometry.canScrollHorizontally);
    expect(view._scrollEndInset).toBe(0);
    expect(parseFloat(getComputedStyle(container).paddingBottom)).toBe(container.clientHeight - 50);
  });
});
