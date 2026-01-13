import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import { Client, GatewayIntentBits, Partials } from "discord.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

// =======================
// HELPERS
// =======================
function mustEnv(name, v) {
  if (!String(v || "").trim()) throw new Error(`Missing env: ${name}`);
  return String(v).trim();
}

// =======================
// DISCORD CLIENT (BOT)
// =======================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // para asignar roles
  ],
  partials: [Partials.GuildMember],
});

client.once("ready", () => {
  console.log(`🤖 Bot conectado como ${client.user.tag}`);
});

await client.login(mustEnv("DISCORD_TOKEN", process.env.DISCORD_TOKEN));

// =======================
// SEGURIDAD (Wix -> Render)
// =======================
function auth(req, res, next) {
  const got = String(req.headers.authorization || "").trim();
  const key = String(process.env.BOT_API_KEY || "").trim();

  if (!key) {
    console.error("❌ BOT_API_KEY missing in Render env");
    return res.status(500).json({ ok: false, error: "Server misconfigured" });
  }

  const expected = `Bearer ${key}`;

  if (got !== expected) {
    console.error("❌ AUTH FAIL", { got, expected });
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }

  next();
}

// =========================
// DISCORD OAUTH (server-side, scope identify)
// =========================
const STATE_TTL_MS = 10 * 60 * 1000;
const stateStore = new Map();      // state -> createdAt
const returnUrlStore = new Map();  // state -> returnUrl

function newState() {
  const s = crypto.randomBytes(18).toString("hex");
  stateStore.set(s, Date.now());
  return s;
}
function consumeState(state) {
  const t = stateStore.get(state);
  stateStore.delete(state);
  if (!t) return false;
  return Date.now() - t <= STATE_TTL_MS;
}
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
    const returnUrl = String(req.query.returnUrl || "").trim();
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
  const code = String(req.query.code || "").trim();
  const state = String(req.query.state || "").trim();
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
      String(returnUrlStore.get(state) || "").trim() ||
      String(process.env.WIX_RETURN_URL || "").trim() ||
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
// RECLUTAMIENTO (Wix -> Render)
// - Postea al canal
// - Asigna rol "esperando validación"
// =========================
app.post("/forms/recruitment", auth, async (req, res) => {
  const started = Date.now();

  try {
    console.log("✅ HIT /forms/recruitment");

    // Usa env por defecto (y permite override si mandas en body)
    const guildId = String(req.body?.guildId || process.env.DISCORD_GUILD_ID || "").trim();
    const channelId = String(req.body?.channelId || process.env.DISCORD_RECRUIT_CHANNEL_ID || "").trim();
    const waitingRoleId = String(req.body?.waitingRoleId || process.env.DISCORD_WAITING_ROLE_ID || "").trim();

    // Campos esperados
    const discordUserId = String(req.body?.discordUserId || "").trim();
    const discordTag = String(req.body?.discordTag || "").trim();
    const memberId = String(req.body?.memberId || "").trim();
    const answers = req.body?.answers || {};

    // Logs útiles (sin exponer secrets)
    console.log("PAYLOAD:", {
      guildId,
      channelId,
      waitingRoleId,
      discordUserId,
      memberId,
      hasAnswers: !!answers && typeof answers === "object",
    });

    if (!guildId || !channelId || !waitingRoleId) {
      return res.status(400).json({
        ok: false,
        error: "Missing DISCORD_GUILD_ID / DISCORD_RECRUIT_CHANNEL_ID / DISCORD_WAITING_ROLE_ID",
      });
    }
    if (!discordUserId) return res.status(400).json({ ok: false, error: "Missing discordUserId" });
    if (!answers?.oathAccepted) return res.status(400).json({ ok: false, error: "Oath not accepted" });

    // 1) Postear en canal
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return res.status(404).json({ ok: false, error: "Channel not found or not text-based" });
    }

    const lines = [
      "🛡️ **Nueva Solicitud de Reclutamiento – Ataraxia**",
      "",
      `👤 **Discord:** ${discordTag || "Usuario"} (<@${discordUserId}>)`,
      `🆔 **ID:** ${discordUserId}`,
      memberId ? `🧾 **Wix memberId:** ${memberId}` : null,
      "",
      "**Respuestas:**",
      `1️⃣ ¿Por qué deseas unirte a Ataraxia?: **${answers.whyJoin || "—"}**`,
      `2️⃣ Experiencia en Ashes of Creation: **${answers.aocExperience || "—"}**`,
      `3️⃣ Rol principal (clase): **${answers.mainClass || "—"}**`,
      `4️⃣ Disponibilidad (días): **${Array.isArray(answers.days) ? answers.days.join(", ") : (answers.days || "—")}**`,
      `5️⃣ Disponibilidad (horarios): **${Array.isArray(answers.times) ? answers.times.join(", ") : (answers.times || "—")}**`,
      `6️⃣ ¿Ayudar a nuevos?: **${answers.helpNewbies || "—"}**`,
      `7️⃣ ¿Aceptas jerarquía?: **${answers.acceptHierarchy || "—"}**`,
      `8️⃣ ¿Obedecer calls en PvP?: **${answers.followOrdersPvp || "—"}**`,
      `9️⃣ ¿Líder o ejecutor?: **${answers.leaderOrExecutor || "—"}**`,
      `🔟 ¿Perder loot por la guild?: **${answers.loseLoot || "—"}**`,
      "",
      "📜 **Juramento:**",
      `✅ ${String(answers.oathText || "Juramento aceptado").trim()}`,
    ].filter(Boolean);

    const sent = await channel.send({ content: lines.join("\n") });

    // 2) Asignar rol
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      return res.status(404).json({ ok: false, error: "Guild not found", messageId: sent.id });
    }

    const member = await guild.members.fetch(discordUserId).catch(() => null);
    if (!member) {
      // Esto pasa si el usuario NO está en el servidor
      return res.status(404).json({
        ok: false,
        error: "Member not found in guild (user is not in the server)",
        messageId: sent.id,
      });
    }

    // Si el bot no puede asignar: aquí truena con error claro
    await member.roles.add(waitingRoleId);

    return res.json({
      ok: true,
      messageId: sent.id,
      roleAdded: waitingRoleId,
      ms: Date.now() - started,
    });
  } catch (err) {
    console.error("❌ /forms/recruitment error:", err);
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err),
    });
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
