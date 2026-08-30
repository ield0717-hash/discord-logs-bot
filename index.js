const { 
  Client, 
  GatewayIntentBits, 
  REST, 
  Routes, 
  SlashCommandBuilder, 
  EmbedBuilder, 
  PermissionFlagsBits,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType
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
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Logs & Auto-Mod Bot is live!');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP Server listening on port ${PORT}`);
});

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

// Helper function to build log page embeds
function buildLogEmbed(entries, category, titleEmoji, page, totalPages, searchQuery) {
  const itemsPerPage = 8;
  const startIndex = (page - 1) * itemsPerPage;
  const pageEntries = entries.slice(startIndex, startIndex + itemsPerPage);

  let logLines = pageEntries.map(e => {
    const time = e.time || 'N/A';
    const user = `**${e.username || 'Unknown'}** (\`${e.userId || 'N/A'}\`)`;

    if (category === 'chats') return `\`[${time}]\` ${user}\n└ ${e.message}`;
    if (category === 'commands') return `\`[${time}]\` ${user}\n└ Command: \`${e.command}\``;
    if (category === 'joins') return `\`[${time}]\` 🟢 ${user} joined`;
    if (category === 'leaves') return `\`[${time}]\` 🔴 ${user} left`;
    return '';
  });

  const embed = new EmbedBuilder()
    .setTitle(`${titleEmoji} Game Logs: ${category.toUpperCase()}`)
    .setColor('#2F3136')
    .setDescription(logLines.join('\n\n'))
    .setFooter({ 
      text: `Page ${page} of ${totalPages} | Total Records: ${entries.length}` + (searchQuery ? ` | Filter: ${searchQuery}` : '') 
    })
    .setTimestamp();

  return embed;
}

// Generic Log Fetcher Function with Interactive Pagination
async function handleLogCommand(interaction, category, titleEmoji) {
  const isStaff = (STAFF_ROLE_ID && interaction.member.roles.cache.has(STAFF_ROLE_ID)) ||
                  interaction.member.permissions.has(PermissionFlagsBits.Administrator);

  if (!isStaff) {
    return interaction.reply({ content: '🔒 **Access Denied:** Staff members only.', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const searchQuery = interaction.options.getString('search')?.toLowerCase();
  
  let cleanUrl = (FIREBASE_URL || '').trim();
  if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
    cleanUrl = 'https://' + cleanUrl;
  }
  cleanUrl = cleanUrl.replace(/\/$/, '');

  const queryUrl = `${cleanUrl}/logs/${category}.json`;

  try {
    const res = await fetch(queryUrl);

    if (!res.ok) {
      return interaction.editReply(`⚠️ Firebase HTTP Error **${res.status} ${res.statusText}**. Check your FIREBASE_URL variable on Render.`);
    }

    const data = await res.json();

    if (!data || typeof data !== 'object') {
      return interaction.editReply(`ℹ️ No **${category}** logs recorded in Firebase yet. Launch Roblox and play first!`);
    }

    let entries = Object.values(data);

    // Apply search filter
    if (searchQuery) {
      entries = entries.filter(e => 
        (e.username && e.username.toLowerCase().includes(searchQuery)) || 
        (e.userId && String(e.userId).toLowerCase() === searchQuery)
      );
    }

    if (entries.length === 0) {
      return interaction.editReply(`ℹ️ No logs found matching query: \`${searchQuery}\`.`);
    }

    // Sort newest to oldest
    entries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const itemsPerPage = 8;
    const totalPages = Math.ceil(entries.length / itemsPerPage);
    let currentPage = 1;

    // Build buttons
    const getButtons = (page) => new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('prev_page')
        .setLabel('◀ Previous')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === 1),
      new ButtonBuilder()
        .setCustomId('next_page')
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === totalPages)
    );

    const initialEmbed = buildLogEmbed(entries, category, titleEmoji, currentPage, totalPages, searchQuery);
    const response = await interaction.editReply({ 
      embeds: [initialEmbed], 
      components: totalPages > 1 ? [getButtons(currentPage)] : [] 
    });

    if (totalPages <= 1) return;

    // Collector for button pagination (Active for 2 minutes)
    const collector = response.createMessageComponentCollector({ 
      componentType: ComponentType.Button, 
      time: 120000 
    });

    collector.on('collect', async i => {
      if (i.user.id !== interaction.user.id) {
        return i.reply({ content: '❌ Only the command runner can use these buttons.', flags: MessageFlags.Ephemeral });
      }

      if (i.customId === 'prev_page' && currentPage > 1) {
        currentPage--;
      } else if (i.customId === 'next_page' && currentPage < totalPages) {
        currentPage++;
      }

      const newEmbed = buildLogEmbed(entries, category, titleEmoji, currentPage, totalPages, searchQuery);
      await i.update({ embeds: [newEmbed], components: [getButtons(currentPage)] });
    });

    collector.on('end', async () => {
      const disabledButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('prev_page').setLabel('◀ Previous').setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId('next_page').setLabel('Next ▶').setStyle(ButtonStyle.Primary).setDisabled(true)
      );
      await interaction.editReply({ components: [disabledButtons] }).catch(() => {});
    });

  } catch (err) {
    console.error('Firebase Fetch Error:', err);
    await interaction.editReply(`❌ Network error: \`${err.message}\`. Verify your \`FIREBASE_URL\` setting.`);
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
