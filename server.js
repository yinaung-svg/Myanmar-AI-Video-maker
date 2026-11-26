const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

const HF_TOKEN = process.env.HF_TOKEN || "";
const HF_VIDEO_MODEL =
  process.env.HF_VIDEO_MODEL || "Wan-AI/Wan2.1-I2V-14B-480P";
// Gradio Space ဥပမာ: "Wan-AI/Wan2.1" သို့မဟုတ် ကိုယ်သုံးမယ့် Space ID
const HF_VIDEO_SPACE = process.env.HF_VIDEO_SPACE || "";
const FAL_KEY = process.env.FAL_KEY || "";

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Myanmar AI Video Maker backend is running.",
    model: HF_VIDEO_MODEL,
    space: HF_VIDEO_SPACE || "not set",
    hasHfToken: Boolean(HF_TOKEN),
    hasFalKey: Boolean(FAL_KEY),
  });
});

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

async function fetchWithTimeout(url, options = {}, timeoutMs = 90000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Hugging Face Gradio Space ခေါ်ဆိုခြင်း (@gradio/client dynamic import)
async function callGradioSpace({ spaceId, prompt, imageBase64 }) {
  if (!spaceId) {
    return {
      ok: false,
      error:
        "HF_VIDEO_SPACE မသတ်မှတ်ရသေးပါ (Render Env တွင် HF_VIDEO_SPACE ထည့်ပါ သို့မဟုတ် FAL_KEY ထည့်ပါ)။",
    };
  }

  const { Client, handle_file } = await import("@gradio/client");
  const client = await Client.connect(spaceId, {
    ...(HF_TOKEN ? { hf_token: HF_TOKEN } : {}),
  });

  // Base64 ကို Blob/File အဖြစ် ပြောင်းပြီး handle_file ပို့ရန်
  let imageFile = null;
  if (imageBase64) {
    const res = await fetch(imageBase64);
    const blob = await res.blob();
    imageFile = handle_file(blob);
  }

  // Space API endpoint အလိုက် predict/submit စမ်းသပ်ခြင်း
  const inputs = imageFile ? [imageFile, prompt] : [prompt];
  const result = await client.predict(0, inputs).catch(async () => {
    return await client.predict("/generate", {
      ...(imageFile ? { image: imageFile } : {}),
      prompt,
    });
  });

  const dataArr = Array.isArray(result?.data) ? result.data : [result?.data];
  for (const item of dataArr) {
    if (!item) continue;
    if (typeof item === "string" && (item.startsWith("http") || item.startsWith("data:video"))) {
      return { ok: true, videoUrl: item, data: result.data };
    }
    if (typeof item === "object") {
      const url = item.url || item.video?.url || item.path || null;
      if (url) {
        const fullUrl = url.startsWith("http")
          ? url
          : `https://${spaceId.replace("/", "-")}.hf.space/file=${url}`;
        return { ok: true, videoUrl: fullUrl, data: result.data };
      }
    }
  }

  return {
    ok: false,
    error: "Gradio Space မှ video URL ပြန်မလာပါ (Space input/output format မကိုက်ညီဖြစ်နိုင်ပါသည်)။",
    data: result?.data,
  };
}

async function callFalFallback({ prompt, imageBase64 }) {
  if (!FAL_KEY) return null;

  const endpoint = imageBase64
    ? "https://fal.run/fal-ai/wan/v2.1/image-to-video"
    : "https://fal.run/fal-ai/wan/v2.1/text-to-video";

  const body = imageBase64
    ? { prompt, image_url: imageBase64, aspect_ratio: "9:16" }
    : { prompt, aspect_ratio: "9:16" };

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

app.post("/api/generate-video", async (req, res) => {
  try {
    const { imageBase64, script, action, voiceLang, modelId, audioBase64 } = req.body;

    if (!script || !script.trim()) {
      return res.status(400).json({
        success: false,
        error: "Script စာသား ထည့်သွင်းရန် လိုအပ်ပါသည်။",
      });
    }

    const activeModel = (modelId && String(modelId).trim()) || HF_VIDEO_MODEL;
    const motionPrompt = buildMotionPrompt(action, script.trim());

    // 1) FAL_KEY ရှိရင် fal.ai ဖြင့် တိုက်ရိုက်ထုတ်ခြင်း
    if (FAL_KEY) {
      const falResult = await callFalFallback({ prompt: motionPrompt, imageBase64 });
      if (falResult && falResult.ok && falResult.videoUrl) {
        return res.json({
          success: true,
          provider: "fal.ai",
          modelUsed: activeModel,
          videoUrl: falResult.videoUrl,
          data: falResult.data,
          promptUsed: motionPrompt,
          voiceLang: voiceLang || "my-MM",
        });
      }
    }

    // 2) HF_VIDEO_SPACE သတ်မှတ်ထားရင် Gradio Space ဖြင့် ထုတ်ခြင်း
    if (HF_VIDEO_SPACE) {
      const spaceResult = await callGradioSpace({
        spaceId: HF_VIDEO_SPACE,
        prompt: motionPrompt,
        imageBase64,
      });
      if (spaceResult.ok && spaceResult.videoUrl) {
        return res.json({
          success: true,
          provider: `gradio-space (${HF_VIDEO_SPACE})`,
          modelUsed: activeModel,
          videoUrl: spaceResult.videoUrl,
          data: spaceResult.data,
          promptUsed: motionPrompt,
          voiceLang: voiceLang || "my-MM",
          hasAudioInput: Boolean(audioBase64),
        });
      }
      return res.status(502).json({
        success: false,
        error: spaceResult.error,
        promptUsed: motionPrompt,
      });
    }

    // 3) နှစ်ခုလုံး မထည့်ရသေးပါက ရှင်းလင်းသော ညွှန်ကြားချက်ပြန်ပို့ခြင်း
    return res.status(404).json({
      success: false,
      error:
        "Hugging Face Router (router.huggingface.co) တွင် ဤ Video Model endpoint (404 Not Found) မရရှိပါ[span_5](start_span)[span_5](end_span)။ Render Environment Variables ထဲတွင် HF_VIDEO_SPACE (ဥပမာ Gradio Video Space) သို့မဟုတ် FAL_KEY ထည့်သွင်းပြီး Redeploy လုပ်ပါ။",
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
