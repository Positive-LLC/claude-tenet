# Tenet v2 升級計畫：從 Deno CLI 演進為 Claude Plugin

本文件記錄 claude-tenet 從 v1（Deno binary + dual-SDK relay + boolean coverage）升級到 v2（Claude Plugin + tmux + worktree + Wave model + 雙 mode + ComponentStatus 四態）的計畫。靈感來自 [agent-tdd](../../willy/agent-tdd/)（同作者另一個針對程式碼專案的 TDD plugin），但 tenet 保持其核心定位：**對 markdown-based Claude agent 專案做對抗性測試**。

> 起草日期：2026-05-01。文件目的是 3 個月後仍能 cold-read 理解前因後果。

---

## 0. 指導原則（決策的最高優先級）

這個工具目前只有作者自己在用、沒有外部使用者。整份計畫由以下三條原則統馭，所有設計選擇都優先服從這些原則：

1. **第一也是唯一目標：把工具做好、做乾淨、做 future-proof。** 不做「能跑就好」的妥協。
2. **不需要擔心 breaking change。** 整個 Deno CLI 在 v2 完成時會被刪除，沒有外部使用者要遷移。可以做 clean break。
3. **不必偏向「最少改動」「最保守」的選項。** 當「保守 vs 乾淨」二選一時，選乾淨。當「漸進演化 vs 重新設計」二選一時，選重新設計。

下文當有「保留 v1 行為」「先用 X 再說」「為 backward compat」這類念頭出現時，**回到這節重讀**。

---

## 1. Locked-in 決策（不再討論）

| # | 決策 | 含義 |
|---|---|---|
| **D1** | **載體換成 Claude Plugin。Deno CLI 整個拿掉。** | 沒有 `tenet` binary、沒有 `deno task start`。User 在 Claude Code 裡輸入 `/tenet:integration <spec>` 或 `/tenet:unit <spec>` 啟動。`src/`、`deno.json`、`deno.lock`、`Makefile`、`install.sh` 在 v2 完成時整批刪除。 |
| **D2** | **GitHub 是必要依賴。** | `gh` CLI required。Mission 開成 GitHub issue（labelled），coverage / wave 結果以 issue / PR / label 為 source of truth。沒 GitHub remote 的 target 不在支援範圍。 |
| **D3** | **Wave 平行是 feature，不是 opt-in。** | Spec 討論階段就和 user 對齊「這個 Wave 跑幾個 mission」。1×1 sequential 是退化情況、不是預設。 |
| **D4** | **Bypass permissions 維持。** | 子 agent 仍以 `--permission-mode bypassPermissions` 啟動。v2 不為此議題改設計，未來再評估。 |
| **D5** | **Integration 與 Unit 是兩個平行的 Claude Skill。** | `/tenet:integration <spec>`（整個專案載入、components 互動式測試）和 `/tenet:unit <spec>`（per-component 隔離測試）是兩個獨立的 user-invocable skill，各有自己的 SKILL.md。共享基礎建設（PROTOCOL、roles、recipes、templates）放在 plugin 根目錄，由兩個 skill 共同引用。 |
| **D6** | **ComponentStatus 四態 first-class。** | Coverage 模型是 `untested / pass / proceed / fail` 四態 enum，不是 boolean covered。狀態 promotion（`proceed` → `pass`）由 mission planner 的 LLM call 在 wave 邊界判定 — 它看完 wave 內所有 BlueTeamReport 後決定是否升級。沒有「測過 = 通過」這種偷懶語意。 |
| **D7** | **Analysis-only Blue + Centralized Fix Phase。** | Blue Analyst 在 mission worktree 裡只跑 read-only 工具（Read/Glob/Grep），輸出 `proposedFixes[]`。Wave 末由 Tenet（在 Root worktree 裡）執行單一 Fix Phase：collect → dedup（依 file+issueId 等價 + 描述相似度）→ priority sort → 一次性套用全部 fix → commit。Blue 不直接改檔，避免多 worker 平行時的競爭與重複工。 |
| **D8** | **Clean break，不為 v1 留後路。** | 沒有 `--legacy` flag、沒有 deprecated fields、沒有 boolean `covered` 並存於 `ComponentStatus` 之類的雙軌。v1 schemas（含 `BlueTeamReport.fixesApplied`、`CoverageStatus.covered`）在 v2 直接刪除。 |

---

## 2. v2 架構總覽

### 2.1 角色

v2 共 **6 個角色**，分工比 v1（紅藍兩隊）細：

| 角色 | 何時出現 | 職責 | 載體 |
|---|---|---|---|
| **Tenet (Root)** | 整個 run 全程 | Wave 0 spec 討論、wave 編排、coverage 維護、Fix Phase 執行、Gate 1/2 驅動、escalation、終局整合 | **User 自己的 Claude session**（user 在 terminal 跑 `/tenet:integration` 或 `/tenet:unit` 的那個 session）。Tenet 不被「spawn」— 它就是 user 的 interactive 視窗，從 `meta.json:tenet_session` 讀出 tmux session 名 |
| **Ownership Analyzer** | **Unit mode** 限定，pre-Wave 1 一次性 | 用 LLM 分析 inventory，產出每個 component 的擁有者（哪個 agent 會 invoke 它）+ 相依清單（隔離測試需要哪些 sibling 才能跑）。輸出寫進 `.tenet/<run-id>/ownership.json` | 一次性 `claude -p` |
| **Red Mission** | 每個 wave 的每個 mission | 跑 attacker↔target 對話 relay，產出 session JSONL + 對話摘要 + `.done`/`.failed`/`.aborted` 狀態檔。**Red Mission 是 shell recipe + 兩個 `claude` 子 session（attacker、target），不是單一 LLM agent** — 見 §6 Q1 | 一個 `recipes/run-red-mission.sh` 在 mission worktree 的 tmux window 裡 driver attacker pane 和 target pane |
| **Blue Analyst** | 每個 mission Red 收尾後 | 讀 session JSONL → 診斷 issue → 輸出 `BlueTeamReport`（含 `proposedFixes[]`，不直接改檔）→ 寫狀態檔 | mission worktree 的 tmux window 內 `claude -p` fire-and-forget |
| **Fix Agent** | 每個 wave 末，Gate 1 完成後 | 收集當前 wave 全部 `proposedFixes[]` → dedup → 套用 → commit。**這是 Tenet 自己在 Root worktree 跑的單一 SDK call**，不是另一個 spawned child（節省 token、避免一層多餘的 hand-off） | Tenet 自己（不另開 agent） |
| **Rebase Agent** | Gate 2 機械衝突時 | Wave 末多個 fix branch 合回 wave root 衝突的 mechanical 解（語意衝突直接升級給 user） | 一次性 `claude -p` |

**鐵律**（沿用 agent-tdd Hard Invariants 精神）：
- Tenet 是唯一的 human interface。其他角色不直接和 user 對話。
- 沒有 decision 只活在對話記憶裡。一切寫進 `.tenet/<run-id>/` 和 GitHub label。
- Single-mission / single-PR：每個 mission 對應一個 Blue Analyst session，最多一個 PR。
- 每個 wave-phase 邊界 Tenet 重讀 PROTOCOL.md + 當前 wave manifest + status dir。

### 2.2 兩個 Wave Lifecycle

兩個 mode 的 Wave 0 和 Wave Initiation 大同小異，差別在 **Unit mode 多了 pre-Wave 1 的 Ownership 分析**，以及 **每個 mission 的環境準備**（Integration 是 worktree、Unit 是 worktree + throwaway-commit strip）。

#### 2.2.1 Integration mode（`/tenet:integration <spec>`）

```
Wave 0（互動）
  └─ Tenet 掃 target → 列出 components → 和 user 商量 Wave 編排
     （哪些 component 是 Wave 1、哪些 Wave 2、每 wave 並行幾個 mission）
     user 說 "go" → 進 autopilot

Wave N（autopilot）
  ├─ Wave initiation
  │   ├─ Tenet 重讀 PROTOCOL.md + 各 role markdown
  │   ├─ planIteration() 一次 LLM call 生 N 個 mission（diversity 由 LLM 自己分配 attack 角度）
  │   ├─ 為每個 mission 開 GitHub issue（labelled）+ 寫 wave-N/manifest.json
  │   ├─ 為每個 mission 建 worktree（基於 wave root branch）+ 開 tmux window
  │   ├─ 在每個 mission worktree 啟 Red Mission recipe（attacker + target relay）
  │   └─ 一次性以 background Bash 起 wave-watcher，idle 等狀態檔
  │
  ├─ Gate 1: agent-terminal
  │   每個 mission 在 wave-N/status/ 出現一個 terminal 狀態檔
  │   （.done / .failed / .aborted / .crashed）
  │   注意：Red 不寫狀態檔。run-red-mission.sh 偵測 Red 終止後在同 worktree
  │   啟 Blue Analyst（read-only），Blue 寫 BlueTeamReport.json + 寫
  │   terminal 狀態檔。wave-watcher 只看 Blue 寫的這一份。詳見 §2.5.2。
  │
  ├─ Fix Phase（Tenet 自跑，Gate 1 完成後）
  │   ├─ 從 wave-N/results/*.report.json 收集所有 proposedFixes[]
  │   ├─ Dedup（file+issueId 等價、描述相似度）+ severity sort
  │   ├─ 在 Root worktree 用一次性 SDK call 套全部 fix → commit
  │   └─ Status promotion：planIteration 下次 call 時看歷史，把 proceed → pass
  │
  └─ Gate 2: wave-merged
      Tenet 把 wave root branch fix commit 推到 origin
      （wave 內沒有 per-mission PR — fix 全集中在 Fix Phase 一次 commit）

下一 Wave 的 mission 從何而來？
  - Wave 1：Wave 0 spec 討論
  - Wave 2+：planIteration 從 coverage state 挑（fail > proceed > untested > pass）
            + Blue Analyst 在當前 wave 發現的 backlog（labelled tenet:pending）
```

#### 2.2.2 Unit mode（`/tenet:unit <spec>`）

```
Wave 0（互動）
  └─ 同 integration

Pre-Wave 1（一次性，autopilot）
  └─ Ownership Analyzer 一次 LLM call：
     輸入：完整 inventory
     輸出：每個 tool component（skill/command/hook/knowledge/other_md）的
          { ownerComponentId, componentsToCopy[], reasoning }
          → 寫 .tenet/<run-id>/ownership.json
     （claude_md 與 agent 是 self-owned 不需分析；mcp_server 跳過不能 unit test）

Wave N（autopilot）
  ├─ Wave initiation
  │   ├─ Tenet 重讀 PROTOCOL + roles + ownership.json
  │   ├─ planIteration() 生 N 個 mission，每個 mission 鎖定一個 component
  │   ├─ 為每個 mission 建 sandbox worktree（見下）
  │   ├─ 啟 Red Mission（attacker + target，target 的 cwd 是 sandbox worktree）
  │   │   target 的 system prompt 是 component 擁有者的 .md（從 ownership 查）
  │   └─ wave-watcher
  │
  ├─ Gate 1 + Fix Phase + Gate 2 同 integration
```

**Wave 0 vs ownership 的順序**：user 在 Wave 0 鎖定的 wave 計畫，可能會在 Pre-Wave 1 ownership 分析後被微調 — 例如 user 把 c1 / c2 排在 Wave 1 並行，但 ownership 顯示兩者共用同一 owner agent、隔離測試會互擾。Tenet 在 Wave 1 啟動前**一定要回頭和 user 確認調整方案，不靜默重排**。

**Sandbox worktree 的做法（Q4 = Option C）：**
1. `git worktree add .tenet/<run-id>/sandboxes/<mission-id> -b sandbox/<mission-id> <wave-root>`
2. 在這個 worktree 裡做一個 throwaway commit：`git rm` 掉所有不在 `componentsToCopy[]` 列表的檔案，留下 target component + dependencies + `settings.json`。**這個 commit 永不 push、永不 merge。**
3. Red Mission 跑在這個被 strip 過的 worktree 上 — target agent 只看得到 minimal 環境
4. Blue Analyst 讀 session JSONL 時知道 sandbox 路徑前綴；產 `proposedFixes[]` 時 `targetFilePath` 一律指向 **原始 repo path**（不是 sandbox 內路徑）— 這個 path 轉換在 Blue 的 role markdown 裡寫死
5. Wave 末 Fix Phase 在 Root worktree（完整 repo）套 fix
6. Wave 結束 `wave-end-cleanup.sh` 直接 `git worktree remove --force` + `git branch -D sandbox/<mission-id>`，throwaway 連同消失

這個做法 vs v1 的 file copy（`.tenet-sandbox-<id>/`）：worktree 是 cheap link，throwaway commit 沒污染、隔離乾淨；不需要 `syncFixesBack()` 因為 fix phase 直接寫原 repo。

### 2.3 Git 分支拓樸

```
main
└── tenet/<run-task>                ← Wave root branch（v2 整個 run 的整合分支）
    │   每個 wave 由 Fix Phase 直接 commit 進來，不開 per-mission PR
    │
    └── （Unit mode 限定）
        sandbox/<mission-id>         ← throwaway，只活在當前 wave，wave 末砍
```

**為什麼 v2 不開 per-mission PR？** v1 一個 mission 一個 fix branch + PR 是 agent-tdd 的繼承，但 agent-tdd 那邊每個 PR 是「impl 的成果」、值得 review。tenet 的 mission 產的是 markdown 修補 + 集中 fix phase；fix 在 wave 邊界已經 dedup 過、commit 訊息可以列出來源 mission，沒必要再多一層 PR overhead。**最後 run 結束時整個 `tenet/<run-task>` branch 一次性開 PR 給 user review。**

### 2.4 Plugin 檔案布局

```
.claude-plugin/
└── plugin.json                     name: tenet, two skills

skills/
├── integration/
│   ├── SKILL.md                    user-invocable: /tenet:integration
│   │                               bootstrap：讀共享 PROTOCOL.md，進 Integration Wave 0
│   └── PROTOCOL-extra.md           （optional）integration 特化規則
└── unit/
    ├── SKILL.md                    user-invocable: /tenet:unit
    │                               bootstrap：讀共享 PROTOCOL.md，進 Unit Wave 0 + 觸發 Ownership Analysis
    └── PROTOCOL-extra.md           Unit 特化規則（sandbox 流程、ownership 步驟）

shared/                             （兩個 skill 共用，由 SKILL.md 用相對路徑引用）
├── PROTOCOL.md                     整個 run 的執行合約，Tenet 在 phase boundary 重讀
├── roles/
│   ├── BLUE_ANALYST_ROLE.md
│   ├── OWNERSHIP_ANALYZER_ROLE.md  Unit mode 限定
│   └── REBASE_AGENT_ROLE.md
├── recipes/
│   ├── init-run.sh                 atomic claim run-id、開 Root worktree、寫 meta.json
│   ├── run-red-mission.sh          driver：在 mission worktree 裡跑 attacker↔target relay
│   ├── spawn-blue-analyst.sh       建 tmux window + 啟 claude -p + 寫狀態檔 wrapper
│   ├── ownership-analyze.sh        Unit pre-wave：跑 Ownership Analyzer，寫 ownership.json
│   ├── unit-sandbox-create.sh      建 sandbox worktree + 跑 throwaway strip commit
│   ├── wave-watcher.sh             background Bash event-watcher
│   ├── fix-phase.sh                Tenet 內呼叫，包 collect+dedup+apply
│   ├── wave-end-cleanup.sh         砍 mission worktree + sandbox（unit mode）
│   ├── terminate-run.sh
│   └── notify-human.sh
├── templates/
│   ├── ISSUE_TEMPLATE-integration.md
│   └── ISSUE_TEMPLATE-unit.md
└── schemas/
    ├── mission.schema.json         Mission JSON schema（含 testMode, setupType 等）
    ├── blue-report.schema.json     BlueTeamReport schema（無 fixesApplied，只有 proposedFixes）
    └── ownership.schema.json
```

**關於 shared/ 的引用方式**：兩個 SKILL.md 各用相對路徑 `${CLAUDE_PLUGIN_DIR}/shared/...` 引用（如 plugin runtime 不暴露 plugin dir，用 `dirname $(dirname ${CLAUDE_SKILL_DIR})` 推算）。Phase B scaffold 時實測決定 final 寫法。**不接受方案：兩 skill 各自複製一份 shared 內容**（違反 D1「乾淨」精神）。

### 2.5 Runtime conventions（PROTOCOL.md 必須細到的事）

§2.1–2.4 是架構與檔案布局。本節列出 PROTOCOL.md 必須明文寫死的執行細則，以免 Phase B–D 各自重新發明。本節是參考索引，**最終應在 `shared/PROTOCOL.md` 自含展開**，不能讓 Tenet runtime 還要回頭讀 UPGRADE 計畫文件。

#### 2.5.1 Runtime data 布局（`.tenet/<run-id>/`）

仿 agent-tdd `.agent-tdd/<root-id>/` 結構，但分整合 / 隔離兩種 mission：

```
<repo>/.tenet/
└── run-<id>/
    ├── meta.json                          # run 設定（mode、base、gh_account、tmux_session、…）
    ├── ownership.json                     # Unit mode only（Pre-Wave 1 寫一次）
    ├── coverage.json                      # 本地 cache，每 wave 開頭從 GitHub re-sync
    ├── feedback.md                        # 對齊 §2.5.7：autopilot 期間 user 的 off-band 輸入
    ├── wave-1/
    │   ├── manifest.json                  # 本 wave 的 mission 清單 + expected terminal count
    │   ├── results/
    │   │   └── mission-<id>.report.json   # Blue 寫的 BlueTeamReport（含 proposedFixes[]）
    │   ├── status/
    │   │   ├── mission-<id>.done          # ← wave-watcher 唯一在等的東西
    │   │   ├── mission-<id>.failed
    │   │   ├── mission-<id>.aborted
    │   │   └── mission-<id>.crashed
    │   ├── logs/
    │   │   └── mission-<id>/
    │   │       ├── attacker.stdout
    │   │       ├── target.stdout
    │   │       ├── target.session.jsonl   # Blue 讀這個來分析
    │   │       └── blue.stdout
    │   └── fix-phase/
    │       ├── deduped.json               # 收齊 + dedup 後的 fix list
    │       ├── .in-progress                # Tenet 跑 Fix Phase 期間存在（見 §6 Q6）
    │       └── commit.sha                 # Tenet 套完 fix 的 commit
    ├── wave-2/
    │   └── …
    ├── worktrees/                         # Integration mode 的 mission worktree
    │   └── mission-<id>/
    └── sandboxes/                         # Unit mode 的 sandbox worktree（worktree + throwaway commit）
        └── mission-<id>/
```

`meta.json` schema（最小集）：

```json
{
  "run_id": "run-1",
  "mode": "integration | unit",
  "task": "<run-task-slug>",
  "base": "main",
  "gh_account": "willie-chang",
  "max_waves": 10,
  "wave_size_cap": 5,
  "current_wave": 1,
  "repo_root": "/abs/path/to/repo",
  "tenet_session": "<whatever-session-the-human-launched-from>"
}
```

#### 2.5.2 Status files：Red 不寫，Blue 寫終局

**鐵律**：每個 mission **只有一個** terminal status file，由 Blue Analyst 在分析完 session JSONL 後 atomic 寫入。Red 跑完不寫狀態檔 — `run-red-mission.sh` driver 偵測 Red 終止（任一 pane 的 `claude` 程序退出 / sentinel marker 收到 mission-complete）後直接在同 worktree 啟 Blue。如此 wave-watcher 計數很乾淨：`expected_terminal_count == len(manifest.missions)`。

| 狀態檔 | 誰寫 | 何時 | schema |
|---|---|---|---|
| `mission-<id>.done` | Blue | 分析完成、報告寫好 | `{ mission_id, outcome:"done", report_path, head_sha }` |
| `mission-<id>.failed` | Blue | Blue 認為 mission 內 target 真的有 bug 但無法產出可套的 fix | `{ mission_id, outcome:"failed", report_path, reason }` |
| `mission-<id>.aborted` | Blue | session JSONL 異常（無法解析、turn 數不足等）— Blue 自己決定 abort | `{ mission_id, outcome:"aborted", reason }` |
| `mission-<id>.crashed` | Driver wrapper | Red 或 Blue 進程異常退出（兩個 pane 任一） | `{ mission_id, outcome:"crashed", who:"red\|blue", exit_code, log_dir }` |

**原子寫入**：一律先寫 `<file>.tmp`、再 `mv` — POSIX 保證 rename atomicity，避免 wave-watcher 讀到半截 JSON。沿用 agent-tdd 慣例。

#### 2.5.3 Wave-watcher 輸入合約

```
wave-watcher.sh <run-id> <wave-N> <expected-terminal-count>
```

行為：每 10 秒掃 `.tenet/<run-id>/wave-<N>/status/`，數 `*.done|*.failed|*.aborted|*.crashed` 的檔數，達到 `expected-terminal-count` 即印 `EVENT=terminal` 並退出。如果出現 `mission-<id>.paused`（v2 不啟用，但留 hook 給 v3），印 `EVENT=paused FILE=<path>` 並退出。No timeout — escalation 由 Tenet 接到 event 後判斷。

`expected-terminal-count` = `manifest.json.missions.length`，由 Tenet 在 wave initiation 寫進 manifest。

#### 2.5.4 BlueTeamReport.proposedFixes[] schema 紀律

**Centralized Fix Phase 假設每個 proposedFix 不需要 Tenet 重新調查就能套用。** 這對 schema 是硬約束：

每個 `proposedFix` 必有：
- `targetFilePath`：絕對或相對於 repo root 的路徑（Unit mode 必為 **原 repo path，不是 sandbox 內 path** — Blue role markdown 必須教會 Blue 做這個轉換）
- `issueId`：和 BlueTeamReport.issues[].id 對應，dedup key 之一
- `severity`：`critical | high | medium | low`，Fix Phase priority sort 用
- `description`：人讀得懂的 1–2 句說明
- 套用指引（**至少其一**）：
  - `patch`: `{ oldText, newText }`（一個 Edit 就能套；最常見）
  - `fullContent`: `string`（整檔覆寫；少見、目標檔案小時用）
  - `instruction`: `string`（**只能**在 patch / fullContent 都不適合時用，且必須具體到讓 Tenet 不需要 re-read 上下文也能套 — 例如「在 `## Triggers` 段末加上 'When user mentions X'」）

**否決**：模糊 instruction 如「make it stricter」「improve the wording」。Blue role markdown 內示範好 vs 壞的例子；structured output schema 至少 enforce required fields（`targetFilePath`、`severity`、`issueId`、套用指引擇一存在），語意品質靠 role markdown + dogfood 反饋逐步 tighten。

#### 2.5.5 Cross-cutting invariants for child agents

任何 spawn 出去的 child（Blue Analyst、Ownership Analyzer、Rebase Agent）開頭都必須：

1. `cd` 到正確的 worktree（mission worktree / sandbox worktree / Root worktree — 由 caller 在 prompt 內指定絕對路徑）
2. 跑 `gh auth switch --user "$(jq -r .gh_account < .tenet/<run-id>/meta.json)"` — multi-account 機器這步沒做 `gh` call 會 silent 用錯 user
3. 讀 `${CLAUDE_PLUGIN_DIR}/shared/PROTOCOL.md`（或 §6 Q5 fallback）+ 自己的 role markdown
4. 寫 status file 用 atomic `<file>.tmp` → `mv` pattern

這四件事寫進 `shared/PROTOCOL.md` §「Spawning child agents」並複製進每個 role markdown 開頭，避免 child 看不到 PROTOCOL.md 時也能照規矩走。

#### 2.5.6 tmux 命名約定

仿 agent-tdd，但 session 命名從 root → run：

- **Dashboard window**：跑 `/tenet:integration` 或 `/tenet:unit` 的人類自己的 session（從 `meta.json:tenet_session` 解析；**永不 hardcode**）。Tenet 自己就在這個 window 裡。
- **Workspace session**：`ws-tenet-<run-id>`，Tenet 在 wave initiation 用 `tmux new-session -d -s ws-tenet-<run-id>` 建立（idempotent）。
- **Mission window**：`mission-<id>`（Integration）或 `mission-<id>-sandbox`（Unit）— 內含兩個 pane：`attacker` + `target`。
- **Blue 跑在哪**：Blue Analyst 在 mission window 結束後沿用同一個 window（cwd 已對；driver 在原 window 啟 `claude -p` 做 Blue 分析），不另開 window。
- **Window title 用作 status indicator**：`run-<id>: wave-<N> (<active>/<expected>)`、`run-<id>: wave-<N> fix-phase`、`run-<id>: COMPLETE`。

#### 2.5.7 Autopilot 期間 user 的 off-band 輸入

從 user 在 Wave 0 說「go」開始到 run 結束之間，user 仍可以在 Tenet 的 window（=自己的 Claude session）打字。**Tenet 不可被打斷去處理。** 鐵律（沿用 agent-tdd Hard Invariant #5）：

- 把 user 訊息 append 到 `.tenet/<run-id>/feedback.md`（時間戳 + 原文）
- 印一行 ack：「Captured to feedback.md, will be considered at next wave initiation」
- 繼續當前 wave loop
- 下次 `planIteration` 把 feedback.md 內容當輸入之一

唯一例外：user 明確輸入緊急中止指令（具體形式 Phase C 定義；目前先保留 `/abort` 與 `/pause` 兩個 reserved keyword）— 這類 control-plane signal Tenet 立即處理而不是塞進 feedback.md。

---

## 3. 五階段實作計畫

不再分「Phase 1 在 Deno 內驗證 + Phase 2 哲學 + Phase 3 換載體」 — 那是 backward-compat 思維的殘留。v2 是 greenfield rewrite，從文件開始把整個東西重畫。

### Phase A — 文件三件套

不寫 code，只寫字。把 v1 `SPEC.md` 的內容拆 + 重整 + 補齊到三個檔：

- **`WHITEPAPER.md`** — design rationale。v2 的核心思想（Wave model、ComponentStatus 四態為何、Analysis-only Blue 為何、Ownership 分析為何、Throwaway-commit sandbox 為何）。Immutable v2 文件，未來新版本再開新 whitepaper。
- **`PROTOCOL.md`** — Tenet 在 runtime 重讀的執行合約，獨立、自含。包含：兩個 mode 的完整 wave lifecycle、`.tenet/<run-id>/` runtime 布局、Red→Blue 寫狀態檔的鐵律與 status file schemas、Mission/BlueTeamReport schema（含 proposedFixes 紀律）、GitHub label 表、wave-watcher 合約、cross-cutting child agent invariants（含 `gh auth switch` 步驟）、tmux 命名約定、feedback.md 規則、scope discipline、rebase ladder、Standards P1–P7（P1–P6 從 agent-tdd `PROTOCOL.md` §1.5 **逐字搬**，不要意譯；P7「不混 mode」是 tenet 加的 — Integration 與 Unit 不在同一 wave 互混）。本 plan §2.5 是參考索引，最終一切細則應在 PROTOCOL.md 自含展開。
- **`ROADMAP.md`** — 活的 tracker。v2 完成度、smoke-test risks、known limitations、後續 v3 候選功能。

驗收：三個檔讀完，一個沒看過 v1 的人能 cold-read 理解 v2 在做什麼、為什麼這樣做、現在做到哪。

### Phase B — Plugin 骨架 + 共享基礎建設

把 `skills/integration/`、`skills/unit/`、`shared/` 全部建好，但**業務邏輯先用 mock**（recipes 裡 echo 假輸出、Tenet 走 happy path 沒真的跑 SDK）。重點是把 chassis 立起來：

- `plugin.json`、兩個 SKILL.md
- `shared/PROTOCOL.md` 完整版（從 Phase A 文件 derive）
- 全部 recipe 的 skeleton（input/output 介面定義清楚，內部 stub）
- `.tenet/<run-id>/` 目錄結構與 `meta.json` schema
- Atomic status file 寫入工具（`recipes/write-status.sh`）
- Background Bash wave-watcher（拿 agent-tdd 的版本改名）
- GitHub label 集合先註冊好（`tenet:pending` / `tenet:active-wave-N` / `tenet:run-<id>` / `tenet:done` / `tenet:failed` / `tenet:rebase-blocked`）
- **Phase B 結束時要決議的開放問題見 §6 — Q5（shared dir 引用方式）必須拍板，Q6（Fix Phase token / wall-clock 規模）此題 Phase C 才能回答，Phase B 先記錄判準。Q1 已在本計畫定案；Phase C 實作時驗證 sentinel marker 偵測。**

「Mock」的精確定義：以 `TENET_MOCK=1` 環境變數驅動 — 設此 flag 時，所有會呼叫 SDK 的點（planIteration、Red attacker/target relay、Blue Analyst、Ownership Analyzer、Fix Phase apply）改成從 `tests/fixtures/` 讀預錄好的 JSON / JSONL。Recipes 本身（tmux、worktree、status file 寫入、wave-watcher）跑真的；只有 LLM 呼叫被替換。

驗收：`TENET_MOCK=1 /tenet:integration test-spec` 在 dummy target 上，整個 wave lifecycle 可以走完（Tenet 把 manifest 寫好、worktree 開好、tmux window 開好、wave-watcher 等到 fixture-driven status 檔出現、Fix Phase 跑 mock、wave 結束）。

### Phase C — Integration mode 完整實作

把 mock 換成真的：

- `planIteration()` 真的呼叫 SDK 生 N 個 mission + status update
- `run-red-mission.sh` 真的跑 attacker（`claude -p` 無 tools）和 target（`claude` interactive 在 mission worktree） + 真的 relay
- Blue Analyst role markdown 完整、真的產 `BlueTeamReport`
- Fix Phase 真的 collect + dedup + apply
- Rebase ladder 完整（trivial / mechanical / semantic / regression）。**注意 tenet 的 rebase 場景比 agent-tdd 少**：因為 tenet 不開 per-mission PR，只有 (a) run 結束時 `tenet/<run-task>` 對 main 的最終 PR rebase，與 (b) 多個 tenet run 共用 base 時 fix commit 的潛在衝突。Rebase Agent role markdown 仍寫完整四階梯，但實際觸發場景在 PROTOCOL.md 點明
- Standards P1–P6 從 agent-tdd `PROTOCOL.md` §1.5 **逐字搬**進本 plugin 的 `shared/PROTOCOL.md`（不要意譯，因為這六條是經過 agent-tdd 線上 incident 打磨過的；P1 與 P5 對 tenet 特別重要 — P1 的「verification surfaces are wave debt」剛好對應 tenet「下一 wave 的 red mission 還找得到舊 issue 就不算 done」）。新增 P7「不混 mode」：Integration mission 和 Unit mission 不在同一 wave 內並列。在 Tenet 的每個 phase boundary 強制 self-check

驗收：對公司內部一個真實 markdown agent 專案跑 `/tenet:integration <spec>`，完整 2 wave、每 wave 3 mission，產出可看的 PR 給 review。

### Phase D — Unit mode 完整實作

加上 Integration 沒有的東西：

- Ownership Analyzer role markdown + recipe + schema
- Pre-wave 1 的 ownership 分析 step（寫進 Unit 版的 SKILL.md bootstrap）
- `unit-sandbox-create.sh` 完整實作 throwaway-commit strip 流程
- Unit mode 的 PROTOCOL-extra.md（sandbox path 轉換規則、Blue Analyst 在 sandbox 裡的 `targetFilePath` 約定）

驗收：對同一個 target 跑 `/tenet:unit <spec>`，產出對單一 component 的深度測試結果與 fix。

### Phase E — Sunset Deno code

整批刪：

```
rm -r src/ deno.json deno.lock Makefile install.sh
rm prompts/*.md（內容已搬進 shared/roles/）
```

更新 `README.md`：安裝 = `/plugin install tenet`，使用 = 兩個 skill 介紹。

更新 `CLAUDE.md`：拿掉 Deno-specific 的內容（commands 段、architecture 段裡的 SDK relay 描述），改成 plugin-specific 的開發指引。

驗收：以下 grep 都應只在 git history 命中（活的 working tree 為空）：
- `grep -r 'deno\|Deno' .`
- `grep -r 'RoundSummary' .`（v1 殘留型別，§4 已標記刪除）
- `grep -rE 'fixesApplied|covered:\s*boolean' .`（v1 deprecated 欄位）
- `grep -r 'syncFixesBack' .`（v1 sandbox 同步函式，已被 worktree + Fix Phase 取代）

---

## 4. v1 → v2 概念與檔案映射

| v1（Deno + staging） | v2 |
|---|---|
| `src/main.ts`（CLI 入口）+ `-w` flag | 兩個 SKILL.md：`skills/integration/SKILL.md`、`skills/unit/SKILL.md` |
| `src/tenet/orchestrator.ts`（integration loop） | `shared/PROTOCOL.md` + Integration Wave Lifecycle 段 |
| `src/tenet/unit-orchestrator.ts`（unit loop） | `shared/PROTOCOL.md` + Unit Wave Lifecycle 段 |
| `src/tenet/scanner.ts` | Tenet 在 Wave 0 用 `Glob`/`Read` 直接掃，不需獨立模組 |
| `src/tenet/mission.ts`（含 `planIteration`） | `shared/PROTOCOL.md` Mission planning 段 + Tenet 在 wave initiation 直接 SDK call |
| `src/tenet/coverage.ts`（含 ComponentStatus 四態） | GitHub label 為主、`.tenet/<run-id>/coverage.json` 為輔。四態完整保留 |
| `src/tenet/ownership.ts` + `prompts/ownership.md` | `shared/roles/OWNERSHIP_ANALYZER_ROLE.md` + `shared/recipes/ownership-analyze.sh` |
| `src/tenet/sandbox.ts`（檔案 copy） | `shared/recipes/unit-sandbox-create.sh`（worktree + throwaway commit，不是 copy） |
| `src/tenet/fix-phase.ts` | Tenet 自跑（不另開 agent）+ `shared/recipes/fix-phase.sh` 包邏輯 |
| `src/red/red-team.ts`（dual-SDK relay 286 行） | `shared/recipes/run-red-mission.sh`（shell driver；attacker + target 各為 tmux pane 內的 interactive `claude`，見 §6 Q1） |
| `src/blue/blue-team.ts` + `session-reader.ts` | `shared/roles/BLUE_ANALYST_ROLE.md`（self-contained role prompt，內含 JSONL 解析指引） |
| `src/types.ts`（schemas） | `shared/schemas/*.json` + 在 `PROTOCOL.md` 寫 status file schema |
| `prompts/tenet.md` | 併入兩個 SKILL.md + `shared/PROTOCOL.md` |
| `prompts/red-team.md` | Attacker 用的 system prompt — 寫進 `run-red-mission.sh` 的 attacker invocation |
| `prompts/blue-team.md` | `shared/roles/BLUE_ANALYST_ROLE.md` |
| `prompts/unit-test.md` | 併入 Unit mode 的 mission planning 段（在 `skills/unit/SKILL.md` 或 `PROTOCOL-extra.md`） |
| `prompts/ownership.md` | 併入 `shared/roles/OWNERSHIP_ANALYZER_ROLE.md` |
| `BlueTeamReport.fixesApplied`（deprecated） | **刪除**。只剩 `proposedFixes` |
| `CoverageStatus.covered: boolean`（deprecated） | **刪除**。只剩 `status: ComponentStatus` |
| `RoundSummary` | **刪除**。只剩 `IterationSummary` |
| `--dry-run` flag | **刪除**。Wave 0 互動本身就是 preview / abort 點 — user 看到 wave 計畫不滿意可以直接退出 |
| `--workers N` flag | Wave 0 user 對話決定（D3 鎖定） |

---

## 5. 不在 v2 範圍

明確列出，避免 scope creep：

- **跨 run 的 dedup。** 兩個 user 同時對同一 repo 跑 tenet 的衝突防護。先假設一 run-per-repo-at-a-time。（`init-run.sh` 用 atomic mkdir + lockfile 確保並發啟動其中一個會 fail；多個 `.tenet/run-<N>/` 序號目錄可共存於 disk，但同一時間只有一個 active autopilot — 已 terminate 的 run-id 可任意保留供 forensic 用）
- **Bypass permissions 政策變更。**（D4 鎖定）
- **Tenet 跑非 GitHub 專案。**（D2 鎖定 — 沒 `gh` 不支援）
- **Crash recovery 自動化。** State 全寫進 disk + GitHub，但 `/tenet:resume <run-id>` slash command 留到 v3。v2 要 resume 就 user 手動重跑同一個 skill 並引用 run-id。
- **Cost telemetry per agent。** Per-mission token / USD 計算留到 v3。v2 wave-end 印一次粗略總額即可。
- **TUI / dashboard refactor。** 已 superseded by tmux dashboard window — `PLAN-parallel-workers-tui.md` 已刪除。
- **多 plugin 整合（與 agent-tdd 串接等）。** v3+。

---

## 6. 開放問題（Phase B 開工前要拍板）

不再有「預設保守選項」這種 punt — 每題列選項與決策標準，Phase B 開工時逐題決議。

### Q1 — Red Mission 內部的 attacker 怎麼跑？

**已決議：interactive `claude` 在另一個 tmux pane。** Attacker 與 target 對稱、都是 stateful interactive `claude` session、都受 tmux send-keys 驅動。

Driver loop：
1. Mission worktree 開兩個 tmux pane：`attacker` pane 跑 `claude` interactive（system prompt 是 attacker persona、無 tools、cwd 不重要）；`target` pane 跑 `claude` interactive 在 mission worktree cwd（讀 target 專案的 `.claude/settings.json` / CLAUDE.md / skills / ...）
2. Driver 用 `tmux capture-pane` 抓 source pane 的 turn output → `tmux send-keys` 餵 destination pane → 等 destination 完成 turn → 反向重複
3. 直到任一方發 mission-complete signal 或 maxExchanges 上限到

**Phase C 實作要小心的點：**
- **Turn boundary 偵測別 grep prompt 字元。** 要求 attacker / target 在每個 turn 結尾印明確 sentinel marker（例如 `<<<TURN_END>>>`），driver 用 marker 偵測 — `^>` grep 會被 color codes / prompt 變動坑死。
- **Crash 偵測：** 任一 pane 的 `claude` 進程退出，driver 立即寫 `.crashed` 狀態檔。
- **乾淨退出：** mission 結束 driver 主動 `tmux kill-window`，再砍 mission worktree。

否決選項：`-p` 多 shot（每 turn 重發 system prompt + 全部歷史，token 疊加）；外部 SDK helper（需 Bun/Node runtime，違反 plugin-native）。

### Q2 — Coverage 在 GitHub label 與本地 JSON 的真理位階

Issue label 若 user 手動改了（拔掉 `tenet:done`），下一 wave 的 mission planner 該以哪邊為準？

- **決議：GitHub 是 source of truth、本地 JSON 是 cache。** Tenet 每 wave 開頭從 `gh issue list` 重 sync 到 `coverage.json`。寫進 PROTOCOL.md。

### Q3 — Wave 0 spec 討論的呈現

Tenet 掃完後 propose Wave plan、user 增刪確認，不是逐 component 問。

- **決議：Tenet 掃完 → 印 component 清單 → propose 「Wave 1: [c1, c2, c3] 並行 3、Wave 2: [c4, c5] 並行 2」 → user 增刪 / 改 wave size → 確認 → go。**

### Q4 — Unit mode sandbox 用什麼隔離？

**已決議：worktree + throwaway commit（Option C）。** 詳見 §2.2.2。

### Q5 — `shared/` 在兩個 skill 間怎麼引用？

兩個 SKILL.md 都需要讀 `shared/PROTOCOL.md`、`shared/roles/*.md`、`shared/recipes/*.sh`。

- **Q5.A** — 用 `${CLAUDE_PLUGIN_DIR}` 環境變數（如 plugin runtime 提供）
- **Q5.B** — 用 `dirname $(dirname ${CLAUDE_SKILL_DIR})` 從 skill dir 推算 plugin root
- **Q5.C** — Plugin install 時 symlink `shared` 進每個 skill dir

**判準：Phase B 開工先實測 Q5.A，不行再 fallback B。C 只有在前兩個都不行才做。** 不接受複製內容到兩個 skill。

### Q6 — Tenet 自跑 Fix Phase 是否會 token / wall-clock 爆炸？

如果 wave 有 5 個 mission、每個 Blue Analyst 平均 8 個 proposedFix，dedup 後可能還有 20+ fix 要在一次 SDK call 套完。**兩個正交風險**：

- **Token**：Tenet 自己的 context 已含 wave-0 spec、PROTOCOL.md、本 wave manifest、各 mission 報告 — 把 20 個 fix 的 patch 內容也吞進去可能擠壓 context budget
- **Wall-clock**：Tenet 跑 Fix Phase 的這 5–10 分鐘，**user 的 Claude window 是不可用的**（Tenet 的 session 被佔住）。對 long-running run 累積觀感很差

**判準：Phase C 實測 →**
1. 若單次 SDK call 在 10 分鐘 + 50 turn 內無法收斂，改為 spawn 一個獨立 Fix Agent（child `claude -p`），Tenet 退回監督角色。
2. 不管 #1 結果如何，Fix Phase 期間 Tenet 必須：(a) 寫 `.tenet/<run-id>/wave-<N>/fix-phase/.in-progress` marker、(b) 把 tmux window title 改成 `run-<id>: wave-<N> fix-phase`、(c) 在 Wave 0 互動時先告知 user「每個 wave 結束會有 5–10 分鐘的不可互動視窗」。

---

## 7. Pre-flight checklist（每次回到這份文件對照）

- [ ] D1–D8 是否還成立？user 有沒有改主意？
- [ ] §0 三條指導原則是否仍是判斷依據？有沒有偷偷退化成「最少改動」思維？
- [ ] Phase A 三件套寫到哪？特別是 PROTOCOL.md 是否含 §2.5 全部子節（runtime 布局、status 語意、wave-watcher 合約、proposedFixes schema、cross-cutting invariants、tmux 命名、feedback.md）？
- [ ] Phase B 開放問題 Q5 是否拍板？Q6 判準是否寫進 PROTOCOL.md？Q1 已決議但 Phase C 實作時要回頭驗證 sentinel marker 偵測
- [ ] Phase C 是否真的對公司內部專案 dogfood 過？Standards P1–P7 是否真的逐字搬進 PROTOCOL.md 而不是意譯？
- [ ] Phase D Unit mode 是否真的用 throwaway-commit 而不是 fallback 回 file copy？
- [ ] Phase E：四個 grep（deno、RoundSummary、fixesApplied/covered、syncFixesBack）是否都只在 git history 命中？

---

End of UPGRADE_v2-plugin.md.
