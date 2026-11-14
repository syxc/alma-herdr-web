import assert from "node:assert/strict"
import { test } from "node:test"
import { renderWorkspaceTree } from "../web/dist/workspace-tree.js"

function element() {
  const node = {
    children: [],
    dataset: {},
    attributes: {},
    textContent: "",
    className: "",
    classList: { contains: () => false, toggle() {}, add() {} },
    setAttribute(name, value) {
      this.attributes[name] = value
    },
    append(...items) {
      this.children.push(...items)
    },
    appendChild(item) {
      this.children.push(item)
    },
    replaceChildren(...items) {
      this.children = items
    },
    addEventListener() {},
  }
  node.ownerDocument = { createElement: () => element() }
  return node
}

function tree(snapshot) {
  const container = element()
  renderWorkspaceTree(container, {
    snapshot,
    selectedPaneId: null,
    onWorkspace() {},
    onTab() {},
    onPane() {},
  })
  const rows = []
  function walk(node) {
    if (typeof node.className === "string" && node.className.startsWith("row ")) rows.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(container)
  return rows
}

const longId = "hc:tb7a06ddb835c585a8957941151ee37f09"

test("tree tabs use consecutive numbers and never leak a core tab id", () => {
  const snapshot = {
    workspaces: [{ workspace_id: "w1", label: "pi-mono", tab_count: 3 }],
    tabs: [
      { tab_id: "t1", workspace_id: "w1", label: "1" },
      { tab_id: "t2", workspace_id: "w1", label: "2" },
      { tab_id: longId, workspace_id: "w1", label: "" },
    ],
    panes: [1, 2, 3].map((id) => ({
      pane_id: id === 3 ? longId : `p${id}`,
      workspace_id: "w1",
      tab_id: id === 3 ? longId : `t${id}`,
      terminal_title_stripped: "π - pi-mono",
      agent: "pi",
      agent_status: "idle",
    })),
  }
  const rows = tree(snapshot)
  const tabLabels = rows
    .filter((row) => row.className === "row tab")
    .map((row) => row.children[0].children[1].textContent)
  assert.deepEqual(tabLabels, ["1", "2", "3"])
  const text = rows.map((row) => row.title).join(" | ")
  assert.ok(!text.includes("hc:"), "the opaque core id must not appear in tree labels")
  assert.ok(!text.includes(longId.slice(0, 12)))
})

test("tree panes prefer readable names over opaque pane ids", () => {
  const snapshot = {
    workspaces: [{ workspace_id: "w1", label: "pi-mono", tab_count: 1 }],
    tabs: [{ tab_id: longId, workspace_id: "w1", label: "" }],
    panes: [
      {
        pane_id: longId,
        workspace_id: "w1",
        tab_id: longId,
        terminal_title_stripped: "",
        title: "",
        label: null,
        agent: null,
        agent_status: "idle",
      },
    ],
  }
  const rows = tree(snapshot)
  const pane = rows.find((row) => row.className === "row pane")
  assert.equal(pane.children[0].children[0].textContent, "Pane")
  assert.ok(!pane.title.includes("hc:"))
})
