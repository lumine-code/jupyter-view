class PresentationFrames {
  constructor(element) {
    this.element = element;
    this.pending = new Set();
    this.destroyed = false;
  }

  request(callback) {
    if (this.destroyed) return null;
    const request = { callback };
    this.pending.add(request);
    this.schedule(request);
    return request;
  }

  schedule(request) {
    const window = this.element.ownerDocument.defaultView;
    const generation = (request.generation || 0) + 1;
    request.generation = generation;
    request.window = window;
    request.cancel = window.cancelAnimationFrame.bind(window);
    request.frame = window.requestAnimationFrame((timestamp) => {
      if (request.generation !== generation || !this.pending.delete(request)) return;
      request.frame = null;
      request.cancel = null;
      request.window = null;
      request.callback(timestamp);
    });
  }

  cancel(request) {
    if (!this.pending.delete(request)) return;
    request.cancel(request.frame);
    request.frame = request.cancel = request.window = null;
  }

  didAttachToWindow() {
    const window = this.element.ownerDocument.defaultView;
    for (const request of this.pending) {
      if (request.window === window) continue;
      request.cancel(request.frame);
      this.schedule(request);
    }
  }

  destroy() {
    this.destroyed = true;
    for (const request of this.pending) this.cancel(request);
  }
}

module.exports = PresentationFrames;
