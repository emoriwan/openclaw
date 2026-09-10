import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Discord provider module implements model/runtime integration.
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { summarizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatThreadBindingDurationLabel } from "./thread-bindings.messages.js";

export function warnDiscordLegacyGroupContextConfig(params: {
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
  accountId: string;
  runtime: Pick<RuntimeEnv, "log">;
}): void {
  const ignored: string[] = [];
  if (
    Object.values(params.discordConfig.guilds ?? {}).some(
      (guild) =>
        guild.requireMention === false ||
        Object.values(guild.channels ?? {}).some((channel) => channel.requireMention === false),
    )
  ) {
    ignored.push("requireMention=false");
  }
  const groupPolicies = [
    params.cfg.messages?.groupChat,
    ...(params.cfg.agents?.list?.map((agent) => agent.groupChat) ?? []),
  ];
  if (
    params.discordConfig.historyLimit !== undefined ||
    groupPolicies.some((policy) => policy?.historyLimit !== undefined)
  ) {
    ignored.push("historyLimit");
  }
  if (groupPolicies.some((policy) => policy?.unmentionedInbound !== undefined)) {
    ignored.push("unmentionedInbound");
  }
  if (
    params.discordConfig.mentionPatterns !== undefined ||
    groupPolicies.some((policy) => policy?.mentionPatterns !== undefined)
  ) {
    ignored.push("mentionPatterns");
  }
  if (ignored.length > 0) {
    params.runtime.log?.(
      `[discord:${params.accountId}] Legacy group settings remain accepted but no longer control Discord group context: ${ignored.join(", ")}. Groups require a native bot mention or reply. Unread text is retained until a request consumes it; historyLimit does not limit this history.`,
    );
  }
}

function formatThreadBindingDurationForConfigLabel(durationMs: number): string {
  const label = formatThreadBindingDurationLabel(durationMs);
  return label === "disabled" ? "off" : label;
}

export function logDiscordResolvedConfig(params: {
  dmEnabled: boolean;
  dmPolicy: string;
  allowFrom?: string[];
  groupDmEnabled: boolean;
  groupDmChannels?: string[];
  groupPolicy: string;
  guildEntries?: Record<string, unknown>;
  mediaMaxBytes: number;
  nativeEnabled: boolean;
  nativeSkillsEnabled: boolean;
  useAccessGroups: boolean;
  threadBindingsEnabled: boolean;
  threadBindingIdleTimeoutMs: number;
  threadBindingMaxAgeMs: number;
}): void {
  const allowFromSummary = summarizeStringEntries({
    entries: params.allowFrom ?? [],
    limit: 4,
    emptyText: "any",
  });
  const groupDmChannelSummary = summarizeStringEntries({
    entries: params.groupDmChannels ?? [],
    limit: 4,
    emptyText: "any",
  });
  const guildSummary = summarizeStringEntries({
    entries: Object.keys(params.guildEntries ?? {}),
    limit: 4,
    emptyText: "any",
  });
  logVerbose(
    `discord: config dm=${params.dmEnabled ? "on" : "off"} dmPolicy=${params.dmPolicy} allowFrom=${allowFromSummary} groupDm=${params.groupDmEnabled ? "on" : "off"} groupDmChannels=${groupDmChannelSummary} groupPolicy=${params.groupPolicy} guilds=${guildSummary} mediaMaxMb=${Math.round(params.mediaMaxBytes / (1024 * 1024))} native=${params.nativeEnabled ? "on" : "off"} nativeSkills=${params.nativeSkillsEnabled ? "on" : "off"} accessGroups=${params.useAccessGroups ? "on" : "off"} threadBindings=${params.threadBindingsEnabled ? "on" : "off"} threadIdleTimeout=${formatThreadBindingDurationForConfigLabel(params.threadBindingIdleTimeoutMs)} threadMaxAge=${formatThreadBindingDurationForConfigLabel(params.threadBindingMaxAgeMs)}`,
  );
}
