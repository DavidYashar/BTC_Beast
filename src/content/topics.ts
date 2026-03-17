/**
 * Content engine topic definitions and weighted distribution.
 * Adapted from handoff v2 — same categories, integrated into our RAG pipeline.
 */

export enum Topic {
  S402_EDUCATION = 'S402_EDUCATION',
  SPARK_INFRASTRUCTURE = 'SPARK_INFRASTRUCTURE',
  FLASHNET_INFRASTRUCTURE = 'FLASHNET_INFRASTRUCTURE',
  UTXO_ECOSYSTEM = 'UTXO_ECOSYSTEM',
  AGENT_ECONOMY = 'AGENT_ECONOMY',
  BEAST_EVOLUTION = 'BEAST_EVOLUTION',
  BEAST_TOKEN = 'BEAST_TOKEN',
  SIGNALS = 'SIGNALS',
  DRY_OBSERVATION = 'DRY_OBSERVATION',
}

export const ALL_TOPICS: Topic[] = Object.values(Topic) as Topic[];

/** Weighted topic distribution — s402 heavy, signals and dry observation light. */
const WEIGHTS: { topic: Topic; weight: number }[] = [
  { topic: Topic.S402_EDUCATION, weight: 35 },
  { topic: Topic.SPARK_INFRASTRUCTURE, weight: 10 },
  { topic: Topic.FLASHNET_INFRASTRUCTURE, weight: 10 },
  { topic: Topic.AGENT_ECONOMY, weight: 15 },
  { topic: Topic.UTXO_ECOSYSTEM, weight: 10 },
  { topic: Topic.BEAST_EVOLUTION, weight: 10 },
  { topic: Topic.BEAST_TOKEN, weight: 5 },
  { topic: Topic.SIGNALS, weight: 3 },
  { topic: Topic.DRY_OBSERVATION, weight: 2 },
];

/** Maximum signal-category tweets per day. */
export const MAX_SIGNAL_TWEETS_PER_DAY = 2;

/**
 * Pick a topic using weighted random selection.
 * If `excludeSignals` is true, SIGNALS is removed from the pool.
 */
export function pickTopic(excludeSignals = false): Topic {
  const pool = excludeSignals
    ? WEIGHTS.filter((w) => w.topic !== Topic.SIGNALS)
    : WEIGHTS;
  const total = pool.reduce((s, w) => s + w.weight, 0);
  let r = Math.random() * total;
  for (const { topic, weight } of pool) {
    r -= weight;
    if (r <= 0) return topic;
  }
  return Topic.DRY_OBSERVATION;
}

/** Human-readable label for logging. */
export function topicLabel(topic: Topic): string {
  return topic.toLowerCase().replace(/_/g, '-');
}
