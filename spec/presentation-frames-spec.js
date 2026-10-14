const PresentationFrames = require("../lib/presentation-frames");

describe("Notebook presentation frames", () => {
  function nativeWindow() {
    return {
      callbacks: [],
      requestAnimationFrame(callback) {
        return this.callbacks.push(callback);
      },
      cancelAnimationFrame: jasmine.createSpy("cancelAnimationFrame"),
    };
  }

  it("moves a pending layout callback to the new window without losing or repeating it", () => {
    const first = nativeWindow();
    const second = nativeWindow();
    const element = { ownerDocument: { defaultView: first } };
    const frames = new PresentationFrames(element);
    const callback = jasmine.createSpy("layout");
    frames.request(callback);
    element.ownerDocument = { defaultView: second };
    frames.didAttachToWindow();
    expect(first.cancelAnimationFrame).toHaveBeenCalledOnceWith(1);
    expect(second.callbacks.length).toBe(1);
    first.callbacks[0](10000);
    expect(callback).not.toHaveBeenCalled();
    second.callbacks[0](42);
    expect(callback).toHaveBeenCalledOnceWith(42);
    frames.destroy();
  });

  it("cancels a retained request through its current owner after migration", () => {
    const first = nativeWindow();
    const second = nativeWindow();
    const element = { ownerDocument: { defaultView: first } };
    const frames = new PresentationFrames(element);
    const callback = jasmine.createSpy("layout");
    const request = frames.request(callback);
    element.ownerDocument = { defaultView: second };
    frames.didAttachToWindow();
    frames.cancel(request);
    expect(second.cancelAnimationFrame).toHaveBeenCalledOnceWith(1);
    second.callbacks[0](42);
    expect(callback).not.toHaveBeenCalled();
    frames.destroy();
  });

  it("retires every pending frame when the notebook is destroyed", () => {
    const window = nativeWindow();
    const frames = new PresentationFrames({ ownerDocument: { defaultView: window } });
    const callback = jasmine.createSpy("layout");
    frames.request(callback);
    frames.request(callback);
    frames.destroy();
    for (const frame of window.callbacks) frame(0);
    expect(window.cancelAnimationFrame).toHaveBeenCalledTimes(2);
    expect(callback).not.toHaveBeenCalled();
    expect(frames.request(callback)).toBeNull();
  });
});
