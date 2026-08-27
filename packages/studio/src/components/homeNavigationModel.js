export const HOME_QUICK_ACTIONS = [
  { id: "ai-generator", label: "AI Generator", description: "Start a secure image or video project.", tabId: "creator" },
  { id: "ai-influencer", label: "AI Influencer", description: "Create consistent influencer content.", tabId: "ai-influencer" },
  { id: "music-video", label: "Music Video", description: "Build a multi-scene music video storyboard.", tabId: "creator" },
  { id: "image", label: "Image", description: "Generate a still through Creator Studio.", tabId: "creator" },
  { id: "video", label: "Video", description: "Generate or animate video through Creator Studio.", tabId: "creator" },
  { id: "storyboard", label: "Storyboard", description: "Plan connected scenes and transitions.", tabId: "creator" },
  { id: "design", label: "Design", description: "Open the existing design workspace.", tabId: "design-agent" },
  { id: "social-campaign", label: "Social Campaign", description: "Package content for a campaign.", tabId: "marketing" },
  { id: "youtube", label: "YouTube", description: "Connect or review private publishing.", tabId: "youtube" },
];

const INTENT_RULES = [
  { pattern: /youtube|publish|upload|channel/i, tabId: "youtube" },
  { pattern: /influencer/i, tabId: "ai-influencer" },
  { pattern: /campaign|social package|social content/i, tabId: "marketing" },
  { pattern: /workflow|automation|nodes?/i, tabId: "workflows" },
  { pattern: /design|graphic|thumbnail|poster|flyer/i, tabId: "design-agent" },
  { pattern: /voice|narration|speech/i, tabId: "voice" },
  { pattern: /avatar|presenter|digital twin/i, tabId: "avatar" },
  { pattern: /music video|storyboard|scene|image|photo|video|animate|film/i, tabId: "creator" },
];

export function resolveHomeIntent(prompt) {
  const normalized = typeof prompt === "string" ? prompt.trim() : "";
  if (!normalized) return "creator";
  return INTENT_RULES.find(({ pattern }) => pattern.test(normalized))?.tabId || "agents";
}
