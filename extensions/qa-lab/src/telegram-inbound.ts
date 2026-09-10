export function renderTelegramQaInbound(
  input: { text: string; nativeCommand?: { name: string } },
  botUsername: string,
) {
  const commandName = input.nativeCommand?.name.trim().toLowerCase();
  const renderedText = input.text.replaceAll("@openclaw", `@${botUsername}`);
  const commandToken = renderedText.match(/^\S+/u)?.[0];
  const text =
    commandName && commandToken?.toLowerCase() === `/${commandName}`
      ? `/${commandName}@${botUsername}${renderedText.slice(commandToken.length)}`
      : renderedText;
  const commandLength = commandName ? (text.match(/^\S+/u)?.[0]?.length ?? 0) : 0;
  const entities = commandLength ? [{ type: "bot_command", offset: 0, length: commandLength }] : [];
  // Telegram clients emit UTF-16 entity offsets; plain text tags alone are not native mentions.
  for (const match of text.matchAll(/(?<![\w@])@[a-z][a-z0-9_]{4,31}(?!\w)/giu)) {
    if (match.index >= commandLength) {
      entities.push({ type: "mention", offset: match.index, length: match[0].length });
    }
  }
  return { text, entities };
}
