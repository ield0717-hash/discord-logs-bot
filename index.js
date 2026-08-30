const { 
  Client, 
  GatewayIntentBits, 
  REST, 
  Routes, 
  SlashCommandBuilder, 
  EmbedBuilder, 
  PermissionFlagsBits 
} = require('discord.js');
const http = require('http');

// Auto-Mod Setup (Bad Words Filter)
const BadWords = require('bad-words');
const FilterClass = BadWords.default || BadWords.Filter || BadWords;
const filter = new FilterClass();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Create a basic HTTP server to satisfy hosting platforms like Render
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Logs & Auto-Mod Bot is live!');
}).listen(port);

const userWarnings = new Map();

const { 
  TOKEN, 
  DISCORD_TOKEN, 
  CLIENT_ID, 
  GUILD_ID, 
  FIREBASE_URL,
  STAFF_ROLE_ID
} = process.env;

// Helper Function: Resolve Roblox Username to User ID
async function resolveRobloxUser(input) {
  if (/^\d+$/.test(input)) return { id: input, username: input };
  try {
    const res = await fetch('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [input], excludeBannedUsers: false }),
    });
    const data = await res.json();
    if (data.data && data.data.length > 0) {
      return { id: data.data[0].id.toString(), username: data.data[0].name };
    }
  } catch (err) {
    console.error('Error resolving Roblox username:', err);
  }
  return null;
}

// Define Slash Command (/get-logs)
const commands = [
  new SlashCommandBuilder()
    .setName('get-logs')
    .setDescription('Staff Only: Search player chats or join history')
    .addStringOption(opt => 
      opt.setName('username')
         .setDescription('Roblox Username or User ID')
         .setRequired(true)
    )
    .addStringOption(opt => 
      opt.setName('type')
         .setDescription('Log type')
         .setRequired(true)
         .addChoices(
           { name: 'In-Game Chat Messages', value: 'chats' },
           { name: 'Join & Leave Sessions', value: 'sessions' }
         )
    ),
].map(cmd => cmd.toJSON());

const botToken = TOKEN || DISCORD_TOKEN;
const rest = new REST({ version: '10' }).setToken(botToken);

// Register Command with Discord API
(async () => {
  try {
    console.log('Registering /get-logs slash command...');
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log('Slash command registered successfully!');
  } catch (err) {
    console.error('Failed to register slash command:', err);
  }
})();

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}!`);
});

// Auto-Moderation Listener (Swear Warning + 10-Minute Timeout)
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  
  // Ignore administrators and moderators from auto-mod
  if (message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return;

  if (filter.isProfane(message.content)) {
    try {
      const userId = message.author.id;
      const warnings = (userWarnings.get(userId) || 0) + 1;
      userWarnings.set(userId, warnings);
      await message.delete();

      if (warnings >= 2) {
        userWarnings.set(userId, 0);
        await message.member.timeout(10 * 60 * 1000, 'Auto-Mod Swearing Limit');
        const msg = await message.channel.send(`🚫 <@${userId}> was muted for 10 minutes (2 Swear Warnings).`);
        setTimeout(() => msg.delete().catch(() => {}), 8000);
      } else {
        const msg = await message.channel.send(`⚠️ <@${userId}> Watch your language! Warning **1/2**.`);
        setTimeout(() => msg.delete().catch(() => {}), 5000);
      }
    } catch (err) {
      console.error('Auto-Mod Error:', err);
    }
  }
});

// Slash Command Interaction Handling
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, options } = interaction;

  if (commandName === 'get-logs') {
    // Permission check: Must have STAFF_ROLE_ID or Administrator
    const isStaff = (STAFF_ROLE_ID && interaction.member.roles.cache.has(STAFF_ROLE_ID)) ||
                    interaction.member.permissions.has(PermissionFlagsBits.Administrator);

    if (!isStaff) {
      return interaction.reply({ content: '🔒 **Access Denied:** Staff members only.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const userInput = options.getString('username');
    const logType = options.getString('type');
    const robloxUser = await resolveRobloxUser(userInput);

    if (!robloxUser) return interaction.editReply(`❌ User \`${userInput}\` not found on Roblox.`);

    const cleanUrl = (FIREBASE_URL || '').replace(/\/$/, '');
    const queryUrl = `${cleanUrl}/logs/${logType}/${robloxUser.id}.json`;

    try {
      const res = await fetch(queryUrl);
      const data = await res.json();

      if (!data) return interaction.editReply(`ℹ️ No ${logType} logs found for **${robloxUser.username}**.`);

      // Format top 15 log entries
      const entries = Object.values(data).sort((a, b) => b.timestamp - a.timestamp).slice(0, 15);
      
      const logBody = logType === 'chats'
        ? entries.map(e => `\`[${e.date} ${e.time}]\` **Chat:** ${e.message}`).join('\n')
        : entries.map(e => `\`[${e.date} ${e.time}]\` **Status:** ${e.type === 'JOIN' ? '🟢 Joined' : '🔴 Left'}`).join('\n');

      const embed = new EmbedBuilder()
        .setTitle(`📜 Game Logs: ${robloxUser.username}`)
        .setColor('Blue')
        .setDescription(logBody.substring(0, 4000))
        .setFooter({ text: `Requested by ${interaction.user.tag}` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('Firebase Query Error:', err);
      await interaction.editReply('❌ Failed to fetch data from Firebase.');
    }
  }
});

client.login(botToken);