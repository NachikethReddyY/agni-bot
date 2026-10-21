/**
 * The labelled corpora the evals measure against.
 *
 * These are small, hand-written sets with a known answer. They are not
 * statistics; they are the promises the system makes, written down so a
 * change that breaks one of them fails loudly.
 */

/** A turn, and whether it should become durable memory. */
export interface LabelledTurn {
  text: string;
  /** The gate should treat this as worth remembering. */
  durable: boolean;
}

/**
 * The gate's job: separate the turns that carry a fact from the ones that
 * do not. A greeting is not a memory; a stated preference is.
 */
export const GATE_CORPUS: LabelledTurn[] = [
  { text: "what is the weather", durable: false },
  { text: "thanks!", durable: false },
  { text: "ok", durable: false },
  { text: "good morning", durable: false },
  { text: "I prefer concise answers without preamble", durable: true },
  { text: "I always deploy on Tuesday mornings", durable: true },
  { text: "My name is Nachiketh", durable: true },
  { text: "We decided to use SQLite for the ledger", durable: true },
  { text: "remember: the wifi password is in the keychain", durable: true },
  { text: "call me Nachi", durable: true },
  { text: "the deadline is Friday", durable: true },
  { text: "sure, whatever you think is best", durable: false },
  { text: "ha, that is funny", durable: false },
  { text: "see you tomorrow", durable: false },
];

/**
 * The facts a needle eval plants and then asks for in a vague way. Each
 * entry is a fact and the question that should find it.
 */
export const NEEDLE_FACTS: Array<{ fact: string; keySlug: string; vague: string }> = [
  { fact: "Deployments happen on Tuesday mornings, never on Fridays.", keySlug: "deploy-day", vague: "when do we deploy" },
  { fact: "The owner prefers dark mode in every editor.", keySlug: "prefers-dark", vague: "what theme do I like" },
  { fact: "The ledger service is called Northwind.", keySlug: "ledger-name", vague: "what is the ledger called" },
  { fact: "The staging database lives in Frankfurt.", keySlug: "staging-region", vague: "where is staging" },
  { fact: "Retries use exponential backoff capped at five minutes.", keySlug: "retry-policy", vague: "how do retries work" },
  { fact: "The owner drinks oat milk, not dairy.", keySlug: "drink", vague: "what do I drink" },
  { fact: "The release train leaves on the first Monday of the month.", keySlug: "release-train", vague: "when is the release" },
  { fact: "Support escalations go to the on-call rota, not to email.", keySlug: "escalation", vague: "who do we escalate to" },
  { fact: "The design system is called Kite.", keySlug: "design-system", vague: "what is the design system called" },
  { fact: "Invoices are issued on the last working day of the month.", keySlug: "invoice-day", vague: "when are invoices sent" },
];

/**
 * A private agent's words. They must never reach the executive assistant.
 */
export const PRIVATE_CANARY = "CANARY-PRIVATE-SHUTTLE-4d2f";

/** A fact scoped to one agent. Another agent must not read it. */
export const SCOPED_CANARY = "CANARY-SCOPED-NOTE-71ab";
