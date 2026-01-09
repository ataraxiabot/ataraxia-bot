import 'dotenv/config';
import express from 'express';
import { Client, GatewayIntentBits } from 'discord.js';

// =======================
// EXPRESS APP
// =======================
const app = express();
app.use(express.json());

// =======================
// DISCORD CLIENT
// =======================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

client.once('ready', () => {
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
    return res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
  }
  next();
}

// =======================
// ENDPOINT PARA WIX
// =======================
app.post('/roles/sync', auth, async (req, res) => {
  try {
    const {
      guildId,
      discordUserId,
      rolesAdd = [],
      rolesRemove = []
    } = req.body;

    if (!guildId || !discordUserId) {
      return res.status(400).json({
        ok: false,
        error: "guildId y discordUserId son requeridos"
      });
    }

    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(discordUserId);

    if (rolesRemove.length > 0) {
      await member.roles.remove(rolesRemove);
    }

    if (rolesAdd.length > 0) {
      await member.roles.add(rolesAdd);
    }

    return res.json({
      ok: true,
      added: rolesAdd,
      removed: rolesRemove
    });

  } catch (err) {
    console.error("❌ Error en /roles/sync:", err);
    return res.status(500).json({
      ok: false,
      error: String(err)
    });
  }
});

// =======================
// START SERVER
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 API escuchando en puerto ${PORT}`);
});
