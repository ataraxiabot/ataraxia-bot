// =========================================================
// index.js (Render) - Ataraxia Bot API
// ✅ Compatible con Wix backend/recruitment.web.js (nuevo)
//   - Auth por header: x-api-key  (no Bearer)
//   - Endpoint: POST /recruitment  (payload type RECRUITMENT_NEW)
// ✅ Mantiene:
//   - Discord client (discord.js)
//   - /roles/sync (Wix -> Render)
//   - /oauth/discord/* (lo dejo intacto por si aún lo usas; puedes borrarlo luego)
//   - /forms/recruitment (tu endpoint viejo, intacto)
//
// ENV requeridas:
//   DISCORD_TOKEN
//   BOT_API_KEY
//   RECRUIT_CHANNEL_ID
// (Opcional si usas OAuth viejo en Render: DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI)
// =========================================================

import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import { Client, GatewayIntentBits } from "discord.js";

const app = express();
app.use(express.json());

// =======================
// DISCORD CLIENT (BOT)
// =======================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once("ready", () => {
  console.log(`🤖 Bot conectado como ${client.user.tag}`);
});

await client.login(process.env.DISCORD_TOKEN);

// =======================
// HELPERS
// =======================
function mustEnv(name, value) {
  if (!String(value || "").trim()) throw new Error(`Missing env: ${name}`);
}

function safeStr(x) {
  return String(x ?? "").trim();
}

// =======================
// SEGURIDAD (Wix -> Render)
// ✅ Nuevo esquema: header x-api-key
// =======================
function auth(req, res, next) {
  const got = safeStr(req.get("x-api-key") || req.headers["x-api-key"]);
  const key = safeStr(process.env.BOT_API_KEY);

  if (!key) {
    return res.status(500).json({ ok: false, error: "Missing BOT_API_KEY env in Render" });
  }

  if (got !== key) {
    console.log("AUTH FAIL:", { got, expected: key ? "[set]" : "[missing]" });
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  next();
}

// =========================
// DISCORD OAUTH (LEGACY)
// - Lo dejo intacto por si aún lo usas en otras páginas
// - Si ya migraste a PKCE en iFrame, puedes borrarlo completo
// =========================
const STATE_TTL_MS = 10 * 60 * 1000;
const stateStore = new Map();       // state -> createdAt
const returnUrlStore = new Map();   // state -> returnUrl

function newState() {
  const s = crypto.randomBytes(18).toString("hex");
  stateStore.set(s, Date.now());
  return s;
}

function consumeState(state) {
  const t = stateStore.get(state);
  stateStore.delete(state);
  if (!t) return false;
  return (Date.now() - t) <= STATE_TTL_MS;
}

// Cleanup
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of stateStore.entries()) {
    if (now - t > STATE_TTL_MS) stateStore.delete(k);
  }
  for (const [k] of returnUrlStore.entries()) {
    if (!stateStore.has(k)) returnUrlStore.delete(k);
  }
}, 60_000).unref?.();

app.get("/oauth/discord/start", (req, res) => {
  try {
    mustEnv("DISCORD_CLIENT_ID", process.env.DISCORD_CLIENT_ID);
    mustEnv("DISCORD_REDIRECT_URI", process.env.DISCORD_REDIRECT_URI);

    const state = newState();

    const returnUrl = safeStr(req.query.returnUrl);
    if (returnUrl) returnUrlStore.set(state, returnUrl);

    const params = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      redirect_uri: process.env.DISCORD_REDIRECT_URI,
      response_type: "code",
      scope: "identify",
      state,
      prompt: "consent",
    });

    return res.redirect("https://discord.com/oauth2/authorize?" + params.toString());
  } catch (e) {
    console.error("OAuth start error:", e);
    return res.status(500).send("OAuth start misconfigured");
  }
});

app.get("/oauth/discord/callback", async (req, res) => {
  const code = safeStr(req.query.code);
  const state = safeStr(req.query.state);

  if (!code) return res.status(400).send("No code");
  if (!state) return res.status(400).send("No state");
  if (!consumeState(state)) return res.status(401).send("Invalid/expired state");

  try {
    mustEnv("DISCORD_CLIENT_ID", process.env.DISCORD_CLIENT_ID);
    mustEnv("DISCORD_CLIENT_SECRET", process.env.DISCORD_CLIENT_SECRET);
    mustEnv("DISCORD_REDIRECT_URI", process.env.DISCORD_REDIRECT_URI);

    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI,
      }),
    });

    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenData?.access_token) {
      console.error("OAuth token error:", tokenData);
      return res.status(401).send("OAuth token error");
    }

    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    const user = await userRes.json().catch(() => ({}));
    if (!user?.id) {
      console.error("Could not fetch Discord user:", user);
      return res.status(500).send("Could not fetch Discord user");
    }

    const safe = {
      discordId: String(user.id),
      username: String(user.username || ""),
      global_name: String(user.global_name || ""),
      avatar: String(user.avatar || ""),
    };

    const returnUrl =
      safeStr(returnUrlStore.get(state)) ||
      "https://www.comunidad-ataraxia.com/registro-nuevos-miembros";

    returnUrlStore.delete(state);

    const p = new URLSearchParams({
      oauth: "ok",
      discordId: safe.discordId,
      username: safe.username,
      global_name: safe.global_name,
      avatar: safe.avatar,
    });

    return res.redirect(`${returnUrl}${returnUrl.includes("?") ? "&" : "?"}${p.toString()}`);
  } catch (err) {
    console.error("OAuth callback error:", err);
    return res.status(500).send("OAuth error");
  }
});

// =========================
// ROLES SYNC (Wix -> Render)
// =========================
app.post("/roles/sync", auth, async (req, res) => {
  try {
    const { guildId, discordUserId, rolesAdd = [], rolesRemove = [] } = req.body || {};

    if (!guildId || !discordUserId) {
      return res.status(400).json({ ok: false, error: "Missing guildId/discordUserId" });
    }

    const guild = await client.guilds.fetch(String(guildId));
    if (!guild) return res.status(404).json({ ok: false, error: "Guild not found" });

    const member = await guild.members.fetch(String(discordUserId)).catch(() => null);
    if (!member) return res.status(404).json({ ok: false, error: "Member not found in guild" });

    const add = Array.isArray(rolesAdd) ? rolesAdd.map(String).filter(Boolean) : [];
    const rem = Array.isArray(rolesRemove) ? rolesRemove.map(String).filter(Boolean) : [];

    if (rem.length) await member.roles.remove(rem);
    if (add.length) await member.roles.add(add);

    return res.json({ ok: true, guildId, discordUserId, rolesAdd: add, rolesRemove: rem });
  } catch (err) {
    console.error("❌ roles/sync error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// =========================
// ✅ NUEVO: RECLUTAMIENTO (Wix -> Render -> Discord)
// Endpoint esperado por Wix backend:
//   POST https://<render>/recruitment
// Headers:
//   x-api-key: <BOT_API_KEY>
// Body:
//   { type:"RECRUITMENT_NEW", data:{...} }
// =========================
app.post("/recruitment", auth, async (req, res) => {
  try {
    const payload = req.body || {};
    if (payload.type !== "RECRUITMENT_NEW") {
      return res.status(400).json({ ok: false, error: "Invalid type" });
    }

    const d = payload.data || {};
    const title = safeStr(d.title);
    const personaje = safeStr(d.personaje);
    const discordId = safeStr(d.discordId);
    const edad = Number(d.edad);
    const ownerId = safeStr(d.ownerId);
    const respuestas = d.respuestas || {};
    const defaults = d.defaults || {};

    if (!title || !personaje || !discordId || !Number.isFinite(edad)) {
      return res.status(400).json({ ok: false, error: "Missing required fields (title/personaje/discordId/edad)" });
    }

    const channelId = safeStr(process.env.RECRUIT_CHANNEL_ID);
    if (!channelId) {
      return res.status(500).json({ ok: false, error: "Missing RECRUIT_CHANNEL_ID env in Render" });
    }

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return res.status(404).json({ ok: false, error: "Recruit channel not found or not text-based" });
    }

    const c = (respuestas.compromiso || {});
    const lines = [
      "🛡️ **Nueva Solicitud de Reclutamiento – Ataraxia**",
      "━━━━━━━━━━━━━━━━━━━━",
      `👤 **Discord:** **${title}** (<@${discordId}>)`,
      `🆔 **Discord ID:** ${discordId}`,
      `🎭 **Personaje:** **${personaje}**`,
      `🔞 **Edad:** **${edad}**`,
      ownerId ? `🧾 **Wix ownerId:** ${ownerId}` : null,
      "",
      "📜 **Respuestas**",
      `1️⃣ **Motivo:**\n${safeStr(respuestas.motivo) || "—"}`,
      "",
      `2️⃣ **Experiencia:**\n${safeStr(respuestas.experiencia) || "—"}`,
      "",
      `3️⃣ **Rol deseado:**\n${safeStr(respuestas.rol) || "—"}`,
      "",
      `4️⃣ **Disponibilidad:**\n${safeStr(respuestas.disponibilidad) || "—"}`,
      "",
      (safeStr(respuestas.exGremio)
        ? `5️⃣ **Gremio anterior:**\n${safeStr(respuestas.exGremio)}\n`
        : null),
      "🧭 **Compromiso y Disciplina**",
      `• Ayudar a nuevos: **${safeStr(c.ayudarNuevos) || "—"}**`,
      `• Acepta jerarquía: **${safeStr(c.aceptaJerarquia) || "—"}**`,
      `• Obedecer calls PvP: **${safeStr(c.obedeceCallsPvP) || "—"}**`,
      `• Perfil: **${safeStr(c.perfil) || "—"}**`,
      `• Sacrificar loot: **${safeStr(c.sacrificaLoot) || "—"}**`,
      "",
      `⚙️ Estado asignado: **${safeStr(defaults.rango) || "esperando validación"}**`,
    ].filter(Boolean);

    const msg = await channel.send({ content: lines.join("\n") });
    return res.json({ ok: true, messageId: msg.id });
  } catch (err) {
    console.error("❌ /recruitment error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// =========================
// LEGACY: tu endpoint viejo (lo dejo intacto)
// =========================
app.post("/forms/recruitment", auth, async (req, res) => {
  try {
    const { guildId, channelId, discordUserId, discordTag, answers, memberId } = req.body || {};

    if (!guildId || !channelId || !discordUserId || !answers) {
      return res.status(400).json({ ok: false, error: "Missing fields" });
    }

    const channel = await client.channels.fetch(String(channelId));
    if (!channel || !channel.isTextBased()) {
      return res.status(404).json({ ok: false, error: "Channel not found or not text" });
    }

    if (!answers?.oathAccepted) {
      return res.status(400).json({ ok: false, error: "Oath not accepted" });
    }

    const lines = [
      "🛡️ **Nueva Solicitud de Reclutamiento – Ataraxia (LEGACY)**",
      "",
      `👤 **Discord:** ${discordTag || "Usuario"} (<@${discordUserId}>)`,
      `🆔 **ID:** ${discordUserId}`,
      memberId ? `🧾 **Wix memberId:** ${memberId}` : null,
      "",
      "**Respuestas:**",
      `1️⃣ Tipo de gameplay: **${answers.gameplayType || "—"}**`,
      `2️⃣ Días por semana en eventos: **${answers.daysPerWeek || "—"}**`,
      `3️⃣ ¿Perder loot por el bien de la guild?: **${answers.loseLoot || "—"}**`,
      `4️⃣ ¿Ayudar a miembros más nuevos?: **${answers.helpNewbies || "—"}**`,
      `5️⃣ ¿Acepta jerarquía?: **${answers.acceptHierarchy || "—"}**`,
      `6️⃣ ¿Guilds grandes antes?: **${answers.bigGuilds || "—"}**`,
      `7️⃣ ¿Líder o ejecutor?: **${answers.leaderOrExecutor || "—"}**`,
      `8️⃣ ¿Seguir órdenes en PvP masivo?: **${answers.followOrdersMassPvp || "—"}**`,
      "",
      "🧠 **9) Si un líder toma una mala decisión:**",
      String(answers.badLeaderDecision || "—"),
      "",
      "🔥 **10) ¿Por qué deberíamos aceptarte?:**",
      String(answers.whyAccept || "—"),
      "",
      "📜 **Juramento:**",
      `✅ ${String(answers.oathText || "Juramento aceptado").trim()}`,
    ].filter(Boolean);

    const msg = await channel.send({ content: lines.join("\n") });
    return res.json({ ok: true, messageId: msg.id });
  } catch (err) {
    console.error("❌ /forms/recruitment error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// =======================
// HEALTHCHECK
// =======================
app.get("/", (req, res) => {
  res.json({ ok: true, service: "ataraxia-bot" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ API escuchando en puerto", PORT));
