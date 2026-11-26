const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

const HF_TOKEN = process.env.HF_TOKEN || "";
const HF_VIDEO_MODEL =
  process.env.HF_VIDEO_MODEL || "Wan-AI/Wan2.1-I2V-14B-480P";
const HF_VIDEO_SPACE = process.env.HF_VIDEO_SPACE || "";
const FAL_KEY = process.env.FAL_KEY || "";

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    version: "1.3.1",
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

function base64ToBlob(dataUrl, fallbackMime = "image/jpeg") {
  if (!dataUrl || typeof dataUrl !== "string") return null;
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (match) {
    const mimeType = match[1] || fallbackMime;
    const buffer = Buffer.from(match[2], "base64");
    return new Blob([buffer], { type: mimeType });
  }
  const buffer = Buffer.from(dataUrl, "base64");
  return buffer.length > 0 ? new Blob([buffer], { type: fallbackMime }) : null;
}

function extractVideoUrlFromGradioData(data, spaceId) {
  const items = Array.isArray(data) ? data : [data];
  for (const item of items) {
    if (!item) continue;
    if (
      typeof item === "string" &&
      (item.startsWith("http") || item.startsWith("data:video"))
    ) {
      return item;
    }
    if (typeof item === "object") {
      const candidate =
        item.url || item.video?.url || item.path || item.value?.url || null;
      if (candidate && typeof candidate === "string") {
        if (candidate.startsWith("http")) return candidate;
        const cleanPath = candidate.replace(/^\/+/, "");
        return `https://${spaceId.replace("/", "-")}.hf.space/gradio_api/file=${cleanPath}`;
      }
    }
  }
  return null;
}

function mapParameterValue(param, { prompt, imageFileInput, audioFileInput }) {
  const pName = (param.parameter_name || param.label || "").toLowerCase();
  const component = (param.component || "").toLowerCase();

  // Choice / Size (256 or 512)
  if (Array.isArray(param.enum) && param.enum.length > 0) {
    if (param.parameter_has_default && param.parameter_default !== undefined) {
      return param.parameter_default;
    }
    return param.enum.includes(512) ? 512 : param.enum[0];
  }
  if (
    pName.includes("size") ||
    pName.includes("resolution") ||
    pName.includes("preprocess")
  ) {
    return param.parameter_has_default && param.parameter_default !== undefined
      ? param.parameter_default
      : 512;
  }

  // Image input
  if (
    component === "image" ||
    pName.includes("image") ||
    pName.includes("img") ||
    pName.includes("face") ||
    pName.includes("source") ||
    pName.includes("portrait")
  ) {
    return imageFileInput || null;
  }

  // Audio input
  if (
    component === "audio" ||
    pName.includes("audio") ||
    pName.includes("voice") ||
    pName.includes("speech")
  ) {
    return audioFileInput || null;
  }

  // Prompt / Text input
  if (
    component === "textbox" ||
    pName.includes("prompt") ||
    pName.includes("text") ||
    pName.includes("script") ||
    pName.includes("caption")
  ) {
    return prompt;
  }

  // Boolean / Checkbox
  if (component === "checkbox" || param.type === "boolean") {
    return param.parameter_has_default ? Boolean(param.parameter_default) : false;
  }

  // Number / Slider
  if (
    component === "slider" ||
    component === "number" ||
    param.type === "number" ||
    param.type === "integer"
  ) {
    if (param.parameter_has_default && param.parameter_default !== undefined) {
      return param.parameter_default;
    }
    return typeof param.minimum === "number" ? param.minimum : 0;
  }

  if (param.parameter_has_default && param.parameter_default !== undefined) {
    return param.parameter_default;
  }
  return null;
}

async function callGradioSpace({ spaceId, prompt, imageBase64, audioBase64 }) {
  try {
    const { Client, handle_file } = await import("@gradio/client");
    const client = await Client.connect(spaceId, {
      ...(HF_TOKEN ? { hf_token: HF_TOKEN } : {}),
    });

    const apiInfo = await client.view_api();
    const namedEndpoints = apiInfo?.named_endpoints || {};
    const endpointNames = Object.keys(namedEndpoints);

    if (endpointNames.length === 0) {
      return {
        ok: false,
        error: `Space (${spaceId}) တွင် named endpoint မတွေ့ပါ။`,
      };
    }

    const orderedEndpoints = [
      ...endpointNames.filter((ep) => ep.includes("generate") || ep.includes("video")),
      ...endpointNames.filter((ep) => !ep.includes("generate") && !ep.includes("video")),
    ];

    const imgBlob = imageBase64 ? base64ToBlob(imageBase64, "image/jpeg") : null;
    const imageFileInput = imgBlob ? handle_file(imgBlob) : null;

    const audBlob = audioBase64 ? base64ToBlob(audioBase64, "audio/wav") : null;
    const audioFileInput = audBlob ? handle_file(audBlob) : null;

    let lastErr = "";
    for (const ep of orderedEndpoints) {
      const schema = namedEndpoints[ep] || {};
      const params = Array.isArray(schema.parameters) ? schema.parameters : [];

      const mappedEntries = params.map((p, idx) => [
        p.parameter_name || `param_${idx}`,
        mapParameterValue(p, { prompt, imageFileInput, audioFileInput }),
      ]);

      const namedPayload = Object.fromEntries(
        mappedEntries.filter(([, v]) => v !== undefined)
      );
      const arrayPayload = mappedEntries.map(([, v]) =>
        v === undefined ? null : v
      );

      for (const candidateInput of [namedPayload, arrayPayload]) {
        try {
          const result = await client.predict(ep, candidateInput);
          const videoUrl = extractVideoUrlFromGradioData(result?.data, spaceId);

          if (videoUrl) {
            return {
              ok: true,
              videoUrl,
              endpointUsed: ep,
              data: result?.data,
            };
          }

          lastErr = `Endpoint (${ep}) မှ video output ပြန်မလာပါ (output: ${JSON.stringify(result?.data).slice(0, 200)})`;
        } catch (epErr) {
          lastErr = epErr.message || String(epErr);
        }
      }
    }

    return {
      ok: false,
      error: `Gradio Space (${spaceId}) ကို ခေါ်ရာတွင် အဆင်မပြေပါ: ${lastErr} (Available endpoints: ${endpointNames.join(", ")})`,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Gradio Space connection error: ${err.message || String(err)}`,
    };
  }
}

async function callFalFallback({ prompt, imageBase64 }) {
  if (!FAL_KEY) return null;

  const endpoint = imageBase64
    ? "https://fal.run/fal-ai/wan/v2.1/image-to-video"
    : "https://fal.run/fal-ai/wan/v2.1/text-to-video";

  const body = imageBase64
    ? { prompt, image_url: imageBase64, aspect_ratio: "9:16" }
    : { prompt, aspect_ratio: "9:16" };

  const response = await fetch(endpoint, {
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

    if (HF_VIDEO_SPACE) {
      const spaceResult = await callGradioSpace({
        spaceId: HF_VIDEO_SPACE,
        prompt: motionPrompt,
        imageBase64,
        audioBase64,
      });

      if (spaceResult.ok && spaceResult.videoUrl) {
        return res.json({
          success: true,
          provider: `gradio-space (${HF_VIDEO_SPACE})`,
          endpointUsed: spaceResult.endpointUsed,
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

    return res.status(404).json({
      success: false,
      error:
        "Hugging Face Router (router.huggingface.co) တွင် ဤ Video Model endpoint (404 Not Found) မရရှိပါ။ Render Environment Variables ထဲတွင် HF_VIDEO_SPACE သို့မဟုတ် FAL_KEY ထည့်သွင်းပြီး Redeploy လုပ်ပါ။",
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
