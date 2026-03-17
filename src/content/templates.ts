/**
 * Template seed prompts per topic.
 * These are NOT posted verbatim — they are seed prompts fed through RAG + LLM
 * to generate unique tweets each time. The variety here prevents the LLM from
 * falling into repetitive patterns even with the same topic.
 */

import { Topic } from './topics.js';

const S402_EDUCATION: string[] = [
  'Explain how the s402 protocol lets agents pay for API calls using Bitcoin micropayments on Spark.',
  'Describe the flow: HTTP 402 → invoice → pay → access. Why this matters for autonomous agents.',
  'Compare s402 to traditional API payment (credit cards, subscriptions). What makes s402 different for machines?',
  'Explain why agents need a payment protocol before they need more features.',
  'Talk about the machine-to-machine economy that s402 enables on Bitcoin.',
  'Describe s402 from a developer perspective — open standard, easy to integrate.',
  'HTTP has status codes. 402 means pay first. Explain how s402 standardizes this for AI agents.',
  'Explain why Spark makes s402 instant and near-zero fee compared to on-chain Bitcoin.',
  'The handshake: s402 quotes, Spark invoices, agent pays, access granted. Walk through the loop.',
  'Talk about s402 as the missing piece — agents can reason, but they need a way to pay.',
  'Explain the builder stack: data from UTXO, logic on Spark, payment via s402.',
  'Why pay-per-call beats subscriptions for AI agents that operate autonomously.',
];

const SPARK_INFRASTRUCTURE: string[] = [
  'Explain what Spark provides: programmable rails for Bitcoin-native tokens.',
  'Describe bonding curves on Spark — tokens launch, curve fills, then migrate to full AMM.',
  'Talk about programmable money on Bitcoin via Spark.',
  'Explain why Spark is to Bitcoin what smart contracts are to Ethereum, but different.',
  'Describe the Spark stack: bonding curves, migration, then liquidity.',
  'Talk about Spark enabling programmable Bitcoin markets that agents can participate in.',
  'Explain how liquidity on Spark moves through curves, not order books.',
  'Builder view: Spark = programmable liquidity. Flashnet = speed. s402 = pay gate.',
  'Describe what makes Spark unique as a Bitcoin L2 for token infrastructure.',
  'Talk about instant, near-zero-fee BTC and token transfers on Spark.',
];

const FLASHNET_INFRASTRUCTURE: string[] = [
  'Explain what Flashnet does: reduces latency for Spark transactions.',
  'Describe why speed matters when agents trade — Flashnet delivers low-latency settlement.',
  'Talk about the infrastructure stack: Flashnet for speed, Spark for logic, s402 for payments.',
  'Explain the difference between Flashnet (speed) and Spark (programmability).',
  'Describe agent trading architecture: Flashnet for speed, Spark for rails, s402 for payment.',
  'Talk about fast settlement as a prerequisite for real-time agent economies.',
  'Explain how low latency plus programmable rails creates the full stack.',
];

const UTXO_ECOSYSTEM: string[] = [
  'Talk about UTXO Exchange — the first DEX for Bitcoin-native tokens on Spark.',
  'Describe what makes UTXO unique: where agents and humans meet the same liquidity.',
  'Explain the token lifecycle: launch on bonding curve → migrate to AMM → full trading.',
  'Talk about trending tokens on UTXO and what the data tells you.',
  'Describe UTXO as where signals become markets.',
  'Explain the difference between "New Pairs", "Migrating", and "Migrated" on UTXO.',
  'Talk about liquidity and price discovery on UTXO Exchange.',
  'Describe UTXO as the execution layer: market data, order flow, programmability.',
  'Talk about what real traction looks like on UTXO vs hype.',
];

const AGENT_ECONOMY: string[] = [
  'Explain what the agent economy looks like: machines trading with machines via protocols.',
  'Describe why agents need infrastructure (s402, Spark) before they can trade effectively.',
  'Talk about the loop: AI observes → agents act → humans confirm.',
  'Explain why the agent economy runs on protocols, not sentiment.',
  'Describe what agents need: balance, signals, and a way to pay. That is the stack.',
  'Talk about how intelligence systems eventually develop economies.',
  'Explain the three layers agents need: data, decision, execution. Where s402 fits.',
  'Compare human traders (charts, sentiment) vs agent traders (APIs, protocols).',
  'Describe the agent economy as infrastructure-first, then signals, then execution.',
  'Talk about why the future of trading is machines that get rate-limited, not emotional.',
  'Explain why agents need a payment protocol before they need more features.',
];

const BEAST_EVOLUTION: string[] = [
  'Talk about Beast learning the UTXO ecosystem — what has changed, what is next.',
  'Describe Beast\'s architecture: observe → score → report. Execution stays elsewhere.',
  'Talk about Beast as the intelligence layer and UTXO as the execution layer.',
  'Describe Beast\'s evolution: more signals, better context, same boundaries.',
  'Talk about what Beast is building toward: AI KOL for s402, Spark, Flashnet, UTXO.',
  'Explain Beast\'s role: interface layer that processes signals and generates content.',
  'Describe the growth path: memory of past signals → better answers → same boundaries.',
  'Talk about being an AI agent that is honest about what it knows and doesn\'t know.',
];

const BEAST_TOKEN: string[] = [
  'Talk about $BEAST — the agent-layer token. Utility over hype.',
  'Describe $BEAST as access to agent signals and content. No promises.',
  'Talk about $BEAST on UTXO Exchange — where the agent meets its own market.',
  'Explain that Beast doesn\'t shill — Beast reports. $BEAST reflects that ethos.',
];

const SIGNALS: string[] = [
  'Explain the difference between a signal (data) and a trade (action).',
  'Describe what a high score means: interesting data, not financial advice.',
  'Talk about how Beast processes signals: inputs in, analysis out, execution elsewhere.',
  'Explain that trending is a list, not a recommendation.',
];

const DRY_OBSERVATION: string[] = [
  'Make a dry observation about markets: humans chase price, machines watch liquidity.',
  'Observe that liquidity often precedes price movement.',
  'Note that momentum follows participation, not the other way around.',
  'Make a dry quip about noise vs signal in crypto markets.',
  'Observe that the chart doesn\'t care about your narrative.',
  'Note that volume is a number and narrative is optional.',
  'Make a wry observation about market structure vs market sentiment.',
  'Observe that alpha is a signal, not a guarantee.',
  'Note the pattern: liquidity moves, then price, then narrative.',
  'Make a dry observation about structure, flow, and narrative — in that order.',
  'Observe that the order book doesn\'t have a mood.',
  'Note that trending is data, not a buy signal.',
  'Make a wry observation about sentiment as input vs execution elsewhere.',
  'Observe that agents see structure before acting. Most humans don\'t.',
  'Note that noise is high and signal is sparse — always.',
];

const TEMPLATES: Record<Topic, string[]> = {
  [Topic.S402_EDUCATION]: S402_EDUCATION,
  [Topic.SPARK_INFRASTRUCTURE]: SPARK_INFRASTRUCTURE,
  [Topic.FLASHNET_INFRASTRUCTURE]: FLASHNET_INFRASTRUCTURE,
  [Topic.UTXO_ECOSYSTEM]: UTXO_ECOSYSTEM,
  [Topic.AGENT_ECONOMY]: AGENT_ECONOMY,
  [Topic.BEAST_EVOLUTION]: BEAST_EVOLUTION,
  [Topic.BEAST_TOKEN]: BEAST_TOKEN,
  [Topic.SIGNALS]: SIGNALS,
  [Topic.DRY_OBSERVATION]: DRY_OBSERVATION,
};

/**
 * Return a random template seed for the given topic.
 */
export function getTemplateSeed(topic: Topic): string {
  const arr = TEMPLATES[topic];
  if (!arr || arr.length === 0) return 'Share an observation about Bitcoin markets and agents.';
  return arr[Math.floor(Math.random() * arr.length)];
}
