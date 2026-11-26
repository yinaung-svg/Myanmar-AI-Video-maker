const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

const HF_TOKEN = process.env.HF_TOKEN;
const HF_VIDEO_MODEL =
  process.env.HF_VIDEO_MODEL || "Wan-AI/Wan2.1-I2V-14B-480P";
const HF_PROVIDER = process.env.HF_PROVIDER || ""; // ဥပမာ fal-ai, replicate, hf-inference (ဗလာထားလျှင် auto)
const FAL_KEY = process.env.FAL_KEY || "";

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// Health check route
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Myanmar AI Video Maker backend is running.",
    model: HF_VIDEO_MODEL,
    hasHfToken: Boolean(HF_TOKEN),
    hasFalKey: Boolean(FAL_KEY),
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

// Fetch helper with timeout
async function fetchWithTimeout(url, options = {}, timeoutMs = 90000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Hugging Face Router API ခေါ်ဆိုခြင်း (provider သတ်မှတ်နိုင်သည်)
async function callHuggingFaceRouter({ model, prompt, imageBase64, provider }) {
  if (!HF_TOKEN) {
    return {
      ok: false,
      status: 500,
      error: "Render Environment Variables ထဲတွင် HF_TOKEN မရှိသေးပါ။",
    };
  }

  const headers = {
    Authorization: `Bearer ${HF_TOKEN}`,
    "Content-Type": "application/json",
  };
  if (provider) {
    headers["X-HF-Provider"] = provider;
  }

  // Provider-specific route သို့မဟုတ် default router route
  const baseRouterUrl = provider
    ? `https://router.huggingface.co/${provider}/models/${model}`
    : `https://router.huggingface.co/models/${model}`;

  const parameters = {};
  if (imageBase64) {
    // data:image/jpeg;base64,... prefix ရှိရင် ခွဲထုတ်နိုင်ရန် ထည့်ပေးသည်
    parameters.image = imageBase64;
  }

  const response = await fetchWithTimeout(baseRouterUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      inputs: prompt,
      ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
    }),
  });

  const contentType = response.headers.get("content-type") || "";

  if (
    response.ok &&
    (contentType.includes("video") ||
      contentType.includes("application/octet-stream"))
  ) {
    const arrayBuffer = await response.arrayBuffer();
    const base64Video = Buffer.from(arrayBuffer).toString("base64");
    const mimeType = contentType.includes("video")
      ? contentType
      : "video/mp4";
    return {
      ok: true,
      videoUrl: `data:${mimeType};base64,${base64Video}`,
    };
  }

  const rawText = await response.text();
  let parsedJson = null;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (_) {
    parsedJson = null;
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error:
        (parsedJson && (parsedJson.error || parsedJson.message)) ||
        `HF Router error (${response.status}): ${rawText.slice(0, 300)}`,
    };
  }

  // JSON ထဲမှာ video url ပြန်လာခဲ့ရင်
  const extractedUrl =
    parsedJson?.videoUrl ||
    parsedJson?.video?.url ||
    parsedJson?.output?.url ||
    (Array.isArray(parsedJson) && parsedJson[0]?.url) ||
    null;

  return {
    ok: true,
    videoUrl: extractedUrl,
    data: parsedJson,
  };
}

// Optional Fallback: FAL_KEY ထည့်ထားလျှင် fal.ai Wan I2V / T2V ကို ခေါ်သုံးခြင်း
async function callFalFallback({ prompt, imageBase64 }) {
  if (!FAL_KEY) return null;

  const endpoint = imageBase64
    ? "https://fal.run/fal-ai/wan/v2.1/image-to-video"
    : "https://fal.run/fal-ai/wan/v2.1/text-to-video";

  const body = imageBase64
    ? {
        prompt,
        image_url: imageBase64,
        aspect_ratio: "9:16",
      }
    : {
        prompt,
        aspect_ratio: "9:16",
      };

  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Key ${FAL_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.detail || data.message || `fal.ai error (${response.status})`);
  }

  const videoUrl = data?.video?.url || data?.output?.video?.url || null;
  return { ok: true, videoUrl, data };
}

// Main video generation endpoint
app.post("/api/generate-video", async (req, res) => {
  try {
    const {
      imageBase64,
      script,
      action,
      voiceLang,
      modelId,
      audioBase64,
    } = req.body;

    if (!script || !script.trim()) {
      return res.status(400).json({
        success: false,
        error: "Script စာသား ထည့်သွင်းရန် လိုအပ်ပါသည်။",
      });
    }

    const activeModel = (modelId && String(modelId).trim()) || HF_VIDEO_MODEL;
    const motionPrompt = buildMotionPrompt(action, script.trim());

    // 1) Hugging Face Router ဖြင့် စမ်းသပ်ခြင်း
    let hfResult = await callHuggingFaceRouter({
      model: activeModel,
      prompt: motionPrompt,
      imageBase64,
      provider: HF_PROVIDER,
    });

    // hf-inference ပံ့ပိုးမပေးတဲ့ error ဖြစ်ပြီး provider မသတ်မှတ်ရသေးရင် fal-ai provider နဲ့ ထပ်စမ်းမည်
    if (
      !hfResult.ok &&
      !HF_PROVIDER &&
      /not supported by provider/i.test(hfResult.error || "")
    ) {
      hfResult = await callHuggingFaceRouter({
        model: activeModel,
        prompt: motionPrompt,
        imageBase64,
        provider: "fal-ai",
      });
    }

    if (hfResult.ok) {
      return res.json({
        success: true,
        provider: HF_PROVIDER || "huggingface-router",
        modelUsed: activeModel,
        videoUrl: hfResult.videoUrl,
        data: hfResult.data,
        promptUsed: motionPrompt,
        voiceLang: voiceLang || "my-MM",
        hasAudioInput: Boolean(audioBase64),
      });
    }

    // 2) FAL_KEY ရှိရင် fal.ai direct fallback ဖြင့် ထပ်စမ်းမည်
    if (FAL_KEY) {
      const falResult = await callFalFallback({
        prompt: motionPrompt,
        imageBase64,
      });
      if (falResult && falResult.ok) {
        return res.json({
          success: true,
          provider: "fal.ai",
          modelUsed: imageBase64
            ? "fal-ai/wan/v2.1/image-to-video"
            : "fal-ai/wan/v2.1/text-to-video",
          videoUrl: falResult.videoUrl,
          data: falResult.data,
          promptUsed: motionPrompt,
          voiceLang: voiceLang || "my-MM",
        });
      }
    }

    return res.status(hfResult.status || 400).json({
      success: false,
      error:
        hfResult.error ||
        "ရွေးချယ်ထားသော Model ကို လက်ရှိ Provider တွင် ပံ့ပိုးမပေးပါ။ Model ပြောင်းကြည့်ပါ သို့မဟုတ် FAL_KEY / HF_PROVIDER ထည့်ပါ။",
      promptUsed: motionPrompt,
    });
  } catch (err) {
    console.error("Generate video error:", err);
    const isTimeout = err.name === "AbortError";
    return res.status(isTimeout ? 504 : 500).json({
      success: false,
      error: isTimeout
        ? "ဗီဒီယို ထုတ်ရာတွင် အချိန်ကြာသွားပါသည် (Timeout)။ ထပ်မံ ကြိုးစားကြည့်ပါ။"
        : err.message || "Server side error occurred.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
