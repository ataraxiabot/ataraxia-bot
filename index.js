import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import { Client, GatewayIntentBits } from "discord.js";

// =======================
// EXPRESS APP
// =======================
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

// Login del bot
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

// 1️⃣ Inicia OAuth
app.get("/oauth/discord/start", (req, res) => {
  // state simple (puedes hacerlo más pro luego)
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

// 2️⃣ Callback OAuth
app.get("/oauth/discord/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("No code");

  try {
    // Intercambiar code → access_token
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

    if (!tokenData.access_token) {
      return res.status(401).send("OAuth token error");
    }

    // Obtener usuario
    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    const user = await userRes.json();

    if (!user?.id) {
      return res.status(500).send("Could not fetch user");
    }

    // ✅ Devuelve discordId al iFrame / Wix (ventana que abrió el popup)
    res.send(`
      <script>
        try{
          window.opener.postMessage(
            { type: "discord:ok", discordId: "${user.id}", username: "${user.username}" },
            "*"
          );
        }catch(e){}
        window.close();
      </script>
    `);
  } catch (err) {
    console.error("OAuth error:", err);
    res.status(500).send("OAuth error");
  }
});

// =======================
// ENDPOINT PARA WIX
// =======================
app.post("/roles/sync", auth, async (req, res) => {
  try {
    const { guildId, discordUserId, rolesAdd = [], rolesRemove = [] } = req.body;

    if (!guildId || !discordUserId) {
      return res.status(400).json({
        ok: false,
        error: "guildId y discordUserId son requeridos",
      });
    }

    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(discordUserId);

    if (rolesRemove.length > 0) await member.roles.remove(rolesRemove);
    if (rolesAdd.length > 0) await member.roles.add(rolesAdd);

    return res.json({ ok: true, added: rolesAdd, removed: rolesRemove });
  } catch (err) {
    console.error("❌ Error en /roles/sync:", err);
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err),
    });
  }
});

// =======================
// START SERVER
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ API escuchando en puerto", PORT));
});
