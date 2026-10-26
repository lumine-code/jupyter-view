const { StringDecoder } = require("node:string_decoder");
const { createReadStream } = require("node:fs");
const { snapshot } = require("./cell-source");
const TextSnapshot = snapshot().constructor;
const isSnapshot = (value) => value instanceof TextSnapshot;

const SMALL_LIMIT = 1024 * 1024;
const METADATA_LIMIT = 32 * 1024 * 1024;
const NODE_LIMIT = 1000000;
const TOO_LARGE = Symbol("large notebook JSON");
const sourcePath = (path) =>
  path.length === 3 && path[0] === "cells" && typeof path[1] === "number" && path[2] === "source";
const sourceItemPath = (path) =>
  path.length === 4 && sourcePath(path.slice(0, 3)) && typeof path[3] === "number";
const omitted = (value) =>
  value === undefined || typeof value === "function" || typeof value === "symbol";

function metadataError() {
  return Object.assign(
    new RangeError(
      "Notebook metadata or outputs exceed the 32 Mi UTF-16 / one-million-value / 256-level processing budget. Open the file as text to inspect the complete data.",
    ),
    { code: "ERR_NOTEBOOK_METADATA_LIMIT" },
  );
}

// Native SerializeJSONProperty invokes toJSON once, then unboxes the four
// primitive wrappers. Internal-slot brand checks cannot be spoofed by tags.
function jsonValue(value, key) {
  if (isSnapshot(value)) return value;
  if (value !== null && ["object", "function", "bigint"].includes(typeof value)) {
    const toJSON = value.toJSON;
    if (typeof toJSON === "function") value = toJSON.call(value, key);
  }
  return unboxValue(value);
}

function unboxValue(value) {
  if (value && typeof value === "object" && !isSnapshot(value)) {
    let kind;
    try {
      Number.prototype.valueOf.call(value);
      kind = "number";
    } catch {}
    if (kind === "number") return +value;
    try {
      String.prototype.valueOf.call(value);
      kind = "string";
    } catch {}
    if (kind === "string") return String(value);
    try {
      return Boolean.prototype.valueOf.call(value);
    } catch {}
    try {
      return BigInt.prototype.valueOf.call(value);
    } catch {}
  }
  return value;
}

function validateSourceValue(value, path) {
  if (sourcePath(path) && !(isSnapshot(value) || typeof value === "string" || Array.isArray(value)))
    throw new TypeError("Cell source must be a string or an array of strings");
  if (sourceItemPath(path) && !(isSnapshot(value) || typeof value === "string"))
    throw new TypeError("Cell source array must contain strings");
}

function captureValue(value) {
  const ancestors = new Map();
  let nodes = 0,
    units = 0;
  const capture = (input, key, path, depth) => {
    if (depth > 256 || (!sourceItemPath(path) && ++nodes > NODE_LIMIT)) throw metadataError();
    const item = jsonValue(input, key);
    validateSourceValue(item, path);
    if (isSnapshot(item)) return item;
    if (typeof item === "string") {
      if (!sourcePath(path) && !sourceItemPath(path) && (units += item.length) > METADATA_LIMIT)
        throw metadataError();
      return item;
    }
    if (omitted(item)) return undefined;
    if (!item || typeof item !== "object") return item;
    if (ancestors.has(item)) return ancestors.get(item);
    const array = Array.isArray(item),
      result = array ? [] : {};
    ancestors.set(item, result);
    const keys = array ? null : Object.keys(item),
      length = array ? item.length : keys.length;
    if (!sourcePath(path) && length + nodes > NODE_LIMIT) throw metadataError();
    for (let index = 0; index < length; index++) {
      const name = array ? index : keys[index];
      if (!array && (units += name.length) > METADATA_LIMIT) throw metadataError();
      const next = capture(item[name], String(name), [...path, name], depth + 1);
      if (next === undefined && !array) continue;
      Object.defineProperty(result, name, {
        value: next,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    ancestors.delete(item);
    return result;
  };
  return capture(value, "", [], 0);
}

function escapedChunk(text) {
  return JSON.stringify(text)
    .slice(1, -1)
    .replace(
      /[\ud800-\udfff]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
}

function checker({ signal, isCurrent } = {}) {
  let deadline = performance.now() + 4;
  const validate = () => {
    signal?.throwIfAborted();
    if (isCurrent && !isCurrent())
      throw Object.assign(new Error("Notebook source changed"), {
        name: "AbortError",
        code: "ABORT_ERR",
      });
  };
  return (force = false) => {
    validate();
    if (force || performance.now() >= deadline)
      return new Promise((resolve) => setImmediate(resolve)).then(() => {
        validate();
        deadline = performance.now() + 4;
      });
    return null;
  };
}

function stringifySmall(value, indent = 2) {
  let units = 0;
  const ancestors = [];
  try {
    return JSON.stringify(
      value,
      function (key, item) {
        while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
        item = unboxValue(item);
        units +=
          32 +
          key.length * 6 +
          ancestors.length * 10 +
          (isSnapshot(item) || typeof item === "string" ? item.length * 6 : 0);
        if (units > SMALL_LIMIT || ancestors.length > 256) throw TOO_LARGE;
        if (item && typeof item === "object") ancestors.push(item);
        return isSnapshot(item) ? item.toString() : item;
      },
      indent,
    );
  } catch (error) {
    if (error === TOO_LARGE) return null;
    throw error;
  }
}

async function stringifySource(value, options = {}) {
  const indent = options.indent ?? 2,
    lineEnding = options.lineEnding ?? "\n";
  if (!Number.isInteger(indent) || indent < 0 || indent > 10)
    throw new TypeError("Notebook JSON indent must be an integer from 0 to 10");
  if (lineEnding !== "\n" && lineEnding !== "\r\n")
    throw new TypeError("Notebook JSON lineEnding must be LF or CRLF");
  if (options.sortKeys !== undefined && typeof options.sortKeys !== "boolean")
    throw new TypeError("Notebook JSON sortKeys must be boolean");
  if (options.cache !== undefined && !(options.cache instanceof WeakMap))
    throw new TypeError("Notebook JSON cache must be a WeakMap");
  const check = checker(options),
    cache = options.cache ?? new WeakMap(),
    ancestors = new Set();
  let result = snapshot(),
    pending = "",
    metadataUnits = 0,
    nodes = 0;
  const charge = (units) => {
    metadataUnits += units;
    if (metadataUnits > METADATA_LIMIT) throw metadataError();
  };
  const append = (part) => {
    if (typeof part === "string" && pending.length + part.length <= 32768) {
      pending += part;
      return;
    }
    if (pending) {
      result = result.replace(result.length, result.length, pending);
      pending = "";
    }
    if (part.length) result = result.replace(result.length, result.length, part);
  };
  const write = async (item, path, depth) => {
    const pause = check();
    if (pause) await pause;
    if (depth > 256 || (!sourceItemPath(path) && ++nodes > NODE_LIMIT)) throw metadataError();
    validateSourceValue(item, path);
    if (isSnapshot(item) || typeof item === "string") {
      if (!isSnapshot(item) && !sourcePath(path) && !sourceItemPath(path)) charge(item.length);
      const text = isSnapshot(item) ? item : snapshot(item);
      append('"');
      append(
        await text.mapChunks(escapedChunk, {
          cache,
          signal: options.signal,
          isCurrent: options.isCurrent,
        }),
      );
      append('"');
      return;
    }
    if (!item || typeof item !== "object") {
      append(JSON.stringify(item) ?? "null");
      return;
    }
    if (ancestors.has(item)) throw new TypeError("Cyclic notebook JSON");
    ancestors.add(item);
    const array = Array.isArray(item),
      keys = array ? null : Object.keys(item);
    if (keys && options.sortKeys) keys.sort();
    const length = array ? item.length : keys.length;
    if (!sourcePath(path) && length + nodes > NODE_LIMIT) throw metadataError();
    append(array ? "[" : "{");
    let emitted = 0;
    for (let index = 0; index < length; index++) {
      const name = array ? index : keys[index],
        childPath = [...path, name];
      if (!array) charge(name.length);
      const child = jsonValue(item[name], String(name));
      validateSourceValue(child, childPath);
      if (!array && omitted(child)) continue;
      if (emitted++) append(",");
      if (indent) append(lineEnding + " ".repeat((depth + 1) * indent));
      if (!array) {
        append('"');
        append(
          await snapshot(name).mapChunks(escapedChunk, {
            cache,
            signal: options.signal,
            isCurrent: options.isCurrent,
          }),
        );
        append(indent ? '": ' : '":');
      }
      await write(child, childPath, depth + 1);
    }
    if (emitted && indent) append(lineEnding + " ".repeat(depth * indent));
    append(array ? "]" : "}");
    ancestors.delete(item);
  };
  const prepared = jsonValue(value, "");
  if (omitted(prepared)) return undefined;
  await write(prepared, [], 0);
  if (pending) result = result.replace(result.length, result.length, pending);
  return result;
}

async function parseSource(input, options = {}) {
  const source = snapshot(input),
    read = source.reader(32768),
    check = checker(options);
  let offset = 0,
    part = "",
    partStart = 0,
    metadataUnits = 0,
    nodes = 0;
  const charge = (count) => {
    metadataUnits += count;
    if (metadataUnits > METADATA_LIMIT) throw metadataError();
  };
  const peek = () => {
    if (offset < partStart || offset >= partStart + part.length) {
      partStart = offset;
      part = read(offset);
    }
    return part[offset - partStart];
  };
  const skip = async (metadata = true) => {
    while (/[ \t\r\n]/.test(peek() ?? "x")) {
      const match = /^[ \t\r\n]+/.exec(part.slice(offset - partStart));
      offset += match[0].length;
      if (metadata) charge(match[0].length);
      const pause = check();
      if (pause) await pause;
    }
  };
  const fail = (message) => {
    throw new SyntaxError(`${message} at notebook offset ${offset}`);
  };
  const string = async (asSource) => {
    if (peek() !== '"') fail("Expected JSON string");
    offset++;
    let result = snapshot(),
      pending = "",
      rawStart = null,
      rawEnd = 0,
      escapesRead = 0;
    const flushRaw = () => {
      if (rawStart !== null) {
        result = result.replace(result.length, result.length, source.subtext(rawStart, rawEnd));
        rawStart = null;
      }
    };
    const flushText = () => {
      if (pending) {
        result = result.replace(result.length, result.length, pending);
        pending = "";
      }
    };
    const append = (value) => {
      flushRaw();
      if (!asSource) charge(value.length);
      if (pending.length + value.length > 32768) flushText();
      pending += value;
    };
    for (;;) {
      const character = peek();
      if (character === undefined) fail("Unterminated JSON string");
      if (character === '"') {
        offset++;
        break;
      }
      if (character === "\\") {
        offset++;
        const escape = peek();
        offset++;
        if (escape === "u") {
          let hex = "";
          for (let i = 0; i < 4; i++) {
            hex += peek() ?? "";
            offset++;
          }
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("Invalid Unicode escape");
          append(String.fromCharCode(parseInt(hex, 16)));
        } else {
          const escapes = {
            '"': '"',
            "\\": "\\",
            "/": "/",
            b: "\b",
            f: "\f",
            n: "\n",
            r: "\r",
            t: "\t",
          };
          if (!Object.hasOwn(escapes, escape)) fail("Invalid JSON escape");
          append(escapes[escape]);
        }
        if ((++escapesRead & 255) === 0) {
          const pause = check();
          if (pause) await pause;
        }
      } else {
        const remaining = part.slice(offset - partStart),
          // JSON strings reject every unescaped U+0000 through U+001F.
          // eslint-disable-next-line no-control-regex
          special = remaining.search(/["\\\u0000-\u001f]/),
          count = special < 0 ? remaining.length : special;
        if (!count) fail("Unescaped control character");
        if (asSource) {
          flushText();
          if (rawStart === null) rawStart = offset;
          rawEnd = offset + count;
        } else append(remaining.slice(0, count));
        offset += count;
        const pause = check();
        if (pause) await pause;
      }
    }
    flushRaw();
    flushText();
    return asSource ? result : result.toString();
  };
  const sourceArray = async () => {
    offset++;
    await skip(false);
    if (peek() === "]") {
      offset++;
      return [];
    }
    let combined = snapshot(),
      pending = "";
    const flush = () => {
      if (pending) {
        combined = combined.replace(combined.length, combined.length, pending);
        pending = "";
      }
    };
    for (;;) {
      if (peek() !== '"') fail("Cell source array must contain strings");
      const item = await string(true);
      if (item.length > 32768) {
        flush();
        combined = combined.replace(combined.length, combined.length, item);
      } else {
        if (pending.length + item.length > 32768) flush();
        pending += item.toString();
      }
      await skip(false);
      const separator = peek();
      offset++;
      if (separator === "]") break;
      if (separator !== ",") fail("Expected comma in cell source array");
      await skip(false);
      const pause = check();
      if (pause) await pause;
    }
    flush();
    return [combined];
  };
  const value = async (path, depth) => {
    await skip();
    const pause = check();
    if (pause) await pause;
    if (++nodes > NODE_LIMIT || depth > 256) throw metadataError();
    const character = peek(),
      cellText = sourcePath(path);
    if (cellText && character !== '"' && character !== "[")
      fail("Cell source must be a string or an array of strings");
    if (character === '"') return string(cellText);
    if (cellText && character === "[") return sourceArray();
    if (character === "{" || character === "[") {
      const array = character === "[",
        end = array ? "]" : "}";
      offset++;
      charge(1);
      await skip();
      const result = array ? [] : {};
      if (peek() === end) {
        offset++;
        return result;
      }
      let index = 0;
      for (;;) {
        let key = index;
        if (!array) {
          key = await string(false);
          await skip();
          if (peek() !== ":") fail("Expected colon");
          offset++;
        }
        const next = await value([...path, key], depth + 1);
        Object.defineProperty(result, key, {
          value: next,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        index++;
        await skip();
        const separator = peek();
        offset++;
        charge(1);
        if (separator === end) break;
        if (separator !== ",") fail("Expected comma");
        await skip();
      }
      return result;
    }
    const chunks = [];
    let length = 0;
    while (peek() !== undefined && !/[ \t\r\n,}\]]/.test(peek())) {
      const remaining = part.slice(offset - partStart),
        delimiter = remaining.search(/[ \t\r\n,}\]]/),
        count = delimiter < 0 ? remaining.length : delimiter;
      chunks.push(remaining.slice(0, count));
      offset += count;
      length += count;
      charge(count);
      const pause = check();
      if (pause) await pause;
    }
    if (!length) fail("Expected JSON value");
    return JSON.parse(chunks.join(""));
  };
  const result = await value([], 0);
  await skip();
  if (offset !== source.length) fail("Unexpected JSON suffix");
  return result;
}

async function readFileSource(filePath, options = {}) {
  const decoder = new StringDecoder("utf8"),
    check = checker(options);
  let result = snapshot();
  for await (const bytes of createReadStream(filePath, {
    highWaterMark: 65536,
    signal: options.signal,
  })) {
    const text = decoder.write(bytes);
    if (text) result = result.replace(result.length, result.length, text);
    const pause = check();
    if (pause) await pause;
  }
  const tail = decoder.end();
  return tail ? result.replace(result.length, result.length, tail) : result;
}

module.exports = {
  escapedChunk,
  stringifySmall,
  stringifySource,
  parseSource,
  readFileSource,
  captureValue,
};
