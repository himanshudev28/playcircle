// Custom Next.js server with Socket.IO for real-time room sync + chat.
// All the realtime logic lives in server/realtime.js.
const { createServer } = require("http");
const path = require("path");
const next = require("next");
const { Server } = require("socket.io");
const { attachRealtime, SOCKET_OPTIONS } = require("./server/realtime");

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST || "localhost";
const port = parseInt(process.env.PORT || "3000", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => handle(req, res));
  const io = new Server(server, SOCKET_OPTIONS);
  const realtime = attachRealtime(io, {
    // Rooms are saved here so they survive a restart; PERSIST=0 turns it off.
    dataFile:
      process.env.PERSIST === "0"
        ? null
        : path.join(process.env.DATA_DIR || path.join(__dirname, ".data"), "rooms.json"),
  });

  // Save rooms on the way down so a deploy or Ctrl-C doesn't lose them.
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.once(sig, () => {
      realtime.close();
      process.exit(0);
    });
  }

  server.listen(port, () => {
    console.log(`> PlayCircle ready on http://${hostname}:${port}`);
  });
});
