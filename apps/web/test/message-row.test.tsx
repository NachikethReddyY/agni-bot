import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { AgentInfo, ChatMessage } from "@agni/client";
import { AppModel } from "../src/state/app-model";
import { AppModelProvider } from "../src/state/use-app-model";
import { MessageRowView } from "../src/components/MessageRowView";

const agent: AgentInfo = { id: "ea", name: "New Bot", color: "#f0b95a", tools: [] };

function message(partial: Partial<ChatMessage> & { id: string; role: ChatMessage["role"]; text: string }): ChatMessage {
  return {
    createdAt: new Date(),
    turnID: null,
    agentID: "ea",
    sessionID: null,
    state: { kind: "complete" },
    usage: null,
    tools: [],
    isLocalEcho: false,
    senderName: null,
    senderColor: null,
    toAgentId: null,
    uiHint: null,
    taskId: null,
    questionId: null,
    ...partial,
  };
}

function renderRow(m: ChatMessage, agentInfo: AgentInfo = agent) {
  const model = new AppModel({ healthPollMs: 0 });
  return render(
    <AppModelProvider model={model}>
      <MessageRowView message={m} agent={agentInfo} isSelected={false} onToggleSelect={() => undefined} />
    </AppModelProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("the thread", () => {
  it("never repeats the agent name above a message", () => {
    const { container } = renderRow(
      message({ id: "m1", role: "assistant", text: "Hello there.", senderName: "New Bot" }),
    );

    expect(container.querySelector(".sender-line")).toBeNull();
    expect(container.querySelector(".sender-badge")).toBeNull();
    expect(screen.queryByText("New Bot")).not.toBeInTheDocument();
    expect(screen.getByText("Hello there.")).toBeInTheDocument();
  });

  it("asks for a name while the onboarding prompt is open", () => {
    renderRow(
      message({
        id: "m2",
        role: "assistant",
        text: "What would you like to call me?",
        uiHint: "onboarding_name_prompt",
      }),
    );

    expect(screen.getByPlaceholderText("Type your preferred name…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("replaces the name field with a centred confirmation once it is done", () => {
    const { container } = renderRow(
      message({
        id: "m3",
        role: "assistant",
        text: "What would you like to call me?",
        uiHint: "onboarding_completed",
        senderName: "Vision",
      }),
      { id: "ea", name: "Vision", color: "#f0b95a", tools: [], onboarded: true },
    );

    expect(screen.queryByPlaceholderText("Type your preferred name…")).not.toBeInTheDocument();
    expect(screen.getByText("Renamed to Vision")).toBeInTheDocument();

    const done = container.querySelector(".onboarding-done");
    expect(done).not.toBeNull();
    expect(done?.classList.contains("onboarding-done")).toBe(true);
  });

  it("settles the name field when the agent already has a name", () => {
    renderRow(
      message({
        id: "m4",
        role: "assistant",
        text: "What would you like to call me?",
        uiHint: "onboarding_name_prompt",
      }),
      { id: "ea", name: "Vision", color: "#f0b95a", tools: [], onboarded: true },
    );

    expect(screen.queryByPlaceholderText("Type your preferred name…")).not.toBeInTheDocument();
    expect(screen.getByText("Renamed to Vision")).toBeInTheDocument();
  });

  it("renders a handoff as \"Messaged <agent>\", and the name opens that agent", () => {
    const model = new AppModel({ healthPollMs: 0 });
    (model as unknown as { handleFrame: (value: unknown) => void }).handleFrame({
      type: "agents.update",
      seq: 1,
      agents: [
        { id: "ea", name: "Vision", color: "#f0b95a" },
        { id: "friday", name: "F.R.I.D.A.Y.", color: "#4a9eff" },
      ],
    });
    render(
      <AppModelProvider model={model}>
        <MessageRowView
          message={message({
            id: "m5",
            role: "system",
            text: "Messaged F.R.I.D.A.Y.",
            uiHint: "handoff_notice",
            toAgentId: "friday",
          })}
          agent={agent}
          isSelected={false}
          onToggleSelect={() => undefined}
        />
      </AppModelProvider>,
    );

    expect(screen.getByText("Messaged")).toBeInTheDocument();
    const link = screen.getByRole("button", { name: "Open F.R.I.D.A.Y. chat" });
    expect(link).toHaveTextContent("F.R.I.D.A.Y.");
    // The agent's badge sits before its name.
    const notice = link.closest(".handoff-notice");
    expect(notice?.querySelector(".badge")).not.toBeNull();
  });

  it("heads a brief from another agent with who sent it", () => {
    const model = new AppModel({ healthPollMs: 0 });
    (model as unknown as { handleFrame: (value: unknown) => void }).handleFrame({
      type: "agents.update",
      seq: 1,
      agents: [
        { id: "ea", name: "Vision", color: "#f0b95a" },
        { id: "friday", name: "F.R.I.D.A.Y.", color: "#4a9eff" },
      ],
    });
    render(
      <AppModelProvider model={model}>
        <MessageRowView
          message={message({
            id: "m6",
            role: "system",
            text: "Vision messaged you: draft the reply to the invoice",
          })}
          agent={agent}
          isSelected={false}
          onToggleSelect={() => undefined}
        />
      </AppModelProvider>,
    );

    expect(screen.getByText("Message from")).toBeInTheDocument();
    expect(screen.getByText("Vision")).toBeInTheDocument();
    // The brief itself reads as a message, not as a log line.
    expect(screen.getByText("draft the reply to the invoice")).toBeInTheDocument();
    expect(screen.queryByText(/Vision messaged you/)).not.toBeInTheDocument();
  });

  it("leaves an ordinary system note alone", () => {
    renderRow(message({ id: "m7", role: "system", text: "Session closed." }));
    expect(screen.getByText("Session closed.")).toBeInTheDocument();
    expect(screen.queryByText(/Message from/)).not.toBeInTheDocument();
  });
});
