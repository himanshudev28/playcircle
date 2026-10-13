// Room state survives a server restart: a JSON snapshot on disk, rewritten
// only when it changes. One file is plenty for a single process; with more
// than one instance this is where Redis would go (same serialize/restore).

const fs = require("fs");
const path = require("path");

function createStore(file) {
  let last = "";

  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(data.rooms) ? data.rooms : [];
    } catch {
      return [];
    }
  }

  function save(rooms) {
    const json = JSON.stringify({ savedAt: Date.now(), rooms });
    if (json === last) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, file); // atomic: never a half-written snapshot
      last = json;
    } catch (err) {
      console.error("[persist] could not save rooms:", err.message);
    }
  }

  return { load, save };
}

module.exports = { createStore };
