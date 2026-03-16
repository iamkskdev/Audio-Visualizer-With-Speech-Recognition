const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Views + static files
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use("/public", express.static(path.join(__dirname, "views", "public")));

app.get("/", (req, res) => {
  res.render("index");
});

io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on("voiceCommand", (text) => {
    const cleaned = String(text || "").trim();
    console.log("Voice command:", cleaned);

    if (!cleaned) {
      socket.emit("response", "I didn't catch that. Please try again.");
      return;
    }

    // Replace with your bot logic
    socket.emit("response", `Received: "${cleaned}"`);
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});