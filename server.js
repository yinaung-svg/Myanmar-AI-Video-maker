const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Render Environment Variables ထဲမှာ ထည့်ထားမယ့် Token & Model/Endpoint
const HF_TOKEN = process.env.HF_TOKEN;
const HF_VIDEO_MODEL =
  process.env.HF_VIDEO_MODEL || "Wan-AI/Wan2.1-I2V-14B-480P";

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// Health check route (Render alive စစ်ရန်)
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Myanmar AI Video Maker backend is running.",
    model: HF_VIDEO_MODEL,
  });
});

// Action/Emotion ကို ဗီဒီယို prompt အဖြစ် ပြောင်းပေးမယ့် helper
function buildMotionPrompt(action, scriptText) {
  const actionMap = {
    angry_turn_away:
      "Dramatic cinematic shot, character looks angry and frustrated while speaking, then sharply turns head to the side and walks away from the frame.",
    greeting_namaste:
      "Polite warm expression, gentle head nod and respectful greeting gesture while speaking clearly.",
    serious_dialogue:
      "Serious expressive facial movements and natural subtle head motion while delivering lines.",
    happy_energetic:
      "Bright expressive smile and lively head movement while speaking with energy.",
  };

  const baseMotion =
    actionMap[action] ||
    "Expressive acting, natural facial emotion and subtle head turn matching the dialogue.";

  return `${baseMotion} Dialogue context: "${scriptText}". High detail, smooth motion, cinematic lighting.`;
}

// Main video generation endpoint
app.post("/api/generate-video", async (req, res) => {
  try {
    const { imageBase64, script, action, voiceLang, audioBase64 } = req.body;

    if (!script || !script.trim()) {
      return res.status(400).json({
        success: false,
        error: "Script စာသား ထည့်သွင်းရန် လိုအပ်ပါသည်။",
      });
    }

    if (!HF_TOKEN) {
      return res.status(500).json({
        success: false,
        error:
          "Render Environment Variables ထဲတွင် HF_TOKEN မရှိသေးပါ။ ထည့်သွင်းပြီး Redeploy လုပ်ပါ။",
      });
    }

    const motionPrompt = buildMotionPrompt(action, script.trim());

    // Hugging Face Router / Inference API call
    const hfUrl = `https://router.huggingface.co/hf-inference/models/${HF_VIDEO_MODEL}`;

    const payload = {
      inputs: motionPrompt,
      parameters: {
        // Model ပေါ်မူတည်ပြီး လိုအပ်သလို ချိန်ညှိနိုင်သည်
        ...(imageBase64 ? { image: imageBase64 } : {}),
        ...(audioBase64 ? { audio: audioBase64 } : {}),
      },
    };

    const hfResponse = await fetch(hfUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HF_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const contentType = hfResponse.headers.get("content-type") || "";

    // ဗီဒီယို binary (mp4/webm/octet-stream) တိုက်ရိုက် ပြန်လာလျှင် base64 data URL အဖြစ် ပြန်ပို့မည်
    if (
      hfResponse.ok &&
      (contentType.includes("video") ||
        contentType.includes("application/octet-stream"))
    ) {
      const arrayBuffer = await hfResponse.arrayBuffer();
      const base64Video = Buffer.from(arrayBuffer).toString("base64");
      const mimeType = contentType.includes("video")
        ? contentType
        : "video/mp4";

      return res.json({
        success: true,
        videoUrl: `data:${mimeType};base64,${base64Video}`,
        promptUsed: motionPrompt,
        voiceLang: voiceLang || "my-MM",
      });
    }

    // JSON response ပြန်လာလျှင်
    const rawText = await hfResponse.text();
    let parsedJson = null;
    try {
      parsedJson = JSON.parse(rawText);
    } catch (_) {
      parsedJson = null;
    }

    if (!hfResponse.ok) {
      return res.status(hfResponse.status).json({
        success: false,
        error:
          (parsedJson && (parsedJson.error || parsedJson.message)) ||
          `Hugging Face API error (${hfResponse.status}): ${rawText.slice(0, 300)}`,
        promptUsed: motionPrompt,
      });
    }

    return res.json({
      success: true,
      data: parsedJson,
      promptUsed: motionPrompt,
    });
  } catch (err) {
    console.error("Generate video error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Server side error occurred.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
