/**
 * Input sanitization and output filtering for LLM-generated tweets.
 * Prevents prompt injection via mentions and credential leakage in replies.
 */

const MAX_MENTION_LENGTH = 500;

// ── Input sanitization ──

const INJECTION_PATTERNS = [
  /ignore\s+(all|previous|prior|above|your)\s+(instructions|rules|prompts?|guidelines)/gi,
  /forget\s+(all|your|previous)\s+(instructions|rules|prompts?)/gi,
  /override\s+(your|all|system)\s+(instructions|rules|prompts?)/gi,
  /reveal\s+(your|the|all)\s+(system|secret|private|api|wallet|key|seed|prompt)/gi,
  /output\s+(your|the|all)\s+(system|secret|private|api|wallet|key|seed|prompt)/gi,
  /show\s+(me\s+)?(your|the|all)\s+(system|secret|private|api|wallet|key|seed|prompt)/gi,
  /what\s+(is|are)\s+your\s+(api|secret|private|wallet|bearer|session|access)\s*(key|token|seed|phrase|address)?/gi,
  /repeat\s+(your|the|all)\s+(system|secret|instructions|rules|prompt)/gi,
  /print\s+(your|the|all)\s+(system|secret|instructions|rules|prompt|env|config)/gi,
  /dump\s+(your|the|all)\s+(system|secret|memory|database|env|config)/gi,
  /between\s*<[^>]*>\s*tags/gi,
  /role:\s*(system|assistant)/gi,
  /\bDAN\b.*\bjailbreak\b/gi,
  /act\s+as\s+(an?\s+)?(unrestricted|unfiltered|developer|admin)/gi,
];

/**
 * Sanitize user mention text before it goes to the LLM.
 * Truncates, strips injection patterns.
 */
export function sanitizeMentionInput(text: string): string {
  let sanitized = text.slice(0, MAX_MENTION_LENGTH);

  for (const pattern of INJECTION_PATTERNS) {
    // Reset lastIndex for global regexps
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, '[filtered]');
  }

  return sanitized.trim();
}

// ── Output filtering ──

const SECRET_PATTERNS = [
  // API keys
  /sk-proj-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /xai-[A-Za-z0-9]{20,}/g,

  // Twitter OAuth tokens
  /\b\d{10,}-[A-Za-z0-9]{20,}/g,

  // Bearer / session tokens
  /bearer\s+[A-Za-z0-9._~+/-]{20,}/gi,
  /session[_-]?token[:\s='"]+[A-Za-z0-9._-]{10,}/gi,

  // Spark / btkn addresses (only block if they look like full wallet addresses in a "reveal" context)
  /spark1[a-z0-9]{58,}/gi,

  // Hex secrets (64-char hex strings like encryption keys)
  /\b[0-9a-f]{64}\b/gi,

  // Mnemonics (12+ words that look like BIP39)
  /\b(abandon|ability|able|about|above|absent|absorb|abstract|absurd|abuse|access|accident)\b(\s+\w+){11,}/gi,

  // Private key patterns
  /private\s*key[:\s='"]+[A-Za-z0-9+/=]{20,}/gi,
  /seed\s*phrase[:\s='"]+.{20,}/gi,

  // Database URLs
  /postgres(ql)?:\/\/[^\s'"]+/gi,

  // Environment variable dumps
  /DATABASE_URL\s*=\s*\S+/gi,
  /OPENAI_API_KEY\s*=\s*\S+/gi,
  /TWITTER_API_(KEY|SECRET)\s*=\s*\S+/gi,
  /OPERATOR_SECRET\s*=\s*\S+/gi,
  /WALLET_ENCRYPTION_KEY\s*=\s*\S+/gi,
];

/**
 * Filter LLM output to catch any accidentally leaked secrets before posting.
 * Returns null if the reply is too suspicious to post.
 */
export function filterLLMOutput(reply: string): string | null {
  let filtered = reply;
  let redactionCount = 0;

  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = filtered.match(pattern);
    if (matches) {
      redactionCount += matches.length;
      filtered = filtered.replace(pattern, '[REDACTED]');
    }
  }

  // If we had to redact anything, the reply is compromised — don't post it
  if (redactionCount > 0) {
    console.warn(`[safety] Blocked reply with ${redactionCount} potential secret(s) redacted.`);
    return null;
  }

  return filtered;
}
