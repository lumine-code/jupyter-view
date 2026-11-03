/** @jsx etch.dom */
const etch = require("@lumine-code/etch");

// One coordinate system for both notebook toolbars. Font glyphs from different
// Octicons generations have different baselines, even inside a centered box.
// These drawings own their geometry; filled triangles are optically centered.
const ICONS = {
  run: { d: "M5 3.5 12.5 8 5 12.5Z", filled: true },
  "run-next": { d: "M4 3.5h8L8 8.5Z M3 11.5h10v1H3Z", filled: true },
  "run-all": { d: "M3 4 9 8 3 12Z M9 4 15 8 9 12Z", filled: true },
  interrupt: { d: "M5 2h6l3 3v6l-3 3H5l-3-3V5Z M8 5v3 M8 11h.01" },
  restart: {
    d: "M13.5 7A5.5 5.5 0 0 0 4 4L2.5 5.5 M2.5 2.5v3h3 M2.5 9a5.5 5.5 0 0 0 9.5 3l1.5-1.5 M13.5 13.5v-3h-3",
  },
  shutdown: { d: "M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Z M4 12l8-8" },
  "insert-above": { d: "M3 2.5h10 M8 13.5v-8 M4.5 9 8 5.5 11.5 9" },
  "insert-below": { d: "M3 13.5h10 M8 2.5v8 M4.5 7 8 10.5 11.5 7" },
  "move-up": { d: "M3 10 8 5 13 10Z", filled: true },
  "move-down": { d: "M3 6 8 11 13 6Z", filled: true },
  delete: { d: "M5 4V2.5h6V4 M2.5 4.5h11 M4 4.5l.5 9h7l.5-9 M6.5 7v4 M9.5 7v4" },
  clear: { d: "M4 4l8 8 M12 4l-8 8" },
  "clear-all": { d: "M4.5 4.5h7v7h-7Z", filled: true },
};

module.exports = function notebookIcon(name) {
  const { d, filled } = ICONS[name];
  return (
    <svg
      className="jupyter-action-icon"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
};
