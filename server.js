const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "25mb" }));

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Myanmar AI Video Server is running" });
});

app.post("/api/render-plan", (req, res) => {
  const { script, motionPrompt } = req.body || {};
  res.json({
    ok: true,
    receivedScript: script || "",
    motionPrompt: motionPrompt || "",
    nextStep: "Connect Burmese TTS API + Image-to-Video API + ffmpeg here"
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
