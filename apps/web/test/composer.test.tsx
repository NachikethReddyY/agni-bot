import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppModel } from "../src/state/app-model";
import { AppModelProvider } from "../src/state/use-app-model";
import { ComposerView } from "../src/components/ComposerView";
import { MarkdownText } from "../src/components/MarkdownText";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function composer() {
  const model = new AppModel({ healthPollMs: 0 });
  const send = vi.spyOn(model, "send").mockReturnValue(true);
  render(<AppModelProvider model={model}><ComposerView /></AppModelProvider>);
  return { model, send, input: screen.getByRole("textbox") };
}
it("Enter sends, Shift+Enter and input composition do not send", () => {
  const { input, send } = composer();
  fireEvent.change(input, { target: { value: "first\nsecond" } });
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(send).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(send).toHaveBeenCalledWith("first\nsecond");
  expect(input).toHaveValue("");
});
it("unknown slash-prefixed text is sent instead of erased", () => {
  const { input, send } = composer();
  fireEvent.change(input, { target: { value: "/tmp/example.txt" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(send).toHaveBeenCalledWith("/tmp/example.txt");
});
it("retains attachment drafts on failure and retries without reuploading", async () => {
  const { model, input } = composer();
  const upload = vi.spyOn(model, "uploadAttachment").mockResolvedValue({ id: "att_fixture", name: "notes.txt", mimeType: "text/plain", size: 5, kind: "text" });
  const send = vi.spyOn(model, "sendAttachments").mockRejectedValueOnce(new Error("No connection")).mockResolvedValueOnce();
  fireEvent.change(screen.getByLabelText("Attach files"), { target: { files: [new File(["hello"], "notes.txt")] } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(await screen.findByText("No connection")).toBeInTheDocument();
  expect(screen.getByText("notes.txt")).toBeInTheDocument();
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(screen.queryByText("notes.txt")).not.toBeInTheDocument());
  expect(upload).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(2);
});
it("renders Markdown tables, lists, code, and single newlines", () => {
  const { container } = render(<MarkdownText text={'**bold**\nnext\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n\n```js\nconst x = 1;\n```'} />);
  expect(container.querySelector("strong")?.textContent).toBe("bold");
  expect(container.querySelector("br")).not.toBeNull();
  expect(screen.getByRole("table")).toBeInTheDocument();
  expect(screen.getByRole("checkbox")).toBeChecked();
  expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
});
