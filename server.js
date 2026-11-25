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
app.use(express.json({ limit: "25mb" }));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Myanmar AI Video Server is running" });
});

// Helper: မြန်မာစာ text ကနေ Google Cloud TTS MP3 Buffer ထုတ်ယူခြင်း
async function synthesizeBurmeseMp3(text, voiceName) {
  const apiKey = process.env.GOOGLE_TTS_API_KEY;
  if (!apiKey) {
    throw new Error("Render Environment Variables မှာ GOOGLE_TTS_API_KEY ထည့်ပေးပါ။");
  }

  const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(apiKey)}`;
  const payload = {
    input: { text: text.trim() },
    voice: {
      languageCode: "my-MM",
      ...(voiceName ? { name: voiceName } : {})
    },
    audioConfig: {
      audioEncoding: "MP3"
    }
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok || !data.audioContent) {
    throw new Error(data.error?.message || "Google Cloud TTS error");
  }

  return Buffer.from(data.audioContent, "base64");
}

// 1) မြန်မာစာ script ကနေ အသံ (.mp3) သက်သက် ထုတ်ပေးမယ့် endpoint
app.post("/api/tts", async (req, res) => {
  try {
    const { text, voiceName } = req.body || {};
    if (!text || !text.trim()) {
      return res.status(400).json({ ok: false, error: "မြန်မာစာ text ထည့်ပေးပါ။" });
    }

    const audioBuffer = await synthesizeBurmeseMp3(text, voiceName);
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(audioBuffer);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 2) ဇာတ်ကောင်ပုံ + မြန်မာစာ script ကို ffmpeg နဲ့ ပေါင်းပြီး Final Video (.mp4) ထုတ်ပေးမယ့် endpoint
app.post("/api/merge-video", async (req, res) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-video-"));
  const imagePath = path.join(tmpDir, "character.png");
  const audioPath = path.join(tmpDir, "voice.mp3");
  const outputPath = path.join(tmpDir, "output.mp4");

  try {
    const { text, voiceName, imageBase64 } = req.body || {};

    if (!text || !text.trim()) {
      return res.status(400).json({ ok: false, error: "မြန်မာစာ script ထည့်ပေးပါ။" });
    }
    if (!imageBase64) {
      return res.status(400).json({ ok: false, error: "ဇာတ်ကောင်ပုံ တစ်ပုံ ရွေးပေးပါ။" });
    }

    // Data URL (data:image/png;base64,...) ဖြစ်နေရင် prefix ဖြတ်ပြီး buffer ပြောင်းမယ်
    const base64Clean = imageBase64.includes(",")
      ? imageBase64.split(",")[1]
      : imageBase64;
    const imgBuffer = Buffer.from(base64Clean, "base64");
    fs.writeFileSync(imagePath, imgBuffer);

    // မြန်မာအသံ MP3 ထုတ်ပြီး သိမ်းမယ်
    const audioBuffer = await synthesizeBurmeseMp3(text, voiceName);
    fs.writeFileSync(audioPath, audioBuffer);

    // FFmpeg နဲ့ ဇာတ်ကောင်ပုံ + မြန်မာအသံ ပေါင်းပြီး .mp4 ထုတ်မယ်
    await execFileAsync("ffmpeg", [
      "-y",
      "-loop", "1",
      "-i", imagePath,
      "-i", audioPath,
      "-c:v", "libx264",
      "-tune", "stillimage",
      "-c:a", "aac",
      "-b:a", "192k",
      "-pix_fmt", "yuv420p",
      "-shortest",
      outputPath
    ]);

    const videoBuffer = fs.readFileSync(outputPath);
    res.setHeader("Content-Type", "video/mp4");
    res.send(videoBuffer);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    // Temp ဖိုင်များ ရှင်းလင်းခြင်း
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
