
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const winston = require("winston");

const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 USE ENV KEYS (DO NOT HARD-CODE)
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Configure Winston logger
const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
  ],
});

// ---------------- HELPERS ----------------
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// Generic API call with retry logic and timeout
async function callApiWithRetry(apiCallFn, message, retries = 3, initialDelay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await apiCallFn(message);
      if (result) {
        return result;
      }
    } catch (error) {
      logger.error(`API call failed (attempt ${i + 1}): ${error.message}`);
      if (error.message.includes("API key not valid") || error.message.includes("Invalid API Key") || error.message.includes("Missing Authentication header")) {
        logger.error("Critical: Invalid API Key detected. Please check your .env file.");
        return null; // Do not retry if API key is invalid
      }
    }
    if (i < retries - 1) {
      await delay(initialDelay * Math.pow(2, i)); // Exponential backoff
    }
  }
  return null;
}

// ---------------- GEMINI (MAIN) ----------------
async function callGemini(message) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set.");
  }
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 seconds timeout

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `You are Terrence AI. Be short, clear, confident.\nUser: ${message}`
                }
              ]
            }
          ]
        }),
        signal: controller.signal,
      }
    );

    clearTimeout(timeoutId);

    if (!res.ok) {
      const errorData = await res.json();
      throw new Error(`Gemini API error: ${res.status} ${res.statusText} - ${JSON.stringify(errorData)}`);
    }

    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (err) {
    logger.error(`Gemini error: ${err.message}`);
    throw err; // Re-throw to be caught by retry mechanism
  }
}

// ---------------- GROQ (FALLBACK 1) ----------------
async function callGroq(message) {
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not set.");
  }
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 seconds timeout

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama3-8b-8192",
        max_tokens: 120,
        messages: [
          {
            role: "system",
            content: "You are Terrence AI. Be short, clear, confident."
          },
          {
            role: "user",
            content: message
          }
        ]
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const errorData = await res.json();
      throw new Error(`Groq API error: ${res.status} ${res.statusText} - ${JSON.stringify(errorData)}`);
    }

    const data = await res.json();
    return data?.choices?.[0]?.message?.content || null;
  } catch (err) {
    logger.error(`Groq error: ${err.message}`);
    throw err; // Re-throw to be caught by retry mechanism
  }
}

// ---------------- OPENROUTER (LAST RESORT) ----------------
const FREE_MODELS = [
  "meta-llama/llama-3.2-3b-instruct:free",
  "google/gemma-3-4b-it:free",
  "nvidia/nemotron-3-super:free",
  "arcee-ai/trinity-large-preview:free",
  "z-ai/glm-4-5-air:free",
  "mistral/devstral-2-2512:free",
  "deepseek/deepseek-chat-v3-0324:free",
  "meta-llama/llama-4-maverick:free",
  "meta-llama/llama-4-scout:free",
  "moonshotai/kimi-vl-a3b-8k:free"
];

async function callOpenRouter(message) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set.");
  }
  for (const model of FREE_MODELS) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 seconds timeout

      const res = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json"
          },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            max_tokens: 120,
            messages: [
              {
                role: "system",
                content: "You are Terrence AI. Be short, clear, confident."
              },
              {
                role: "user",
                content: message
              }
            ]
          })
        }
      );

      clearTimeout(timeoutId);

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(`OpenRouter API error (${model}): ${res.status} ${res.statusText} - ${JSON.stringify(errorData)}`);
      }

      const data = await res.json();

      if (data?.choices?.[0]?.message?.content) {
        return data.choices[0].message.content;
      }

      await delay(500); // Small delay before trying next model
    } catch (err) {
      logger.error(`OpenRouter error (${model}): ${err.message}`);
      if (err.message.includes("API key not valid") || err.message.includes("Invalid API Key") || err.message.includes("Missing Authentication header")) {
        logger.error("Critical: Invalid OpenRouter API Key detected. Please check your .env file.");
        return null; // Do not continue trying other models if API key is invalid
      }
      // Continue to next model if one fails for other reasons
    }
  }

  return null;
}

// ---------------- HEALTH CHECK ROUTE ----------------
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

// ---------------- MAIN ROUTE ----------------
app.post("/chat", async (req, res) => {
  const message = req.body.message;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    logger.warn("Invalid message received: ", message);
    return res.status(400).json({ reply: "Invalid or empty message provided." });
  }

  logger.info(`Received message: "${message}"`);

  // 1. GEMINI (MAIN)
  const gemini = await callApiWithRetry(callGemini, message);
  if (gemini) {
    logger.info("✅ Gemini successful");
    return res.json({ reply: gemini });
  }

  logger.warn("⚠️ Gemini failed after retries. Falling back to Groq.");

  // 2. GROQ (FALLBACK)
  const groq = await callApiWithRetry(callGroq, message);
  if (groq) {
    logger.info("✅ Groq successful");
    return res.json({ reply: groq });
  }

  logger.warn("⚠️ Groq failed after retries. Falling back to OpenRouter.");

  // 3. OPENROUTER (LAST RESORT)
  const openrouter = await callOpenRouter(message); // OpenRouter has its own internal model retry
  if (openrouter) {
    logger.info("✅ OpenRouter successful");
    return res.json({ reply: openrouter });
  }

  // FAILSAFE
  logger.error("❌ All AI providers failed after all attempts.");
  res.status(500).json({
    reply: "All AI providers are currently unavailable. Please try again later."
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.stack}`);
  res.status(500).send('Something broke!');
});

// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  logger.info(`✅ Server running on http://localhost:${PORT}`);
  logger.info(`🚀 Terrence AI online`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT signal received: closing HTTP server');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});
