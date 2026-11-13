import assert from "node:assert/strict"
import { test } from "node:test"
import { DetailScreen } from "../web/dist/detail.js"
import { renderSessionList } from "../web/dist/session-list.js"

function element() {
  return {
    children: [],
    dataset: {},
    textContent: "",
    className: "",
    classList: { contains: () => true },
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
}

function environment(t) {
  for (const name of ["window", "document"]) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    })
  }
  globalThis.window = { localStorage: { getItem: () => null } }
  globalThis.document = { createElement: element }
  const view = Object.create(DetailScreen.prototype)
  Object.assign(view, {
    actions: {},
    inputPaneId: null,
    input: { setEnabled() {}, reset() {} },
    keyToolbar: { setEnabled() {}, reset() {} },
    commandInput: {},
    commandSend: {},
    keyboardToggle: {},
    tabNumber: element(),
    detailStatus: element(),
    detailTitle: element(),
    detailDot: element(),
    actionMenu: element(),
  })
  return view
}

function fixture() {
  const panes = [1, 2, 3, 5, 6, 7].map((id) => ({
    pane_id: `p${id}`,
    tab_id: `t${id}`,
    workspace_id: "w1",
    agent: id === 7 ? "pi" : null,
    agent_status: id === 7 ? "working" : "unknown",
    cwd: "/project",
    terminal_title_stripped: "",
  }))
  return {
    workspaces: [{ workspace_id: "w1", label: "Project" }],
    tabs: panes.map((pane) => ({ tab_id: pane.tab_id, workspace_id: "w1", number: Number(pane.tab_id.slice(1)) })),
    panes,
  }
}

function renderedNumbers(view, state, pane) {
  const list = element()
  renderSessionList(list, { snapshot: state, selectedPaneId: pane.pane_id, onPick() {} })
  const row = list.children.find((node) => node.dataset.pane === pane.pane_id)
  view.update(state, pane)
  return [row.children[0].children[0].textContent, view.tabNumber.textContent]
}

test("list and header share consecutive numbers despite backend tab gaps", (t) => {
  const view = environment(t)
  const state = fixture()
  for (const [index, pane] of state.panes.entries()) {
    assert.deepEqual(renderedNumbers(view, state, pane), [String(index + 1), String(index + 1)])
  }
})

test("exiting pi and refreshing backend tab metadata cannot change the displayed number", (t) => {
  const view = environment(t)
  const state = fixture()
  const pane = state.panes.at(-1)
  state.tabs.at(-1).number = 6
  assert.deepEqual(renderedNumbers(view, state, pane), ["6", "6"])
  const after = {
    ...state,
    tabs: state.tabs.map((tab) => ({ ...tab, number: Number(tab.tab_id.slice(1)) })),
    panes: state.panes.map((entry) =>
      entry.pane_id === pane.pane_id ? { ...entry, agent: null, agent_status: "unknown" } : entry,
    ),
  }
  assert.deepEqual(renderedNumbers(view, after, after.panes.at(-1)), ["6", "6"])
})

test("same-number core terminals show their machine beside the directory", (t) => {
  environment(t)
  const state = fixture()
  state.panes = ["hc:t1", "hc:vps/t1"].map((pane_id) => ({ ...state.panes[0], pane_id }))
  const list = element()
  renderSessionList(list, { snapshot: state, selectedPaneId: "hc:vps/t1", onPick() {} })
  const rows = list.children.filter((node) => node.dataset.pane)
  assert.deepEqual(
    rows.map((row) => row.title),
    ["This computer · /project", "vps · /project"],
  )
  assert.deepEqual(
    rows.map((row) => row.dataset.pane),
    ["hc:t1", "hc:vps/t1"],
  )
  assert.match(rows[1].className, /selected/)
})

test("split panes and multiple workspaces retain the same global numbering", (t) => {
  const view = environment(t)
  const state = fixture()
  state.panes = [
    { ...state.panes[0], workspace_id: "w1", tab_id: "t1" },
    { ...state.panes[1], workspace_id: "w1", tab_id: "t1" },
    { ...state.panes[2], workspace_id: "w2", tab_id: "t2" },
  ]
  state.tabs = [
    { tab_id: "t1", number: 1 },
    { tab_id: "t2", number: 1 },
  ]
  for (const [index, pane] of state.panes.entries()) {
    assert.deepEqual(renderedNumbers(view, state, pane), [String(index + 1), String(index + 1)])
  }
})
