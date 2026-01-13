// ================================
// Render index.js (COMPLETO) - Ataraxia OAuth + Recruitment
// - /oauth/start
// - /oauth/exchange
// - /recruitment/submit
// Requisitos ENV en Render:
//   PORT
//   API_KEY
//   DISCORD_CLIENT_ID
//   DISCORD_CLIENT_SECRET
//   DISCORD_REDIRECT_URI  (https://www.comunidad-ataraxia.com/discord-callback)
//   DISCORD_BOT_TOKEN
//   DISCORD_GUILD_ID
// ================================

import "dotenv/config";
import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 3000);
const API_KEY = String(process.env.API_KEY || "");

const DISCORD_CLIENT_ID = String(process.env.DISCORD_CLIENT_ID || "");
const DISCORD_CLIENT_SECRET = String(process.env.DISCORD_CLIENT_SECRET || "");
const DISCORD_REDIRECT_URI = String(process.env.DISCORD_REDIRECT_URI || "");

const DISCORD_BOT_TOKEN = String(process.env.DISCORD_BOT_TOKEN || "");
const DISCORD_GUILD_ID = String(process.env.DISCORD_GUILD_ID || "");

// ---------- CONSTS ----------
const OAUTH_SCOPE = "identify";
const STATE_TTL_MS = 10 * 60 * 1000; // 10 min

// In-memory store de state (suficiente para este caso; si reinicia Render, solo reintenta)
const STATE_STORE = new Map(); // state -> { createdAt }

// ---------- AUTH MIDDLEWARE ----------
function requireApiKey(req, res, next) {
  if (!API_KEY) return res.status(500).json({ ok: false, error: "missing_api_key_env" });
  const got = String(req.headers["x-api-key"] || "");
  if (got !== API_KEY) return res.status(401).json({ ok: false, error: "invalid_api_key" });
  next();
}

// ---------- HELPERS ----------
function assertEnv() {
  const missing = [];
  if (!DISCORD_CLIENT_ID) missing.push("DISCORD_CLIENT_ID");
  if (!DISCORD_CLIENT_SECRET) missing.push("DISCORD_CLIENT_SECRET");
  if (!DISCORD_REDIRECT_URI) missing.push("DISCORD_REDIRECT_URI");
  if (!DISCORD_BOT_TOKEN) missing.push("DISCORD_BOT_TOKEN");
  if (!DISCORD_GUILD_ID) missing.push("DISCORD_GUILD_ID");
  if (!API_KEY) missing.push("API_KEY");
  return missing;
}

function cleanStates() {
  const now = Date.now();
  for (const [state, meta] of STATE_STORE.entries()) {
    if (!meta?.createdAt || now - meta.createdAt > STATE_TTL_MS) STATE_STORE.delete(state);
  }
}

async function discordTokenExchange(code, redirectUri) {
  const body = new URLSearchParams();
  body.set("client_id", DISCORD_CLIENT_ID);
  body.set("client_secret", DISCORD_CLIENT_SECRET);
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", redirectUri);

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
  return data; // { access_token, token_type, ... }
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
  return data; // { id, username, global_name, discriminator, ... }
}

async function discordSendChannelMessage(channelId, content) {
  const resp = await fetch(`https://discord.com/api/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
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
  const resp = await fetch(`https://discord.com/api/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
    method: "PUT",
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
  });

  // Discord role add suele regresar 204 No Content
  if (!(resp.status === 204 || resp.ok)) {
    const txt = await resp.text();
    throw new Error(`add_role_failed:${resp.status}:${txt}`);
  }
  return true;
}

function safeText(v, max = 900) {
  const s = String(v || "").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function fmtYesNo(v) {
  const s = String(v || "").trim();
  if (!s) return "—";
  return s;
}

function buildRecruitmentMessage(payload) {
  const discordUsername = safeText(payload.discordUsername || "Discord");
  const discordId = safeText(payload.discordId || "");
  const ownerId = safeText(payload.ownerId || "");
  const a = payload.answers || {};

  const lines = [];
  lines.push("🛡️ **Nueva Solicitud de Reclutamiento: Ataraxia**");
  lines.push("");
  lines.push(`• Discord: **${safeText(discordUsername)}** (${discordId})`);
  lines.push(`• Wix ownerId: ${ownerId}`);
  lines.push("");
  lines.push("📌 **Datos base**");
  lines.push(`• Personaje: **${safeText(a.personaje)}**`);
  lines.push(`• Edad: **${safeText(a.edad)}**`);
  lines.push(`• Clase: **${safeText(a.clase)}**`);
  lines.push(`• Gameplay: **${safeText(a.gameplay)}**`);
  lines.push("");
  lines.push("⚔️ **Compromisos**");
  lines.push(`• ¿Perder loot por la guild?: **${fmtYesNo(a.perderLoot)}**`);
  lines.push(`• ¿Ayudar a nuevos?: **${fmtYesNo(a.ayudarNuevos)}**`);
  lines.push(`• ¿Guild grande?: **${fmtYesNo(a.guildGrande)}**`);
  lines.push(`• ¿Voz en Discord?: **${fmtYesNo(a.vozDiscord)}**`);
  lines.push(`• ¿Acepta jerarquía?: **${fmtYesNo(a.jerarquia)}**`);
  lines.push("");
  lines.push("🧠 **Perfil**");
  lines.push(`• Otras guilds: ${safeText(a.otrasGuilds) || "—"}`);
  lines.push(`• Líder o ejecutor: ${safeText(a.liderOEjecutor) || "—"}`);
  lines.push(`• Seguir calls (PvP): ${safeText(a.seguirCalls) || "—"}`);
  lines.push("");
  lines.push("🗡️ **Criterio**");
  lines.push(`• Si un líder toma mala decisión: ${safeText(a.malaDecision, 1200)}`);
  lines.push("");
  lines.push("👑 **Motivo**");
  lines.push(`${safeText(a.porQue, 1200)}`);

  // Discord limita a 2000 chars por mensaje
  const content = lines.join("\n");
  return content.length > 1900 ? content.slice(0, 1900) + "\n…" : content;
}

// ---------- HEALTH ----------
app.get("/", (_req, res) => res.send("OK"));
app.get("/health", (_req, res) => {
  const missing = assertEnv();
  res.json({ ok: missing.length === 0, missing });
});

// ================================
// 1) /oauth/start
// ================================
app.post("/oauth/start", requireApiKey, async (_req, res) => {
  try {
    cleanStates();

    const missing = assertEnv();
    if (missing.length) return res.status(500).json({ ok: false, error: "missing_env", missing });

    const state = crypto.randomBytes(16).toString("hex");
    STATE_STORE.set(state, { createdAt: Date.now() });

    const params = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      redirect_uri: DISCORD_REDIRECT_URI,
      response_type: "code",
      scope: OAUTH_SCOPE,
      state,
      prompt: "consent",
    });

    const url = `https://discord.com/oauth2/authorize?${params.toString()}`;

    return res.json({ ok: true, url, state });
  } catch (e) {
    console.error("OAUTH_START_ERROR:", e);
    return res.status(500).json({ ok: false, error: "oauth_start_failed" });
  }
});

// ================================
// 2) /oauth/exchange
// body: { code, redirect_uri }
// ================================
app.post("/oauth/exchange", requireApiKey, async (req, res) => {
  try {
    const missing = assertEnv();
    if (missing.length) return res.status(500).json({ ok: false, error: "missing_env", missing });

    const code = String(req.body?.code || "").trim();
    const redirectUri = String(req.body?.redirect_uri || DISCORD_REDIRECT_URI).trim();
    if (!code) return res.status(400).json({ ok: false, error: "missing_code" });
    if (!redirectUri) return res.status(400).json({ ok: false, error: "missing_redirect_uri" });

    const token = await discordTokenExchange(code, redirectUri);
    const me = await discordGetMe(token.access_token);

    const discordId = me.id;
    const discordUsername = me.global_name || me.username || "Discord";
    const discordTag = me.discriminator && me.discriminator !== "0"
      ? `${me.username}#${me.discriminator}`
      : me.username;

    return res.json({
      ok: true,
      discordId,
      discordUsername,
      discordTag,
    });
  } catch (e) {
    console.error("OAUTH_EXCHANGE_ERROR:", e);
    return res.status(500).json({ ok: false, error: "oauth_exchange_failed" });
  }
});

// ================================
// 3) /recruitment/submit
// body: { discordId, discordUsername, ownerId, answers, channelId, roleId }
// ================================
app.post("/recruitment/submit", requireApiKey, async (req, res) => {
  try {
    const missing = assertEnv();
    if (missing.length) return res.status(500).json({ ok: false, error: "missing_env", missing });

    const discordId = String(req.body?.discordId || "").trim();
    const discordUsername = String(req.body?.discordUsername || "").trim();
    const ownerId = String(req.body?.ownerId || "").trim();
    const answers = req.body?.answers || {};

    const channelId = String(req.body?.channelId || "").trim();
    const roleId = String(req.body?.roleId || "").trim();

    if (!discordId) return res.status(400).json({ ok: false, error: "missing_discordId" });
    if (!channelId) return res.status(400).json({ ok: false, error: "missing_channelId" });
    if (!roleId) return res.status(400).json({ ok: false, error: "missing_roleId" });
    if (!answers?.personaje || !answers?.clase) return res.status(400).json({ ok: false, error: "missing_required_answers" });

    // 1) Post al canal
    const content = buildRecruitmentMessage({ discordId, discordUsername, ownerId, answers });
    await discordSendChannelMessage(channelId, content);

    // 2) Asignar rol (si el usuario ya está en el server)
    // Si no está en el server, Discord devuelve 404. Lo reportamos como roleAssigned:false sin tirar todo.
    let roleAssigned = false;
    try {
      await discordAddRole(DISCORD_GUILD_ID, discordId, roleId);
      roleAssigned = true;
    } catch (e) {
      console.warn("ROLE_ASSIGN_WARN:", String(e?.message || e));
      roleAssigned = false;
    }

    return res.json({
      ok: true,
      posted: true,
      roleAssigned,
    });
  } catch (e) {
    console.error("RECRUITMENT_SUBMIT_ERROR:", e);
    return res.status(500).json({ ok: false, error: "recruitment_submit_failed" });
  }
});

app.listen(PORT, () => {
  console.log("Ataraxia Render API listening on", PORT);
});
