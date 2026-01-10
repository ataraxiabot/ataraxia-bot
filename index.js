import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import { Client, GatewayIntentBits } from "discord.js";

const app = express();
app.use(express.json());

// =======================
// DISCORD CLIENT
// =======================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once("ready", () => {
  console.log(`🤖 Bot conectado como ${client.user.tag}`);
});

// Render (Node ESM) permite top-level await
await client.login(process.env.DISCORD_TOKEN);

// =======================
// SEGURIDAD BÁSICA
// =======================
function auth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  if (authHeader !== `Bearer ${process.env.BOT_API_KEY}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

// =========================
// DISCORD OAUTH
// =========================
app.get("/oauth/discord/start", (req, res) => {
  const state = "ATARAXIA_" + Date.now();

  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify",
    state,
  });

  res.redirect("https://discord.com/oauth2/authorize?" + params.toString());
});

app.get("/oauth/discord/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("No code");

  try {
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

    const tokenData = await tokenRes.json();
    if (!tokenData?.access_token) return res.status(401).send("OAuth token error");

    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    const user = await userRes.json();
    if (!user?.id) return res.status(500).send("Could not fetch user");

    // ✅ mandamos objeto completo al opener
    const safeUser = {
      id: user.id,
      username: user.username,
      global_name: user.global_name || "",
      avatar: user.avatar || "",
    };

    res.send(`
      <script>
        try {
          window.opener.postMessage(
            { type: "discord:ok", discordUser: ${JSON.stringify(safeUser)} },
            "*"
          );
        } catch(e) {}
        window.close();
      </script>
    `);
  } catch (err) {
    console.error("OAuth error:", err);
    res.status(500).send("OAuth error");
  }
});

// =========================
// ROLES SYNC (Wix -> Render)
// Endpoint esperado por Wix: POST /roles/sync
// =========================
app.post("/roles/sync", auth, async (req, res) => {
  try {
    const { guildId, discordUserId, rolesAdd = [], rolesRemove = [] } = req.body || {};

    if (!guildId || !discordUserId) {
      return res.status(400).json({ ok: false, error: "Missing guildId/discordUserId" });
    }

    const gid = String(guildId);
    const uid = String(discordUserId);

    const guild = await client.guilds.fetch(gid);
    if (!guild) return res.status(404).json({ ok: false, error: "Guild not found" });

    const member = await guild.members.fetch(uid).catch(() => null);
    if (!member) {
      return res.status(404).json({
        ok: false,
        error: "Member not found in guild (user must be in the server)"
      });
    }

    const add = Array.isArray(rolesAdd) ? rolesAdd.map(String).filter(Boolean) : [];
    const rem = Array.isArray(rolesRemove) ? rolesRemove.map(String).filter(Boolean) : [];

    // Quitamos primero, luego agregamos
    if (rem.length) await member.roles.remove(rem);
    if (add.length) await member.roles.add(add);

    return res.json({
      ok: true,
      guildId: gid,
      discordUserId: uid,
      rolesAdd: add,
      rolesRemove: rem
    });

  } catch (err) {
    console.error("❌ roles/sync error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// =========================
// RECLUTAMIENTO - POST A DISCORD
// (queda IGUAL, no se rompe)
// =========================
app.post("/forms/recruitment", auth, async (req, res) => {
  try {
    const {
      guildId,
      channelId,
      discordUserId,
      discordTag,
      answers,
      memberId
    } = req.body || {};

    if (!guildId || !channelId || !discordUserId || !answers) {
      return res.status(400).json({ ok: false, error: "Missing fields" });
    }

    console.log("📨 Recruitment IN:", {
      guildId, channelId, discordUserId,
      discordTag: discordTag || null,
      memberId: memberId || null
    });

    const guild = await client.guilds.fetch(guildId);
    if (!guild) return res.status(404).json({ ok: false, error: "Guild not found" });

    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      return res.status(404).json({ ok: false, error: "Channel not found or not text" });
    }

    const lines = [
      "🛡️ **Nueva Solicitud de Reclutamiento – Ataraxia**",
      "",
      `👤 **Discord:** ${discordTag || "Usuario"} (<@${discordUserId}>)`,
      `🆔 **ID:** ${discordUserId}`,
      memberId ? `🧾 **Wix memberId:** ${memberId}` : null,
      "",
      "**Respuestas:**",
      `1️⃣ Tipo de gameplay: **${answers.gameplayType}**`,
      `2️⃣ Días por semana en eventos: **${answers.daysPerWeek}**`,
      `3️⃣ ¿Perder loot por el bien de la guild?: **${answers.loseLoot}**`,
      `4️⃣ ¿Ayudar a miembros más nuevos?: **${answers.helpNewbies}**`,
      `5️⃣ ¿Acepta jerarquía?: **${answers.acceptHierarchy}**`,
      `6️⃣ ¿Guilds grandes antes?: **${answers.bigGuilds}**`,
      `7️⃣ ¿Líder o ejecutor?: **${answers.leaderOrExecutor}**`,
      `8️⃣ ¿Seguir órdenes en PvP masivo?: **${answers.followOrdersMassPvp}**`,
      "",
      "🧠 **9) Si un líder toma una mala decisión:**",
      answers.badLeaderDecision,
      "",
      "🔥 **10) ¿Por qué deberíamos aceptarte?:**",
      answers.whyAccept,
      "",
      "📜 *Juramento aceptado*"
    ].filter(Boolean);

    const msg = await channel.send({ content: lines.join("\n") });

    console.log("✅ Recruitment posted:", {
      channelId,
      messageId: msg.id
    });

    return res.json({ ok: true, messageId: msg.id });

  } catch (err) {
    console.error("❌ Recruitment error:", err);
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

// =======================
// START SERVER
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ API escuchando en puerto", PORT));
