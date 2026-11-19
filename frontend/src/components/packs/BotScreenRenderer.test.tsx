import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BotScreenRenderer } from "./BotScreenRenderer";
import { getBotMenu, getBotMessages, invokeBotAction } from "@/lib/api/bots";

vi.mock("@/lib/api/bots", () => ({ getBotMenu: vi.fn(), getBotMessages: vi.fn(), invokeBotAction: vi.fn(), invokeBotActionUpload: vi.fn() }));
vi.mock("@/hooks/use-back-to-close", () => ({ useBackToClose: vi.fn() }));

describe("conversational bot controls", () => {
  beforeEach(() => { vi.resetAllMocks(); vi.mocked(getBotMessages).mockResolvedValue([]); });
  it("shows readable current rule states in the list", async () => {
    vi.mocked(getBotMenu).mockResolvedValue({ screenId: "group", title: "Gameplay rules", presentation: "conversation", items: [{ id: "fire", title: "Fire spreads", subtitle: "Off · Fire can spread and burn blocks", action: { id: "fire", label: "Change", type: "form" } }], actions: [] });
    render(<BotScreenRenderer botKey="controls" />);
    expect(await screen.findByRole("button", { name: /Fire spreads.*Off.*Fire can spread/ })).toBeInTheDocument();
  });
  it("navigates from an interactive category to a readable list", async () => {
    vi.mocked(getBotMenu).mockResolvedValueOnce({ screenId: "resource", title: "Minecraft", subtitle: "Choose a section", presentation: "conversation", items: [{ id: "mods", title: "Mods", action: { id: "mods", label: "Mods", type: "navigate", screenId: "group", params: { resource: "minecraft", group: "Mods" } } }], actions: [] });
    vi.mocked(getBotMenu).mockResolvedValueOnce({ screenId: "group", title: "Mods", subtitle: "1 installed", presentation: "conversation", items: [{ id: "m", title: "Fabric API", subtitle: "Enabled", action: { id: "open", label: "Open", type: "navigate", screenId: "entry" } }], actions: [] });
    render(<BotScreenRenderer botKey="controls" />);
    fireEvent.click(await screen.findByRole("button", { name: "Mods" }));
    expect(await screen.findByRole("button", { name: /Fabric API\s*Enabled/ })).toBeInTheDocument();
  });
  it("collapses and restores the controls panel", async () => {
    vi.mocked(getBotMenu).mockResolvedValue({ screenId: "resource", title: "Minecraft", presentation: "conversation", items: [], actions: [{ id: "back", label: "Back", type: "navigate", screenId: "home" }, { id: "refresh", label: "Refresh", type: "invoke" }] });
    render(<BotScreenRenderer botKey="controls" />);
    fireEvent.click(await screen.findByRole("button", { name: "Controls" }));
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show controls" }));
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });
  it("asks for input before confirmation and does not send the action until confirmed", async () => {
    vi.mocked(getBotMenu).mockResolvedValue({ screenId: "group", title: "Admins", presentation: "conversation", items: [], actions: [{ id: "op", label: "Make operator", type: "form", confirmText: "Give operator privileges?", fields: [{ key: "input", label: "Player name", kind: "text", required: true }], params: { resource: "minecraft", group: "Admins" } }] });
    vi.mocked(invokeBotAction).mockResolvedValue({ screen: { screenId: "group", title: "Admins", presentation: "conversation", items: [], actions: [] } });
    render(<BotScreenRenderer botKey="controls" />);
    fireEvent.click(await screen.findByRole("button", { name: "Make operator" }));
    const form = screen.getByRole("dialog");
    fireEvent.change(within(form).getByRole("textbox"), { target: { value: "Alex" } });
    fireEvent.click(within(form).getByRole("button", { name: "Make operator" }));
    expect(invokeBotAction).not.toHaveBeenCalled();
    const confirm = await screen.findByRole("dialog");
    expect(within(confirm).getByText("Give operator privileges? (Alex)")).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole("button", { name: "Make operator" }));
    await waitFor(() => expect(invokeBotAction).toHaveBeenCalledWith("controls", "op", "group", { resource: "minecraft", group: "Admins", input: "Alex" }));
  });
});
