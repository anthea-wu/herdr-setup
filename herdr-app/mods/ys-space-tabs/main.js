// Every space's tabs, grouped under the space, for the sidebar. Click a group to fold it,
// click a tab to show it. The dot after a tab is its most urgent agent status.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, run, theme, shared, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Same rule as the shipped sidebar mods: below 160px the sidebar is a rail.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// The avatar colors the shipped spaces mod stores in shared("space.colors").
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

const tone = (t, status) => t[status] ?? t.unknown;

// Section divider from the blog: a sparse dashed line (6px dash, 10px gap).
const dash = (t) => h_flex().h(1).flex_none().mx(16).gap(10).overflow_hidden()
  .children(Array.from({ length: 32 }, () => div().w(6).h(1).flex_none().bg(t.foreground + "4d")));
const FOLDED = "space-tabs.folded";

// Tab labels follow the shipped agents mod: an unnamed tab reads as its lead terminal's
// live title ("OC | Jira SEALMS-222"), a named one keeps its name.
// Drops what an agent puts before its title: a status glyph or spinner and the separator after it.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

// Per tab: its first agent, else its focused terminal, else its first terminal.
function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

function label(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  // A bare path or user@host says nothing a folder doesn't.
  const path = /^[~/]|^[A-Za-z]:\\/.test((l?.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== l?.terminal && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}

export default class SpaceTabs extends View {
  init() {
    try { this.folded = new Set(JSON.parse(localStorage.getItem(FOLDED) ?? "[]")); } catch { this.folded = new Set(); }
    this.scroll = ScrollHandle.new();
    this.revealed = null;
  }

  toggle(id, cx) {
    if (this.folded.has(id)) this.folded.delete(id);
    else this.folded.add(id);
    const alive = new Set(spaces().map((s) => s.id));
    localStorage.setItem(FOLDED, JSON.stringify([...this.folded].filter((f) => alive.has(f))));
    cx.notify();
  }

  show(space, tab) {
    if (!space.active) run("space.select", { id: space.id });
    run("tab.select", { id: tab.id });
  }

  tabRow(space, tab, last, t, leads) {
    const on = space.active && tab.active;
    const name = label(tab, leads.get(tab.id));
    return h_flex()
      .id(`space-tab-${tab.id}`)
      .h(26)
      .flex_none()
      .pl(11)
      .pr(8)
      .gap(6)
      .items_center()
      .border_l(3)
      .border_color(on ? t.accent : "#00000000")
      .cursor_pointer()
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .tooltip(name)
      .on_click(() => this.show(space, tab))
      .child(div().flex_none().text_color(t.dim).child(last ? "└─" : "├─"))
      .child(div().flex_1().min_w(0).truncate()
        .text_color(on ? t.foreground : tab.settled ? t.dim : t.muted)
        .child(name))
      .when(Boolean(tab.status), (el) => el.child(div().size(6).flex_none().bg(tone(t, tab.status))));
  }

  group(space, tabs, t, colors, leads) {
    const folded = this.folded.has(space.id);
    const color = colors[space.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    const head = h_flex()
      .id(`space-tabs-${space.id}`)
      .h(28)
      .flex_none()
      .px(8)
      .gap(8)
      .items_center()
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.toggle(space.id, cx))
      .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none().text_color(t.dim))
      .child(h_flex().size(16).flex_none().bg(fill).items_center().justify_center()
        .text_size(9.5).font_bold().text_color("#ffffff")
        .child([...space.name][0]?.toUpperCase() ?? "?"))
      .child(div().flex_1().min_w(0).truncate().text_color(space.active ? t.foreground : t.muted).child(space.name))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(String(tabs.length)));
    if (folded) return [head];
    return [head, ...tabs.map((tab, i) => this.tabRow(space, tab, i === tabs.length - 1, t, leads))];
  }

  render() {
    const t = theme();
    if (narrow()) return v_flex().size_full().bg(t.chrome);
    const colors = shared("space.colors") ?? {};
    // One read: every panes() call copies the whole list.
    const leads = leadPanes(panes());
    const rows = [];
    let activeAt = -1;
    for (const space of spaces()) {
      // Only tabs with an agent in them: a bare shell tab would read as its number.
      const tabs = space.tabs.filter((tab) => leads.get(tab.id)?.program?.agent || tab.status);
      const group = this.group(space, tabs, t, colors, leads);
      if (space.active && !this.folded.has(space.id)) {
        const i = tabs.findIndex((tab) => tab.active);
        if (i >= 0) activeAt = rows.length + 1 + i;
      }
      rows.push(...group);
    }
    // Bring the shown tab into view when it, or its place in the list, changes.
    const shown = `${activeAt}:${spaces().find((s) => s.active)?.tabs.find((tab) => tab.active)?.id ?? ""}`;
    if (shown !== this.revealed) {
      this.revealed = shown;
      if (activeAt >= 0) this.scroll.scroll_to_item(activeAt);
    }
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(dash(t))
      .child(h_flex().h(31).flex_none().pl(16).pr(10).items_center().text_size(11).text_color(t.muted).child("TABS"))
      .child(v_flex().id("space-tabs-list").flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
        .track_scroll(this.scroll)
        .children(rows));
  }
}
