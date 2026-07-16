import { describe, expect, test } from "bun:test";
import { runAgentBatch, type AgentAdapter } from "../agent-runner";

function tree(label: string, id: string) {
  return [{
    type: "Application",
    frame: { x: 0, y: 0, width: 402, height: 874 },
    children: [{
      type: "Button",
      AXLabel: label,
      AXUniqueId: id,
      enabled: true,
      frame: { x: 20, y: 100, width: 200, height: 50 },
      children: [],
    }],
  }];
}

function nestedLabelTree() {
  return [{
    type: "Application",
    frame: { x: 0, y: 0, width: 402, height: 874 },
    children: [{
      type: "Button",
      enabled: true,
      frame: { x: 20, y: 100, width: 200, height: 50 },
      children: [{
        type: "StaticText",
        AXLabel: "Continue",
        frame: { x: 70, y: 110, width: 100, height: 30 },
        children: [],
      }],
    }],
  }];
}

function adapter(screens: unknown[]) {
  let index = 0;
  let describes = 0;
  const actions: string[] = [];
  const value: AgentAdapter = {
    describe: async () => {
      describes++;
      return { tree: screens[index]!, frameGeneration: index + 1 };
    },
    screenshot: () => Buffer.from("jpeg"),
    tap: async (x, y) => {
      actions.push(`tap:${x.toFixed(3)},${y.toFixed(3)}`);
      index = Math.min(index + 1, screens.length - 1);
    },
    swipe: async () => { actions.push("swipe"); },
    scroll: async () => { actions.push("scroll"); },
    multiTouch: async () => { actions.push("multiTouch"); },
    type: async (text) => { actions.push(`type:${text}`); },
    button: async (name) => { actions.push(`button:${name}`); },
    settle: async () => {},
  };
  return { value, actions, describeCount: () => describes };
}

describe("agent batch runner", () => {
  test("resolves selectors immediately before every action and returns only the final snapshot", async () => {
    const fake = adapter([
      tree("Cards", "cards"),
      tree("First card", "first-card"),
      tree("Card details", "card-details"),
    ]);

    const result = await runAgentBatch(fake.value, [
      { tap: { label: "Cards" }, until: { id: "first-card" } },
      { tap: { label: "First card" }, until: { id: "card-details" } },
      { snapshot: { interactive: true } },
    ]);

    expect(result).toEqual({
      ok: true,
      completed: 3,
      snapshot: expect.stringContaining('button "Card details" id="card-details"'),
    });
    expect(fake.actions).toEqual(["tap:0.299,0.143", "tap:0.299,0.143"]);
    expect(fake.describeCount()).toBe(3);
  });

  test("fails fast with the failing step, current snapshot, screenshot, and timings", async () => {
    const fake = adapter([tree("Cards", "cards"), tree("Home", "home")]);

    const result = await runAgentBatch(fake.value, [
      { tap: { label: "Cards" }, until: { id: "home" } },
      { tap: { label: "Missing" } },
      { button: { name: "home" } },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.completed).toBe(1);
    expect(result.failedStep).toBe(1);
    expect(result.error).toContain("Missing");
    expect(result.snapshot).toContain('button "Home" id="home"');
    expect(result.screenshot).toBe(Buffer.from("jpeg").toString("base64"));
    expect(result.timings).toHaveLength(2);
    expect(fake.actions).toEqual(["tap:0.299,0.143"]);
  });

  test("maps a semantic child label to its actionable parent", async () => {
    const fake = adapter([nestedLabelTree()]);

    const result = await runAgentBatch(fake.value, [{ tap: { label: "Continue" } }]);

    expect(result.ok).toBe(true);
    expect(fake.actions).toEqual(["tap:0.299,0.143"]);
  });
});
