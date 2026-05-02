להלן מסמך מסודר שאפשר לתת כמעט כמו שהוא לסוכן שמבצע את המעבר מ־`LangGraph + ChatAnthropic` למודל שבו **Claude Agent SDK** הוא runtime של agent בתוך הגרף.

---

# מסמך תכנון: מעבר מ־LangGraph Chat Model Objects ל־Claude Agent SDK Runtime

## 1. מטרת המעבר

המטרה היא להחליף חלק מה־nodes שמשתמשים היום ב־`ChatAnthropic` / `bindTools` / tool loop רגיל, ל־nodes שמפעילים **Claude Agent SDK** כ־agent runtime עצמאי.

במודל החדש, LangGraph נשאר ה־orchestrator הראשי של המערכת: הוא מנהל workflow state, checkpoints, החלטות routing, memory retrieval, validation, status, retries ו־observability.
Claude Agent SDK משמש כ־runtime למשימות agentic עמוקות: קריאת קבצים, חיפוש בקוד, הרצת commands, שימוש ב־MCP tools, ניתוח רב־שלבי, והמשך session. Anthropic מתארים את Agent SDK כנותן את אותם tools, agent loop ו־context management שמפעילים את Claude Code, כולל קריאת קבצים, הרצת פקודות, עריכת קוד, MCP, permissions ו־sessions. ([Claude][1])

---

## 2. עיקרון מרכזי: LangGraph נשאר source of truth

אין להחליף את כל ה־state של המערכת ב־`claudeSessionId`.

החלוקה הנכונה:

```text
LangGraph / App Checkpoint
  = מצב המערכת וה־workflow

Claude Agent SDK session_id
  = המשכיות שיחה/קונטקסט מול Claude

Thread summary / memory
  = זיכרון חיצוני ארוך טווח

MCP server
  = שכבת tools חיצונית ומבוקרת
```

כלומר:

```ts
type AgentThread = {
  threadId: string;
  userId: string;

  status: "active" | "paused" | "summarizing" | "archived" | "failed";

  currentNode?: string;
  graphState: Record<string, unknown>;

  claudeSessionId?: string;

  topic?: string;
  shortSummary?: string;
  workingSummary?: string;
  finalSummary?: string;

  memoryIds?: string[];

  turnCount: number;
  tokenEstimate?: number;

  createdAt: string;
  updatedAt: string;
};
```

`claudeSessionId` הוא שדה בתוך ה־checkpoint/thread שלך — לא תחליף ל־checkpoint.

---

## 3. ההבדל בין ChatAnthropic ל־Claude Agent SDK

### המודל הישן: LangGraph + ChatAnthropic

במודל הזה:

```text
LangGraph node
  -> ChatAnthropic
  -> model returns tool_calls
  -> LangGraph/ToolNode executes tools
  -> result returned to model
```

המודל מבקש tool call, אבל האפליקציה שלך אחראית להריץ את הכלי ולהחזיר tool result. LangChain מתעדת שימוש ב־`bindTools` עבור Anthropic tools, כלומר הכלים נקשרים למודל אבל ה־tool loop הוא חלק ממסגרת LangChain/LangGraph. ([LangChain Docs][2])

### המודל החדש: LangGraph node שמריץ Agent SDK

במודל החדש:

```text
LangGraph node
  -> build prompt + inject memory/state
  -> Claude Agent SDK query()
  -> Claude manages tool loop internally
  -> final result returned to LangGraph
```

Anthropic מנסחים את ההבדל כך: עם Client SDK אתה מממש בעצמך את tool loop; עם Agent SDK, Claude מטפל בכלים בצורה אוטונומית. ([Claude][1])

---

## 4. מתי להשתמש ב־Agent SDK ומתי להשאיר ChatAnthropic

### להשתמש ב־Claude Agent SDK עבור:

```text
- משימות קוד וריפו
- קריאת קבצים
- Grep / Glob / Read
- הרצת Bash מבוקרת
- MCP tools
- ניתוח רב־שלבי
- agent שצריך לעבוד אוטונומית לאורך כמה צעדים
```

### להשאיר LangGraph + ChatAnthropic עבור:

```text
- structured output פשוט
- קריאה חד־פעמית למודל
- workflows עסקיים מדויקים
- tool calls שבהם האפליקציה חייבת לשלוט בכל שלב
- פעולות שדורשות validation קשיח אחרי כל tool
```

הגישה המומלצת היא **hybrid architecture**:

```text
LangGraph = orchestrator
Claude Agent SDK = node ייעודי למשימות agentic כבדות
ChatAnthropic = node רגיל למשימות LLM פשוטות/מובנות
MCP = שכבת tools משותפת
```

---

## 5. ניהול threads, sessions ו־checkpoints

### `threadId`

זה מזהה אפליקטיבי שלך. הוא מייצג שיחה, job, או workflow run.

```text
threadId = מזהה העבודה אצלנו
```

ב־LangGraph, `thread_id` משמש לזיהוי רצף checkpoints; תיעוד LangGraph מראה שכל checkpoint משויך ל־`thread_id`, `checkpoint_ns`, ו־`checkpoint_id`. ([LangChain Docs][3])

### `claudeSessionId`

זה מזהה session של Claude Agent SDK.

```text
claudeSessionId = איך להמשיך את אותה שיחת Claude
```

Anthropic מתעדים ש־`resume` מקבל session ID וממשיך את ה־agent עם context מלא מהמקום שבו ה־session נעצר. הם גם מציינים שזה שימושי להמשך task, recovery מ־limit, או restart של process. ([Claude][4])

### checkpoint

זה snapshot של מצב המערכת שלך:

```text
checkpoint = באיזה node היינו, מה ה-state, מה הסטטוס, איזה memories הוזרקו, מה ה-output האחרון
```

LangGraph מספק checkpointer implementations כמו Memory, SQLite, Postgres, MongoDB ו־Redis; Postgres ו־Redis מתאימים יותר לפרודקשן. ([LangChain Docs][3])

---

## 6. כלל חשוב: לא להסתמך רק על Claude session

אם רוצים מערכת אמינה, לא לבנות אותה כך שכל ההמשכיות תלויה ב־Claude session.

Anthropic מציינים שב־resume בין hosts צריך או להעביר session files לאותו path, או לא להסתמך על session resume בכלל — אלא לשמור את התוצאות החשובות כ־application state ולהזריק אותן ל־fresh session. הם מציינים שהגישה השנייה לעיתים robust יותר. ([Claude][4])

לכן:

```text
Recommended:
  save application state + summary + memory ids + claudeSessionId

Avoid:
  only save claudeSessionId
```

---

## 7. מודל memory ו־thread summaries

יש לנהל זיכרון בכמה שכבות:

```text
Short-term:
  Claude session context

Mid-term:
  LangGraph checkpoint / thread state

Long-term:
  thread summaries + semantic memory + vector/hybrid search
```

### מבנה מומלץ לטבלת threads

```ts
type ThreadRecord = {
  id: string;
  userId: string;

  topic: string | null;
  shortSummary: string | null;
  workingSummary: string | null;
  finalSummary: string | null;

  embeddingText?: string;
  embedding?: number[];

  status: "active" | "paused" | "summarizing" | "archived" | "failed";

  claudeSessionId?: string;
  langGraphThreadId?: string;
  lastCheckpointId?: string;
  lastNode?: string;

  turnCount: number;
  tokenEstimate?: number;

  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};
```

### לא לסכם רק בסוף

יש לעדכן `workingSummary` תוך כדי הריצה, ולא רק כשמגיעים למקסימום טוקנים.
הסיבה: אם ה־session מסתיים בגלל max turns, budget, error או context pressure, עדיין יש summary עדכני.

### בסיום thread

בסיום thread, להריץ summarization ייעודי שמחזיר JSON תקין:

```json
{
  "topic": "short title",
  "shortSummary": "1-3 sentences",
  "finalSummary": "detailed summary",
  "completed": [],
  "decisions": [],
  "openQuestions": [],
  "nextBestActions": [],
  "importantFilesOrTools": [],
  "warnings": []
}
```

יש לבצע validation עם Zod לפני שמירה.

---

## 8. חיפוש threads: לאנדקס יותר מה־topic

לא לאנדקס וקטורית רק את ה־`topic`.

יש ליצור `embeddingText` שמורכב מ:

```text
topic
shortSummary
workingSummary / finalSummary
decisions
openQuestions
tags
important files/tools
```

דוגמה:

```ts
const embeddingText = `
Topic: ${topic}

Short summary:
${shortSummary}

Detailed summary:
${finalSummary ?? workingSummary}

Decisions:
${decisions.join("\n")}

Open questions:
${openQuestions.join("\n")}

Tags:
${tags.join(", ")}
`.trim();
```

ה־tool `search_threads` צריך לבצע ideally חיפוש hybrid:

```text
keyword search
+
vector search
```

keyword search טוב לשמות מדויקים כמו `LangGraph`, `Meridian`, `PostgresSaver`, `worker`, `port 3001`.
vector search טוב לשאלות סמנטיות כמו “הבעיה הקודמת שבה הקונטיינר היה unhealthy למרות שהשירות עלה”.

---

## 9. Tools שה־agent צריך לקבל

במקום לתת ל־agent גישה ישירה לטבלאות DB, לתת לו MCP tools מוגדרים ומוגבלים.

### Thread/memory tools

```ts
list_recent_threads({
  limit: number,
  status?: "active" | "paused" | "archived" | "failed"
})
```

מחזיר רק:

```ts
[
  {
    threadId: "thr_123",
    topic: "Worker container unhealthy",
    shortSummary: "Investigated Docker worker healthcheck failure.",
    updatedAt: "..."
  }
]
```

```ts
search_threads({
  query: string,
  limit?: number
})
```

מחזיר:

```ts
[
  {
    threadId: "thr_123",
    topic: "...",
    shortSummary: "...",
    score: 0.87
  }
]
```

```ts
get_thread_summary({
  threadId: string
})
```

מחזיר summary מפורט יותר:

```ts
{
  threadId: "thr_123",
  topic: "...",
  workingSummary: "...",
  finalSummary: "...",
  decisions: [],
  openQuestions: [],
  nextBestActions: []
}
```

```ts
propose_thread_summary_update({
  threadId: string,
  topic?: string,
  shortSummary?: string,
  workingSummary?: string,
  finalSummary?: string
})
```

עדיף שה־agent יציע update, והמערכת תאשר/תוודא schema לפני כתיבה.

---

## 10. MCP server כגבול נכון ל־tools

אם יש סקריפטים JS קיימים, אין לתת ל־Claude להריץ אותם חופשי דרך Bash אלא לעטוף אותם כ־MCP tools.

המודל:

```text
JS function/script
  -> MCP tool עם schema
  -> MCP server package
  -> Claude Agent SDK mcpServers
  -> allowedTools
```

Anthropic מתעדים חיבור MCP servers ל־Agent SDK דרך `mcpServers`, והרשאה לשימוש בכלים דרך `allowedTools`. הם גם ממליצים להעדיף `allowedTools` על פני permission mode רחב מדי כמו `bypassPermissions`, כי wildcard ב־`allowedTools` נותן גישה רק לשרת/כלי הרצוי ולא מבטל prompt safety רחב. ([Claude][5])

### שם tool ב־Claude Agent SDK

```text
mcp__<server_name>__<tool_name>
```

דוגמה:

```text
mcp__memory__search_threads
mcp__memory__get_thread_summary
mcp__project_tools__run_report
```

---

## 11. דוגמת חיבור MCP ל־Claude Agent SDK

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: `
You are continuing an autonomous workflow.

Use memory tools only when needed.
Start by checking whether related previous threads exist.
  `,
  options: {
    resume: state.claudeSessionId,

    mcpServers: {
      memory: {
        command: "node",
        args: ["/absolute/path/to/memory-mcp-server/dist/index.js"],
        env: {
          DATABASE_URL: process.env.DATABASE_URL!,
        },
      },
      project_tools: {
        command: "node",
        args: ["/absolute/path/to/project-tools-mcp/dist/index.js"],
      },
    },

    allowedTools: [
      "mcp__memory__list_recent_threads",
      "mcp__memory__search_threads",
      "mcp__memory__get_thread_summary",
      "mcp__memory__propose_thread_summary_update",

      "mcp__project_tools__run_report",
    ],
  },
})) {
  // collect messages/result/session id
}
```

---

## 12. אם נשארים גם עם LangGraph MCP adapters

אם יש tools שצריכים לשמש גם LangGraph/ChatAnthropic וגם Claude Agent SDK, לשמור אותם כ־MCP server משותף.

ב־LangGraph/LangChain אפשר להשתמש ב־`MultiServerMCPClient` כדי לטעון MCP tools ולהעביר אותם ל־agent. תיעוד LangChain מראה שימוש ב־`MultiServerMCPClient`, כולל MCP server מקומי ב־stdio עם `command: "node"` ו־`args`. ([LangChain Docs][6])

כלומר:

```text
Same MCP server
  -> Claude Agent SDK
  -> LangGraph/LangChain MCP adapter
```

זה מונע כפילות בין LangChain tools לבין Agent SDK tools.

---

## 13. ניהול סיום thread

Thread לא צריך להסתיים רק לפי טוקנים. יש להגדיר כמה תנאי סיום:

```text
- turnCount >= maxTurns
- tokenEstimate >= threshold
- task completed
- need_user_input
- timeout exceeded
- budget exceeded
- repeated tool failure
- agent explicitly says cannot progress safely
```

Flow מומלץ:

```text
active
  -> summarizing
  -> archived
```

ב־`summarizing`:

1. שולחים prompt לסיכום מובנה.
2. מקבלים JSON.
3. עושים Zod validation.
4. שומרים `topic`, `shortSummary`, `finalSummary`, `decisions`, `openQuestions`.
5. מעדכנים embedding/hybrid index.
6. מסמנים thread כ־`archived` או `paused`.

---

## 14. Prompt בסיסי ל־Agent SDK node

```text
You are running as an autonomous agent inside a larger LangGraph workflow.

The application, not you, is the source of truth for workflow state.
You may use the provided tools to inspect memory, retrieve previous thread summaries, and execute approved actions.

Current workflow state:
{{graphState}}

Current thread:
{{threadInfo}}

Working summary:
{{workingSummary}}

Relevant memories:
{{retrievedMemory}}

Current task:
{{task}}

Rules:
- Use only approved tools.
- Prefer reading summaries before asking for broad context.
- Do not assume previous filesystem changes unless they are present in the current workspace.
- If you need prior context, use search_threads or get_thread_summary.
- If you reach a stopping point, produce a concise status and next actions.
```

---

## 15. Observability / Langfuse

אם עוברים ל־Agent SDK, לא לצפות ש־Langfuse יזהה אוטומטית את הקריאה כמו `ChatAnthropic`.

יש לעטוף ידנית:

```text
Langfuse trace
  -> LangGraph node span
    -> memory retrieval span
    -> Claude Agent SDK generation/span
    -> MCP tool spans, אם יש מידע נגיש
    -> summarization span
```

לשמור metadata:

```ts
{
  threadId,
  claudeSessionId,
  currentNode,
  toolNamesUsed,
  memoryIds,
  summaryUpdated,
  turnCount,
  status
}
```

לא לשמור raw command output או diffs מלאים ללא סינון, כי הם עלולים להכיל secrets או לוגים גדולים.

---

## 16. מה לא לעשות

### לא להפוך `claudeSessionId` ל־state הראשי

לא נכון:

```text
thread = claudeSessionId only
```

נכון:

```text
thread = app state + checkpoint + claudeSessionId + summaries + memory ids
```

### לא לתת Bash חופשי כשאפשר MCP tool

לא מומלץ:

```text
allowedTools: ["Bash"]
```

כברירת מחדל רחבה.

מומלץ:

```text
MCP tool עם schema מוגדר
allowedTools: ["mcp__project_tools__run_report"]
```

### לא לסכם רק בסוף

צריך rolling summary.

### לא לאנדקס רק topic

צריך לאנדקס `topic + summaries + decisions + openQuestions + tags`.

### לא לערבב שני tool loops עמוקים באותו שלב

להימנע ממצב שבו גם LangGraph וגם Agent SDK מנסים לנהל tool loop מורכב באותו node.

---

## 17. תהליך migration מומלץ

### שלב 1 — מיפוי nodes קיימים

לסווג כל node קיים:

```text
A. simple LLM call
B. structured output
C. business tool workflow
D. code/repo/filesystem agentic work
E. memory/thread management
```

להעביר ל־Agent SDK רק nodes מסוג D, ואולי חלק מ־E.

### שלב 2 — יצירת MCP server

להוציא tools משותפים ל־MCP server:

```text
memory tools
project tools
repo tools
business API tools
```

### שלב 3 — יצירת Agent SDK node

Node זה יקבל:

```ts
{
  threadId,
  graphState,
  claudeSessionId,
  workingSummary,
  retrievedMemories,
  task
}
```

ויחזיר:

```ts
{
  output,
  claudeSessionId,
  status,
  proposedSummaryUpdate?,
  toolUsage?,
  nextActions?
}
```

### שלב 4 — שמירת checkpoint אחרי כל run

אחרי כל קריאה ל־Agent SDK:

```text
save graph state
save claudeSessionId
save last output
save memory ids
update turn count
maybe update working summary
```

### שלב 5 — הוספת summarization lifecycle

להוסיף מצב:

```text
active -> summarizing -> archived
```

### שלב 6 — הוספת search_threads

להתחיל פשוט:

```text
Postgres full-text search on topic/summary/tags
```

ואחר כך להוסיף:

```text
pgvector / vector DB over embeddingText
```

---

## 18. Acceptance criteria

המעבר ייחשב תקין אם:

```text
1. LangGraph עדיין יכול להמשיך workflow מאותו threadId.
2. כל checkpoint כולל claudeSessionId אם נוצר.
3. Agent SDK יכול לעשות resume ל-session קיים.
4. אם resume נכשל, המערכת יכולה לפתוח fresh session עם injected summary/state.
5. MCP tools נטענים דרך mcpServers ומוגבלים ב-allowedTools.
6. אין גישה חופשית ל-DB; יש רק tools מוגדרים.
7. thread summaries נשמרים ומעודכנים.
8. search_threads מחזיר topic + shortSummary בלבד.
9. get_thread_summary מחזיר summary מפורט לפי בקשה.
10. Langfuse/logging מציג threadId, claudeSessionId, node, status, tool usage.
```

---

## 19. Target architecture

```text
User request / autonomous trigger
        ↓
LangGraph thread_id
        ↓
Load checkpoint + thread record
        ↓
Retrieve relevant memories / thread summaries
        ↓
Agent SDK node
        ↓
Claude Agent SDK
        ↓
MCP servers
  ├── memory tools
  ├── project tools
  └── repo/business tools
        ↓
Agent result
        ↓
Validate + parse
        ↓
Update checkpoint
        ↓
Maybe update rolling summary
        ↓
Continue graph / summarize / archive
```

---

## 20. עיקרון סופי

הארכיטקטורה המומלצת היא:

```text
LangGraph = state machine / orchestrator / checkpoint owner

Claude Agent SDK = autonomous runtime for complex agentic tasks

MCP = controlled tool boundary

Thread summaries = long-term memory index

claudeSessionId = temporary conversational continuity, not source of truth
```

הגישה הזו נותנת אוטונומיה בלי לאבד שליטה:
Claude יכול לעבוד כמו agent אמיתי, אבל ה־workflow, הזיכרון, ההרשאות וה־state נשארים בבעלות האפליקציה שלך.

[1]: https://code.claude.com/docs/en/agent-sdk/overview "Agent SDK overview - Claude Code Docs"
[2]: https://docs.langchain.com/oss/javascript/integrations/chat/anthropic "ChatAnthropic integration - Docs by LangChain"
[3]: https://docs.langchain.com/oss/javascript/langgraph/persistence "Persistence - Docs by LangChain"
[4]: https://code.claude.com/docs/en/agent-sdk/sessions "Work with sessions - Claude Code Docs"
[5]: https://code.claude.com/docs/en/agent-sdk/mcp "Connect to external tools with MCP - Claude Code Docs"
[6]: https://docs.langchain.com/oss/javascript/langchain/mcp "Model Context Protocol (MCP) - Docs by LangChain"
