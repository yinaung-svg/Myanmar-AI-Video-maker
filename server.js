const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "25mb" }));

// Browser က main URL ဖွင့်ရင် index.html ကို ပြပေးမည်
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Server ကျန်းမာရေး စစ်ဆေးရန်
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Myanmar AI Video Server is running" });
});

// Frontend ကနေ ပို့လာတဲ့ script နဲ့ motionPrompt ကို လက်ခံစမ်းသပ်ရန်
app.post("/api/render-plan", (req, res) => {
  const { script, motionPrompt, hasCharacterImage } = req.body || {};
  res.json({
    ok: true,
    receivedScript: script || "",
    motionPrompt: motionPrompt || "",
    hasCharacterImage: Boolean(hasCharacterImage),
    nextStep: "Connect Burmese TTS API + Image-to-Video API + ffmpeg here"
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
