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

// Port binding for Render hosting
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

// Define 4 Log Commands
const commands = [
  new SlashCommandBuilder()
    .setName('chat-logs')
    .setDescription('Show overall chat logs (optional: filter by user)')
    .addStringOption(opt => opt.setName('search').setDescription('Search by Username or User ID').setRequired(false)),

  new SlashCommandBuilder()
    .setName('join-logs')
    .setDescription('Show player join history (optional: filter by user)')
    .addStringOption(opt => opt.setName('search').setDescription('Search by Username or User ID').setRequired(false)),

  new SlashCommandBuilder()
    .setName('leave-logs')
    .setDescription('Show player leave history (optional: filter by user)')
    .addStringOption(opt => opt.setName('search').setDescription('Search by Username or User ID').setRequired(false)),

  new SlashCommandBuilder()
    .setName('command-logs')
    .setDescription('Show executed game commands (optional: filter by user)')
    .addStringOption(opt => opt.setName('search').setDescription('Search by Username or User ID').setRequired(false)),
].map(cmd => cmd.toJSON());

const botToken = TOKEN || DISCORD_TOKEN;
const rest = new REST({ version: '10' }).setToken(botToken);

// Register Commands with Discord
(async () => {
  try {
    console.log('Registering 4 slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log('Slash commands registered successfully!');
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
})();

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}!`);
});

// Auto-Moderation Listener
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
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

// Generic Log Fetcher Function
async function handleLogCommand(interaction, category, titleEmoji) {
  const isStaff = (STAFF_ROLE_ID && interaction.member.roles.cache.has(STAFF_ROLE_ID)) ||
                  interaction.member.permissions.has(PermissionFlagsBits.Administrator);

  if (!isStaff) {
    return interaction.reply({ content: '🔒 **Access Denied:** Staff members only.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const searchQuery = interaction.options.getString('search')?.toLowerCase();
  const cleanUrl = (FIREBASE_URL || '').replace(/\/$/, '');
  const queryUrl = `${cleanUrl}/logs/${category}.json`;

  try {
    const res = await fetch(queryUrl);
    const data = await res.json();

    if (!data) {
      return interaction.editReply(`ℹ️ No ${category} logs recorded yet.`);
    }

    let entries = Object.values(data);

    // Apply optional search filter
    if (searchQuery) {
      entries = entries.filter(e => 
        e.username.toLowerCase().includes(searchQuery) || 
        e.userId.toLowerCase() === searchQuery
      );
    }

    if (entries.length === 0) {
      return interaction.editReply(`ℹ️ No logs found matching query: \`${searchQuery}\`.`);
    }

    // Sort newest to oldest and take top 15
    entries.sort((a, b) => b.timestamp - a.timestamp);
    const recentEntries = entries.slice(0, 15);

    let logBody = '';
    if (category === 'chats') {
      logBody = recentEntries.map(e => `\`[${e.time}]\` **${e.username}** (\`${e.userId}\`): ${e.message}`).join('\n');
    } else if (category === 'commands') {
      logBody = recentEntries.map(e => `\`[${e.time}]\` **${e.username}**: \`${e.command}\``).join('\n');
    } else if (category === 'joins') {
      logBody = recentEntries.map(e => `\`[${e.time}]\` 🟢 **${e.username}** (\`${e.userId}\`) joined`).join('\n');
    } else if (category === 'leaves') {
      logBody = recentEntries.map(e => `\`[${e.time}]\` 🔴 **${e.username}** (\`${e.userId}\`) left`).join('\n');
    }

    const embed = new EmbedBuilder()
      .setTitle(`${titleEmoji} Game Logs: ${category.toUpperCase()}`)
      .setColor('Blue')
      .setDescription(logBody.substring(0, 4000))
      .setFooter({ text: searchQuery ? `Filtered by: ${searchQuery}` : 'Showing global history' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

  } catch (err) {
    console.error('Firebase Query Error:', err);
    await interaction.editReply('❌ Failed to fetch data from Firebase.');
  }
}

// Slash Command Interaction Listener
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'chat-logs') await handleLogCommand(interaction, 'chats', '💬');
  if (commandName === 'join-logs') await handleLogCommand(interaction, 'joins', '🟢');
  if (commandName === 'leave-logs') await handleLogCommand(interaction, 'leaves', '🔴');
  if (commandName === 'command-logs') await handleLogCommand(interaction, 'commands', '⚙️');
});

client.login(botToken);
