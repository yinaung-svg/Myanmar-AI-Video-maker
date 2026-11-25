const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Myanmar AI Video Server is running" });
});

function getVoiceFilter(voiceType) {
  switch (voiceType) {
    case "male":
      return "asetrate=24000*0.85,aresample=24000,atempo=1.32";
    case "child":
      return "asetrate=24000*1.18,aresample=24000,atempo=1.22";
    case "female":
    default:
      return "atempo=1.25";
  }
}

async function synthesizeRawBurmeseMp3(text) {
  const cleanText = text.trim();
  const chunks = cleanText.match(/.{1,180}(?:\s|$|။|၊)/g) || [cleanText];
  const buffers = [];

  for (const part of chunks) {
    const q = part.trim();
    if (!q) continue;
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=my&q=${encodeURIComponent(q)}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });
    if (!response.ok) {
      throw new Error("Free Burmese TTS server ကို ချိတ်ဆက်လို့ မရပါ။");
    }
    const arrBuf = await response.arrayBuffer();
    buffers.push(Buffer.from(arrBuf));
  }

  if (buffers.length === 0) {
    throw new Error("အသံထုတ်ရန် စာသား မတွေ့ပါ။");
  }

  return Buffer.concat(buffers);
}

async function synthesizeStyledBurmeseMp3(text, voiceType = "female") {
  const rawBuffer = await synthesizeRawBurmeseMp3(text);
  const filter = getVoiceFilter(voiceType);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-voice-"));
  const inAudio = path.join(tmpDir, "raw.mp3");
  const outAudio = path.join(tmpDir, "styled.mp3");

  try {
    fs.writeFileSync(inAudio, rawBuffer);
    await execFileAsync("ffmpeg", [
      "-y",
      "-threads", "1",
      "-i", inAudio,
      "-af", filter,
      "-c:a", "libmp3lame",
      "-b:a", "96k",
      outAudio
    ]);
    return fs.readFileSync(outAudio);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

app.post("/api/tts", async (req, res) => {
  try {
    const { text, voiceType } = req.body || {};
    if (!text || !text.trim()) {
      return res.status(400).json({ ok: false, error: "မြန်မာစာ text ထည့်ပေးပါ။" });
    }

    const audioBuffer = await synthesizeStyledBurmeseMp3(text, voiceType);
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(audioBuffer);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/merge-video", async (req, res) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-video-"));
  const imagePath = path.join(tmpDir, "character.jpg");
  const audioPath = path.join(tmpDir, "voice.mp3");
  const outputPath = path.join(tmpDir, "output.mp4");

  try {
    let { text, voiceType, imageBase64 } = req.body || {};

    if (!text || !text.trim()) {
      return res.status(400).json({ ok: false, error: "မြန်မာစာ script ထည့်ပေးပါ။" });
    }
    if (!imageBase64) {
      return res.status(400).json({ ok: false, error: "ဇာတ်ကောင်ပုံ တစ်ပုံ ရွေးပေးပါ။" });
    }

    const base64Clean = imageBase64.includes(",")
      ? imageBase64.split(",")[1]
      : imageBase64;
    fs.writeFileSync(imagePath, Buffer.from(base64Clean, "base64"));
    imageBase64 = null;

    const audioBuffer = await synthesizeStyledBurmeseMp3(text, voiceType);
    fs.writeFileSync(audioPath, audioBuffer);

    await execFileAsync("ffmpeg", [
      "-y",
      "-threads", "1",
      "-loop", "1",
      "-framerate", "12",
      "-i", imagePath,
      "-i", audioPath,
      "-vf", "scale='min(480,iw)':-2,format=yuv420p",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "stillimage",
      "-c:a", "aac",
      "-b:a", "96k",
      "-shortest",
      "-movflags", "+faststart",
      outputPath
    ]);

    res.setHeader("Content-Type", "video/mp4");
    const stream = fs.createReadStream(outputPath);
    stream.on("close", () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {}
    });
    stream.pipe(res);
  } catch (err) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
