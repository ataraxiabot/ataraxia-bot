// =========================================================
// index.js (Render) - Ataraxia Bot API (FINAL, SOLO PKCE)
// ✅ Render NO hace OAuth. El OAuth PKCE vive en el iFrame (Wix).
// ✅ Render solo recibe solicitudes firmadas desde Wix (x-api-key)
//    y publica en Discord con tu bot.
//
// Endpoints:
//   GET  /               -> healthcheck
//   POST /recruitment    -> (Wix) nueva solicitud de reclutamiento
//   POST /roles/sync     -> (Wix) sync de roles (opcional)
//
// ENV requeridas en Render:
//   DISCORD_TOKEN
//   BOT_API_KEY
//   RECRUIT_CHANNEL_ID
//
// ENV para roles/sync (si lo usas):
//   (ninguna extra; viene guildId en body)
// =========================================================

import "dotenv/config";
import express from "express";
import { Client, GatewayIntentBits } from "discord.js";

const app = express();
app.use(express.json());

// =======================
// HELPERS
// =======================
function safeStr(x) {
  return String(x ?? "").trim();
}

function mustEnv(name) {
  const v = safeStr(process.env[name]);
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

// =======================
// AUTH (Wix -> Render)
// Header esperado: x-api-key: <BOT_API_KEY>
// =======================
function auth(req, res, next) {
  const got = safeStr(req.get("x-api-key") || req.headers["x-api-key"]);
  const key = safeStr(process.env.BOT_API_KEY);

  if (!key) {
    return res.status(500).json({ ok: false, error: "Missing BOT_API_KEY env in Render" });
  }

  if (got !== key) {
    // Debug mínimo (sin filtrar secretos)
    console.log("AUTH FAIL:", { gotPresent: !!got });
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  next();
}

// =======================
// DISCORD CLIENT (BOT)
// =======================
mustEnv("DISCORD_TOKEN");
mustEnv("RECRUIT_CHANNEL_ID");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once("ready", () => {
  console.log(`🤖 Bot conectado como ${client.user.tag}`);
});

await client.login(process.env.DISCORD_TOKEN);

// =======================
// HEALTHCHECK
// =======================
app.get("/", (req, res) => {
  res.json({ ok: true, service: "ataraxia-bot", mode: "pkce-only" });
});

// =========================
// RECLUTAMIENTO (Wix -> Render -> Discord)
// Wix manda:
//  headers: x-api-key
//  body: { type:"RECRUITMENT_NEW", data:{...} }
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
    const comp = (respuestas.compromiso || {});

    if (!title || !personaje || !discordId || !Number.isFinite(edad)) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields (title/personaje/discordId/edad)",
      });
    }

    const channelId = safeStr(process.env.RECRUIT_CHANNEL_ID);
    const channel = await client.channels.fetch(channelId).catch(() => null);

    if (!channel || !channel.isTextBased()) {
      return res.status(404).json({ ok: false, error: "Recruit channel not found or not text-based" });
    }

    const exGremio = safeStr(respuestas.exGremio);

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
      exGremio ? `5️⃣ **Gremio anterior:**\n${exGremio}\n` : null,
      "🧭 **Compromiso y Disciplina**",
      `• Ayudar a nuevos: **${safeStr(comp.ayudarNuevos) || "—"}**`,
      `• Acepta jerarquía: **${safeStr(comp.aceptaJerarquia) || "—"}**`,
      `• Obedecer calls PvP: **${safeStr(comp.obedeceCallsPvP) || "—"}**`,
      `• Perfil: **${safeStr(comp.perfil) || "—"}**`,
      `• Sacrificar loot: **${safeStr(comp.sacrificaLoot) || "—"}**`,
      "",
      `⚙️ Estado asignado: **${safeStr(defaults.rango) || "esperando validación"}**`,
      `📊 Stats iniciales: zenirios ${defaults.zenirios ?? 0} | karma ${defaults.karma ?? 5} | xp ${defaults.xp ?? 0} | nivel ${defaults.nivel ?? 1}`,
    ].filter(Boolean);

    const msg = await channel.send({ content: lines.join("\n") });

    return res.json({ ok: true, messageId: msg.id });
  } catch (err) {
    console.error("❌ /recruitment error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// =========================
// ROLES SYNC (opcional)
// Body esperado:
// { guildId, discordUserId, rolesAdd:[], rolesRemove:[] }
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
    console.error("❌ /roles/sync error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// =======================
// START
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ API escuchando en puerto", PORT));

