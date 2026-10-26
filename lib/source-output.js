const fs = require("node:fs").promises;

// UTF-8 encoding must join surrogate pairs even when a piece boundary splits
// them. File writes consume this iterator with backpressure.
async function* utf8Chunks(source) {
  let carry = "";
  for (const chunk of source.chunks()) {
    let text = carry + chunk;
    const last = text.charCodeAt(text.length - 1);
    carry = last >= 0xd800 && last <= 0xdbff ? text.slice(-1) : "";
    if (carry) text = text.slice(0, -1);
    if (text) yield Buffer.from(text, "utf8");
  }
  if (carry) yield Buffer.from(carry, "utf8");
}

async function writeSource(path, source, options) {
  await fs.writeFile(path, utf8Chunks(source), options);
}

module.exports = { utf8Chunks, writeSource };
