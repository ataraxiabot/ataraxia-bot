// =========================================================
// RENDER (index.js) - COMPLETO / ROBUSTO / IDEMPOTENTE
//
// ✅ ENV esperadas:
//   BOT_API_KEY
//   DISCORD_CLIENT_ID
//   DISCORD_CLIENT_SECRET
//   DISCORD_REDIRECT_URI
//   DISCORD_TOKEN
//   RECRUIT_CHANNEL_ID
//   WIX_RETURN_URL
//
// Opcional:
//   DISCORD_GUILD_ID
//
// ✅ Rutas:
//   POST /oauth/start
//   POST /oauth/exchange         (IDEMPOTENTE)
//   POST /recruitment/submit
//   GET  /oauth/discord/callback
//
// =========================================================

import "dotenv/config";
import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);

// ===== ENV =====
const BOT_API_KEY = String(process.env.BOT_API_KEY || "");
const DISCORD_CLIENT_ID = String(process.env.DISCORD_CLIENT_ID || "");
const DISCORD_CLIENT_SECRET = String(process.env.DISCORD_CLIENT_SECRET || "");
const DISCORD_REDIRECT_URI = String(process.env.DISCORD_REDIRECT_URI || "");
const DISCORD_TOKEN = String(process.env.DISCORD_TOKEN || "");
const RECRUIT_CHANNEL_ID = String(process.env.RECRUIT_CHANNEL_ID || "");
const WIX_RETURN_URL = String(process.env.WIX_RETURN_URL || "");

// Opcional
const DISCORD_GUILD_ID = String(process.env.DISCORD_GUILD_ID || "");
const DEFAULT_SCOPE = "identify";

// ===== Utils =====
function missingEnv() {
  const miss = [];
  if (!BOT_API_KEY) miss.push("BOT_API_KEY");
  if (!DISCORD_CLIENT_ID) miss.push("DISCORD_CLIENT_ID");
  if (!DISCORD_CLIENT_SECRET) miss.push("DISCORD_CLIENT_SECRET");
  if (!DISCORD_REDIRECT_URI) miss.push("DISCORD_REDIRECT_URI");
  if (!DISCORD_TOKEN) miss.push("DISCORD_TOKEN");
  if (!RECRUIT_CHANNEL_ID) miss.push("RECRUIT_CHANNEL_ID");
  if (!WIX_RETURN_URL) miss.push("WIX_RETURN_URL");
  return miss;
}

function requireApiKey(req, res, next) {
  try {
    const got = String(req.headers["x-api-key"] || "");
    if (!BOT_API_KEY) return res.status(500).json({ ok: false, error: "BOT_API_KEY_MISSING" });
    if (got !== BOT_API_KEY) return res.status(401).json({ ok: false, error: "INVALID_API_KEY" });
    return next();
  } catch (_e) {
    return res.status(500).json({ ok: false, error: "AUTH_MIDDLEWARE_FAILED" });
  }
}

function jsonOk(extra = {}) {
  return { ok: true, ...extra };
}
function jsonFail(error, details) {
  const out = { ok: false, error: String(error || "UNKNOWN") };
  if (details !== undefined) out.details = details;
  return out;
}

// ===== Idempotencia exchange (cache TTL) =====
// code -> { ts, payload: { discordId, discordUsername, discordTag } }
const CODE_CACHE = new Map();
const CODE_TTL_MS = 5 * 60 * 1000;

function cacheGet(code) {
  const row = CODE_CACHE.get(code);
  if (!row) return null;
  if (Date.now() - row.ts > CODE_TTL_MS) {
    CODE_CACHE.delete(code);
    return null;
  }
  return row.payload;
}
function cacheSet(code, payload) {
  CODE_CACHE.set(code, { ts: Date.now(), payload });
  // limpieza ligera
  const now = Date.now();
  for (const [k, v] of CODE_CACHE) {
    if (now - v.ts > CODE_TTL_MS) CODE_CACHE.delete(k);
  }
}

// ===== Discord OAuth =====
async function discordTokenExchange(code) {
  const body = new URLSearchParams();
  body.set("client_id", DISCORD_CLIENT_ID);
  body.set("client_secret", DISCORD_CLIENT_SECRET);
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", DISCORD_REDIRECT_URI);

  const resp = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const txt = await resp.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (_) {}

  if (!resp.ok || !data?.access_token) {
    throw new Error(`token_exchange_failed:${resp.status}:${txt}`);
  }
  return data;
}

async function discordGetMe(accessToken) {
  const resp = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const txt = await resp.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (_) {}

  if (!resp.ok || !data?.id) {
    throw new Error(`get_me_failed:${resp.status}:${txt}`);
  }
  return data;
}

async function discordSendChannelMessage(channelId, content) {
  const resp = await fetch(`https://discord.com/api/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${DISCORD_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });

  const txt = await resp.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (_) {}

  if (!resp.ok || !data?.id) {
    throw new Error(`send_message_failed:${resp.status}:${txt}`);
  }
  return data;
}

async function discordAddRole(guildId, userId, roleId) {
  if (!guildId) return false;
  const resp = await fetch(
    `https://discord.com/api/guilds/${guildId}/members/${userId}/roles/${roleId}`,
    {
      method: "PUT",
      headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
    }
  );
  if (resp.status === 204) return true;
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`add_role_failed:${resp.status}:${txt}`);
  }
  return true;
}

// ===== Helpers de mensaje =====
function safeText(v, max = 900) {
  const s = String(v || "").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function buildRecruitmentMessage({ discordId, discordUsername, ownerId, answers }) {
  const a = answers || {};
  const lines = [];

  lines.push("🛡️ **Nueva Solicitud de Reclutamiento: Ataraxia**");
  lines.push("");
  lines.push(`• Discord: **${safeText(discordUsername || "Discord")}** (${safeText(discordId)})`);
  lines.push(`• Wix ownerId: ${safeText(ownerId)}`);
  lines.push("");
  lines.push("📌 **Datos base**");
  lines.push(`• Personaje: **${safeText(a.personaje)}**`);
  lines.push(`• Edad: **${safeText(a.edad)}**`);
  lines.push(`• Clase: **${safeText(a.clase)}**`);
  lines.push(`• Gameplay: **${safeText(a.gameplay)}**`);
  lines.push("");
  lines.push("⚔️ **Compromisos**");
  lines.push(`• ¿Perder loot por la guild?: **${safeText(a.perderLoot)}**`);
  lines.push(`• ¿Ayudar a nuevos?: **${safeText(a.ayudarNuevos)}**`);
  lines.push(`• ¿Guild grande?: **${safeText(a.guildGrande)}**`);
  lines.push(`• ¿Voz Discord?: **${safeText(a.vozDiscord)}**`);
  lines.push(`• ¿Acepta jerarquía?: **${safeText(a.jerarquia)}**`);
  lines.push("");
  lines.push("🧠 **Perfil**");
  lines.push(`• Otras guilds: ${safeText(a.otrasGuilds) || "—"}`);
  lines.push(`• Líder o ejecutor: ${safeText(a.liderOEjecutor) || "—"}`);
  lines.push(`• Seguir calls (PvP): ${safeText(a.seguirCalls) || "—"}`);
  lines.push("");
  lines.push("🗡️ **Criterio**");
  lines.push(`${safeText(a.malaDecision, 1200) || "—"}`);
  lines.push("");
  lines.push("👑 **Por qué Ataraxia debería reclutarte**");
  lines.push(`${safeText(a.porQue, 1200) || "—"}`);

  const content = lines.join("\n");
  return content.length > 1900 ? content.slice(0, 1900) + "\n…" : content;
}

// ===== Health =====
app.get("/", (_req, res) => res.send("OK"));
app.get("/health", (_req, res) =>
  res.json({ ok: missingEnv().length === 0, missing: missingEnv() })
);

// =========================================================
// DISCORD REDIRECT (Render) -> regresa a Wix con ?code&state
// =========================================================
app.get("/oauth/discord/callback", (req, res) => {
  try {
    const q = req.query || {};
    const code = String(q.code || "").trim();
    const state = String(q.state || "").trim();
    const error = String(q.error || "").trim();
    const error_description = String(q.error_description || "").trim();

    const params = [];
    if (code) params.push(`code=${encodeURIComponent(code)}`);
    if (state) params.push(`state=${encodeURIComponent(state)}`);
    if (error) params.push(`error=${encodeURIComponent(error)}`);
    if (error_description) params.push(`error_description=${encodeURIComponent(error_description)}`);

    const target =
      `${WIX_RETURN_URL}` +
      (params.length ? (WIX_RETURN_URL.includes("?") ? "&" : "?") + params.join("&") : "");

    return res.redirect(302, target);
  } catch (_e) {
    return res.status(500).send("callback_failed");
  }
});

// =========================================================
// OAUTH START
// =========================================================
async function handleOauthStart(_req, res) {
  try {
    const miss = missingEnv();
    if (miss.length) return res.status(500).json(jsonFail("MISSING_ENV", miss));

    const state = crypto.randomBytes(16).toString("hex");
    const params = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      redirect_uri: DISCORD_REDIRECT_URI,
      response_type: "code",
      scope: DEFAULT_SCOPE,
      state,
      prompt: "consent",
    });

    const url = `https://discord.com/oauth2/authorize?${params.toString()}`;
    return res.json(jsonOk({ url, state }));
  } catch (e) {
    console.error("OAUTH_START_ERROR:", e);
    return res.status(500).json(jsonFail("OAUTH_START_FAILED"));
  }
}

app.post("/oauth/start", requireApiKey, handleOauthStart);
app.post("/oauth/discord/start", requireApiKey, handleOauthStart);

// =========================================================
// OAUTH EXCHANGE - IDEMPOTENTE (NO 409)
// =========================================================
async function handleOauthExchange(req, res) {
  try {
    const miss = missingEnv();
    if (miss.length) return res.status(500).json(jsonFail("MISSING_ENV", miss));

    const code = String(req.body?.code || "").trim();
    if (!code) return res.status(400).json(jsonFail("MISSING_CODE"));

    // ✅ Si ya se procesó este code recientemente, devolver lo mismo
    const cached = cacheGet(code);
    if (cached) return res.json(jsonOk(cached));

    let token, me;
    try {
      token = await discordTokenExchange(code);
      me = await discordGetMe(token.access_token);
    } catch (e) {
      const msg = String(e?.message || e);

      // ✅ invalid_grant => code inválido/expirado/usado (Discord). No cachear.
      if (msg.includes("invalid_grant")) {
        return res.status(400).json(jsonFail("OAUTH_INVALID_GRANT", msg));
      }

      return res.status(502).json(jsonFail("OAUTH_PROVIDER_ERROR", msg));
    }

    const discordId = me.id;
    const discordUsername = me.global_name || me.username || "Discord";
    const discordTag =
      me.discriminator && me.discriminator !== "0"
        ? `${me.username}#${me.discriminator}`
        : me.username;

    const payload = { discordId, discordUsername, discordTag };

    // ✅ cachea para doble request
    cacheSet(code, payload);

    return res.json(jsonOk(payload));
  } catch (e) {
    console.error("OAUTH_EXCHANGE_ERROR:", e);
    return res.status(500).json(jsonFail("OAUTH_EXCHANGE_FAILED", String(e?.message || e)));
  }
}

app.post("/oauth/exchange", requireApiKey, handleOauthExchange);
app.post("/oauth/discord/exchange", requireApiKey, handleOauthExchange);

// =========================================================
// RECRUITMENT SUBMIT
// =========================================================
async function handleRecruitmentSubmit(req, res) {
  try {
    const miss = missingEnv();
    if (miss.length) return res.status(500).json(jsonFail("MISSING_ENV", miss));

    const discordId = String(req.body?.discordId || "").trim();
    const discordUsername = String(req.body?.discordUsername || "").trim();
    const ownerId = String(req.body?.ownerId || "").trim();
    const answers = req.body?.answers || {};

    const roleId = String(req.body?.roleId || "").trim();
    const channelId = String(req.body?.channelId || "").trim() || RECRUIT_CHANNEL_ID;

    if (!discordId) return res.status(400).json(jsonFail("MISSING_DISCORD_ID"));
    if (!channelId) return res.status(400).json(jsonFail("MISSING_CHANNEL_ID"));
    if (!answers?.personaje || !answers?.clase)
      return res.status(400).json(jsonFail("MISSING_REQUIRED_ANSWERS"));

    const content = buildRecruitmentMessage({ discordId, discordUsername, ownerId, answers });
    await discordSendChannelMessage(channelId, content);

    let roleAssigned = false;
    if (roleId) {
      try {
        await discordAddRole(DISCORD_GUILD_ID, discordId, roleId);
        roleAssigned = true;
      } catch (_e) {
        roleAssigned = false;
      }
    }

    return res.json(jsonOk({ posted: true, roleAssigned }));
  } catch (e) {
    console.error("RECRUITMENT_SUBMIT_ERROR:", e);
    return res.status(500).json(jsonFail("RECRUITMENT_SUBMIT_FAILED", String(e?.message || e)));
  }
}

app.post("/recruitment/submit", requireApiKey, handleRecruitmentSubmit);
app.post("/oauth/discord/submit", requireApiKey, handleRecruitmentSubmit);

// ===== Start =====
app.listen(PORT, () => console.log("Ataraxia Render API on", PORT));

