import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, InputState, Input, VirtualListScrollHandle } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, layout, window, run, props, checking, shared, setShared, notify, nextCommand } from "herdr";

// Read-only git viewer with two tabs. Tree: every branch as a graph; picking a
// commit opens its files and diff underneath. Changes: the uncommitted files
// and their diff. It never writes to the repo.

const ROW = 26, LANE = 14, MAX_LANES = 12, LIMIT = 1500, DIFF_ROW = 20;
// A commit row, left to right: 3px edge, the graph, a gap, then the short hash in a box this wide.
const EDGE = 3, GAP = 6, HASH_W = 56;
const graphWidth = (c) => 16 + (c.width - 1) * LANE;
const WT = "WORKTREE";
// Diff colours as Claude Code's light colourblind-friendly theme draws them: added blue, removed red.
const ADD = "#24578a", ADD_BG = "#dbedff", DEL = "#a3211a", DEL_BG = "#ffdcdc";
// The empty tree: what a root commit is compared against.
const EMPTY = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// Reads write nothing under .git (no index refresh or lock), so the folder
// watch never sees its own refresh.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-c", "core.quotepath=false"];
const LOG_FORMAT = "--format=%H%x1f%P%x1f%D%x1f%an%x1f%at%x1f%s%x1e";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The repo shown is wherever the focused pane is, so it follows the space.
function location(pin) {
  // A layout can pin the panel to one folder: props { folder }.
  if (props()?.folder) return { cwd: props().folder, on: null };
  // Pinned to a space: wherever its first terminal is now, whatever is focused.
  const pinned = pin ? spaces().find((s) => s.id === pin) : null;
  if (pinned) {
    const tabs = pinned.tabs.map((x) => x.id), pane = panes().find((p) => tabs.includes(p.tab) && p.cwd);
    return { cwd: pane?.cwd || pinned.folder, on: pinned.machine ?? null };
  }
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

function parseStats(stdout) {
  const stats = {};
  for (const entry of stdout.split("\0")) {
    const [a, d, ...parts] = entry.split("\t");
    if (parts.length) stats[parts.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
  }
  return stats;
}

function parseRefs(text) {
  const refs = [];
  for (const raw of text.split(", ").map((s) => s.trim()).filter(Boolean)) {
    let name = raw, head = false;
    if (name.startsWith("HEAD -> ")) { head = true; name = name.slice(8); }
    if (name === "HEAD") { refs.push({ kind: "head", name: "HEAD" }); continue; }
    if (name.startsWith("tag: ")) { refs.push({ kind: "tag", name: name.slice(5).replace(/^refs\/tags\//, "") }); continue; }
    if (name.startsWith("refs/tags/")) { refs.push({ kind: "tag", name: name.slice(10) }); continue; }
    if (name.startsWith("refs/remotes/")) {
      name = name.slice(13);
      if (!name.endsWith("/HEAD")) refs.push({ kind: "remote", name });
      continue;
    }
    refs.push({ kind: head ? "head" : "local", name: name.replace(/^refs\/heads\//, "").replace(/^refs\//, "") });
  }
  const order = { head: 0, local: 1, tag: 2, remote: 3 };
  return refs.sort((a, b) => order[a.kind] - order[b.kind]);
}

function parseLog(stdout) {
  const commits = [];
  for (const record of stdout.split("\x1e")) {
    const f = record.replace(/^\s+/, "").split("\x1f");
    if (f.length < 6 || !f[0]) continue;
    commits.push({ hash: f[0], parents: f[1] ? f[1].split(" ") : [], refs: parseRefs(f[2]), author: f[3], time: Number(f[4]) * 1000, subject: f[5] });
  }
  return commits;
}

// Gives every commit a lane and the line pieces its row draws. `lanes[i]` is
// the commit that lane is waiting for, going down the list (newest first).
// Pieces: v = straight through, t = top half, b = bottom half, h = across at
// the middle, from `lane` to the commit's own.
function buildGraph(commits) {
  const lanes = [];
  let widest = 1;
  const free = () => { let i = lanes.indexOf(null); if (i < 0) { i = lanes.length; lanes.push(null); } return i; };
  for (const c of commits) {
    const mine = [];
    lanes.forEach((h, i) => { if (h === c.hash) mine.push(i); });
    const col = mine.length ? mine[0] : free();
    const segs = [];
    lanes.forEach((h, i) => { if (h !== null && h !== c.hash) segs.push({ k: "v", lane: i }); });
    if (mine.length) segs.push({ k: "t", lane: col });
    for (const i of mine.slice(1)) { segs.push({ k: "t", lane: i }, { k: "h", lane: i }); lanes[i] = null; }
    lanes[col] = c.parents[0] ?? null;
    if (c.parents.length) segs.push({ k: "b", lane: col });
    for (const p of c.parents.slice(1)) {
      let j = lanes.indexOf(p);
      if (j === col) continue;
      if (j < 0) { j = free(); lanes[j] = p; segs.push({ k: "b", lane: j }); }
      segs.push({ k: "h", lane: j });
    }
    widest = Math.max(widest, lanes.length);
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    c.col = col; c.segs = segs; c.width = Math.min(MAX_LANES, Math.max(col, ...segs.map((s) => s.lane)) + 1);
  }
  return Math.min(widest, MAX_LANES);
}

function ago(time) {
  if (!time) return "";
  const s = Math.max(0, (Date.now() - time) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  const d = new Date(time), pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function stamp(time) {
  if (!time) return "";
  const d = new Date(time), pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// One file list with one open diff: the Changes tab has one, a picked commit another.
const blank = () => ({ files: [], open: null, rows: [], diffWidth: 300, x: 0, cut: false });
// Columns a line takes in the mono font: CJK and full-width glyphs are two wide.
const columns = (text) => text.length + (text.match(/[⺀-鿿가-힯豈-﫿＀-｠]/g)?.length ?? 0);

export default class Git extends View {
  init(_props, cx) {
    this.commits = []; this.lanes = 1; this.root = null; this.width = 560;
    this.wt = blank(); this.picked = blank(); this.sel = null; this.body = []; this.token = 0;
    // The space this panel stays on; null follows whatever is focused.
    this.pin = null; this.menu = false;
    // Tree search: narrows the list to commits whose hash, subject, author or ref name matches.
    this.query = ""; this.handle = cx.focus_handle();
    this.search = InputState.new({ placeholder: "Search hash, message, author, branch" });
    this.logScroll = VirtualListScrollHandle.new();
    // Leaving a search puts the picked commit in the middle of the full list (see tree()).
    this.search.on("change", (_e, cx) => {
      const was = this.query.trim();
      this.query = this.search.value();
      if (was && !this.query.trim()) this.center = true;
      // Every new search starts from its first match.
      if (this.query.trim() && this.query.trim() !== was) this.top = true;
      cx.notify();
    });
    this.search.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.search.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    try { this.pin = localStorage.getItem("space") || null; } catch {}
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(15000, (cx) => { if (!this.hidden()) this.refresh(cx); });
    // From the tab bar's git keys: "focus" after opening, "key-tree" / "key-changes" while shown.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") { this.handle.focus(); cx.notify(); continue; }
        const want = command === "key-tree" ? "tree" : command === "key-changes" ? "changes" : null;
        if (!want) continue;
        // The key for the tab already shown, pressed while this column has the keyboard, closes it.
        if ((this.handle.is_focused() || this.typing) && this.tab === want) {
          run("layout.hide", { id: props()?.node ?? "git" });
          const pane = focused()?.pane;
          if (pane) run("pane.focus", { pane });
        } else { this.setTab(want, cx); this.handle.focus(); }
      }
    });
  }

  hidden() {
    return Boolean(find(layout(), props()?.node ?? "git")?.hidden);
  }

  clearSearch() {
    if (this.query.trim()) this.center = true;
    this.search.set_value(""); this.query = "";
  }

  key() {
    return JSON.stringify(location(this.pin));
  }

  setPin(id, cx) {
    this.pin = id; this.menu = false;
    try { if (id) localStorage.setItem("space", id); else localStorage.removeItem("space"); } catch {}
    this.refresh(cx);
    cx.notify();
  }

  // The list under the header: follow the focus, or stay on one space.
  spaceMenu(t) {
    const pinned = spaces().some((s) => s.id === this.pin) ? this.pin : null;
    const row = (id, name, detail) => {
      const on = id === pinned;
      return h_flex().id(`git-space-${id ?? "follow"}`).h(28).flex_none().px(10).gap(8).items_center().cursor_pointer()
        .border_l(3).border_color(on ? t.accent : "#00000000").when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.setPin(id, cx))
        .child(div().flex_none().max_w(220).truncate().child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(detail));
    };
    return v_flex().id("git-spaces").flex_none().max_h(260).overflow_y_scroll().py(4).bg(t.chrome).border_b(1).border_color(t.border)
      .child(row(null, "Follow focus", "the space and pane you are in"))
      .children(spaces().map((s) => row(s.id, s.name, [s.machine, s.branch].filter(Boolean).join(" · "))));
  }

  // Shared, so the tab bar's keys can pick the tab while this column is hidden.
  get tab() {
    return shared("ys-git.tab") === "changes" ? "changes" : "tree";
  }

  setTab(tab, cx) {
    setShared("ys-git.tab", tab);
    cx.notify();
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root && !this.hidden()) this.refresh(cx);
          else this.stale = true;
        }
      } catch { this.watched = null; }
    });
  }

  clear(error) {
    this.root = null; this.commits = []; this.wt = blank(); this.picked = blank(); this.sel = null;
    this.body = []; this.sig = null; this.watched = null; this.error = error;
  }

  refresh(cx) {
    if (this.loading) return;
    const { cwd, on } = location(this.pin), context = this.key();
    this.context = context; this.stale = false;
    if (!cwd) { this.clear("No folder"); return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (top.code !== 0) { this.clear("Not a git repository"); return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const hasHead = head.code === 0;
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const log = await git(["log", "--date-order", "--decorate=full", "-n", String(LIMIT), LOG_FORMAT, "--exclude=refs/stash", "--all", ...(hasHead ? ["HEAD"] : [])]);
        if (log.code !== 0) throw new Error(log.stderr);
        const numstat = hasHead ? await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"]) : { code: 0, stdout: "" };
        const sig = `${root}\n${log.stdout}\n${status.stdout}\n${numstat.stdout}`;
        if (sig === this.sig) return;
        if (root !== this.root) { this.sel = null; this.body = []; this.picked = blank(); this.wt = blank(); }

        const stats = parseStats(numstat.stdout), files = [];
        for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          files.push({ path, status: s, fresh, add: 0, del: 0, ...stats[path] });
        }
        const commits = parseLog(log.stdout);
        if (files.length) commits.unshift({ hash: WT, parents: hasHead ? [head.stdout.trim()] : [], refs: [], author: "", time: 0, subject: `Uncommitted changes (${files.length})` });
        this.lanes = buildGraph(commits);
        this.root = root; this.on = on; this.hasHead = hasHead; this.commits = commits; this.error = null; this.sig = sig;
        this.limited = commits.length >= LIMIT;
        this.watch(root, cx);

        if (this.sel && !commits.some((c) => c.hash === this.sel)) { this.sel = null; this.body = []; this.picked = blank(); }
        // The Changes tab keeps its open file while it still has changes, else shows the first.
        const wt = this.wt;
        wt.files = files;
        if (!files.some((f) => f.path === wt.open)) { wt.open = files[0]?.path ?? null; wt.rows = []; wt.cut = false; }
        if (wt.open) await this.loadDiff(wt, WT, wt.open);
      } catch (e) { this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  git(args) {
    return exec("git", [...READ, ...args], { cwd: this.root, on: this.on });
  }

  // A picked commit: its message, the files it changed against its first parent, the first file's diff.
  async loadCommit(hash) {
    const my = ++this.token, commit = this.commits.find((c) => c.hash === hash), view = blank();
    this.sel = hash; this.body = []; this.email = ""; this.note = null; this.picked = view;
    if (!commit) return;
    const base = commit.parents[0] ?? EMPTY;
    const meta = await this.git(["show", "-s", "--format=%ae%x1f%B", hash]);
    const names = await this.git(["diff", "--name-status", "-z", "--no-renames", base, hash]);
    const nums = await this.git(["diff", "--numstat", "-z", "--no-renames", base, hash]);
    if (my !== this.token) return;
    if (names.code !== 0) { this.note = (names.stderr || "Cannot read this commit").trim(); return; }
    const [email, ...rest] = meta.stdout.split("\x1f");
    this.email = email?.trim() ?? "";
    this.body = rest.join("\x1f").replace(/\s+$/, "").split("\n").slice(0, 200);
    const stats = parseStats(nums.stdout), tokens = names.stdout.split("\0").filter(Boolean);
    for (let i = 0; i + 1 < tokens.length && view.files.length < 1000; i += 2)
      view.files.push({ path: tokens[i + 1], status: tokens[i][0], add: 0, del: 0, ...stats[tokens[i + 1]] });
    if (view.files.length) await this.loadDiff(view, hash, view.files[0].path);
  }

  async loadDiff(view, hash, path) {
    const file = view.files.find((f) => f.path === path);
    if (!file) return;
    view.open = path;
    let lines;
    try {
      if (hash === WT && (file.fresh || (!this.hasHead && file.status === "A"))) {
        const text = await readTextFile(`${this.root}/${path}`, { on: this.on }).catch(() => null);
        if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
        else if (text.includes("\0")) lines = ["Binary file · no text diff"];
        else {
          file.add = countLines(text);
          lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").map((l) => `+${l}`)];
        }
      } else {
        const commit = this.commits.find((c) => c.hash === hash);
        const range = hash === WT ? (this.hasHead ? ["HEAD"] : []) : [commit?.parents[0] ?? EMPTY, hash];
        const r = await this.git(["diff", ...range, "--no-ext-diff", "--no-textconv", "--no-color", "--", path]);
        if (r.code !== 0) throw new Error(r.stderr);
        const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
        lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
      }
    } catch { lines = ["Cannot preview this diff (too large or unreadable)"]; }
    if (view.open !== path || (view !== this.wt && view !== this.picked)) return;
    view.cut = lines.length > 3000;
    view.rows = diffRows(lines.slice(0, 3000).map((line) => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
    view.diffWidth = Math.max(300, ...view.rows.map((row) => (columns(row.text) + 1) * 7 + 50));
    view.x = 0;
  }

  // Rows in a virtual list take no handlers of their own, so the list reports only which row.
  // The press before it (on the box around the list) says where: on the hash copies it,
  // anywhere else opens the commit.
  clickCommit(hash, cx) {
    const c = this.commits.find((x) => x.hash === hash), x = this.pressX;
    this.pressX = null;
    if (c && hash !== WT && typeof x === "number") {
      const from = EDGE + (this.query.trim() ? 16 : graphWidth(c)) + GAP;
      if (x >= from - 2 && x <= from + HASH_W) {
        const short = hash.slice(0, 7);
        cx.write_to_clipboard(short);
        notify({ title: `Copied ${short}`, timeout: 1500 });
        return;
      }
    }
    this.pickCommit(hash, cx);
  }

  pickCommit(hash, cx) {
    // The uncommitted row belongs to the other tab.
    if (hash === WT) { this.setTab("changes", cx); return; }
    if (hash === this.sel) return;
    cx.spawn(async (cx) => { await this.loadCommit(hash); cx.notify(); });
    cx.notify();
  }

  closeCommit(cx) {
    this.token++; this.sel = null; this.body = []; this.note = null; this.picked = blank();
    cx.notify();
  }

  pickFile(view, hash, path, cx) {
    if (path === view.open) return;
    view.open = path; view.rows = []; view.cut = false;
    cx.spawn(async (cx) => { await this.loadDiff(view, hash, path); cx.notify(); });
    cx.notify();
  }

  graph(c, t, palette, width) {
    const x = (lane) => 8 + lane * LANE, color = (lane) => palette[lane % palette.length], mid = ROW / 2;
    const el = div().w(width).h(ROW).flex_none().relative().overflow_hidden();
    for (const s of c.segs) {
      if (s.k === "h") {
        const a = Math.min(x(s.lane), x(c.col)), b = Math.max(x(s.lane), x(c.col));
        el.child(div().absolute().left(a - 1).top(mid - 1).w(b - a + 2).h(2).bg(color(s.lane)));
      } else {
        const top = s.k === "b" ? mid : 0, height = s.k === "v" ? ROW : mid;
        el.child(div().absolute().left(x(s.lane) - 1).top(top).w(2).h(height).bg(color(s.lane)));
      }
    }
    el.child(div().absolute().left(x(c.col) - 4).top(mid - 4).w(8).h(8).bg(c.hash === WT ? t.foreground : color(c.col)));
    if (c.hash === WT) el.child(div().absolute().left(x(c.col) - 2).top(mid - 2).w(4).h(4).bg(t.background));
    return el;
  }

  badge(ref, t) {
    const look = {
      head: [t.accent, t.accent, t.accent_foreground],
      local: [t.raised, t.input, t.foreground],
      tag: [t.background, t.ansi3, t.ansi3],
      remote: [t.background, t.border, t.muted],
    }[ref.kind];
    return div().flex_none().max_w(130).px(4).text_size(10.5).truncate().bg(look[0]).border_1().border_color(look[1]).text_color(look[2]).child(ref.name);
  }

  // Drawn inside the virtual list, where rows take no handlers: the list's on_item_click picks.
  commitRow(c, t, palette, width) {
    const on = c.hash === this.sel, extra = c.refs.length - 2;
    return h_flex().id(`commit-${c.hash}`).w_full().h(ROW).flex_none().gap(6).pr(12).items_center().cursor_pointer()
      .border_l(3).border_color(on ? t.accent : "#00000000").when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .child(this.graph(c, t, palette, width))
      .child(div().flex_none().w(HASH_W).text_size(11).font_family(settings().font_family ?? "JetBrains Mono").text_color(t.muted).child(c.hash === WT ? "" : c.hash.slice(0, 7)))
      .children(c.refs.slice(0, 2).map((r) => this.badge(r, t)))
      .when(extra > 0, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).child(`+${extra}`)))
      .child(div().flex_1().min_w(0).truncate().text_color(c.hash === WT ? t.working : t.foreground).child(c.subject || "(no message)"))
      .when(this.width >= 620 && Boolean(c.author), (e) => e.child(div().flex_none().w(110).truncate().text_size(11).text_color(t.muted).child(c.author)))
      .child(div().flex_none().w(72).text_right().text_size(11).text_color(t.dim).child(ago(c.time)));
  }

  fileRow(view, hash, f, t) {
    const parts = f.path.split("/"), name = parts.pop();
    const tone = f.status === "A" ? ADD : f.status === "D" || f.status === "U" ? DEL : t.working;
    return h_flex().id(`file-${f.path}`).h(26).flex_none().px(8).gap(8).items_center().cursor_pointer()
      .when(view.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.pickFile(view, hash, f.path, cx))
      .child(div().w(12).flex_none().text_size(11).text_color(tone).child(f.status))
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().flex_none().max_w(280).truncate().child(name)))
      .when(f.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(ADD).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(DEL).child(`−${f.del}`)));
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(DIFF_ROW).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(DIFF_ROW).flex_none().gap(10).when(kind === "+", (e) => e.bg(ADD_BG)).when(kind === "-", (e) => e.bg(DEL_BG))
      .child(div().w(34).flex_none().text_right().text_color(kind === "+" ? ADD : kind === "-" ? DEL : t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  header(t) {
    const w = window(), space = spaces().find((s) => s.active);
    const repo = this.root ? this.root.split(/[\\/]/).pop() : "";
    const head = this.commits.find((c) => c.refs.some((r) => r.kind === "head"))?.refs.find((r) => r.kind === "head")?.name ?? space?.branch ?? "";
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop).on_click(action).child(label);
    // The two tabs, drawn like the tab bar's panel buttons.
    const tab = (id, label, icon, count) => {
      const on = this.tab === id;
      return h_flex().id(`git-tab-${id}`).h(26).px(8).gap(5).flex_none().items_center().text_size(12)
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
        .on_mouse_down("left", stop).on_click((_e, cx) => this.setTab(id, cx))
        .child(svg(icon).size(14)).child(label)
        .when(count > 0, (e) => e.child(div().px(4).text_size(10.5).bg(t.accent).text_color(t.accent_foreground).child(String(count))));
    };
    return h_flex().h(42).flex_none().px(10).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(tab("tree", "Tree", "mods/workspace-chrome/git-branch.svg", 0))
      .child(tab("changes", "Changes", "mods/changes/changes.svg", this.wt.files.length))
      // Which repo: click to pick a space to stay on.
      .child(h_flex().id("git-space").flex_1().min_w(0).h(26).ml(6).px(6).gap(5).items_center().cursor_pointer().text_size(12)
        .bg(this.menu ? t.selected : t.chrome).text_color(t.muted).hover((s) => s.bg(t.hover))
        .on_mouse_down("left", stop).on_click((_e, cx) => { this.menu = !this.menu; cx.notify(); })
        .when(spaces().some((s) => s.id === this.pin), (e) => e.child(svg("mods/workspace-chrome/pin.svg").size(12).flex_none().text_color(t.foreground)))
        .child(div().min_w(0).truncate().child([repo, head].filter(Boolean).join(" · ") || "No repository"))
        .child(svg("mods/workspace-chrome/chevron-down.svg").size(12).flex_none()))
      .when(Boolean(this.loading), (e) => e.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.dim).spin(900)))
      .child(button("git-hide", svg("mods/workspace-chrome/panel-right.svg").size(15), () => { run("layout.hide", { id: props()?.node ?? "git" }); const pane = focused()?.pane; if (pane) run("pane.focus", { pane }); }))
      .when(Boolean(w?.buttons), (e) => e
        .child(button("git-minimize", w.platform === "windows" ? svg("mods/ys-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("git-maximize", w.platform === "windows" ? svg(`mods/ys-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("git-close", w.platform === "windows" ? svg("mods/ys-tabs/win-close.svg").size(16) : "×", () => run("window.close"))));
  }

  // Title, file count and totals above a file list; `extra` adds a commit's author and message.
  summary(view, title, t, close, extra) {
    const add = view.files.reduce((n, f) => n + f.add, 0), del = view.files.reduce((n, f) => n + f.del, 0);
    const box = v_flex().flex_none().px(12).py(8).gap(4).border_b(1).border_color(t.border).bg(t.chrome)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_none().font_semibold().child(title))
        .child(div().flex_none().px(5).border_1().border_color(t.border).text_size(10.5).text_color(t.muted).child(`${view.files.length} files`))
        .child(div().flex_1())
        .child(div().flex_none().text_size(11).text_color(ADD).child(`+${add}`))
        .child(div().flex_none().text_size(11).text_color(DEL).child(`−${del}`))
        .when(Boolean(close), (e) => e.child(div().id("git-close-commit").size(20).flex_none().flex().items_center().justify_center().text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.closeCommit(cx)).child(svg("mods/pane/close.svg").size(12)))));
    return extra ? extra(box) : box;
  }

  // A file list and the open file's diff, filling what is left.
  filesAndDiff(view, hash, name, t, empty) {
    const mono = settings().font_family ?? "JetBrains Mono";
    // Sideways position is kept here rather than in a scroll area around the list: the list
    // inside takes the wheel first, so a nested horizontal area never got the gesture.
    const wide = Math.max(view.diffWidth, this.width), max = Math.max(0, wide - this.width);
    const x = view.x = Math.min(Math.max(view.x ?? 0, 0), max);
    const wheel = (e, cx) => {
      const dx = e.delta?.x ?? 0, dy = e.delta?.y ?? 0, by = dx || (e.modifiers?.shift ? dy : 0);
      if (!by || (dx && Math.abs(dy) > Math.abs(dx))) return;
      cx.stop_propagation();
      const next = Math.min(Math.max(view.x - by, 0), max);
      if (next !== view.x) { view.x = next; cx.notify(); }
    };
    return [
      div().flex_1().min_h(44).max_h(view.files.length * 26 + 12).relative().border_b(1).border_color(t.border)
        .child(v_flex().id(`git-files-${name}`).absolute().inset_0().overflow_y_scroll().p(6).children(view.files.map((f) => this.fileRow(view, hash, f, t)))
          .when(!view.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(empty))))
        .child(Scrollbar.vertical(`git-files-${name}`).absolute().inset_0()),
      div().flex_1().min_h(0).relative().overflow_hidden().font_family(mono).text_size(11)
        .child(div().absolute().top(0).bottom(max > 0 ? 12 : 0).left(-x).w(wide).child(v_virtual_list(`git-diff-${name}`, view.rows.length, DIFF_ROW, (i) => String(i),
          (range) => view.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full()))
        .child(div().id(`git-diff-wheel-${name}`).absolute().inset_0().on_scroll_wheel(wheel))
        .child(Scrollbar.vertical(`git-diff-${name}`).viewport_from_layout().absolute().inset_0())
        // The sideways bar: press the track to jump there, then drag (the root follows the pointer).
        .when(max > 0 && this.width > 0, (e) => e.child(div().id(`git-diff-bar-${name}`).absolute().bottom(0).left(0).right(0).h(12).bg(t.chrome).border_t(1).border_color(t.border)
          .on_mouse_down("left", (ev, cx) => {
            const w = this.width, thumb = w * w / wide, at = ev?.local_position?.x;
            if (typeof at === "number" && (at < view.x / wide * w || at > view.x / wide * w + thumb)) view.x = Math.min(Math.max((at - thumb / 2) / w * wide, 0), max);
            this.drag = { view, from: ev.position.x, x0: view.x, scale: wide / w, max };
            cx.stop_propagation(); cx.notify();
          })
          .child(div().absolute().top(2).bottom(2).left(x / wide * this.width).w(this.width / wide * this.width).bg(this.drag?.view === view ? t.muted : t.dim))))
        .when(Boolean(view.cut), (e) => e.child(div().absolute().bottom(max > 0 ? 12 : 0).right(14).px(6).bg(t.raised).text_color(t.dim).child("First 3,000 lines"))),
    ];
  }

  tree(t) {
    // The marks the yuansui sidebar gives spaces (ys-spaces MARK), so lanes read as the same set.
    const palette = ["#22a99a", "#e3814f", "#5b8def", "#8b7cf6", "#3fae6a", "#d9649a"];
    const empty = this.error || (this.loading ? "Loading…" : this.root ? "No commits yet" : "No folder");
    const c = this.sel ? this.commits.find((x) => x.hash === this.sel) : null;
    const q = this.query.trim().toLowerCase(), has = (s) => (s ?? "").toLowerCase().includes(q);
    // While searching, rows are matches only, so the lines between them are left out.
    const list = q ? this.commits.filter((x) => x.hash !== WT && (x.hash.startsWith(q) || has(x.subject) || has(x.author) || x.refs.some((r) => has(r.name)))) : this.commits;
    const stop = (_e, cx) => cx.stop_propagation();
    if (q && this.top) {
      this.top = false;
      if (list.length) this.logScroll.scroll_to_item(0, "top");
    }
    if (!q && this.center) {
      this.center = false;
      const at = this.sel ? this.commits.findIndex((x) => x.hash === this.sel) : -1;
      if (at >= 0) this.logScroll.scroll_to_item(at, "center");
    }
    return v_flex().flex_1().min_h(0)
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
        .child(svg("mods/workspace-chrome/search.svg").size(13).flex_none().text_color(t.dim))
        .child(div().id("git-search").flex_1().min_w(0).h(24).px(8).flex().items_center().bg(t.raised).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
          .on_mouse_down("left", stop).child(Input.new(this.search).h_full().text_size(12).text_color(t.foreground)))
        .when(Boolean(q), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(`${list.length} found`))
          .child(div().id("git-search-clear").size(20).flex_none().flex().items_center().justify_center().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", stop).on_click((_e, cx) => { this.clearSearch(); cx.notify(); }).child(svg("mods/pane/close.svg").size(12)))))
      .child(div().id("git-log-box").flex_1().min_h(0).relative()
        .on_mouse_down("left", (e) => { const x = e?.local_position?.x; this.pressX = typeof x === "number" ? x : null; })
        .child(div().absolute().inset_0().child(v_virtual_list("git-log", list.length, ROW, (i) => list[i]?.hash ?? String(i),
          (range) => list.slice(range.start, range.end).map((x) => {
            try { return q ? this.commitRow({ ...x, segs: [], col: 0 }, t, palette, 16) : this.commitRow(x, t, palette, graphWidth(x)); }
            catch (e) { return div().h(ROW).px(12).truncate().text_color(t.ansi1).child(String(e)); }
          })).on_item_click((hash, cx) => this.clickCommit(hash, cx)).track_scroll(this.logScroll).size_full()))
        .child(Scrollbar.vertical("git-log").viewport_from_layout().absolute().inset_0())
        .when(!list.length, (e) => e.child(div().absolute().top(10).px(14).text_color(t.dim).child(q ? "No commit matches" : empty))))
      .when(Boolean(this.limited), (e) => e.child(div().flex_none().px(12).py(3).text_size(11).text_color(t.dim).border_t(1).border_color(t.border).child(`Showing the newest ${LIMIT} commits`)))
      // Only once a commit is picked: who and what, its files, and one file's diff.
      .when(Boolean(c), (e) => e.child(v_flex().flex_1().min_h(0).border_t(1).border_color(t.border)
        .child(this.summary(this.picked, c.hash.slice(0, 8), t, true, (box) => box
          .child(div().truncate().text_size(11.5).text_color(t.muted).child(`${c.author}${this.email ? ` <${this.email}>` : ""} · ${stamp(c.time)}`))
          .child(v_flex().id("git-body").max_h(96).overflow_y_scroll().text_size(12).children(
            (this.body.length ? this.body : [c.subject]).map((line) => div().flex_none().child(line || " "))))))
        .when(Boolean(this.note), (el) => el.child(div().flex_none().px(12).py(6).text_size(11).text_color(t.ansi1).child(this.note)))
        .children(this.filesAndDiff(this.picked, c.hash, "commit", t, "No file changes"))));
  }

  changes(t) {
    const empty = this.error || (this.loading && !this.root ? "Loading…" : this.root ? "No uncommitted changes" : "No folder");
    return v_flex().flex_1().min_h(0)
      .child(this.summary(this.wt, "Uncommitted changes", t, false))
      .children(this.filesAndDiff(this.wt, WT, "wt", t, empty));
  }

  render(cx) {
    const t = theme();
    if (!this.hidden() && !this.loading && (this.key() !== this.context || this.stale)) this.refresh(cx);
    return v_flex().id("ys-git").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12.8)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); } })
      // A click gives the panel the keyboard, so Ctrl+F reaches it: search the tree. Escape clears.
      .track_focus(this.handle).on_mouse_down("left", () => this.handle.focus())
      .on_mouse_move((e, cx) => {
        const d = this.drag;
        if (!d) return;
        const next = Math.min(Math.max(d.x0 + (e.position.x - d.from) * d.scale, 0), d.max);
        if (next !== d.view.x) { d.view.x = next; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => { if (this.drag) { this.drag = null; cx.notify(); } })
      .on_key_down((e, cx) => {
        if (e.key === "f" && e.modifiers?.control) { if (this.tab !== "tree") this.setTab("tree", cx); this.search.focus(); cx.stop_propagation(); }
        else if (e.key === "escape" && (this.typing || this.query)) { this.clearSearch(); this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(this.header(t))
      .when(this.menu, (e) => e.child(this.spaceMenu(t)))
      .child(this.tab === "changes" ? this.changes(t) : this.tree(t));
  }
}
