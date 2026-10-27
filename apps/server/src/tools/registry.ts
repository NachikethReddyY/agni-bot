/**
 * Tool registry. Every tool declares a schema and a timeout before it can be
 * registered; the task lane executes them through this registry only.
 *
 * The current task and retrieval captures use validated deterministic paths;
 * model-invoked tools are not enabled until the separate task runner lands.
 * Shell/files/Gmail arrive later with their approval flows.
 */

export interface ToolContext {
  threadID: string;
  turnID: string;
  signal: AbortSignal;
  /**
   * True when this turn was started from another agent's message (a delegation
   * brief, a handoff, or a completion wake). Tools that write durable memory
   * refuse to run in that case.
   */
  peerInput?: boolean;
  /**
   * Agent-to-agent chain metadata. Absent for a root turn; populated for
   * delegated work so tools (notably `handoff`) can refuse or behave
   * differently inside a chain.
   */
  chain?: {
    /** 1 = root turn, 2 = first delegation, … */
    depth: number;
    /** The agent id that started the chain. */
    rootAgentID: string;
    /** The agent id currently running. */
    currentAgentID: string;
    /** Short summary passed in by the delegating agent. */
    handoffSummary: string | null;
  };
}

export type ToolKind = "static" | "dynamic";

export interface ToolDefinition<Args = unknown, Result = unknown> {
  name: string;
  description: string;
  /** JSON-schema-shaped argument description, surfaced to the model. */
  schema: unknown;
  timeoutMs: number;
  kind?: ToolKind;
  handler: (args: Args, ctx: ToolContext) => Promise<Result>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition<never, unknown>>();

  register<Args, Result>(definition: ToolDefinition<Args, Result>): void {
    if (this.tools.has(definition.name)) throw new Error(`tool already registered: ${definition.name}`);
    if (!(definition.timeoutMs > 0)) throw new Error(`tool must declare a positive timeout: ${definition.name}`);
    this.tools.set(definition.name, definition as ToolDefinition<never, unknown>);
  }

  get(name: string): ToolDefinition<never, unknown> | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition<never, unknown>[] {
    return [...this.tools.values()];
  }

  /** Get tools filtered by kind. */
  listByKind(kind: ToolKind): ToolDefinition<never, unknown>[] {
    return [...this.tools.values()].filter((tool) => (tool.kind ?? "static") === kind);
  }

  /** Intersect a persona's allowlist with what is actually registered. */
  allowlist(names: string[]): ToolDefinition<never, unknown>[] {
    return names.map((name) => this.tools.get(name)).filter((tool): tool is ToolDefinition<never, unknown> => Boolean(tool));
  }

  allowlistByKind(names: string[], kind: ToolKind): ToolDefinition<never, unknown>[] {
    return names
      .map((name) => this.tools.get(name))
      .filter((tool): tool is ToolDefinition<never, unknown> => tool !== undefined && (tool.kind ?? "static") === kind);
  }
}

export const toolRegistry = new ToolRegistry();
